use std::{
    path::Path,
    sync::{Arc, atomic::Ordering},
};

use tauri::{Manager, State};

use super::{VaultState, background::Background};
use crate::{
    documents::DocumentState,
    vault::{IndexState, NoteDocument, Vault, VaultError, VaultParent, VaultResult, VaultSnapshot},
};

#[derive(Default)]
pub(super) struct Session {
    active: Option<Arc<ActiveVault>>,
    pub(super) parent: Option<Arc<VaultParent>>,
}

pub(super) struct ActiveVault {
    pub(super) vault: Arc<Vault>,
    pub(super) background: Background,
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
        state.ensure_generation(generation)?;
        // Validation, root watching and the immediate snapshot all happen before session handoff.
        // An invalid selection leaves the prior Vault and its document authorizations untouched.
        let vault = Arc::new(open(&data)?);
        let next_generation = generation.wrapping_add(1);
        let background = Background::start(
            vault.clone(),
            app,
            state.generation.clone(),
            next_generation,
        )?;
        let active = Arc::new(ActiveVault { vault, background });
        let snapshot = active.snapshot()?;
        let old = {
            let mut session = state
                .session
                .lock()
                .map_err(|_| VaultError::io("Vault session is unavailable."))?;
            state.ensure_generation(generation)?;
            selected_paths
                .lock()
                .map_err(|_| VaultError::io("Document access is unavailable."))?
                .clear();
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
) -> VaultResult<()> {
    let state = state.inner().clone();
    let generation = state.generation();
    let selected_paths = app_state.selected_paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let old = {
            let mut session = state
                .session
                .lock()
                .map_err(|_| VaultError::io("Vault session is unavailable."))?;
            state.ensure_generation(generation)?;
            selected_paths
                .lock()
                .map_err(|_| VaultError::io("Document access is unavailable."))?
                .clear();
            let old = session.active.take();
            session.parent = None;
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
