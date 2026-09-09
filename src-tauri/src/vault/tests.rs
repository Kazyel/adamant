use super::*;
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use tempfile::TempDir;

struct Fixture {
    _temp: TempDir,
    root: PathBuf,
    state: PathBuf,
    vault: Vault,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Caderno 日本語");
        let state = temp.path().join("machine");
        let vault = VaultParent::select(temp.path()).unwrap().create("Caderno 日本語", &state).unwrap();
        reconciled(&vault);
        Self {
            _temp: temp,
            root,
            state,
            vault,
        }
    }

    fn reconcile(&self) -> VaultSnapshot {
        reconciled(&self.vault)
    }

    fn recovery_sources(&self) -> Vec<String> {
        fs::read_dir(self.vault.recovery_directory())
            .unwrap()
            .map(|entry| fs::read_to_string(entry.unwrap().path()).unwrap())
            .collect()
    }
}

fn reconciled(vault: &Vault) -> VaultSnapshot {
    assert!(
        vault
            .reconcile(&std::sync::atomic::AtomicBool::new(false), &mut |_| Ok(()))
            .unwrap()
    );
    vault.set_index_state(IndexState::Ready, None);
    vault.refresh().unwrap()
}

fn identified(body: &str) -> String {
    format!(
        "---\nid: {}\ncustom: 'preserve me' # comment\n---\n{body}",
        Uuid::new_v4()
    )
}

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
    let first = f.vault.import_note("notes/imported.md", &source).unwrap();
    assert_eq!(first.text, text);
    f.reconcile();
    let duplicate = f
        .vault
        .import_note("notes/not-created.md", &source)
        .unwrap();
    assert_eq!(duplicate.path, first.path);
    assert!(!f.root.join("notes/not-created.md").exists());
    fs::write(&source, first.text.replace("Original", "Different")).unwrap();
    let collision = f
        .vault
        .import_note("notes/collision.md", &source)
        .unwrap_err();
    assert_eq!(collision.kind, "conflict");
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
fn revisions_detect_external_content_even_when_mtime_is_restored() {
    let f = Fixture::new();
    let note = f.vault.create_note("note.md", "# Initial\n").unwrap();
    let path = f.root.join("note.md");
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    let external = note.text.replace("Initial", "Outside");
    fs::write(&path, &external).unwrap();
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let submitted = note.text.replace("Initial", "My buffer");
    let conflict = f
        .vault
        .save_note("note.md", &submitted, &note.revision)
        .unwrap_err();
    assert_eq!(conflict.kind, "conflict");
    assert_eq!(conflict.current.unwrap().text, external);
    assert_eq!(fs::read_to_string(path).unwrap(), external);
    assert!(f.recovery_sources().contains(&submitted));
}

#[test]
fn deletion_is_a_conflict_and_never_recreates_the_original_path() {
    let f = Fixture::new();
    let note = f
        .vault
        .create_note("nested/note.md", "# Initial\n")
        .unwrap();
    fs::remove_dir_all(f.root.join("nested")).unwrap();
    let submitted = note.text + "Unsaved\n";
    let conflict = f
        .vault
        .save_note("nested/note.md", &submitted, &note.revision)
        .unwrap_err();
    assert_eq!(conflict.kind, "conflict");
    assert!(conflict.current.is_none());
    assert!(!f.root.join("nested/note.md").exists());
    assert!(f.recovery_sources().contains(&submitted));
}

#[test]
fn atomic_exchange_retains_both_versions_of_a_real_external_save_race() {
    let f = Fixture::new();
    let note = f.vault.create_note("note.md", "# Initial\n").unwrap();
    let external = note.text.replace("Initial", "Racing external writer");
    let submitted = note.text.replace("Initial", "My submitted buffer");
    let conflict = f
        .vault
        .save_note_inner("note.md", &submitted, &note.revision, || {
            fs::write(f.root.join("external.tmp"), &external).unwrap();
            fs::rename(f.root.join("external.tmp"), f.root.join("note.md")).unwrap();
        })
        .unwrap_err();
    assert_eq!(conflict.kind, "conflict");
    assert_eq!(
        conflict.current.unwrap().text,
        fs::read_to_string(f.root.join("note.md")).unwrap()
    );
    let retained = f.recovery_sources();
    assert!(retained.contains(&submitted));
    assert!(retained.contains(&external));
}

