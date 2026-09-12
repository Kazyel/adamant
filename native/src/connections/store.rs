use std::{
    io::{Read, Write},
    path::Path,
    sync::Mutex,
};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};

use super::models::{Connection, RemoteDetail, RemoteRef};

const MAX_METADATA: u64 = 256 * 1024;
const MAX_DETAIL: usize = 2 * 1024 * 1024;
const MAX_CACHE: u64 = 32 * 1024 * 1024 + 64 * 1024;
const MAX_ENTRIES: usize = 16;
// ponytail: one short app-local storage lock; split by file only if contention is measured.
static STORAGE: Mutex<()> = Mutex::new(());

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredConnection {
    pub connection: Connection,
    pub account_id: String,
    pub email: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct CachedDetail {
    connection_id: String,
    remote: RemoteRef,
    detail: RemoteDetail,
}

pub(super) fn connection_id(provider: &str, host: &str, account: &str) -> String {
    use std::fmt::Write as _;

    let digest = Sha256::new()
        .chain_update(host)
        .chain_update([0])
        .chain_update(account)
        .finalize();
    let mut id = String::with_capacity(provider.len() + 65);
    id.push_str(provider);
    id.push(':');
    for byte in digest {
        write!(&mut id, "{byte:02x}").expect("Writing to a String cannot fail");
    }
    id
}

fn directory(app_data: &Path) -> Result<Dir, String> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(app_data)
        .map_err(|_| "App-local connection storage is unavailable.")?;
    if std::fs::symlink_metadata(app_data)
        .map_err(|_| "Connection storage is unavailable.")?
        .file_type()
        .is_symlink()
    {
        return Err("Connection storage must not be a symbolic link.".into());
    }
    let root = Dir::open_ambient_dir(app_data, ambient_authority())
        .map_err(|_| "Connection storage is unavailable.")?;
    match root.create_dir("connections") {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err("Could not create app-local connection storage.".into()),
    }
    let dir = root
        .open_dir_nofollow("connections")
        .map_err(|_| "Connection storage must be a real directory.")?;
    #[cfg(unix)]
    {
        use cap_std::fs::PermissionsExt;
        dir.set_permissions(".", cap_std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not protect app-local connection storage.")?;
    }
    Ok(dir)
}

fn read_json<T: DeserializeOwned + Default>(
    dir: &Dir,
    name: &str,
    limit: u64,
) -> Result<T, String> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
    }
    let file = match dir.open_with(name, &options) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(T::default()),
        Err(_) => return Err("Could not safely read app-local connection data.".into()),
    };
    let metadata = file
        .metadata()
        .map_err(|_| "Could not inspect connection data.")?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(
            "App-local connection data exceeds its safe size limit or is not a regular file."
                .into(),
        );
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read connection data.")?;
    if bytes.len() as u64 > limit {
        return Err("App-local connection data exceeds its size limit.".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "App-local connection data is invalid; it has not been overwritten.".into())
}

fn write_json<T: Serialize>(dir: &Dir, name: &str, value: &T, limit: u64) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "Could not encode connection data.")?;
    if bytes.len() as u64 > limit {
        return Err("App-local connection data exceeds its size limit.".into());
    }
    let temp = format!(".{name}.{}.tmp", uuid::Uuid::new_v4());
    let result = (|| {
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
        let mut file = dir.open_with(&temp, &options)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        dir.rename(&temp, dir, name)?;
        #[cfg(unix)]
        dir.open(".")?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = dir.remove_file(&temp);
    }
    result.map_err(|_: std::io::Error| "Could not durably save app-local connection data.".into())
}

fn valid_connection(record: &StoredConnection) -> bool {
    let value = &record.connection;
    let valid_host = match value.provider.as_str() {
        "github" => {
            value.host == "github.com" && record.account_id.parse::<u64>().is_ok_and(|id| id > 0)
        }
        "jira" => {
            super::jira_host(&value.host).is_ok_and(|host| host == value.host)
                && record
                    .email
                    .as_ref()
                    .is_some_and(|email| super::validate_email(email).is_ok())
        }
        _ => false,
    };
    valid_host
        && !record.account_id.is_empty()
        && record.account_id.len() <= 512
        && !record.account_id.chars().any(char::is_control)
        && !value.account.is_empty()
        && value.account.len() <= 1024
        && value.id == connection_id(&value.provider, &value.host, &record.account_id)
}

fn records(dir: &Dir) -> Result<Vec<StoredConnection>, String> {
    let rows: Vec<StoredConnection> = read_json(dir, "accounts.json", MAX_METADATA)?;
    if rows.len() > 64 || rows.iter().any(|record| !valid_connection(record)) {
        return Err(
            "Saved connection metadata is invalid. Reconnect the account in Connections.".into(),
        );
    }
    Ok(rows)
}

pub(super) fn connections(app_data: &Path) -> Result<Vec<StoredConnection>, String> {
    let _guard = STORAGE
        .lock()
        .map_err(|_| "Connection storage is busy after an error.")?;
    records(&directory(app_data)?)
}

pub(super) fn save_connection(app_data: &Path, record: StoredConnection) -> Result<(), String> {
    let _guard = STORAGE
        .lock()
        .map_err(|_| "Connection storage is busy after an error.")?;
    if !valid_connection(&record) {
        return Err("The service returned an invalid account identity.".into());
    }
    let dir = directory(app_data)?;
    let mut rows = records(&dir)?;
    rows.retain(|row| row.connection.id != record.connection.id);
    if rows.len() >= 64 {
        return Err("The 64 saved connection limit has been reached.".into());
    }
    rows.push(record);
    write_json(&dir, "accounts.json", &rows, MAX_METADATA)
}

