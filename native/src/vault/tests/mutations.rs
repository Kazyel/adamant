use std::fs;

use super::{Fixture, identified};
use crate::vault::mutations::{MutationKind, MutationRequest};

#[test]
fn trash_removes_surviving_markdown_links_and_metadata_references() {
    let fixture = Fixture::new();
    fixture.vault.create_folder("removed").unwrap();
    let gone = fixture
        .vault
        .create_note("removed/gone.md", "Gone")
        .unwrap();
    let kept = fixture.vault.create_note("kept.md", "Keep").unwrap();
    let document_id = uuid::Uuid::new_v4();
    fs::write(fixture.root.join("removed/paper.pdf"), b"original PDF").unwrap();
    fs::write(
        fixture.root.join("removed/paper.pdf.meta.yaml"),
        format!("id: {document_id}\n"),
    )
    .unwrap();
    let referrer = format!(
        "\u{feff}---\r\nid: {}\r\ncustom: 'keep spelling' # comment\r\nrefs:\r\n  - {{kind: note, id: {}}}\r\n  - {{kind: document, id: {document_id}}}\r\n  - {{kind: note, id: {}}}\r\n---\r\nBefore [Gone](removed/gone.md) [Paper](removed/paper.pdf) [Keep](kept.md).\r\n",
        uuid::Uuid::new_v4(),
        gone.id.as_ref().unwrap(),
        kept.id.as_ref().unwrap()
    );
    fs::write(fixture.root.join("referrer.md"), &referrer).unwrap();
    let companion = format!(
        "id: {}\r\ncustom: 'preserve me' # companion\r\nrefs: [{{kind: note, id: {}}}, {{kind: note, id: {}}}]\r\n",
        uuid::Uuid::new_v4(),
        gone.id.unwrap(),
        kept.id.unwrap()
    );
    fs::write(fixture.root.join("outside.docx"), b"original DOCX").unwrap();
    fs::write(fixture.root.join("outside.docx.meta.yaml"), &companion).unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Trash,
            paths: vec!["removed".into()],
            destination: None,
        })
        .unwrap();
    assert!(plan.affected_paths.contains(&"referrer.md".into()));
    assert!(plan.affected_paths.contains(&"outside.docx".into()));
    assert_eq!(
        fixture.vault.commit_mutation(&plan.id).unwrap().outcomes[0].status,
        "completed"
    );
    let changed = fs::read_to_string(fixture.root.join("referrer.md")).unwrap();
    assert!(changed.contains("custom: 'keep spelling' # comment\r\n"));
    assert!(changed.ends_with("Before Gone Paper [Keep](kept.md).\r\n"));
    let refs = super::super::metadata::note_metadata(&changed)
        .value
        .unwrap()["refs"]
        .clone();
    assert_eq!(refs.as_array().unwrap().len(), 1);
    let changed_companion =
        fs::read_to_string(fixture.root.join("outside.docx.meta.yaml")).unwrap();
    assert!(changed_companion.contains("custom: 'preserve me' # companion\r\n"));
    let refs = super::super::metadata::companion_metadata(&changed_companion)
        .value
        .unwrap()["refs"]
        .clone();
    assert_eq!(refs.as_array().unwrap().len(), 1);
    assert_eq!(
        fs::read(fixture.root.join("outside.docx")).unwrap(),
        b"original DOCX"
    );
}

#[test]
fn partial_trash_cleans_only_completed_targets_and_keeps_newer_sources() {
    let fixture = Fixture::new();
    fixture.vault.create_note("a.md", "A").unwrap();
    let b = fixture.vault.create_note("b.md", "B").unwrap();
    fixture
        .vault
        .create_note("referrer.md", "[A](a.md) [B](b.md)")
        .unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Trash,
            paths: vec!["a.md".into(), "b.md".into()],
            destination: None,
        })
        .unwrap();
    let path = fixture.root.join("b.md");
    let external = format!("{}External", b.text);
    let replacement = external.clone();
    crate::vault::mutations::before_move_to("stage-1", move || {
        fs::write(path, replacement).unwrap()
    });
    let result = fixture.vault.commit_mutation(&plan.id).unwrap();
    assert_eq!(result.outcomes[0].status, "completed");
    assert_eq!(result.outcomes[1].status, "failed");
    assert!(result.recovery_id.is_some());
    assert!(
        fixture
            .vault
            .read_note("referrer.md")
            .unwrap()
            .text
            .ends_with("A [B](b.md)")
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("b.md")).unwrap(),
        external
    );
    assert_eq!(
        fixture.vault.recover_mutation(&plan.id).unwrap().state,
        "conflicted"
    );
    assert!(
        fixture
            .vault
            .read_note("referrer.md")
            .unwrap()
            .text
            .ends_with("A [B](b.md)")
    );
}

#[test]
fn failed_selected_referrer_is_cleaned_and_recovery_preserves_its_original_payload() {
    let fixture = Fixture::new();
    let a = fixture.vault.create_note("a.md", "A").unwrap();
    let original_b = format!(
        "---\nid: {}\nrefs: [{{kind: note, id: {}}}]\n---\n[A](a.md)",
        uuid::Uuid::new_v4(),
        a.id.unwrap()
    );
    fs::write(fixture.root.join("b.md"), &original_b).unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Trash,
            paths: vec!["a.md".into(), "b.md".into()],
            destination: None,
        })
        .unwrap();
    let collision = fixture
        .root
        .join(format!(".adamant/transactions/{}/stage-1", plan.id));
    let collision_path = collision.clone();
    crate::vault::mutations::before_move_to("stage-1", move || {
        fs::write(collision_path, b"occupied staging").unwrap()
    });
    let result = fixture.vault.commit_mutation(&plan.id).unwrap();
    assert_eq!(result.outcomes[0].status, "completed");
    assert_eq!(result.outcomes[1].status, "failed");
    let surviving_b = fixture.vault.read_note("b.md").unwrap();
    assert!(surviving_b.text.ends_with("A"));
    let refs = super::super::metadata::note_metadata(&surviving_b.text)
        .value
        .unwrap()["refs"]
        .clone();
    assert_eq!(refs.as_array().unwrap().len(), 0);
    let blocked = fixture.vault.recover_mutation(&plan.id).unwrap();
    assert_eq!(blocked.state, "conflicted");
    assert_eq!(
        fixture.vault.read_note("b.md").unwrap().text,
        surviving_b.text
    );
    fs::remove_file(collision).unwrap();
    assert_eq!(
        fixture.vault.recover_mutation(&plan.id).unwrap().state,
        "recovered"
    );
    let trash_b = fixture
        .vault
        .list_trash()
        .unwrap()
        .into_iter()
        .find(|entry| entry.path == "b.md")
        .unwrap();
    assert_eq!(
        fs::read_to_string(
            fixture
                .root
                .join(format!(".adamant/trash/{}/payload/b.md", trash_b.id))
        )
        .unwrap(),
        original_b
    );
    assert!(fixture.vault.startup_recover().unwrap().is_empty());
}

