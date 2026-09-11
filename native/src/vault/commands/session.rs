use std::{
    path::Path,
    sync::{Arc, Mutex, atomic::Ordering},
};

use tauri::{Manager, State};

use super::{
    VaultState,
    background::Background,
    remembered::{PreparedRecord, RememberedVault},
};
use crate::{
    documents::DocumentState,
    vault::{IndexState, NoteDocument, Vault, VaultError, VaultParent, VaultResult, VaultSnapshot},
};

#[derive(Default)]
pub(super) struct Session {
    active: Option<Arc<ActiveVault>>,
    pub(super) parent: Option<Arc<VaultParent>>,
    explicitly_closed: bool,
}

pub(super) struct ActiveVault {
    pub(super) vault: Arc<Vault>,
    pub(super) background: Background,
    pub(super) recovery: Mutex<Vec<crate::vault::mutations::RecoveryRecord>>,
}

impl ActiveVault {
    pub(super) fn snapshot(&self) -> VaultResult<VaultSnapshot> {
        let mut snapshot = self.vault.refresh()?;
        self.background.project_status(&mut snapshot.indexing);
        Ok(snapshot)
    }

    pub(super) fn mutate(
        &self,
        operation: impl FnOnce(&Vault) -> VaultResult<NoteDocument>,
    ) -> VaultResult<NoteDocument> {
        self.vault.ensure_no_pending_mutations()?;
        if self.background.has_pending_changes() {
            // Identity-sensitive mutations must not certify against an old Ready state while
            // the callback's pending paths or a requested reconciliation wait for the worker.
            self.vault.set_index_state(
                IndexState::Stale,
                Some("Filesystem changes are pending.".into()),
            );
        }
        let note = operation(&self.vault)?;
        // Local writes mark core state stale. Do not depend on an OS notification arriving
        // (or that directory already being watched) to reconcile the successful write.
        self.background
            .enqueue_path(self.vault.root().join(&note.path));
        Ok(note)
    }
}

impl VaultState {
    pub(super) fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    fn reset_transient_authority(&self, active: Option<&ActiveVault>) {
        *self
            .imports
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Default::default();
        for (_, flag) in self
            .searches
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .drain()
        {
            flag.store(true, Ordering::Release);
        }
        for (id, _) in self
            .mutation_plans
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .drain()
        {
            if let Some(active) = active {
                let _ = active.vault.cancel_mutation(&id);
            }
        }
    }

    fn active(&self, generation: u64) -> VaultResult<Arc<ActiveVault>> {
        let session = self
            .session
            .lock()
            .map_err(|_| VaultError::io("Vault session is unavailable. Restart Adamant."))?;
        self.ensure_generation(generation)?;
        session
            .active
            .clone()
            .ok_or_else(|| VaultError::invalid("Open a Vault first."))
    }

    pub(super) fn ensure_generation(&self, generation: u64) -> VaultResult<()> {
        if self.generation() != generation {
            return Err(VaultError::invalid(
                "The Vault changed before this operation completed.",
            ));
        }
        Ok(())
    }

    pub(super) fn ensure_standalone(&self, generation: u64) -> VaultResult<()> {
        let session = self
            .session
            .lock()
            .map_err(|_| VaultError::io("Vault session is unavailable. Restart Adamant."))?;
        self.ensure_generation(generation)?;
        if session.active.is_some() {
            return Err(VaultError::invalid(
                "Use the Vault workspace while a Vault is open.",
            ));
        }
        Ok(())
    }
}

pub(super) async fn with_vault<T: Send + 'static>(
    state: &VaultState,
    generation: u64,
    operation: impl FnOnce(&ActiveVault) -> VaultResult<T> + Send + 'static,
) -> VaultResult<T> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let active = state.active(generation)?;
        // The session lock protects the authority handoff, never filesystem/SQLite work.
        let result = operation(&active)?;
        state.ensure_generation(generation)?;
        Ok(result)
    })
    .await
    .map_err(|_| VaultError::io("The Vault operation stopped unexpectedly."))?
}

pub(super) async fn with_write<T: Send + 'static>(
    state: &VaultState,
    generation: u64,
    operation: impl FnOnce(&ActiveVault) -> VaultResult<T> + Send + 'static,
) -> VaultResult<T> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Source commits and authority handoff are serialized, without holding the
        // session mutex during IO. Reads and cancellation remain independent.
        let _authority = state
            .authority
            .lock()
            .map_err(|_| VaultError::io("Vault write authority is unavailable."))?;
        let active = state.active(generation)?;
        let result = operation(&active)?;
        state.ensure_generation(generation)?;
        Ok(result)
    })
    .await
    .map_err(|_| VaultError::io("The Vault write stopped unexpectedly."))?
}

