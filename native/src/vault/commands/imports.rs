use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use cap_std::fs::File;
use serde::Serialize;
use tauri::{Emitter, Manager, State};
use uuid::Uuid;

use super::{VaultState, session::with_write};
use crate::vault::{
    VaultError, VaultResult,
    capability::{kind, open_regular},
    mutations::{ImportedFile, MutationResult},
};

const MAX_IMPORTS: usize = 100;
const MAX_BATCH_BYTES: u64 = 256 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_COMPANION_BYTES: u64 = 256 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportSelection {
    token: String,
    name: String,
    kind: &'static str,
}

struct Grant {
    selection: ImportSelection,
    file: File,
    companion: Option<File>,
    created: Instant,
}

#[derive(Default)]
pub(super) struct ImportStore {
    generation: u64,
    grants: HashMap<String, Grant>,
}

fn select_file(path: &Path) -> VaultResult<Grant> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| VaultError::invalid("Import filenames must be valid UTF-8."))?;
    let file_kind = kind(path);
    if !matches!(file_kind, "markdown" | "pdf" | "docx") {
        return Err(VaultError::invalid(format!(
            "Unsupported import: {name}. Choose Markdown, PDF or DOCX."
        )));
    }
    let (dir, _) = crate::vault::navigation::retained_parent(path)?;
    let file = open_regular(&dir, Path::new(name))?;
    if file.metadata()?.len() > MAX_FILE_BYTES {
        return Err(VaultError::invalid(format!(
            "{name} exceeds the 64 MiB import limit."
        )));
    }
    let companion = if matches!(file_kind, "pdf" | "docx") {
        let companion_name = format!("{name}.meta.yaml");
        match dir.symlink_metadata(&companion_name) {
            Ok(_) => Some(open_regular(&dir, Path::new(&companion_name))?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        }
    } else {
        None
    };
    if companion
        .as_ref()
        .map(|file| file.metadata().map(|meta| meta.len()))
        .transpose()?
        .is_some_and(|length| length > MAX_COMPANION_BYTES)
    {
        return Err(VaultError::invalid(format!(
            "Metadata for {name} exceeds 256 KiB."
        )));
    }
    Ok(Grant {
        selection: ImportSelection {
            token: Uuid::new_v4().to_string(),
            name: name.to_owned(),
            kind: file_kind,
        },
        file,
        companion,
        created: Instant::now(),
    })
}

fn grant_paths(
    state: &VaultState,
    generation: u64,
    paths: Vec<PathBuf>,
) -> VaultResult<Vec<ImportSelection>> {
    if paths.len() > MAX_IMPORTS {
        return Err(VaultError::invalid("Import at most 100 files at a time."));
    }
    let grants = paths
        .iter()
        .map(|path| select_file(path))
        .collect::<VaultResult<Vec<_>>>()?;
    let size = grants
        .iter()
        .try_fold(0_u64, |size, grant| -> VaultResult<u64> {
            Ok(size.saturating_add(grant.file.metadata()?.len()))
        })?;
    if size > MAX_BATCH_BYTES {
        return Err(VaultError::invalid("The selected imports exceed 256 MiB."));
    }
    let mut store = state
        .imports
        .lock()
        .map_err(|_| VaultError::io("Import selection is unavailable."))?;
    state.ensure_generation(generation)?;
    store.grants.clear();
    store.generation = generation;
    let selections = grants.iter().map(|grant| grant.selection.clone()).collect();
    store.grants.extend(
        grants
            .into_iter()
            .map(|grant| (grant.selection.token.clone(), grant)),
    );
    Ok(selections)
}

fn read_granted(mut file: File, limit: u64) -> VaultResult<Vec<u8>> {
    let mut bytes = Vec::new();
    (&mut file).take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(VaultError::invalid(
            "The selected file grew beyond the import limit. Select it again.",
        ));
    }
    Ok(bytes)
}

#[tauri::command]
pub(crate) async fn vault_select_imports(
    state: State<'_, VaultState>,
) -> VaultResult<Vec<ImportSelection>> {
    let generation = state.generation();
    let Some(files) = rfd::AsyncFileDialog::new()
        .set_title("Import into the Vault")
        .add_filter("Supported documents", &["md", "pdf", "docx"])
        .pick_files()
        .await
    else {
        return Ok(Vec::new());
    };
    let paths = files
        .into_iter()
        .map(|file| file.path().to_owned())
        .collect();
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || grant_paths(&state, generation, paths))
        .await
        .map_err(|_| VaultError::io("Import selection stopped unexpectedly."))?
}

