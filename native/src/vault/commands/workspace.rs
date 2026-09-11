use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use serde::Serialize;
use tauri::{Manager, State};

use super::{
    VaultState,
    session::{with_vault, with_write},
};
use crate::vault::navigation::{navigation_target, retained_target};
use crate::{
    documents::{Document, DocumentState},
    vault::{
        NoteDocument, VaultError, VaultResult,
        workspace::{DraftRecord, WorkspaceState, WorkspaceTab},
    },
};

#[derive(Serialize)]
#[serde(tag = "type", content = "document", rename_all = "camelCase")]
pub(crate) enum RestoredTab {
    Note(RestoredNote),
    Document(Document),
}

#[derive(Serialize)]
pub(crate) struct RestoredNote {
    #[serde(flatten)]
    note: NoteDocument,
    identity: String,
}

fn app_data(app: &tauri::AppHandle) -> VaultResult<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map_err(|_| VaultError::io("Local workspace storage is unavailable."))
}

#[tauri::command]
pub(crate) async fn workspace_repair_storage(
    state: State<'_, VaultState>,
    app: tauri::AppHandle,
) -> VaultResult<Vec<String>> {
    let data = app_data(&app)?;
    with_write(&state, state.generation(), move |active| {
        Ok(active.vault.repair_workspace_storage(&data)?)
    })
    .await
}

#[tauri::command]
pub(crate) async fn workspace_load(
    state: State<'_, VaultState>,
    app: tauri::AppHandle,
) -> VaultResult<Option<WorkspaceState>> {
    let data = app_data(&app)?;
    with_vault(&state, state.generation(), move |active| {
        Ok(active.vault.load_workspace(&data)?)
    })
    .await
}