#[test]
fn cleaned_selected_folder_recovery_rejects_untracked_writer_changes() {
    let fixture = Fixture::new();
    fixture.vault.create_note("a.md", "A").unwrap();
    fixture.vault.create_folder("b").unwrap();
    let original = fixture
        .vault
        .create_note("b/referrer.md", "[A](../a.md)")
        .unwrap();
    fs::write(fixture.root.join("b/unrelated.bin"), b"keep").unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Trash,
            paths: vec!["a.md".into(), "b".into()],
            destination: None,
        })
        .unwrap();
    let collision = fixture
        .root
        .join(format!(".adamant/transactions/{}/stage-1", plan.id));
    let collision_path = collision.clone();
    crate::vault::mutations::before_move_to("stage-1", move || {
        fs::write(collision_path, b"occupied staging").unwrap()
    });
    assert!(
        fixture
            .vault
            .commit_mutation(&plan.id)
            .unwrap()
            .recovery_id
            .is_some()
    );
    fs::remove_file(collision).unwrap();
    fs::write(fixture.root.join("b/unrelated.bin"), b"external change").unwrap();
    let denied = fixture.vault.recover_mutation(&plan.id).unwrap();
    assert_eq!(denied.state, "conflicted");
    assert!(
        denied.result.unwrap().outcomes[1]
            .message
            .as_ref()
            .unwrap()
            .contains("Newer source preserved")
    );
    assert_eq!(
        fs::read(fixture.root.join("b/unrelated.bin")).unwrap(),
        b"external change"
    );
    fs::write(fixture.root.join("b/unrelated.bin"), b"keep").unwrap();
    assert_eq!(
        fixture.vault.recover_mutation(&plan.id).unwrap().state,
        "recovered"
    );
    let trash = fixture
        .vault
        .list_trash()
        .unwrap()
        .into_iter()
        .find(|entry| entry.path == "b")
        .unwrap();
    assert_eq!(
        fs::read_to_string(
            fixture
                .root
                .join(format!(".adamant/trash/{}/payload/b/referrer.md", trash.id))
        )
        .unwrap(),
        original.text
    );
}

#[test]
fn cleaned_staging_recovery_preserves_a_recreated_public_source() {
    let fixture = Fixture::new();
    fixture.vault.create_note("a.md", "A").unwrap();
    fixture.vault.create_note("b.md", "[A](a.md)").unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Trash,
            paths: vec!["a.md".into(), "b.md".into()],
            destination: None,
        })
        .unwrap();
    let staging = fixture
        .root
        .join(format!(".adamant/transactions/{}/stage-1", plan.id));
    let collision = staging.clone();
    crate::vault::mutations::before_move_to("stage-1", move || {
        fs::write(collision, b"occupied staging").unwrap()
    });
    assert!(
        fixture
            .vault
            .commit_mutation(&plan.id)
            .unwrap()
            .recovery_id
            .is_some()
    );
    fs::remove_file(&staging).unwrap();
    fs::rename(fixture.root.join("b.md"), &staging).unwrap();
    let captured = fs::read(&staging).unwrap();
    fs::write(fixture.root.join("b.md"), b"external replacement").unwrap();
    assert_eq!(
        fixture.vault.recover_mutation(&plan.id).unwrap().state,
        "conflicted"
    );
    assert_eq!(
        fs::read(fixture.root.join("b.md")).unwrap(),
        b"external replacement"
    );
    assert_eq!(fs::read(staging).unwrap(), captured);
}

#[test]
fn interrupted_survivor_publication_resumes_only_its_journal_owned_capture() {
    let fixture = Fixture::new();
    fixture.vault.create_note("a.md", "A").unwrap();
    let original = fixture.vault.create_note("b.md", "[A](a.md)").unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Trash,
            paths: vec!["a.md".into(), "b.md".into()],
            destination: None,
        })
        .unwrap();
    let collision = fixture
        .root
        .join(format!(".adamant/transactions/{}/stage-1", plan.id));
    let collision_path = collision.clone();
    crate::vault::mutations::before_move_to("stage-1", move || {
        fs::write(collision_path, b"occupied staging").unwrap();
        crate::vault::mutations::before_move_to("b.md", || {
            panic!("interrupted survivor publication")
        });
    });
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fixture
            .vault
            .commit_mutation(&plan.id)))
        .is_err()
    );
    assert!(!fixture.root.join("b.md").exists());
    let captured = fixture.root.join(format!(
        ".adamant/transactions/{}/referrer-0.original",
        plan.id
    ));
    assert_eq!(fs::read_to_string(captured).unwrap(), original.text);
    fs::remove_file(collision).unwrap();
    assert_eq!(
        fixture.vault.recover_mutation(&plan.id).unwrap().state,
        "recovered"
    );
    let trash = fixture
        .vault
        .list_trash()
        .unwrap()
        .into_iter()
        .find(|entry| entry.path == "b.md")
        .unwrap();
    assert_eq!(
        fs::read_to_string(
            fixture
                .root
                .join(format!(".adamant/trash/{}/payload/b.md", trash.id))
        )
        .unwrap(),
        original.text
    );
    assert!(fixture.vault.startup_recover().unwrap().is_empty());
}

#[test]
fn interrupted_trash_resumes_incremental_reference_cleanup() {
    let fixture = Fixture::new();
    let a = fixture.vault.create_note("a.md", "A").unwrap();
    let b = fixture.vault.create_note("b.md", "B").unwrap();
    let source = format!(
        "---\nid: {}\nrefs: [{{kind: note, id: {}}}, {{kind: note, id: {}}}]\n---\n[A](a.md) [B](b.md)",
        uuid::Uuid::new_v4(),
        a.id.unwrap(),
        b.id.unwrap()
    );
    fs::write(fixture.root.join("referrer.md"), source).unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Trash,
            paths: vec!["a.md".into(), "b.md".into()],
            destination: None,
        })
        .unwrap();
    crate::vault::mutations::before_move_to("stage-1", || panic!("interrupted next item"));
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fixture
            .vault
            .commit_mutation(&plan.id)))
        .is_err()
    );
    let partial = fixture.vault.read_note("referrer.md").unwrap();
    assert!(partial.text.ends_with("A [B](b.md)"));
    let refs = super::super::metadata::note_metadata(&partial.text)
        .value
        .unwrap()["refs"]
        .clone();
    assert_eq!(refs.as_array().unwrap().len(), 1);
    assert_eq!(
        fixture.vault.recover_mutation(&plan.id).unwrap().state,
        "recovered"
    );
    let complete = fixture.vault.read_note("referrer.md").unwrap();
    assert!(complete.text.ends_with("A B"));
    let refs = super::super::metadata::note_metadata(&complete.text)
        .value
        .unwrap()["refs"]
        .clone();
    assert_eq!(refs.as_array().unwrap().len(), 0);
}

