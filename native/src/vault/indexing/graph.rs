use super::IndexedEntry;
use crate::vault::{
    Vault,
    graph::{GraphData, GraphNode, GraphReferences, GraphSnapshot, SavedGraphNode},
};
use serde_json::Value;
use std::collections::HashSet;

fn node(
    row: &IndexedEntry,
    key: String,
    saved: Option<&SavedGraphNode>,
    duplicate: bool,
) -> GraphNode {
    let value = row
        .metadata
        .as_ref()
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    let reference_kind = if row.entry.kind != "markdown" {
        "document"
    } else {
        match value.as_ref().and_then(|value| value["kind"].as_str()) {
            Some("topic") => "topic",
            Some("documentation-page") => "documentation-page",
            _ => "note",
        }
    };
    GraphNode { key, path: row.entry.path.clone(), kind: row.entry.kind, id: row.entry.id.clone(), identity: row.identity.clone().unwrap_or_default(), tags: crate::vault::tags::metadata_tags(value.as_ref()), reference_kind,
        problem: duplicate.then(|| "Duplicate file UUID; graph connections use this specific path until the collision is resolved.".into()),
        x: saved.and_then(|node| node.x), y: saved.and_then(|node| node.y) }
}

impl Vault {
    pub(crate) fn graph_inventory(&self, revision: u64, data: GraphData) -> GraphSnapshot {
        let inventory = self.inventory();
        let mut graph = GraphSnapshot {
            nodes: Vec::new(),
            edges: data.edges,
            references: GraphReferences {
                edges: Vec::new(),
                indexing: inventory.status.clone(),
                can_continue: false,
            },
            indexing: inventory.status.clone(),
            generation: inventory.generation,
            complete: inventory.complete && inventory.status.state == super::IndexState::Ready,
            revision,
        };
        let mut represented = HashSet::new();
        let mut keys = HashSet::new();
        for saved in &data.nodes {
            keys.insert(saved.key.clone());
            let (row, problem, missing) = if let Some(id) = &saved.id {
                let id = uuid::Uuid::parse_str(id)
                    .expect("Graph UUID was validated")
                    .to_string();
                match inventory.identities.get(&id) {
                    Some(paths) if paths.len() == 1 => (
                        paths
                            .iter()
                            .next()
                            .and_then(|path| inventory.rows.get(path)),
                        None,
                        false,
                    ),
                    Some(_) if saved.key == format!("path:{}", saved.path) => (
                        inventory
                            .rows
                            .get(&saved.path)
                            .filter(|row| row.entry.id.as_ref() == Some(&id)),
                        None,
                        false,
                    ),
                    Some(_) => (
                        None,
                        Some(
                            "Duplicate file identity. Resolve the collision to reconnect this node.",
                        ),
                        false,
                    ),
                    None => (
                        None,
                        Some("This file is missing from the current inventory."),
                        !inventory.rows.contains_key(&saved.path),
                    ),
                }
            } else {
                let row = inventory.rows.get(&saved.path);
                (row, None, row.is_none())
            };
            if let Some(row) =
                row.filter(|row| matches!(row.entry.kind, "markdown" | "pdf" | "docx"))
                && represented.insert(row.entry.path.clone())
            {
                let duplicate = row.entry.id.as_ref().is_some_and(|id| {
                    inventory
                        .identities
                        .get(id)
                        .is_some_and(|paths| paths.len() > 1)
                });
                graph
                    .nodes
                    .push(node(row, saved.key.clone(), Some(saved), duplicate));
                continue;
            }
            if graph.complete && missing {
                continue;
            }
            graph.nodes.push(GraphNode {
                key: saved.key.clone(),
                path: saved.path.clone(),
                kind: crate::vault::capability::kind(std::path::Path::new(&saved.path)),
                id: saved.id.clone(),
                identity: String::new(),
                tags: Vec::new(),
                reference_kind: if saved.path.to_ascii_lowercase().ends_with(".md") {
                    "note"
                } else {
                    "document"
                },
                problem: Some(
                    problem
                        .unwrap_or(
                            "This file is missing or already represented by another graph node.",
                        )
                        .into(),
                ),
                x: saved.x,
                y: saved.y,
            });
        }
        for row in inventory
            .rows
            .values()
            .filter(|row| matches!(row.entry.kind, "markdown" | "pdf" | "docx"))
        {
            if represented.contains(&row.entry.path) {
                continue;
            }
            let duplicate = row.entry.id.as_ref().is_some_and(|id| {
                inventory
                    .identities
                    .get(id)
                    .is_some_and(|paths| paths.len() > 1)
            });
            let mut key = match &row.entry.id {
                Some(id) if !duplicate => format!("uuid:{id}"),
                _ => format!("path:{}", row.entry.path),
            };
            let base = key.clone();
            let mut suffix = 1usize;
            while !keys.insert(key.clone()) {
                key = format!("{base}#{suffix}");
                suffix += 1;
            }
            graph.nodes.push(node(row, key, None, duplicate));
        }
        let visible_keys: HashSet<_> = graph.nodes.iter().map(|node| &node.key).collect();
        graph.edges.retain(|edge| {
            visible_keys.contains(&edge.source) && visible_keys.contains(&edge.target)
        });
        drop(inventory);
        graph.references = self.graph_references(&graph.nodes, graph.generation);
        graph
    }
}
