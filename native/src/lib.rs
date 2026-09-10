mod connections;
mod documents;
pub mod vault;

use tauri::Manager;
use vault::commands;

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
        .invoke_handler(tauri::generate_handler![
            documents::pick_document,
            documents::open_document,
            connections::check_github,
            connections::check_jira,
            commands::vault_open,
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
            commands::vault_import_note,
            commands::vault_open_document,
        ])
        .run(tauri::generate_context!())
        .expect("Adamant's desktop runtime stopped unexpectedly");
}