#[test]
fn trash_retains_uuid_references_when_a_duplicate_file_survives() {
    let fixture = Fixture::new();
    let a = fixture.vault.create_note("a.md", "A").unwrap();
    fs::write(fixture.root.join("duplicate.md"), &a.text).unwrap();
    let source = format!(
        "---\nid: {}\nrefs: [{{kind: note, id: {}}}]\n---\n[A](a.md) [Duplicate](duplicate.md)",
        uuid::Uuid::new_v4(),
        a.id.unwrap()
    );
    fs::write(fixture.root.join("referrer.md"), &source).unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Trash,
            paths: vec!["a.md".into()],
            destination: None,
        })
        .unwrap();
    assert_eq!(
        fixture.vault.commit_mutation(&plan.id).unwrap().outcomes[0].status,
        "completed"
    );
    let changed = fixture.vault.read_note("referrer.md").unwrap();
    assert_eq!(changed.text, source.replace("[A](a.md)", "A"));
}

#[test]
fn trash_refuses_unsafe_metadata_and_changed_referrers_before_removal() {
    let fixture = Fixture::new();
    let a = fixture.vault.create_note("a.md", "A").unwrap();
    let unsafe_source = format!(
        "---\nid: {}\nshared: &links [{{kind: note, id: {}}}]\nrefs: *links\n---\nBody",
        uuid::Uuid::new_v4(),
        a.id.unwrap()
    );
    fs::write(fixture.root.join("referrer.md"), &unsafe_source).unwrap();
    let request = MutationRequest {
        kind: MutationKind::Trash,
        paths: vec!["a.md".into()],
        destination: None,
    };
    assert!(fixture.vault.prepare_mutation(request.clone()).is_err());
    assert_eq!(
        fs::read_to_string(fixture.root.join("a.md")).unwrap(),
        a.text
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("referrer.md")).unwrap(),
        unsafe_source
    );
    fs::write(fixture.root.join("referrer.md"), "[A](a.md)").unwrap();
    let plan = fixture.vault.prepare_mutation(request).unwrap();
    fs::write(fixture.root.join("referrer.md"), "[A](a.md) External").unwrap();
    assert_eq!(
        fixture.vault.commit_mutation(&plan.id).unwrap_err().kind,
        "conflict"
    );
    assert!(fixture.root.join("a.md").exists());
    assert_eq!(
        fs::read_to_string(fixture.root.join("referrer.md")).unwrap(),
        "[A](a.md) External"
    );
}

#[test]
fn duplicate_gets_a_new_identity_and_preserves_source_bytes() {
    let fixture = Fixture::new();
    let original = fixture
        .vault
        .create_note("source.md", &identified("# Source\n"))
        .unwrap();
    let before = fs::read(fixture.root.join("source.md")).unwrap();
    fixture.vault.create_folder("copies").unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Duplicate,
            paths: vec!["source.md".into()],
            destination: Some("copies".into()),
        })
        .unwrap();
    let result = fixture.vault.commit_mutation(&plan.id).unwrap();
    assert_eq!(result.outcomes[0].status, "completed");
    let duplicate = fixture.vault.read_note("copies/source.md").unwrap();
    assert_ne!(duplicate.id, original.id);
    assert_eq!(fs::read(fixture.root.join("source.md")).unwrap(), before);
}

#[test]
fn trash_is_recoverable_and_does_not_overwrite_a_restore_collision() {
    let fixture = Fixture::new();
    fixture
        .vault
        .create_note("trash-me.md", &identified("# Keep\n"))
        .unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Trash,
            paths: vec!["trash-me.md".into()],
            destination: None,
        })
        .unwrap();
    let result = fixture.vault.commit_mutation(&plan.id).unwrap();
    assert_eq!(result.outcomes[0].status, "completed");
    let entries = fixture.vault.list_trash().unwrap();
    assert_eq!(entries.len(), 1);
    let new_text = identified("# New\n");
    fixture.reconcile();
    fixture.vault.create_note("trash-me.md", &new_text).unwrap();
    let blocked = fixture.vault.restore_trash(&entries[0].id, None).unwrap();
    assert_eq!(blocked.outcomes[0].status, "failed");
    assert_eq!(
        fixture.vault.read_note("trash-me.md").unwrap().text,
        new_text
    );
}

#[test]
fn stale_plan_refuses_external_change_without_touching_source() {
    let fixture = Fixture::new();
    let text = identified("# Original\n");
    fixture.vault.create_note("race.md", &text).unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Rename,
            paths: vec!["race.md".into()],
            destination: Some("renamed.md".into()),
        })
        .unwrap();
    fs::write(
        fixture.root.join("race.md"),
        text.replace("Original", "External"),
    )
    .unwrap();
    let error = fixture.vault.commit_mutation(&plan.id).unwrap_err();
    assert_eq!(error.kind, "conflict");
    assert_eq!(
        fs::read_to_string(fixture.root.join("race.md")).unwrap(),
        text.replace("Original", "External")
    );
    assert!(!fixture.root.join("renamed.md").exists());
}

#[test]
fn distinct_case_destination_is_never_overwritten() {
    let fixture = Fixture::new();
    fixture
        .vault
        .create_note("A.md", &identified("# A\n"))
        .unwrap();
    let existing = identified("# Existing\n");
    fixture.reconcile();
    fixture.vault.create_note("a.md", &existing).unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Rename,
            paths: vec!["A.md".into()],
            destination: Some("a.md".into()),
        })
        .unwrap();
    assert!(!plan.conflicts.is_empty());
    assert!(fixture.vault.commit_mutation(&plan.id).is_err());
    assert!(fixture.root.join("A.md").exists());
    assert_eq!(
        fs::read_to_string(fixture.root.join("a.md")).unwrap(),
        existing
    );
}

