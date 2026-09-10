use std::fs;

use uuid::Uuid;

use super::Fixture;

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
