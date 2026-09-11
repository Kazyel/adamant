use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const VERSION: u32 = 1;
const MAX_STATE: u64 = 2 * 1024 * 1024;
const MAX_TABS: usize = 64;
const MAX_DRAFTS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTab {
    pub id: String,
    pub kind: String,
    pub path: String,
    pub name: String,
    pub source_path: Option<String>,
    pub source_kind: String,
    pub identity: Option<String>,
    pub base_revision: Option<String>,
    pub view: String,
    pub show_original: bool,
    pub page: u32,
    pub zoom: f64,
    pub line: u32,
    pub column: u32,
    #[serde(default)]
    pub scroll_top: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryLocation {
    pub path: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
    #[serde(default)]
    pub identity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceNavigation {
    pub recent: Vec<String>,
    pub favorites: Vec<String>,
    pub history: Vec<HistoryLocation>,
    pub history_index: i32,
    pub expanded: Vec<String>,
    #[serde(default)]
    pub identities: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub favorite_identities: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    pub version: u32,
    pub root: String,
    pub vault_id: String,
    #[serde(default)]
    pub navigation: Option<WorkspaceNavigation>,
    pub active_id: Option<String>,
    pub tabs: Vec<WorkspaceTab>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftRecord {
    pub id: String,
    pub root: String,
    pub vault_id: String,
    pub path: String,
    pub identity: Option<String>,
    pub base_revision: Option<String>,
    pub text: String,
    pub saved_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DraftFile {
    version: u32,
    root: String,
    vault_id: String,
    drafts: Vec<DraftRecord>,
}

fn read_bounded(path: &Path) -> io::Result<Vec<u8>> {
    let file = File::open(path)?;
    let mut bytes = Vec::new();
    file.take(MAX_STATE + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_STATE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "stored workspace data exceeds limit",
        ));
    }
    Ok(bytes)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if bytes.len() as u64 > MAX_STATE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "workspace state exceeds limit",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "storage path has no parent"))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "storage filename is invalid")
        })?;
    let tmp = parent.join(format!(".{name}.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, path)?;
        File::open(parent)?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn key(vault_id: &str, root: &Path) -> String {
    crate::vault::hash(format!("{}\0{}", vault_id, root.to_string_lossy()).as_bytes())
}

fn scope(vault_id: &str, root: &Path) -> (String, String) {
    (vault_id.to_owned(), root.to_string_lossy().into_owned())
}

fn workspace_path(app_data: &Path, vault_id: &str, root: &Path) -> PathBuf {
    app_data
        .join("workspaces")
        .join(format!("{}.json", key(vault_id, root)))
}

fn drafts_path(app_data: &Path, vault_id: &str, root: &Path) -> PathBuf {
    app_data
        .join("drafts")
        .join(format!("{}.json", key(vault_id, root)))
}

fn valid_tab(tab: &WorkspaceTab) -> bool {
    matches!(tab.kind.as_str(), "markdown" | "pdf" | "docx")
        && !tab.id.is_empty()
        && match tab.source_kind.as_str() {
            "vault" => super::capability::relative(&tab.path).is_ok(),
            "standalone" => Path::new(&tab.path).is_absolute(),
            "untitled" => tab.kind == "markdown" && tab.path.is_empty(),
            _ => false,
        }
        && matches!(tab.view.as_str(), "edit" | "read" | "split")
        && tab.zoom.is_finite()
        && tab.zoom > 0.0
        && tab.page > 0
        && tab.line > 0
        && tab.column > 0
        && tab.identity.as_ref().is_none_or(|id| !id.is_empty())
        && tab.scroll_top.is_finite()
        && tab.scroll_top >= 0.0
}

fn valid_workspace(state: &WorkspaceState) -> bool {
    let ids: std::collections::HashSet<_> = state.tabs.iter().map(|tab| &tab.id).collect();
    state.tabs.len() <= MAX_TABS
        && ids.len() == state.tabs.len()
        && state.tabs.iter().all(valid_tab)
        && state.active_id.as_ref().is_none_or(|id| ids.contains(id))
        && state.navigation.as_ref().is_none_or(|navigation| {
            navigation.recent.len() <= 100
                && navigation.favorites.len() <= 100
                && navigation.history.len() <= 100
                && navigation.expanded.len() <= 100
                && navigation.identities.len() <= 400
                && navigation.favorite_identities.len() <= 100
                && navigation
                    .identities
                    .iter()
                    .chain(navigation.favorite_identities.iter())
                    .all(|(path, identity)| !path.is_empty() && !identity.is_empty())
                && navigation.history_index >= -1
                && navigation.history_index < navigation.history.len() as i32
        })
}

fn preserve_invalid(path: &Path, check: io::Result<()>) -> io::Result<Option<String>> {
    match check {
        Ok(()) => return Ok(None),
        Err(error) if error.kind() == io::ErrorKind::InvalidData => {}
        Err(error) => return Err(error),
    }
    let (parent, name) = super::navigation::retained_parent(path)
        .map_err(|error| io::Error::other(error.message))?;
    if !parent.symlink_metadata(&name)?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Local storage is not a regular file; no content was changed.",
        ));
    }
    let backup = format!("{}.preserved-{}", name.to_string_lossy(), Uuid::new_v4());
    rustix::fs::renameat_with(
        &parent,
        &name,
        &parent,
        &backup,
        rustix::fs::RenameFlags::NOREPLACE,
    )?;
    super::capability::sync_dir(&parent).map_err(|error| io::Error::other(error.message))?;
    Ok(Some(
        path.with_file_name(backup).to_string_lossy().into_owned(),
    ))
}

