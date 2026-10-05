use super::{Fixture, identified};
use crate::vault::{navigation::navigation_target, tags::TagRequest};
use std::fs;

fn request(fixture: &Fixture, path: &str, tags: &[&str]) -> TagRequest {
    let identity = navigation_target(&fixture.vault, path).unwrap().identity;
    let snapshot = fixture.vault.tags(Some(path), Some(&identity), "").unwrap();
    TagRequest {
        path: path.into(),
        expected_identity: identity,
        expected_revision: snapshot.revision,
        tags: tags.iter().map(|tag| (*tag).into()).collect(),
    }
}

#[test]
fn tag_edit_preserves_note_body_unknown_metadata_and_line_endings() {
    let f = Fixture::new();
    let id = uuid::Uuid::new_v4();
    for (name, metadata) in [
        (
            "block.md",
            format!(
                "# Keep this comment\r\nid: {id}\r\nkind: topic\r\ncustom: 'keep spelling' # untouched\r\ntags: [old] # tag comment\r\n"
            ),
        ),
        (
            "flow.md",
            format!(
                "{{id: {id}, kind: topic, custom: 'keep spelling', tags: [old]}} # untouched\r\n"
            ),
        ),
    ] {
        let text = format!("\u{feff}---\r\n{metadata}---\r\n# Coração\r\nMixed\n");
        fs::write(f.root.join(name), &text).unwrap();
        let saved = f
            .vault
            .set_tags(request(&f, name, &["rust", "日本語", "rust"]))
            .unwrap()
            .note
            .unwrap();
        assert!(saved.text.starts_with("\u{feff}---\r\n"));
        assert!(saved.text.ends_with("---\r\n# Coração\r\nMixed\n"));
        assert!(saved.text.contains("custom: 'keep spelling'"));
        assert!(saved.text.contains("# untouched\r\n"));
        if name == "block.md" {
            assert!(saved.text.contains("# tag comment\r\n"));
        }
        let snapshot = f
            .vault
            .tags(Some(name), Some(&format!("uuid:{id}")), "")
            .unwrap();
        assert_eq!(snapshot.tags, ["rust", "日本語"]);
        assert_eq!(snapshot.revision.as_deref(), Some(saved.revision.as_str()));
        let repeated = f
            .vault
            .set_tags(request(&f, name, &["rust", "日本語"]))
            .unwrap()
            .note
            .unwrap();
        assert_eq!(repeated.text, saved.text);
    }
}

#[test]
fn tag_insertion_and_removal_preserve_other_frontmatter() {
    let f = Fixture::new();
    fs::write(f.root.join("note.md"), identified("# Keep this body\n")).unwrap();
    let original = f.vault.read_note("note.md").unwrap();
    let added = f
        .vault
        .set_tags(request(&f, "note.md", &["one"]))
        .unwrap()
        .note
        .unwrap();
    assert_eq!(added.id, original.id);
    assert!(added.text.ends_with("# Keep this body\n"));
    assert!(added.text.contains("custom: 'preserve me' # comment"));
    let removed = f
        .vault
        .set_tags(request(&f, "note.md", &[]))
        .unwrap()
        .note
        .unwrap();
    assert!(removed.text.contains("tags: []"));
    assert_eq!(removed.id, original.id);
}

#[test]
fn document_tags_use_companions_without_changing_originals_or_annotations() {
    let f = Fixture::new();
    for path in ["paper.pdf", "report.docx"] {
        let original = b"Original binary\0\xff";
        fs::write(f.root.join(path), original).unwrap();
        let companion = f.root.join(format!("{path}.meta.yaml"));
        f.vault.set_tags(request(&f, path, &[])).unwrap();
        assert!(!companion.exists());
        let changed = f.vault.set_tags(request(&f, path, &["reading"])).unwrap();
        assert!(changed.note.is_none());
        assert!(changed.identity.starts_with("uuid:"));
        let previous = fs::read_to_string(&companion).unwrap();
        let with_extra = format!(
            "{previous}title: 'Paper' # keep\nrefs: [{{kind: note, id: {}}}]\n",
            uuid::Uuid::new_v4()
        );
        fs::write(&companion, &with_extra).unwrap();
        f.vault
            .set_tags(request(&f, path, &["reading", "work"]))
            .unwrap();
        let after = fs::read_to_string(&companion).unwrap();
        assert_eq!(
            after,
            with_extra.replace("tags: [\"reading\"]", "tags: [\"reading\",\"work\"]")
        );
        assert_eq!(fs::read(f.root.join(path)).unwrap(), original);
    }
}

