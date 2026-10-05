use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use super::{
    IndexStatus, NoteDocument, Vault, VaultError, VaultResult, hash, metadata, navigation,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TagSnapshot {
    pub identity: Option<String>,
    pub revision: Option<String>,
    pub tags: Vec<String>,
    pub suggestions: Vec<String>,
    pub folders: Vec<String>,
    pub more_suggestions: bool,
    pub more_folders: bool,
    pub indexing: IndexStatus,
    pub problem: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TagRequest {
    pub path: String,
    pub expected_identity: String,
    pub expected_revision: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TagChange {
    pub identity: String,
    pub note: Option<NoteDocument>,
}

pub(super) fn metadata_tags(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(|value| value.get("tags"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

pub(super) fn validated_tags(tags: &[String]) -> VaultResult<Vec<String>> {
    if tags.len() > 64
        || tags.iter().any(|tag| {
            tag.is_empty()
                || tag.len() > 128
                || tag.trim() != tag
                || tag.chars().any(char::is_control)
        })
    {
        return Err(VaultError::invalid(
            "Use at most 64 tags, each containing 1–128 UTF-8 bytes, without control characters or surrounding whitespace.",
        ));
    }
    let mut unique = Vec::new();
    for tag in tags {
        if !unique.contains(tag) {
            unique.push(tag.clone());
        }
    }
    Ok(unique)
}

impl Vault {
    fn tag_target(&self, path: &str, identity: &str) -> VaultResult<navigation::NavigationTarget> {
        let target = navigation::navigation_target(self, path)?;
        if target.identity != identity {
            return Err(VaultError::conflict(
                "The document identity changed. Reopen it before editing tags.",
                None,
            ));
        }
        if !matches!(target.entry.kind, "markdown" | "pdf" | "docx") {
            return Err(VaultError::invalid(
                "Tags belong to Markdown, PDF or DOCX documents.",
            ));
        }
        Ok(target)
    }

    pub(crate) fn tags(
        &self,
        path: Option<&str>,
        expected_identity: Option<&str>,
        query: &str,
    ) -> VaultResult<TagSnapshot> {
        self.ensure_current_manifest()?;
        if query.len() > 4096 {
            return Err(VaultError::invalid("Tag search is limited to 4096 bytes."));
        }
        let mut snapshot = self.tag_facets(query);
        let Some(path) = path else {
            return Ok(snapshot);
        };
        let identity = expected_identity
            .ok_or_else(|| VaultError::invalid("A verified document identity is required."))?;
        let mut target = self.tag_target(path, identity)?;
        snapshot.identity = Some(target.identity.clone());
        let text = if target.entry.kind == "markdown" {
            Some(
                String::from_utf8(target.read_bytes()?)
                    .map_err(|_| VaultError::invalid("The Note is not UTF-8."))?,
            )
        } else {
            self.read_companion(path)?
        };
        if let Some(text) = text {
            let parsed = if target.entry.kind == "markdown" {
                metadata::note_metadata(&text)
            } else {
                metadata::companion_metadata(&text)
            };
            if parsed.id != target.entry.id {
                return Err(VaultError::conflict(
                    "Document metadata changed while reading. Refresh its tags.",
                    None,
                ));
            }
            snapshot.revision = Some(hash(text.as_bytes()));
            snapshot.tags = metadata_tags(parsed.value.as_ref());
            snapshot.problem = parsed.error;
        }
        Ok(snapshot)
    }

    pub(crate) fn set_tags(&self, request: TagRequest) -> VaultResult<TagChange> {
        let tags = validated_tags(&request.tags)?;
        let _identity = self
            .identity_writes
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.ensure_no_pending_mutations()?;
        let target = self.tag_target(&request.path, &request.expected_identity)?;
        if let Some(error) = &target.entry.metadata_error {
            return Err(VaultError::invalid(format!(
                "Repair or adopt document metadata before editing tags: {error}"
            )));
        }
        if target.entry.kind == "markdown" {
            let response = target.into_response(true)?;
            let note = response
                .note
                .ok_or_else(|| VaultError::invalid("Missing Note source."))?;
            if request.expected_revision.as_deref() != Some(note.revision.as_str()) {
                return Err(VaultError::conflict(
                    "The Note changed on disk. Refresh before editing tags.",
                    Some(note),
                ));
            }
            if metadata_tags(metadata::note_metadata(&note.text).value.as_ref()) == tags {
                return Ok(TagChange {
                    identity: response.target.identity,
                    note: Some(note),
                });
            }
            let text = metadata::tagged_note(&note.text, &tags)?;
            let saved = self.save_note_inner(&request.path, &text, &note.revision, || {})?;
            return Ok(TagChange {
                identity: response.target.identity,
                note: Some(saved),
            });
        }
        let previous = self.read_companion(&request.path)?;
        if previous.as_ref().map(|text| hash(text.as_bytes())) != request.expected_revision {
            return Err(VaultError::conflict(
                "Document metadata changed on disk. Refresh before editing tags.",
                None,
            ));
        }
        let mut value = match &previous {
            Some(text) => {
                let parsed = metadata::companion_metadata(text);
                if parsed.error.is_some() || parsed.id != target.entry.id {
                    return Err(VaultError::invalid(
                        "Document metadata changed or is invalid.",
                    ));
                }
                parsed
                    .value
                    .ok_or_else(|| VaultError::invalid("Missing companion metadata."))?
            }
            None => json!({"id": Uuid::new_v4().to_string()}),
        };
        if metadata_tags(Some(&value)) == tags {
            return Ok(TagChange {
                identity: target.identity,
                note: None,
            });
        }
        value["tags"] = json!(tags);
        let text = match previous.as_deref() {
            Some(previous) => super::annotations::sequence_field_text(previous, "tags", &value)?,
            None => format!(
                "id: {}\ntags: {}\n",
                value["id"].as_str().unwrap(),
                value["tags"]
            ),
        };
        self.write_companion(&request.path, &text, previous.as_deref(), || {
            self.tag_target(&request.path, &request.expected_identity)
                .map(|_| ())
        })?;
        Ok(TagChange {
            identity: format!("uuid:{}", value["id"].as_str().unwrap()),
            note: None,
        })
    }
}