fn matches(entry: &CachedDetail, connection_id: &str, remote: &RemoteRef) -> bool {
    let same = |value: &RemoteRef| {
        value.provider == remote.provider
            && value.host == remote.host
            && value.scope == remote.scope
            && value.number == remote.number
    };
    entry.connection_id == connection_id
        && (same(&entry.remote) || entry.detail.item.remote.as_ref().is_some_and(same))
}

pub(super) fn cached(
    app_data: &Path,
    connection_id: &str,
    remote: &RemoteRef,
) -> Result<Option<RemoteDetail>, String> {
    let _guard = STORAGE
        .lock()
        .map_err(|_| "Connection storage is busy after an error.")?;
    let rows: Vec<CachedDetail> = read_json(&directory(app_data)?, "details.json", MAX_CACHE)?;
    if rows.len() > MAX_ENTRIES {
        return Err("The detail cache exceeds its entry limit.".into());
    }
    Ok(rows
        .into_iter()
        .find(|row| matches(row, connection_id, remote))
        .map(|row| row.detail))
}

pub(super) fn save_detail(
    app_data: &Path,
    connection_id: &str,
    remote: &RemoteRef,
    detail: &RemoteDetail,
) -> Result<(), String> {
    if serde_json::to_vec(detail)
        .map_err(|_| "Could not encode remote detail.")?
        .len()
        > MAX_DETAIL
    {
        return Err("This detail exceeds the 2 MiB offline cache limit; the live result is still available.".into());
    }
    let _guard = STORAGE
        .lock()
        .map_err(|_| "Connection storage is busy after an error.")?;
    let dir = directory(app_data)?;
    let mut rows: Vec<CachedDetail> = read_json(&dir, "details.json", MAX_CACHE)?;
    rows.retain(|row| {
        !matches(row, connection_id, remote)
            && !(row.connection_id == connection_id && row.detail.item.id == detail.item.id)
    });
    if rows.len() >= MAX_ENTRIES {
        rows.drain(..rows.len() - MAX_ENTRIES + 1);
    }
    rows.push(CachedDetail {
        connection_id: connection_id.into(),
        remote: remote.clone(),
        detail: detail.clone(),
    });
    write_json(&dir, "details.json", &rows, MAX_CACHE)
}

pub(super) fn invalidate(
    app_data: &Path,
    connection_id: &str,
    remote: &RemoteRef,
) -> Result<(), String> {
    let _guard = STORAGE
        .lock()
        .map_err(|_| "Connection storage is busy after an error.")?;
    let dir = directory(app_data)?;
    let mut rows: Vec<CachedDetail> = read_json(&dir, "details.json", MAX_CACHE)?;
    rows.retain(|row| !matches(row, connection_id, remote));
    write_json(&dir, "details.json", &rows, MAX_CACHE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn detail(number: usize) -> RemoteDetail {
        serde_json::from_value(json!({
            "item": { "id": format!("jira:team.atlassian.net:{number}"), "kind": "jira", "title": "Remote work",
                "description": "Cached discussion", "remote": { "provider": "jira", "host": "team.atlassian.net", "scope": "TEAM", "number": number.to_string() },
                "url": format!("https://team.atlassian.net/browse/TEAM-{number}"), "remoteState": "Open", "assignee": "", "labels": [],
                "priority": "none", "dueDate": "", "checklist": [], "links": [], "updatedAt": "2026-09-12T00:00:00Z", "fetchedAt": "2026-09-12T01:00:00Z" },
            "comments": [], "commits": [], "checks": [], "files": [], "transitions": [], "priorities": [],
            "actions": ["comment"], "editableFields": [], "headSha": null, "partial": false, "stale": false, "warnings": []
        })).unwrap()
    }

    #[test]
    fn cache_is_account_isolated_and_invalidates_manual_key_aliases() {
        let temp = tempfile::tempdir().unwrap();
        let value = detail(1);
        let canonical = value.item.remote.as_ref().unwrap();
        let mut manual = canonical.clone();
        manual.number = "TEAM-1".into();
        save_detail(temp.path(), "account-a", &manual, &value).unwrap();
        assert_eq!(
            cached(temp.path(), "account-a", canonical)
                .unwrap()
                .unwrap()
                .item
                .id,
            value.item.id
        );
        assert!(
            cached(temp.path(), "account-b", canonical)
                .unwrap()
                .is_none()
        );
        invalidate(temp.path(), "account-a", canonical).unwrap();
        assert!(cached(temp.path(), "account-a", &manual).unwrap().is_none());
    }

    #[test]
    fn cache_evicts_oldest_details_and_rejects_oversize_without_losing_the_latest() {
        let temp = tempfile::tempdir().unwrap();
        for number in 1..=MAX_ENTRIES + 1 {
            let value = detail(number);
            save_detail(
                temp.path(),
                "account-a",
                value.item.remote.as_ref().unwrap(),
                &value,
            )
            .unwrap();
        }
        assert!(
            cached(
                temp.path(),
                "account-a",
                detail(1).item.remote.as_ref().unwrap()
            )
            .unwrap()
            .is_none()
        );
        let mut latest = detail(MAX_ENTRIES + 1);
        let remote = latest.item.remote.clone().unwrap();
        latest.item.description = "x".repeat(MAX_DETAIL);
        assert!(save_detail(temp.path(), "account-a", &remote, &latest).is_err());
        assert_eq!(
            cached(temp.path(), "account-a", &remote)
                .unwrap()
                .unwrap()
                .item
                .description,
            "Cached discussion"
        );
    }

    #[cfg(unix)]
    #[test]
    fn account_metadata_never_follows_a_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        directory(temp.path()).unwrap();
        std::os::unix::fs::symlink(
            outside.path(),
            temp.path().join("connections/accounts.json"),
        )
        .unwrap();
        assert!(connections(temp.path()).is_err());
    }
}