#[test]
fn exclusive_creation_and_path_capability_prevent_overwrites_and_escapes() {
    let f = Fixture::new();
    let note = f
        .vault
        .create_note("notes/note.md", "# Existing\n")
        .unwrap();
    assert_eq!(
        f.vault
            .save_copy("notes/note.md", "Replacement")
            .unwrap_err()
            .kind,
        "conflict"
    );
    assert_eq!(f.vault.read_note("notes/note.md").unwrap().text, note.text);
    for path in [
        "../outside.md",
        "notes/../../outside.md",
        "/tmp/outside.md",
        "notes/./other.md",
    ] {
        assert_eq!(
            f.vault.save_copy(path, "No escape").unwrap_err().kind,
            "invalid"
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let outside = f._temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.md"), "Private").unwrap();
        symlink(&outside, f.root.join("link")).unwrap();
        symlink(outside.join("secret.md"), f.root.join("alias.md")).unwrap();
        assert!(f.vault.read_note("link/secret.md").is_err());
        assert!(f.vault.save_copy("link/created.md", "No escape").is_err());
        assert!(f.vault.read_note("alias.md").is_err());
        assert!(f.vault.save_note("alias.md", "No escape", "any").is_err());
        assert_eq!(
            fs::read_to_string(outside.join("secret.md")).unwrap(),
            "Private"
        );
        assert!(!outside.join("created.md").exists());
        assert!(
            f.reconcile()
                .issues
                .iter()
                .any(|issue| issue.path == "link")
        );
    }
}

#[test]
fn reopen_move_copy_and_index_deletion_preserve_authoritative_notes() {
    let f = Fixture::new();
    let note = f.vault.create_note("日本語.md", "# Portable\n").unwrap();
    let original_snapshot = f.reconcile();
    let original_index = f.vault.index_path();
    fs::remove_file(&original_index).unwrap();
    f.reconcile();
    let indexed: (String,) = tauri::async_runtime::block_on(async {
        let mut connection =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&original_index))
                .await
                .unwrap();
        let row = sqlx::query_as("SELECT id FROM entries WHERE path = ?")
            .bind("日本語.md")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        connection.close().await.unwrap();
        row
    });
    assert_eq!(indexed.0, note.id.clone().unwrap());
    let copy = f._temp.path().join("Copy");
    fs::create_dir(&copy).unwrap();
    fs::copy(f.root.join("vault.json"), copy.join("vault.json")).unwrap();
    fs::copy(f.root.join("日本語.md"), copy.join("日本語.md")).unwrap();
    let copied = Vault::open(&copy, &f.state).unwrap();
    reconciled(&copied);
    assert_eq!(
        copied.list_entries("", 0, 100).unwrap().entries[0].id,
        note.id
    );
    assert_eq!(copied.refresh().unwrap().id, original_snapshot.id);
    assert_ne!(copied.index_path(), original_index);
    assert_eq!(
        copied.read_note("日本語.md").unwrap().revision,
        note.revision
    );
    let moved = f._temp.path().join("Moved");
    drop(f.vault);
    fs::rename(&f.root, &moved).unwrap();
    let reopened = Vault::open(&moved, &f.state).unwrap();
    assert_eq!(reopened.read_note("日本語.md").unwrap().text, note.text);
    reconciled(&reopened);
    assert_eq!(reopened.refresh().unwrap().id, original_snapshot.id);
    assert_ne!(reopened.index_path(), original_index);
    assert!(!moved.join("index.sqlite").exists());
}

