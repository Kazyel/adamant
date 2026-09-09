//! Portable files are authoritative. `Vault::open` and all methods work without a window or dialog.
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, File, OpenOptions},
};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
#[path = "vault_index.rs"]
mod indexing;
use indexing::Inventory;
pub use indexing::{IndexState, IndexStatus, VaultPage};
use uuid::Uuid;

use crate::vault_metadata::{adopt, manifest_validator, note_metadata};

pub type VaultResult<T> = Result<T, VaultError>;
const MAX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultError {
    pub kind: &'static str,
    pub message: String,
    pub current: Option<NoteDocument>,
}

impl VaultError {
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self {
            kind: "invalid",
            message: message.into(),
            current: None,
        }
    }
    pub(crate) fn io(message: impl Into<String>) -> Self {
        Self {
            kind: "io",
            message: message.into(),
            current: None,
        }
    }
    fn conflict(message: impl Into<String>, current: Option<NoteDocument>) -> Self {
        Self {
            kind: "conflict",
            message: message.into(),
            current,
        }
    }
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for VaultError {}
impl From<std::io::Error> for VaultError {
    fn from(error: std::io::Error) -> Self {
        Self::io(error.to_string())
    }
}
impl From<sqlx::Error> for VaultError {
    fn from(error: sqlx::Error) -> Self {
        Self::io(format!("Derived index: {error}"))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDocument {
    pub path: String,
    pub text: String,
    pub revision: String,
    pub id: Option<String>,
    pub metadata_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    pub path: String,
    pub kind: &'static str,
    pub id: Option<String>,
    pub metadata_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultIssue {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSnapshot {
    pub id: String,
    pub name: String,
    pub root: String,
    pub issues: Vec<VaultIssue>,
    pub issue_count: usize,
    pub indexing: IndexStatus,
}

pub struct Vault {
    root: PathBuf,
    dir: Dir,
    id: String,
    name: String,
    state_dir: PathBuf,
    inventory: Mutex<Inventory>,
    index_work: Mutex<()>,
    identity_writes: Mutex<()>,
}

fn hash(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut hex = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        write!(&mut hex, "{byte:02x}").expect("Writing to a String cannot fail");
    }
    hex
}

fn document(path: &str, text: String) -> NoteDocument {
    let metadata = note_metadata(&text);
    NoteDocument {
        path: path.into(),
        revision: hash(text.as_bytes()),
        text,
        id: metadata.id,
        metadata_error: metadata.error,
    }
}

fn kind(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if extension.eq_ignore_ascii_case("md") => "markdown",
        Some(extension) if extension.eq_ignore_ascii_case("pdf") => "pdf",
        Some(extension) if extension.eq_ignore_ascii_case("docx") => "docx",
        _ => "file",
    }
}

fn relative(path: &str) -> VaultResult<&Path> {
    let value = Path::new(path);
    if path.is_empty()
        || path.contains('\0')
        || value.is_absolute()
        || value
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || path.split('/').any(|part| matches!(part, "" | "." | ".."))
    {
        return Err(VaultError::invalid(
            "Use a nonempty Vault-relative path without traversal or absolute components.",
        ));
    }
    Ok(value)
}

fn note_path(path: &str) -> VaultResult<&Path> {
    let path = relative(path)?;
    if kind(path) != "markdown" {
        return Err(VaultError::invalid("A Note needs a .md filename."));
    }
    Ok(path)
}

fn open_regular(dir: &Dir, name: &Path) -> VaultResult<File> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        // A malicious FIFO/device must not block a native command while its type is checked.
        options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
    }
    let file = dir.open_with(name, &options)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(VaultError::invalid(
            "Choose a regular file, not a link or device.",
        ));
    }
    Ok(file)
}

fn read_limited(dir: &Dir, name: &Path, limit: u64) -> VaultResult<Vec<u8>> {
    let file = open_regular(dir, name)?;
    let length = file.metadata()?.len();
    if length > limit {
        return Err(VaultError::invalid(format!(
            "The file exceeds the {limit}-byte read limit."
        )));
    }
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(VaultError::invalid(format!(
            "The file exceeds the {limit}-byte read limit."
        )));
    }
    Ok(bytes)
}

