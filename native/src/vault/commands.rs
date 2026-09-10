use std::{
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicU64},
};

use tauri::State;

use super::{NoteDocument, Vault, VaultError, VaultPage, VaultParent, VaultResult, VaultSnapshot};
use crate::documents::{Document, DocumentState};
use session::{ActiveVault, Session, activate_vault, close_vault, with_vault};

mod background;
mod session;

#[derive(Default, Clone)]
pub(crate) struct VaultState {
    session: Arc<Mutex<Session>>,
    // Updated only under the session lock; dialogs/runtime tasks can capture it without blocking.
    generation: Arc<AtomicU64>,
}

#[tauri::command]
pub(crate) async fn vault_select_parent(
    state: State<'_, VaultState>,
) -> VaultResult<Option<String>> {
    let generation = state.generation();
    let Some(folder) = rfd::AsyncFileDialog::new()
        .set_title("Choose a parent folder for the new Vault")
        .pick_folder()
        .await
    else {
        return Ok(None);
    };
    let root = folder.path().to_owned();
    let parent = tauri::async_runtime::spawn_blocking(move || VaultParent::select(&root))
        .await
        .map_err(|_| VaultError::io("Reading the parent folder stopped unexpectedly."))??;
    let path = parent.root().to_string_lossy().into_owned();
    let mut session = state
        .session
        .lock()
        .map_err(|_| VaultError::io("Vault session is unavailable."))?;
    state.ensure_generation(generation)?;
    session.parent = Some(Arc::new(parent));
    Ok(Some(path))
}

#[tauri::command]
pub(crate) async fn vault_open(
    state: State<'_, VaultState>,
    app_state: State<'_, DocumentState>,
    app: tauri::AppHandle,
) -> VaultResult<Option<VaultSnapshot>> {
    let generation = state.generation();
    let Some(folder) = rfd::AsyncFileDialog::new()
        .set_title("Open an Adamant Vault")
        .pick_folder()
        .await
    else {
        return Ok(None);
    };
    let root = folder.path().to_owned();
    activate_vault(state, app_state, app, generation, move |data| {
        Vault::open(&root, data)
    })
    .await
    .map(Some)
}

#[tauri::command]
pub(crate) async fn vault_create(
    name: String,
    state: State<'_, VaultState>,
    app_state: State<'_, DocumentState>,
    app: tauri::AppHandle,
) -> VaultResult<VaultSnapshot> {
    let generation = state.generation();
    let parent = state
        .session
        .lock()
        .map_err(|_| VaultError::io("Vault session is unavailable."))?
        .parent
        .clone()
        .ok_or_else(|| VaultError::invalid("Choose a parent folder first."))?;
    activate_vault(state, app_state, app, generation, move |data| {
        parent.create(&name, data)
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_refresh(state: State<'_, VaultState>) -> VaultResult<VaultSnapshot> {
    with_vault(&state, state.generation(), ActiveVault::snapshot).await
}

#[tauri::command]
pub(crate) async fn vault_list_entries(
    directory: String,
    offset: usize,
    limit: usize,
    state: State<'_, VaultState>,
) -> VaultResult<VaultPage> {
    with_vault(&state, state.generation(), move |active| {
        let mut page = active.vault.list_entries(&directory, offset, limit)?;
        active.background.project_status(&mut page.indexing);
        Ok(page)
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_reconcile(state: State<'_, VaultState>) -> VaultResult<VaultSnapshot> {
    with_vault(&state, state.generation(), |active| {
        active.background.reconcile();
        active.snapshot()
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_cancel_index(state: State<'_, VaultState>) -> VaultResult<VaultSnapshot> {
    with_vault(&state, state.generation(), |active| {
        active.background.cancel();
        active.snapshot()
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_close(
    state: State<'_, VaultState>,
    app_state: State<'_, DocumentState>,
) -> VaultResult<()> {
    close_vault(state, app_state).await
}

#[tauri::command]
pub(crate) async fn vault_read_note(
    path: String,
    state: State<'_, VaultState>,
) -> VaultResult<NoteDocument> {
    with_vault(&state, state.generation(), move |active| {
        active.vault.read_note(&path)
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_create_note(
    path: String,
    text: String,
    state: State<'_, VaultState>,
) -> VaultResult<NoteDocument> {
    with_vault(&state, state.generation(), move |active| {
        active.mutate(|vault| vault.create_note(&path, &text))
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_save_note(
    path: String,
    text: String,
    expected_revision: String,
    state: State<'_, VaultState>,
) -> VaultResult<NoteDocument> {
    with_vault(&state, state.generation(), move |active| {
        active.mutate(|vault| vault.save_note(&path, &text, &expected_revision))
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_save_copy(
    path: String,
    text: String,
    state: State<'_, VaultState>,
) -> VaultResult<NoteDocument> {
    with_vault(&state, state.generation(), move |active| {
        active.mutate(|vault| vault.save_copy(&path, &text))
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_adopt_note(
    path: String,
    expected_revision: String,
    state: State<'_, VaultState>,
) -> VaultResult<NoteDocument> {
    with_vault(&state, state.generation(), move |active| {
        active.mutate(|vault| vault.adopt_note(&path, &expected_revision))
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_import_note(
    path: String,
    state: State<'_, VaultState>,
) -> VaultResult<Option<NoteDocument>> {
    let generation = state.generation();
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("Import a Markdown Note")
        .add_filter("Markdown", &["md"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let source: PathBuf = file.path().to_owned();
    with_vault(&state, generation, move |active| {
        active.mutate(|vault| vault.import_note(&path, &source))
    })
    .await
    .map(Some)
}

#[tauri::command]
pub(crate) async fn vault_open_document(
    path: String,
    state: State<'_, VaultState>,
    app_state: State<'_, DocumentState>,
) -> VaultResult<Document> {
    let generation = state.generation();
    let authority = state.inner().clone();
    let selected_paths = app_state.selected_paths.clone();
    with_vault(&state, generation, move |active| {
        let (absolute, kind, bytes) = active.vault.read_document(&path)?;
        let name = absolute
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| VaultError::invalid("The document filename must be Unicode."))?
            .to_owned();
        // Keep the generation check and grant atomic with respect to choose/close clearing grants.
        let _session = authority
            .session
            .lock()
            .map_err(|_| VaultError::io("Vault session is unavailable."))?;
        authority.ensure_generation(generation)?;
        selected_paths
            .lock()
            .map_err(|_| VaultError::io("Document access is unavailable."))?
            .insert(absolute.clone());
        Ok(Document {
            path: absolute.to_string_lossy().into_owned(),
            name,
            kind,
            bytes,
        })
    })
    .await
}