#[test]
fn original_documents_and_companions_remain_separate_and_unmodified() {
    let f = Fixture::new();
    let original = b"%PDF-1.7\noriginal bytes";
    let id = Uuid::new_v4();
    let companion = format!(
        "id: {id}\ntitle: Original\nunknown: keep\nrefs:\n  - kind: note\n    id: {}\n",
        Uuid::new_v4()
    );
    fs::write(f.root.join("paper.pdf"), original).unwrap();
    fs::write(f.root.join("paper.pdf.meta.yaml"), &companion).unwrap();
    let snapshot = f.reconcile();
    let page = f.vault.list_entries("", 0, 100).unwrap();
    let entry = page
        .entries
        .iter()
        .find(|entry| entry.path == "paper.pdf")
        .unwrap();
    assert_eq!(entry.id.as_deref(), Some(id.to_string().as_str()));
    assert!(
        snapshot
            .issues
            .iter()
            .any(|issue| issue.path == "paper.pdf.meta.yaml"
                && issue.message.contains("Unresolved reference"))
    );
    assert!(
        !snapshot
            .issues
            .iter()
            .any(|issue| issue.message.contains("UUID collision"))
    );
    let (_, kind, bytes) = f.vault.read_document("paper.pdf").unwrap();
    assert_eq!(kind, "pdf");
    assert_eq!(bytes, original);
    fs::rename(f.root.join("paper.pdf"), f.root.join("moved.pdf")).unwrap();
    let snapshot = f.reconcile();
    assert!(
        snapshot
            .issues
            .iter()
            .any(|issue| issue.path == "paper.pdf.meta.yaml"
                && issue.message.contains("no original"))
    );
    assert_eq!(
        fs::read_to_string(f.root.join("paper.pdf.meta.yaml")).unwrap(),
        companion
    );
}

#[test]
fn manifest_is_exclusive_validated_and_never_rewritten_on_open() {
    let f = Fixture::new();
    let manifest = fs::read_to_string(f.root.join("vault.json")).unwrap();
    assert!(VaultParent::select(f.root.parent().unwrap()).unwrap().create("Caderno 日本語", &f.state).is_err());
    assert_eq!(
        fs::read_to_string(f.root.join("vault.json")).unwrap(),
        manifest
    );
    let custom = manifest.replace("\n}", ",\n  \"unknown\": {\"keep\": true}\n}");
    fs::write(f.root.join("vault.json"), &custom).unwrap();
    Vault::open(&f.root, &f.state).unwrap();
    assert_eq!(
        fs::read_to_string(f.root.join("vault.json")).unwrap(),
        custom
    );
    fs::write(
        f.root.join("vault.json"),
        "{\"formatVersion\":2,\"id\":\"invalid\"}",
    )
    .unwrap();
    assert_eq!(
        Vault::open(&f.root, &f.state).err().unwrap().kind,
        "invalid"
    );
}

#[cfg(unix)]
#[test]
fn successful_save_preserves_permissions_without_growing_recovery_history() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let f = Fixture::new();
    let note = f.vault.create_note("note.md", "# Start\n").unwrap();
    fs::set_permissions(f.root.join("note.md"), fs::Permissions::from_mode(0o640)).unwrap();
    let saved = f
        .vault
        .save_note("note.md", &(note.text + "Edited\n"), &note.revision)
        .unwrap();
    assert_eq!(
        fs::metadata(f.root.join("note.md")).unwrap().mode() & 0o777,
        0o640
    );
    assert_eq!(f.vault.read_note("note.md").unwrap().text, saved.text);
    assert!(f.recovery_sources().is_empty());
    assert!(!f.vault.refresh().unwrap().issues.iter().any(
        |issue| issue.message.contains("recovery") || issue.message.contains("UUID collision")
    ));
}

