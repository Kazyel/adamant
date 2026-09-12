mod connections;
mod documents;
pub mod vault;

use tauri::Manager;
use vault::commands;
use vault::commands::{imports, usability, workspace};

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or("The main window is unavailable.")?;
            window.set_zoom(1.1)?;
            Ok(())
        })
        .manage(documents::DocumentState::default())
        .manage(connections::client())
        .manage(commands::VaultState::default())
        .on_webview_event(imports::handle_drop)
        .invoke_handler(tauri::generate_handler![
            documents::pick_document,
            documents::open_document,
            documents::open_link,
            connections::check_github,
            connections::check_jira,
            connections::work_connections,
            connections::work_remote_list,
            connections::work_remote_detail,
            connections::work_remote_act,
            commands::work_context::work_load,
            commands::work_context::work_save,
            commands::vault_open,
            commands::vault_restore,
            commands::vault_select_parent,
            commands::vault_create,
            commands::vault_refresh,
            commands::vault_list_entries,
            commands::vault_reconcile,
            commands::vault_cancel_index,
            commands::vault_close,
            commands::vault_read_note,
            commands::vault_create_note,
            commands::vault_save_note,
            commands::vault_save_copy,
            commands::vault_adopt_note,
            commands::vault_open_document,
            imports::vault_select_imports,
            imports::vault_import_files,
            usability::vault_create_folder,
            usability::vault_prepare_mutation,
            usability::vault_commit_mutation,
            usability::vault_cancel_mutation,
            usability::vault_list_trash,
            usability::vault_restore_trash,
            usability::vault_purge_trash,
            usability::vault_search,
            usability::vault_cancel_search,
            usability::vault_navigation_target,
            usability::vault_recovery_list,
            usability::vault_recover_mutation,
            usability::vault_export_recovery,
            usability::vault_acknowledge_recovery,
            workspace::workspace_load,
            workspace::workspace_repair_storage,
            workspace::workspace_save,
            workspace::workspace_read_tab,
            workspace::last_document_load,
            workspace::last_document_save,
            workspace::drafts_load,
            workspace::draft_save,
            workspace::draft_delete,
            workspace::preferences_load,
            workspace::preferences_save,
        ])
        .run(tauri::generate_context!())
        .expect("Adamant's desktop runtime stopped unexpectedly");
}