#[tauri::command]
pub(crate) async fn workspace_save(
    mut state: WorkspaceState,
    vault_state: State<'_, VaultState>,
    documents: State<'_, DocumentState>,
    app: tauri::AppHandle,
) -> VaultResult<()> {
    let data = app_data(&app)?;
    let selected = documents.selected_paths.clone();
    with_write(&vault_state, vault_state.generation(), move |active| {
        let previous = active.vault.load_workspace(&data)?;
        let selected = selected
            .lock()
            .map_err(|_| VaultError::io("Document grants are unavailable."))?;
        for tab in &mut state.tabs {
            let retained = previous.as_ref().and_then(|workspace| {
                workspace.tabs.iter().find(|old| {
                    old.id == tab.id
                        && old.path == tab.path
                        && old.kind == tab.kind
                        && old.source_kind == tab.source_kind
                })
            });
            match tab.source_kind.as_str() {
                "vault" => {
                    crate::vault::capability::relative(&tab.path)?;
                }
                "standalone"
                    if selected.contains(&PathBuf::from(&tab.path)) || retained.is_some() => {}
                "untitled" if tab.path.is_empty() && tab.kind == "markdown" => continue,
                _ => {
                    return Err(VaultError::invalid(
                        "Workspace tabs may only retain documents explicitly opened in Adamant.",
                    ));
                }
            }
            if !matches!(tab.kind.as_str(), "markdown" | "pdf" | "docx") {
                return Err(VaultError::invalid("Unsupported workspace document type."));
            }
            if tab.identity.is_none() {
                if retained.is_some_and(|old| old.identity.is_none()) {
                    // Legacy tabs without identity must be explicitly reopened, never rebound during autosave.
                    continue;
                }
                if let Some(identity) = retained.and_then(|old| old.identity.as_ref()) {
                    tab.identity = Some(identity.clone());
                } else {
                    let target = if tab.source_kind == "vault" {
                        navigation_target(&active.vault, &tab.path)?
                    } else {
                        retained_target(&tab.path)?
                    };
                    if target.entry.kind != tab.kind {
                        return Err(VaultError::invalid(
                            "The document type changed before its workspace identity was saved.",
                        ));
                    }
                    tab.identity = Some(target.identity);
                }
            }
        }
        active.vault.save_workspace(&data, &state)?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn workspace_read_tab(
    tab_id: String,
    state: State<'_, VaultState>,
    documents: State<'_, DocumentState>,
    app: tauri::AppHandle,
) -> VaultResult<Option<RestoredTab>> {
    let data = app_data(&app)?;
    let selected = documents.selected_paths.clone();
    let generation = state.generation();
    let authority = state.inner().clone();
    with_vault(&state, generation, move |active| {
        let workspace = active.vault.load_workspace(&data)?.ok_or_else(|| VaultError::invalid("No saved workspace is available."))?;
        let tab = workspace.tabs.iter().find(|tab| tab.id == tab_id).ok_or_else(|| VaultError::invalid("This saved tab is unavailable."))?;
        if tab.source_kind == "untitled" { return Ok(None); }
        let mut target = if tab.source_kind == "vault" {
            navigation_target(&active.vault, &tab.path)?
        } else if tab.source_kind == "standalone" {
            retained_target(&tab.path)?
        } else { return Err(VaultError::invalid("The saved tab origin is invalid.")); };
        if tab.identity.as_deref() != Some(target.identity.as_str()) || target.entry.kind != tab.kind {
            return Err(VaultError::invalid("The saved document identity changed or was not recorded. Its draft is retained; close this tab and reopen the current file explicitly."));
        }
        let bytes = target.read_bytes()?;
        if tab.source_kind == "vault" && tab.kind == "markdown" {
            let text = String::from_utf8(bytes).map_err(|_| VaultError::invalid("The saved Note is not UTF-8."))?;
            let note = crate::vault::notes::document(&tab.path, text);
            if note.id != target.entry.id { return Err(VaultError::invalid("The Note identity changed while restoring. Open it again explicitly.")); }
            return Ok(Some(RestoredTab::Note(RestoredNote { note, identity: target.identity })));
        }
        let absolute = if tab.source_kind == "vault" { active.vault.root.join(crate::vault::capability::relative(&tab.path)?) } else { PathBuf::from(&tab.path) };
        let document = Document {
            name: absolute.file_name().and_then(|name| name.to_str()).ok_or_else(|| VaultError::invalid("Document name is not UTF-8."))?.to_owned(),
            path: absolute.to_string_lossy().into_owned(), kind: target.entry.kind, bytes,
            identity: target.identity,
        };
        let _session = authority.session.lock().map_err(|_| VaultError::io("Vault session is unavailable."))?;
        authority.ensure_generation(generation)?;
        selected.lock().map_err(|_| VaultError::io("Document grants are unavailable."))?.insert(PathBuf::from(&document.path));
        Ok(Some(RestoredTab::Document(document)))
    }).await
}

#[tauri::command]
pub(crate) async fn drafts_load(
    state: State<'_, VaultState>,
    app: tauri::AppHandle,
) -> VaultResult<Vec<DraftRecord>> {
    let data = app_data(&app)?;
    with_vault(&state, state.generation(), move |active| {
        Ok(active.vault.load_drafts(&data)?)
    })
    .await
}

#[tauri::command]
pub(crate) async fn draft_save(
    draft: DraftRecord,
    state: State<'_, VaultState>,
    app: tauri::AppHandle,
) -> VaultResult<()> {
    let data = app_data(&app)?;
    with_write(&state, state.generation(), move |active| {
        Ok(active.vault.save_draft(&data, draft)?)
    })
    .await
}

#[tauri::command]
pub(crate) async fn draft_delete(
    id: String,
    root: String,
    vault_id: String,
    state: State<'_, VaultState>,
    app: tauri::AppHandle,
) -> VaultResult<()> {
    let data = app_data(&app)?;
    with_write(&state, state.generation(), move |active| {
        if active.vault.id != vault_id || active.vault.vault_root.to_string_lossy() != root {
            return Err(VaultError::invalid(
                "The draft belongs to another Vault. It has not been deleted.",
            ));
        }
        Ok(active.vault.delete_draft(&data, &id)?)
    })
    .await
}

#[tauri::command]
pub(crate) async fn preferences_load(
    app: tauri::AppHandle,
) -> VaultResult<Option<serde_json::Value>> {
    let data = app_data(&app)?;
    tauri::async_runtime::spawn_blocking(move || crate::vault::workspace::load_preferences(&data))
        .await
        .map_err(|_| VaultError::io("Loading preferences stopped unexpectedly."))?
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) async fn preferences_save(
    value: serde_json::Value,
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
) -> VaultResult<()> {
    let data = app_data(&app)?;
    let authority = state.authority.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = authority
            .lock()
            .map_err(|_| VaultError::io("Preference storage is unavailable."))?;
        crate::vault::workspace::save_preferences(&data, &value).map_err(VaultError::from)
    })
    .await
    .map_err(|_| VaultError::io("Saving preferences stopped unexpectedly."))?
}

#[derive(Serialize)]
pub(crate) struct LastDocument {
    tab: WorkspaceTab,
    document: Document,
}

fn remember_document(
    data: &Path,
    mut tab: Option<WorkspaceTab>,
    selected: &HashSet<PathBuf>,
) -> VaultResult<()> {
    if let Some(tab) = &mut tab {
        if tab.source_kind != "standalone" || !selected.contains(Path::new(&tab.path)) {
            return Err(VaultError::invalid(
                "Only documents explicitly opened in Adamant can be remembered.",
            ));
        }
        if tab.identity.is_none() {
            tab.identity = crate::vault::workspace::load_last_document(data)?
                .filter(|previous| previous.path == tab.path)
                .and_then(|previous| previous.identity);
        }
        let target = retained_target(&tab.path)?;
        if target.entry.kind != tab.kind
            || tab
                .identity
                .as_ref()
                .is_some_and(|identity| identity != &target.identity)
        {
            return Err(VaultError::invalid(
                "The document identity or type changed. Open it again explicitly.",
            ));
        }
        tab.identity = Some(target.identity);
    }
    crate::vault::workspace::save_last_document(data, tab.as_ref())
}

fn restore_document(
    data: &Path,
    selected: &mut HashSet<PathBuf>,
) -> VaultResult<Option<LastDocument>> {
    let Some(tab) = crate::vault::workspace::load_last_document(data)? else {
        return Ok(None);
    };
    let target = retained_target(&tab.path)?;
    if tab.identity.as_deref() != Some(target.identity.as_str()) || target.entry.kind != tab.kind {
        return Err(VaultError::invalid(
            "The last document identity or type changed. Open it again explicitly.",
        ));
    }
    let document = crate::documents::read_target(PathBuf::from(&tab.path), target)?;
    selected.insert(PathBuf::from(&document.path));
    Ok(Some(LastDocument { tab, document }))
}

#[tauri::command]
pub(crate) async fn last_document_save(
    tab: Option<WorkspaceTab>,
    state: State<'_, VaultState>,
    documents: State<'_, DocumentState>,
    app: tauri::AppHandle,
) -> VaultResult<()> {
    let data = app_data(&app)?;
    let generation = state.generation();
    let state = state.inner().clone();
    let selected = documents.selected_paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _authority = state
            .authority
            .lock()
            .map_err(|_| VaultError::io("Document storage authority is unavailable."))?;
        state.ensure_standalone(generation)?;
        let selected = selected
            .lock()
            .map_err(|_| VaultError::io("Document grants are unavailable."))?;
        remember_document(&data, tab, &selected)
    })
    .await
    .map_err(|_| VaultError::io("Remembering the last document stopped unexpectedly."))?
}

