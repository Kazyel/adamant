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
fn graph_resolves_uuid_moves_but_keeps_missing_and_duplicate_identity_connections() {
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
    fs::remove_file(f.root.join("b.pdf")).unwrap();
    f.reconcile();
    assert!(f.vault.graph().unwrap().nodes[1].identity.is_empty());
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
