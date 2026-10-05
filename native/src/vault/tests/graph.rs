use super::{Fixture, Vault, fs};
use crate::vault::graph::{GraphData, GraphEdge, GraphSnapshot, SavedGraphNode};

fn data(snapshot: &GraphSnapshot) -> GraphData {
    GraphData {
        version: 1,
        nodes: snapshot
            .nodes
            .iter()
            .map(|node| SavedGraphNode {
                key: node.key.clone(),
                path: node.path.clone(),
                id: node.id.clone(),
                x: node.x,
                y: node.y,
            })
            .collect(),
        edges: snapshot.edges.clone(),
    }
}

fn connect_all(graph: &mut GraphData) {
    for (index, source) in graph.nodes.iter().enumerate() {
        for target in graph.nodes.iter().skip(index + 1) {
            graph.edges.push(GraphEdge {
                id: uuid::Uuid::new_v4().to_string(),
                source: source.key.clone(),
                target: target.key.clone(),
            });
        }
    }
}

#[test]
fn graph_links_all_formats_without_touching_any_source_or_metadata_and_restores_positions() {
    let f = Fixture::new();
    let id = uuid::Uuid::new_v4();
    let md = format!(
        "\u{feff}---\r\nid: '{id}' # keep\r\nkind: note\r\ncustom: 'unknown'\r\n---\r\nBody\r\n"
    );
    for (path, text) in [
        ("a.md", md.as_str()),
        ("b.md", "raw"),
        ("a.pdf", "PDF"),
        ("a.docx", "DOCX"),
    ] {
        fs::write(f.root.join(path), text).unwrap();
    }
    f.reconcile();
    let first = f.vault.graph().unwrap();
    assert_eq!(first.nodes.len(), 4);
    assert!(!f.root.join(".adamant/graph.json").exists());
    let mut graph = data(&first);
    graph.nodes[0].x = Some(150.0);
    graph.nodes[0].y = Some(-42.5);
    connect_all(&mut graph);
    let saved = f.vault.save_graph(graph, 0).unwrap();
    assert_eq!(saved.revision, 1);
    assert_eq!(saved.edges.len(), 6);
    assert_eq!(fs::read_to_string(f.root.join("a.md")).unwrap(), md);
    assert_eq!(fs::read_to_string(f.root.join("b.md")).unwrap(), "raw");
    assert_eq!(fs::read_to_string(f.root.join("a.pdf")).unwrap(), "PDF");
    assert_eq!(fs::read_to_string(f.root.join("a.docx")).unwrap(), "DOCX");
    assert!(!f.root.join("a.pdf.meta.yaml").exists());
    assert!(!f.root.join("a.docx.meta.yaml").exists());
    let reopened = Vault::open(&f.root, &f.state).unwrap();
    super::reconciled(&reopened);
    let restored = reopened.graph().unwrap();
    assert_eq!(restored.edges.len(), 6);
    assert_eq!(restored.nodes[0].x, Some(150.0));
    assert_eq!(restored.nodes[0].y, Some(-42.5));
}

#[test]
fn graph_rejects_stale_revisions_wrong_scope_invalid_edges_and_coordinates() {
    let f = Fixture::new();
    fs::write(f.root.join("a.md"), "raw").unwrap();
    f.reconcile();
    let first = f.vault.graph().unwrap();
    let saved = f.vault.save_graph(data(&first), 0).unwrap();
    let bytes = fs::read(f.root.join(".adamant/graph.json")).unwrap();
    assert!(f.vault.save_graph(data(&first), 0).is_err());
    assert!(f.vault.graph_scope("/wrong", "wrong").is_err());
    let mut graph = data(&saved);
    graph.edges.push(GraphEdge {
        id: "x".into(),
        source: graph.nodes[0].key.clone(),
        target: "missing".into(),
    });
    assert!(f.vault.save_graph(graph, 1).is_err());
    let mut graph = data(&saved);
    graph.nodes[0].x = Some(f64::NAN);
    graph.nodes[0].y = Some(0.0);
    assert!(f.vault.save_graph(graph, 1).is_err());
    let mut graph = data(&saved);
    graph.nodes[0].path = "../outside.md".into();
    assert!(f.vault.save_graph(graph, 1).is_err());
    assert_eq!(fs::read(f.root.join(".adamant/graph.json")).unwrap(), bytes);
    fs::write(f.root.join(".adamant/graph.json"), b"invalid JSON").unwrap();
    assert!(f.vault.graph().is_err());
    assert!(f.vault.save_graph(data(&saved), 1).is_err());
    assert_eq!(
        fs::read(f.root.join(".adamant/graph.json")).unwrap(),
        b"invalid JSON"
    );
}

