fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "pick_document",
            "open_document",
            "check_github",
            "check_jira",
        ]),
    ))
    .expect("Failed to build Adamant's Tauri configuration");
}
