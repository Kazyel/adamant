use super::{
    VaultState,
    session::{with_vault, with_write},
};
use crate::vault::{
    VaultResult,
    graph::{GraphData, GraphSnapshot},
};
use tauri::State;

#[tauri::command]
pub(crate) async fn vault_graph(
    root: String,
    vault_id: String,
    state: State<'_, VaultState>,
) -> VaultResult<GraphSnapshot> {
    with_vault(&state, state.generation(), move |active| {
        active.vault.graph_scope(&root, &vault_id)?;
        let mut graph = active.vault.graph()?;
        active.background.project_status(&mut graph.indexing);
        graph.complete &= graph.indexing.state == crate::vault::IndexState::Ready;
        Ok(graph)
    })
    .await
}
#[tauri::command]
pub(crate) async fn vault_save_graph(
    root: String,
    vault_id: String,
    expected_revision: u64,
    graph: GraphData,
    state: State<'_, VaultState>,
) -> VaultResult<GraphSnapshot> {
    with_write(&state, state.generation(), move |active| {
        active.vault.graph_scope(&root, &vault_id)?;
        let mut graph = active.vault.save_graph(graph, expected_revision)?;
        active.background.project_status(&mut graph.indexing);
        graph.complete &= graph.indexing.state == crate::vault::IndexState::Ready;
        Ok(graph)
    })
    .await
}