impl super::Vault {
    pub fn repair_workspace_storage(&self, app_data: &Path) -> io::Result<Vec<String>> {
        let mut backups = Vec::new();
        let state = self.load_workspace(app_data).map(|_| ());
        if let Some(path) =
            preserve_invalid(&workspace_path(app_data, &self.id, &self.vault_root), state)?
        {
            backups.push(path);
        }
        let drafts = self.load_drafts(app_data).map(|_| ());
        if let Some(path) =
            preserve_invalid(&drafts_path(app_data, &self.id, &self.vault_root), drafts)?
        {
            backups.push(path);
        }
        Ok(backups)
    }

    pub fn load_workspace(&self, app_data: &Path) -> io::Result<Option<WorkspaceState>> {
        let path = workspace_path(app_data, &self.id, &self.vault_root);
        let bytes = match read_bounded(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let state: WorkspaceState = serde_json::from_slice(&bytes).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("workspace state is malformed: {error}"),
            )
        })?;
        let (vault_id, root) = scope(&self.id, &self.vault_root);
        if state.version != VERSION
            || state.vault_id != vault_id
            || state.root != root
            || !valid_workspace(&state)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "workspace state scope or tab limit is invalid",
            ));
        }
        Ok(Some(state))
    }

    pub fn save_workspace(&self, app_data: &Path, state: &WorkspaceState) -> io::Result<()> {
        let (vault_id, root) = scope(&self.id, &self.vault_root);
        if state.version != VERSION
            || state.vault_id != vault_id
            || state.root != root
            || !valid_workspace(state)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "workspace scope mismatch or tab limit exceeded",
            ));
        }
        let dir = app_data.join("workspaces");
        fs::create_dir_all(&dir)?;
        let bytes = serde_json::to_vec(state).map_err(io::Error::other)?;
        atomic_write(
            &workspace_path(app_data, &self.id, &self.vault_root),
            &bytes,
        )
    }

    pub fn load_drafts(&self, app_data: &Path) -> io::Result<Vec<DraftRecord>> {
        let path = drafts_path(app_data, &self.id, &self.vault_root);
        let bytes = match read_bounded(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let file: DraftFile = serde_json::from_slice(&bytes).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("draft storage is malformed: {error}"),
            )
        })?;
        let (vault_id, root) = scope(&self.id, &self.vault_root);
        if file.version != VERSION
            || file.vault_id != vault_id
            || file.root != root
            || file.drafts.len() > MAX_DRAFTS
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "draft storage scope or limit is invalid",
            ));
        }
        let ids: std::collections::HashSet<_> = file.drafts.iter().map(|draft| &draft.id).collect();
        if ids.len() != file.drafts.len()
            || file.drafts.iter().any(|draft| {
                draft.id.is_empty() || draft.vault_id != vault_id || draft.root != root
            })
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "draft storage contains another Vault",
            ));
        }
        Ok(file.drafts)
    }

    pub fn save_draft(&self, app_data: &Path, draft: DraftRecord) -> io::Result<()> {
        let (vault_id, root) = scope(&self.id, &self.vault_root);
        if draft.id.is_empty()
            || draft.vault_id != vault_id
            || draft.root != root
            || draft.text.len() as u64 > MAX_STATE
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "draft scope or size is invalid",
            ));
        }
        let mut drafts = self.load_drafts(app_data)?;
        if let Some(existing) = drafts.iter_mut().find(|existing| existing.id == draft.id) {
            *existing = draft;
        } else if drafts.len() >= MAX_DRAFTS {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "draft limit exceeded; discard an old draft first",
            ));
        } else {
            drafts.push(draft);
        }
        let file = DraftFile {
            version: VERSION,
            root,
            vault_id,
            drafts,
        };
        let bytes = serde_json::to_vec(&file).map_err(io::Error::other)?;
        let dir = app_data.join("drafts");
        fs::create_dir_all(&dir)?;
        atomic_write(&drafts_path(app_data, &self.id, &self.vault_root), &bytes)
    }

    pub fn delete_draft(&self, app_data: &Path, id: &str) -> io::Result<()> {
        if id.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "draft id is required",
            ));
        }
        let (vault_id, root) = scope(&self.id, &self.vault_root);
        let mut drafts = self.load_drafts(app_data)?;
        drafts.retain(|draft| draft.id != id);
        let file = DraftFile {
            version: VERSION,
            root,
            vault_id,
            drafts,
        };
        let bytes = serde_json::to_vec(&file).map_err(io::Error::other)?;
        let dir = app_data.join("drafts");
        fs::create_dir_all(&dir)?;
        atomic_write(&drafts_path(app_data, &self.id, &self.vault_root), &bytes)
    }
}

