//! Capability-bounded file operations, recovery journal and Markdown reference updates.
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use pulldown_cmark::{Event, LinkType, Options, Parser, Tag};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{MAX_BYTES, Vault, VaultError, VaultResult, capability, metadata};

const ADMIN: &str = ".adamant";
const MARKER: &[u8] = b"adamant-admin-v1\n";
const MAX_SCOPE_ENTRIES: u64 = 50_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MutationKind {
    Rename,
    Move,
    Duplicate,
    Trash,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationRequest {
    pub kind: MutationKind,
    pub paths: Vec<String>,
    pub destination: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationItem {
    pub path: String,
    pub kind: String,
    pub file_count: u64,
    pub hidden_count: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionEntry {
    pub path: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationPlan {
    pub id: String,
    pub items: Vec<MutationItem>,
    pub affected_paths: Vec<String>,
    pub conflicts: Vec<String>,
    #[serde(default)]
    pub referrer_revisions: Vec<RevisionEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationOutcome {
    pub path: String,
    pub status: String,
    pub destination: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityMapping {
    pub from: String,
    pub to: String,
    pub id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub outcomes: Vec<MutationOutcome>,
    pub mappings: Vec<IdentityMapping>,
    pub affected_paths: Vec<String>,
    pub recovery_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub id: String,
    pub path: String,
    pub deleted_at: u64,
    pub kind: String,
    pub file_count: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRecord {
    pub id: String,
    pub state: String,
    pub message: String,
    #[serde(default)]
    pub versions: Vec<String>,
    #[serde(default)]
    pub exported_to: Option<String>,
    #[serde(default)]
    pub result: Option<MutationResult>,
}

/// Bytes and companions come from the native picker/import capability.  This
/// type intentionally has no source path: frontend input cannot grant access
/// to an arbitrary filesystem location.
#[derive(Debug, Clone)]
pub struct ImportedFile {
    pub name: String,
    pub bytes: Vec<u8>,
    pub companion: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalChange {
    path: String,
    expected_revision: String,
    original: Vec<u8>,
    updated: Vec<u8>,
    applied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    #[serde(default)]
    schema: u32,
    id: String,
    vault_id: String,
    request: MutationRequest,
    completed: Vec<IdentityMapping>,
    #[serde(default)]
    changes: Vec<JournalChange>,
    #[serde(default)]
    moves: Vec<JournalMove>,
    #[serde(default)]
    captures: Vec<RevisionEntry>,
    #[serde(default)]
    ready: bool,
    #[serde(default)]
    exported_to: Option<String>,
    created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalMove {
    item: String,
    source: String,
    target: String,
    source_admin: bool,
    target_admin: bool,
    duplicate: bool,
    expected_revision: String,
    output_revision: String,
    mappings: Vec<IdentityMapping>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrashRecord {
    id: String,
    path: String,
    kind: String,
    file_count: u64,
    bytes: u64,
    deleted_at: u64,
    payload: String,
    #[serde(default)]
    companions: Vec<String>,
}

struct PendingPlan {
    vault_id: String,
    root: PathBuf,
    request: MutationRequest,
    revisions: Vec<String>,
    plan: MutationPlan,
    created_at: u64,
}

fn plans() -> &'static Mutex<HashMap<String, PendingPlan>> {
    static PLANS: LazyLock<Mutex<HashMap<String, PendingPlan>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    &PLANS
}
fn mutation_guard() -> &'static Mutex<()> {
    static LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
    &LOCK
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn join_path(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}/{name}")
    }
}
fn path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
fn file_name(path: &str) -> VaultResult<&str> {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| VaultError::invalid("The path has no valid filename."))
}

fn open_path(root: &Dir, path: &str, create: bool) -> VaultResult<(Dir, PathBuf)> {
    let relative = capability::relative(path)?;
    let components = relative.components().collect::<Vec<_>>();
    let Some(last) = components.last() else {
        return Err(VaultError::invalid("A path is required."));
    };
    let mut dir = root.try_clone()?;
    for component in &components[..components.len() - 1] {
        let name = Path::new(component.as_os_str());
        if create {
            match dir.create_dir(name) {
                Ok(()) => capability::sync_dir(&dir)?,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
        dir = dir.open_dir_nofollow(name)?;
    }
    Ok((dir, PathBuf::from(last.as_os_str())))
}

fn exists(root: &Dir, path: &str) -> VaultResult<bool> {
    let relative = capability::relative(path)?;
    let mut dir = root.try_clone()?;
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let name = Path::new(component.as_os_str());
        let metadata = match dir.symlink_metadata(name) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        if metadata.file_type().is_symlink() {
            return Err(VaultError::invalid(
                "Symbolic links are not safe mutation paths.",
            ));
        }
        if components.peek().is_some() {
            dir = dir.open_dir_nofollow(name)?;
        }
    }
    Ok(true)
}

fn existing_companion(root: &Dir, path: &str) -> VaultResult<Option<String>> {
    match companion_path(path) {
        Some(companion) if exists(root, &companion)? => Ok(Some(companion)),
        _ => Ok(None),
    }
}

fn normalize(path: PathBuf) -> Option<String> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(name) => normalized.push(name),
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            std::path::Component::CurDir => {}
            _ => return None,
        }
    }
    Some(path_string(&normalized))
}

fn entry_kind(dir: &Dir, name: &Path) -> VaultResult<cap_std::fs::FileType> {
    let ty = dir.symlink_metadata(name)?.file_type();
    if ty.is_symlink() {
        return Err(VaultError::invalid(
            "Symbolic links are not permitted in a mutation.",
        ));
    }
    if !ty.is_file() && !ty.is_dir() {
        return Err(VaultError::invalid(
            "Special files are not permitted in a mutation.",
        ));
    }
    Ok(ty)
}

fn scope(dir: &Dir, name: &Path, prefix: &str, count: &mut u64) -> VaultResult<(u64, u64, u64)> {
    if prefix.split('/').count() > 128 {
        return Err(VaultError::invalid(
            "The physical scope exceeds the depth limit.",
        ));
    }
    *count += 1;
    if *count > MAX_SCOPE_ENTRIES {
        return Err(VaultError::invalid(
            "The physical mutation scope exceeds 50,000 entries; reconcile and select a smaller scope.",
        ));
    }
    let ty = entry_kind(dir, name)?;
    let display = name.file_name().and_then(|n| n.to_str()).unwrap_or(prefix);
    let hidden =
        u64::from(display.starts_with('.') || (!ty.is_dir() && capability::kind(name) == "file"));
    if ty.is_file() {
        let bytes = dir.symlink_metadata(name)?.len();
        return Ok((1, hidden, bytes));
    }
    let child = dir.open_dir_nofollow(name)?;
    let mut files = 0;
    let mut hidden_count = hidden;
    let mut bytes = 0;
    for entry in child.entries()? {
        let entry = entry?;
        let child_name = entry.file_name();
        let child_name = child_name
            .to_str()
            .ok_or_else(|| VaultError::invalid("A descendant filename is not valid Unicode."))?;
        let child_path = join_path(prefix, child_name);
        let (f, h, b) = scope(
            &child,
            &PathBuf::from(entry.file_name()),
            &child_path,
            count,
        )?;
        files += f;
        hidden_count += h;
        bytes += b;
    }
    Ok((files, hidden_count, bytes))
}

fn revision(
    dir: &Dir,
    name: &Path,
    hasher: &mut Sha256,
    count: &mut u64,
    depth: usize,
) -> VaultResult<()> {
    if depth > 128 {
        return Err(VaultError::invalid(
            "Revision assessment exceeds the depth limit.",
        ));
    }
    *count += 1;
    if *count > MAX_SCOPE_ENTRIES {
        return Err(VaultError::invalid(
            "The physical mutation scope exceeds 50,000 entries.",
        ));
    }
    let ty = entry_kind(dir, name)?;
    hasher.update([if ty.is_dir() { b'd' } else { b'f' }]);
    if ty.is_file() {
        let mut file = capability::open_regular(dir, name)?;
        let length = file.metadata()?.len();
        hasher.update(length.to_le_bytes());
        let mut buffer = [0; 64 * 1024];
        let mut read = 0;
        loop {
            let n = file.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            read += n as u64;
            if read > length {
                return Err(VaultError::conflict(
                    "Source grew while assessing its revision.",
                    None,
                ));
            }
            hasher.update(&buffer[..n]);
        }
        if read != length {
            return Err(VaultError::conflict(
                "Source changed while assessing its revision.",
                None,
            ));
        }
    } else {
        let child = dir.open_dir_nofollow(name)?;
        let mut names = child
            .entries()?
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect::<Result<Vec<_>, _>>()?;
        names.sort();
        hasher.update((names.len() as u64).to_le_bytes());
        for child_name in names {
            let bytes = child_name.as_encoded_bytes();
            hasher.update((bytes.len() as u64).to_le_bytes());
            hasher.update(bytes);
            revision(&child, Path::new(&child_name), hasher, count, depth + 1)?;
        }
    }
    Ok(())
}
fn source_revision(root: &Dir, path: &str) -> VaultResult<String> {
    let (dir, name) = open_path(root, path, false)?;
    let mut hasher = Sha256::new();
    revision(&dir, &name, &mut hasher, &mut 0, 0)?;
    use std::fmt::Write;
    let mut hex = String::with_capacity(64);
    for byte in hasher.finalize() {
        write!(&mut hex, "{byte:02x}").expect("Writing to a String cannot fail");
    }
    Ok(hex)
}

fn companion_path(path: &str) -> Option<String> {
    let kind = capability::kind(Path::new(path));
    matches!(kind, "pdf" | "docx").then(|| format!("{path}.meta.yaml"))
}

fn logical_revision(root: &Dir, path: &str) -> VaultResult<String> {
    let primary = source_revision(root, path)?;
    let companion = existing_companion(root, path)?
        .map(|path| source_revision(root, &path))
        .transpose()?;
    Ok(super::hash(
        format!("{primary}:{}", companion.as_deref().unwrap_or("absent")).as_bytes(),
    ))
}

fn is_admin_path(path: &str) -> bool {
    path.split('/')
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case(ADMIN))
        || path.eq_ignore_ascii_case("vault.json")
}

fn validate_admin(dir: Dir) -> VaultResult<Dir> {
    let marker = capability::read_limited(&dir, Path::new("marker"), 128).map_err(|_| {
        VaultError::invalid(
            "The existing .adamant namespace has no valid Adamant ownership marker.",
        )
    })?;
    if marker != MARKER {
        return Err(VaultError::invalid(
            "The existing .adamant namespace has no valid Adamant ownership marker.",
        ));
    }
    Ok(dir)
}

fn admin_dir(vault: &Vault) -> VaultResult<Dir> {
    let parent = &vault.manifest_dir;
    match parent.symlink_metadata(ADMIN) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(VaultError::invalid(
                    "The existing .adamant path is not an Adamant administration namespace; it was not adopted or hidden.",
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let staging = format!(".adamant-admin-{}", Uuid::new_v4());
            let dir = child_dir(parent, &staging)?;
            capability::write_new(&dir, Path::new("marker"), MARKER)?;
            capability::sync_dir(&dir)?;
            move_one(parent, &staging, parent, ADMIN)?;
        }
        Err(error) => return Err(error.into()),
    }
    validate_admin(parent.open_dir_nofollow(ADMIN)?)
}

fn existing_admin_dir(vault: &Vault) -> VaultResult<Option<Dir>> {
    match vault.manifest_dir.symlink_metadata(ADMIN) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(VaultError::invalid(
                    "The existing .adamant path is not an Adamant administration namespace; it was not adopted or hidden.",
                ));
            }
            validate_admin(vault.manifest_dir.open_dir_nofollow(ADMIN)?).map(Some)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
fn optional_dir(parent: &Dir, name: &str) -> VaultResult<Option<Dir>> {
    if !exists(parent, name)? {
        return Ok(None);
    }
    parent.open_dir_nofollow(name).map(Some).map_err(Into::into)
}
fn child_dir(parent: &Dir, name: &str) -> VaultResult<Dir> {
    let mut builder = cap_std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use cap_std::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match parent.create_dir_with(name, &builder) {
        Ok(()) => capability::sync_dir(parent)?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    parent.open_dir_nofollow(name).map_err(Into::into)
}
fn json_bytes(value: &impl Serialize) -> VaultResult<Vec<u8>> {
    struct BoundedJson(Vec<u8>);
    impl std::io::Write for BoundedJson {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > MAX_BYTES as usize - self.0.len() {
                return Err(std::io::Error::other(
                    "Recovery metadata exceeds 64 MiB; choose a smaller mutation.",
                ));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut bytes = BoundedJson(Vec::new());
    serde_json::to_writer_pretty(&mut bytes, value)
        .map_err(|error| VaultError::invalid(error.to_string()))?;
    Ok(bytes.0)
}
fn write_json_new(dir: &Dir, name: &str, value: &impl Serialize) -> VaultResult<()> {
    if exists(dir, name)? {
        return Err(VaultError::conflict(
            "Recovery metadata already exists.",
            None,
        ));
    }
    write_verified(dir, name, &json_bytes(value)?)
}
fn replace_json(dir: &Dir, name: &str, value: &impl Serialize) -> VaultResult<()> {
    let bytes = json_bytes(value)?;
    let staging = format!(".{name}.{}", Uuid::new_v4());
    capability::write_new(dir, Path::new(&staging), &bytes)?;
    dir.rename(&staging, dir, name)?;
    capability::sync_dir(dir)
}

fn remove_tree(dir: &Dir, name: &Path) -> VaultResult<()> {
    let ty = dir.symlink_metadata(name)?.file_type();
    if ty.is_dir() {
        let child = dir.open_dir_nofollow(name)?;
        for entry in child.entries()? {
            remove_tree(&child, &PathBuf::from(entry?.file_name()))?;
        }
        dir.remove_dir(name)?;
    } else {
        dir.remove_file(name)?;
    }
    Ok(())
}

fn mutation_target(request: &MutationRequest, path: &str) -> String {
    let destination = request.destination.as_deref().unwrap_or("");
    match request.kind {
        MutationKind::Rename => {
            if request.paths.first().is_some_and(|first| first == path) {
                destination.to_owned()
            } else if let Some(first) = request.paths.first() {
                path.strip_prefix(first).map_or_else(
                    || destination.to_owned(),
                    |suffix| format!("{destination}{suffix}"),
                )
            } else {
                destination.to_owned()
            }
        }
        MutationKind::Move | MutationKind::Duplicate => {
            join_path(destination, file_name(path).unwrap_or(path))
        }
        MutationKind::Trash => String::new(),
    }
}

fn normalize_mutation_request(root: &Dir, request: &mut MutationRequest) -> VaultResult<()> {
    if request.destination.as_deref().is_some_and(is_admin_path) {
        return Err(VaultError::invalid(
            "Administrative destinations are protected.",
        ));
    }
    if request.paths.is_empty() {
        return Err(VaultError::invalid("No paths supplied."));
    }
    if request.paths.len() as u64 > MAX_SCOPE_ENTRIES {
        return Err(VaultError::invalid("Select at most 50,000 paths."));
    }
    if request.kind == MutationKind::Rename && request.paths.len() != 1 {
        return Err(VaultError::invalid("Rename accepts exactly one path."));
    }
    if request.kind == MutationKind::Trash && request.destination.is_some() {
        return Err(VaultError::invalid("Trash has no destination."));
    }
    let mut paths = std::mem::take(&mut request.paths);
    for path in &mut paths {
        capability::relative(path)?;
        if is_admin_path(path) {
            return Err(VaultError::invalid("Administrative paths are protected."));
        }
        if let Some(original) = path.strip_suffix(".meta.yaml")
            && matches!(capability::kind(Path::new(original)), "pdf" | "docx")
            && exists(root, original)?
        {
            *path = original.to_owned();
        }
    }
    paths.sort();
    paths.dedup();
    let mut selected = BTreeSet::<String>::new();
    for path in paths {
        if !Path::new(&path)
            .ancestors()
            .skip(1)
            .filter_map(Path::to_str)
            .any(|parent| selected.contains(parent))
        {
            selected.insert(path);
        }
    }
    if request.kind == MutationKind::Rename
        && request.destination.as_deref().is_none_or(str::is_empty)
    {
        return Err(VaultError::invalid(
            "Rename requires a complete nonempty destination path.",
        ));
    }
    request.paths = selected.into_iter().collect();
    Ok(())
}

fn check_mutation_destination(
    root: &Dir,
    request: &MutationRequest,
    conflicts: &mut Vec<String>,
) -> VaultResult<()> {
    if request.kind != MutationKind::Rename {
        if let Some(destination) = request.destination.as_deref().filter(|d| !d.is_empty()) {
            capability::relative(destination)?;
            let (dir, name) = open_path(root, destination, false)?;
            if !dir.symlink_metadata(&name)?.is_dir() {
                conflicts.push(format!("Destination is not a folder: {destination}"));
            }
        }
    } else if let Some(destination) = request.destination.as_deref()
        && let Some(parent) = Path::new(destination).parent()
        && !parent.as_os_str().is_empty()
        && parent != Path::new(".")
    {
        let parent = path_string(parent);
        let (dir, name) = open_path(root, &parent, false)?;
        if !dir.symlink_metadata(&name)?.is_dir() {
            conflicts.push(format!("Rename parent is not a folder: {parent}"));
        }
    }
    Ok(())
}

fn check_mutation_target(
    root: &Dir,
    path: &str,
    target: String,
    targets: &mut HashSet<String>,
    conflicts: &mut Vec<String>,
) -> VaultResult<()> {
    if target.is_empty() {
        return Ok(());
    }
    capability::relative(&target)?;
    if is_admin_path(&target) {
        return Err(VaultError::invalid(
            "Administrative destinations are protected.",
        ));
    }
    let kind = capability::kind(Path::new(path));
    if matches!(kind, "markdown" | "pdf" | "docx") && kind != capability::kind(Path::new(&target)) {
        conflicts.push(format!(
            "Keep the supported document extension when renaming {path}."
        ));
    }
    if target == path
        || target
            .strip_prefix(path)
            .is_some_and(|suffix| suffix.starts_with('/'))
    {
        conflicts.push(format!(
            "Destination is the source or its descendant: {path}"
        ));
    }
    if !targets.insert(target.clone()) {
        conflicts.push(format!("Destinations overlap: {target}"));
    }
    if exists(root, &target)? && target != path && !same_entry(root, path, &target)? {
        conflicts.push(format!("Destination already exists: {target}"));
    }
    if let Some(companion) = existing_companion(root, path)? {
        let target_companion = format!("{target}.meta.yaml");
        if exists(root, &target_companion)? && !same_entry(root, &companion, &target_companion)? {
            conflicts.push(format!(
                "Companion destination already exists: {target_companion}"
            ));
        }
    }
    Ok(())
}

impl Vault {
    pub fn create_folder(&self, path: &str) -> VaultResult<()> {
        let _guard = mutation_guard().lock().unwrap_or_else(|e| e.into_inner());
        if is_admin_path(path) {
            return Err(VaultError::invalid("Administrative paths are protected."));
        }
        self.ensure_current_manifest()?;
        self.ensure_no_pending_mutations()?;
        let (dir, name) = open_path(&self.dir, path, true)?;
        match dir.create_dir(&name) {
            Ok(()) => {
                capability::sync_dir(&dir)?;
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(
                VaultError::conflict("A file or folder with this name already exists.", None),
            ),
            Err(error) => Err(error.into()),
        }
    }

    pub fn prepare_mutation(&self, mut request: MutationRequest) -> VaultResult<MutationPlan> {
        self.ensure_current_manifest()?;
        self.ensure_no_pending_mutations()?;
        normalize_mutation_request(&self.dir, &mut request)?;
        let roots = &request.paths;
        let mut items = Vec::new();
        let mut revisions = Vec::new();
        let mut conflicts = Vec::new();
        let mut scope_entries = 0;
        for path in roots {
            let revision = logical_revision(&self.dir, path)?;
            let (dir, name) = open_path(&self.dir, path, false)?;
            let (mut file_count, mut hidden_count, mut bytes) =
                scope(&dir, &name, path, &mut scope_entries)?;
            if let Some(companion) = existing_companion(&self.dir, path)? {
                let (companion_dir, companion_name) = open_path(&self.dir, &companion, false)?;
                let (files, hidden, size) = scope(
                    &companion_dir,
                    &companion_name,
                    &companion,
                    &mut scope_entries,
                )?;
                file_count += files;
                hidden_count += hidden;
                bytes += size;
            }
            #[cfg(test)]
            run_scope_hook();
            if logical_revision(&self.dir, path)? != revision {
                return Err(VaultError::conflict(
                    format!("Source changed while assessing its scope: {path}. Prepare again."),
                    None,
                ));
            }
            items.push(MutationItem {
                path: path.clone(),
                kind: if dir.symlink_metadata(&name)?.is_dir() {
                    "folder".into()
                } else {
                    capability::kind(&name).into()
                },
                file_count,
                hidden_count,
                bytes,
            });
            revisions.push(revision);
        }
        if items.iter().map(|item| item.bytes).sum::<u64>() > 256 * 1024 * 1024 {
            return Err(VaultError::invalid(
                "Recovery staging is limited to 256 MiB per operation; choose a smaller scope.",
            ));
        }
        check_mutation_destination(&self.dir, &request, &mut conflicts)?;
        let mut targets = HashSet::new();
        for path in roots {
            check_mutation_target(
                &self.dir,
                path,
                mutation_target(&request, path),
                &mut targets,
                &mut conflicts,
            )?;
        }
        if matches!(request.kind, MutationKind::Duplicate) {
            self.validate_duplicate(roots)?;
        }
        let mut referrer_revisions = Vec::new();
        if matches!(request.kind, MutationKind::Rename | MutationKind::Move) {
            let mut notes = Vec::new();
            collect_all_markdown_bounded(self, &mut notes)?;
            let maps = roots
                .iter()
                .map(|path| (path.clone(), mutation_target(&request, path)))
                .collect::<Vec<_>>();
            for (path, text) in &notes {
                rewrite_markdown(text, path, &remap_path(path, &maps), &maps)?;
            }
            referrer_revisions = notes
                .into_iter()
                .map(|(path, text)| RevisionEntry {
                    path,
                    revision: super::hash(text.as_bytes()),
                })
                .collect();
        }
        let mut affected_paths = roots.clone();
        affected_paths.extend(
            referrer_revisions
                .iter()
                .map(|revision| revision.path.clone()),
        );
        affected_paths.sort();
        affected_paths.dedup();
        let plan = MutationPlan {
            id: Uuid::new_v4().to_string(),
            items,
            affected_paths,
            conflicts,
            referrer_revisions,
        };
        let mut pending_plans = plans().lock().unwrap_or_else(|e| e.into_inner());
        pending_plans.retain(|_, pending| now().saturating_sub(pending.created_at) < 900);
        if pending_plans.len() >= 128 {
            return Err(VaultError::invalid(
                "Too many pending mutation plans; cancel an abandoned plan and retry.",
            ));
        }
        pending_plans.insert(
            plan.id.clone(),
            PendingPlan {
                vault_id: self.id.clone(),
                root: self.root.clone(),
                request,
                revisions,
                plan: plan.clone(),
                created_at: now(),
            },
        );
        Ok(plan)
    }

    fn validate_duplicate(&self, roots: &[String]) -> VaultResult<HashMap<String, String>> {
        let identities = duplicate_identities(&self.dir, roots)?;
        let mut files = Vec::new();
        collect_all_metadata_bounded(self, &mut files)?;
        let mut seen = HashSet::new();
        for (path, text) in files {
            let metadata = if is_companion_name(&path) {
                metadata::companion_metadata(&text)
            } else {
                metadata::note_metadata(&text)
            };
            if let Some(id) = metadata.id
                && identities.contains_key(&id)
                && !seen.insert(id)
            {
                return Err(VaultError::conflict(
                    "A duplicated identity is ambiguous elsewhere in the Vault; repair the collision before copying its references.",
                    None,
                ));
            }
        }
        Ok(identities)
    }

    pub fn cancel_mutation(&self, id: &str) -> VaultResult<()> {
        plans()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
            .map(|_| ())
            .ok_or_else(|| VaultError::invalid("The mutation plan expired or is unknown."))
    }
    pub fn commit_mutation(&self, id: &str) -> VaultResult<MutationResult> {
        let _guard = mutation_guard().lock().unwrap_or_else(|e| e.into_inner());
        self.ensure_current_manifest()?;
        self.ensure_no_pending_mutations()?;
        let pending = plans()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id)
            .ok_or_else(|| VaultError::invalid("The mutation plan expired or is unknown."))?;
        if now().saturating_sub(pending.created_at) >= 900 {
            return Err(VaultError::invalid(
                "The mutation plan expired; prepare it again.",
            ));
        }
        if pending.vault_id != self.id || pending.root != self.root {
            return Err(VaultError::invalid(
                "The mutation belongs to another Vault session.",
            ));
        }
        if !pending.plan.conflicts.is_empty() {
            return Err(VaultError::conflict(
                pending.plan.conflicts.join("; "),
                None,
            ));
        }
        for (path, expected) in pending.request.paths.iter().zip(&pending.revisions) {
            if logical_revision(&self.dir, path)? != *expected {
                return Err(VaultError::conflict(
                    format!("Source changed since preparation: {path}"),
                    None,
                ));
            }
        }
        if matches!(
            pending.request.kind,
            MutationKind::Move | MutationKind::Rename
        ) {
            let mut notes = Vec::new();
            collect_all_markdown_bounded(self, &mut notes)?;
            let expected = pending
                .plan
                .referrer_revisions
                .iter()
                .map(|entry| (entry.path.as_str(), entry.revision.as_str()))
                .collect::<HashMap<_, _>>();
            if notes.len() != expected.len()
                || notes.iter().any(|(path, text)| {
                    expected.get(path.as_str()).copied()
                        != Some(super::hash(text.as_bytes()).as_str())
                })
            {
                return Err(VaultError::conflict(
                    "Reference scope changed since preparation; prepare again before moving.",
                    None,
                ));
            }
        }
        self.commit_prepared(&pending)
    }
    fn commit_prepared(&self, pending: &PendingPlan) -> VaultResult<MutationResult> {
        let admin = admin_dir(self)?;
        let transaction = child_dir(&child_dir(&admin, "transactions")?, &pending.plan.id)?;
        let duplicate = pending.request.kind == MutationKind::Duplicate;
        let identities = if duplicate {
            self.validate_duplicate(&pending.request.paths)?
        } else {
            HashMap::new()
        };
        let maps = pending
            .request
            .paths
            .iter()
            .map(|path| (path.clone(), mutation_target(&pending.request, path)))
            .collect::<Vec<_>>();
        let mut journal = Journal {
            schema: 2,
            id: pending.plan.id.clone(),
            vault_id: self.id.clone(),
            request: pending.request.clone(),
            completed: Vec::new(),
            changes: Vec::new(),
            moves: Vec::new(),
            captures: Vec::new(),
            ready: false,
            exported_to: None,
            created_at: now(),
        };
        let journals = child_dir(&admin, "journals")?;
        // Even a failure during staging is discoverable, but cannot have moved a source.
        write_json_new(&journals, &format!("{}.json", journal.id), &journal)?;
        let prepared = (|| -> VaultResult<()> {
            for (item_index, path) in pending.request.paths.iter().enumerate() {
                let companion = existing_companion(&self.dir, path)?;
                let target = if pending.request.kind == MutationKind::Trash {
                    let trash_id = Uuid::new_v4().to_string();
                    let record_dir = child_dir(&child_dir(&admin, "trash")?, &trash_id)?;
                    child_dir(&record_dir, "payload")?;
                    let item = &pending.plan.items[item_index];
                    let record = TrashRecord {
                        id: trash_id.clone(),
                        path: path.clone(),
                        kind: item.kind.clone(),
                        file_count: item.file_count,
                        bytes: item.bytes,
                        deleted_at: now(),
                        payload: format!("payload/{}", file_name(path)?),
                        companions: companion
                            .iter()
                            .map(|path| file_name(path).map(str::to_owned))
                            .collect::<VaultResult<Vec<_>>>()?,
                    };
                    write_json_new(&record_dir, "record.json", &record)?;
                    format!("trash/{trash_id}/{}", record.payload)
                } else {
                    mutation_target(&pending.request, path)
                };
                for source in std::iter::once(path.clone()).chain(companion) {
                    let target = if source == *path {
                        target.clone()
                    } else {
                        format!("{target}.meta.yaml")
                    };
                    let index = journal.moves.len();
                    let expected_revision = source_revision(&self.dir, &source)?;
                    let mappings = if duplicate || pending.request.kind == MutationKind::Trash {
                        Vec::new()
                    } else {
                        collect_mappings(self, &source, &target)?
                    };
                    journal.moves.push(JournalMove {
                        item: path.clone(),
                        source: source.clone(),
                        target: target.clone(),
                        source_admin: false,
                        target_admin: pending.request.kind == MutationKind::Trash,
                        duplicate,
                        expected_revision: expected_revision.clone(),
                        output_revision: expected_revision,
                        mappings,
                    });
                    replace_json(&journals, &format!("{}.json", journal.id), &journal)?;
                    copy_path(&self.dir, &source, &transaction, &format!("backup-{index}"))?;
                    if source_revision(&transaction, &format!("backup-{index}"))?
                        != journal.moves[index].expected_revision
                    {
                        return Err(VaultError::conflict(
                            "Source changed while staging; source was not removed.",
                            None,
                        ));
                    }
                    if duplicate {
                        copy_entry(
                            &transaction,
                            Path::new(&format!("backup-{index}")),
                            &transaction,
                            Path::new(&format!("stage-{index}")),
                            &source,
                            &target,
                            &DuplicateRewrites {
                                paths: &maps,
                                identities: &identities,
                            },
                        )?;
                        journal.moves[index].output_revision =
                            source_revision(&transaction, &format!("stage-{index}"))?;
                        copy_path(
                            &transaction,
                            &format!("stage-{index}"),
                            &transaction,
                            &format!("output-{index}"),
                        )?;
                    }
                }
            }
            if matches!(
                pending.request.kind,
                MutationKind::Move | MutationKind::Rename
            ) {
                let mappings = journal
                    .moves
                    .iter()
                    .flat_map(|entry| entry.mappings.clone())
                    .collect::<Vec<_>>();
                journal.changes = self.reference_changes(&mappings)?;
                // Rewriting is based on exactly the source revisions approved in preflight.
                let expected = pending
                    .plan
                    .referrer_revisions
                    .iter()
                    .map(|entry| (entry.path.as_str(), entry.revision.as_str()))
                    .collect::<HashMap<_, _>>();
                for change in &journal.changes {
                    let old = reverse_remap_path(&change.path, &maps);
                    if expected.get(old.as_str()).copied()
                        != Some(change.expected_revision.as_str())
                    {
                        return Err(VaultError::conflict(
                            "A reference changed while staging; prepare again.",
                            None,
                        ));
                    }
                }
            }
            for (source, revision) in pending.request.paths.iter().zip(&pending.revisions) {
                if logical_revision(&self.dir, source)? != *revision {
                    return Err(VaultError::conflict(
                        "Source changed during staging; no source was removed.",
                        None,
                    ));
                }
            }
            journal.ready = true;
            replace_json(&journals, &format!("{}.json", journal.id), &journal)
        })();
        if let Err(error) = prepared {
            return Ok(failed_transaction(&journal, error.message));
        }
        self.run_journal(&admin, &journals, &mut journal)
    }

    fn reference_changes(&self, mappings: &[IdentityMapping]) -> VaultResult<Vec<JournalChange>> {
        if mappings.is_empty() {
            return Ok(Vec::new());
        }
        let maps = mappings
            .iter()
            .map(|m| (m.from.clone(), m.to.clone()))
            .collect::<Vec<_>>();
        let mut notes = Vec::new();
        collect_all_markdown_bounded(self, &mut notes)?;
        let mut changes = Vec::new();
        for (path, text) in notes {
            let final_path = remap_path(&path, &maps);
            let updated = rewrite_markdown(&text, &path, &final_path, &maps)?;
            if updated != text {
                changes.push(JournalChange {
                    path: final_path,
                    expected_revision: super::hash(text.as_bytes()),
                    original: text.into_bytes(),
                    updated: updated.into_bytes(),
                    applied: false,
                });
            }
        }
        Ok(changes)
    }
    fn resume_journal_item(
        &self,
        admin: &Dir,
        transaction: &Dir,
        journal: &Journal,
        item: &str,
        result: &mut MutationResult,
    ) -> VaultResult<()> {
        let mut entries = journal
            .moves
            .iter()
            .enumerate()
            .filter(|(_, entry)| entry.item == item)
            .peekable();
        let first = entries.peek().ok_or_else(|| {
            VaultError::invalid(
                "The journal does not describe this logical item; nothing was guessed.",
            )
        })?;
        let destination = (!first.1.target_admin).then(|| first.1.target.clone());
        for (index, entry) in entries {
            self.resume_move(
                admin,
                transaction,
                &journal.id,
                index,
                entry,
                &journal.changes,
            )?;
        }
        result.mappings.extend(
            journal
                .moves
                .iter()
                .filter(|entry| entry.item == item)
                .flat_map(|entry| entry.mappings.iter().cloned()),
        );
        result.outcomes.push(MutationOutcome {
            path: item.into(),
            status: "completed".into(),
            destination,
            message: None,
        });
        Ok(())
    }

    fn run_journal(
        &self,
        admin: &Dir,
        journals: &Dir,
        journal: &mut Journal,
    ) -> VaultResult<MutationResult> {
        if journal.schema != 2 || !journal.ready {
            return Ok(failed_transaction(journal, "Staging was interrupted before any source removal. Export retained versions, then acknowledge before retrying.".into()));
        }
        let transaction = admin.open_dir_nofollow(format!("transactions/{}", journal.id))?;
        let mut result = MutationResult {
            outcomes: Vec::new(),
            mappings: Vec::new(),
            affected_paths: recovery_versions(journal),
            recovery_id: None,
        };
        for item in &journal.request.paths {
            if let Err(error) =
                self.resume_journal_item(admin, &transaction, journal, item, &mut result)
            {
                result.outcomes.push(MutationOutcome {
                    path: item.clone(),
                    status: "failed".into(),
                    destination: None,
                    message: Some(error.message),
                });
                result.recovery_id = Some(journal.id.clone());
                break;
            }
        }
        for path in journal.request.paths.iter().skip(result.outcomes.len()) {
            result.outcomes.push(MutationOutcome {
                path: path.clone(),
                status: "unstarted".into(),
                destination: None,
                message: None,
            });
        }
        journal.completed = result.mappings.clone();
        if let Err(error) = replace_json(journals, &format!("{}.json", journal.id), journal) {
            result.recovery_id = Some(journal.id.clone());
            result.outcomes.push(MutationOutcome {
                path: journal.id.clone(),
                status: "failed".into(),
                destination: None,
                message: Some(error.message),
            });
            return Ok(result);
        }
        if result.recovery_id.is_none() {
            for (index, change) in journal.changes.iter().enumerate() {
                if let Err(error) = self.apply_change(&transaction, &journal.id, index, change) {
                    result.recovery_id = Some(journal.id.clone());
                    result.outcomes.push(MutationOutcome {
                        path: change.path.clone(),
                        status: "failed".into(),
                        destination: None,
                        message: Some(error.message),
                    });
                    break;
                }
            }
        }
        if result.recovery_id.is_none()
            && let Err(error) = finish_restored_trash(admin, journal)
        {
            result.recovery_id = Some(journal.id.clone());
            result.outcomes.push(MutationOutcome {
                path: journal.id.clone(),
                status: "failed".into(),
                destination: None,
                message: Some(error.message),
            });
        }
        if result.recovery_id.is_none() {
            let finalized = (|| -> VaultResult<()> {
                self.ensure_current_manifest()?;
                journals.remove_file(format!("{}.json", journal.id))?;
                capability::sync_dir(journals)
            })();
            if let Err(error) = finalized {
                // Preserve the truthful completed mappings even when durability reporting fails.
                let name = format!("{}.json", journal.id);
                if !exists(journals, &name)? {
                    let _ = write_json_new(journals, &name, journal);
                }
                result.recovery_id = Some(journal.id.clone());
                result.outcomes.push(MutationOutcome {
                    path: journal.id.clone(),
                    status: "failed".into(),
                    destination: None,
                    message: Some(error.message),
                });
            } else if let Ok(transactions) = admin.open_dir_nofollow("transactions") {
                let _ = remove_tree(&transactions, Path::new(&journal.id));
            }
        }
        Ok(result)
    }

    fn resume_move(
        &self,
        admin: &Dir,
        transaction: &Dir,
        id: &str,
        index: usize,
        entry: &JournalMove,
        changes: &[JournalChange],
    ) -> VaultResult<()> {
        self.ensure_current_manifest()?;
        let source_root = if entry.source_admin { admin } else { &self.dir };
        let target_root = if entry.target_admin { admin } else { &self.dir };
        let source_exists = exists(source_root, &entry.source)?;
        let local_stage = sibling_stage(&entry.source, id, &format!("move-{index}"));
        let local = !entry.duplicate
            && (exists(source_root, &local_stage)?
                || (source_exists
                    && !same_device(
                        &open_path(source_root, &entry.source, false)?.0,
                        transaction,
                    )?));
        let stage_root = if local { source_root } else { transaction };
        let stage = if local {
            local_stage
        } else {
            format!("stage-{index}")
        };
        let staged = exists(stage_root, &stage)?;
        let target_exists = exists(target_root, &entry.target)?;
        if !staged
            && (entry.duplicate || !source_exists)
            && ((target_exists
                && source_revision(target_root, &entry.target)? == entry.output_revision)
                || (!entry.duplicate
                    && published_matches(
                        target_root,
                        &entry.target,
                        transaction,
                        &format!("backup-{index}"),
                        changes,
                    )?))
        {
            return Ok(());
        }
        if target_exists
            && !(source_exists
                && !entry.source_admin
                && !entry.target_admin
                && same_entry(&self.dir, &entry.source, &entry.target)?)
        {
            return Err(VaultError::conflict(
                format!(
                    "Destination exists: {}. No version was overwritten.",
                    entry.target
                ),
                None,
            ));
        }
        if !staged {
            if entry.duplicate || !source_exists {
                return Err(VaultError::conflict(
                    "A captured source is missing; retained backups were not substituted over current files.",
                    None,
                ));
            }
            if source_revision(source_root, &entry.source)? != entry.expected_revision {
                return Err(VaultError::conflict(
                    format!("Newer source preserved at {}.", entry.source),
                    None,
                ));
            }
            move_one(source_root, &entry.source, stage_root, &stage)?;
        } else if source_exists && !entry.duplicate {
            return Err(VaultError::conflict(
                "Both source and private staging exist; neither was overwritten.",
                None,
            ));
        }
        if !source_revision(stage_root, &stage)
            .is_ok_and(|revision| revision == entry.output_revision)
        {
            if !entry.duplicate && !exists(source_root, &entry.source)? {
                let _ = move_one(stage_root, &stage, source_root, &entry.source);
            }
            return Err(VaultError::conflict(
                "A source changed or became unreadable at the rename boundary; captured data was preserved.",
                None,
            ));
        }
        publish_entry(
            stage_root,
            &stage,
            target_root,
            &entry.target,
            &entry.output_revision,
            id,
            index,
        )?;
        if source_revision(target_root, &entry.target)? != entry.output_revision {
            return Err(VaultError::conflict(
                "Destination changed after publication; retained originals remain available.",
                None,
            ));
        }
        Ok(())
    }

    fn apply_change(
        &self,
        transaction: &Dir,
        id: &str,
        index: usize,
        change: &JournalChange,
    ) -> VaultResult<()> {
        self.ensure_current_manifest()?;
        if super::hash(&change.original) != change.expected_revision {
            return Err(VaultError::invalid(
                "Recovery original does not match its revision.",
            ));
        }
        let backup = format!("referrer-{index}.original");
        let local_old = sibling_stage(&change.path, id, &format!("referrer-{index}"));
        let local = exists(&self.dir, &local_old)?
            || !same_device(&open_path(&self.dir, &change.path, false)?.0, transaction)?;
        let old_root = if local { &self.dir } else { transaction };
        let old = if local { local_old } else { backup.clone() };
        if exists(&self.dir, &change.path)? {
            let current = self.read_note(&change.path)?;
            if current.revision == super::hash(&change.updated) {
                return Ok(());
            }
            if current.revision != change.expected_revision || exists(old_root, &old)? {
                return Err(VaultError::conflict(
                    "Referrer changed; staged versions and the current file were preserved.",
                    Some(current),
                ));
            }
            move_one(&self.dir, &change.path, old_root, &old)?;
        }
        let (parent, name) = open_path(old_root, &old, false)?;
        let captured = match capability::read_regular(&parent, &name) {
            Ok(bytes) => bytes,
            Err(error) => {
                if !exists(&self.dir, &change.path)? {
                    let _ = move_one(old_root, &old, &self.dir, &change.path);
                }
                return Err(error);
            }
        };
        if super::hash(&captured) != change.expected_revision {
            if !exists(&self.dir, &change.path)? {
                let _ = move_one(old_root, &old, &self.dir, &change.path);
            }
            return Err(VaultError::conflict(
                "A newer referrer was captured and preserved, not overwritten.",
                None,
            ));
        }
        if local {
            write_verified(transaction, &backup, &captured)?;
        }
        let new = format!("referrer-{index}.updated");
        write_verified(transaction, &new, &change.updated)?;
        let revision = source_revision(transaction, &new)?;
        publish_entry(
            transaction,
            &new,
            &self.dir,
            &change.path,
            &revision,
            id,
            index,
        )?;
        if local {
            if capability::read_regular(&parent, &name)? != captured {
                return Err(VaultError::conflict(
                    "Captured referrer changed again; all versions were retained.",
                    None,
                ));
            }
            parent.remove_file(name)?;
            capability::sync_dir(&parent)?;
        }
        Ok(())
    }

    pub fn purge_trash(&self, ids: &[String]) -> VaultResult<MutationResult> {
        let _guard = mutation_guard().lock().unwrap_or_else(|e| e.into_inner());
        self.ensure_current_manifest()?;
        self.ensure_no_pending_mutations()?;
        let admin = admin_dir(self)?;
        let trash = child_dir(&admin, "trash")?;
        let purging = child_dir(&admin, "purging")?;
        let mut outcomes = Vec::new();
        for id in ids {
            let deleted = (|| -> VaultResult<()> {
                Uuid::parse_str(id)
                    .map_err(|_| VaultError::invalid("Trash item id is invalid."))?;
                let expected = trash_confirmations()
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .get(&(self.root.clone(), id.clone()))
                    .cloned()
                    .ok_or_else(|| {
                        VaultError::conflict(
                            "List Trash and confirm the current physical scope before deleting.",
                            None,
                        )
                    })?;
                let already_staged = exists(&purging, id)?;
                let source = if already_staged { &purging } else { &trash };
                if source_revision(source, id)? != expected {
                    return Err(VaultError::conflict(
                        "Trash changed since it was listed. Review its new scope before deleting.",
                        None,
                    ));
                }
                let record = source.open_dir_nofollow(id)?;
                read_trash_record(&record, id)?;
                if !already_staged {
                    move_one(&trash, id, &purging, id)?;
                }
                if source_revision(&purging, id)? != expected {
                    if !exists(&trash, id)? {
                        let _ = move_one(&purging, id, &trash, id);
                    }
                    return Err(VaultError::conflict(
                        "Trash changed at the deletion boundary; the captured version was retained.",
                        None,
                    ));
                }
                let record = purging.open_dir_nofollow(id)?;
                for entry in record.entries()? {
                    let name = entry?.file_name();
                    if name != "record.json" && name != "payload" {
                        return Err(VaultError::conflict(
                            "Unexpected files in the Trash record were preserved.",
                            None,
                        ));
                    }
                }
                // Keep the descriptor until the payload is gone: interrupted purge stays listable/retryable.
                if exists(&record, "payload")? {
                    remove_tree(&record, Path::new("payload"))?;
                }
                capability::sync_dir(&record)?;
                record.remove_file("record.json")?;
                capability::sync_dir(&record)?;
                purging.remove_dir(id)?;
                capability::sync_dir(&purging)?;
                Ok(())
            })();
            outcomes.push(MutationOutcome {
                path: id.clone(),
                status: if deleted.is_ok() {
                    "completed"
                } else {
                    "failed"
                }
                .into(),
                destination: None,
                message: deleted.err().map(|error| error.message),
            });
        }
        Ok(MutationResult {
            outcomes,
            mappings: Vec::new(),
            affected_paths: Vec::new(),
            recovery_id: None,
        })
    }

    pub fn restore_trash(
        &self,
        id: &str,
        destination: Option<String>,
    ) -> VaultResult<MutationResult> {
        let _guard = mutation_guard().lock().unwrap_or_else(|e| e.into_inner());
        self.ensure_current_manifest()?;
        self.ensure_no_pending_mutations()?;
        Uuid::parse_str(id).map_err(|_| VaultError::invalid("Trash item id is invalid."))?;
        let admin = admin_dir(self)?;
        let record_dir = admin.open_dir_nofollow(format!("trash/{id}"))?;
        let record = read_trash_record(&record_dir, id)?;
        let destination = destination.as_deref().unwrap_or("");
        if !destination.is_empty() {
            capability::relative(destination)?;
        }
        let target = if destination.is_empty() {
            record.path.clone()
        } else {
            join_path(destination, file_name(&record.path)?)
        };
        if is_admin_path(&target) {
            return Err(VaultError::invalid(
                "Administrative restore destinations are protected.",
            ));
        }
        if exists(&self.dir, &target)?
            || (!record.companions.is_empty() && exists(&self.dir, &format!("{target}.meta.yaml"))?)
        {
            return Ok(MutationResult {
                outcomes: vec![MutationOutcome {
                    path: record.path,
                    status: "failed".into(),
                    destination: Some(target),
                    message: Some(
                        "Restore destination already exists; nothing was overwritten.".into(),
                    ),
                }],
                mappings: Vec::new(),
                affected_paths: Vec::new(),
                recovery_id: None,
            });
        }
        let primary = format!("trash/{id}/{}", record.payload);
        let mut sources = vec![(primary.clone(), target.clone())];
        for companion in &record.companions {
            sources.push((
                format!("trash/{id}/payload/{companion}"),
                format!("{target}.meta.yaml"),
            ));
        }
        let mut count = 0;
        let mut bytes = 0;
        for (source, _) in &sources {
            let (dir, name) = open_path(&admin, source, false)?;
            let (_, _, size) = scope(&dir, &name, source, &mut count)?;
            bytes += size;
        }
        if bytes > 256 * 1024 * 1024 {
            return Err(VaultError::invalid(
                "Restore exceeds the recovery staging byte limit.",
            ));
        }
        // All declared pair members must exist before any one of them moves.
        let revisions = sources
            .iter()
            .map(|(source, _)| source_revision(&admin, source))
            .collect::<VaultResult<Vec<_>>>()?;
        let operation = Uuid::new_v4().to_string();
        let transaction = child_dir(&child_dir(&admin, "transactions")?, &operation)?;
        let journals = child_dir(&admin, "journals")?;
        let mut journal = Journal {
            schema: 2,
            id: operation.clone(),
            vault_id: self.id.clone(),
            request: MutationRequest {
                kind: MutationKind::Move,
                paths: vec![record.path.clone()],
                destination: Some(target.clone()),
            },
            completed: Vec::new(),
            changes: Vec::new(),
            moves: Vec::new(),
            captures: Vec::new(),
            ready: false,
            exported_to: None,
            created_at: now(),
        };
        write_json_new(&journals, &format!("{operation}.json"), &journal)?;
        let staged = (|| -> VaultResult<()> {
            for (index, ((source, target), revision)) in sources.iter().zip(revisions).enumerate() {
                journal.moves.push(JournalMove {
                    item: record.path.clone(),
                    source: source.clone(),
                    target: target.clone(),
                    source_admin: true,
                    target_admin: false,
                    duplicate: false,
                    expected_revision: revision.clone(),
                    output_revision: revision,
                    mappings: vec![IdentityMapping {
                        from: format!("trash:{id}/{}", file_name(source)?),
                        to: target.clone(),
                        id: None,
                    }],
                });
                replace_json(&journals, &format!("{operation}.json"), &journal)?;
                copy_path(&admin, source, &transaction, &format!("backup-{index}"))?;
                if source_revision(&transaction, &format!("backup-{index}"))?
                    != journal.moves[index].expected_revision
                {
                    return Err(VaultError::conflict(
                        "Trash payload changed while staging; it was not removed.",
                        None,
                    ));
                }
            }
            let mut notes = Vec::new();
            collect_markdown_bounded(&admin, &primary, &mut notes, &mut 0, &mut 0)?;
            for (path, text) in notes {
                if capability::kind(Path::new(&path)) != "markdown" {
                    continue;
                }
                let old_path = remap_path(&path, &[(primary.clone(), record.path.clone())]);
                let new_path = remap_path(&path, &[(primary.clone(), target.clone())]);
                let updated = rewrite_markdown(
                    &text,
                    &old_path,
                    &new_path,
                    &[(record.path.clone(), target.clone())],
                )?;
                if updated != text {
                    journal.changes.push(JournalChange {
                        path: new_path,
                        expected_revision: super::hash(text.as_bytes()),
                        original: text.into_bytes(),
                        updated: updated.into_bytes(),
                        applied: false,
                    });
                }
            }
            journal.ready = true;
            replace_json(&journals, &format!("{operation}.json"), &journal)
        })();
        if let Err(error) = staged {
            return Ok(failed_transaction(&journal, error.message));
        }
        self.run_journal(&admin, &journals, &mut journal)
    }

    pub fn list_trash(&self) -> VaultResult<Vec<TrashEntry>> {
        let _guard = mutation_guard().lock().unwrap_or_else(|e| e.into_inner());
        self.ensure_current_manifest()?;
        let Some(admin) = existing_admin_dir(self)? else {
            return Ok(Vec::new());
        };
        let mut result = Vec::new();
        let mut receipts = HashMap::new();
        let mut count = 0;
        for namespace in ["trash", "purging"] {
            let Some(trash) = optional_dir(&admin, namespace)? else {
                continue;
            };
            for entry in trash.entries()? {
                let name = entry?.file_name();
                let id = name
                    .to_str()
                    .ok_or_else(|| VaultError::invalid("Trash id is not valid Unicode."))?;
                Uuid::parse_str(id).map_err(|_| VaultError::invalid("Trash id is malformed."))?;
                let revision = source_revision(&trash, id)?;
                let dir = trash.open_dir_nofollow(id)?;
                if namespace == "purging" && !exists(&dir, "record.json")? {
                    if dir.entries()?.next().transpose()?.is_none() {
                        continue;
                    }
                    return Err(VaultError::invalid(
                        "An interrupted purge lost its descriptor; remaining bytes were retained.",
                    ));
                }
                let record = read_trash_record(&dir, id)?;
                let (file_count, _, bytes) = if exists(&dir, "payload")? {
                    scope(&dir, Path::new("payload"), "payload", &mut count)?
                } else {
                    (0, 0, 0)
                };
                #[cfg(test)]
                run_scope_hook();
                if source_revision(&trash, id)? != revision {
                    return Err(VaultError::conflict(
                        "Trash changed while assessing its scope. List Trash again before deleting.",
                        None,
                    ));
                }
                receipts.insert((self.root.clone(), id.to_owned()), revision);
                result.push(TrashEntry {
                    id: record.id,
                    path: record.path,
                    deleted_at: record.deleted_at,
                    kind: if namespace == "purging" {
                        "purging".into()
                    } else {
                        record.kind
                    },
                    file_count,
                    bytes,
                });
            }
        }
        let mut known = trash_confirmations()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        known.retain(|(root, _), _| *root != self.root);
        known.extend(receipts);
        result.sort_by(|a, b| {
            b.deleted_at
                .cmp(&a.deleted_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(result)
    }
    pub fn ensure_no_pending_mutations(&self) -> VaultResult<()> {
        let Some(admin) = existing_admin_dir(self)? else {
            return Ok(());
        };
        let Some(journals) = optional_dir(&admin, "journals")? else {
            return Ok(());
        };
        for entry in journals.entries()? {
            if entry?
                .file_name()
                .to_str()
                .is_none_or(|name| name.ends_with(".json"))
            {
                return Err(VaultError::conflict(
                    "An interrupted mutation requires recovery before another write.",
                    None,
                ));
            }
        }
        Ok(())
    }

    fn read_journal(&self, journals: &Dir, id: &str) -> VaultResult<Journal> {
        Uuid::parse_str(id).map_err(|_| VaultError::invalid("Recovery id is invalid."))?;
        let bytes = capability::read_regular(journals, Path::new(&format!("{id}.json")))?;
        let journal: Journal = serde_json::from_slice(&bytes)
            .map_err(|error| VaultError::invalid(format!("Malformed recovery journal: {error}")))?;
        if journal.id != id || journal.vault_id != self.id {
            return Err(VaultError::invalid(
                "The recovery journal does not belong to this Vault and operation.",
            ));
        }
        for entry in &journal.moves {
            capability::relative(&entry.source)?;
            capability::relative(&entry.target)?;
            if entry.source_admin {
                if !entry.source.starts_with("trash/")
                    && !entry.source.starts_with(&format!("transactions/{id}/"))
                {
                    return Err(VaultError::invalid(
                        "Recovery source is outside its private transaction.",
                    ));
                }
            } else if is_admin_path(&entry.source) {
                return Err(VaultError::invalid(
                    "Recovery cannot move administration files.",
                ));
            }
            if entry.target_admin {
                if !entry.target.starts_with("trash/") {
                    return Err(VaultError::invalid(
                        "Recovery target is not a Trash payload.",
                    ));
                }
            } else if is_admin_path(&entry.target) {
                return Err(VaultError::invalid(
                    "Recovery cannot replace administration files.",
                ));
            }
        }
        for change in &journal.changes {
            capability::relative(&change.path)?;
            if is_admin_path(&change.path)
                || super::hash(&change.original) != change.expected_revision
            {
                return Err(VaultError::invalid(
                    "Recovery contains an invalid original revision or path.",
                ));
            }
        }
        Ok(journal)
    }

    pub fn recover_mutation(&self, id: &str) -> VaultResult<RecoveryRecord> {
        let _guard = mutation_guard().lock().unwrap_or_else(|e| e.into_inner());
        self.ensure_current_manifest()?;
        let admin = existing_admin_dir(self)?
            .ok_or_else(|| VaultError::invalid("No recovery journal exists."))?;
        let journals = admin.open_dir_nofollow("journals")?;
        let mut journal = self.read_journal(&journals, id)?;
        let versions = recovery_versions(&journal);
        if journal.exported_to.is_some() {
            return Ok(RecoveryRecord { id: id.into(), state: "conflicted".into(), message: "Recovery export was requested. Complete and acknowledge the verified archive to keep current files.".into(), versions, exported_to: journal.exported_to, result: None });
        }
        let result = self.run_journal(&admin, &journals, &mut journal)?;
        let recovered = result.recovery_id.is_none();
        let message = if recovered {
            "Journaled items and references were reconciled without replacing newer versions."
                .into()
        } else {
            result
                .outcomes
                .iter()
                .filter_map(|outcome| outcome.message.clone())
                .collect::<Vec<_>>()
                .join("; ")
        };
        Ok(RecoveryRecord {
            id: id.into(),
            state: if recovered { "recovered" } else { "conflicted" }.into(),
            message,
            versions,
            exported_to: journal.exported_to,
            result: Some(result),
        })
    }

    fn snapshot_recovery_captures(&self, admin: &Dir, journal: &mut Journal) -> VaultResult<()> {
        if journal.schema != 2 {
            return Ok(());
        }
        let transaction = admin.open_dir_nofollow(format!("transactions/{}", journal.id))?;
        for (administrative, path, label) in capture_locations(journal) {
            let root = if administrative { admin } else { &self.dir };
            if !exists(root, &path)? {
                continue;
            }
            let revision = source_revision(root, &path)?;
            let name = format!("captured-{label}-{revision}");
            copy_verified_tree(root, &path, &transaction, &name)?;
            if source_revision(&transaction, &name)? != revision
                || source_revision(root, &path)? != revision
            {
                return Err(VaultError::conflict(
                    "A captured version changed during export; all retained versions were kept.",
                    None,
                ));
            }
            if !journal.captures.iter().any(|capture| capture.path == name) {
                journal.captures.push(RevisionEntry {
                    path: name,
                    revision,
                });
            }
        }
        Ok(())
    }

    pub fn export_recovery(&self, id: &str, destination: &str) -> VaultResult<MutationResult> {
        let _guard = mutation_guard().lock().unwrap_or_else(|e| e.into_inner());
        self.ensure_current_manifest()?;
        capability::relative(destination)?;
        if is_admin_path(destination) {
            return Err(VaultError::invalid("Administrative paths are protected."));
        }
        let admin = existing_admin_dir(self)?
            .ok_or_else(|| VaultError::invalid("No recovery journal exists."))?;
        let journals = admin.open_dir_nofollow("journals")?;
        let mut journal = self.read_journal(&journals, id)?;
        if exists(&self.dir, destination)? && journal.exported_to.as_deref() != Some(destination) {
            return Err(VaultError::conflict(
                "Recovery export destination already exists; nothing was overwritten.",
                None,
            ));
        }
        self.snapshot_recovery_captures(&admin, &mut journal)?;
        journal.exported_to = Some(destination.to_owned());
        replace_json(&journals, &format!("{id}.json"), &journal)?;
        let (parent, name) = open_path(&self.dir, destination, true)?;
        let export = child_dir(
            &parent,
            name.to_str()
                .ok_or_else(|| VaultError::invalid("Export filename is invalid."))?,
        )?;
        write_recovery_versions(&admin, &journal, &export)?;
        verify_recovery_versions(&admin, &journal, &export)?;
        capability::sync_dir(&export)?;
        capability::sync_dir(&parent)?;
        Ok(MutationResult {
            outcomes: recovery_versions(&journal)
                .iter()
                .map(|path| MutationOutcome {
                    path: path.clone(),
                    status: "completed".into(),
                    destination: Some(destination.into()),
                    message: None,
                })
                .collect(),
            mappings: Vec::new(),
            affected_paths: recovery_versions(&journal),
            recovery_id: Some(id.into()),
        })
    }

    pub fn acknowledge_recovery(&self, id: &str) -> VaultResult<RecoveryRecord> {
        let _guard = mutation_guard().lock().unwrap_or_else(|e| e.into_inner());
        self.ensure_current_manifest()?;
        let admin = existing_admin_dir(self)?
            .ok_or_else(|| VaultError::invalid("No recovery journal exists."))?;
        let journals = admin.open_dir_nofollow("journals")?;
        let journal = self.read_journal(&journals, id)?;
        if journal.schema != 2 {
            return Err(VaultError::invalid(
                "This older journal did not record every captured source. Export known versions and reconcile its legacy staging before clearing it.",
            ));
        }
        for (administrative, path, label) in capture_locations(&journal) {
            let root = if administrative { &admin } else { &self.dir };
            if exists(root, &path)? {
                let revision = source_revision(root, &path)?;
                let name = format!("captured-{label}-{revision}");
                if !journal
                    .captures
                    .iter()
                    .any(|capture| capture.path == name && capture.revision == revision)
                {
                    return Err(VaultError::conflict(
                        "A captured version changed since export. Export again before acknowledging.",
                        None,
                    ));
                }
            }
        }
        let exported_to = journal.exported_to.clone().ok_or_else(|| {
            VaultError::invalid("Export all staged versions before acknowledging.")
        })?;
        let (parent, name) = open_path(&self.dir, &exported_to, false)?;
        let export = parent.open_dir_nofollow(name)?;
        // Verify every original, new version, and captured tree; user-added export files are never trusted.
        verify_recovery_versions(&admin, &journal, &export)?;
        let archive = child_dir(&admin, "recovery-archive")?;
        let item = child_dir(&archive, id)?;
        // Idempotent copies allow retry after interruption; an unequal existing byte is a conflict.
        write_recovery_versions(&admin, &journal, &item)?;
        verify_recovery_versions(&admin, &journal, &item)?;
        capability::sync_dir(&item)?;
        capability::sync_dir(&archive)?;
        journals.remove_file(format!("{id}.json"))?;
        capability::sync_dir(&journals)?;
        Ok(RecoveryRecord { id: id.into(), state: "acknowledged".into(), message: "Current files were kept. All exported original, updated and captured versions were verified and archived.".into(), versions: recovery_versions(&journal), exported_to: Some(exported_to), result: None })
    }

    pub fn startup_recover(&self) -> VaultResult<Vec<RecoveryRecord>> {
        self.ensure_current_manifest()?;
        let Some(admin) = existing_admin_dir(self)? else {
            return Ok(Vec::new());
        };
        let Some(journals) = optional_dir(&admin, "journals")? else {
            return Ok(Vec::new());
        };
        let mut ids = Vec::new();
        for entry in journals.entries()? {
            let name = entry?.file_name().to_string_lossy().into_owned();
            if let Some(id) = name.strip_suffix(".json") {
                ids.push(id.to_owned());
            }
        }
        let mut result = Vec::new();
        for id in ids {
            match self.recover_mutation(&id) {
                Ok(record) => result.push(record),
                Err(error) => result.push(RecoveryRecord {
                    id,
                    state: "needs-review".into(),
                    message: error.message,
                    versions: Vec::new(),
                    exported_to: None,
                    result: None,
                }),
            }
        }
        Ok(result)
    }

    pub fn import_files(
        &self,
        imports: Vec<ImportedFile>,
        directory: &str,
    ) -> VaultResult<MutationResult> {
        let _guard = mutation_guard().lock().unwrap_or_else(|e| e.into_inner());
        let _identities = self
            .identity_writes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        self.ensure_current_manifest()?;
        self.ensure_no_pending_mutations()?;
        if imports.len() > 100
            || imports
                .iter()
                .map(|file| {
                    file.bytes.len() as u64
                        + file
                            .companion
                            .as_ref()
                            .map_or(0, |bytes| bytes.len() as u64)
                })
                .sum::<u64>()
                > 256 * 1024 * 1024
        {
            return Err(VaultError::invalid(
                "Import is limited to 100 files and 256 MiB.",
            ));
        }
        if is_admin_path(directory) {
            return Err(VaultError::invalid(
                "Administrative destinations are protected.",
            ));
        }
        if !directory.is_empty() {
            let (parent, name) = open_path(&self.dir, directory, false)?;
            parent.open_dir_nofollow(name)?;
        }
        let mut metadata_files = Vec::new();
        collect_all_metadata_bounded(self, &mut metadata_files)?;
        let mut identities: HashMap<String, Vec<String>> = HashMap::new();
        for (path, text) in &metadata_files {
            let meta = if is_companion_name(path) {
                metadata::companion_metadata(text)
            } else {
                metadata::note_metadata(text)
            };
            if let Some(id) = meta.id {
                identities.entry(id).or_default().push(path.clone());
            }
        }
        drop(metadata_files);
        let mut result = MutationResult {
            outcomes: Vec::new(),
            mappings: Vec::new(),
            affected_paths: Vec::new(),
            recovery_id: None,
        };
        for mut file in imports {
            if result.recovery_id.is_some() {
                result.outcomes.push(MutationOutcome {
                    path: file.name,
                    status: "unstarted".into(),
                    destination: None,
                    message: None,
                });
                continue;
            }
            let outcome = (|| -> VaultResult<MutationResult> {
                let target_name = file_name(&file.name)?;
                let target = join_path(directory, target_name);
                if is_admin_path(&target) || file.bytes.len() as u64 > MAX_BYTES {
                    return Err(VaultError::invalid(
                        "Import path is protected or the file exceeds 64 MiB.",
                    ));
                }
                let kind = capability::kind(Path::new(target_name));
                if !matches!(kind, "markdown" | "pdf" | "docx") {
                    return Err(VaultError::invalid(
                        "Only Markdown, PDF and DOCX can be imported.",
                    ));
                }
                let mut bytes = std::mem::take(&mut file.bytes);
                let mut imported_id = None;
                if kind == "markdown" {
                    let text = String::from_utf8(bytes)
                        .map_err(|_| VaultError::invalid("Markdown import must be UTF-8."))?;
                    let text = if metadata::note_metadata(&text).id.is_none() {
                        metadata::adopt(&text)?
                    } else {
                        text
                    };
                    let meta = metadata::note_metadata(&text);
                    if meta.error.is_some() || meta.id.is_none() {
                        return Err(VaultError::invalid(
                            "Markdown identity metadata is invalid.",
                        ));
                    }
                    imported_id = meta.id;
                    bytes = text.into_bytes();
                }
                if let Some(companion) = &file.companion {
                    if !matches!(kind, "pdf" | "docx") || companion.len() > 256 * 1024 {
                        return Err(VaultError::invalid(
                            "Only bounded PDF/DOCX companion metadata can be imported.",
                        ));
                    }
                    let text = std::str::from_utf8(companion)
                        .map_err(|_| VaultError::invalid("Companion metadata must be UTF-8."))?;
                    let meta = metadata::companion_metadata(text);
                    if meta.error.is_some() || meta.id.is_none() {
                        return Err(VaultError::invalid(
                            "Companion identity metadata is invalid.",
                        ));
                    }
                    imported_id = meta.id;
                }
                if let Some(id) = &imported_id
                    && let Some(existing) = identities.get(id)
                {
                    if kind == "markdown"
                        && existing.iter().all(|path| {
                            self.read_note(path)
                                .is_ok_and(|note| note.text.as_bytes() == bytes)
                        })
                    {
                        return Ok(MutationResult {
                            outcomes: vec![MutationOutcome {
                                path: file.name.clone(),
                                status: "skipped".into(),
                                destination: existing.first().cloned(),
                                message: Some(
                                    "An identical Note with this identity already exists.".into(),
                                ),
                            }],
                            mappings: Vec::new(),
                            affected_paths: Vec::new(),
                            recovery_id: None,
                        });
                    }
                    return Err(VaultError::conflict(
                        format!(
                            "Identity already exists at {}; originals were preserved.",
                            existing.join(", ")
                        ),
                        None,
                    ));
                }
                if exists(&self.dir, &target)?
                    || (file.companion.is_some()
                        && exists(&self.dir, &format!("{target}.meta.yaml"))?)
                {
                    return Err(VaultError::conflict(
                        "Import destination or companion already exists.",
                        None,
                    ));
                }
                let id = Uuid::new_v4().to_string();
                let admin = admin_dir(self)?;
                let transaction = child_dir(&child_dir(&admin, "transactions")?, &id)?;
                let journals = child_dir(&admin, "journals")?;
                let mut journal = Journal {
                    schema: 2,
                    id: id.clone(),
                    vault_id: self.id.clone(),
                    request: MutationRequest {
                        kind: MutationKind::Duplicate,
                        paths: vec![target.clone()],
                        destination: Some(directory.into()),
                    },
                    completed: Vec::new(),
                    changes: Vec::new(),
                    moves: Vec::new(),
                    captures: Vec::new(),
                    ready: false,
                    exported_to: None,
                    created_at: now(),
                };
                write_json_new(&journals, &format!("{id}.json"), &journal)?;
                let staged = (|| -> VaultResult<()> {
                    for (index, (name, bytes)) in
                        std::iter::once((target.clone(), bytes.as_slice()))
                            .chain(
                                file.companion
                                    .as_ref()
                                    .map(|bytes| (format!("{target}.meta.yaml"), bytes.as_slice())),
                            )
                            .enumerate()
                    {
                        capability::write_new(
                            &transaction,
                            Path::new(&format!("backup-{index}")),
                            bytes,
                        )?;
                        capability::write_new(
                            &transaction,
                            Path::new(&format!("stage-{index}")),
                            bytes,
                        )?;
                        capability::write_new(
                            &transaction,
                            Path::new(&format!("output-{index}")),
                            bytes,
                        )?;
                        let revision = source_revision(&transaction, &format!("stage-{index}"))?;
                        journal.moves.push(JournalMove {
                            item: target.clone(),
                            source: format!("transactions/{id}/backup-{index}"),
                            target: name,
                            source_admin: true,
                            target_admin: false,
                            duplicate: true,
                            expected_revision: revision.clone(),
                            output_revision: revision,
                            mappings: Vec::new(),
                        });
                    }
                    journal.ready = true;
                    replace_json(&journals, &format!("{id}.json"), &journal)
                })();
                if let Err(error) = staged {
                    return Ok(failed_transaction(&journal, error.message));
                }
                let imported = self.run_journal(&admin, &journals, &mut journal)?;
                if imported.recovery_id.is_none()
                    && let Some(id) = imported_id
                {
                    identities.entry(id).or_default().push(target);
                }
                Ok(imported)
            })();
            match outcome {
                Ok(item) => {
                    result.outcomes.extend(item.outcomes);
                    result.affected_paths.extend(item.affected_paths);
                    result.recovery_id = item.recovery_id;
                }
                Err(error) => result.outcomes.push(MutationOutcome {
                    path: file.name,
                    status: "failed".into(),
                    destination: None,
                    message: Some(error.message),
                }),
            }
        }
        Ok(result)
    }
}

fn same_entry(root: &Dir, left: &str, right: &str) -> VaultResult<bool> {
    if !exists(root, left)? || !exists(root, right)? {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        let (ld, ln) = open_path(root, left, false)?;
        let (rd, rn) = open_path(root, right, false)?;
        let lm = ld.symlink_metadata(ln)?;
        let rm = rd.symlink_metadata(rn)?;
        // Distinct hard-link directory entries are collisions, not case aliases.
        Ok(left.to_lowercase() == right.to_lowercase()
            && lm.dev() == rm.dev()
            && lm.ino() == rm.ino()
            && (lm.is_dir() || lm.nlink() == 1))
    }
    #[cfg(not(unix))]
    {
        Ok(left == right)
    }
}

fn move_one(
    source_root: &Dir,
    source: &str,
    destination_root: &Dir,
    target: &str,
) -> VaultResult<()> {
    let (src_dir, src_name) = open_path(source_root, source, false)?;
    let (dst_dir, dst_name) = open_path(destination_root, target, true)?;
    #[cfg(test)]
    run_move_hook(target);
    #[cfg(any(target_os = "linux", target_os = "android", target_os = "macos"))]
    rustix::fs::renameat_with(
        &src_dir,
        &src_name,
        &dst_dir,
        &dst_name,
        rustix::fs::RenameFlags::NOREPLACE,
    )
    .map_err(|error| {
        VaultError::io(format!(
            "Exclusive rename failed; source/staging was preserved: {error}"
        ))
    })?;
    #[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
    return Err(VaultError::invalid(
        "This platform has no supported exclusive rename primitive; source was preserved.",
    ));
    capability::sync_dir(&src_dir)?;
    capability::sync_dir(&dst_dir)?;
    Ok(())
}

fn copy_path(src: &Dir, source: &str, dst: &Dir, target: &str) -> VaultResult<()> {
    let (src, source) = open_path(src, source, false)?;
    let (dst, target) = open_path(dst, target, true)?;
    copy_raw(&src, &source, &dst, &target, 0)
}

fn copy_raw(src: &Dir, source: &Path, dst: &Dir, target: &Path, depth: usize) -> VaultResult<()> {
    if depth > 128 {
        return Err(VaultError::invalid(
            "Recovery tree exceeds the depth limit.",
        ));
    }
    if entry_kind(src, source)?.is_file() {
        let input = capability::open_regular(src, source)?;
        let length = input.metadata()?.len();
        let mut output = capability::write_new(dst, target, b"")?;
        let copied = std::io::copy(&mut input.take(length + 1), &mut output)?;
        if copied != length {
            return Err(VaultError::conflict(
                "File changed while copying recovery bytes.",
                None,
            ));
        }
        output.sync_all()?;
    } else {
        dst.create_dir(target)?;
        let source = src.open_dir_nofollow(source)?;
        let target = dst.open_dir_nofollow(target)?;
        for entry in source.entries()? {
            let name = entry?.file_name();
            copy_raw(
                &source,
                Path::new(&name),
                &target,
                Path::new(&name),
                depth + 1,
            )?;
        }
        capability::sync_dir(&target)?;
    }
    capability::sync_dir(dst)
}

fn duplicate_identities(root: &Dir, roots: &[String]) -> VaultResult<HashMap<String, String>> {
    let mut files = Vec::new();
    let mut count = 0;
    let mut bytes = 0;
    for path in roots {
        collect_markdown_bounded(root, path, &mut files, &mut count, &mut bytes)?;
        if let Some(companion) = existing_companion(root, path)? {
            collect_markdown_bounded(root, &companion, &mut files, &mut count, &mut bytes)?;
        }
    }
    let mut identities = HashMap::new();
    for (path, text) in &files {
        let note = capability::kind(Path::new(path)) == "markdown";
        let inspected = if note {
            metadata::note_metadata(text)
        } else {
            metadata::companion_metadata(text)
        };
        let fresh = Uuid::new_v4().to_string();
        metadata::duplicate_source(text, note, &fresh, &HashMap::new())?;
        // Unadopted Markdown has no identity to remap; give its output a fresh one by path.
        let key = inspected.id.unwrap_or_else(|| format!("path:{path}"));
        if identities.insert(key, fresh).is_some() {
            return Err(VaultError::invalid(
                "The duplicated subtree contains repeated identities; repair them before duplicating.",
            ));
        }
    }
    Ok(identities)
}

struct DuplicateRewrites<'a> {
    paths: &'a [(String, String)],
    identities: &'a HashMap<String, String>,
}

fn copy_entry(
    src: &Dir,
    src_name: &Path,
    dst: &Dir,
    dst_name: &Path,
    source_path: &str,
    target_path: &str,
    rewrites: &DuplicateRewrites<'_>,
) -> VaultResult<()> {
    if source_path.split('/').count() > 128 {
        return Err(VaultError::invalid(
            "Duplicate tree exceeds the depth limit.",
        ));
    }
    let ty = entry_kind(src, src_name)?;
    if ty.is_file() {
        if capability::kind(Path::new(source_path)) != "markdown" && !is_companion_name(source_path)
        {
            return copy_raw(src, src_name, dst, dst_name, 0);
        }
        let bytes = capability::read_limited(src, src_name, MAX_BYTES)?;
        let note = capability::kind(Path::new(source_path)) == "markdown";
        let output = if note || is_companion_name(source_path) {
            let text = String::from_utf8(bytes)
                .map_err(|_| VaultError::invalid("Metadata source must be UTF-8."))?;
            let inspected = if note {
                metadata::note_metadata(&text)
            } else {
                metadata::companion_metadata(&text)
            };
            let key = inspected
                .id
                .unwrap_or_else(|| format!("path:{source_path}"));
            let fresh = rewrites.identities.get(&key).ok_or_else(|| {
                VaultError::conflict("Identity scope changed while duplicating.", None)
            })?;
            let text = metadata::duplicate_source(&text, note, fresh, rewrites.identities)?;
            if note {
                rewrite_markdown(&text, source_path, target_path, rewrites.paths)?.into_bytes()
            } else {
                text.into_bytes()
            }
        } else {
            bytes
        };
        capability::write_new(dst, dst_name, &output)?;
        return Ok(());
    }
    dst.create_dir(dst_name)?;
    let child_src = src.open_dir_nofollow(src_name)?;
    let child_dst = dst.open_dir_nofollow(dst_name)?;
    for entry in child_src.entries()? {
        let entry = entry?;
        let name = entry.file_name();
        let name_text = name
            .to_str()
            .ok_or_else(|| VaultError::invalid("A descendant filename is not valid Unicode."))?;
        let source_child = join_path(source_path, name_text);
        let target_child = join_path(target_path, name_text);
        copy_entry(
            &child_src,
            Path::new(&name),
            &child_dst,
            Path::new(&name),
            &source_child,
            &target_child,
            rewrites,
        )?;
    }
    capability::sync_dir(&child_dst)?;
    capability::sync_dir(dst)?;
    Ok(())
}

fn is_companion_name(path: &str) -> bool {
    path.strip_suffix(".meta.yaml")
        .is_some_and(|original| matches!(capability::kind(Path::new(original)), "pdf" | "docx"))
}
fn collect_markdown_bounded(
    root: &Dir,
    path: &str,
    out: &mut Vec<(String, String)>,
    count: &mut u64,
    bytes: &mut u64,
) -> VaultResult<()> {
    if path.split('/').count() > 128 {
        return Err(VaultError::invalid(
            "Reference assessment exceeds the depth limit.",
        ));
    }
    if *count >= MAX_SCOPE_ENTRIES {
        return Err(VaultError::invalid(
            "Reference assessment exceeds the bounded entry limit.",
        ));
    }
    *count += 1;
    let (dir, name) = open_path(root, path, false)?;
    let ty = entry_kind(&dir, &name)?;
    if ty.is_file() {
        if capability::kind(&name) == "markdown" || is_companion_name(path) {
            let text = capability::read_text(&dir, &name)?;
            *bytes = bytes
                .checked_add(text.len() as u64)
                .ok_or_else(|| VaultError::invalid("Reference assessment is too large."))?;
            if *bytes > 256 * 1024 * 1024 {
                return Err(VaultError::invalid(
                    "Reference assessment exceeds the bounded byte limit.",
                ));
            }
            out.push((path.to_owned(), text));
        }
        return Ok(());
    }
    let child = dir.open_dir_nofollow(&name)?;
    for entry in child.entries()? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name
            .to_str()
            .ok_or_else(|| VaultError::invalid("A descendant filename is not valid Unicode."))?;
        collect_markdown_bounded(root, &join_path(path, name), out, count, bytes)?;
    }
    Ok(())
}

fn collect_all_metadata_bounded(vault: &Vault, out: &mut Vec<(String, String)>) -> VaultResult<()> {
    let mut count = 0;
    let mut bytes = 0;
    let marked_legacy = vault.content_root_relative == "." && existing_admin_dir(vault)?.is_some();
    for entry in vault.dir.entries()? {
        let name = entry?.file_name();
        let name = name
            .to_str()
            .ok_or_else(|| VaultError::invalid("A filename is not valid Unicode."))?;
        if marked_legacy && name == ADMIN {
            continue;
        }
        collect_markdown_bounded(&vault.dir, name, out, &mut count, &mut bytes)?;
    }
    Ok(())
}

fn collect_all_markdown_bounded(vault: &Vault, out: &mut Vec<(String, String)>) -> VaultResult<()> {
    collect_all_metadata_bounded(vault, out)?;
    out.retain(|(path, _)| capability::kind(Path::new(path)) == "markdown");
    Ok(())
}

fn collect_mappings(vault: &Vault, from: &str, to: &str) -> VaultResult<Vec<IdentityMapping>> {
    let mut result = vec![IdentityMapping {
        from: from.into(),
        to: to.into(),
        id: None,
    }];
    let mut notes = Vec::new();
    collect_markdown_bounded(&vault.dir, from, &mut notes, &mut 0, &mut 0)?;
    for (path, text) in notes {
        let target = remap_path(&path, &[(from.to_owned(), to.to_owned())]);
        let id = if is_companion_name(&path) {
            metadata::companion_metadata(&text).id
        } else {
            metadata::note_metadata(&text).id
        };
        if path == from {
            result[0].id = id;
        } else {
            result.push(IdentityMapping {
                from: path,
                to: target,
                id,
            });
        }
    }
    Ok(result)
}

#[derive(Debug)]
struct LinkEdit {
    start: usize,
    end: usize,
    target: String,
}

fn rewrite_markdown(
    text: &str,
    old_referrer: &str,
    new_referrer: &str,
    maps: &[(String, String)],
) -> VaultResult<String> {
    let edits = parse_links(text)?;
    let mut result = text.to_owned();
    for edit in edits.into_iter().rev() {
        if let Some(target) = rewrite_target(&edit.target, old_referrer, new_referrer, maps) {
            result.replace_range(edit.start..edit.end, &target);
        }
    }
    Ok(result)
}
fn parse_links(text: &str) -> VaultResult<Vec<LinkEdit>> {
    let mut edits = Vec::new();
    let parser = Parser::new_ext(text, Options::all());
    // Only parser-recognized definitions are eligible: not code, HTML, or shadow definitions.
    for (_, definition) in parser.reference_definitions().iter() {
        let raw = &text[definition.span.clone()];
        let (start, end) = label_end(raw).and_then(|close| destination_span(raw, close + 2))
            .filter(|&(start, end)| destination_matches(raw, start, end, &definition.dest))
            .ok_or_else(|| VaultError::invalid("A reference definition cannot be rewritten byte-safely; edit its layout explicitly first."))?;
        edits.push(LinkEdit {
            start: definition.span.start + start,
            end: definition.span.start + end,
            target: definition.dest.to_string(),
        });
    }
    for (event, range) in parser.into_offset_iter() {
        let destination = match event {
            Event::Start(Tag::Link {
                link_type: LinkType::Inline,
                dest_url,
                ..
            })
            | Event::Start(Tag::Image {
                link_type: LinkType::Inline,
                dest_url,
                ..
            }) => dest_url,
            _ => continue,
        };
        let raw = &text[range.clone()];
        let (start, end) = inline_destination(raw)
            .filter(|&(start, end)| destination_matches(raw, start, end, &destination))
            .ok_or_else(|| VaultError::invalid("A local link cannot be rewritten byte-safely; edit its layout explicitly first."))?;
        edits.push(LinkEdit {
            start: range.start + start,
            end: range.start + end,
            target: destination.to_string(),
        });
    }
    edits.sort_by_key(|edit| (edit.start, edit.end));
    edits.dedup_by_key(|edit| (edit.start, edit.end));
    Ok(edits)
}

fn inline_destination(raw: &str) -> Option<(usize, usize)> {
    let close = label_end(raw)?;
    if raw.as_bytes().get(close + 1) != Some(&b'(') {
        return None;
    }
    destination_span(raw, close + 2)
}

fn label_end(raw: &str) -> Option<usize> {
    let bytes = raw.as_bytes();
    let mut index = usize::from(raw.starts_with('!'));
    if bytes.get(index) != Some(&b'[') {
        return None;
    }
    // Parser-owned code and HTML ranges prevent brackets inside labels from becoming destinations.
    let mut ignored = Parser::new_ext(raw, Options::all())
        .into_offset_iter()
        .filter_map(|(event, span)| {
            matches!(
                event,
                Event::Code(_) | Event::Html(_) | Event::InlineHtml(_)
            )
            .then_some(span)
        })
        .peekable();
    let mut depth = 1;
    index += 1;
    while index < bytes.len() {
        while ignored.peek().is_some_and(|span| span.end <= index) {
            ignored.next();
        }
        if let Some(span) = ignored.peek().filter(|span| span.contains(&index)) {
            index = span.end;
            continue;
        }
        match bytes[index] {
            b'\\' => {
                index += 2;
                continue;
            }
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn destination_matches(raw: &str, start: usize, end: usize, expected: &str) -> bool {
    let angle = start > 0 && raw.as_bytes()[start - 1] == b'<';
    let source = if angle {
        format!("[x](<{}>)", &raw[start..end])
    } else {
        format!("[x]({})", &raw[start..end])
    };
    Parser::new(&source).any(|event| matches!(event, Event::Start(Tag::Link { dest_url, .. }) if dest_url.as_ref() == expected))
}

fn destination_span(raw: &str, offset: usize) -> Option<(usize, usize)> {
    let start = offset + raw[offset..].len() - raw[offset..].trim_start().len();
    let angle = raw.as_bytes().get(start) == Some(&b'<');
    let start = start + usize::from(angle);
    let mut depth = 0;
    let mut escaped = false;
    for (offset, byte) in raw.as_bytes()[start..].iter().copied().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if byte == b'\\' {
            escaped = true;
            continue;
        }
        if angle {
            if byte == b'>' {
                return Some((start, start + offset));
            }
        } else {
            if byte == b'(' {
                depth += 1;
            } else if byte == b')' {
                if depth == 0 {
                    return Some((start, start + offset));
                }
                depth -= 1;
            } else if byte.is_ascii_whitespace() {
                return Some((start, start + offset));
            }
        }
    }
    (!angle && start < raw.len()).then_some((start, raw.len()))
}
fn remap_path(path: &str, maps: &[(String, String)]) -> String {
    for (from, to) in maps {
        if path == *from {
            return to.clone();
        }
        if let Some(rest) = path.strip_prefix(&(from.clone() + "/")) {
            return join_path(to, rest);
        }
    }
    path.to_owned()
}
fn reverse_remap_path(path: &str, maps: &[(String, String)]) -> String {
    for (from, to) in maps {
        if path == to {
            return from.clone();
        }
        if let Some(rest) = path.strip_prefix(&(to.clone() + "/")) {
            return join_path(from, rest);
        }
    }
    path.to_owned()
}
fn rewrite_target(
    target: &str,
    old_referrer: &str,
    new_referrer: &str,
    maps: &[(String, String)],
) -> Option<String> {
    if target.is_empty()
        || target.starts_with(['#', '?'])
        || target.starts_with("//")
        || target.split_once(':').is_some_and(|(scheme, _)| {
            !scheme.is_empty()
                && scheme.as_bytes()[0].is_ascii_alphabetic()
                && scheme
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
        })
    {
        return None;
    }
    let (path, suffix) = target
        .find(['#', '?'])
        .map_or((target, ""), |index| (&target[..index], &target[index..]));
    let root_relative = path.starts_with('/');
    let decoded = percent_decode(path.trim_start_matches('/'))?;
    if decoded.contains('\0') || decoded.contains('\\') {
        return None;
    }
    let base = if root_relative {
        Path::new("")
    } else {
        Path::new(old_referrer).parent().unwrap_or(Path::new(""))
    };
    let resolved = normalize(base.join(decoded))?;
    let mapped = remap_path(&resolved, maps);
    if mapped == resolved
        && (root_relative || Path::new(old_referrer).parent() == Path::new(new_referrer).parent())
    {
        return None;
    }
    let rewritten = if root_relative {
        format!("/{}", format_encoded(&mapped))
    } else {
        let base = Path::new(new_referrer).parent().unwrap_or(Path::new(""));
        format_encoded(&relative_link(base, Path::new(&mapped)))
    };
    Some(rewritten + suffix)
}
fn relative_link(base: &Path, target: &Path) -> String {
    let b = base
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(n) => Some(n.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let t = target
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(n) => Some(n.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let mut common = 0;
    while common < b.len() && common < t.len() && b[common] == t[common] {
        common += 1;
    }
    let mut out = Vec::new();
    for _ in common..b.len() {
        out.push("..".into());
    }
    out.extend(t[common..].iter().cloned());
    if out.is_empty() {
        ".".into()
    } else {
        out.join("/")
    }
}
fn percent_decode(input: &str) -> Option<String> {
    let mut out = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let value = std::str::from_utf8(&bytes[index + 1..index + 3])
                .ok()
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())?;
            out.push(value);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}
fn format_encoded(path: &str) -> String {
    let mut result = String::with_capacity(path.len());
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'-' | b'_' | b'~') {
            result.push(byte as char);
        } else {
            use std::fmt::Write as _;
            write!(&mut result, "%{byte:02X}").expect("writing a String cannot fail");
        }
    }
    result
}

fn recovery_versions(journal: &Journal) -> Vec<String> {
    let mut versions = journal.request.paths.clone();
    versions.extend(
        journal
            .moves
            .iter()
            .filter(|entry| !entry.source_admin)
            .map(|entry| entry.source.clone()),
    );
    versions.extend(
        journal
            .moves
            .iter()
            .filter(|entry| !entry.target_admin)
            .map(|entry| entry.target.clone()),
    );
    versions.extend(journal.changes.iter().map(|change| change.path.clone()));
    versions.sort();
    versions.dedup();
    versions
}

fn failed_transaction(journal: &Journal, message: String) -> MutationResult {
    MutationResult {
        outcomes: journal
            .request
            .paths
            .iter()
            .enumerate()
            .map(|(index, path)| MutationOutcome {
                path: path.clone(),
                status: if index == 0 { "failed" } else { "unstarted" }.into(),
                destination: None,
                message: (index == 0).then(|| message.clone()),
            })
            .collect(),
        mappings: Vec::new(),
        affected_paths: recovery_versions(journal),
        recovery_id: Some(journal.id.clone()),
    }
}

fn write_verified(dir: &Dir, name: &str, bytes: &[u8]) -> VaultResult<()> {
    if exists(dir, name)? {
        if capability::read_regular(dir, Path::new(name))? != bytes {
            return Err(VaultError::conflict(
                format!("Existing recovery file differs: {name}; it was not overwritten."),
                None,
            ));
        }
        return Ok(());
    }
    let temporary = format!(".recovery-{}", Uuid::new_v4());
    capability::write_new(dir, Path::new(&temporary), bytes)?;
    move_one(dir, &temporary, dir, name)
}

fn copy_verified_tree(
    source: &Dir,
    name: &str,
    destination: &Dir,
    target: &str,
) -> VaultResult<()> {
    let (source_parent, source_name) = open_path(source, name, false)?;
    if entry_kind(&source_parent, &source_name)?.is_file() {
        if exists(destination, target)? {
            if source_revision(source, name)? != source_revision(destination, target)? {
                return Err(VaultError::conflict(
                    "An existing recovery copy differs; no bytes were overwritten.",
                    None,
                ));
            }
        } else {
            let (parent, file) = open_path(destination, target, true)?;
            let temporary = format!(".recovery-{}", Uuid::new_v4());
            copy_raw(
                &source_parent,
                &source_name,
                &parent,
                Path::new(&temporary),
                0,
            )?;
            move_one(
                &parent,
                &temporary,
                &parent,
                file.to_str()
                    .ok_or_else(|| VaultError::invalid("Recovery filename is invalid."))?,
            )?;
        }
    } else {
        let (parent, folder) = open_path(destination, target, true)?;
        let destination = child_dir(
            &parent,
            folder
                .to_str()
                .ok_or_else(|| VaultError::invalid("Recovery folder is invalid."))?,
        )?;
        let source = source_parent.open_dir_nofollow(source_name)?;
        for entry in source.entries()? {
            let name = entry?.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| VaultError::invalid("Recovery filename is invalid."))?;
            copy_verified_tree(&source, name, &destination, name)?;
        }
        capability::sync_dir(&destination)?;
    }
    Ok(())
}

fn verify_tree(source: &Dir, name: &str, destination: &Dir, target: &str) -> VaultResult<()> {
    let (parent, file) = open_path(source, name, false)?;
    if entry_kind(&parent, &file)?.is_file() {
        if source_revision(source, name)? != source_revision(destination, target)? {
            return Err(VaultError::conflict(
                "A recovery copy differs from its retained version.",
                None,
            ));
        }
    } else {
        let source = parent.open_dir_nofollow(file)?;
        let (parent, folder) = open_path(destination, target, false)?;
        let destination = parent.open_dir_nofollow(folder)?;
        for entry in source.entries()? {
            let name = entry?.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| VaultError::invalid("Recovery filename is invalid."))?;
            verify_tree(&source, name, &destination, name)?;
        }
    }
    Ok(())
}

fn change_stem(index: usize, change: &JournalChange) -> String {
    format!(
        "{index:04}-{}",
        file_name(&change.path).unwrap_or("document.md")
    )
}

fn write_recovery_versions(admin: &Dir, journal: &Journal, destination: &Dir) -> VaultResult<()> {
    write_verified(destination, "journal.json", &json_bytes(journal)?)?;
    for (index, change) in journal.changes.iter().enumerate() {
        let stem = change_stem(index, change);
        write_verified(destination, &format!("{stem}.original"), &change.original)?;
        write_verified(destination, &format!("{stem}.updated"), &change.updated)?;
    }
    let path = format!("transactions/{}", journal.id);
    if exists(admin, &path)? {
        copy_verified_tree(admin, &path, destination, "staging")?;
    }
    capability::sync_dir(destination)
}

fn verify_recovery_versions(admin: &Dir, journal: &Journal, destination: &Dir) -> VaultResult<()> {
    if capability::read_regular(destination, Path::new("journal.json"))? != json_bytes(journal)? {
        return Err(VaultError::conflict(
            "The exported journal differs from the active original.",
            None,
        ));
    }
    for (index, change) in journal.changes.iter().enumerate() {
        let stem = change_stem(index, change);
        if super::hash(&change.original) != change.expected_revision
            || capability::read_regular(destination, Path::new(&format!("{stem}.original")))?
                != change.original
            || capability::read_regular(destination, Path::new(&format!("{stem}.updated")))?
                != change.updated
        {
            return Err(VaultError::conflict(
                "Not every original and updated recovery byte was verified.",
                None,
            ));
        }
    }
    let path = format!("transactions/{}", journal.id);
    if exists(admin, &path)? {
        let transaction = admin.open_dir_nofollow(&path)?;
        if journal.ready {
            for (index, entry) in journal.moves.iter().enumerate() {
                if source_revision(&transaction, &format!("backup-{index}"))?
                    != entry.expected_revision
                {
                    return Err(VaultError::conflict(
                        "A retained original does not match the journal revision.",
                        None,
                    ));
                }
                if entry.duplicate
                    && source_revision(&transaction, &format!("output-{index}"))?
                        != entry.output_revision
                {
                    return Err(VaultError::conflict(
                        "A retained duplicate does not match the journal revision.",
                        None,
                    ));
                }
            }
        }
        for capture in &journal.captures {
            if source_revision(&transaction, &capture.path)? != capture.revision {
                return Err(VaultError::conflict(
                    "A captured source differs from its journaled revision.",
                    None,
                ));
            }
        }
        verify_tree(admin, &path, destination, "staging")?;
    } else if journal.schema == 2 {
        return Err(VaultError::conflict(
            "Private staging is missing; recovery cannot be acknowledged.",
            None,
        ));
    }
    Ok(())
}

fn read_trash_record(dir: &Dir, id: &str) -> VaultResult<TrashRecord> {
    let record: TrashRecord =
        serde_json::from_slice(&capability::read_regular(dir, Path::new("record.json"))?)
            .map_err(|error| VaultError::invalid(format!("Malformed Trash record: {error}")))?;
    capability::relative(&record.path)?;
    if record.id != id
        || is_admin_path(&record.path)
        || record.payload != format!("payload/{}", file_name(&record.path)?)
        || record.companions.len() > 1
        || record
            .companions
            .iter()
            .any(|name| name != &format!("{}.meta.yaml", file_name(&record.path).unwrap_or("")))
        || (!record.companions.is_empty() && companion_path(&record.path).is_none())
    {
        return Err(VaultError::invalid(
            "Trash record paths or companions are invalid.",
        ));
    }
    Ok(record)
}

fn finish_restored_trash(admin: &Dir, journal: &Journal) -> VaultResult<()> {
    let mut records = HashSet::new();
    for entry in &journal.moves {
        if entry.source_admin
            && let Some(path) = entry.source.strip_prefix("trash/")
        {
            records.insert(path.split('/').next().unwrap().to_owned());
        }
    }
    if records.is_empty() {
        return Ok(());
    }
    let trash = admin.open_dir_nofollow("trash")?;
    for id in records {
        if !exists(&trash, &id)? {
            continue;
        }
        let record = trash.open_dir_nofollow(&id)?;
        if let Some(payload) = optional_dir(&record, "payload")? {
            if payload.entries()?.next().transpose()?.is_some() {
                return Err(VaultError::conflict(
                    "Unexpected Trash descendants remain; they were not deleted.",
                    None,
                ));
            }
            record.remove_dir("payload")?;
        }
        if exists(&record, "record.json")? {
            record.remove_file("record.json")?;
        }
        capability::sync_dir(&record)?;
        trash.remove_dir(&id)?;
    }
    capability::sync_dir(&trash)
}

fn published_matches(
    root: &Dir,
    path: &str,
    backups: &Dir,
    backup: &str,
    changes: &[JournalChange],
) -> VaultResult<bool> {
    let (parent, name) = open_path(backups, backup, false)?;
    if entry_kind(&parent, &name)?.is_file() {
        if let Some((index, change)) = changes
            .iter()
            .enumerate()
            .find(|(_, change)| change.path == path)
        {
            if !exists(root, path)? {
                let captured = format!("referrer-{index}.original");
                return Ok(exists(backups, &captured)?
                    && capability::read_regular(backups, Path::new(&captured))?
                        == change.original);
            }
            let (dir, name) = open_path(root, path, false)?;
            let bytes = capability::read_regular(&dir, &name)?;
            return Ok(bytes == change.original || bytes == change.updated);
        }
        return Ok(source_revision(root, path)? == source_revision(backups, backup)?);
    }
    let old = parent.open_dir_nofollow(name)?;
    let (parent, name) = open_path(root, path, false)?;
    let new = parent.open_dir_nofollow(name)?;
    let names = old
        .entries()?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<Result<HashSet<_>, _>>()?;
    let current = new
        .entries()?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<Result<HashSet<_>, _>>()?;
    if !current.is_subset(&names) {
        return Ok(false);
    }
    for name in names {
        let name = name
            .to_str()
            .ok_or_else(|| VaultError::invalid("A filename is invalid Unicode."))?;
        if !published_matches(
            root,
            &join_path(path, name),
            backups,
            &join_path(backup, name),
            changes,
        )? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn trash_confirmations() -> &'static Mutex<HashMap<(PathBuf, String), String>> {
    static CONFIRMED: LazyLock<Mutex<HashMap<(PathBuf, String), String>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    &CONFIRMED
}

#[cfg(test)]
type MoveHook = (String, Box<dyn FnOnce()>);

#[cfg(test)]
thread_local! {
    static BEFORE_MOVE: std::cell::RefCell<Option<MoveHook>> = const { std::cell::RefCell::new(None) };
    static AFTER_SCOPE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(super) fn before_move_to(target: &str, hook: impl FnOnce() + 'static) {
    BEFORE_MOVE.with(|slot| *slot.borrow_mut() = Some((target.into(), Box::new(hook))));
}

#[cfg(test)]
fn run_move_hook(target: &str) {
    let hook = BEFORE_MOVE.with(|slot| {
        let matches = slot
            .borrow()
            .as_ref()
            .is_some_and(|(path, _)| path == target);
        if matches {
            slot.borrow_mut().take()
        } else {
            None
        }
    });
    if let Some((_, hook)) = hook {
        hook();
    }
}

#[cfg(test)]
pub(super) fn after_scope(hook: impl FnOnce() + 'static) {
    AFTER_SCOPE.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

#[cfg(test)]
fn run_scope_hook() {
    let hook = AFTER_SCOPE.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook();
    }
}

fn sibling_stage(path: &str, id: &str, label: &str) -> String {
    join_path(
        &path_string(Path::new(path).parent().unwrap_or(Path::new(""))),
        &format!(".adamant-{id}-{label}"),
    )
}

fn same_device(left: &Dir, right: &Dir) -> VaultResult<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(left.try_clone()?.into_std_file().metadata()?.dev()
            == right.try_clone()?.into_std_file().metadata()?.dev())
    }
    #[cfg(not(unix))]
    {
        Err(VaultError::invalid(
            "Safe cross-filesystem publication is unavailable on this platform.",
        ))
    }
}

fn publish_entry(
    source: &Dir,
    stage: &str,
    destination: &Dir,
    target: &str,
    revision: &str,
    id: &str,
    index: usize,
) -> VaultResult<()> {
    let (source_parent, source_name) = open_path(source, stage, false)?;
    let (target_parent, _) = open_path(destination, target, true)?;
    if same_device(&source_parent, &target_parent)? {
        return move_one(source, stage, destination, target);
    }
    let publication = sibling_stage(target, id, &format!("publish-{index}"));
    copy_verified_tree(source, stage, destination, &publication)?;
    if source_revision(destination, &publication)? != revision
        || source_revision(source, stage)? != revision
    {
        return Err(VaultError::conflict(
            "Cross-filesystem copy changed; captured original and copy were retained.",
            None,
        ));
    }
    move_one(destination, &publication, destination, target)?;
    if source_revision(destination, target)? != revision
        || source_revision(source, stage)? != revision
    {
        return Err(VaultError::conflict(
            "Cross-filesystem publication changed; the captured original was retained.",
            None,
        ));
    }
    remove_tree(&source_parent, &source_name)?;
    capability::sync_dir(&source_parent)
}

fn capture_locations(journal: &Journal) -> Vec<(bool, String, String)> {
    let mut locations = Vec::new();
    for (index, entry) in journal.moves.iter().enumerate() {
        if !entry.duplicate {
            locations.push((
                entry.source_admin,
                sibling_stage(&entry.source, &journal.id, &format!("move-{index}")),
                format!("source-{index}"),
            ));
        }
        locations.push((
            entry.target_admin,
            sibling_stage(&entry.target, &journal.id, &format!("publish-{index}")),
            format!("publication-{index}"),
        ));
    }
    for (index, change) in journal.changes.iter().enumerate() {
        locations.push((
            false,
            sibling_stage(&change.path, &journal.id, &format!("referrer-{index}")),
            format!("referrer-{index}"),
        ));
        locations.push((
            false,
            sibling_stage(&change.path, &journal.id, &format!("publish-{index}")),
            format!("reference-publication-{index}"),
        ));
    }
    locations
}