#[test]
fn companion_moves_as_one_logical_item() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("paper.pdf"), b"pdf bytes").unwrap();
    fs::write(fixture.root.join("paper.pdf.meta.yaml"), b"kind: pdf\n").unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Rename,
            paths: vec!["paper.pdf".into()],
            destination: Some("renamed.pdf".into()),
        })
        .unwrap();
    fixture.vault.commit_mutation(&plan.id).unwrap();
    assert!(!fixture.root.join("paper.pdf").exists());
    assert_eq!(
        fs::read(fixture.root.join("renamed.pdf")).unwrap(),
        b"pdf bytes"
    );
    assert_eq!(
        fs::read(fixture.root.join("renamed.pdf.meta.yaml")).unwrap(),
        b"kind: pdf\n"
    );
    assert!(!fixture.root.join("paper.pdf.meta.yaml").exists());
}

#[test]
fn duplicate_replaces_id_after_yaml_whitespace_without_reformatting() {
    let fixture = Fixture::new();
    let source = "---\r\nid:   11111111-1111-4111-8111-111111111111  # keep\r\n---\r\nbody\r\n";
    fixture.vault.create_note("source.md", source).unwrap();
    fixture.vault.create_folder("copies").unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Duplicate,
            paths: vec!["source.md".into()],
            destination: Some("copies".into()),
        })
        .unwrap();
    fixture.vault.commit_mutation(&plan.id).unwrap();
    let duplicate = fixture.vault.read_note("copies/source.md").unwrap();
    let fresh = duplicate.id.unwrap();
    assert_ne!(fresh, "11111111-1111-4111-8111-111111111111");
    assert_eq!(
        duplicate.text,
        source.replace("11111111-1111-4111-8111-111111111111", &fresh)
    );
}
#[test]
fn interrupted_move_exposes_recoverable_record_without_overwrite() {
    let fixture = Fixture::new();
    fixture
        .vault
        .create_note("one.md", &identified("# One\n"))
        .unwrap();
    fixture.reconcile();
    fixture
        .vault
        .create_note("two.md", &identified("# Two\n"))
        .unwrap();
    fs::create_dir(fixture.root.join("moved")).unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Move,
            paths: vec!["one.md".into(), "two.md".into()],
            destination: Some("moved".into()),
        })
        .unwrap();
    let collision = fixture.root.join("moved/two.md");
    crate::vault::mutations::before_move_to("moved/two.md", move || {
        fs::write(collision, b"external").unwrap()
    });
    let result = fixture.vault.commit_mutation(&plan.id).unwrap();
    assert_eq!(result.recovery_id.as_deref(), Some(plan.id.as_str()));
    assert!(
        result
            .mappings
            .iter()
            .all(|mapping| mapping.from == "one.md")
    );
    assert!(
        result
            .mappings
            .iter()
            .any(|mapping| mapping.to == "moved/one.md")
    );
    assert_eq!(result.outcomes[0].status, "completed");
    assert_eq!(result.outcomes[1].status, "failed");
    let reopened = crate::vault::Vault::open(&fixture.root, &fixture.state).unwrap();
    let records = reopened.startup_recover().unwrap();
    let record = records.iter().find(|record| record.id == plan.id).unwrap();
    assert_eq!(record.state, "conflicted");
    let recovered = record.result.as_ref().unwrap();
    assert_eq!(recovered.recovery_id.as_deref(), Some(plan.id.as_str()));
    assert_eq!(recovered.outcomes[0].status, "completed");
    assert_eq!(recovered.outcomes[1].status, "failed");
    assert_eq!(recovered.mappings.len(), 1);
    let mapping = &recovered.mappings[0];
    assert_eq!(mapping.from, "one.md");
    assert_eq!(mapping.to, "moved/one.md");
    assert_eq!(mapping.id, reopened.read_note("moved/one.md").unwrap().id);
    assert_eq!(
        fs::read(fixture.root.join("moved/two.md")).unwrap(),
        b"external"
    );
}

#[test]
fn crash_after_capture_recovers_the_journaled_source_and_mappings() {
    let fixture = Fixture::new();
    let text = identified("# Original\n");
    fixture.vault.create_note("source.md", &text).unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Rename,
            paths: vec!["source.md".into()],
            destination: Some("target.md".into()),
        })
        .unwrap();
    crate::vault::mutations::before_move_to("target.md", || {
        panic!("simulated process interruption")
    });
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fixture
            .vault
            .commit_mutation(&plan.id)))
        .is_err()
    );
    assert!(!fixture.root.join("source.md").exists());
    assert_eq!(
        fs::read_to_string(
            fixture
                .root
                .join(format!(".adamant/transactions/{}/stage-0", plan.id))
        )
        .unwrap(),
        text
    );
    let recovery = fixture.vault.recover_mutation(&plan.id).unwrap();
    assert_eq!(recovery.state, "recovered");
    assert_eq!(
        fs::read_to_string(fixture.root.join("target.md")).unwrap(),
        text
    );
    let result = recovery.result.unwrap();
    assert!(
        result
            .mappings
            .iter()
            .any(|mapping| mapping.from == "source.md" && mapping.to == "target.md")
    );
    assert!(result.affected_paths.contains(&"source.md".to_owned()));
}

#[test]
fn a_newer_source_at_the_capture_boundary_is_not_replaced() {
    let fixture = Fixture::new();
    let original = identified("# Original\n");
    fixture.vault.create_note("source.md", &original).unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Rename,
            paths: vec!["source.md".into()],
            destination: Some("target.md".into()),
        })
        .unwrap();
    let path = fixture.root.join("source.md");
    let newer = original.replace("Original", "External");
    let external = newer.clone();
    crate::vault::mutations::before_move_to("stage-0", move || fs::write(path, external).unwrap());
    let result = fixture.vault.commit_mutation(&plan.id).unwrap();
    assert!(result.recovery_id.is_some());
    assert!(result.mappings.is_empty());
    assert_eq!(
        fs::read_to_string(fixture.root.join("source.md")).unwrap(),
        newer
    );
    assert!(!fixture.root.join("target.md").exists());
}

