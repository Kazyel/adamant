use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use crate::vault::{
    VaultError, VaultResult,
    navigation::{NavigationTarget, retained_target},
};
use serde::Serialize;
use tauri::State;

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
    pub(crate) identity: String,
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
    let path = selected
        .to_str()
        .ok_or_else(|| "The document path must be Unicode.".to_string())?;
    let target = retained_target(path).map_err(|error| error.message)?;
    read_target(selected, target).map_err(|error| error.message)
}

pub(crate) fn read_target(path: PathBuf, mut target: NavigationTarget) -> VaultResult<Document> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| VaultError::invalid("The document filename must be Unicode."))?
        .to_owned();
    let path = path
        .into_os_string()
        .into_string()
        .map_err(|_| VaultError::invalid("The document path must be Unicode."))?;
    let bytes = target.read_bytes()?;
    Ok(Document {
        path,
        name,
        kind: target.entry.kind,
        bytes,
        identity: target.identity,
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

fn validated_link(value: &str) -> Result<reqwest::Url, String> {
    if value
        .chars()
        .any(|character| character.is_control() || character.is_whitespace())
        || value.contains('\\')
    {
        return Err("The link contains invalid whitespace or characters.".into());
    }
    let url = reqwest::Url::parse(value).map_err(|error| format!("Invalid link: {error}"))?;
    match url.scheme() {
        "http" | "https"
            if url.host_str().is_some()
                && value
                    .split_once(':')
                    .is_some_and(|(_, rest)| rest.starts_with("//")) =>
        {
            Ok(url)
        }
        "mailto" if url.cannot_be_a_base() && !url.path().is_empty() => Ok(url),
        "http" | "https" | "mailto" => Err("The link is missing a valid destination.".into()),
        _ => Err("Only HTTP, HTTPS, and mailto links can be opened externally.".into()),
    }
}

#[tauri::command]
pub(crate) async fn open_link(url: String) -> Result<(), String> {
    let url = validated_link(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        open::that(url.as_str())
            .map_err(|error| format!("No external application could open this link: {error}"))
    })
    .await
    .map_err(|error| format!("The external link opener stopped unexpectedly: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::validated_link;

    #[test]
    fn validated_link_accepts_web_and_mail_destinations() {
        for (value, expected) in [
            ("http://example.com/", "http://example.com/"),
            (
                "https://example.com/a%20b?q=hello#section",
                "https://example.com/a%20b?q=hello#section",
            ),
            ("HTTPS://example.com/", "https://example.com/"),
            (
                "mailto:reader@example.com?subject=Hello%20there",
                "mailto:reader@example.com?subject=Hello%20there",
            ),
        ] {
            assert_eq!(validated_link(value).unwrap().as_str(), expected);
        }
    }

    #[test]
    fn validated_link_rejects_unsafe_schemes_and_malformed_destinations() {
        for value in [
            "javascript:alert(1)",
            "data:text/html,hello",
            "file:///etc/passwd",
            "ftp://example.com/",
            "adamant://open",
            "//example.com/",
            "/tmp/note.md",
            "",
            "https://",
            "https://[invalid",
            "https://example.com:invalid/",
            "https:example.com",
            "https:\\\\example.com",
            "https://example.com/a b",
            "\nhttps://example.com/",
            "java\nscript:alert(1)",
            "mailto:",
            "mailto:?subject=Hello",
            "mailto://reader@example.com",
        ] {
            assert!(validated_link(value).is_err(), "accepted {value:?}");
        }
    }
}
