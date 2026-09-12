use tauri::State;

use super::{
    VaultState,
    session::{with_vault, with_write},
};
use crate::vault::{VaultError, VaultResult, work_context::WorkState};

#[tauri::command]
pub(crate) async fn work_load(
    vault_id: String,
    expected_root: String,
    state: State<'_, VaultState>,
) -> VaultResult<WorkState> {
    with_vault(&state, state.generation(), move |active| {
        if active.vault.vault_root().to_string_lossy() != expected_root {
            return Err(VaultError::invalid(
                "The active Vault location changed. Reopen the project workspace.",
            ));
        }
        active.vault.load_work(&vault_id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn work_save(
    vault_id: String,
    expected_root: String,
    state: WorkState,
    expected_revision: u64,
    vault_state: State<'_, VaultState>,
) -> VaultResult<WorkState> {
    with_write(&vault_state, vault_state.generation(), move |active| {
        if active.vault.vault_root().to_string_lossy() != expected_root {
            return Err(VaultError::invalid(
                "The active Vault location changed. Work was not written to another Vault.",
            ));
        }
        active.vault.save_work(&vault_id, state, expected_revision)
    })
    .await
}
