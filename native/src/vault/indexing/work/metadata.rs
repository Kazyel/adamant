//! Bounded frontmatter and companion reads; document bodies remain source-only.
use std::{
    io::Read,
    path::{Path, PathBuf},
};

use cap_std::fs::{Dir, File};
use serde_json::Value;
use uuid::Uuid;

use crate::vault::capability::{kind, open_regular};
use crate::vault::metadata::{companion_metadata, note_metadata};
use crate::vault::{Vault, VaultEntry, VaultError, VaultResult};

use super::super::{IndexedEntry, MAX_BATCH_BYTES, MAX_METADATA_BYTES, message};
use super::{
    Work,
    discovery::{companion_original, modified_at},
};

impl<'a> Work<'a> {
    pub(super) fn file(&mut self, dir: &Dir, name: &Path, path: &str) {
        if path.rsplit('/').next().is_some_and(|name| {
            name.starts_with(".adamant-write-") || name.starts_with(".adamant-recovery-")
        }) {
            self.issues.push(
                path,
                "Retained safe-write or recovery source. Inspect this version before deleting it.",
            );
        }
        if !Vault::supported_path(name) {
            if let Some(original) = companion_original(path) {
                let original_name = Path::new(original).file_name().expect("Companion filename");
                match dir.symlink_metadata(original_name) {
                    Ok(metadata) if metadata.is_file() => {}
                    Ok(_) => self.issues.push(path, "Companion metadata has no regular original document; reassociation is required."),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => self.issues.push(path, "Companion metadata has no original document; reassociation is required."),
                    Err(error) => self.partial(path, error.to_string()),
                }
            }
            return;
        }
        let kind = kind(name);
        let mut row = IndexedEntry {
            entry: VaultEntry {
                path: path.into(),
                kind,
                id: None,
                metadata_error: None,
                modified_at: modified_at(dir, name),
            },
            metadata: None,
            identity: None,
            references: Vec::new(),
            epoch: self.epoch,
        };
        let identity = open_regular(dir, name).and_then(|mut source| {
            let information = source.metadata()?;
            self.file_metadata(dir, name, &mut source, &mut row)?;
            crate::vault::navigation::target_identity(row.entry.id.as_deref(), &information)
        });
        match identity {
            Ok(identity) => row.identity = Some(identity),
            Err(error) => {
                self.incomplete = true;
                row.entry.metadata_error = Some(message(error.message));
            }
        }

        if let Some(error) = &row.entry.metadata_error {
            self.metadata_issues.push(path, error.clone());
        }
        self.put(row);
    }

    fn file_metadata(
        &mut self,
        dir: &Dir,
        name: &Path,
        source: &mut File,
        row: &mut IndexedEntry,
    ) -> VaultResult<()> {
        let note = row.entry.kind == "markdown";
        let metadata_name = if note {
            name.to_path_buf()
        } else {
            let mut name = name.as_os_str().to_os_string();
            name.push(".meta.yaml");

            PathBuf::from(name)
        };

        // Originals without companions are readable; discovery must not adopt or modify them.
        if !note
            && dir
                .symlink_metadata(&metadata_name)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            return Ok(());
        }

        let text = if note {
            self.metadata_text(source, true)?
        } else {
            self.metadata_text(&mut open_regular(dir, &metadata_name)?, false)?
        };
        let metadata = if note {
            note_metadata(&text)
        } else {
            companion_metadata(&text)
        };

        if metadata.value.is_none() && (!note || !text.is_empty()) {
            self.incomplete = true;
        }

        row.entry.id = metadata.id;
        row.entry.metadata_error = metadata.error.map(message);

        let Some(value) = metadata.value else {
            return Ok(());
        };

        if let Some(references) = value.get("refs").and_then(Value::as_array) {
            for reference in references {
                if matches!(
                    reference["kind"].as_str(),
                    Some("note" | "topic" | "document" | "documentation-page")
                ) && let Some(id) = reference["id"]
                    .as_str()
                    .and_then(|id| Uuid::parse_str(id).ok())
                {
                    row.references.push(id.to_string());
                }
            }

            row.references.sort_unstable();
            row.references.dedup();
        }

        row.metadata = Some(value.to_string());
        Ok(())
    }

    fn metadata_text(&mut self, file: &mut File, note: bool) -> VaultResult<String> {
        let length = file.metadata()?.len();
        if !note && length > MAX_METADATA_BYTES {
            return Err(VaultError::invalid(
                "Companion metadata exceeds 256 KiB; it was not read.",
            ));
        }
        let mut bytes = Vec::new();
        let mut line_start = 0;
        let mut first = true;
        loop {
            if (!note && bytes.len() as u64 == length)
                || (note
                    && bytes.len() as u64 == length
                    && !first
                    && matches!(trim_delimiter(&bytes[line_start..]), b"---" | b"..."))
            {
                return String::from_utf8(bytes)
                    .map_err(|_| VaultError::invalid("Metadata must contain UTF-8 text."));
            }
            if !self.checkpoint() {
                return Err(VaultError::invalid(
                    "Metadata inspection stopped before completion.",
                ));
            }
            let available = (MAX_METADATA_BYTES as usize - bytes.len())
                .min(MAX_BATCH_BYTES - self.metadata_read);
            if available == 0 {
                if self.metadata_read >= MAX_BATCH_BYTES {
                    self.halted = true;
                }
                return Err(VaultError::invalid(
                    "The 256 KiB metadata or 32 MiB batch read budget was reached.",
                ));
            }
            let mut buffer = [0u8; 4096];
            let count = file.read(&mut buffer[..available.min(4096)])?;
            self.metadata_read += count;
            bytes.extend_from_slice(&buffer[..count]);
            if note {
                while let Some(end) = bytes[line_start..].iter().position(|byte| *byte == b'\n') {
                    let end = line_start + end + 1;
                    let mut line = &bytes[line_start..end];
                    if first {
                        line = line.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(line);
                    }
                    let line = trim_delimiter(line);
                    if first && line != b"---" {
                        return Ok(String::new());
                    }
                    if !first && matches!(line, b"---" | b"...") {
                        bytes.truncate(end);
                        return String::from_utf8(bytes)
                            .map_err(|_| VaultError::invalid("Metadata must contain UTF-8 text."));
                    }
                    first = false;
                    line_start = end;
                }
                if first {
                    let line = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
                    if line.len() >= 3
                        && (line[..3] != *b"---"
                            || line[3..]
                                .iter()
                                .any(|byte| !matches!(byte, b'\r' | b' ' | b'\t')))
                    {
                        return Ok(String::new());
                    }
                }
            }
            if count == 0 {
                if note
                    && first
                    && trim_delimiter(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes))
                        != b"---"
                {
                    return Ok(String::new());
                }
                return String::from_utf8(bytes)
                    .map_err(|_| VaultError::invalid("Metadata must contain UTF-8 text."));
            }
        }
    }
}

fn trim_delimiter(mut line: &[u8]) -> &[u8] {
    while line
        .last()
        .is_some_and(|byte| matches!(byte, b'\r' | b'\n' | b' ' | b'\t'))
    {
        line = &line[..line.len() - 1];
    }
    line
}
