//! Bounded, metadata-only inventory. Source reads and atomic writes stay in `vault`.
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::Path,
    sync::MutexGuard,
};

use serde::Serialize;

use super::capability::{kind, relative};
use super::{NoteDocument, Vault, VaultEntry, VaultError, VaultIssue, VaultResult, VaultSnapshot};

mod search;
mod work;
pub(super) use search::BodyIndex;

const MAX_ENTRIES: usize = 50_000;
const MAX_DIRECTORIES: usize = 2048;
pub(super) const MAX_METADATA_BYTES: u64 = 256 * 1024;
const MAX_BATCH_BYTES: usize = 32 * 1024 * 1024;
const MAX_ISSUES: usize = 200;
const MAX_MESSAGE_BYTES: usize = 1024;

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
    pub generation: u64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub kind: String,
    pub id: Option<String>,
    pub identity: String,
    pub line: Option<usize>,
    pub column: Option<usize>,
    pub snippet: String,
    pub revision: Option<String>,
}

pub struct SearchQuery<'a> {
    pub request_id: String,
    pub query: &'a str,
    pub mode: &'a str,
    pub offset: usize,
    pub limit: usize,
    pub expected_generation: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub request_id: String,
    pub hits: Vec<SearchHit>,
    pub has_more: bool,
    pub can_continue: bool,
    pub truncated: bool,
    pub indexing: IndexStatus,
    pub generation: u64,
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
    identity: Option<String>,
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
    // Public row snapshot, independent of the reconciliation sweep epoch.
    generation: u64,
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
            generation: 1,
        }
    }

    fn remove(&mut self, path: &str) {
        let Some(row) = self.rows.remove(path) else {
            return;
        };
        self.generation += 1;
        self.metadata_bytes -= row.weight();
        if row.entry.kind == "directory" {
            self.directories -= 1;
        } else {
            self.status.indexed_documents -= 1;
        }
        if let Some(id) = &row.entry.id
            && let Some(paths) = self.identities.get_mut(id)
        {
            paths.remove(path);

            if paths.is_empty() {
                self.identities.remove(id);
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
        self.generation += 1;
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
            root: self.vault_root.to_string_lossy().into_owned(),
            content_root: self.content_root_relative,
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
        self.list_entries_filtered(directory, offset, limit, "name", "", None)
    }

    pub fn list_entries_filtered(
        &self,
        directory: &str,
        offset: usize,
        limit: usize,
        sort: &str,
        filter: &str,
        generation: Option<u64>,
    ) -> VaultResult<VaultPage> {
        self.ensure_current_manifest()?;
        if !directory.is_empty() {
            relative(directory)?;
        }
        let limit = if limit == 0 { 100 } else { limit.min(200) };
        let inventory = self.inventory();
        if let Some(expected) = generation
            && expected != inventory.generation
        {
            return Err(VaultError::conflict(
                "The Vault inventory changed. Restart this directory listing.",
                None,
            ));
        }
        let needle = filter.to_lowercase();
        let mut children = inventory
            .children
            .get(directory)
            .into_iter()
            .flatten()
            .filter(|path| needle.is_empty() || path.to_lowercase().contains(&needle))
            .filter_map(|path| inventory.rows.get(path))
            .collect::<Vec<_>>();
        children.sort_by(|left, right| {
            right
                .entry
                .kind
                .eq("directory")
                .cmp(&left.entry.kind.eq("directory"))
                .then_with(|| match sort {
                    "type" => left
                        .entry
                        .kind
                        .cmp(right.entry.kind)
                        .then_with(|| left.entry.path.cmp(&right.entry.path)),
                    "modified" => right
                        .entry
                        .modified_at
                        .cmp(&left.entry.modified_at)
                        .then_with(|| left.entry.path.cmp(&right.entry.path)),
                    _ => left.entry.path.cmp(&right.entry.path),
                })
        });
        let total = children.len();
        let entries = children
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|row| row.entry.clone())
            .collect();
        Ok(VaultPage {
            directory: directory.into(),
            offset,
            limit,
            entries,
            total,
            has_more: offset.saturating_add(limit) < total,
            indexing: inventory.status.clone(),
            generation: inventory.generation,
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
}
