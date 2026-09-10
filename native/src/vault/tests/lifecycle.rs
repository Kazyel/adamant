use std::{fs, path::Path};

use serde_json::Value;
use uuid::Uuid;

use super::{Fixture, reconciled};
use crate::vault::{NoteDocument, Vault, VaultParent};

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
fn manifest_is_exclusive_validated_and_never_rewritten_on_open() {
    let f = Fixture::new();
    let manifest = fs::read_to_string(f.root.join("vault.json")).unwrap();
    assert!(
        VaultParent::select(f.root.parent().unwrap())
            .unwrap()
            .create("Caderno 日本語", &f.state)
            .is_err()
    );
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
fn admission_rejects_populated_creation_and_missing_marker_without_changing_files() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("existing");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("keep.md"), "# Authored content\n").unwrap();
    let state = temp.path().join("machine");
    assert_eq!(
        VaultParent::select(temp.path())
            .unwrap()
            .create("existing", &state)
            .err()
            .unwrap()
            .kind,
        "invalid"
    );
    assert!(!root.join("vault.json").exists());
    let manifest =
        serde_json::json!({"formatVersion":1,"id":Uuid::new_v4().to_string()}).to_string();
    fs::write(root.join("vault.json"), &manifest).unwrap();
    assert_eq!(Vault::open(&root, &state).err().unwrap().kind, "invalid");
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
fn guided_creation_is_exclusive_confined_and_preserves_replaced_parents() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("parent");
    fs::create_dir(&root).unwrap();
    let state = temp.path().join("machine");
    let parent = VaultParent::select(&root).unwrap();
    assert!(fs::read_dir(&root).unwrap().next().is_none());
    for name in [
        "",
        ".",
        "..",
        "../escape",
        "/absolute",
        "nested/name",
        "nested\\name",
        " trailing ",
        "bad.",
    ] {
        assert!(parent.create(name, &state).is_err(), "{name}");
    }
    assert!(fs::read_dir(&root).unwrap().next().is_none());
    let vault = parent.create("Research 日本語", &state).unwrap();
    assert_eq!(vault.refresh().unwrap().name, "Research 日本語");
    let manifest = fs::read(vault.vault_root().join("vault.json")).unwrap();
    fs::write(vault.root().join("keep.md"), "unchanged").unwrap();
    assert!(parent.create("Research 日本語", &state).is_err());
    assert_eq!(
        fs::read(vault.vault_root().join("vault.json")).unwrap(),
        manifest
    );
    assert_eq!(
        fs::read_to_string(vault.root().join("keep.md")).unwrap(),
        "unchanged"
    );
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

#[test]
fn new_vault_content_is_relative_confined_and_legacy_layout_is_unchanged() {
    let legacy = Fixture::new();
    assert_legacy_layout(&legacy);

    let vault = VaultParent::select(legacy._temp.path())
        .unwrap()
        .create("New 日本語", &legacy.state)
        .unwrap();
    let container = vault.vault_root().to_owned();
    let content = container.join("content");
    assert_eq!(vault.root(), content);
    let manifest_path = container.join("vault.json");
    let manifest = fs::read(&manifest_path).unwrap();
    let value: Value = serde_json::from_slice(&manifest).unwrap();
    assert_eq!(value["formatVersion"], 1);
    assert_eq!(value["contentRoot"], "content");
    fs::write(container.join("outside.md"), "# Container only\n").unwrap();
    let note = vault.create_note("notes/note.md", "# Content\n").unwrap();
    assert_content_inventory(&vault, &note, &legacy.state, &manifest);

    assert_content_reconfiguration(&vault, &legacy.state, value, &manifest);

    let preserved = container.join("preserved");
    fs::rename(&content, &preserved).unwrap();
    assert!(Vault::open(&container, &legacy.state).is_err());
    assert!(!content.exists());
    fs::create_dir(&content).unwrap();
    assert!(vault.save_copy("blocked.md", "No write").is_err());
    assert!(fs::read_dir(&content).unwrap().next().is_none());
    fs::remove_dir(&content).unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&preserved, &content).unwrap();
        assert!(Vault::open(&container, &legacy.state).is_err());
        assert!(vault.read_note("notes/note.md").is_err());
        assert!(vault.save_copy("blocked.md", "No write").is_err());
        fs::remove_file(&content).unwrap();
    }
    fs::rename(&preserved, &content).unwrap();
    let moved = legacy._temp.path().join("Moved");
    fs::rename(&container, &moved).unwrap();
    fs::create_dir(&container).unwrap();
    assert!(vault.save_copy("blocked.md", "No write").is_err());
    assert!(fs::read_dir(&container).unwrap().next().is_none());
    assert_eq!(
        fs::read_to_string(moved.join("content/notes/note.md")).unwrap(),
        note.text
    );
}