#[test]
fn tag_changes_reject_stale_revisions_replacements_and_unsafe_yaml() {
    let f = Fixture::new();
    fs::write(f.root.join("note.md"), identified("# Before\n")).unwrap();
    let stale = request(&f, "note.md", &["later"]);
    let external = f
        .vault
        .read_note("note.md")
        .unwrap()
        .text
        .replace("Before", "External");
    fs::write(f.root.join("note.md"), &external).unwrap();
    assert!(f.vault.set_tags(stale).is_err());
    assert_eq!(
        fs::read_to_string(f.root.join("note.md")).unwrap(),
        external
    );

    let replaced = request(&f, "note.md", &["later"]);
    let replacement = identified("# Different UUID\n");
    fs::write(f.root.join("note.md"), &replacement).unwrap();
    assert!(f.vault.set_tags(replaced).is_err());
    assert_eq!(
        fs::read_to_string(f.root.join("note.md")).unwrap(),
        replacement
    );

    for raw in [
        "# Unmanaged\n".to_owned(),
        format!(
            "---\nid: {}\ncustom: &shared [one]\ntags: *shared\n---\n# Body\n",
            uuid::Uuid::new_v4()
        ),
    ] {
        fs::write(f.root.join("note.md"), &raw).unwrap();
        assert!(f.vault.set_tags(request(&f, "note.md", &["two"])).is_err());
        assert_eq!(fs::read_to_string(f.root.join("note.md")).unwrap(), raw);
    }

    fs::write(f.root.join("document.pdf"), b"%PDF-source").unwrap();
    f.vault
        .set_tags(request(&f, "document.pdf", &["original"]))
        .unwrap();
    let stale = request(&f, "document.pdf", &["submitted"]);
    let companion = f.root.join("document.pdf.meta.yaml");
    let external = fs::read_to_string(&companion).unwrap() + "title: External\n";
    fs::write(&companion, &external).unwrap();
    assert!(f.vault.set_tags(stale).is_err());
    assert_eq!(fs::read_to_string(&companion).unwrap(), external);
}

#[test]
fn tag_facets_and_graph_use_derived_metadata_and_bound_suggestions() {
    let f = Fixture::new();
    fs::create_dir(f.root.join("notes")).unwrap();
    for number in 0..105 {
        let tags = format!("tag-{number:03}");
        fs::write(
            f.root.join(format!("notes/{number}.md")),
            format!(
                "---\nid: {}\ntags: [{tags}, shared]\n---\nBody",
                uuid::Uuid::new_v4()
            ),
        )
        .unwrap();
    }
    f.reconcile();
    let facets = f.vault.tags(None, None, "").unwrap();
    assert_eq!(facets.suggestions.len(), 100);
    assert!(facets.more_suggestions);
    assert_eq!(facets.folders, ["notes"]);
    let searched = f.vault.tags(None, None, "104").unwrap();
    assert_eq!(searched.suggestions, ["tag-104"]);
    assert!(!searched.more_suggestions);
    let graph = f.vault.graph().unwrap();
    assert!(
        graph
            .nodes
            .iter()
            .find(|node| node.path == "notes/104.md")
            .unwrap()
            .tags
            .contains(&"tag-104".to_owned())
    );
    assert!(!f.root.join(".adamant/graph.json").exists());
}

#[test]
fn tags_and_filter_inputs_enforce_bounded_safe_values() {
    use crate::vault::indexing::SearchFilters;
    for tags in [
        vec!["".into()],
        vec![" trailing ".into()],
        vec!["line\nbreak".into()],
        vec!["x".repeat(129)],
        vec!["tag".into(); 65],
    ] {
        assert!(crate::vault::tags::validated_tags(&tags).is_err());
    }
    for filters in [
        SearchFilters {
            directory: Some("../outside".into()),
            ..Default::default()
        },
        SearchFilters {
            kinds: vec!["html".into()],
            ..Default::default()
        },
    ] {
        assert!(filters.validate().is_err());
    }
    assert!(
        SearchFilters {
            directory: Some("notes/topic".into()),
            tags: vec!["rust".into()],
            kinds: vec!["markdown".into()]
        }
        .validate()
        .is_ok()
    );

    let f = Fixture::new();
    let tags = (0..65)
        .map(|index| format!("tag-{index}"))
        .collect::<Vec<_>>();
    let text = format!(
        "---\nid: {}\ntags: {}\n---\n# Source\n",
        uuid::Uuid::new_v4(),
        serde_json::to_string(&tags).unwrap()
    );
    fs::write(f.root.join("existing.md"), &text).unwrap();
    let identity = navigation_target(&f.vault, "existing.md").unwrap().identity;
    let snapshot = f
        .vault
        .tags(Some("existing.md"), Some(&identity), "")
        .unwrap();
    assert_eq!(
        snapshot.tags, tags,
        "existing metadata must not be silently truncated"
    );
    assert!(
        f.vault
            .set_tags(TagRequest {
                path: "existing.md".into(),
                expected_identity: identity,
                expected_revision: snapshot.revision,
                tags
            })
            .is_err()
    );
    assert_eq!(
        fs::read_to_string(f.root.join("existing.md")).unwrap(),
        text
    );
}
