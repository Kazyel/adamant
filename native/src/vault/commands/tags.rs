use tauri::State;

use super::{
    VaultState,
    session::{with_vault, with_write},
};
use crate::vault::{
    VaultResult,
    tags::{TagChange, TagRequest, TagSnapshot},
};

#[tauri::command]
pub(crate) async fn vault_tags(
    path: Option<String>,
    expected_identity: Option<String>,
    query: Option<String>,
    state: State<'_, VaultState>,
) -> VaultResult<TagSnapshot> {
    with_vault(&state, state.generation(), move |active| {
        let mut snapshot = active.vault.tags(
            path.as_deref(),
            expected_identity.as_deref(),
            query.as_deref().unwrap_or(""),
        )?;
        active.background.project_status(&mut snapshot.indexing);
        Ok(snapshot)
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_set_tags(
    request: TagRequest,
    state: State<'_, VaultState>,
) -> VaultResult<TagChange> {
    with_write(&state, state.generation(), move |active| {
        let path = request.path.clone();
        let result = active.vault.set_tags(request);
        active
            .background
            .enqueue_path(active.vault.root().join(path));
        result
    })
    .await
}