#[test]
fn graph_resolves_uuid_moves_and_preserves_duplicate_identity_connections() {
    let f = Fixture::new();
    let note = f.vault.create_note("a.md", "A").unwrap();
    fs::write(f.root.join("b.pdf"), b"PDF").unwrap();
    f.reconcile();
    let initial = f.vault.graph().unwrap();
    let mut graph = data(&initial);
    graph.edges.push(GraphEdge {
        id: "edge".into(),
        source: graph.nodes[0].key.clone(),
        target: graph.nodes[1].key.clone(),
    });
    f.vault.save_graph(graph, 0).unwrap();
    fs::rename(f.root.join("a.md"), f.root.join("moved.md")).unwrap();
    f.reconcile();
    let moved = f.vault.graph().unwrap();
    assert_eq!(moved.nodes[0].path, "moved.md");
    assert_eq!(moved.nodes[0].key, initial.nodes[0].key);
    fs::write(f.root.join("duplicate.md"), note.text).unwrap();
    f.reconcile();
    let duplicate = f.vault.graph().unwrap();
    assert!(duplicate.nodes[0].identity.is_empty());
    assert!(
        duplicate.nodes[0]
            .problem
            .as_ref()
            .unwrap()
            .contains("Duplicate")
    );
    assert_eq!(duplicate.nodes.len(), 4);
    assert_eq!(duplicate.edges.len(), 1);
}

#[test]
fn graph_hides_deleted_files_and_connections_and_restores_trashed_positions() {
    use crate::vault::mutations::{MutationKind, MutationRequest};

    let f = Fixture::new();
    f.vault.create_folder("removed").unwrap();
    f.vault
        .create_note("remaining.md", "[gone](removed/note.md)")
        .unwrap();
    f.vault.create_note("removed/note.md", "Note").unwrap();
    fs::write(f.root.join("removed/paper.pdf"), b"PDF").unwrap();
    fs::write(f.root.join("removed/document.docx"), b"DOCX").unwrap();
    f.reconcile();
    let mut graph = data(&references_complete(&f));
    for node in &mut graph.nodes {
        node.x = Some(120.0);
        node.y = Some(240.0);
    }
    connect_all(&mut graph);
    let saved = f.vault.save_graph(graph, 0).unwrap();
    let authored = fs::read(f.root.join(".adamant/graph.json")).unwrap();
    let plan = f
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Trash,
            paths: vec!["removed".into()],
            destination: None,
        })
        .unwrap();
    assert_eq!(
        f.vault.commit_mutation(&plan.id).unwrap().outcomes[0].status,
        "completed"
    );
    f.reconcile();
    let removed = references_complete(&f);
    assert_eq!(removed.nodes.len(), 1);
    assert_eq!(removed.nodes[0].path, "remaining.md");
    assert!(removed.edges.is_empty());
    assert!(removed.references.edges.is_empty());
    assert_eq!(
        fs::read(f.root.join(".adamant/graph.json")).unwrap(),
        authored
    );

    let trash = f.vault.list_trash().unwrap();
    assert_eq!(
        f.vault.restore_trash(&trash[0].id, None).unwrap().outcomes[0].status,
        "completed"
    );
    f.reconcile();
    let restored = references_complete(&f);
    assert_eq!(restored.nodes.len(), saved.nodes.len());
    assert_eq!(restored.edges.len(), saved.edges.len());
    assert!(restored.references.edges.is_empty());
    for node in &restored.nodes {
        assert_eq!((node.x, node.y), (Some(120.0), Some(240.0)));
    }
}