pub(super) async fn restore_vault(
    state: State<'_, VaultState>,
    app_state: State<'_, DocumentState>,
    app: tauri::AppHandle,
) -> VaultResult<Option<VaultSnapshot>> {
    let (generation, has_active, explicitly_closed) = {
        let session = state
            .session
            .lock()
            .map_err(|_| VaultError::io("Vault session is unavailable."))?;
        (
            state.generation(),
            session.active.is_some(),
            session.explicitly_closed,
        )
    };
    if has_active {
        return with_vault(&state, generation, ActiveVault::snapshot)
            .await
            .map(Some);
    }
    if explicitly_closed {
        return Ok(None);
    }
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|error| VaultError::io(error.to_string()))?;
    let remembered = tauri::async_runtime::spawn_blocking(move || RememberedVault::read(&data))
        .await
        .map_err(|_| VaultError::io("Reading the remembered Vault stopped unexpectedly."))??;
    state.ensure_generation(generation)?;
    let Some(remembered) = remembered else {
        return Ok(None);
    };
    activate_vault(state, app_state, app, generation, move |data| {
        remembered.open(data)
    })
    .await
    .map(Some)
}

pub(super) async fn activate_vault(
    state: State<'_, VaultState>,
    app_state: State<'_, DocumentState>,
    app: tauri::AppHandle,
    generation: u64,
    open: impl FnOnce(&Path) -> VaultResult<Vault> + Send + 'static,
) -> VaultResult<VaultSnapshot> {
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|error| VaultError::io(error.to_string()))?;
    let state = state.inner().clone();
    let selected_paths = app_state.selected_paths.clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        let _authority = state
            .authority
            .lock()
            .map_err(|_| VaultError::io("Vault write authority is unavailable."))?;
        state.ensure_generation(generation)?;
        // Validation, root watching and the immediate snapshot all happen before session handoff.
        // An invalid selection leaves the prior Vault and its document authorizations untouched.
        let vault = Arc::new(open(&data)?);
        let (recovery, recovery_error) = match vault.startup_recover() {
            Ok(records) => (records, None),
            Err(error) => (Vec::new(), Some(error)),
        };
        let next_generation = generation.wrapping_add(1);
        let background = Background::start(
            vault.clone(),
            app,
            state.generation.clone(),
            next_generation,
        )?;
        let active = Arc::new(ActiveVault {
            vault,
            background,
            recovery: Mutex::new(recovery),
        });
        let mut snapshot = active.snapshot()?;
        if let Some(error) = recovery_error {
            snapshot.issues.push(crate::vault::VaultIssue {
                path: ".adamant".into(),
                message: format!(
                    "Recovery requires attention; sources were retained: {}",
                    error.message
                ),
            });
            snapshot.issue_count += 1;
        }
        let remembered = PreparedRecord::prepare(&data, Some(&active.vault))?;
        let old = {
            let mut session = state
                .session
                .lock()
                .map_err(|_| VaultError::io("Vault session is unavailable."))?;
            state.ensure_generation(generation)?;
            let mut selected_paths = selected_paths
                .lock()
                .map_err(|_| VaultError::io("Document access is unavailable."))?;
            remembered.commit()?;
            // No fallible work follows the preference commit: IPC and active authority agree.
            selected_paths.clear();
            state.reset_transient_authority(session.active.as_deref());
            let old = session.active.replace(active.clone());
            session.parent = None;
            state.generation.store(next_generation, Ordering::Release);
            if let Some(old) = &old {
                old.background.stop();
            }
            active.background.activate();
            old
        };
        drop(old);
        Ok::<_, VaultError>(snapshot)
    })
    .await
    .map_err(|_| VaultError::io("Opening the Vault stopped unexpectedly."))??;
    Ok(snapshot)
}

pub(super) async fn close_vault(
    state: State<'_, VaultState>,
    app_state: State<'_, DocumentState>,
    app: tauri::AppHandle,
) -> VaultResult<()> {
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|error| VaultError::io(error.to_string()))?;
    let state = state.inner().clone();
    let generation = state.generation();
    let selected_paths = app_state.selected_paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _authority = state
            .authority
            .lock()
            .map_err(|_| VaultError::io("Vault write authority is unavailable."))?;
        let remembered = PreparedRecord::prepare(&data, None)?;
        let old = {
            let mut session = state
                .session
                .lock()
                .map_err(|_| VaultError::io("Vault session is unavailable."))?;
            state.ensure_generation(generation)?;
            let mut selected_paths = selected_paths
                .lock()
                .map_err(|_| VaultError::io("Document access is unavailable."))?;
            remembered.commit()?;
            selected_paths.clear();
            state.reset_transient_authority(session.active.as_deref());
            let old = session.active.take();
            session.parent = None;
            session.explicitly_closed = true;
            state
                .generation
                .store(generation.wrapping_add(1), Ordering::Release);
            if let Some(old) = &old {
                old.background.stop();
            }
            old
        };
        // No join and no watcher teardown on the native/UI path, even if a note command has
        // retained the old ActiveVault. Its worker has already received the stop/cancel signal.
        drop(old);
        Ok::<_, VaultError>(())
    })
    .await
    .map_err(|_| VaultError::io("Closing the Vault stopped unexpectedly."))?
}
