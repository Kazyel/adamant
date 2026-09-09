fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "pick_document",
            "open_document",
            "check_github",
            "check_jira",
            "vault_open",
            "vault_select_parent",
            "vault_create",
            "vault_refresh",
            "vault_list_entries",
            "vault_reconcile",
            "vault_cancel_index",
            "vault_close",
            "vault_read_note",
            "vault_create_note",
            "vault_save_note",
            "vault_save_copy",
            "vault_adopt_note",
            "vault_import_note",
            "vault_open_document",
        ]),
    ))
    .expect("Failed to build Adamant's Tauri configuration");
}
