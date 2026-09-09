//! Bounded, metadata-only inventory. Source reads and atomic writes stay in `vault`.
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    io::Read,
    ops::Bound::{Excluded, Unbounded},
    path::{Path, PathBuf},
    sync::{
        MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use serde::Serialize;
use serde_json::Value;
use sqlx::{Connection, Row, SqliteConnection, sqlite::SqliteConnectOptions};
use uuid::Uuid;

use super::{
    NoteDocument, Vault, VaultEntry, VaultError, VaultIssue, VaultResult, VaultSnapshot, kind,
    open_regular, relative,
};
use crate::vault_metadata::{companion_metadata, note_metadata};

const MAX_ENTRIES: usize = 50_000;
const MAX_DIRECTORIES: usize = 2048;
const MAX_DEPTH: usize = 32;
pub(super) const MAX_METADATA_BYTES: u64 = 256 * 1024;
const MAX_BATCH_BYTES: usize = 32 * 1024 * 1024;
const MAX_ISSUES: usize = 200;
const MAX_MESSAGE_BYTES: usize = 1024;
const WORK_TIME: Duration = Duration::from_secs(5);
const COMMIT_ROWS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexState {
    Indexing,
    Ready,
    Partial,
    Stale,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub state: IndexState,
    pub scanned_entries: usize,
    pub indexed_documents: usize,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultPage {
    pub directory: String,
    pub offset: usize,
    pub limit: usize,
    pub entries: Vec<VaultEntry>,
    pub total: usize,
    pub has_more: bool,
    pub indexing: IndexStatus,
}

pub(super) fn message(mut text: String) -> String {
    if text.len() > MAX_MESSAGE_BYTES {
        let mut end = MAX_MESSAGE_BYTES - 3;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("...");
    }
    text
}

#[derive(Clone, Default)]
struct Issues {
    items: Vec<VaultIssue>,
    count: usize,
}

impl Issues {
    fn push(&mut self, path: &str, description: impl Into<String>) {
        self.push_with(path, || description.into());
    }

    fn push_with(&mut self, path: &str, description: impl FnOnce() -> String) {
        self.count = self.count.saturating_add(1);
        if self.items.len() < MAX_ISSUES {
            self.items.push(VaultIssue {
                path: message(path.into()),
                message: message(description()),
            });
        }
    }

    fn append(&mut self, other: &Self) {
        self.count = self.count.saturating_add(other.count);
        self.items.extend(
            other
                .items
                .iter()
                .take(MAX_ISSUES - self.items.len())
                .cloned(),
        );
    }
}

#[derive(Clone)]
struct IndexedEntry {
    entry: VaultEntry,
    // Only control metadata, never Markdown bodies or original PDF/DOCX bytes.
    metadata: Option<String>,
    references: Vec<String>,
    epoch: u64,
}

impl IndexedEntry {
    fn weight(&self) -> usize {
        self.metadata.as_ref().map_or(0, String::len)
            + self.references.iter().map(String::len).sum::<usize>()
    }
}

pub(super) struct Inventory {
    rows: BTreeMap<String, IndexedEntry>,
    children: HashMap<String, BTreeSet<String>>,
    identities: HashMap<String, BTreeSet<String>>,
    issues: Issues,
    status: IndexStatus,
    complete: bool,
    metadata_bytes: usize,
    directories: usize,
    epoch: u64,
}

impl Inventory {
    pub(super) fn new() -> Self {
        Self {
            rows: BTreeMap::new(),
            children: HashMap::new(),
            identities: HashMap::new(),
            issues: Issues::default(),
            status: IndexStatus {
                state: IndexState::Indexing,
                scanned_entries: 0,
                indexed_documents: 0,
                message: Some("Waiting for bounded metadata indexing.".into()),
            },
            complete: false,
            metadata_bytes: 0,
            directories: 0,
            epoch: 0,
        }
    }

    fn remove(&mut self, path: &str) {
        let Some(row) = self.rows.remove(path) else {
            return;
        };
        self.metadata_bytes -= row.weight();
        if row.entry.kind == "directory" {
            self.directories -= 1;
        } else {
            self.status.indexed_documents -= 1;
        }
        if let Some(id) = &row.entry.id {
            if let Some(paths) = self.identities.get_mut(id) {
                paths.remove(path);
                if paths.is_empty() {
                    self.identities.remove(id);
                }
            }
        }
        let parent = parent_path(path);
        if let Some(children) = self.children.get_mut(parent) {
            children.remove(path);
            if children.is_empty() {
                self.children.remove(parent);
            }
        }
    }

    fn put(&mut self, row: IndexedEntry) -> bool {
        let path = &row.entry.path;
        let old = self.rows.get(path);
        if (old.is_none() && self.rows.len() >= MAX_ENTRIES)
            || self.metadata_bytes - old.map_or(0, IndexedEntry::weight) + row.weight()
                > MAX_BATCH_BYTES
            || (row.entry.kind == "directory"
                && !old.is_some_and(|row| row.entry.kind == "directory")
                && self.directories >= MAX_DIRECTORIES - 1)
        {
            return false;
        }
        self.remove(&row.entry.path);
        self.metadata_bytes += row.weight();
        if row.entry.kind == "directory" {
            self.directories += 1;
        } else {
            self.status.indexed_documents += 1;
        }
        if let Some(id) = &row.entry.id {
            self.identities
                .entry(id.clone())
                .or_default()
                .insert(row.entry.path.clone());
        }
        self.children
            .entry(parent_path(&row.entry.path).into())
            .or_default()
            .insert(row.entry.path.clone());
        self.rows.insert(row.entry.path.clone(), row);
        true
    }
}

fn parent_path(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

impl Vault {
    fn inventory(&self) -> MutexGuard<'_, Inventory> {
        self.inventory
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub fn ignored_directory(name: &str) -> bool {
        matches!(
            name,
            ".git"
                | ".hg"
                | ".svn"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | ".next"
                | ".cache"
                | ".generated"
                | ".venv"
                | "venv"
                | "__pycache__"
        )
    }

    pub fn supported_path(path: &Path) -> bool {
        matches!(kind(path), "markdown" | "pdf" | "docx")
    }

    pub fn set_index_state(&self, state: IndexState, description: Option<String>) {
        let mut inventory = self.inventory();
        // Only the worker can certify drained event/overflow queues. A successful incremental
        // batch alone cannot upgrade an inventory whose full traversal was incomplete.
        inventory.status.state = if state == IndexState::Ready && !inventory.complete {
            IndexState::Partial
        } else {
            state
        };
        inventory.status.message = description.map(message);
    }

    pub fn refresh(&self) -> VaultResult<VaultSnapshot> {
        self.ensure_current_manifest()?;
        let inventory = self.inventory();
        Ok(VaultSnapshot {
            id: self.id.clone(),
            name: self.name.clone(),
            root: self.root.to_string_lossy().into_owned(),
            issues: inventory.issues.items.clone(),
            issue_count: inventory.issues.count,
            indexing: inventory.status.clone(),
        })
    }

    pub fn list_entries(
        &self,
        directory: &str,
        offset: usize,
        limit: usize,
    ) -> VaultResult<VaultPage> {
        self.ensure_current_manifest()?;
        if !directory.is_empty() {
            relative(directory)?;
        }
        let limit = if limit == 0 { 100 } else { limit.min(200) };
        let inventory = self.inventory();
        let children = inventory.children.get(directory);
        let total = children.map_or(0, BTreeSet::len);
        let entries = children
            .into_iter()
            .flatten()
            .skip(offset)
            .take(limit)
            .filter_map(|path| inventory.rows.get(path).map(|row| row.entry.clone()))
            .collect();
        Ok(VaultPage {
            directory: directory.into(),
            offset,
            limit,
            entries,
            total,
            has_more: offset.saturating_add(limit) < total,
            indexing: inventory.status.clone(),
        })
    }

    pub(super) fn require_complete_inventory(&self) -> VaultResult<()> {
        self.ensure_current_manifest()?;
        let inventory = self.inventory();
        if !inventory.complete || inventory.status.state != IndexState::Ready {
            return Err(VaultError::invalid(
                "Identity checks require a complete, ready inventory. Reconcile the Vault first, or create a Note with a newly generated UUID. No source was changed.",
            ));
        }
        Ok(())
    }

    pub(super) fn identity_paths(&self, id: &str) -> VaultResult<BTreeSet<String>> {
        self.require_complete_inventory()?;
        let paths = {
            let inventory = self.inventory();
            if !inventory.complete || inventory.status.state != IndexState::Ready {
                return Err(VaultError::invalid(
                    "The inventory changed. Reconcile before checking identities.",
                ));
            }
            inventory.identities.get(id).cloned().unwrap_or_default()
        };
        if paths.iter().any(|path| kind(Path::new(path)) != "markdown") {
            return Err(VaultError::conflict(
                "This UUID belongs to document companion metadata, not the imported Note. Nothing was overwritten.",
                None,
            ));
        }
        Ok(paths)
    }

    pub(super) fn matching_note(&self, path: &str, id: &str) -> VaultResult<NoteDocument> {
        let note = self.read_note(path)?;
        if note.id.as_deref() != Some(id) {
            self.set_index_state(
                IndexState::Stale,
                Some("An identity changed on disk. Reconcile before importing.".into()),
            );
            return Err(VaultError::invalid(
                "A matching Note changed externally. Reconcile before checking identities.",
            ));
        }
        Ok(note)
    }

    fn index_directory(&self, path: &str) -> VaultResult<Dir> {
        let mut dir = self.dir.try_clone()?;
        if !path.is_empty() {
            for component in relative(path)?.components() {
                dir = dir.open_dir_nofollow(Path::new(component.as_os_str()))?;
            }
        }
        Ok(dir)
    }

    pub fn reconcile(
        &self,
        cancel: &AtomicBool,
        on_directory: &mut dyn FnMut(&Path) -> VaultResult<()>,
    ) -> VaultResult<bool> {
        let _work = self
            .index_work
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.ensure_current_manifest()?;
        let mut work = Work::new(self, cancel, on_directory, true);
        let dir = self.dir.try_clone()?;
        work.directory(&dir, "", 0);
        work.finish(&[String::new()])
    }

    pub fn apply_changes(
        &self,
        paths: &[PathBuf],
        cancel: &AtomicBool,
        on_directory: &mut dyn FnMut(&Path) -> VaultResult<()>,
    ) -> VaultResult<bool> {
        let _work = self
            .index_work
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.ensure_current_manifest()?;
        let mut work = Work::new(self, cancel, on_directory, false);
        if work.full {
            // A missing cache cannot be reconstructed from one watcher delta. Reuse the
            // bounded full walk; cancellation/limits keep its partial state explicit.
            let dir = self.dir.try_clone()?;
            work.directory(&dir, "", 0);
            return work.finish(&[String::new()]);
        }
        let mut scopes = BTreeSet::new();
        if paths.len() > 1024 {
            work.partial(
                "",
                "The incremental path budget was exceeded. Reconcile the Vault.",
            );
        }
        for path in paths.iter().take(1024) {
            if !work.checkpoint() {
                break;
            }
            let path = if path.is_absolute() {
                match path.strip_prefix(&self.root) {
                    Ok(path) => path,
                    Err(_) => {
                        work.partial("", "A watcher path was outside the Vault and was ignored.");
                        continue;
                    }
                }
            } else {
                path.as_path()
            };
            let Some(path) = path.to_str() else {
                work.partial("", "A changed filename is not valid Unicode.");
                continue;
            };
            #[cfg(windows)]
            let normalized = path.replace('\\', "/");
            #[cfg(windows)]
            let path = normalized.as_str();
            if path.is_empty() {
                scopes.insert(String::new());
                continue;
            }
            if relative(path).is_err() {
                work.partial("", "An unsafe watcher path was ignored.");
                continue;
            }
            if path.split('/').any(Self::ignored_directory) {
                continue;
            }
            let path = companion_original(path).unwrap_or(path);
            if path == "vault.json" {
                continue;
            }
            scopes.insert(path.to_owned());
        }
        // One parent event subsumes its descendants; no duplicate subtree walks in a batch.
        let mut admitted: Vec<String> = Vec::new();
        for path in scopes {
            if admitted.iter().any(|parent| {
                parent.is_empty()
                    || path == *parent
                    || path
                        .strip_prefix(parent)
                        .is_some_and(|suffix| suffix.starts_with('/'))
            }) {
                continue;
            }
            admitted.push(path);
        }
        for path in &admitted {
            if !work.examine() {
                break;
            }
            if path.is_empty() {
                match self.dir.try_clone() {
                    Ok(dir) => work.directory(&dir, "", 0),
                    Err(error) => work.partial(path, error.to_string()),
                }
                continue;
            }
            let parent = match self.index_directory(parent_path(path)) {
                Ok(dir) => dir,
                Err(error) => {
                    if self
                        .dir
                        .symlink_metadata(path)
                        .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                    {
                        work.delete_subtree(path);
                    } else {
                        work.partial(path, error.message);
                    }
                    continue;
                }
            };
            let name = Path::new(path)
                .file_name()
                .expect("Validated relative path");
            match parent.symlink_metadata(name) {
                Ok(metadata) if metadata.is_dir() => {
                    work.put_directory(path);
                    match parent.open_dir_nofollow(name) {
                        Ok(dir) => work.directory(&dir, path, path.split('/').count()),
                        Err(error) => work.partial(path, error.to_string()),
                    }
                }
                Ok(metadata) if metadata.is_file() => {
                    work.delete_subtree(path);
                    work.file(&parent, Path::new(name), path);
                }
                Ok(_) => {
                    work.delete_subtree(path);
                    work.issues.push(
                        path,
                        "Filesystem links and non-regular files are not followed.",
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    work.delete_subtree(path);
                    if matches!(kind(Path::new(path)), "pdf" | "docx") {
                        let companion = format!("{path}.meta.yaml");
                        let name = Path::new(&companion)
                            .file_name()
                            .expect("Companion filename");
                        if parent
                            .symlink_metadata(name)
                            .is_ok_and(|metadata| metadata.is_file())
                        {
                            work.issues.push(&companion, "Companion metadata has no original document; reassociation is required.");
                        }
                    }
                }
                Err(error) => work.partial(path, error.to_string()),
            }
        }
        work.finish(&admitted)
    }
}

fn companion_original(path: &str) -> Option<&str> {
    path.strip_suffix(".meta.yaml")
        .filter(|original| matches!(kind(Path::new(original)), "pdf" | "docx"))
}

enum Delta {
    Put(IndexedEntry),
    DeleteSubtree(String),
}

struct Work<'a> {
    vault: &'a Vault,
    cancel: &'a AtomicBool,
    on_directory: &'a mut dyn FnMut(&Path) -> VaultResult<()>,
    started: Instant,
    progress: Instant,
    examined: usize,
    directories: usize,
    metadata_read: usize,
    incomplete: bool,
    halted: bool,
    full: bool,
    was_complete: bool,
    epoch: u64,
    token: String,
    issues: Issues,
    metadata_issues: Issues,
    pending: Vec<Delta>,
    database: Option<SqliteConnection>,
}

impl<'a> Work<'a> {
    fn new(
        vault: &'a Vault,
        cancel: &'a AtomicBool,
        on_directory: &'a mut dyn FnMut(&Path) -> VaultResult<()>,
        full: bool,
    ) -> Self {
        let started = Instant::now();
        let (epoch, was_complete) = {
            let mut inventory = vault.inventory();
            inventory.epoch += 1;
            inventory.status.state = if full {
                IndexState::Indexing
            } else {
                IndexState::Stale
            };
            inventory.status.scanned_entries = 0;
            inventory.status.message =
                Some("Reading bounded document metadata; source files remain available.".into());
            (inventory.epoch, inventory.complete)
        };
        let mut work = Self {
            vault,
            cancel,
            on_directory,
            started,
            progress: started,
            // Reserve both bounded manifest guards as part of the metadata read budget.
            examined: 0,
            directories: 0,
            metadata_read: 2 * MAX_METADATA_BYTES as usize,
            incomplete: false,
            halted: false,
            full,
            was_complete,
            epoch,
            token: Uuid::new_v4().to_string(),
            issues: Issues::default(),
            metadata_issues: Issues::default(),
            pending: Vec::with_capacity(COMMIT_ROWS),
            database: None,
        };
        if work.checkpoint() {
            match tauri::async_runtime::block_on(open_index(vault)) {
                Ok((connection, fresh)) => {
                    work.database = Some(connection);
                    if fresh && !full {
                        work.full = true;
                        vault.set_index_state(
                            IndexState::Indexing,
                            Some("The disposable SQLite index was recreated; rebuilding bounded metadata.".into()),
                        );
                    }
                }
                Err(error) => work.cache_error(error),
            }
        }
        work
    }

    fn partial(&mut self, path: &str, description: impl Into<String>) {
        self.incomplete = true;
        self.issues.push(path, description);
    }

    fn checkpoint(&mut self) -> bool {
        if self.halted {
            return false;
        }
        if self.cancel.load(Ordering::Acquire) {
            self.halted = true;
            self.partial(
                "",
                "Indexing was cancelled. Unseen inventory rows were retained.",
            );
        } else if self.started.elapsed() >= WORK_TIME {
            self.halted = true;
            self.partial(
                "",
                "The five-second indexing budget was reached. Unseen inventory rows were retained.",
            );
        }
        !self.halted
    }

    fn examine(&mut self) -> bool {
        if !self.checkpoint() {
            return false;
        }
        if self.examined >= MAX_ENTRIES {
            self.halted = true;
            self.partial("", "The 50,000-entry inspection budget was reached. Narrow the Vault or reconcile after reducing its contents.");
            return false;
        }
        self.examined += 1;
        if self.examined.is_multiple_of(COMMIT_ROWS)
            || self.progress.elapsed() >= Duration::from_millis(150)
        {
            self.flush();
        }
        true
    }

    fn directory(&mut self, dir: &Dir, path: &str, depth: usize) {
        if !self.checkpoint() {
            return;
        }
        if depth > MAX_DEPTH {
            self.partial(path, "The directory depth limit of 32 was reached.");
            return;
        }
        if self.directories >= MAX_DIRECTORIES {
            self.halted = true;
            self.partial(
                path,
                "The 2,048-directory discovery/watch budget was reached.",
            );
            return;
        }
        self.directories += 1;
        let absolute = self.vault.root.join(path);
        if !absolute
            .canonicalize()
            .is_ok_and(|current| current == absolute)
        {
            self.partial(
                path,
                "A directory moved or became a link before watcher registration.",
            );
            return;
        }
        if let Err(error) = (self.on_directory)(&absolute) {
            self.partial(
                path,
                format!("Directory watcher unavailable: {}", error.message),
            );
            return;
        }
        if !self.checkpoint() {
            return;
        }
        let mut entries = match dir.entries() {
            Ok(entries) => entries,
            Err(error) => {
                self.partial(path, error.to_string());
                return;
            }
        };
        loop {
            if !self.checkpoint() {
                break;
            }
            // Probe exhaustion before charging an entry, so exactly 50,000 entries can complete.
            let Some(entry) = entries.next() else { break };
            if !self.examine() {
                break;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    self.partial(path, error.to_string());
                    continue;
                }
            };
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                self.partial(path, "A filename is not valid Unicode and cannot be shown.");
                continue;
            };
            if Vault::ignored_directory(name) {
                continue;
            }
            let child = if path.is_empty() {
                name.to_owned()
            } else {
                format!("{path}/{name}")
            };
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    self.partial(&child, error.to_string());
                    continue;
                }
            };
            if file_type.is_dir() {
                self.put_directory(&child);
                if self.halted {
                    break;
                }
                match dir.open_dir_nofollow(name) {
                    Ok(dir) => self.directory(&dir, &child, depth + 1),
                    Err(error) => self.partial(&child, error.to_string()),
                }
            } else if file_type.is_file() {
                self.file(dir, Path::new(name), &child);
            } else {
                self.issues.push(
                    &child,
                    "Filesystem links and non-regular files are not followed.",
                );
            }
        }
    }

    fn put_directory(&mut self, path: &str) {
        self.put(IndexedEntry {
            entry: VaultEntry {
                path: path.into(),
                kind: "directory",
                id: None,
                metadata_error: None,
            },
            metadata: None,
            references: Vec::new(),
            epoch: self.epoch,
        });
    }

    fn file(&mut self, dir: &Dir, name: &Path, path: &str) {
        if path.rsplit('/').next().is_some_and(|name| {
            name.starts_with(".adamant-write-") || name.starts_with(".adamant-recovery-")
        }) {
            self.issues.push(
                path,
                "Retained safe-write or recovery source. Inspect this version before deleting it.",
            );
        }
        if !Vault::supported_path(name) {
            if let Some(original) = companion_original(path) {
                let original_name = Path::new(original).file_name().expect("Companion filename");
                match dir.symlink_metadata(original_name) {
                    Ok(metadata) if metadata.is_file() => {}
                    Ok(_) => self.issues.push(path, "Companion metadata has no regular original document; reassociation is required."),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => self.issues.push(path, "Companion metadata has no original document; reassociation is required."),
                    Err(error) => self.partial(path, error.to_string()),
                }
            }
            return;
        }
        let kind = kind(name);
        let mut row = IndexedEntry {
            entry: VaultEntry {
                path: path.into(),
                kind,
                id: None,
                metadata_error: None,
            },
            metadata: None,
            references: Vec::new(),
            epoch: self.epoch,
        };
        let metadata_name = if kind == "markdown" {
            name.to_path_buf()
        } else {
            let mut name = name.as_os_str().to_os_string();
            name.push(".meta.yaml");
            PathBuf::from(name)
        };
        // Missing companions are known absence, not evidence of an incomplete traversal.
        let missing_companion = kind != "markdown"
            && dir
                .symlink_metadata(&metadata_name)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound);
        if missing_companion {
            row.entry.metadata_error =
                Some("Companion metadata unavailable: no companion file.".into());
        } else {
            match self.metadata_text(dir, &metadata_name, kind == "markdown") {
                Ok(text) => {
                    let metadata = if kind == "markdown" {
                        note_metadata(&text)
                    } else {
                        companion_metadata(&text)
                    };
                    if metadata.value.is_none() && (kind != "markdown" || !text.is_empty()) {
                        self.incomplete = true;
                    }
                    row.entry.id = metadata.id;
                    row.entry.metadata_error = metadata.error.map(message);
                    if let Some(value) = metadata.value {
                        if let Some(references) = value.get("refs").and_then(Value::as_array) {
                            for reference in references {
                                if matches!(
                                    reference["kind"].as_str(),
                                    Some("note" | "topic" | "document" | "documentation-page")
                                ) {
                                    if let Some(id) = reference["id"]
                                        .as_str()
                                        .and_then(|id| Uuid::parse_str(id).ok())
                                    {
                                        row.references.push(id.to_string());
                                    }
                                }
                            }
                            row.references.sort_unstable();
                            row.references.dedup();
                        }
                        row.metadata = Some(value.to_string());
                    }
                }
                Err(error) => {
                    self.incomplete = true;
                    row.entry.metadata_error = Some(message(error.message));
                }
            }
        }
        if let Some(error) = &row.entry.metadata_error {
            self.metadata_issues.push(path, error.clone());
        }
        self.put(row);
    }

    fn metadata_text(&mut self, dir: &Dir, name: &Path, note: bool) -> VaultResult<String> {
        let mut file = open_regular(dir, name)?;
        let length = file.metadata()?.len();
        if !note && length > MAX_METADATA_BYTES {
            return Err(VaultError::invalid(
                "Companion metadata exceeds 256 KiB; it was not read.",
            ));
        }
        let mut bytes = Vec::new();
        let mut line_start = 0;
        let mut first = true;
        loop {
            if (!note && bytes.len() as u64 == length)
                || (note
                    && bytes.len() as u64 == length
                    && !first
                    && matches!(trim_delimiter(&bytes[line_start..]), b"---" | b"..."))
            {
                return String::from_utf8(bytes)
                    .map_err(|_| VaultError::invalid("Metadata must contain UTF-8 text."));
            }
            if !self.checkpoint() {
                return Err(VaultError::invalid(
                    "Metadata inspection stopped before completion.",
                ));
            }
            let available = (MAX_METADATA_BYTES as usize - bytes.len())
                .min(MAX_BATCH_BYTES - self.metadata_read);
            if available == 0 {
                if self.metadata_read >= MAX_BATCH_BYTES {
                    self.halted = true;
                }
                return Err(VaultError::invalid(
                    "The 256 KiB metadata or 32 MiB batch read budget was reached.",
                ));
            }
            let mut buffer = [0u8; 4096];
            let count = file.read(&mut buffer[..available.min(4096)])?;
            self.metadata_read += count;
            bytes.extend_from_slice(&buffer[..count]);
            if note {
                while let Some(end) = bytes[line_start..].iter().position(|byte| *byte == b'\n') {
                    let end = line_start + end + 1;
                    let mut line = &bytes[line_start..end];
                    if first {
                        line = line.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(line);
                    }
                    let line = trim_delimiter(line);
                    if first && line != b"---" {
                        return Ok(String::new());
                    }
                    if !first && matches!(line, b"---" | b"...") {
                        bytes.truncate(end);
                        return String::from_utf8(bytes)
                            .map_err(|_| VaultError::invalid("Metadata must contain UTF-8 text."));
                    }
                    first = false;
                    line_start = end;
                }
                if first {
                    let line = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
                    if line.len() >= 3
                        && (line[..3] != *b"---"
                            || line[3..]
                                .iter()
                                .any(|byte| !matches!(byte, b'\r' | b' ' | b'\t')))
                    {
                        return Ok(String::new());
                    }
                }
            }
            if count == 0 {
                if note
                    && first
                    && trim_delimiter(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes))
                        != b"---"
                {
                    return Ok(String::new());
                }
                return String::from_utf8(bytes)
                    .map_err(|_| VaultError::invalid("Metadata must contain UTF-8 text."));
            }
        }
    }

    fn put(&mut self, row: IndexedEntry) {
        if !self.checkpoint() {
            return;
        }
        if !self.vault.inventory().put(row.clone()) {
            self.halted = true;
            self.partial(&row.entry.path, "The bounded in-memory entry, directory or metadata capacity was reached. Existing rows were retained.");
            return;
        }
        self.pending.push(Delta::Put(row));
        if self.pending.len() >= COMMIT_ROWS {
            self.flush();
        }
    }

    fn subtree_paths(&self, path: &str) -> Vec<String> {
        let inventory = self.vault.inventory();
        let prefix = format!("{path}/");
        let mut paths: Vec<String> = inventory
            .rows
            .range(prefix.clone()..)
            .take_while(|(key, _)| key.starts_with(&prefix))
            .map(|(key, _)| key.clone())
            .collect();
        if inventory.rows.contains_key(path) {
            paths.push(path.into());
        }
        paths
    }

    fn delete_subtree(&mut self, path: &str) {
        for path in self.subtree_paths(path) {
            if !self.checkpoint() {
                break;
            }
            self.vault.inventory().remove(&path);
        }
        // Also invalidate cached rows from an earlier process that have not entered memory.
        self.pending.push(Delta::DeleteSubtree(path.into()));
        if self.pending.len() >= COMMIT_ROWS {
            self.flush();
        }
    }

    fn cache_error(&mut self, error: VaultError) {
        self.issues.push("vault.json", format!("Files and the in-memory inventory remain available; the disposable SQLite index could not be updated: {}", error.message));
        self.database = None;
    }

    fn flush(&mut self) {
        if let Some(database) = self.database.as_mut() {
            if !self.pending.is_empty() {
                if let Err(error) = tauri::async_runtime::block_on(write_changes(
                    database,
                    &self.pending,
                    &self.token,
                )) {
                    self.cache_error(error);
                }
            }
        }
        self.pending.clear();
        let mut inventory = self.vault.inventory();
        inventory.status.scanned_entries = self.examined;
        inventory.issues = self.issues.clone();
        inventory.issues.append(&self.metadata_issues);
        self.progress = Instant::now();
    }

    fn diagnostics(&mut self, complete: bool, scopes: &[String]) {
        if !self.checkpoint() {
            return;
        }
        // Count eligible identities once. Repeatedly filtering a large collision group for
        // every member would become quadratic when a reconciliation has unseen old rows.
        let identities: HashMap<String, usize> = {
            let inventory = self.vault.inventory();
            inventory
                .identities
                .iter()
                .filter_map(|(id, paths)| {
                    let count = paths
                        .iter()
                        .filter(|path| {
                            !complete
                                || inventory.rows.get(*path).is_some_and(|row| {
                                    row.epoch == self.epoch || !covered(path, scopes)
                                })
                        })
                        .count();
                    (count > 0).then(|| (id.clone(), count))
                })
                .collect()
        };
        let mut after = None;
        loop {
            if !self.checkpoint() {
                break;
            }
            let rows = {
                let inventory = self.vault.inventory();
                inventory
                    .rows
                    .range::<String, _>((after.as_ref().map_or(Unbounded, Excluded), Unbounded))
                    .take(COMMIT_ROWS)
                    .map(|(_, row)| (row.entry.clone(), row.references.clone(), row.epoch))
                    .collect::<Vec<_>>()
            };
            if rows.is_empty() {
                break;
            }
            after = rows.last().map(|(entry, _, _)| entry.path.clone());
            for (entry, references, epoch) in rows {
                let path = &entry.path;
                if complete && epoch != self.epoch && covered(path, scopes) {
                    continue;
                }
                if epoch != self.epoch {
                    if let Some(error) = entry.metadata_error {
                        self.issues.push(path, error);
                    }
                }
                if let Some(id) = &entry.id {
                    if identities.get(id).is_some_and(|count| *count > 1) {
                        self.issues.push_with(path, || format!("UUID collision {id}: multiple documents share this identity. Content was not merged."));
                    }
                }
                if complete {
                    for id in &references {
                        if !identities.contains_key(id) {
                            if self.issues.items.len() < MAX_ISSUES {
                                let issue_path = if matches!(entry.kind, "pdf" | "docx") {
                                    format!("{path}.meta.yaml")
                                } else {
                                    path.clone()
                                };
                                self.issues.push_with(&issue_path, || {
                                    format!("Unresolved reference: {id}")
                                });
                            } else {
                                self.issues.count = self.issues.count.saturating_add(1);
                            }
                        }
                    }
                }
            }
        }
    }

    fn finish(mut self, scopes: &[String]) -> VaultResult<bool> {
        self.checkpoint();
        if let Err(error) = self.vault.ensure_current_manifest() {
            self.partial("vault.json", error.message.clone());
            self.database = None;
            self.flush();
            self.vault.inventory().complete = false;
            self.vault
                .set_index_state(IndexState::Partial, Some(message(error.message.clone())));
            return Err(error);
        }
        self.diagnostics(!self.incomplete && (self.full || self.was_complete), scopes);
        self.flush();
        // No sweep after an incomplete traversal. Positive changes and observed deletions
        // already committed above remain useful; all unobserved rows stay intact.
        if !self.incomplete {
            let missing = {
                let inventory = self.vault.inventory();
                inventory
                    .rows
                    .iter()
                    .filter(|(path, row)| row.epoch != self.epoch && covered(path, scopes))
                    .map(|(path, _)| path.clone())
                    .collect::<Vec<_>>()
            };
            if self.checkpoint() {
                let result = if let Some(database) = self.database.as_mut() {
                    tauri::async_runtime::block_on(prune_index(
                        database,
                        scopes,
                        &self.token,
                        self.cancel,
                        self.started,
                    ))
                } else {
                    Ok(true)
                };
                match result {
                    Ok(false) => {
                        self.checkpoint();
                    }
                    Err(error) => {
                        self.cache_error(error);
                        self.checkpoint();
                    }
                    Ok(true) => {}
                }
                if !self.incomplete {
                    // All source enumeration and cancellable SQL work is complete. This small
                    // in-memory commit has no I/O; cancellation after this boundary is a new state.
                    for paths in missing.chunks(COMMIT_ROWS) {
                        let mut inventory = self.vault.inventory();
                        for path in paths {
                            inventory.remove(path);
                        }
                    }
                }
            }
        }
        let complete = !self.incomplete;
        {
            let mut inventory = self.vault.inventory();
            inventory.complete = complete && (self.full || self.was_complete);
            inventory.issues = self.issues.clone();
            inventory.issues.append(&self.metadata_issues);
            inventory.status.scanned_entries = self.examined;
            // Never Ready here: events may have arrived while the traversal was running.
            inventory.status.state = if self.cancel.load(Ordering::Acquire) {
                IndexState::Cancelled
            } else if !complete {
                IndexState::Partial
            } else if self.full {
                IndexState::Indexing
            } else {
                IndexState::Stale
            };
            inventory.status.message = Some(if complete {
                "Metadata batch complete; waiting for pending filesystem events to drain.".into()
            } else {
                self.issues.items.first().map(|issue| issue.message.clone()).unwrap_or_else(|| "Metadata indexing is incomplete. Existing rows and source files were retained.".into())
            });
        }
        Ok(complete)
    }
}

