use super::{Fixture, Vault, fs, reconciled};
use crate::vault::{
    annotations::{AnnotationAction, AnnotationRequest, companion_text},
    navigation::navigation_target,
};
use serde_json::json;

fn change(
    f: &Fixture,
    document: &str,
    action: AnnotationAction,
) -> crate::vault::VaultResult<crate::vault::annotations::AnnotationChange> {
    let identity = navigation_target(&f.vault, document)?.identity;
    let snapshot = f.vault.annotations(document, &identity, "")?;
    f.vault.change_annotation(AnnotationRequest {
        path: document.into(),
        expected_identity: identity,
        expected_revision: snapshot.revision,
        action,
    })
}

#[test]
fn annotations_survive_note_moves_vault_relocation_and_unlink_keeps_sources() {
    let f = Fixture::new();
    fs::write(f.root.join("paper.pdf"), b"original PDF bytes").unwrap();
    f.reconcile();
    let identity = navigation_target(&f.vault, "paper.pdf").unwrap().identity;
    assert!(
        f.vault
            .annotations("paper.pdf", &identity, "")
            .unwrap()
            .links
            .is_empty()
    );
    assert!(!f.root.join("paper.pdf.meta.yaml").exists());
    let result = change(
        &f,
        "paper.pdf",
        AnnotationAction::Create {
            path: "notes/Reading.md".into(),
        },
    )
    .unwrap();
    let note = result.created.unwrap();
    let note_id = note.id.clone().unwrap();
    f.reconcile();
    assert_eq!(
        f.vault
            .annotations("notes/Reading.md", &format!("uuid:{note_id}"), "")
            .unwrap()
            .links[0]
            .path
            .as_deref(),
        Some("paper.pdf")
    );
    fs::rename(f.root.join("notes/Reading.md"), f.root.join("Renamed.md")).unwrap();
    f.reconcile();
    assert_eq!(
        f.vault
            .annotations("paper.pdf", &result.identity, "")
            .unwrap()
            .links[0]
            .path
            .as_deref(),
        Some("Renamed.md")
    );
    let moved = f.root.with_file_name("Moved Vault");
    fs::rename(&f.root, &moved).unwrap();
    let reopened = Vault::open(&moved, &f.state.with_file_name("another-machine")).unwrap();
    reconciled(&reopened);
    let snapshot = reopened
        .annotations("paper.pdf", &result.identity, "")
        .unwrap();
    assert_eq!(snapshot.links[0].path.as_deref(), Some("Renamed.md"));
    reopened
        .change_annotation(AnnotationRequest {
            path: "paper.pdf".into(),
            expected_identity: result.identity,
            expected_revision: snapshot.revision,
            action: AnnotationAction::Unlink { id: note_id },
        })
        .unwrap();
    assert_eq!(
        fs::read(moved.join("paper.pdf")).unwrap(),
        b"original PDF bytes"
    );
    assert_eq!(
        fs::read_to_string(moved.join("Renamed.md")).unwrap(),
        note.text
    );
}

#[test]
fn shared_notes_missing_targets_duplicate_ids_and_stale_metadata_are_explicit() {
    let f = Fixture::new();
    for path in ["a.pdf", "b.docx"] {
        fs::write(f.root.join(path), b"original").unwrap();
    }
    let note = f.vault.create_note("Note.md", "Reading notes\r\n").unwrap();
    let id = note.id.clone().unwrap();
    f.reconcile();
    change(&f, "a.pdf", AnnotationAction::Link { id: id.clone() }).unwrap();
    f.reconcile();
    change(&f, "b.docx", AnnotationAction::Link { id: id.clone() }).unwrap();
    f.reconcile();
    let sources = f
        .vault
        .annotations("Note.md", &format!("uuid:{id}"), "")
        .unwrap();
    assert_eq!(sources.links.len(), 2);
    let identity = navigation_target(&f.vault, "a.pdf").unwrap().identity;
    let before = f.vault.annotations("a.pdf", &identity, "").unwrap();
    let companion = f.root.join("a.pdf.meta.yaml");
    let changed = format!(
        "{}custom: external\n",
        fs::read_to_string(&companion).unwrap()
    );
    fs::write(&companion, &changed).unwrap();
    let error = f
        .vault
        .change_annotation(AnnotationRequest {
            path: "a.pdf".into(),
            expected_identity: identity.clone(),
            expected_revision: before.revision,
            action: AnnotationAction::Unlink { id: id.clone() },
        })
        .unwrap_err();
    assert_eq!(error.kind, "conflict");
    assert_eq!(fs::read_to_string(&companion).unwrap(), changed);
    fs::write(f.root.join("Duplicate.md"), &note.text).unwrap();
    f.reconcile();
    let ambiguous = f.vault.annotations("a.pdf", &identity, "").unwrap();
    assert!(ambiguous.links[0].path.is_none());
    assert!(
        ambiguous.links[0]
            .problem
            .as_ref()
            .unwrap()
            .contains("Duplicate")
    );
    assert!(change(&f, "b.docx", AnnotationAction::Link { id: id.clone() }).is_err());
    fs::remove_file(f.root.join("Duplicate.md")).unwrap();
    fs::remove_file(f.root.join("Note.md")).unwrap();
    f.reconcile();
    let missing = f.vault.annotations("a.pdf", &identity, "").unwrap();
    assert!(missing.links[0].path.is_none());
    change(&f, "a.pdf", AnnotationAction::Unlink { id }).unwrap();
    assert!(
        fs::read_to_string(&companion)
            .unwrap()
            .contains("custom: external")
    );
}