#[tauri::command]
pub(crate) async fn vault_import_files(
    tokens: Vec<String>,
    directory: String,
    state: State<'_, VaultState>,
) -> VaultResult<MutationResult> {
    let generation = state.generation();
    let grants = {
        let mut store = state
            .imports
            .lock()
            .map_err(|_| VaultError::io("Import selection is unavailable."))?;
        if store.generation != generation || tokens.is_empty() || tokens.len() > MAX_IMPORTS {
            return Err(VaultError::invalid(
                "Select files for this Vault before importing.",
            ));
        }
        let mut seen = HashSet::new();
        for token in &tokens {
            if !seen.insert(token)
                || !store
                    .grants
                    .get(token)
                    .is_some_and(|grant| grant.created.elapsed() < Duration::from_secs(600))
            {
                return Err(VaultError::invalid(
                    "This import selection expired. Select the files again.",
                ));
            }
        }
        tokens
            .iter()
            .filter_map(|token| store.grants.remove(token))
            .collect::<Vec<_>>()
    };
    with_write(&state, generation, move |active| {
        let mut total = 0_u64;
        let mut files = Vec::with_capacity(grants.len());
        for grant in grants {
            let bytes = read_granted(grant.file, MAX_FILE_BYTES)?;
            let companion = grant
                .companion
                .map(|file| read_granted(file, MAX_COMPANION_BYTES))
                .transpose()?;
            total = total
                .saturating_add(bytes.len() as u64)
                .saturating_add(companion.as_ref().map_or(0, |bytes| bytes.len() as u64));
            if total > MAX_BATCH_BYTES {
                return Err(VaultError::invalid(
                    "The selected files grew beyond the 256 MiB batch limit.",
                ));
            }
            files.push(ImportedFile {
                name: grant.selection.name,
                bytes,
                companion,
            });
        }
        let result = active.vault.import_files(files, &directory)?;
        active.background.reconcile();
        Ok(result)
    })
    .await
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportDrop {
    selections: Vec<ImportSelection>,
    request_id: String,
    x: f64,
    y: f64,
}

pub(crate) fn handle_drop(webview: &tauri::Webview, event: &tauri::WebviewEvent) {
    if webview.label() != "main" {
        return;
    }
    let tauri::WebviewEvent::DragDrop(event) = event else {
        return;
    };
    let app = webview.app_handle().clone();
    let Ok(scale) = webview.window().scale_factor() else {
        return;
    };
    match event {
        tauri::DragDropEvent::Enter { position, .. } | tauri::DragDropEvent::Over { position } => {
            let _ = app.emit_to(
                "main",
                "vault-import-hover",
                serde_json::json!({ "x": position.x / scale, "y": position.y / scale }),
            );
            return;
        }
        tauri::DragDropEvent::Leave => {
            let _ = app.emit_to("main", "vault-import-hover", serde_json::Value::Null);
            return;
        }
        _ => {}
    }
    let tauri::DragDropEvent::Drop { paths, position } = event else {
        return;
    };
    if paths.is_empty() {
        return;
    }
    let request_id = Uuid::new_v4().to_string();
    let (x, y) = (position.x / scale, position.y / scale);
    let start = ImportDrop {
        request_id: request_id.clone(),
        selections: Vec::new(),
        x,
        y,
    };
    if app.emit_to("main", "vault-import-start", start).is_err() {
        return;
    }
    let state = app.state::<VaultState>().inner().clone();
    let generation = state.generation();
    let paths = paths.clone();
    tauri::async_runtime::spawn_blocking(move || match grant_paths(&state, generation, paths) {
        Ok(selections) => {
            let _ = app.emit_to(
                "main",
                "vault-import-dropped",
                ImportDrop {
                    selections,
                    request_id,
                    x,
                    y,
                },
            );
        }
        Err(error) => {
            let _ = app.emit_to("main", "vault-import-error", error);
        }
    });
}