fn trim_delimiter(mut line: &[u8]) -> &[u8] {
    while line
        .last()
        .is_some_and(|byte| matches!(byte, b'\r' | b'\n' | b' ' | b'\t'))
    {
        line = &line[..line.len() - 1];
    }
    line
}

fn covered(mut path: &str, scopes: &[String]) -> bool {
    loop {
        if scopes
            .binary_search_by(|scope| scope.as_str().cmp(path))
            .is_ok()
        {
            return true;
        }
        if path.is_empty() {
            return false;
        }
        path = parent_path(path);
    }
}

async fn open_index(vault: &Vault) -> VaultResult<(SqliteConnection, bool)> {
    let options = SqliteConnectOptions::new()
        .filename(vault.index_path())
        .create_if_missing(true)
        .busy_timeout(Duration::from_millis(100));
    let mut connection = SqliteConnection::connect_with(&options).await?;
    let columns = sqlx::query("PRAGMA table_info(entries)")
        .fetch_all(&mut connection)
        .await?;
    let fresh = columns.is_empty();
    if fresh {
        sqlx::query("CREATE TABLE IF NOT EXISTS entries (path TEXT PRIMARY KEY, kind TEXT NOT NULL, id TEXT, metadata TEXT, metadata_error TEXT, generation TEXT)")
            .execute(&mut connection).await?;
    }
    // One-time migration of the previous disposable source-copy cache, not a refresh rebuild.
    for column in &columns {
        let name: &str = column.try_get("name")?;
        match name {
            "source" => {
                sqlx::query("ALTER TABLE entries DROP COLUMN source")
                    .execute(&mut connection)
                    .await?;
            }
            "revision" => {
                sqlx::query("ALTER TABLE entries DROP COLUMN revision")
                    .execute(&mut connection)
                    .await?;
            }
            _ => {}
        }
    }
    if !fresh
        && !columns.iter().any(|column| {
            column
                .try_get::<&str, _>("name")
                .is_ok_and(|name| name == "generation")
        })
    {
        sqlx::query("ALTER TABLE entries ADD COLUMN generation TEXT")
            .execute(&mut connection)
            .await?;
    }
    sqlx::query("CREATE INDEX IF NOT EXISTS entries_id ON entries(id)")
        .execute(&mut connection)
        .await?;
    Ok((connection, fresh))
}