fn read_regular(dir: &Dir, name: &Path) -> VaultResult<Vec<u8>> {
    read_limited(dir, name, MAX_BYTES)
}

fn read_text(dir: &Dir, name: &Path) -> VaultResult<String> {
    String::from_utf8(read_regular(dir, name)?)
        .map_err(|_| VaultError::invalid("Markdown and metadata must contain UTF-8 source text."))
}

fn read_manifest(dir: &Dir) -> VaultResult<Value> {
    let bytes = read_limited(dir, Path::new("vault.json"), indexing::MAX_METADATA_BYTES).map_err(|error| {
        VaultError::invalid(format!(
            "Cannot read an Adamant vault.json: {}. Create an empty Vault, then import selected documents; restore the manifest to reopen an existing Vault.",
            error.message
        ))
    })?;
    let text = String::from_utf8(bytes)
        .map_err(|_| VaultError::invalid("vault.json must contain UTF-8 text."))?;
    let value: Value = serde_json::from_str(&text).map_err(|error| {
        VaultError::invalid(indexing::message(format!("Invalid vault.json: {error}")))
    })?;
    if value["format"].as_str() != Some("adamant-vault")
        || value["formatVersion"].as_u64() != Some(1)
        || value["id"]
            .as_str()
            .and_then(|id| Uuid::parse_str(id).ok())
            .is_none()
    {
        return Err(VaultError::invalid(
            "This directory is not an Adamant Vault (format marker adamant-vault, version 1, UUID required). Create an empty Vault and import selected documents; unmarked folders are never scanned or migrated.",
        ));
    }
    manifest_validator().validate(&value).map_err(|error| {
        VaultError::invalid(indexing::message(format!("Invalid vault.json: {error}")))
    })?;
    Ok(value)
}

fn write_new(dir: &Dir, name: &Path, bytes: &[u8]) -> VaultResult<File> {
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = dir.open_with(name, &options)?;
    if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        let _ = dir.remove_file(name);
        return Err(error.into());
    }
    Ok(file)
}

fn sync_dir(dir: &Dir) -> VaultResult<()> {
    #[cfg(unix)]
    // Directory capabilities may use O_PATH; fsync needs a readable directory descriptor.
    dir.open(".")?.sync_all()?;
    Ok(())
}

fn private_dir(path: &Path) -> VaultResult<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    Ok(())
}

/// A directory capability granted by the native parent-folder picker, never by an IPC path.
pub struct VaultParent {
    root: PathBuf,
    dir: Dir,
}

impl VaultParent {
    pub fn select(root: &Path) -> VaultResult<Self> {
        if !fs::symlink_metadata(root)?.is_dir() {
            return Err(VaultError::invalid("Choose a real folder, not a symbolic link."));
        }
        let root = root.canonicalize()?;
        if root.to_str().is_none() {
            return Err(VaultError::invalid("The folder path must be valid Unicode."));
        }
        let dir = Dir::open_ambient_dir(&root, ambient_authority())?;
        verify_directory(&root, &dir)?;
        Ok(Self { root, dir })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn create(&self, name: &str, state_root: &Path) -> VaultResult<Vault> {
        if name.is_empty()
            || name.len() > 255
            || name.trim() != name
            || name.ends_with('.')
            || name.chars().any(|c| c.is_control() || "/\\<>:\"|?*".contains(c))
            || matches!(name, "." | "..")
        {
            return Err(VaultError::invalid("Use a single folder name, without path separators, special characters, or leading/trailing spaces."));
        }
        verify_directory(&self.root, &self.dir)?;
        let root = self.root.join(name);
        let state_root = state_directory(&root, state_root)?;
        self.dir.create_dir(name).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                VaultError::invalid("A file or folder with this name already exists. Choose another name, or open the existing Vault.")
            } else {
                error.into()
            }
        })?;
        // Never remove this directory on failure: another process may have added user files.
        let dir = self.dir.open_dir_nofollow(name)?;
        verify_directory(&root, &dir)?;
        if dir.entries()?.next().transpose()?.is_some() {
            return Err(VaultError::invalid("The new folder is no longer empty. Its contents were kept; choose another name."));
        }
        let bytes = serde_json::to_vec_pretty(&serde_json::json!({ "format": "adamant-vault", "formatVersion": 1, "id": Uuid::new_v4().to_string(), "name": name })).map_err(|error| VaultError::invalid(error.to_string()))?;
        let staging = format!(".adamant-write-{}", Uuid::new_v4());
        write_new(&dir, Path::new(&staging), &bytes)?;
        let result = dir.hard_link(&staging, &dir, "vault.json");
        let _ = dir.remove_file(&staging);
        result?;
        sync_dir(&dir)?;
        sync_dir(&self.dir)?;
        verify_directory(&root, &dir)?;
        Vault::from_dir(root, dir, state_root)
    }
}