#[test]
fn simultaneous_saves_never_silently_drop_either_submitted_version() {
    let f = Fixture::new();
    let note = f.vault.create_note("note.md", "# Initial\n").unwrap();
    let first = note.text.replace("Initial", "First buffer");
    let second = note.text.replace("Initial", "Second buffer");
    let barrier = std::sync::Barrier::new(2);
    let results = std::thread::scope(|scope| {
        let left = scope.spawn(|| {
            f.vault
                .save_note_inner("note.md", &first, &note.revision, || {
                    barrier.wait();
                })
        });
        let right = scope.spawn(|| {
            f.vault
                .save_note_inner("note.md", &second, &note.revision, || {
                    barrier.wait();
                })
        });
        [left.join().unwrap(), right.join().unwrap()]
    });
    assert!(results.iter().any(Result::is_err));
    for error in results.into_iter().filter_map(Result::err) {
        assert_eq!(error.kind, "conflict");
    }
    let mut surviving = f.recovery_sources();
    surviving.push(f.vault.read_note("note.md").unwrap().text);
    assert!(surviving.contains(&first));
    assert!(surviving.contains(&second));
}

#[test]
fn active_manifest_changes_fail_closed_without_reindexing_or_mutating_content() {
    let f = Fixture::new();
    let note = f.vault.create_note("note.md", "# Original\n").unwrap();
    f.reconcile();
    let manifest_path = f.root.join("vault.json");
    let original = fs::read_to_string(&manifest_path).unwrap();
    let index = fs::read(f.vault.index_path()).unwrap();
    let replacement =
        serde_json::json!({ "format": "adamant-vault", "formatVersion": 1, "id": Uuid::new_v4().to_string() }).to_string();
    for manifest in [
        Some(replacement.as_str()),
        Some("{\"formatVersion\":2}"),
        None,
    ] {
        if let Some(manifest) = manifest {
            fs::write(&manifest_path, manifest).unwrap();
        } else {
            fs::remove_file(&manifest_path).unwrap();
        }
        assert!(f.vault.refresh().is_err());
        assert!(
            f.vault
                .save_note(
                    "note.md",
                    &(note.text.clone() + "Changed\n"),
                    &note.revision
                )
                .is_err()
        );
        assert!(f.vault.save_copy("copy.md", &note.text).is_err());
        assert_eq!(
            fs::read_to_string(f.root.join("note.md")).unwrap(),
            note.text
        );
        assert!(!f.root.join("copy.md").exists());
        assert_eq!(fs::read(f.vault.index_path()).unwrap(), index);
    }
    fs::write(&manifest_path, &original).unwrap();
    let saved = f
        .vault
        .save_note("note.md", &(note.text + "Restored\n"), &note.revision)
        .unwrap();
    assert_eq!(f.vault.read_note("note.md").unwrap().text, saved.text);
    assert_eq!(
        f.vault.refresh().unwrap().id,
        serde_json::from_str::<Value>(&original).unwrap()["id"]
    );
}

#[test]
fn manifest_replacement_during_save_preserves_the_original_note() {
    let f = Fixture::new();
    let note = f.vault.create_note("note.md", "# Original\n").unwrap();
    let replacement =
        serde_json::json!({ "format": "adamant-vault", "formatVersion": 1, "id": Uuid::new_v4().to_string() }).to_string();
    let result = f.vault.save_note_inner(
        "note.md",
        &(note.text.clone() + "Changed\n"),
        &note.revision,
        || {
            fs::write(f.root.join("vault.json"), &replacement).unwrap();
        },
    );
    assert!(result.is_err());
    assert_eq!(
        fs::read_to_string(f.root.join("note.md")).unwrap(),
        note.text
    );
    assert_eq!(
        fs::read_to_string(f.root.join("vault.json")).unwrap(),
        replacement
    );
}

#[test]
fn admission_rejects_populated_creation_and_missing_marker_without_changing_files() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("existing");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("keep.md"), "# Authored content\n").unwrap();
    let state = temp.path().join("machine");
    assert_eq!(
        VaultParent::select(temp.path()).unwrap().create("existing", &state).err().unwrap().kind,
        "invalid"
    );
    assert!(!root.join("vault.json").exists());
    let manifest =
        serde_json::json!({"formatVersion":1,"id":Uuid::new_v4().to_string()}).to_string();
    fs::write(root.join("vault.json"), &manifest).unwrap();
    assert_eq!(
        Vault::open(&root, &state).err().unwrap().kind,
        "invalid"
    );
    assert_eq!(
        fs::read_to_string(root.join("keep.md")).unwrap(),
        "# Authored content\n"
    );
    assert_eq!(
        fs::read_to_string(root.join("vault.json")).unwrap(),
        manifest
    );
}

