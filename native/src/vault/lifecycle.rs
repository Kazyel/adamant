use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use cap_fs_ext::DirExt;
use cap_std::{ambient_authority, fs::Dir};
use serde_json::Value;
use uuid::Uuid;

use super::capability::{private_dir, read_limited, sync_dir, verify_directory, write_new};
use super::indexing::{self, Inventory};
use super::metadata::manifest_validator;
use super::{Vault, VaultError, VaultParent, VaultResult, hash};

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

fn state_directory(root: &Path, state_root: &Path) -> VaultResult<PathBuf> {
    private_dir(state_root)?;
    let state_root = state_root.canonicalize()?;
    if state_root.starts_with(root) || root.starts_with(&state_root) {
        return Err(VaultError::invalid(
            "Choose a Vault outside Adamant's machine-local data directory.",
        ));
    }
    Ok(state_root)
}

impl VaultParent {
    pub fn select(root: &Path) -> VaultResult<Self> {
        if !fs::symlink_metadata(root)?.is_dir() {
            return Err(VaultError::invalid(
                "Choose a real folder, not a symbolic link.",
            ));
        }

        let root = root.canonicalize()?;
        if root.to_str().is_none() {
            return Err(VaultError::invalid(
                "The folder path must be valid Unicode.",
            ));
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
            || name
                .chars()
                .any(|c| c.is_control() || "/\\<>:\"|?*".contains(c))
            || matches!(name, "." | "..")
        {
            return Err(VaultError::invalid(
                "Use a single folder name, without path separators, special characters, or leading/trailing spaces.",
            ));
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
            return Err(VaultError::invalid(
                "The new folder is no longer empty. Its contents were kept; choose another name.",
            ));
        }

        dir.create_dir("content")?;
        let bytes = serde_json::to_vec_pretty(&serde_json::json!({ "format": "adamant-vault", "formatVersion": 1, "contentRoot": "content", "id": Uuid::new_v4().to_string(), "name": name })).map_err(|error| VaultError::invalid(error.to_string()))?;
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

    fn from_dir(vault_root: PathBuf, manifest_dir: Dir, state_root: PathBuf) -> VaultResult<Self> {
        verify_directory(&vault_root, &manifest_dir)?;
        let value = read_manifest(&manifest_dir)?;
        let content_root_relative = if value.get("contentRoot").is_some() {
            "content"
        } else {
            "."
        };
        let (root, dir) = if content_root_relative == "content" {
            let dir = manifest_dir.open_dir_nofollow("content").map_err(|error| {
                VaultError::invalid(format!(
                    "The Vault content folder is missing or unsafe: {error}"
                ))
            })?;
            let root = vault_root.join("content");
            verify_directory(&root, &dir)?;
            (root, dir)
        } else {
            (vault_root.clone(), manifest_dir.try_clone()?)
        };
        let id = Uuid::parse_str(value["id"].as_str().unwrap())
            .map_err(|error| VaultError::invalid(error.to_string()))?
            .to_string();
        let name = value["name"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                vault_root
                    .file_name()
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
            vault_root,
            manifest_dir,
            content_root_relative,
            id,
            name,
            state_dir,
            inventory: Mutex::new(Inventory::new()),
            body_index: Mutex::new(super::indexing::BodyIndex::new()),
            index_work: Mutex::new(()),
            identity_writes: Mutex::new(()),
        })
    }

    pub(super) fn ensure_current_manifest(&self) -> VaultResult<()> {
        verify_directory(&self.vault_root, &self.manifest_dir)?;
        if self.content_root_relative == "content" {
            verify_directory(&self.root, &self.dir)?;
        }
        let value = read_manifest(&self.manifest_dir)?;
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
        if value["contentRoot"].as_str().unwrap_or(".") != self.content_root_relative {
            return Err(VaultError::invalid(
                "The manifest content root changed externally. Close and reopen the Vault; no content or index was changed.",
            ));
        }
        Ok(())
    }
}