fn verify_directory(root: &Path, dir: &Dir) -> VaultResult<()> {
    let current = fs::symlink_metadata(root)?;
    if !current.is_dir() || root.canonicalize()? != root {
        return Err(VaultError::invalid("The selected folder moved or was replaced. Choose it again."));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let opened = dir.try_clone()?.into_std_file().metadata()?;
        if current.dev() != opened.dev() || current.ino() != opened.ino() {
            return Err(VaultError::invalid("The selected folder moved or was replaced. Choose it again."));
        }
    }
    Ok(())
}

fn state_directory(root: &Path, state_root: &Path) -> VaultResult<PathBuf> {
    private_dir(state_root)?;
    let state_root = state_root.canonicalize()?;
    if state_root.starts_with(root) || root.starts_with(&state_root) {
        return Err(VaultError::invalid("Choose a Vault outside Adamant's machine-local data directory."));
    }
    Ok(state_root)
}

impl Vault {
    /// `state_root` is machine-local app data, outside the Vault. No dialog/runtime window is needed.
    /// Calls are synchronous; adapters use blocking workers without holding the session lock.
    pub fn open(root: &Path, state_root: &Path) -> VaultResult<Self> {
        let root = root.canonicalize()?;
        if root.to_str().is_none() {
            return Err(VaultError::invalid("The Vault path must be valid Unicode."));
        }
        let state_root = state_directory(&root, state_root)?;
        let dir = Dir::open_ambient_dir(&root, ambient_authority())?;
        Self::from_dir(root, dir, state_root)
    }

    fn from_dir(root: PathBuf, dir: Dir, state_root: PathBuf) -> VaultResult<Self> {
        let value = read_manifest(&dir)?;
        let id = Uuid::parse_str(value["id"].as_str().unwrap())
            .map_err(|error| VaultError::invalid(error.to_string()))?
            .to_string();
        let name = value["name"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                root.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            });
        let state_dir = state_root.join("vaults").join(format!(
            "{id}-{}",
            hash(root.as_os_str().as_encoded_bytes())
        ));
        private_dir(&state_dir)?;
        Ok(Self {
            root,
            dir,
            id,
            name,
            state_dir,
            inventory: Mutex::new(Inventory::new()),
            index_work: Mutex::new(()),
            identity_writes: Mutex::new(()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn index_path(&self) -> PathBuf {
        self.state_dir.join("index.sqlite")
    }
    pub fn recovery_directory(&self) -> PathBuf {
        self.state_dir.join("recovery")
    }

    fn ensure_current_manifest(&self) -> VaultResult<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let current = fs::symlink_metadata(&self.root)?;
            let opened = self.dir.try_clone()?.into_std_file().metadata()?;
            if !current.is_dir() || current.dev() != opened.dev() || current.ino() != opened.ino() {
                return Err(VaultError::invalid(
                    "The Vault root moved or was replaced. Reopen it at its current location.",
                ));
            }
        }
        let value = read_manifest(&self.dir)?;
        if value["id"]
            .as_str()
            .and_then(|id| Uuid::parse_str(id).ok())
            .map(|id| id.to_string())
            .as_deref()
            != Some(self.id.as_str())
        {
            return Err(VaultError::invalid(
                "The manifest identity changed externally. Close and reopen the Vault; no content or index was changed.",
            ));
        }
        Ok(())
    }

    fn parent(&self, path: &str, create: bool) -> VaultResult<(Dir, PathBuf)> {
        self.ensure_current_manifest()?;
        let path = relative(path)?;
        let mut dir = self.dir.try_clone()?;
        let components = path.components().collect::<Vec<_>>();
        for component in &components[..components.len() - 1] {
            let name = Path::new(component.as_os_str());
            if create {
                match dir.create_dir(name) {
                    Ok(()) => sync_dir(&dir)?,
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error.into()),
                }
            }
            dir = dir.open_dir_nofollow(name).map_err(|error| {
                VaultError::invalid(format!("Unsafe or unavailable parent directory: {error}"))
            })?;
        }
        Ok((dir, PathBuf::from(components.last().unwrap().as_os_str())))
    }

