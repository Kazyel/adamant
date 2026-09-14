use tauri::State;

use super::{
    VaultState,
    session::{with_vault, with_write},
};
use crate::vault::{
    VaultError, VaultResult,
    annotations::{AnnotationAction, AnnotationChange, AnnotationRequest, AnnotationSnapshot},
};

#[tauri::command]
pub(crate) async fn vault_annotations(
    path: String,
    expected_identity: String,
    query: String,
    state: State<'_, VaultState>,
) -> VaultResult<AnnotationSnapshot> {
    with_vault(&state, state.generation(), move |active| {
        active.vault.annotations(&path, &expected_identity, &query)
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_change_annotation(
    request: AnnotationRequest,
    state: State<'_, VaultState>,
) -> VaultResult<AnnotationChange> {
    with_write(&state, state.generation(), move |active| {
        crate::vault::capability::relative(&request.path)?;
        if let AnnotationAction::Create { path } = &request.action {
            crate::vault::capability::note_path(path)?;
        }
        if matches!(request.action, AnnotationAction::Link { .. })
            && active.background.has_pending_changes()
        {
            return Err(VaultError::invalid(
                "Filesystem changes are pending. Wait for indexing, then refresh annotations.",
            ));
        }
        let path = request.path.clone();
        let created_path = match &request.action {
            AnnotationAction::Create { path } => Some(path.clone()),
            _ => None,
        };
        let result = active.vault.change_annotation(request);
        // Also reconcile partial outcomes, including a Note retained after a failed link.
        active
            .background
            .enqueue_path(active.vault.root().join(path));
        if let Some(path) = created_path {
            active
                .background
                .enqueue_path(active.vault.root().join(path));
        }
        result
    })
    .await
}