async fn write_changes(
    connection: &mut SqliteConnection,
    changes: &[Delta],
    token: &str,
) -> VaultResult<()> {
    let mut transaction = connection.begin().await?;
    for change in changes {
        match change {
            Delta::Put(row) => {
                sqlx::query("INSERT INTO entries (path,kind,id,metadata,metadata_error,generation) VALUES (?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET kind=excluded.kind,id=excluded.id,metadata=excluded.metadata,metadata_error=excluded.metadata_error,generation=excluded.generation")
                    .bind(&row.entry.path).bind(row.entry.kind).bind(&row.entry.id).bind(&row.metadata)
                    .bind(&row.entry.metadata_error).bind(token).execute(&mut *transaction).await?;
            }
            Delta::DeleteSubtree(path) => {
                let prefix = format!("{path}/");
                sqlx::query("DELETE FROM entries WHERE path = ? OR substr(path,1,?) = ?")
                    .bind(path)
                    .bind(prefix.chars().count() as i64)
                    .bind(prefix)
                    .execute(&mut *transaction)
                    .await?;
            }
        }
    }
    transaction.commit().await?;
    Ok(())
}

async fn prune_index(
    connection: &mut SqliteConnection,
    scopes: &[String],
    token: &str,
    cancel: &AtomicBool,
    started: Instant,
) -> VaultResult<bool> {
    let mut transaction = connection.begin().await?;
    for scope in scopes {
        if cancel.load(Ordering::Acquire) || started.elapsed() >= WORK_TIME {
            transaction.rollback().await?;
            return Ok(false);
        }
        if scope.is_empty() {
            sqlx::query("DELETE FROM entries WHERE generation IS NULL OR generation != ?")
                .bind(token)
                .execute(&mut *transaction)
                .await?;
        } else {
            let prefix = format!("{scope}/");
            sqlx::query("DELETE FROM entries WHERE (generation IS NULL OR generation != ?) AND (path = ? OR substr(path,1,?) = ?)")
                .bind(token).bind(scope).bind(prefix.chars().count() as i64).bind(prefix)
                .execute(&mut *transaction).await?;
        }
    }
    if cancel.load(Ordering::Acquire) || started.elapsed() >= WORK_TIME {
        transaction.rollback().await?;
        return Ok(false);
    }
    transaction.commit().await?;
    Ok(true)
}
