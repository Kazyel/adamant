use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use super::capability::{read_limited, sync_dir, write_new};
use super::{
    IndexStatus, NoteDocument, Vault, VaultError, VaultResult, hash, metadata, navigation,
};

const MAX_METADATA: u64 = 256 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationLink {
    pub id: String,
    pub path: Option<String>,
    pub problem: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationSnapshot {
    pub identity: String,
    pub revision: Option<String>,
    pub links: Vec<AnnotationLink>,
    pub candidates: Vec<AnnotationLink>,
    pub more_candidates: bool,
    pub more_links: bool,
    pub indexing: IndexStatus,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum AnnotationAction {
    Link { id: String },
    Unlink { id: String },
    Create { path: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AnnotationRequest {
    pub path: String,
    pub expected_identity: String,
    pub expected_revision: Option<String>,
    pub action: AnnotationAction,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnnotationChange {
    pub identity: String,
    pub created: Option<NoteDocument>,
}

pub(super) fn note_reference_id(reference: &Value) -> Option<String> {
    (reference["kind"] == "note")
        .then(|| {
            reference["id"]
                .as_str()
                .and_then(|id| Uuid::parse_str(id).ok())
                .map(|id| id.to_string())
        })
        .flatten()
}

pub(super) fn ordinary_note(value: &Value) -> bool {
    value.get("kind").is_none_or(|kind| kind == "note")
}

fn sequence_end(text: &str, start: usize) -> VaultResult<usize> {
    use serde_saphyr::granit_parser::{Event, Parser};
    let mut depth = 0;
    let mut found = false;
    for event in Parser::new_from_str(text) {
        let (event, span) = event.map_err(|error| VaultError::invalid(error.to_string()))?;
        if !found {
            if span.start.byte_offset() == Some(start) && matches!(event, Event::SequenceStart(..))
            {
                found = true;
            } else {
                continue;
            }
        }
        match event {
            Event::SequenceStart(..) | Event::MappingStart(..) => depth += 1,
            Event::SequenceEnd | Event::MappingEnd => {
                depth -= 1;
                if depth == 0 {
                    return span
                        .end
                        .byte_offset()
                        .ok_or_else(|| VaultError::invalid("References have no end location."));
                }
            }
            _ => {}
        }
    }
    Err(VaultError::invalid(
        "Cannot locate the annotation reference sequence.",
    ))
}

pub(super) fn companion_text(previous: Option<&str>, value: &Value) -> VaultResult<String> {
    let refs = serde_json::to_string(&value["refs"])
        .map_err(|error| VaultError::invalid(error.to_string()))?;
    let Some(previous) = previous else {
        return Ok(format!(
            "id: {}\nrefs: {refs}\n",
            value["id"].as_str().unwrap()
        ));
    };
    let fields: std::collections::HashMap<String, serde_saphyr::Spanned<Value>> =
        serde_saphyr::from_str(previous).map_err(|error| VaultError::invalid(error.to_string()))?;
    let newline = if previous.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut next = previous.to_owned();
    if let Some(field) = fields.get("refs") {
        if field.referenced != field.defined {
            return Err(VaultError::invalid(
                "Aliased annotation references require an explicit metadata edit.",
            ));
        }
        let span = field.referenced.span();
        let start = span
            .byte_offset()
            .and_then(|value| usize::try_from(value).ok());
        let Some(start) = start else {
            return Err(VaultError::invalid(
                "Annotation references have no source location.",
            ));
        };
        let end = sequence_end(previous, start)?;
        let raw = previous
            .get(start..end)
            .ok_or_else(|| VaultError::invalid("Annotation source location is invalid."))?;
        let suffix = if raw.ends_with('\n') { newline } else { "" };
        next.replace_range(start..end, &format!("{refs}{suffix}"));
    } else {
        // Insert before the first mapping key, retaining comments and unrelated YAML verbatim.
        let first = previous
            .trim_start_matches('\u{feff}')
            .split_inclusive('\n')
            .find(|line| {
                let line = line.trim();
                !line.is_empty() && !line.starts_with('#') && line != "---"
            })
            .ok_or_else(|| VaultError::invalid("Document metadata has no mapping."))?;
        let start = first.as_ptr() as usize - previous.as_ptr() as usize;
        if first.trim_start().starts_with('{') {
            let brace = start + first.find('{').unwrap() + 1;
            next.insert_str(brace, &format!("refs: {refs}, "));
        } else {
            let indent = &first[..first.len() - first.trim_start_matches(' ').len()];
            next.insert_str(start, &format!("{indent}refs: {refs}{newline}"));
        }
    }
    let parsed = metadata::companion_metadata(&next);
    if parsed.error.is_some() || parsed.value.as_ref() != Some(value) {
        return Err(VaultError::invalid(
            "This YAML layout cannot be changed safely. Edit its refs explicitly; existing metadata was not rewritten.",
        ));
    }
    Ok(next)
}

impl Vault {
    fn annotation_target(
        &self,
        path: &str,
        expected_identity: &str,
    ) -> VaultResult<navigation::NavigationTarget> {
        self.ensure_current_manifest()?;
        let target = navigation::navigation_target(self, path)?;
        if target.identity != expected_identity {
            return Err(VaultError::conflict(
                "The document identity changed. Reopen the current file before managing annotations.",
                None,
            ));
        }
        if let Some(error) = &target.entry.metadata_error {
            return Err(VaultError::invalid(format!(
                "Repair or adopt this document's metadata before managing annotations: {error}"
            )));
        }
        Ok(target)
    }

    fn read_companion(&self, path: &str) -> VaultResult<Option<String>> {
        let (dir, name) = self.parent(&format!("{path}.meta.yaml"), false)?;
        match dir.symlink_metadata(&name) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
            Ok(_) => String::from_utf8(read_limited(&dir, &name, MAX_METADATA)?)
                .map(Some)
                .map_err(|_| VaultError::invalid("Companion metadata is not UTF-8.")),
        }
    }

    pub(crate) fn annotations(
        &self,
        path: &str,
        expected_identity: &str,
        query: &str,
    ) -> VaultResult<AnnotationSnapshot> {
        if query.len() > 4096 {
            return Err(VaultError::invalid("Search text is too long."));
        }
        let target = self.annotation_target(path, expected_identity)?;
        let mut snapshot = AnnotationSnapshot {
            identity: target.identity,
            revision: None,
            links: Vec::new(),
            candidates: Vec::new(),
            more_candidates: false,
            more_links: false,
            indexing: self.refresh()?.indexing,
        };
        let note_id = match target.entry.kind {
            "pdf" | "docx" => {
                if let Some(text) = self.read_companion(path)? {
                    let parsed = metadata::companion_metadata(&text);
                    if parsed.error.is_some() || parsed.id != target.entry.id {
                        return Err(VaultError::invalid(
                            "Document metadata changed while reading. Refresh annotations.",
                        ));
                    }
                    snapshot.revision = Some(hash(text.as_bytes()));
                    if let Some(refs) = parsed
                        .value
                        .as_ref()
                        .and_then(|value| value["refs"].as_array())
                    {
                        snapshot.links = refs
                            .iter()
                            .filter_map(note_reference_id)
                            .map(|id| AnnotationLink {
                                id,
                                path: None,
                                problem: None,
                            })
                            .collect();
                    }
                }
                None
            }
            "markdown" => target.entry.id,
            _ => return Err(VaultError::invalid("Choose a Note, PDF or DOCX.")),
        };
        self.annotation_inventory(&mut snapshot, note_id.as_deref(), query)?;
        Ok(snapshot)
    }

    pub(crate) fn change_annotation(
        &self,
        request: AnnotationRequest,
    ) -> VaultResult<AnnotationChange> {
        let _identity = self
            .identity_writes
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.ensure_no_pending_mutations()?;
        let target = self.annotation_target(&request.path, &request.expected_identity)?;
        if !matches!(target.entry.kind, "pdf" | "docx") {
            return Err(VaultError::invalid(
                "Annotations belong to PDF or DOCX documents.",
            ));
        }
        if matches!(request.action, AnnotationAction::Link { .. })
            && let Some(id) = &target.entry.id
        {
            let entry = self.annotation_identity_path(id)?;
            if entry.is_none_or(|entry| entry.path != request.path) {
                return Err(VaultError::invalid(
                    "Document identity is not reconciled. Refresh the Vault.",
                ));
            }
        }
        let previous = self.read_companion(&request.path)?;
        if previous.as_ref().map(|text| hash(text.as_bytes())) != request.expected_revision {
            return Err(VaultError::conflict(
                "Annotations changed on disk. Refresh the list before applying your change.",
                None,
            ));
        }
        let mut value = if let Some(text) = &previous {
            let parsed = metadata::companion_metadata(text);
            if parsed.error.is_some() || parsed.id != target.entry.id {
                return Err(VaultError::invalid(
                    "Companion metadata changed or is invalid.",
                ));
            }
            parsed
                .value
                .ok_or_else(|| VaultError::invalid("Missing document metadata."))?
        } else {
            json!({"id": Uuid::new_v4().to_string()})
        };
        let mut refs = value
            .get("refs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut created = None;
        match request.action {
            AnnotationAction::Link { id } => {
                let id = Uuid::parse_str(&id)
                    .map_err(|_| VaultError::invalid("Invalid Note identity."))?
                    .to_string();
                let entry = self.annotation_identity_path(&id)?.ok_or_else(|| {
                    VaultError::invalid("This Note is missing. Refresh the list.")
                })?;
                if entry.kind != "markdown" || entry.metadata_error.is_some() {
                    return Err(VaultError::invalid(
                        "Choose an adopted Markdown Note with valid metadata.",
                    ));
                }
                let note = self.read_note(&entry.path)?;
                let metadata = metadata::note_metadata(&note.text);
                if note.id.as_deref() != Some(&id)
                    || note.metadata_error.is_some()
                    || metadata
                        .value
                        .as_ref()
                        .is_none_or(|value| !ordinary_note(value))
                {
                    return Err(VaultError::invalid(
                        "The selected Note changed. Refresh the Vault.",
                    ));
                }
                if !refs
                    .iter()
                    .any(|reference| note_reference_id(reference).as_deref() == Some(&id))
                {
                    refs.push(json!({"kind": "note", "id": id}));
                }
            }
            AnnotationAction::Unlink { id } => {
                let id = Uuid::parse_str(&id)
                    .map_err(|_| VaultError::invalid("Invalid Note identity."))?
                    .to_string();
                refs.retain(|reference| note_reference_id(reference).as_deref() != Some(&id));
            }
            AnnotationAction::Create { path } => {
                // A failed link leaves the ordinary Note available for explicit relinking.
                let text = metadata::adopt("")?;
                super::capability::note_path(&path)?;
                let note = super::notes::document(&path, text);
                refs.push(json!({"kind": "note", "id": note.id}));
                created = Some(note);
            }
        }
        value["refs"] = Value::Array(refs);
        if created.is_none()
            && (previous.as_ref().is_some_and(|text| {
                metadata::companion_metadata(text).value.as_ref() == Some(&value)
            }) || (previous.is_none() && value["refs"].as_array().is_some_and(Vec::is_empty)))
        {
            return Ok(AnnotationChange {
                identity: target.identity,
                created: None,
            });
        }
        let text = companion_text(previous.as_deref(), &value)?;
        if text.len() as u64 > MAX_METADATA {
            return Err(VaultError::invalid("Companion metadata exceeds 256 KiB."));
        }
        if let Some(note) = &created {
            self.create_raw(&note.path, &note.text)?;
        }
        let result = self.write_companion(&request.path, &text, previous.as_deref(), || {
            self.annotation_target(&request.path, &request.expected_identity)
                .map(|_| ())
        });
        if let Err(mut error) = result {
            if let Some(note) = &created {
                error.message.push_str(&format!(" The new Note was preserved at {}. Link that existing Note after refreshing; it was not deleted.", note.path));
            }
            return Err(error);
        }
        Ok(AnnotationChange {
            identity: format!("uuid:{}", metadata::companion_metadata(&text).id.unwrap()),
            created,
        })
    }

    pub(super) fn write_companion(
        &self,
        path: &str,
        text: &str,
        previous: Option<&str>,
        before_write: impl FnOnce() -> VaultResult<()>,
    ) -> VaultResult<()> {
        if text.len() as u64 > MAX_METADATA {
            return Err(VaultError::invalid("Companion metadata exceeds 256 KiB."));
        }
        let companion = format!("{path}.meta.yaml");
        let original_identity = self.original_file_identity(path)?;
        let (dir, name) = self.parent(&companion, false)?;
        let staging = format!(".adamant-write-{}.meta.yaml", Uuid::new_v4());
        let file = write_new(&dir, Path::new(&staging), text.as_bytes())?;
        if previous.is_some() {
            file.set_permissions(dir.symlink_metadata(&name)?.permissions())?;
            file.sync_all()?;
        }
        if let Err(error) = self.ensure_current_manifest().and_then(|()| before_write()) {
            let _ = dir.remove_file(&staging);
            return Err(error);
        }
        if let Some(previous) = previous {
            let retained = self.retain(&companion, text.as_bytes(), "submitted")?;
            super::persistence::exchange(&dir, &staging, &name)?;
            sync_dir(&dir)?;
            let displaced = read_limited(&dir, Path::new(&staging), MAX_METADATA);
            let current = read_limited(&dir, &name, MAX_METADATA);
            if !displaced
                .as_ref()
                .is_ok_and(|bytes| bytes == previous.as_bytes())
                || !current.as_ref().is_ok_and(|bytes| bytes == text.as_bytes())
            {
                return Err(VaultError::conflict(
                    format!(
                        "An external writer raced the annotation change. The displaced version is retained beside the document as {staging}; the submitted version is retained at {}. Inspect both before continuing.",
                        retained.display()
                    ),
                    None,
                ));
            }
            std::fs::remove_file(retained)?;
        } else {
            if let Err(error) = dir.hard_link(&staging, &dir, &name) {
                let _ = dir.remove_file(&staging);
                return Err(VaultError::conflict(
                    format!(
                        "Could not create document metadata without overwriting an existing file: {error}. Refresh annotations."
                    ),
                    None,
                ));
            }
            sync_dir(&dir)?;
            if !self
                .original_file_identity(path)
                .is_ok_and(|identity| identity == original_identity)
            {
                // Detach the new association rather than adopt an externally replaced original.
                // A concurrent metadata writer's bytes are retained too; never overwrite them.
                let recovery = format!(".adamant-recovery-{}.meta.yaml", Uuid::new_v4());
                dir.rename(&name, &dir, &recovery)?;
                sync_dir(&dir)?;
                return Err(VaultError::conflict(
                    format!(
                        "The original was replaced while creating annotations. Metadata was detached and retained beside it as {recovery}; the submitted metadata is also retained as {staging}. Refresh the document before relinking."
                    ),
                    None,
                ));
            }
        }
        dir.remove_file(&staging)?;
        sync_dir(&dir)?;
        self.set_index_state(
            super::IndexState::Stale,
            Some("Annotations changed; awaiting indexing.".into()),
        );
        Ok(())
    }

    fn original_file_identity(&self, path: &str) -> VaultResult<String> {
        let (dir, name) = self.parent(path, false)?;
        let original = super::capability::open_regular(&dir, &name)?;
        navigation::target_identity(None, &original.metadata()?)
    }
}