#[tauri::command]
pub(crate) async fn last_document_load(
    state: State<'_, VaultState>,
    documents: State<'_, DocumentState>,
    app: tauri::AppHandle,
) -> VaultResult<Option<LastDocument>> {
    let data = app_data(&app)?;
    let generation = state.generation();
    let state = state.inner().clone();
    let selected = documents.selected_paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _authority = state
            .authority
            .lock()
            .map_err(|_| VaultError::io("Document storage authority is unavailable."))?;
        state.ensure_standalone(generation)?;
        let mut selected = selected
            .lock()
            .map_err(|_| VaultError::io("Document grants are unavailable."))?;
        restore_document(&data, &mut selected)
    })
    .await
    .map_err(|_| VaultError::io("Restoring the last document stopped unexpectedly."))?
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, io::Read, os::unix::fs::symlink};

    fn standalone_tab(path: &Path) -> WorkspaceTab {
        let target = retained_target(path.to_str().unwrap()).unwrap();
        WorkspaceTab {
            id: "standalone-file".into(),
            kind: target.entry.kind.into(),
            path: path.to_str().unwrap().into(),
            name: path.file_name().unwrap().to_str().unwrap().into(),
            source_path: None,
            source_kind: "standalone".into(),
            identity: Some(target.identity),
            base_revision: None,
            view: "read".into(),
            show_original: false,
            page: 2,
            zoom: 1.25,
            line: 3,
            column: 4,
            scroll_top: 125.0,
        }
    }

    #[test]
    fn remembered_documents_restore_bytes_identity_position_and_only_the_saved_grant() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("state");
        for (name, bytes) in [
            ("notas.md", b"# Ol\xc3\xa1\r\n".as_slice()),
            ("report.pdf", b"%PDF-\0\xff".as_slice()),
            ("report.docx", b"PK\0\xff".as_slice()),
        ] {
            let path = temp.path().join(name);
            fs::write(&path, bytes).unwrap();
            let tab = standalone_tab(&path);
            let selected = HashSet::from([path.clone(), temp.path().join("unrelated.md")]);
            remember_document(&data, Some(tab.clone()), &selected).unwrap();
            let mut restarted_grants = HashSet::new();
            let restored = restore_document(&data, &mut restarted_grants)
                .unwrap()
                .unwrap();
            assert_eq!(restored.document.bytes, bytes);
            assert_eq!(Some(restored.document.identity), tab.identity);
            assert_eq!(restored.tab.page, 2);
            assert_eq!(restored.tab.scroll_top, 125.0);
            assert_eq!(restarted_grants, HashSet::from([path]));
        }
    }

    #[test]
    fn missing_and_cleared_last_document_do_not_restore_a_file_or_grant() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("state");
        let mut selected = HashSet::new();
        assert!(restore_document(&data, &mut selected).unwrap().is_none());
        let path = temp.path().join("note.md");
        fs::write(&path, b"note").unwrap();
        selected.insert(path.clone());
        remember_document(&data, Some(standalone_tab(&path)), &selected).unwrap();
        remember_document(&data, None, &selected).unwrap();
        selected.clear();
        assert!(restore_document(&data, &mut selected).unwrap().is_none());
        assert!(selected.is_empty());
    }

    #[test]
    fn last_document_rejects_ungranted_drafts_replacements_and_missing_sources() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("state");
        let path = temp.path().join("report.pdf");
        fs::write(&path, b"original").unwrap();
        let tab = standalone_tab(&path);
        assert!(remember_document(&data, Some(tab.clone()), &HashSet::new()).is_err());
        let selected = HashSet::from([path.clone()]);
        let mut draft = tab.clone();
        draft.source_kind = "untitled".into();
        draft.path.clear();
        assert!(remember_document(&data, Some(draft), &selected).is_err());
        let mut without_identity = tab.clone();
        without_identity.identity = None;
        remember_document(&data, Some(without_identity.clone()), &selected).unwrap();
        assert_eq!(
            crate::vault::workspace::load_last_document(&data)
                .unwrap()
                .unwrap()
                .identity,
            tab.identity
        );

        fs::rename(&path, temp.path().join("original.pdf")).unwrap();
        fs::write(&path, b"replacement").unwrap();
        let mut restarted_grants = HashSet::new();
        assert!(restore_document(&data, &mut restarted_grants).is_err());
        assert!(remember_document(&data, Some(without_identity), &selected).is_err());
        assert!(restarted_grants.is_empty());
        fs::remove_file(&path).unwrap();
        assert!(restore_document(&data, &mut restarted_grants).is_err());
        assert!(restarted_grants.is_empty());
        symlink(temp.path().join("original.pdf"), &path).unwrap();
        assert!(restore_document(&data, &mut restarted_grants).is_err());
        assert!(restarted_grants.is_empty());
    }

    #[test]
    fn retained_identity_and_bytes_use_one_open_file_even_when_the_path_is_replaced() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("report.pdf");
        fs::write(&path, b"original viewer source").unwrap();
        let mut retained = retained_target(path.to_str().unwrap()).unwrap();
        fs::rename(&path, directory.path().join("original.pdf")).unwrap();
        fs::write(&path, b"replacement source").unwrap();
        let replacement = retained_target(path.to_str().unwrap()).unwrap();
        assert_ne!(retained.identity, replacement.identity);
        let mut bytes = Vec::new();
        retained
            .source
            .take()
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes, b"original viewer source");
    }

    #[test]
    fn retained_documents_never_follow_file_or_parent_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.pdf");
        fs::write(&source, b"private source").unwrap();
        let link = directory.path().join("linked.pdf");
        symlink(&source, &link).unwrap();
        assert!(retained_target(link.to_str().unwrap()).is_err());
        let folder = directory.path().join("linked-parent");
        symlink(directory.path(), &folder).unwrap();
        assert!(retained_target(folder.join("source.pdf").to_str().unwrap()).is_err());
    }
}