#[test]
fn graph_does_not_infer_deletion_from_unscanned_files_or_changed_metadata() {
    let f = Fixture::new();
    f.vault.create_note("a.md", "A").unwrap();
    fs::write(f.root.join("b.pdf"), b"PDF").unwrap();
    f.reconcile();
    let mut graph = data(&f.vault.graph().unwrap());
    connect_all(&mut graph);
    f.vault.save_graph(graph, 0).unwrap();
    let reopened = Vault::open(&f.root, &f.state).unwrap();
    let pending = reopened.graph().unwrap();
    assert!(!pending.complete);
    assert_eq!(pending.nodes.len(), 2);
    assert_eq!(pending.edges.len(), 1);
    super::reconciled(&reopened);
    let ready = reopened.graph().unwrap();
    assert!(ready.complete);
    assert_eq!(ready.nodes.len(), 2);
    assert_eq!(ready.edges.len(), 1);
    fs::write(f.root.join("a.md"), "Metadata temporarily removed").unwrap();
    super::reconciled(&reopened);
    let changed = reopened.graph().unwrap();
    assert!(changed.complete);
    assert!(
        changed
            .nodes
            .iter()
            .any(|node| node.key == ready.nodes[0].key)
    );
    assert_eq!(changed.edges.len(), 1);
}

#[cfg(unix)]
#[test]
fn graph_storage_rejects_symlinks_and_reports_partial_inventory() {
    let f = Fixture::new();
    let first = f.vault.graph().unwrap();
    let saved = f.vault.save_graph(data(&first), 0).unwrap();
    let path = f.root.join(".adamant/graph.json");
    fs::remove_file(&path).unwrap();
    let outside = f.state.join("outside.json");
    fs::write(&outside, "untouched").unwrap();
    std::os::unix::fs::symlink(&outside, &path).unwrap();
    assert!(f.vault.graph().is_err());
    assert!(f.vault.save_graph(data(&saved), 1).is_err());
    assert_eq!(fs::read_to_string(outside).unwrap(), "untouched");
    fs::remove_file(&path).unwrap();
    f.vault.set_index_state(
        crate::vault::IndexState::Partial,
        Some("Test coverage".into()),
    );
    assert!(!f.vault.graph().unwrap().complete);
}

#[test]
fn persisted_graph_matches_published_schema() {
    let f = Fixture::new();
    fs::write(f.root.join("notes.md"), "plain Markdown").unwrap();
    fs::write(f.root.join("paper.PDF"), "original").unwrap();
    f.reconcile();
    let mut graph = data(&f.vault.graph().unwrap());
    graph.nodes[0].x = Some(12.5);
    graph.nodes[0].y = Some(-80.0);
    connect_all(&mut graph);
    f.vault.save_graph(graph, 0).unwrap();
    let record: serde_json::Value =
        serde_json::from_slice(&fs::read(f.root.join(".adamant/graph.json")).unwrap()).unwrap();
    let schema: serde_json::Value =
        serde_json::from_str(include_str!("../../../../schemas/graph.schema.json")).unwrap();
    let validator = jsonschema::options().build(&schema).unwrap();
    assert!(
        validator.is_valid(&record),
        "{:?}",
        validator
            .iter_errors(&record)
            .map(|error| error.to_string())
            .collect::<Vec<_>>()
    );
    let mut invalid = record.clone();
    invalid["graph"]["nodes"][0]["x"] = serde_json::json!(10_000_001);
    assert!(!validator.is_valid(&invalid));
    let mut invalid = record.clone();
    invalid["graph"]["nodes"][0]["path"] = serde_json::json!("../outside.md");
    assert!(!validator.is_valid(&invalid));
    let mut invalid = record.clone();
    invalid["graph"]["nodes"][0]["y"] = serde_json::Value::Null;
    assert!(!validator.is_valid(&invalid));
    let mut invalid = record;
    invalid["revision"] = serde_json::json!(-1);
    assert!(!validator.is_valid(&invalid));
}

