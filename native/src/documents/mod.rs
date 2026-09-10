use std::{
    collections::HashSet,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::Serialize;
use tauri::State;

const MAX_DOCUMENT_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct DocumentState {
    pub(crate) selected_paths: Arc<Mutex<HashSet<PathBuf>>>,
}

#[derive(Serialize)]
pub(crate) struct Document {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) kind: &'static str,
    pub(crate) bytes: Vec<u8>,
}

fn document_kind(path: &Path) -> Result<&'static str, String> {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if extension.eq_ignore_ascii_case("md") => Ok("markdown"),
        Some(extension) if extension.eq_ignore_ascii_case("pdf") => Ok("pdf"),
        Some(extension) if extension.eq_ignore_ascii_case("docx") => Ok("docx"),
        _ => Err("Choose a Markdown (.md), PDF (.pdf), or DOCX (.docx) document.".into()),
    }
}

pub(crate) fn read_document(selected: PathBuf) -> Result<Document, String> {
    document_kind(&selected)?;
    let path = selected
        .canonicalize()
        .map_err(|_| "The selected document is unavailable. Choose it again.".to_string())?;
    let kind = document_kind(&path)?;
    let metadata =
        fs::metadata(&path).map_err(|_| "Cannot inspect the selected document.".to_string())?;
    if !metadata.is_file() {
        return Err("Choose a regular document file, not a directory or device.".into());
    }
    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err("This M0 viewer accepts documents up to 64 MiB.".into());
    }
    let file = File::open(&path)
        .map_err(|_| "Cannot read the selected document. Check its permissions.".to_string())?;
    let metadata = file
        .metadata()
        .map_err(|_| "Cannot inspect the selected document.".to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_DOCUMENT_BYTES {
        return Err(
            "The document changed while opening. Choose a regular file up to 64 MiB.".into(),
        );
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Reading the document failed. Choose it again.".to_string())?;
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("This M0 viewer accepts documents up to 64 MiB.".into());
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The document filename must be valid Unicode.".to_string())?
        .to_owned();
    let path = path
        .into_os_string()
        .into_string()
        .map_err(|_| "The document path must be valid Unicode.".to_string())?;
    Ok(Document {
        path,
        name,
        kind,
        bytes,
    })
}

#[tauri::command]
pub(crate) async fn pick_document(
    state: State<'_, DocumentState>,
) -> Result<Option<Document>, String> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("Open a document in Adamant")
        .add_filter("Documents", &["md", "pdf", "docx"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let selected = file.path().to_owned();
    let document = tauri::async_runtime::spawn_blocking(move || read_document(selected))
        .await
        .map_err(|_| "The document reader stopped unexpectedly.".to_string())??;
    state
        .selected_paths
        .lock()
        .map_err(|_| "Document access is unavailable. Restart Adamant.".to_string())?
        .insert(PathBuf::from(&document.path));
    Ok(Some(document))
}

#[tauri::command]
pub(crate) async fn open_document(
    path: String,
    state: State<'_, DocumentState>,
) -> Result<(), String> {
    let path = {
        let selected = state
            .selected_paths
            .lock()
            .map_err(|_| "Document access is unavailable. Restart Adamant.".to_string())?;
        selected.get(Path::new(&path)).cloned().ok_or_else(|| {
            "Choose this document in Adamant before opening it externally.".to_string()
        })?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let current = path
            .canonicalize()
            .map_err(|_| "The original document is unavailable. Choose it again.".to_string())?;
        if current != path || !current.is_file() {
            return Err("The original document moved or became a link. Choose it again.".into());
        }
        document_kind(&current)?;
        open::that(&current).map_err(|_| {
            "No external application could open this document. Check the file association."
                .to_string()
        })
    })
    .await
    .map_err(|_| "The external opener stopped unexpectedly.".to_string())?
}