#[test]
fn interrupted_companion_publication_can_resume_without_orphaning_either_member() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("paper.pdf"), b"PDF original").unwrap();
    fs::write(
        fixture.root.join("paper.pdf.meta.yaml"),
        b"id: 11111111-1111-4111-8111-111111111111\n",
    )
    .unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Rename,
            paths: vec!["paper.pdf.meta.yaml".into()],
            destination: Some("renamed.pdf".into()),
        })
        .unwrap();
    crate::vault::mutations::before_move_to("renamed.pdf.meta.yaml", || {
        panic!("interrupted between pair members")
    });
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fixture
            .vault
            .commit_mutation(&plan.id)))
        .is_err()
    );
    assert_eq!(
        fs::read(fixture.root.join("renamed.pdf")).unwrap(),
        b"PDF original"
    );
    let recovered = fixture.vault.recover_mutation(&plan.id).unwrap();
    assert_eq!(recovered.state, "recovered");
    assert_eq!(
        fs::read(fixture.root.join("renamed.pdf.meta.yaml")).unwrap(),
        b"id: 11111111-1111-4111-8111-111111111111\n"
    );
    assert!(!fixture.root.join("paper.pdf").exists());
    assert!(!fixture.root.join("paper.pdf.meta.yaml").exists());
}

#[test]
fn duplicate_preserves_quoted_root_identity_layout_and_remaps_subtree_references() {
    let fixture = Fixture::new();
    fixture.vault.create_folder("copies").unwrap();
    fixture.vault.create_folder("project/sub").unwrap();
    let first = "11111111-1111-4111-8111-111111111111";
    let second = "22222222-2222-4222-8222-222222222222";
    let document = "33333333-3333-4333-8333-333333333333";
    let external = "44444444-4444-4444-8444-444444444444";
    let a = format!(
        "\u{feff}---\r\nnested:\n  id: {external}\r\nid:   '{first}' # keep\r\nrefs: [{{kind: note, id: \"{second}\"}}, {{kind: document, id: '{document}'}}, {{kind: note, id: {external}}}]\r\n---\n[B](sub/b.md) [outside](../outside.md)\r\n"
    );
    let b =
        format!("---\nid: {second}\nrefs:\n  - kind: note\n    id: {first}\n---\n[A](../a.md)\n");
    fixture.vault.create_note("project/a.md", &a).unwrap();
    fixture.reconcile();
    fixture.vault.create_note("project/sub/b.md", &b).unwrap();
    fs::write(
        fixture.root.join("project/.hidden.bin"),
        b"unsupported\0bytes",
    )
    .unwrap();
    fs::write(fixture.root.join("project/sub/paper.pdf"), b"PDF bytes").unwrap();
    let companion = format!("id: '{document}' # exact\nrefs: [{{kind: note, id: '{first}'}}]\n");
    fs::write(
        fixture.root.join("project/sub/paper.pdf.meta.yaml"),
        &companion,
    )
    .unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Duplicate,
            paths: vec!["project".into(), "project/sub/b.md".into()],
            destination: Some("copies".into()),
        })
        .unwrap();
    assert_eq!(plan.items.len(), 1);
    let result = fixture.vault.commit_mutation(&plan.id).unwrap();
    assert!(result.recovery_id.is_none());
    let a_copy = fixture.vault.read_note("copies/project/a.md").unwrap();
    let b_copy = fixture.vault.read_note("copies/project/sub/b.md").unwrap();
    let companion_copy =
        fs::read_to_string(fixture.root.join("copies/project/sub/paper.pdf.meta.yaml")).unwrap();
    let doc_id = crate::vault::metadata::companion_metadata(&companion_copy)
        .id
        .unwrap();
    let new_a = a_copy.id.unwrap();
    let new_b = b_copy.id.unwrap();
    assert_eq!(
        a_copy.text,
        a.replace(first, &new_a)
            .replace(second, &new_b)
            .replace(document, &doc_id)
            .replace("../outside.md", "../../outside.md")
    );
    assert_eq!(
        b_copy.text,
        b.replace(first, &new_a).replace(second, &new_b)
    );
    assert_eq!(
        companion_copy,
        companion.replace(first, &new_a).replace(document, &doc_id)
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("project/a.md")).unwrap(),
        a
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("project/sub/b.md")).unwrap(),
        b
    );
    assert_eq!(
        fs::read(fixture.root.join("copies/project/.hidden.bin")).unwrap(),
        b"unsupported\0bytes"
    );
    assert_eq!(
        fs::read(fixture.root.join("copies/project/sub/paper.pdf")).unwrap(),
        b"PDF bytes"
    );
}

#[test]
fn link_rewrite_touches_only_parser_recognized_destinations() {
    let fixture = Fixture::new();
    fixture.vault.create_folder("moved").unwrap();
    fixture
        .vault
        .create_note("B (日本).md", &identified("# B\n"))
        .unwrap();
    let body = "[B (日本).md](<B%20(%E6%97%A5%E6%9C%AC).md> \"title\")\r\n![image](/B%20(%E6%97%A5%E6%9C%AC).md#part)\n[ref][b]\n\n[b]: <B%20(%E6%97%A5%E6%9C%AC).md> 'keep'\n\n`[code](B%20(%E6%97%A5%E6%9C%AC).md)`\n````\n[b]: B%20(%E6%97%A5%E6%9C%AC).md\n````\n<a href=\"B%20(%E6%97%A5%E6%9C%AC).md\">raw</a>\n[external](https://example.com/B.md)\n";
    let source = identified(body);
    fixture.reconcile();
    fixture.vault.create_note("a.md", &source).unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Move,
            paths: vec!["B (日本).md".into()],
            destination: Some("moved".into()),
        })
        .unwrap();
    assert!(plan.affected_paths.contains(&"a.md".to_owned()));
    let result = fixture.vault.commit_mutation(&plan.id).unwrap();
    assert!(result.recovery_id.is_none());
    let expected = source
        .replace(
            "](<B%20(%E6%97%A5%E6%9C%AC).md>",
            "](<moved/B%20%28%E6%97%A5%E6%9C%AC%29.md>",
        )
        .replace(
            "](/B%20(%E6%97%A5%E6%9C%AC).md#part)",
            "](/moved/B%20%28%E6%97%A5%E6%9C%AC%29.md#part)",
        )
        .replace(
            "[b]: <B%20(%E6%97%A5%E6%9C%AC).md>",
            "[b]: <moved/B%20%28%E6%97%A5%E6%9C%AC%29.md>",
        );
    assert_eq!(fixture.vault.read_note("a.md").unwrap().text, expected);
}

#[test]
fn a_new_referrer_invalidates_preflight_before_any_move() {
    let fixture = Fixture::new();
    fixture
        .vault
        .create_note("target.md", &identified("# Target\n"))
        .unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Rename,
            paths: vec!["target.md".into()],
            destination: Some("renamed.md".into()),
        })
        .unwrap();
    fs::write(
        fixture.root.join("new.md"),
        identified("[new incoming](target.md)\n"),
    )
    .unwrap();
    assert!(fixture.vault.commit_mutation(&plan.id).is_err());
    assert!(fixture.root.join("target.md").exists());
    assert!(!fixture.root.join("renamed.md").exists());
}

