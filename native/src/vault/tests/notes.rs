use std::fs;

use uuid::Uuid;

use super::{Fixture, identified};

#[test]
fn source_survives_discovery_explicit_adoption_and_save() {
    let f = Fixture::new();
    let raw =
        "\u{feff}---\r\n# comentário\r\ncustom: { nested: '日本語' }\r\n---\r\n\r\n# Coração\r\n";
    fs::write(f.root.join("estudo.md"), raw).unwrap();
    f.reconcile();
    assert!(
        f.vault
            .list_entries("", 0, 100)
            .unwrap()
            .entries
            .iter()
            .any(|entry| entry.path == "estudo.md"
                && entry.id.is_none()
                && entry.metadata_error.is_some())
    );
    assert_eq!(fs::read_to_string(f.root.join("estudo.md")).unwrap(), raw);
    let read = f.vault.read_note("estudo.md").unwrap();
    let ordinary = f
        .vault
        .save_note("estudo.md", &(raw.to_owned() + "Texto\r\n"), &read.revision)
        .unwrap();
    assert!(ordinary.id.is_none());
    let adopted = f.vault.adopt_note("estudo.md", &ordinary.revision).unwrap();
    assert!(adopted.id.is_some());
    assert!(
        adopted
            .text
            .starts_with("\u{feff}---\r\n# comentário\r\ncustom: { nested: '日本語' }\r\n")
    );
    assert!(adopted.text.ends_with("---\r\n\r\n# Coração\r\nTexto\r\n"));
    assert_eq!(
        f.vault
            .adopt_note("estudo.md", &adopted.revision)
            .unwrap()
            .text,
        adopted.text
    );
    let edited = adopted.text.replace("# Coração", "# Continuação");
    assert_eq!(
        f.vault
            .save_note("estudo.md", &edited, &adopted.revision)
            .unwrap()
            .text,
        edited
    );
    assert_eq!(
        fs::read_to_string(f.root.join("estudo.md")).unwrap(),
        edited
    );
}

#[test]
fn malformed_yaml_is_editable_but_never_destructively_adopted() {
    let f = Fixture::new();
    let raw = "---\nid: [unfinished\n---\n# Body stays available\n";
    fs::write(f.root.join("broken.md"), raw).unwrap();
    let read = f.vault.read_note("broken.md").unwrap();
    assert_eq!(read.text, raw);
    assert!(read.metadata_error.is_some());
    assert_eq!(
        f.vault
            .adopt_note("broken.md", &read.revision)
            .unwrap_err()
            .kind,
        "invalid"
    );
    assert_eq!(fs::read_to_string(f.root.join("broken.md")).unwrap(), raw);
    let edited = raw.replace("Body", "Edited body");
    let saved = f
        .vault
        .save_note("broken.md", &edited, &read.revision)
        .unwrap();
    assert_eq!(saved.text, edited);
    assert!(saved.metadata_error.is_some());
    assert_eq!(
        f.vault
            .save_copy("copies/broken.md", &saved.text)
            .unwrap()
            .text,
        edited
    );
}

#[test]
fn adoption_supports_flow_mapping_without_reformatting_unknown_values() {
    let f = Fixture::new();
    let raw = "---\n{custom: [one, 'two'], tags: []} # trailing\n---\nBody\n";
    fs::write(f.root.join("flow.md"), raw).unwrap();
    let read = f.vault.read_note("flow.md").unwrap();
    let adopted = f.vault.adopt_note("flow.md", &read.revision).unwrap();
    assert!(adopted.metadata_error.is_none());
    assert!(
        adopted
            .text
            .contains("custom: [one, 'two'], tags: []} # trailing\n---\nBody\n")
    );
}