#[test]
fn discovered_keys_do_not_collide_with_saved_keys_and_json_is_readable() {
    let f = Fixture::new();
    fs::write(f.root.join("a.md"), "raw").unwrap();
    f.reconcile();
    f.vault.set_index_state(
        super::IndexState::Partial,
        Some("Unseen paths remain".into()),
    );
    let graph = GraphData {
        version: 1,
        nodes: vec![
            SavedGraphNode {
                key: "path:a.md".into(),
                path: "missing.md".into(),
                id: None,
                x: None,
                y: None,
            },
            SavedGraphNode {
                key: "path:a.md#1".into(),
                path: "other.md".into(),
                id: None,
                x: None,
                y: None,
            },
        ],
        edges: vec![],
    };
    let saved = f.vault.save_graph(graph, 0).unwrap();
    assert_eq!(saved.nodes.len(), 3);
    assert_eq!(saved.nodes[2].key, "path:a.md#2");
    let keys = saved
        .nodes
        .iter()
        .map(|node| &node.key)
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(keys.len(), saved.nodes.len());
    let bytes = fs::read_to_string(f.root.join(".adamant/graph.json")).unwrap();
    assert!(bytes.starts_with("{\n  \"vaultId\":"));
    assert!(bytes.ends_with("}\n"));
}

fn references_complete(fixture: &Fixture) -> GraphSnapshot {
    for _ in 0..40 {
        let snapshot = fixture.vault.graph().unwrap();
        if !snapshot.references.can_continue {
            return snapshot;
        }
    }
    panic!("Graph reference indexing did not finish within its bounded batches");
}

#[test]
fn graph_derives_directed_markdown_pairs_without_persisting_them() {
    let f = Fixture::new();
    let source = "[b](b.md) [again][b] [self](a.md) [missing](missing.md)\n\n[b]: b.md\n`[code](c.md)`\n![image](c.md)\n[external](https://example.com/c.md)";
    fs::write(f.root.join("a.md"), source).unwrap();
    fs::write(f.root.join("b.md"), "[a](a.md)").unwrap();
    fs::write(f.root.join("c.md"), "no links").unwrap();
    f.reconcile();
    let snapshot = references_complete(&f);
    assert!(snapshot.edges.is_empty());
    assert_eq!(snapshot.references.edges.len(), 2);
    assert_eq!(snapshot.references.indexing.state, super::IndexState::Ready);
    assert_eq!(snapshot.references.edges[0].source, "path:a.md");
    assert_eq!(snapshot.references.edges[0].target, "path:b.md");
    assert_eq!(snapshot.references.edges[1].source, "path:b.md");
    assert_eq!(snapshot.references.edges[1].target, "path:a.md");
    let saved = f.vault.save_graph(data(&snapshot), 0).unwrap();
    assert_eq!(saved.references.edges.len(), 2);
    let record: serde_json::Value =
        serde_json::from_slice(&fs::read(f.root.join(".adamant/graph.json")).unwrap()).unwrap();
    assert_eq!(record["graph"]["edges"], serde_json::json!([]));
    assert!(record["graph"].get("references").is_none());
    assert!(record.get("references").is_none());
    assert_eq!(fs::read_to_string(f.root.join("a.md")).unwrap(), source);
}