#[test]
fn recovery_acknowledgement_verifies_every_version_and_retries_partial_archive() {
    let fixture = Fixture::new();
    fixture
        .vault
        .create_note("target.md", &identified("# Target\n"))
        .unwrap();
    fixture.reconcile();
    fixture
        .vault
        .create_note("referrer.md", &identified("[target](target.md)\n"))
        .unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Rename,
            paths: vec!["target.md".into()],
            destination: Some("renamed.md".into()),
        })
        .unwrap();
    let collision = fixture.root.join("renamed.md");
    crate::vault::mutations::before_move_to("renamed.md", move || {
        fs::write(collision, b"external destination").unwrap()
    });
    let failed = fixture.vault.commit_mutation(&plan.id).unwrap();
    assert_eq!(failed.recovery_id.as_deref(), Some(plan.id.as_str()));
    fixture.vault.export_recovery(&plan.id, "export").unwrap();
    let original = fixture.root.join("export/0000-referrer.md.original");
    let original_bytes = fs::read(&original).unwrap();
    fs::write(&original, b"tampered original").unwrap();
    assert!(fixture.vault.acknowledge_recovery(&plan.id).is_err());
    assert!(fixture.vault.ensure_no_pending_mutations().is_err());
    fs::write(&original, &original_bytes).unwrap();
    let updated = fixture.root.join("export/0000-referrer.md.updated");
    let updated_bytes = fs::read(&updated).unwrap();
    fs::write(&updated, b"tampered updated").unwrap();
    assert!(fixture.vault.acknowledge_recovery(&plan.id).is_err());
    fs::write(&updated, updated_bytes).unwrap();
    fs::write(fixture.root.join("export/unrelated.txt"), b"do not adopt").unwrap();
    let archive = fixture
        .root
        .join(format!(".adamant/recovery-archive/{}", plan.id));
    fs::create_dir_all(&archive).unwrap();
    fs::copy(
        fixture.root.join("export/journal.json"),
        archive.join("journal.json"),
    )
    .unwrap();
    let acknowledged = fixture.vault.acknowledge_recovery(&plan.id).unwrap();
    assert_eq!(acknowledged.state, "acknowledged");
    assert_eq!(
        fs::read(archive.join("0000-referrer.md.original")).unwrap(),
        original_bytes
    );
    assert!(!archive.join("unrelated.txt").exists());
    assert_eq!(
        fs::read(fixture.root.join("renamed.md")).unwrap(),
        b"external destination"
    );
    fixture.vault.ensure_no_pending_mutations().unwrap();
}

#[test]
fn restore_to_another_folder_preserves_identity_and_outgoing_meaning() {
    let fixture = Fixture::new();
    fixture.vault.create_folder("original").unwrap();
    fixture.vault.create_folder("other/deep").unwrap();
    let text = identified("[root](../root.md)\n");
    let note = fixture
        .vault
        .create_note("original/note.md", &text)
        .unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Trash,
            paths: vec!["original/note.md".into()],
            destination: None,
        })
        .unwrap();
    fixture.vault.commit_mutation(&plan.id).unwrap();
    let trash = fixture.vault.list_trash().unwrap();
    let result = fixture
        .vault
        .restore_trash(&trash[0].id, Some("other/deep".into()))
        .unwrap();
    assert!(result.recovery_id.is_none());
    let restored = fixture.vault.read_note("other/deep/note.md").unwrap();
    assert_eq!(restored.id, note.id);
    assert_eq!(restored.text, text.replace("../root.md", "../../root.md"));
    assert!(fixture.vault.list_trash().unwrap().is_empty());
}

#[test]
fn purge_rechecks_the_listed_physical_scope_including_hidden_files() {
    let fixture = Fixture::new();
    fixture.vault.create_folder("folder").unwrap();
    fs::write(fixture.root.join("folder/.original.bin"), b"original").unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Trash,
            paths: vec!["folder".into()],
            destination: None,
        })
        .unwrap();
    assert_eq!(plan.items[0].file_count, 1);
    assert_eq!(plan.items[0].hidden_count, 1);
    fixture.vault.commit_mutation(&plan.id).unwrap();
    let item = fixture.vault.list_trash().unwrap().remove(0);
    let hidden = fixture.root.join(format!(
        ".adamant/trash/{}/payload/folder/.new.bin",
        item.id
    ));
    fs::write(&hidden, b"external").unwrap();
    assert_eq!(
        fixture
            .vault
            .purge_trash(std::slice::from_ref(&item.id))
            .unwrap()
            .outcomes[0]
            .status,
        "failed"
    );
    assert_eq!(fs::read(&hidden).unwrap(), b"external");
    assert_eq!(fixture.vault.list_trash().unwrap()[0].file_count, 2);
    assert_eq!(
        fixture.vault.purge_trash(&[item.id]).unwrap().outcomes[0].status,
        "completed"
    );
    assert!(fixture.vault.list_trash().unwrap().is_empty());
}

#[test]
fn import_invalid_companion_and_duplicate_batch_identity_never_orphan_sources() {
    use crate::vault::mutations::ImportedFile;
    let fixture = Fixture::new();
    let text = identified("# imported\n").into_bytes();
    let result = fixture
        .vault
        .import_files(
            vec![
                ImportedFile {
                    name: "bad.pdf".into(),
                    bytes: b"pdf".to_vec(),
                    companion: Some(vec![0xff]),
                },
                ImportedFile {
                    name: "first.md".into(),
                    bytes: text.clone(),
                    companion: None,
                },
                ImportedFile {
                    name: "second.md".into(),
                    bytes: text.clone(),
                    companion: None,
                },
            ],
            "",
        )
        .unwrap();
    assert_eq!(
        result
            .outcomes
            .iter()
            .map(|item| item.status.as_str())
            .collect::<Vec<_>>(),
        ["failed", "completed", "skipped"]
    );
    assert!(!fixture.root.join("bad.pdf").exists());
    assert!(!fixture.root.join("bad.pdf.meta.yaml").exists());
    assert_eq!(fs::read(fixture.root.join("first.md")).unwrap(), text);
    assert!(!fixture.root.join("second.md").exists());
}

