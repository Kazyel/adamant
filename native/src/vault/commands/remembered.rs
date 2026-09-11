use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
};

use cap_std::{ambient_authority, fs::Dir};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::vault::{
    Vault, VaultError, VaultResult,
    capability::{private_dir, read_limited, write_new},
};

const RECORD: &str = "last-vault.json";
const MAX_RECORD_BYTES: u64 = 64 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RememberedVault {
    root: PathBuf,
    id: String,
}

impl RememberedVault {
    pub(super) fn read(data: &Path) -> VaultResult<Option<Self>> {
        let dir = match Dir::open_ambient_dir(data, ambient_authority()) {
            Ok(dir) => dir,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        match dir.symlink_metadata(RECORD) {
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        }
        let bytes = read_limited(&dir, Path::new(RECORD), MAX_RECORD_BYTES)?;
        let record: Self = serde_json::from_slice(&bytes).map_err(|error| {
            VaultError::invalid(format!("The remembered Vault record is invalid: {error}"))
        })?;
        if !record.root.is_absolute()
            || record.root.to_str().is_none()
            || Uuid::parse_str(&record.id).is_err()
        {
            return Err(VaultError::invalid(
                "The remembered Vault path or UUID is invalid.",
            ));
        }
        Ok(Some(record))
    }

    pub(super) fn open(self, data: &Path) -> VaultResult<Vault> {
        if self.root.canonicalize()? != self.root {
            return Err(VaultError::invalid(
                "The remembered Vault folder moved or was replaced. Choose it again.",
            ));
        }
        let vault = Vault::open(&self.root, data)?;
        if vault.vault_root() != self.root
            || Uuid::parse_str(&self.id).ok() != Uuid::parse_str(&vault.id).ok()
        {
            return Err(VaultError::invalid(
                "The remembered Vault identity changed. Choose the Vault again; its files were not changed.",
            ));
        }
        Ok(vault)
    }
}

// Bytes are synced before the generation-checked rename. This preference survives a normal
// process restart; it does not promise durability across sudden power loss.
pub(super) struct PreparedRecord {
    dir: Dir,
    staging: Option<String>,
}

impl PreparedRecord {
    pub(super) fn prepare(data: &Path, vault: Option<&Vault>) -> VaultResult<Self> {
        private_dir(data)?;
        let dir = Dir::open_ambient_dir(data, ambient_authority())?;
        let mut prepared = Self { dir, staging: None };
        if let Some(vault) = vault {
            let bytes = serde_json::to_vec(&RememberedVault {
                root: vault.vault_root().to_owned(),
                id: vault.id.clone(),
            })
            .map_err(|error| VaultError::invalid(error.to_string()))?;
            if bytes.len() as u64 > MAX_RECORD_BYTES {
                return Err(VaultError::invalid(
                    "The remembered Vault path is too long.",
                ));
            }
            let staging = format!(".last-vault-{}", Uuid::new_v4());
            write_new(&prepared.dir, Path::new(&staging), &bytes)?;
            prepared.staging = Some(staging);
        }
        Ok(prepared)
    }

    pub(super) fn commit(&self) -> VaultResult<()> {
        match &self.staging {
            Some(staging) => self.dir.rename(staging, &self.dir, RECORD)?,
            None => match self.dir.remove_file(RECORD) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            },
        }
        Ok(())
    }
}

impl Drop for PreparedRecord {
    fn drop(&mut self) {
        if let Some(staging) = &self.staging {
            let _ = self.dir.remove_file(staging);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::vault::VaultParent;

    #[test]
    fn remembers_container_identity_and_clear_survives_reopening_state() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("machine");
        let vault = VaultParent::select(temp.path())
            .unwrap()
            .create("Caderno 日本語", &data)
            .unwrap();
        let root = vault.vault_root().to_owned();
        let id = vault.id.clone();
        PreparedRecord::prepare(&data, Some(&vault))
            .unwrap()
            .commit()
            .unwrap();
        drop(vault);

        let restored = RememberedVault::read(&data)
            .unwrap()
            .unwrap()
            .open(&data)
            .unwrap();
        assert_eq!(restored.vault_root(), root);
        assert_eq!(restored.id, id);
        assert_eq!(restored.root(), root.join("content"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(data.join(RECORD))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        PreparedRecord::prepare(&data, None)
            .unwrap()
            .commit()
            .unwrap();
        assert!(RememberedVault::read(&data).unwrap().is_none());
    }

    #[test]
    fn abandoned_or_failed_record_commit_keeps_previous_selection() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("machine");
        let parent = VaultParent::select(temp.path()).unwrap();
        let first = parent.create("First", &data).unwrap();
        let second = parent.create("Second", &data).unwrap();
        PreparedRecord::prepare(&data, Some(&first))
            .unwrap()
            .commit()
            .unwrap();
        drop(PreparedRecord::prepare(&data, Some(&second)).unwrap());
        let assert_first = || {
            let restored = RememberedVault::read(&data)
                .unwrap()
                .unwrap()
                .open(&data)
                .unwrap();
            assert_eq!(restored.id, first.id);
        };
        assert_first();
        let prepared = PreparedRecord::prepare(&data, Some(&second)).unwrap();
        prepared
            .dir
            .remove_file(prepared.staging.as_ref().unwrap())
            .unwrap();
        assert!(prepared.commit().is_err());
        assert_first();
    }

    #[test]
    fn rejects_replaced_identity_and_untrusted_records_without_changing_sources() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("machine");
        assert!(RememberedVault::read(&data).unwrap().is_none());
        let vault = VaultParent::select(temp.path())
            .unwrap()
            .create("Vault", &data)
            .unwrap();
        let source = vault.root().join("note.md");
        fs::write(&source, "Keep this source exactly.\n").unwrap();
        PreparedRecord::prepare(&data, Some(&vault))
            .unwrap()
            .commit()
            .unwrap();
        let manifest = vault.vault_root().join("vault.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        value["id"] = Uuid::new_v4().to_string().into();
        fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(
            RememberedVault::read(&data)
                .unwrap()
                .unwrap()
                .open(&data)
                .is_err()
        );
        assert_eq!(
            fs::read_to_string(&source).unwrap(),
            "Keep this source exactly.\n"
        );
        for bytes in [b"{".to_vec(), vec![b' '; MAX_RECORD_BYTES as usize + 1]] {
            fs::write(data.join(RECORD), bytes).unwrap();
            assert!(RememberedVault::read(&data).is_err());
        }
    }
}
