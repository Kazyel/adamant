use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use tauri::State;

use super::{
    VaultState,
    session::{with_vault, with_write},
};
use crate::vault::navigation::{NavigationTarget, navigation_target};
use crate::vault::{
    VaultError, VaultResult,
    indexing::{SearchPage, SearchQuery},
    mutations::{MutationPlan, MutationRequest, MutationResult, TrashEntry},
};

#[tauri::command]
pub(crate) async fn vault_create_folder(
    path: String,
    state: State<'_, VaultState>,
) -> VaultResult<()> {
    with_write(&state, state.generation(), move |active| {
        active.vault.create_folder(&path)?;
        active.background.reconcile();
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_navigation_target(
    path: String,
    state: State<'_, VaultState>,
) -> VaultResult<NavigationTarget> {
    with_vault(&state, state.generation(), move |active| {
        navigation_target(&active.vault, &path)
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_prepare_mutation(
    request: MutationRequest,
    state: State<'_, VaultState>,
) -> VaultResult<MutationPlan> {
    let generation = state.generation();
    let plans = state.mutation_plans.clone();
    with_write(&state, generation, move |active| {
        let mut plans = plans
            .lock()
            .map_err(|_| VaultError::io("Mutation plans are unavailable."))?;
        plans.retain(|_, scope| *scope == generation);
        if plans.len() >= 16 {
            return Err(VaultError::invalid(
                "Too many pending operations. Cancel an operation before preparing another.",
            ));
        }
        let plan = active.vault.prepare_mutation(request)?;
        plans.insert(plan.id.clone(), generation);
        Ok(plan)
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_commit_mutation(
    plan_id: String,
    state: State<'_, VaultState>,
) -> VaultResult<MutationResult> {
    let generation = state.generation();
    let plans = state.mutation_plans.clone();
    with_write(&state, generation, move |active| {
        let plan_generation = plans
            .lock()
            .map_err(|_| VaultError::io("Mutation plans are unavailable."))?
            .remove(&plan_id);
        if plan_generation != Some(generation) {
            return Err(VaultError::invalid(
                "The operation belongs to an expired Vault session. Prepare it again.",
            ));
        }
        let result = active.vault.commit_mutation(&plan_id)?;
        active.background.reconcile();
        Ok(result)
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_cancel_mutation(
    plan_id: String,
    state: State<'_, VaultState>,
) -> VaultResult<()> {
    let generation = state.generation();
    let plans = state.mutation_plans.clone();
    with_vault(&state, generation, move |active| {
        if plans
            .lock()
            .map_err(|_| VaultError::io("Mutation plans are unavailable."))?
            .remove(&plan_id)
            == Some(generation)
        {
            active.vault.cancel_mutation(&plan_id)?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_list_trash(state: State<'_, VaultState>) -> VaultResult<Vec<TrashEntry>> {
    with_vault(&state, state.generation(), |active| {
        active.vault.list_trash()
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_restore_trash(
    id: String,
    destination: Option<String>,
    state: State<'_, VaultState>,
) -> VaultResult<MutationResult> {
    with_write(&state, state.generation(), move |active| {
        let result = active.vault.restore_trash(&id, destination)?;
        active.background.reconcile();
        Ok(result)
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_purge_trash(
    ids: Vec<String>,
    state: State<'_, VaultState>,
) -> VaultResult<MutationResult> {
    if ids.is_empty() || ids.len() > 100 {
        return Err(VaultError::invalid(
            "Select between one and 100 trash records to permanently delete.",
        ));
    }
    with_write(&state, state.generation(), move |active| {
        active.vault.purge_trash(&ids)
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_search(
    query: String,
    mode: String,
    request_id: String,
    offset: usize,
    limit: usize,
    expected_generation: Option<u64>,
    state: State<'_, VaultState>,
) -> VaultResult<SearchPage> {
    if request_id.is_empty()
        || request_id.len() > 128
        || query.len() > 4096
        || !matches!(mode.as_str(), "path" | "content")
    {
        return Err(VaultError::invalid("Invalid search request."));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut searches = state
            .searches
            .lock()
            .map_err(|_| VaultError::io("Search is unavailable."))?;
        if searches.len() >= 16 {
            return Err(VaultError::invalid(
                "Too many searches are pending. Cancel an earlier search.",
            ));
        }
        if let Some(previous) = searches.insert(request_id.clone(), cancel.clone()) {
            previous.store(true, Ordering::Release);
        }
    }
    let id = request_id.clone();
    let flag = cancel.clone();
    let result = with_vault(&state, state.generation(), move |active| {
        let mut result = active.vault.search(
            SearchQuery {
                request_id: id,
                query: &query,
                mode: &mode,
                offset,
                limit,
                expected_generation,
            },
            &flag,
        )?;
        active.background.project_status(&mut result.indexing);
        Ok(result)
    })
    .await;
    if let Ok(mut searches) = state.searches.lock()
        && searches
            .get(&request_id)
            .is_some_and(|current| Arc::ptr_eq(current, &cancel))
    {
        searches.remove(&request_id);
    }
    result
}

#[tauri::command]
pub(crate) fn vault_cancel_search(
    request_id: String,
    state: State<'_, VaultState>,
) -> VaultResult<()> {
    if let Some(cancel) = state
        .searches
        .lock()
        .map_err(|_| VaultError::io("Search is unavailable."))?
        .get(&request_id)
    {
        cancel.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn vault_recovery_list(
    state: State<'_, VaultState>,
) -> VaultResult<Vec<super::super::mutations::RecoveryRecord>> {
    with_write(&state, state.generation(), |active| {
        let fresh = active.vault.startup_recover()?;
        let mut records = std::mem::take(
            &mut *active
                .recovery
                .lock()
                .map_err(|_| VaultError::io("Recovery records are unavailable."))?,
        );
        for record in fresh {
            records.retain(|previous| previous.id != record.id);
            records.push(record);
        }
        if records.iter().any(|record| record.state == "recovered") {
            active.background.reconcile();
        }
        Ok(records)
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_recover_mutation(
    id: String,
    state: State<'_, VaultState>,
) -> VaultResult<super::super::mutations::RecoveryRecord> {
    with_write(&state, state.generation(), move |active| {
        let record = active.vault.recover_mutation(&id)?;
        active.background.reconcile();
        Ok(record)
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_export_recovery(
    id: String,
    destination: String,
    state: State<'_, VaultState>,
) -> VaultResult<MutationResult> {
    with_write(&state, state.generation(), move |active| {
        let result = active.vault.export_recovery(&id, &destination)?;
        active.background.reconcile();
        Ok(result)
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_acknowledge_recovery(
    id: String,
    state: State<'_, VaultState>,
) -> VaultResult<super::super::mutations::RecoveryRecord> {
    with_write(&state, state.generation(), move |active| {
        active.vault.acknowledge_recovery(&id)
    })
    .await
}