#[test]
fn supported_inventory_is_case_insensitive_paged_and_never_admits_control_or_ignored_files() {
    let f = Fixture::new();
    for path in ["a.MD", "b.PdF", "c.DoCx"] {
        fs::write(f.root.join(path), "Supported source").unwrap();
    }
    for path in [
        "hidden.markdown",
        "data.json",
        "text.txt",
        "unknown.pdf.meta.yaml",
    ] {
        fs::write(f.root.join(path), "---\nid: [invalid\n").unwrap();
    }
    fs::create_dir(f.root.join("node_modules")).unwrap();
    fs::write(
        f.root.join("node_modules/ignored.md"),
        "# Not a Vault document\n",
    )
    .unwrap();
    let snapshot = f.reconcile();
    let mut paths = Vec::new();
    let mut offset = 0;
    loop {
        let page = f.vault.list_entries("", offset, 1).unwrap();
        assert!(page.entries.len() <= 1);
        paths.extend(page.entries.into_iter().map(|entry| entry.path));
        if !page.has_more {
            break;
        }
        offset += 1;
    }
    assert_eq!(paths, ["a.MD", "b.PdF", "c.DoCx"]);
    assert!(!snapshot.issues.iter().any(|issue| matches!(
        issue.path.as_str(),
        "hidden.markdown" | "data.json" | "text.txt"
    )));
    assert!(f.vault.read_note("hidden.markdown").is_err());
    assert!(f.vault.read_document("hidden.markdown").is_err());
    assert!(
        f.vault
            .save_copy("copy.markdown", "# Disallowed\n")
            .is_err()
    );
    assert!(!f.root.join("copy.markdown").exists());
    assert!(crate::read_document(f.root.join("hidden.markdown")).is_err());
    assert_eq!(
        crate::read_document(f.root.join("a.MD")).unwrap().bytes,
        b"Supported source"
    );
}

#[test]
fn cancellation_preserves_inventory_and_source_access_but_cannot_certify_identity_absence() {
    let f = Fixture::new();
    let note = f.vault.create_note("note.md", "# Original\n").unwrap();
    f.reconcile();
    let cancelled = std::sync::atomic::AtomicBool::new(true);
    assert!(!f.vault.reconcile(&cancelled, &mut |_| Ok(())).unwrap());
    assert!(matches!(
        f.vault.refresh().unwrap().indexing.state,
        IndexState::Cancelled
    ));
    assert_eq!(
        f.vault.list_entries("", 0, 100).unwrap().entries[0].id,
        note.id
    );
    let saved = f
        .vault
        .save_note(
            "note.md",
            &(note.text.clone() + "Still editable\n"),
            &note.revision,
        )
        .unwrap();
    assert_eq!(f.vault.read_note("note.md").unwrap().text, saved.text);
    let copy = f.vault.save_copy("recovery.md", &saved.text).unwrap();
    assert_eq!(copy.text, saved.text);
    let created = f.vault.create_note("new.md", "# New identity\n").unwrap();
    assert_ne!(created.id, note.id);
    let source = f._temp.path().join("import.md");
    fs::write(&source, identified("# Supplied identity\n")).unwrap();
    assert_eq!(
        f.vault.import_note("import.md", &source).unwrap_err().kind,
        "invalid"
    );
    assert!(!f.root.join("import.md").exists());
}

#[test]
fn depth_limit_keeps_unseen_rows_and_exposes_partial_inventory() {
    let f = Fixture::new();
    let note = f
        .vault
        .create_note("retained.md", "# Last complete inventory\n")
        .unwrap();
    f.reconcile();
    fs::remove_file(f.root.join("retained.md")).unwrap();
    let mut directory = f.root.clone();
    for _ in 0..34 {
        directory = directory.join("nested");
        fs::create_dir(&directory).unwrap();
    }
    assert!(
        !f.vault
            .reconcile(&std::sync::atomic::AtomicBool::new(false), &mut |_| Ok(()))
            .unwrap()
    );
    assert!(matches!(
        f.vault.refresh().unwrap().indexing.state,
        IndexState::Partial
    ));
    let page = f.vault.list_entries("", 0, 100).unwrap();
    assert!(
        page.entries
            .iter()
            .any(|entry| entry.path == "retained.md" && entry.id == note.id)
    );
    assert!(!f.root.join("retained.md").exists());
}