#[test]
fn reference_edits_preserve_unrelated_yaml_and_reject_unsafe_layouts() {
    let id = "11111111-1111-4111-8111-111111111111";
    let note = "22222222-2222-4222-8222-222222222222";
    for original in [
        format!("\u{feff}id: '{id}' # identity\r\ncustom: 'keep me' # exact\r\n"),
        format!("id: {id}\nrefs: [] # refs\ncustom: 'keep me' # exact\n"),
        format!("id: {id}\nrefs:\n  - kind: topic\n    id: {id}\ncustom: 'keep me' # exact\n"),
        format!("{{id: '{id}', custom: 'keep me'}}\n"),
    ] {
        let mut value = crate::vault::metadata::companion_metadata(&original)
            .value
            .unwrap();
        let mut refs = value
            .get("refs")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        refs.push(json!({"kind": "note", "id": note}));
        value["refs"] = json!(refs);
        let text = companion_text(Some(&original), &value).unwrap();
        assert!(text.contains("custom: 'keep me'"), "{text}");
        assert_eq!(
            crate::vault::metadata::companion_metadata(&text).value,
            Some(value)
        );
    }
}

#[test]
fn invalid_metadata_occupied_destinations_and_unsafe_paths_leave_files_intact() {
    let f = Fixture::new();
    fs::write(f.root.join("paper.pdf"), b"original").unwrap();
    f.vault.create_note("Existing.md", "keep me").unwrap();
    f.reconcile();
    assert!(
        change(
            &f,
            "paper.pdf",
            AnnotationAction::Create {
                path: "Existing.md".into()
            }
        )
        .is_err()
    );
    assert!(
        change(
            &f,
            "paper.pdf",
            AnnotationAction::Create {
                path: "../escape.md".into()
            }
        )
        .is_err()
    );
    assert!(!f.root.join("paper.pdf.meta.yaml").exists());
    fs::write(f.root.join("paper.pdf.meta.yaml"), "malformed: [").unwrap();
    assert!(
        change(
            &f,
            "paper.pdf",
            AnnotationAction::Create {
                path: "New.md".into()
            }
        )
        .is_err()
    );
    assert!(!f.root.join("New.md").exists());
    assert_eq!(
        fs::read_to_string(f.root.join("paper.pdf.meta.yaml")).unwrap(),
        "malformed: ["
    );
}

#[test]
fn companion_exchange_retains_external_writer_bytes() {
    let f = Fixture::new();
    fs::write(f.root.join("paper.pdf"), b"original").unwrap();
    let companion = f.root.join("paper.pdf.meta.yaml");
    fs::write(&companion, "old").unwrap();
    let error = f
        .vault
        .write_companion("paper.pdf", "submitted", Some("old"), || {
            fs::write(&companion, "external")?;
            Ok(())
        })
        .unwrap_err();
    assert_eq!(error.kind, "conflict");
    assert_eq!(fs::read_to_string(&companion).unwrap(), "submitted");
    let retained = fs::read_dir(&f.root)
        .unwrap()
        .filter_map(Result::ok)
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".adamant-write-")
        })
        .unwrap();
    assert_eq!(fs::read_to_string(retained.path()).unwrap(), "external");
    assert!(f.recovery_sources().contains(&"submitted".to_owned()));
}

#[test]
fn partial_inventory_allows_new_annotations_and_unlink_but_not_existing_identity_links() {
    let f = Fixture::new();
    fs::write(f.root.join("paper.pdf"), b"original").unwrap();
    f.reconcile();
    f.vault.set_index_state(
        crate::vault::IndexState::Partial,
        Some("Fixture traversal limit".into()),
    );
    let created = change(
        &f,
        "paper.pdf",
        AnnotationAction::Create {
            path: "New.md".into(),
        },
    )
    .unwrap()
    .created
    .unwrap();
    let id = created.id.unwrap();
    f.vault
        .set_index_state(crate::vault::IndexState::Partial, None);
    assert!(change(&f, "paper.pdf", AnnotationAction::Link { id: id.clone() }).is_err());
    change(&f, "paper.pdf", AnnotationAction::Unlink { id }).unwrap();
    assert!(f.root.join("New.md").exists());
    assert_eq!(fs::read(f.root.join("paper.pdf")).unwrap(), b"original");
}

