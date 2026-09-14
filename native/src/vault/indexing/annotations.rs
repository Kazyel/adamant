use super::IndexedEntry;
use serde_json::Value;

use crate::vault::{
    Vault, VaultEntry, VaultError, VaultResult,
    annotations::{AnnotationLink, AnnotationSnapshot},
};

fn ordinary_note(row: &IndexedEntry) -> bool {
    row.entry.kind == "markdown"
        && row
            .metadata
            .as_ref()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .is_some_and(|value| super::super::annotations::ordinary_note(&value))
}

impl Vault {
    pub(crate) fn annotation_identity_path(&self, id: &str) -> VaultResult<Option<VaultEntry>> {
        self.ensure_current_manifest()?;
        let inventory = self.inventory();
        if !inventory.complete || inventory.status.state != super::IndexState::Ready {
            return Err(VaultError::invalid(
                "Linking an existing Note requires a complete, ready inventory. Reconcile the Vault first.",
            ));
        }
        let Some(paths) = inventory.identities.get(id) else {
            return Ok(None);
        };
        if paths.len() != 1 {
            return Err(VaultError::invalid(
                "This identity occurs more than once in the Vault. Resolve the duplicate before linking.",
            ));
        }
        Ok(paths
            .iter()
            .next()
            .and_then(|path| inventory.rows.get(path))
            .map(|row| row.entry.clone()))
    }

    pub(crate) fn annotation_inventory(
        &self,
        snapshot: &mut AnnotationSnapshot,
        note_id: Option<&str>,
        query: &str,
    ) -> VaultResult<()> {
        let inventory = self.inventory();
        snapshot.indexing = inventory.status.clone();
        let needle = query.to_lowercase();
        if let Some(id) = note_id {
            let mut seen = std::collections::HashSet::new();
            if inventory
                .identities
                .get(id)
                .is_some_and(|paths| paths.len() > 1)
            {
                return Err(VaultError::invalid(
                    "This Note UUID occurs more than once. Resolve the collision before viewing its source documents.",
                ));
            }
            snapshot.links = inventory
                .rows
                .values()
                .filter(|row| {
                    matches!(row.entry.kind, "pdf" | "docx")
                        && (row.entry.path.to_lowercase().contains(&needle)
                            || row.entry.id.as_ref().is_some_and(|id| id.contains(&needle)))
                        && row.entry.metadata_error.is_none()
                        && row
                            .metadata
                            .as_ref()
                            .and_then(|text| serde_json::from_str::<Value>(text).ok())
                            .and_then(|value| value.get("refs").and_then(Value::as_array).cloned())
                            .is_some_and(|refs| {
                                refs.iter().any(|reference| {
                                    super::super::annotations::note_reference_id(reference)
                                        .as_deref()
                                        == Some(id)
                                })
                            })
                })
                .filter_map(|row| {
                    row.entry.id.as_ref().map(|id| AnnotationLink {
                        id: id.clone(),
                        path: None,
                        problem: None,
                    })
                })
                .filter(|link| seen.insert(link.id.clone()))
                .take(101)
                .collect();
        }
        for link in &mut snapshot.links {
            match inventory.identities.get(&link.id) {
                Some(paths) if paths.len() == 1 => {
                    if let Some(row) = paths
                        .iter()
                        .next()
                        .and_then(|path| inventory.rows.get(path))
                    {
                        let correct_kind = if note_id.is_some() {
                            matches!(row.entry.kind, "pdf" | "docx")
                        } else {
                            ordinary_note(row)
                        };
                        if correct_kind && row.entry.metadata_error.is_none() {
                            link.path = Some(row.entry.path.clone());
                        } else {
                            link.problem = Some(
                                "The target has invalid metadata or a different document type."
                                    .into(),
                            );
                        }
                    }
                }
                Some(_) => {
                    link.problem = Some("Duplicate identity; resolve it in the Vault.".into())
                }
                None => link.problem = Some("Missing from the current inventory.".into()),
            }
        }
        snapshot
            .links
            .sort_by(|a, b| a.path.cmp(&b.path).then(a.id.cmp(&b.id)));
        snapshot.links.dedup_by(|a, b| a.id == b.id);
        let linked_ids = snapshot
            .links
            .iter()
            .map(|link| link.id.clone())
            .collect::<std::collections::HashSet<_>>();
        snapshot.links.retain(|link| {
            link.id.contains(&needle)
                || link
                    .path
                    .as_ref()
                    .is_some_and(|path| path.to_lowercase().contains(&needle))
        });
        snapshot.more_links = snapshot.links.len() > 100;
        snapshot.links.truncate(100);
        if note_id.is_some() {
            return Ok(());
        }
        let mut candidates = inventory.rows.values().filter(|row| {
            ordinary_note(row)
                && row.entry.metadata_error.is_none()
                && row.entry.path.to_lowercase().contains(&needle)
                && row.entry.id.as_ref().is_some_and(|id| {
                    inventory
                        .identities
                        .get(id)
                        .is_some_and(|paths| paths.len() == 1)
                        && !linked_ids.contains(id)
                })
        });
        snapshot.candidates = candidates
            .by_ref()
            .take(50)
            .filter_map(|row| {
                row.entry.id.as_ref().map(|id| AnnotationLink {
                    id: id.clone(),
                    path: Some(row.entry.path.clone()),
                    problem: None,
                })
            })
            .collect();
        snapshot.more_candidates = candidates.next().is_some();
        Ok(())
    }
}