fn assert_legacy_layout(legacy: &Fixture) {
    let original = fs::read(legacy.root.join("vault.json")).unwrap();
    legacy.vault.save_copy("legacy.md", "# Legacy\n").unwrap();

    assert_eq!(legacy.vault.root(), legacy.root);
    assert_eq!(legacy.reconcile().content_root, ".");
    assert_eq!(
        fs::read_to_string(legacy.root.join("legacy.md")).unwrap(),
        "# Legacy\n"
    );
    assert!(!legacy.root.join("content").exists());

    let reopened = Vault::open(&legacy.root, &legacy.state).unwrap();

    assert_eq!(reopened.read_note("legacy.md").unwrap().text, "# Legacy\n");
    assert_eq!(fs::read(legacy.root.join("vault.json")).unwrap(), original);
}

fn assert_content_inventory(vault: &Vault, note: &NoteDocument, state: &Path, manifest: &[u8]) {
    let container = vault.vault_root();
    let content = container.join("content");

    assert_eq!(
        fs::read_to_string(content.join("notes/note.md")).unwrap(),
        note.text
    );
    assert!(!container.join("notes").exists());

    let snapshot = reconciled(vault);

    assert_eq!(snapshot.root, container.to_string_lossy());
    assert_eq!(snapshot.content_root, "content");
    assert_eq!(snapshot.name, "New 日本語");
    assert_eq!(
        vault
            .list_entries("", 0, 100)
            .unwrap()
            .entries
            .into_iter()
            .map(|entry| entry.path)
            .collect::<Vec<_>>(),
        ["notes"]
    );
    assert_eq!(
        vault.list_entries("notes", 0, 100).unwrap().entries[0].path,
        "notes/note.md"
    );
    assert!(vault.read_note("outside.md").is_err());
    assert!(vault.save_copy("../escaped.md", "No escape").is_err());

    let reopened = Vault::open(container, state).unwrap();

    assert_eq!(
        reopened.read_note("notes/note.md").unwrap().revision,
        note.revision
    );
    assert_eq!(
        reopened.read_document("notes/note.md").unwrap().0,
        content.join("notes/note.md")
    );
    assert_eq!(fs::read(container.join("vault.json")).unwrap(), manifest);
}

fn assert_content_reconfiguration(
    vault: &Vault,
    state: &Path,
    mut manifest: Value,
    original: &[u8],
) {
    let manifest_path = vault.vault_root().join("vault.json");
    let index = fs::read(vault.index_path()).unwrap();
    manifest.as_object_mut().unwrap().remove("contentRoot");
    fs::write(&manifest_path, manifest.to_string()).unwrap();

    assert!(vault.save_copy("blocked.md", "No write").is_err());
    assert!(vault.refresh().is_err());
    assert_eq!(fs::read(vault.index_path()).unwrap(), index);

    let changed_layout = Vault::open(vault.vault_root(), state).unwrap();

    assert_ne!(changed_layout.index_path(), vault.index_path());
    fs::write(&manifest_path, original).unwrap();
}