#[test]
fn local_schemas_validate_nested_references_and_preserve_invalid_source() {
    let f = Fixture::new();
    let id = Uuid::new_v4();
    let valid = format!(
        "---\nid: {id}\nkind: topic\nrefs:\n  - kind: calendar-event\n    id: organizer@example.org\n    recurrenceId: 20260906T120000Z\n  - kind: external-item\n    provider: github\n    instance: github.com\n    id: I_123\n    url: https://github.com/org/repo/issues/2\nunknown: {{value: yes}}\n---\nText"
    );
    fs::write(f.root.join("refs.md"), &valid).unwrap();
    let read = f.vault.read_note("refs.md").unwrap();
    assert!(read.metadata_error.is_none(), "{:?}", read.metadata_error);
    let invalid = valid.replace("provider: github", "provider: other");
    let saved = f
        .vault
        .save_note("refs.md", &invalid, &read.revision)
        .unwrap();
    assert!(saved.metadata_error.is_some());
    assert_eq!(saved.text, invalid);
    let replacement = invalid.replace(&id.to_string(), &Uuid::new_v4().to_string());
    assert_eq!(
        f.vault
            .save_note("refs.md", &replacement, &saved.revision)
            .unwrap_err()
            .kind,
        "invalid"
    );
    assert_eq!(f.vault.read_note("refs.md").unwrap().text, invalid);
}

#[test]
fn import_deduplicates_exact_identity_and_rejects_different_content() {
    let f = Fixture::new();
    let source = f._temp.path().join("import.md");
    let text = identified("# Original\n");
    fs::write(&source, &text).unwrap();
    f.vault.create_folder("notes").unwrap();
    f.reconcile();
    let imported = |name: &str| crate::vault::mutations::ImportedFile {
        name: name.into(),
        bytes: fs::read(&source).unwrap(),
        companion: None,
    };
    let result = f
        .vault
        .import_files(vec![imported("imported.md")], "notes")
        .unwrap();
    assert_eq!(result.outcomes[0].status, "completed");
    let first = f.vault.read_note("notes/imported.md").unwrap();
    assert_eq!(first.text, text);
    f.reconcile();
    let duplicate = f
        .vault
        .import_files(vec![imported("not-created.md")], "notes")
        .unwrap();
    assert_eq!(duplicate.outcomes[0].status, "skipped");
    assert_eq!(
        duplicate.outcomes[0].destination.as_deref(),
        Some(first.path.as_str())
    );
    assert!(!f.root.join("notes/not-created.md").exists());
    fs::write(&source, first.text.replace("Original", "Different")).unwrap();
    let collision = f
        .vault
        .import_files(vec![imported("collision.md")], "notes")
        .unwrap();
    assert_eq!(collision.outcomes[0].status, "failed");
    assert_eq!(f.vault.read_note(&first.path).unwrap().text, first.text);
    assert!(!f.root.join("notes/collision.md").exists());
    f.vault.save_copy("recovery.md", &first.text).unwrap();
    let snapshot = f.reconcile();
    assert!(
        snapshot
            .issues
            .iter()
            .any(|issue| issue.path == "recovery.md" && issue.message.contains("UUID collision"))
    );
    assert_eq!(
        f.vault
            .create_note("another.md", &first.text)
            .unwrap_err()
            .kind,
        "conflict"
    );
}

#[test]
fn identified_read_refuses_replacement_without_rebinding_the_buffer() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("unmanaged.md"), "Original bytes").unwrap();
    let target =
        crate::vault::navigation::navigation_target(&fixture.vault, "unmanaged.md").unwrap();
    fs::rename(
        fixture.root.join("unmanaged.md"),
        fixture.root.join("original.md"),
    )
    .unwrap();
    fs::write(fixture.root.join("unmanaged.md"), "Replacement bytes").unwrap();
    assert!(
        fixture
            .vault
            .read_note_identified("unmanaged.md", &target.identity)
            .is_err()
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("original.md")).unwrap(),
        "Original bytes"
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("unmanaged.md")).unwrap(),
        "Replacement bytes"
    );
}