pub fn load_preferences(app_data: &Path) -> io::Result<Option<serde_json::Value>> {
    let path = app_data.join("preferences.json");
    let bytes = match read_bounded(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    serde_json::from_slice(&bytes).map(Some).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("preferences are malformed: {error}"),
        )
    })
}

pub fn save_preferences(app_data: &Path, value: &serde_json::Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    fs::create_dir_all(app_data)?;
    atomic_write(&app_data.join("preferences.json"), &bytes)
}

pub(crate) fn load_last_document(app_data: &Path) -> super::VaultResult<Option<WorkspaceTab>> {
    use cap_std::{ambient_authority, fs::Dir};
    let dir = match Dir::open_ambient_dir(app_data, ambient_authority()) {
        Ok(dir) => dir,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let path = Path::new("last-document.json");
    match dir.symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let bytes = super::capability::read_limited(&dir, path, MAX_STATE)?;
    let tab: Option<WorkspaceTab> = serde_json::from_slice(&bytes).map_err(|error| {
        super::VaultError::invalid(format!("The last document record is invalid: {error}"))
    })?;
    if tab.as_ref().is_some_and(|tab| {
        !valid_tab(tab) || tab.source_kind != "standalone" || tab.identity.is_none()
    }) {
        return Err(super::VaultError::invalid(
            "The last document record is invalid.",
        ));
    }
    Ok(tab)
}

pub(crate) fn save_last_document(
    app_data: &Path,
    tab: Option<&WorkspaceTab>,
) -> super::VaultResult<()> {
    if tab.is_some_and(|tab| {
        !valid_tab(tab) || tab.source_kind != "standalone" || tab.identity.is_none()
    }) {
        return Err(super::VaultError::invalid(
            "Only an identified standalone file can be remembered.",
        ));
    }
    let bytes =
        serde_json::to_vec(&tab).map_err(|error| super::VaultError::invalid(error.to_string()))?;
    super::capability::private_dir(app_data)?;
    atomic_write(&app_data.join("last-document.json"), &bytes)?;
    Ok(())
}