#[test]
fn surfaced_index_errors_have_bounded_counts_and_message_bytes() {
    let f = Fixture::new();
    let invalid = format!(
        "---\nid: {}\ntags: {{bad: '{}'}}\n---\nBody\n",
        Uuid::new_v4(),
        "x".repeat(8192)
    );
    for index in 0..210 {
        fs::write(f.root.join(format!("invalid-{index}.md")), &invalid).unwrap();
    }
    let snapshot = f.reconcile();
    assert!(snapshot.issue_count >= 210);
    assert!(snapshot.issues.len() <= 200);
    assert!(
        snapshot
            .issues
            .iter()
            .all(|issue| issue.message.len() <= 1024)
    );
    assert_eq!(
        fs::read_to_string(f.root.join("invalid-0.md")).unwrap(),
        invalid
    );
}

#[test]
fn a_deleted_cache_rebuilds_all_notes_before_incremental_completion() {
    let f = Fixture::new();
    let a = f.vault.create_note("a.md", "# A").unwrap();
    let b = f.vault.create_note("b.md", "# B").unwrap();
    f.reconcile();
    fs::remove_file(f.vault.index_path()).unwrap();
    let changed = format!("{}\nChanged A", a.text);
    f.vault.save_note("a.md", &changed, &a.revision).unwrap();
    assert!(
        f.vault
            .apply_changes(
                &[PathBuf::from("a.md")],
                &std::sync::atomic::AtomicBool::new(false),
                &mut |_| Ok(()),
            )
            .unwrap()
    );
    let paths = tauri::async_runtime::block_on(async {
        let mut connection = SqliteConnection::connect_with(
            &SqliteConnectOptions::new().filename(f.vault.index_path()),
        )
        .await
        .unwrap();
        sqlx::query_scalar::<_, String>("SELECT path FROM entries ORDER BY path")
            .fetch_all(&mut connection)
            .await
            .unwrap()
    });
    assert_eq!(paths, ["a.md", "b.md"]);
    assert_eq!(f.vault.read_note("a.md").unwrap().text, changed);
    assert_eq!(f.vault.read_note("b.md").unwrap().text, b.text);
}

#[test]
fn guided_creation_is_exclusive_confined_and_preserves_replaced_parents() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("parent");
    fs::create_dir(&root).unwrap();
    let state = temp.path().join("machine");
    let parent = VaultParent::select(&root).unwrap();
    assert!(fs::read_dir(&root).unwrap().next().is_none());
    for name in ["", ".", "..", "../escape", "/absolute", "nested/name", "nested\\name", " trailing ", "bad."] {
        assert!(parent.create(name, &state).is_err(), "{name}");
    }
    assert!(fs::read_dir(&root).unwrap().next().is_none());
    let vault = parent.create("Research 日本語", &state).unwrap();
    assert_eq!(vault.refresh().unwrap().name, "Research 日本語");
    let manifest = fs::read(vault.root().join("vault.json")).unwrap();
    fs::write(vault.root().join("keep.md"), "unchanged").unwrap();
    assert!(parent.create("Research 日本語", &state).is_err());
    assert_eq!(fs::read(vault.root().join("vault.json")).unwrap(), manifest);
    assert_eq!(fs::read_to_string(vault.root().join("keep.md")).unwrap(), "unchanged");
    #[cfg(unix)]
    {
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
        assert!(parent.create("linked", &state).is_err());
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
        fs::rename(&root, temp.path().join("moved")).unwrap();
        std::os::unix::fs::symlink(&outside, &root).unwrap();
        assert!(parent.create("Escaped", &state).is_err());
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
    }
}
