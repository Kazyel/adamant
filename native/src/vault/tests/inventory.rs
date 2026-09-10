use std::{fs, path::PathBuf};

use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use uuid::Uuid;

use super::{Fixture, identified, reconciled};
use crate::vault::{IndexState, Vault};

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
    assert!(crate::documents::read_document(f.root.join("hidden.markdown")).is_err());
    assert_eq!(
        crate::documents::read_document(f.root.join("a.MD"))
            .unwrap()
            .bytes,
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