#[test]
fn graph_references_follow_saved_changes_and_uuid_renames_with_opaque_keys() {
    use crate::vault::mutations::{MutationKind, MutationRequest};

    let f = Fixture::new();
    f.vault.create_note("a.md", "[b](b.md)").unwrap();
    f.vault.create_note("b.md", "B").unwrap();
    f.reconcile();
    let mut graph = data(&references_complete(&f));
    graph.nodes[0].key = "opaque-source".into();
    graph.nodes[1].key = "opaque-target".into();
    connect_all(&mut graph);
    let saved = f.vault.save_graph(graph, 0).unwrap();
    assert_eq!(saved.references.edges[0].source, "opaque-source");
    assert_eq!(saved.references.edges[0].target, "opaque-target");
    let plan = f
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Rename,
            paths: vec!["b.md".into()],
            destination: Some("renamed target.md".into()),
        })
        .unwrap();
    f.vault.commit_mutation(&plan.id).unwrap();
    f.reconcile();
    let renamed = references_complete(&f);
    assert_eq!(renamed.nodes[1].path, "renamed target.md");
    assert_eq!(renamed.references.edges.len(), 1);
    assert_eq!(renamed.references.edges[0].target, "opaque-target");
    let source = f.vault.read_note("a.md").unwrap();
    let metadata_end = source.text.find("\n---\n").unwrap() + 5;
    let metadata = &source.text[..metadata_end];
    f.vault
        .save_note(
            "a.md",
            &format!("{metadata}Links removed"),
            &source.revision,
        )
        .unwrap();
    f.reconcile();
    let removed = references_complete(&f);
    assert!(removed.references.edges.is_empty());
    assert_eq!(removed.edges.len(), 1);
    fs::write(
        f.root.join("a.md"),
        format!("{metadata}[back](renamed%20target.md)"),
    )
    .unwrap();
    f.reconcile();
    assert_eq!(references_complete(&f).references.edges.len(), 1);
    fs::remove_file(f.root.join("renamed target.md")).unwrap();
    f.reconcile();
    let missing = references_complete(&f);
    assert!(missing.references.edges.is_empty());
    assert!(missing.edges.is_empty());
    assert_eq!(missing.nodes.len(), 1);
}

#[test]
fn graph_references_report_bounded_batches_and_permanent_analysis_limits() {
    let f = Fixture::new();
    for index in 0..65 {
        fs::write(
            f.root.join(format!("note-{index:03}.md")),
            "[target](target.md)",
        )
        .unwrap();
    }
    fs::write(f.root.join("target.md"), "Target").unwrap();
    fs::write(
        f.root.join("too-many.md"),
        "[target](target.md)\n".repeat(257),
    )
    .unwrap();
    fs::write(f.root.join("too-large.md"), "x".repeat(1024 * 1024 + 1)).unwrap();
    f.reconcile();
    let first = f.vault.graph().unwrap();
    assert!(first.complete);
    assert!(first.references.can_continue);
    assert_eq!(first.references.indexing.state, super::IndexState::Partial);
    let final_snapshot = references_complete(&f);
    assert_eq!(final_snapshot.references.edges.len(), 66);
    assert_eq!(
        final_snapshot.references.indexing.state,
        super::IndexState::Partial
    );
    assert!(
        final_snapshot
            .references
            .indexing
            .message
            .unwrap()
            .contains("256 links")
    );
}

#[test]
fn graph_references_use_discovered_keys_for_duplicate_uuid_nodes() {
    let f = Fixture::new();
    let duplicate = super::identified("Target");
    fs::write(f.root.join("a.md"), "[one](b.md) [two](c.md)").unwrap();
    fs::write(f.root.join("b.md"), &duplicate).unwrap();
    f.reconcile();
    f.vault
        .save_graph(data(&references_complete(&f)), 0)
        .unwrap();
    fs::write(f.root.join("c.md"), duplicate).unwrap();
    f.reconcile();
    let graph = references_complete(&f);
    assert_eq!(graph.references.edges.len(), 2);
    assert_eq!(graph.references.edges[0].target, "path:b.md");
    assert_eq!(graph.references.edges[1].target, "path:c.md");
    assert!(graph.nodes.iter().any(|node| node.identity.is_empty()));
}

#[test]
fn graph_references_do_not_mix_inventory_generations() {
    let f = Fixture::new();
    fs::write(f.root.join("a.md"), "[b](b.md)").unwrap();
    fs::write(f.root.join("b.md"), "B").unwrap();
    f.reconcile();
    let previous = references_complete(&f);
    fs::remove_file(f.root.join("b.md")).unwrap();
    f.reconcile();
    let references = f
        .vault
        .graph_references(&previous.nodes, previous.generation);
    assert!(references.edges.is_empty());
    assert!(references.can_continue);
    assert_eq!(references.indexing.state, super::IndexState::Partial);
    assert!(references_complete(&f).references.edges.is_empty());
}
