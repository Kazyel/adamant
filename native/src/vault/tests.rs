use std::{fs, path::PathBuf};

use tempfile::TempDir;
use uuid::Uuid;

use super::{IndexState, Vault, VaultSnapshot};

mod inventory;
mod lifecycle;
mod notes;
mod persistence;

struct Fixture {
    _temp: TempDir,
    root: PathBuf,
    state: PathBuf,
    vault: Vault,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Caderno 日本語");
        let state = temp.path().join("machine");
        // Existing fixtures exercise the legacy root-relative layout without migration.
        fs::create_dir(&root).unwrap();
        fs::write(
            root.join("vault.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "format": "adamant-vault",
                "formatVersion": 1,
                "id": Uuid::new_v4().to_string()
            }))
            .unwrap(),
        )
        .unwrap();
        let vault = Vault::open(&root, &state).unwrap();
        reconciled(&vault);
        Self {
            _temp: temp,
            root,
            state,
            vault,
        }
    }

    fn reconcile(&self) -> VaultSnapshot {
        reconciled(&self.vault)
    }

    fn recovery_sources(&self) -> Vec<String> {
        fs::read_dir(self.vault.recovery_directory())
            .unwrap()
            .map(|entry| fs::read_to_string(entry.unwrap().path()).unwrap())
            .collect()
    }
}

fn reconciled(vault: &Vault) -> VaultSnapshot {
    assert!(
        vault
            .reconcile(&std::sync::atomic::AtomicBool::new(false), &mut |_| Ok(()))
            .unwrap()
    );
    vault.set_index_state(IndexState::Ready, None);
    vault.refresh().unwrap()
}

fn identified(body: &str) -> String {
    format!(
        "---\nid: {}\ncustom: 'preserve me' # comment\n---\n{body}",
        Uuid::new_v4()
    )
}