    fn note_is_absent(&self, path: &str) -> bool {
        let Ok(mut dir) = self.dir.try_clone() else {
            return false;
        };
        let mut components = Path::new(path).components().peekable();
        while let Some(component) = components.next() {
            let name = Path::new(component.as_os_str());
            if components.peek().is_none() {
                return dir
                    .symlink_metadata(name)
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound);
            }
            match dir.open_dir_nofollow(name) {
                Ok(child) => dir = child,
                Err(error) => return error.kind() == std::io::ErrorKind::NotFound,
            }
        }
        false
    }

    pub fn read_note(&self, path: &str) -> VaultResult<NoteDocument> {
        note_path(path)?;
        let result = self
            .parent(path, false)
            .and_then(|(dir, name)| read_text(&dir, &name));
        match result {
            Ok(text) => Ok(document(path, text)),
            Err(error) => {
                // A missing path is a deletion conflict only while the original root and
                // manifest still authorize this Vault; links and unreadable files are not deletions.
                self.ensure_current_manifest()?;
                if self.note_is_absent(path) {
                    return Err(VaultError::conflict(
                        "The Note or its parent directory was deleted. Reload or save a recovery copy.",
                        None,
                    ));
                }
                Err(error)
            }
        }
    }

    /// Return authorized bytes via the capability, not a second ambient-path read.
    pub fn read_document(&self, path: &str) -> VaultResult<(PathBuf, &'static str, Vec<u8>)> {
        let relative = relative(path)?;
        let kind = kind(relative);
        if !matches!(kind, "markdown" | "pdf" | "docx") {
            return Err(VaultError::invalid(
                "Choose a Markdown, PDF or DOCX document.",
            ));
        }
        let (dir, name) = self.parent(path, false)?;
        let bytes = read_regular(&dir, &name)?;
        let absolute = self.root.join(relative);
        if absolute.canonicalize()? != absolute {
            return Err(VaultError::invalid(
                "The document path changed or became a link. Refresh the Vault.",
            ));
        }
        Ok((absolute, kind, bytes))
    }

    pub fn create_note(&self, path: &str, text: &str) -> VaultResult<NoteDocument> {
        let _identity = self
            .identity_writes
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let text = if note_metadata(text).id.is_some() {
            self.ensure_identity_available(path, text)?;
            text.to_owned()
        } else {
            adopt(text)?
        };
        self.create_raw(path, &text)
    }

    pub fn save_copy(&self, path: &str, text: &str) -> VaultResult<NoteDocument> {
        self.create_raw(path, text)
    }

    fn create_raw(&self, path: &str, text: &str) -> VaultResult<NoteDocument> {
        note_path(path)?;
        if text.len() as u64 > MAX_BYTES {
            return Err(VaultError::invalid("The Note exceeds 64 MiB."));
        }
        let (dir, name) = self.parent(path, true)?;
        let staging = format!(".adamant-write-{}.md", Uuid::new_v4());
        write_new(&dir, Path::new(&staging), text.as_bytes())?;
        let result = dir.hard_link(&staging, &dir, &name);
        let _ = dir.remove_file(&staging);
        result.map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                VaultError::conflict(
                    "The destination already exists. Choose another path.",
                    self.read_note(path).ok(),
                )
            } else {
                error.into()
            }
        })?;
        sync_dir(&dir)?;
        self.set_index_state(
            IndexState::Stale,
            Some("A local write is awaiting indexing.".into()),
        );
        Ok(document(path, text.to_owned()))
    }

    fn retain(&self, path: &str, text: &[u8], label: &str) -> VaultResult<PathBuf> {
        let recovery = self.recovery_directory();
        private_dir(&recovery)?;
        let dir = Dir::open_ambient_dir(&recovery, ambient_authority())?;
        let name = format!("{}-{}-{label}.md", hash(path.as_bytes()), Uuid::new_v4());
        write_new(&dir, Path::new(&name), text)?;
        sync_dir(&dir)?;
        Ok(recovery.join(name))
    }

    fn stale(
        &self,
        path: &str,
        text: &str,
        current: Option<NoteDocument>,
    ) -> VaultResult<NoteDocument> {
        let retained = self.retain(path, text.as_bytes(), "submitted")?;
        Err(VaultError::conflict(
            format!(
                "The on-disk Note changed or was deleted. Your submitted version is retained at {}. Reload disk or save a recovery copy; no force overwrite is available.",
                retained.display()
            ),
            current,
        ))
    }

    pub fn save_note(
        &self,
        path: &str,
        text: &str,
        expected_revision: &str,
    ) -> VaultResult<NoteDocument> {
        let _identity = self
            .identity_writes
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.save_note_inner(path, text, expected_revision, || {})
    }

    fn save_note_inner(
        &self,
        path: &str,
        text: &str,
        expected_revision: &str,
        before_exchange: impl FnOnce(),
    ) -> VaultResult<NoteDocument> {
        self.save_note_checked(path, text, expected_revision, before_exchange, false)
    }

    fn save_note_checked(
        &self,
        path: &str,
        text: &str,
        expected_revision: &str,
        before_exchange: impl FnOnce(),
        generated_identity: bool,
    ) -> VaultResult<NoteDocument> {
        note_path(path)?;
        if text.len() as u64 > MAX_BYTES {
            return Err(VaultError::invalid("The Note exceeds 64 MiB."));
        }
        self.ensure_current_manifest()?;
        let current = match self.read_note(path) {
            Ok(current) => current,
            Err(error) => {
                // Only genuine absence is a deleted-note conflict; unsafe/unreadable files remain errors.
                let absent = error.kind == "conflict" && error.current.is_none();
                if absent {
                    return self.stale(path, text, None);
                }
                return Err(error);
            }
        };
        if current.revision != expected_revision {
            return self.stale(path, text, Some(current));
        }
        let next = document(path, text.to_owned());
        if current.id.is_some() && next.id.is_some() && current.id != next.id {
            return Err(VaultError::invalid(
                "Ordinary Save cannot replace an existing identity. Use a new Note or preserve this ID; source was not changed.",
            ));
        }
        if !generated_identity && current.id.is_none() && next.id.is_some() {
            self.ensure_identity_available(path, text)?;
        }
        if current.text == text {
            return Ok(current);
        }
        let (dir, name) = self.parent(path, false)?;
        let old_permissions = dir.symlink_metadata(&name)?.permissions();
        let staging = format!(".adamant-write-{}.md", Uuid::new_v4());
        let file = write_new(&dir, Path::new(&staging), text.as_bytes())?;
        file.set_permissions(old_permissions)?;
        file.sync_all()?;
        // Retain submitted bytes before the replacement, including crash/error paths.
        let retained = self.retain(path, text.as_bytes(), "submitted")?;
        before_exchange();
        if let Err(mut error) = self.ensure_current_manifest() {
            let _ = dir.remove_file(&staging);
            error.message.push_str(&format!(
                " Submitted version retained at {}.",
                retained.display()
            ));
            return Err(error);
        }
        if let Err(error) = exchange(&dir, &staging, &name) {
            let _ = dir.remove_file(&staging);
            if error.kind() == std::io::ErrorKind::NotFound {
                return self.stale(path, text, None);
            }
            return Err(VaultError::io(format!(
                "Safe replacement failed: {error}. Submitted version: {}",
                retained.display()
            )));
        }
        sync_dir(&dir)?;
        // The exchange captures the actual displaced file, not a racy pre-rename snapshot.
        // This observes the replacement boundary, not writes continuing indefinitely to detached handles.
        let displaced = read_regular(&dir, Path::new(&staging));
        let matches = displaced
            .as_ref()
            .is_ok_and(|bytes| hash(bytes) == expected_revision);
        let now = self.read_note(path).ok();
        if matches
            && now
                .as_ref()
                .is_some_and(|document| document.revision == next.revision)
        {
            dir.remove_file(&staging)?;
            sync_dir(&dir)?;
            fs::remove_file(&retained)?;
            self.set_index_state(
                IndexState::Stale,
                Some("A local write is awaiting indexing.".into()),
            );
            return Ok(next);
        }
        let backup = displaced.and_then(|bytes| self.retain(path, &bytes, "displaced"));
        let recovery_path = match backup {
            Ok(backup) => {
                dir.remove_file(&staging)?;
                backup
            }
            Err(_) => {
                // If machine-local recovery storage fails, retain authored source beside the Note.
                let displaced_name = format!(".adamant-recovery-{}.md", Uuid::new_v4());
                dir.rename(&staging, &dir, &displaced_name)?;
                self.root
                    .join(Path::new(path).parent().unwrap_or(Path::new("")))
                    .join(displaced_name)
            }
        };
        sync_dir(&dir)?;
        Err(VaultError::conflict(
            format!(
                "An external writer raced the save. Both versions are retained: submitted at {}; displaced at {}. Reload to inspect the current disk version.",
                retained.display(),
                recovery_path.display()
            ),
            now,
        ))
    }

    pub fn adopt_note(&self, path: &str, expected_revision: &str) -> VaultResult<NoteDocument> {
        let _identity = self
            .identity_writes
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let current = self.read_note(path)?;
        if current.revision != expected_revision {
            return self.stale(path, &current.text, Some(current.clone()));
        }
        let text = adopt(&current.text)?;
        self.save_note_checked(path, &text, expected_revision, || {}, current.id.is_none())
    }

    /// Native source selection is a separate adapter. This entry point supports direct temp-Vault smoke runs.
    pub fn import_note(&self, path: &str, source: &Path) -> VaultResult<NoteDocument> {
        let _identity = self
            .identity_writes
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.require_complete_inventory()?;
        note_path(path)?;
        if kind(source) != "markdown" {
            return Err(VaultError::invalid("Import a Markdown file."));
        }
        let parent = source
            .parent()
            .ok_or_else(|| VaultError::invalid("Select a source file."))?;
        let dir = Dir::open_ambient_dir(parent, ambient_authority())?;
        let original = read_text(
            &dir,
            Path::new(
                source
                    .file_name()
                    .ok_or_else(|| VaultError::invalid("Select a source file."))?,
            ),
        )?;
        let metadata = note_metadata(&original);
        if let Some(id) = &metadata.id {
            let mut first = None;
            for candidate in self.identity_paths(id)? {
                let note = self.matching_note(&candidate, id)?;
                if note.text != original {
                    return Err(VaultError::conflict(
                        "Import identity collision: another Note has this UUID with different source. Nothing was overwritten.",
                        Some(note),
                    ));
                }
                if first.is_none() {
                    first = Some(note);
                }
            }
            if let Some(note) = first {
                return Ok(note);
            }
        }
        let adopted = if metadata.id.is_some() {
            original
        } else {
            adopt(&original)?
        };
        self.ensure_identity_available(path, &adopted)?;
        self.create_raw(path, &adopted)
    }

    fn ensure_identity_available(&self, path: &str, text: &str) -> VaultResult<()> {
        if let Some(id) = note_metadata(text).id {
            if let Some(existing) = self
                .identity_paths(&id)?
                .into_iter()
                .find(|candidate| candidate != path)
            {
                let existing = self.matching_note(&existing, &id)?;
                return Err(VaultError::conflict(
                    format!(
                        "Identity collision with {}. Use Import to deduplicate identical content or save a raw recovery copy explicitly.",
                        existing.path
                    ),
                    Some(existing),
                ));
            }
        }
        Ok(())
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn exchange(dir: &Dir, staging: &str, destination: &Path) -> std::io::Result<()> {
    rustix::fs::renameat_with(
        dir,
        staging,
        dir,
        destination,
        rustix::fs::RenameFlags::EXCHANGE,
    )
    .map_err(Into::into)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn exchange(_dir: &Dir, _staging: &str, _destination: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "This platform has no supported atomic exchange primitive. Save a recovery copy instead; the original was not overwritten.",
    ))
}

#[cfg(test)]
mod tests;