#[test]
fn duplicate_note_backlinks_are_rejected_and_non_note_kinds_cannot_be_annotations() {
    let f = Fixture::new();
    fs::write(f.root.join("paper.pdf"), b"original").unwrap();
    let note = f.vault.create_note("Note.md", "").unwrap();
    let id = note.id.clone().unwrap();
    let topic = f.vault.create_note("Topic.md", "").unwrap();
    fs::write(
        f.root.join("Topic.md"),
        topic.text.replace("kind: note", "kind: topic"),
    )
    .unwrap();
    f.reconcile();
    let identity = navigation_target(&f.vault, "paper.pdf").unwrap().identity;
    let snapshot = f.vault.annotations("paper.pdf", &identity, "").unwrap();
    assert_eq!(snapshot.candidates.len(), 1);
    assert!(
        change(
            &f,
            "paper.pdf",
            AnnotationAction::Link {
                id: topic.id.unwrap()
            }
        )
        .is_err()
    );
    change(&f, "paper.pdf", AnnotationAction::Link { id: id.clone() }).unwrap();
    fs::write(f.root.join("Duplicate.md"), note.text).unwrap();
    f.reconcile();
    assert!(
        f.vault
            .annotations("Note.md", &format!("uuid:{id}"), "")
            .is_err()
    );
    assert!(
        f.vault
            .annotations("Duplicate.md", &format!("uuid:{id}"), "")
            .is_err()
    );
}

#[test]
fn annotation_responses_are_bounded_and_search_reaches_links_beyond_the_cap() {
    let f = Fixture::new();
    let note = f.vault.create_note("Note.md", "").unwrap();
    let note_id = note.id.unwrap();
    let ids: Vec<_> = (0..105).map(|_| uuid::Uuid::new_v4().to_string()).collect();
    for (index, id) in ids.iter().enumerate() {
        fs::write(f.root.join(format!("paper-{index:03}.pdf")), b"original").unwrap();
        fs::write(
            f.root.join(format!("paper-{index:03}.pdf.meta.yaml")),
            format!("id: {id}\nrefs: [{{kind: note, id: {note_id}}}]\n"),
        )
        .unwrap();
    }
    let refs = ids
        .iter()
        .map(|id| json!({"kind": "note", "id": id}))
        .collect::<Vec<_>>();
    fs::write(f.root.join("many.pdf"), b"original").unwrap();
    let many_id = uuid::Uuid::new_v4().to_string();
    fs::write(
        f.root.join("many.pdf.meta.yaml"),
        format!(
            "id: {many_id}\nrefs: {}\n",
            serde_json::to_string(&refs).unwrap()
        ),
    )
    .unwrap();
    f.reconcile();
    let forward = f
        .vault
        .annotations("many.pdf", &format!("uuid:{many_id}"), "")
        .unwrap();
    assert_eq!(forward.links.len(), 100);
    assert!(forward.more_links);
    let found = f
        .vault
        .annotations("many.pdf", &format!("uuid:{many_id}"), &ids[104])
        .unwrap();
    assert_eq!(found.links.len(), 1);
    assert!(!found.more_links);
    let backlinks = f
        .vault
        .annotations("Note.md", &format!("uuid:{note_id}"), "")
        .unwrap();
    assert_eq!(backlinks.links.len(), 100);
    assert!(backlinks.more_links);
    let found = f
        .vault
        .annotations("Note.md", &format!("uuid:{note_id}"), "paper-104")
        .unwrap();
    assert_eq!(found.links[0].path.as_deref(), Some("paper-104.pdf"));
    assert!(!found.more_links);
}

#[test]
fn first_companion_is_detached_if_original_changes_at_publication() {
    let f = Fixture::new();
    fs::write(f.root.join("paper.pdf"), b"original").unwrap();
    let error = f
        .vault
        .write_companion("paper.pdf", "submitted", None, || {
            fs::rename(f.root.join("paper.pdf"), f.root.join("moved.pdf"))?;
            fs::write(f.root.join("paper.pdf"), b"replacement")?;
            Ok(())
        })
        .unwrap_err();
    assert_eq!(error.kind, "conflict");
    assert!(!f.root.join("paper.pdf.meta.yaml").exists());
    assert_eq!(fs::read(f.root.join("paper.pdf")).unwrap(), b"replacement");
    assert_eq!(fs::read(f.root.join("moved.pdf")).unwrap(), b"original");
    let retained = fs::read_dir(&f.root)
        .unwrap()
        .filter_map(Result::ok)
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".adamant-recovery-")
        })
        .unwrap();
    assert_eq!(fs::read_to_string(retained.path()).unwrap(), "submitted");
}