#[cfg(unix)]
#[test]
fn symlink_destinations_and_unowned_administration_never_count_as_absence() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    fixture
        .vault
        .create_note("source.md", &identified("# original\n"))
        .unwrap();
    symlink(fixture.root.join("missing"), fixture.root.join("unsafe")).unwrap();
    assert!(
        fixture
            .vault
            .prepare_mutation(MutationRequest {
                kind: MutationKind::Move,
                paths: vec!["source.md".into()],
                destination: Some("unsafe".into()),
            })
            .is_err()
    );
    fs::create_dir(fixture.root.join(".adamant")).unwrap();
    fs::write(fixture.root.join(".adamant/user-file"), b"owned by user").unwrap();
    assert!(
        fixture
            .vault
            .prepare_mutation(MutationRequest {
                kind: MutationKind::Trash,
                paths: vec!["source.md".into()],
                destination: None,
            })
            .is_err()
    );
    assert_eq!(
        fs::read(fixture.root.join(".adamant/user-file")).unwrap(),
        b"owned by user"
    );
    assert!(!fixture.root.join(".adamant/marker").exists());
    assert!(fixture.root.join("source.md").exists());
}

#[test]
fn missing_companion_after_an_interrupted_trash_is_never_reported_recovered() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("paper.pdf"), b"original document").unwrap();
    let companion = b"id: 11111111-1111-4111-8111-111111111111\n";
    fs::write(fixture.root.join("paper.pdf.meta.yaml"), companion).unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Trash,
            paths: vec!["paper.pdf".into()],
            destination: None,
        })
        .unwrap();
    crate::vault::mutations::before_move_to("stage-1", || panic!("interrupted companion capture"));
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fixture
            .vault
            .commit_mutation(&plan.id)))
        .is_err()
    );
    fs::remove_file(fixture.root.join("paper.pdf.meta.yaml")).unwrap();
    let recovery = fixture.vault.recover_mutation(&plan.id).unwrap();
    assert_eq!(recovery.state, "conflicted");
    let result = recovery.result.as_ref().unwrap();
    assert!(result.recovery_id.is_some());
    assert_eq!(result.outcomes[0].status, "failed");
    assert!(result.mappings.is_empty());
    let trash = fixture.vault.list_trash().unwrap();
    assert_eq!(trash[0].file_count, 1);
    assert_eq!(
        fs::read(
            fixture
                .root
                .join(format!(".adamant/trash/{}/payload/paper.pdf", trash[0].id))
        )
        .unwrap(),
        b"original document"
    );
    assert_eq!(
        fs::read(
            fixture
                .root
                .join(format!(".adamant/transactions/{}/backup-1", plan.id))
        )
        .unwrap(),
        companion
    );
}

#[test]
fn duplicate_rejects_identity_ambiguity_outside_the_selected_subtree() {
    let fixture = Fixture::new();
    fixture.vault.create_folder("copies").unwrap();
    let text = identified("# shared identity\n");
    fixture.vault.create_note("selected.md", &text).unwrap();
    fs::write(fixture.root.join("outside.md"), &text).unwrap();
    assert!(
        fixture
            .vault
            .prepare_mutation(MutationRequest {
                kind: MutationKind::Duplicate,
                paths: vec!["selected.md".into()],
                destination: Some("copies".into()),
            })
            .is_err()
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("selected.md")).unwrap(),
        text
    );
    assert!(!fixture.root.join("copies/selected.md").exists());
}

#[test]
fn link_labels_with_code_and_quoted_html_never_supply_the_destination_span() {
    let fixture = Fixture::new();
    fixture
        .vault
        .create_note("B.md", &identified("# target\n"))
        .unwrap();
    let body =
        "[`literal `` ](B.md) still code`](B.md)\n[<span title=\"> ](B.md)\">label</span>](B.md)\n";
    let text = identified(body);
    fixture.reconcile();
    fixture.vault.create_note("A.md", &text).unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Rename,
            paths: vec!["B.md".into()],
            destination: Some("renamed.md".into()),
        })
        .unwrap();
    let result = fixture.vault.commit_mutation(&plan.id).unwrap();
    assert!(result.recovery_id.is_none());
    assert_eq!(
        fixture.vault.read_note("A.md").unwrap().text,
        text.replace("](B.md)\n", "](renamed.md)\n")
    );
}

#[test]
fn case_only_rename_preserves_the_identified_document_bytes() {
    let fixture = Fixture::new();
    let text = identified("# unchanged\n");
    let id = fixture.vault.create_note("Case.md", &text).unwrap().id;
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Rename,
            paths: vec!["Case.md".into()],
            destination: Some("CASE.md".into()),
        })
        .unwrap();
    let result = fixture.vault.commit_mutation(&plan.id).unwrap();
    assert!(result.recovery_id.is_none());
    assert_eq!(fixture.vault.read_note("CASE.md").unwrap().text, text);
    assert_eq!(fixture.vault.read_note("CASE.md").unwrap().id, id);
}

#[test]
fn owned_legacy_trash_is_not_an_import_identity_or_a_live_referrer() {
    use crate::vault::mutations::ImportedFile;

    let fixture = Fixture::new();
    let target = identified("# Target\n");
    let referrer = identified("[target](/target.md)\n");
    fixture.vault.create_note("target.md", &target).unwrap();
    fixture.reconcile();
    fixture.vault.create_note("referrer.md", &referrer).unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Trash,
            paths: vec!["referrer.md".into()],
            destination: None,
        })
        .unwrap();
    let trashed = fixture.vault.commit_mutation(&plan.id).unwrap();
    assert_eq!(trashed.outcomes[0].status, "completed");
    let entry = fixture.vault.list_trash().unwrap().remove(0);
    let retained = fixture
        .root
        .join(format!(".adamant/trash/{}/payload/referrer.md", entry.id));

    let imported = fixture
        .vault
        .import_files(
            vec![ImportedFile {
                name: "returned.md".into(),
                bytes: referrer.as_bytes().to_vec(),
                companion: None,
            }],
            "",
        )
        .unwrap();
    assert_eq!(imported.outcomes[0].status, "completed");
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Rename,
            paths: vec!["target.md".into()],
            destination: Some("renamed.md".into()),
        })
        .unwrap();
    let renamed = fixture.vault.commit_mutation(&plan.id).unwrap();
    assert!(renamed.recovery_id.is_none());
    assert_eq!(renamed.outcomes[0].status, "completed");
    assert_eq!(fs::read_to_string(&retained).unwrap(), referrer);
    assert_eq!(
        fs::read_to_string(fixture.root.join("returned.md")).unwrap(),
        referrer.replace("/target.md", "/renamed.md")
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("renamed.md")).unwrap(),
        target
    );
}

