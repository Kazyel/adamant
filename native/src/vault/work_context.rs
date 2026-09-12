use std::{
    collections::HashSet,
    io::{self, Write},
    path::Path,
};

use cap_std::fs::Dir;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{Vault, VaultError, VaultResult, capability, mutations, persistence};

const FILE: &str = "work-context.json";
const MAX_STATE_BYTES: usize = 32 * 1024 * 1024;
const MAX_REVISION: u64 = 9_007_199_254_740_991;
const MAX_TEXT: usize = 4096;
const MAX_BODY: usize = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Provider {
    Github,
    Jira,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ItemKind {
    Local,
    GithubIssue,
    GithubPr,
    Jira,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Priority {
    None,
    Low,
    Medium,
    High,
    Urgent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteRef {
    pub provider: Provider,
    pub host: String,
    pub scope: String,
    pub number: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChecklistEntry {
    pub id: String,
    pub text: String,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkLink {
    pub id: String,
    pub label: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkItem {
    pub id: String,
    pub kind: ItemKind,
    pub title: String,
    pub description: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub remote: Option<RemoteRef>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub url: Option<String>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub remote_state: Option<String>,
    pub assignee: String,
    pub labels: Vec<String>,
    pub priority: Priority,
    pub due_date: String,
    pub checklist: Vec<ChecklistEntry>,
    pub links: Vec<WorkLink>,
    pub updated_at: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub fetched_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkSource {
    pub id: String,
    pub connection_id: String,
    pub provider: Provider,
    pub host: String,
    pub scope: String,
    pub filter: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkView {
    pub mode: String,
    pub query: String,
    pub kind: String,
    pub priority: String,
    pub sort: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkColumn {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkMember {
    pub item_id: String,
    pub column_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkSpace {
    pub id: String,
    pub name: String,
    pub columns: Vec<WorkColumn>,
    pub members: Vec<WorkMember>,
    pub sources: Vec<WorkSource>,
    pub view: WorkView,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkDraft {
    pub item_id: String,
    pub kind: String,
    pub body: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkState {
    pub version: u32,
    pub vault_id: String,
    pub revision: u64,
    #[serde(deserialize_with = "Option::deserialize")]
    pub active_space_id: Option<String>,
    pub spaces: Vec<WorkSpace>,
    pub items: Vec<WorkItem>,
    pub drafts: Vec<WorkDraft>,
}

fn require(valid: bool, message: &str) -> VaultResult<()> {
    if valid {
        Ok(())
    } else {
        Err(VaultError::invalid(message))
    }
}

fn text(value: &str, limit: usize) -> bool {
    value.len() <= limit && !value.contains('\0')
}

fn identifier(value: &str) -> bool {
    !value.trim().is_empty() && text(value, 512) && !value.chars().any(char::is_control)
}

fn host(value: &str) -> bool {
    if value.is_empty() || value.len() > 2048 || !value.is_ascii() {
        return false;
    }
    reqwest::Url::parse(&format!("https://{value}/")).is_ok_and(|url| {
        url.host_str() == Some(value)
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
    })
}

fn web_url(value: &str) -> bool {
    text(value, 8192)
        && !value.chars().any(char::is_control)
        && reqwest::Url::parse(value).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
        })
}

fn date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(i, b)| i != 4 && i != 7 && !b.is_ascii_digit())
    {
        return false;
    }
    let year: u32 = value[..4].parse().unwrap_or(0);
    let month: u32 = value[5..7].parse().unwrap_or(0);
    let day: u32 = value[8..].parse().unwrap_or(0);
    let days = match month {
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    year > 0 && day > 0 && day <= days
}

fn timestamp(value: &str) -> bool {
    // Provider timestamps and JS ISO strings are kept verbatim, including timezone offsets.
    let bytes = value.as_bytes();
    if !value.is_ascii()
        || bytes.len() < 20
        || bytes.len() > 64
        || !date(&value[..10])
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return false;
    }
    let number = |part: &str, maximum: u32| {
        part.bytes().all(|b| b.is_ascii_digit())
            && part.parse::<u32>().is_ok_and(|number| number <= maximum)
    };
    if !number(&value[11..13], 23) || !number(&value[14..16], 59) || !number(&value[17..19], 60) {
        return false;
    }
    let mut zone = &value[19..];
    if let Some(fraction) = zone.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return false;
        }
        zone = &fraction[digits..];
    }
    zone == "Z"
        || (zone.len() == 6
            && matches!(zone.as_bytes()[0], b'+' | b'-')
            && zone.as_bytes()[3] == b':'
            && number(&zone[1..3], 23)
            && number(&zone[4..], 59))
        || (zone.len() == 5
            && matches!(zone.as_bytes()[0], b'+' | b'-')
            && number(&zone[1..3], 23)
            && number(&zone[3..], 59))
}

fn validate_item_origin(item: &WorkItem) -> VaultResult<()> {
    require(
        match (&item.kind, &item.remote) {
            (ItemKind::Local, None) => {
                item.url.is_none() && item.remote_state.is_none() && item.fetched_at.is_none()
            }
            (ItemKind::GithubIssue | ItemKind::GithubPr, Some(remote)) => {
                remote.provider == Provider::Github
            }
            (ItemKind::Jira, Some(remote)) => remote.provider == Provider::Jira,
            _ => false,
        },
        "Work item kind does not match its remote identity.",
    )?;
    if let Some(remote) = &item.remote {
        require(
            host(&remote.host)
                && !remote.scope.trim().is_empty()
                && text(&remote.scope, 1024)
                && !remote.number.trim().is_empty()
                && text(&remote.number, 256),
            "Invalid remote item identity.",
        )?;
    }
    Ok(())
}

impl WorkState {
    fn empty(vault_id: &str) -> Self {
        Self {
            version: 1,
            vault_id: vault_id.to_owned(),
            revision: 0,
            active_space_id: None,
            spaces: Vec::new(),
            items: Vec::new(),
            drafts: Vec::new(),
        }
    }

    fn validate(&self, vault_id: &str) -> VaultResult<()> {
        require(
            self.version == 1 && self.vault_id == vault_id && self.revision <= MAX_REVISION,
            "Work context has an unsupported version, invalid revision, or different Vault identity.",
        )?;
        require(
            self.items.len() <= 10_000 && self.spaces.len() <= 128 && self.drafts.len() <= 1000,
            "Work context exceeds its item, space, or draft limit.",
        )?;
        let mut items = HashSet::with_capacity(self.items.len());
        for item in &self.items {
            require(
                identifier(&item.id) && items.insert(item.id.as_str()),
                "Work item IDs must be valid and unique.",
            )?;
            require(
                !item.title.trim().is_empty()
                    && text(&item.title, MAX_TEXT)
                    && text(&item.description, MAX_BODY)
                    && text(&item.assignee, MAX_TEXT)
                    && item.labels.len() <= 256
                    && item.labels.iter().all(|label| text(label, MAX_TEXT))
                    && item.checklist.len() <= 1000
                    && item.links.len() <= 1000
                    && (item.due_date.is_empty() || date(&item.due_date))
                    && timestamp(&item.updated_at)
                    && item.fetched_at.as_deref().is_none_or(timestamp)
                    && item
                        .remote_state
                        .as_deref()
                        .is_none_or(|state| text(state, MAX_TEXT))
                    && item.url.as_deref().is_none_or(web_url),
                "Work item fields are invalid or exceed their limits.",
            )?;
            validate_item_origin(item)?;
            let mut checklist = HashSet::with_capacity(item.checklist.len());
            for entry in &item.checklist {
                require(
                    identifier(&entry.id)
                        && checklist.insert(entry.id.as_str())
                        && text(&entry.text, MAX_TEXT),
                    "Checklist entries must have unique IDs and bounded text.",
                )?;
            }
            let mut links = HashSet::with_capacity(item.links.len());
            for link in &item.links {
                require(
                    identifier(&link.id)
                        && links.insert(link.id.as_str())
                        && text(&link.label, MAX_TEXT)
                        && text(&link.target, 8192)
                        && (web_url(&link.target)
                            || (!link.target.contains([':', '\\'])
                                && capability::relative(&link.target).is_ok())),
                    "Links must have unique IDs and target a portable Vault path or credential-free HTTP(S) URL.",
                )?;
            }
        }
        let mut spaces = HashSet::with_capacity(self.spaces.len());
        for space in &self.spaces {
            require(
                identifier(&space.id)
                    && spaces.insert(space.id.as_str())
                    && !space.name.trim().is_empty()
                    && text(&space.name, MAX_TEXT)
                    && !space.columns.is_empty()
                    && space.columns.len() <= 64
                    && space.members.len() <= 10_000
                    && space.sources.len() <= 256,
                "Space IDs, names, or collection limits are invalid.",
            )?;
            let mut columns = HashSet::with_capacity(space.columns.len());
            for column in &space.columns {
                require(
                    identifier(&column.id)
                        && columns.insert(column.id.as_str())
                        && !column.name.trim().is_empty()
                        && text(&column.name, MAX_TEXT),
                    "Columns require unique IDs and nonempty bounded names.",
                )?;
            }
            let mut members = HashSet::with_capacity(space.members.len());
            for member in &space.members {
                require(
                    items.contains(member.item_id.as_str())
                        && columns.contains(member.column_id.as_str())
                        && members.insert(member.item_id.as_str()),
                    "Space membership references a missing item/column or repeats an item.",
                )?;
            }
            let mut sources = HashSet::with_capacity(space.sources.len());
            for source in &space.sources {
                require(
                    identifier(&source.id)
                        && sources.insert(source.id.as_str())
                        && identifier(&source.connection_id)
                        && host(&source.host)
                        && !source.scope.trim().is_empty()
                        && text(&source.scope, 1024)
                        && text(&source.filter, MAX_TEXT),
                    "Space source fields are invalid or exceed their limits.",
                )?;
            }
            let view = &space.view;
            require(
                matches!(view.mode.as_str(), "list" | "board")
                    && text(&view.query, MAX_TEXT)
                    && matches!(
                        view.kind.as_str(),
                        "all" | "local" | "github-issue" | "github-pr" | "jira"
                    )
                    && matches!(
                        view.priority.as_str(),
                        "all" | "none" | "low" | "medium" | "high" | "urgent"
                    )
                    && matches!(
                        view.sort.as_str(),
                        "manual" | "updated" | "priority" | "due"
                    ),
                "Space view is invalid.",
            )?;
        }
        require(
            self.active_space_id
                .as_deref()
                .is_none_or(|id| spaces.contains(id)),
            "Active space does not exist.",
        )?;
        let mut drafts = HashSet::with_capacity(self.drafts.len());
        for draft in &self.drafts {
            require(
                items.contains(draft.item_id.as_str())
                    && matches!(draft.kind.as_str(), "comment" | "review")
                    && drafts.insert((draft.item_id.as_str(), draft.kind.as_str()))
                    && text(&draft.body, MAX_BODY)
                    && timestamp(&draft.updated_at),
                "Drafts require existing items, unique kinds, and valid bounded fields.",
            )?;
        }
        Ok(())
    }
}

struct BoundedBytes(Vec<u8>);

impl Write for BoundedBytes {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_STATE_BYTES.saturating_sub(self.0.len()) {
            return Err(io::Error::other("Work context exceeds 32 MiB."));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn read_state(dir: &Dir, vault_id: &str) -> VaultResult<Option<(WorkState, Vec<u8>)>> {
    match dir.symlink_metadata(FILE) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let bytes = capability::read_limited(dir, Path::new(FILE), MAX_STATE_BYTES as u64)?;
    let state: WorkState = serde_json::from_slice(&bytes).map_err(|_| VaultError::invalid(
        "Work context JSON is malformed or contains unsupported fields. The file was not changed."))?;
    state.validate(vault_id)?;
    Ok(Some((state, bytes)))
}

impl Vault {
    fn work_authority(&self, vault_id: &str) -> VaultResult<()> {
        require(
            vault_id == self.id,
            "Work context belongs to a different Vault. Reopen it before continuing.",
        )?;
        self.ensure_current_manifest()
    }

    pub(crate) fn load_work(&self, vault_id: &str) -> VaultResult<WorkState> {
        self.work_authority(vault_id)?;
        let Some(dir) = mutations::existing_admin_dir(self)? else {
            return Ok(WorkState::empty(vault_id));
        };
        let loaded = read_state(&dir, vault_id)?;
        self.work_authority(vault_id)?;
        capability::verify_directory(&self.vault_root.join(".adamant"), &dir)?;
        Ok(loaded.map_or_else(|| WorkState::empty(vault_id), |(state, _)| state))
    }

    pub(crate) fn save_work(
        &self,
        vault_id: &str,
        mut state: WorkState,
        expected_revision: u64,
    ) -> VaultResult<WorkState> {
        self.work_authority(vault_id)?;
        state.validate(vault_id)?;
        if state.revision != expected_revision || expected_revision >= MAX_REVISION {
            return Err(VaultError::conflict(
                "Work context revision is stale or exhausted. Reload before saving.",
                None,
            ));
        }
        state.revision += 1;
        let mut bytes = BoundedBytes(Vec::new());
        serde_json::to_writer(&mut bytes, &state)
            .map_err(|_| VaultError::invalid("Work context exceeds the 32 MiB storage limit."))?;
        let dir = mutations::admin_dir(self)?;
        // The immutable ownership marker coordinates independent Vault handles/processes. Kernel
        // locks disappear on crash; no stale lock-file removal or ambient path grants are needed.
        let lock = capability::open_regular(&dir, Path::new("marker"))?.into_std();
        lock.try_lock().map_err(|error| match error {
            std::fs::TryLockError::WouldBlock => VaultError::conflict(
                "Another work-context save is active. Retry after it completes.",
                None,
            ),
            std::fs::TryLockError::Error(error) => {
                VaultError::io(format!("Work-context storage could not be locked: {error}"))
            }
        })?;
        let previous = read_state(&dir, vault_id)?;
        if previous.as_ref().map_or(0, |(state, _)| state.revision) != expected_revision {
            return Err(VaultError::conflict(
                "Work context changed on disk. Reload before saving; nothing was overwritten.",
                None,
            ));
        }
        let staging = format!(".adamant-write-work-{}.json", Uuid::new_v4());
        capability::write_new(&dir, Path::new(&staging), &bytes.0)?;
        let result = (|| {
            self.work_authority(vault_id)?;
            capability::verify_directory(&self.vault_root.join(".adamant"), &dir)?;
            match &previous {
                None => {
                    // Creation must never replace a file that appeared after the absent read.
                    dir.hard_link(&staging, &dir, FILE).map_err(|error| {
                        if error.kind() == io::ErrorKind::AlreadyExists {
                            VaultError::conflict(
                                "Work context was created elsewhere. Reload before saving.",
                                None,
                            )
                        } else {
                            error.into()
                        }
                    })?;
                    capability::sync_dir(&dir)?;
                }
                Some((_, original)) => {
                    let current =
                        capability::read_limited(&dir, Path::new(FILE), MAX_STATE_BYTES as u64)?;
                    if current != *original {
                        return Err(VaultError::conflict(
                            "Work context changed during save. Reload before saving.",
                            None,
                        ));
                    }
                    persistence::exchange(&dir, &staging, Path::new(FILE))?;
                    capability::sync_dir(&dir)?;
                    let displaced =
                        capability::read_limited(&dir, Path::new(&staging), MAX_STATE_BYTES as u64);
                    if !displaced.as_ref().is_ok_and(|value| value == original) {
                        // Keep both versions. A second exchange after a content check would
                        // race another external writer and could replace its newer current file.
                        return Err(VaultError::conflict(
                            format!(
                                "An external writer raced the save. Recovery bytes remain in .adamant/{staging}; reload before saving."
                            ),
                            None,
                        ));
                    }
                }
            }
            dir.remove_file(&staging)?;
            capability::sync_dir(&dir)?;
            Ok(())
        })();
        // On an error, keep staging rather than deleting a potentially displaced authored file.
        result?;
        Ok(state)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::os::unix::fs::symlink;

    use super::*;

    fn work_fixture() -> (tempfile::TempDir, Vault, WorkState) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        fs::create_dir(&root).unwrap();
        let id = Uuid::new_v4().to_string();
        fs::write(
            root.join("vault.json"),
            serde_json::json!({
                "format": "adamant-vault", "formatVersion": 1, "id": id,
            })
            .to_string(),
        )
        .unwrap();
        let vault = Vault::open(&root, &temp.path().join("machine")).unwrap();
        let mut state = vault.load_work(&id).unwrap();
        state.items.push(serde_json::from_value(serde_json::json!({
            "id": "local:task", "kind": "local", "title": "Keep authored work", "description": "Notes",
            "remote": null, "url": null, "remoteState": null, "assignee": "", "labels": ["planning"],
            "priority": "high", "dueDate": "2028-02-29",
            "checklist": [{"id": "check", "text": "Preserve", "done": false}],
            "links": [{"id": "note", "label": "Context", "target": "notes/context.md"}],
            "updatedAt": "2026-09-12T12:00:00.000Z", "fetchedAt": null
        })).unwrap());
        for (space, column) in [("project-a", "doing"), ("project-b", "later")] {
            state.spaces.push(serde_json::from_value(serde_json::json!({
                "id": space, "name": space, "columns": [{"id": column, "name": column}],
                "members": [{"itemId": "local:task", "columnId": column}],
                "sources": [{"id": "source", "connectionId": "github:account", "provider": "github",
                    "host": "github.com", "scope": "owner/repo", "filter": "is:open"}],
                "view": {"mode": "board", "query": "authored", "kind": "all", "priority": "high", "sort": "manual"}
            })).unwrap());
        }
        state.active_space_id = Some("project-b".into());
        state.drafts.push(WorkDraft {
            item_id: "local:task".into(),
            kind: "comment".into(),
            body: "Unsent work".into(),
            updated_at: "2026-09-12T12:00:00+00:00".into(),
        });
        (temp, vault, state)
    }

    #[test]
    fn work_storage_confines_identity_rejects_stale_and_preserves_malformed_source() {
        let (temp, vault, state) = work_fixture();
        let id = state.vault_id.clone();
        let root = temp.path().join("vault");
        assert!(vault.load_work(&Uuid::new_v4().to_string()).is_err());
        let first = vault.save_work(&id, state.clone(), 0).unwrap();
        let saved = vault.save_work(&id, first.clone(), 1).unwrap();
        let reopened = Vault::open(&root, &temp.path().join("other-machine")).unwrap();
        assert_eq!(saved.revision, 2);
        assert_eq!(
            serde_json::to_value(reopened.load_work(&id).unwrap()).unwrap(),
            serde_json::to_value(&saved).unwrap()
        );
        let source = root.join(".adamant").join(FILE);
        let bytes = fs::read(&source).unwrap();
        assert_eq!(
            reopened.save_work(&id, first, 1).unwrap_err().kind,
            "conflict"
        );
        assert_eq!(fs::read(&source).unwrap(), bytes);

        let mut wrong = saved.clone();
        wrong.vault_id = Uuid::new_v4().to_string();
        assert!(vault.save_work(&id, wrong, 2).is_err());
        assert_eq!(fs::read(&source).unwrap(), bytes);
        let mut credentials = serde_json::to_value(&saved).unwrap();
        credentials["token"] = serde_json::json!("must-not-be-adopted");
        let malformed = serde_json::to_vec(&credentials).unwrap();
        fs::write(&source, &malformed).unwrap();
        assert!(vault.load_work(&id).is_err());
        assert!(vault.save_work(&id, saved.clone(), 2).is_err());
        assert_eq!(fs::read(&source).unwrap(), malformed);
    }

    #[test]
    fn work_storage_rejects_symlinked_state_and_admin_directory() {
        let (temp, vault, state) = work_fixture();
        let id = state.vault_id.clone();
        let root = temp.path().join("vault");
        let first = vault.save_work(&id, state, 0).unwrap();
        let saved = vault.save_work(&id, first, 1).unwrap();
        let source = root.join(".adamant").join(FILE);
        let bytes = fs::read(&source).unwrap();

        let outside = temp.path().join("outside.json");
        fs::write(&outside, &bytes).unwrap();
        fs::remove_file(&source).unwrap();
        symlink(&outside, &source).unwrap();
        assert!(vault.load_work(&id).is_err());
        assert!(vault.save_work(&id, saved.clone(), 2).is_err());
        assert_eq!(fs::read(&outside).unwrap(), bytes);
        fs::remove_file(&source).unwrap();
        let moved = temp.path().join("moved-admin");
        fs::rename(root.join(".adamant"), &moved).unwrap();
        symlink(&moved, root.join(".adamant")).unwrap();
        assert!(vault.load_work(&id).is_err());
        assert!(vault.save_work(&id, saved, 2).is_err());
        assert!(!moved.join(FILE).exists());
    }
}