#[test]
fn preparation_rejects_files_added_after_the_disclosed_scope_was_measured() {
    let fixture = Fixture::new();
    fixture.vault.create_folder("folder").unwrap();
    fs::write(fixture.root.join("folder/original.md"), b"original").unwrap();
    let added = fixture.root.join("folder/.external.bin");
    crate::vault::mutations::after_scope(move || fs::write(added, b"external").unwrap());
    let request = MutationRequest {
        kind: MutationKind::Trash,
        paths: vec!["folder".into()],
        destination: None,
    };
    let error = fixture.vault.prepare_mutation(request.clone()).unwrap_err();
    assert_eq!(error.kind, "conflict");
    assert_eq!(
        fs::read(fixture.root.join("folder/original.md")).unwrap(),
        b"original"
    );
    assert_eq!(
        fs::read(fixture.root.join("folder/.external.bin")).unwrap(),
        b"external"
    );
    assert!(!fixture.root.join(".adamant").exists());

    let plan = fixture.vault.prepare_mutation(request).unwrap();
    assert_eq!(plan.items[0].file_count, 2);
    assert_eq!(plan.items[0].hidden_count, 1);
    assert_eq!(plan.items[0].bytes, 16);
    let result = fixture.vault.commit_mutation(&plan.id).unwrap();
    assert_eq!(result.outcomes[0].status, "completed");
    let item = fixture.vault.list_trash().unwrap().remove(0);
    assert_eq!(item.file_count, 2);
    assert_eq!(item.bytes, 16);
}

#[test]
fn preparation_binds_companion_presence_and_bytes_to_the_logical_scope() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("paper.pdf"), b"PDF original").unwrap();
    let original = b"id: 11111111-1111-4111-8111-111111111111\n";
    let changed = b"id: 22222222-2222-4222-8222-222222222222\n";
    let request = MutationRequest {
        kind: MutationKind::Rename,
        paths: vec!["paper.pdf".into()],
        destination: Some("renamed.pdf".into()),
    };
    for bytes in [original, changed] {
        let companion = fixture.root.join("paper.pdf.meta.yaml");
        crate::vault::mutations::after_scope(move || fs::write(companion, bytes).unwrap());
        let error = fixture.vault.prepare_mutation(request.clone()).unwrap_err();
        assert_eq!(error.kind, "conflict");
        assert_eq!(
            fs::read(fixture.root.join("paper.pdf")).unwrap(),
            b"PDF original"
        );
        assert_eq!(
            fs::read(fixture.root.join("paper.pdf.meta.yaml")).unwrap(),
            bytes
        );
        assert!(!fixture.root.join("renamed.pdf").exists());
    }
    let plan = fixture.vault.prepare_mutation(request).unwrap();
    assert_eq!(plan.items[0].file_count, 2);
    assert_eq!(
        plan.items[0].bytes,
        b"PDF original".len() as u64 + changed.len() as u64
    );
    let result = fixture.vault.commit_mutation(&plan.id).unwrap();
    assert_eq!(result.outcomes[0].status, "completed");
    assert_eq!(
        fs::read(fixture.root.join("renamed.pdf.meta.yaml")).unwrap(),
        changed
    );
    assert_eq!(
        fs::read(fixture.root.join("renamed.pdf")).unwrap(),
        b"PDF original"
    );
}

#[test]
fn an_unstable_trash_listing_never_authorizes_purging_undisclosed_bytes() {
    let fixture = Fixture::new();
    fixture.vault.create_folder("folder").unwrap();
    fs::write(fixture.root.join("folder/original.md"), b"original").unwrap();
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Trash,
            paths: vec!["folder".into()],
            destination: None,
        })
        .unwrap();
    let result = fixture.vault.commit_mutation(&plan.id).unwrap();
    assert_eq!(result.outcomes[0].status, "completed");
    let record = fs::read_dir(fixture.root.join(".adamant/trash"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
    let id = record.file_name().into_string().unwrap();
    let added = record.path().join("payload/folder/.external.bin");
    let external = added.clone();
    crate::vault::mutations::after_scope(move || fs::write(external, b"external").unwrap());
    assert_eq!(fixture.vault.list_trash().unwrap_err().kind, "conflict");
    let refused = fixture
        .vault
        .purge_trash(std::slice::from_ref(&id))
        .unwrap();
    assert_eq!(refused.outcomes[0].status, "failed");
    assert_eq!(fs::read(&added).unwrap(), b"external");
    assert_eq!(
        fs::read(record.path().join("payload/folder/original.md")).unwrap(),
        b"original"
    );

    let listed = fixture.vault.list_trash().unwrap().remove(0);
    assert_eq!(listed.file_count, 2);
    assert_eq!(listed.bytes, 16);
    assert_eq!(
        fixture.vault.purge_trash(&[id]).unwrap().outcomes[0].status,
        "completed"
    );
    assert!(!record.path().exists());
}

#[test]
fn imports_reject_any_conflicting_uuid_match_but_skip_all_identical_matches() {
    use crate::vault::mutations::ImportedFile;

    let fixture = Fixture::new();
    let first = identified("# First\n");
    let second = first.replace("# First", "# Second");
    let identical = identified("# Identical\n");
    let existing = [
        ("first.md", &first),
        ("second.md", &second),
        ("same-a.md", &identical),
        ("same-b.md", &identical),
    ];
    for (path, text) in existing {
        fs::write(fixture.root.join(path), text).unwrap();
    }
    let result = fixture
        .vault
        .import_files(
            [
                ("first-import.md", &first),
                ("second-import.md", &second),
                ("identical-import.md", &identical),
            ]
            .into_iter()
            .map(|(name, text)| ImportedFile {
                name: name.into(),
                bytes: text.as_bytes().to_vec(),
                companion: None,
            })
            .collect(),
            "",
        )
        .unwrap();
    assert_eq!(
        result
            .outcomes
            .iter()
            .map(|outcome| (outcome.path.as_str(), outcome.status.as_str()))
            .collect::<Vec<_>>(),
        [
            ("first-import.md", "failed"),
            ("second-import.md", "failed"),
            ("identical-import.md", "skipped"),
        ]
    );
    let destination = result.outcomes[2].destination.as_ref().unwrap();
    assert_eq!(
        fs::read_to_string(fixture.root.join(destination)).unwrap(),
        identical
    );
    for outcome in result.outcomes {
        assert!(!fixture.root.join(outcome.path).exists());
    }
    for (path, text) in existing {
        assert_eq!(fs::read_to_string(fixture.root.join(path)).unwrap(), *text);
    }
}
