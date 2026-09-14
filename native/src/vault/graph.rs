use super::{IndexStatus, Vault, VaultError, VaultResult, capability, mutations, persistence};
use cap_std::fs::Dir;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    io::{self, Write},
    path::Path,
};
use uuid::Uuid;

const FILE: &str = "graph.json";
const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SavedGraphNode {
    pub key: String,
    pub path: String,
    pub id: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GraphData {
    pub version: u32,
    pub nodes: Vec<SavedGraphNode>,
    pub edges: Vec<GraphEdge>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GraphRecord {
    vault_id: String,
    revision: u64,
    graph: GraphData,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphNode {
    pub key: String,
    pub path: String,
    pub kind: &'static str,
    pub id: Option<String>,
    pub identity: String,
    pub reference_kind: &'static str,
    pub problem: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphSnapshot {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub indexing: IndexStatus,
    pub generation: u64,
    pub complete: bool,
    pub revision: u64,
}

impl GraphData {
    fn validate(&self) -> VaultResult<()> {
        if self.version != 1 || self.nodes.len() > 50_000 || self.edges.len() > 100_000 {
            return Err(VaultError::invalid(
                "Unsupported graph version or graph collection limit exceeded.",
            ));
        }
        let mut keys = HashSet::new();
        for node in &self.nodes {
            capability::relative(&node.path)?;
            if node.path.len() > 4096
                || !Vault::supported_path(Path::new(&node.path))
                || !keys.insert(node.key.as_str())
                || node.key.len() > 8192
                || node.key.is_empty()
                || node
                    .id
                    .as_ref()
                    .is_some_and(|id| Uuid::parse_str(id).is_err())
                || !matches!((node.x, node.y), (None, None) | (Some(_), Some(_)))
                || [node.x, node.y]
                    .into_iter()
                    .flatten()
                    .any(|value| !value.is_finite() || value.abs() > 10_000_000.0)
            {
                return Err(VaultError::invalid(
                    "Graph nodes require unique keys, supported files, UUID identities and finite bounded positions.",
                ));
            }
        }
        let mut edges = HashSet::new();
        let mut pairs = HashSet::new();
        for edge in &self.edges {
            let pair = if edge.source < edge.target {
                (&edge.source, &edge.target)
            } else {
                (&edge.target, &edge.source)
            };
            if edge.id.is_empty()
                || edge.id.len() > 256
                || !edges.insert(&edge.id)
                || !pairs.insert(pair)
                || edge.source == edge.target
                || !keys.contains(edge.source.as_str())
                || !keys.contains(edge.target.as_str())
            {
                return Err(VaultError::invalid(
                    "Graph connections require unique IDs, distinct existing nodes and no repeated connection.",
                ));
            }
        }
        Ok(())
    }
}

struct BoundedBytes(Vec<u8>);
impl Write for BoundedBytes {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_BYTES.saturating_sub(self.0.len()) {
            return Err(io::Error::other("Graph exceeds 32 MiB."));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn read_record(dir: &Dir, vault_id: &str) -> VaultResult<Option<(GraphRecord, Vec<u8>)>> {
    match dir.symlink_metadata(FILE) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let bytes = capability::read_limited(dir, Path::new(FILE), MAX_BYTES as u64)?;
    let record: GraphRecord = serde_json::from_slice(&bytes).map_err(|_| {
        VaultError::invalid("Graph JSON is malformed or unsupported. Its bytes were not changed.")
    })?;
    if record.vault_id != vault_id || record.revision > MAX_REVISION {
        return Err(VaultError::invalid(
            "Graph identity or revision is invalid.",
        ));
    }
    record.graph.validate()?;
    Ok(Some((record, bytes)))
}

impl Vault {
    pub(crate) fn graph_scope(&self, root: &str, vault_id: &str) -> VaultResult<()> {
        self.ensure_current_manifest()?;
        if self.vault_root.to_string_lossy() != root || self.id != vault_id {
            return Err(VaultError::invalid(
                "The active Vault changed. Reopen the graph.",
            ));
        }
        Ok(())
    }
    pub(crate) fn graph(&self) -> VaultResult<GraphSnapshot> {
        self.ensure_current_manifest()?;
        let record = if let Some(dir) = mutations::existing_admin_dir(self)? {
            let record = read_record(&dir, &self.id)?;
            capability::verify_directory(&self.vault_root.join(".adamant"), &dir)?;
            record.map(|(record, _)| record)
        } else {
            None
        };
        self.ensure_current_manifest()?;
        let (revision, data) = record.map_or_else(
            || {
                (
                    0,
                    GraphData {
                        version: 1,
                        nodes: Vec::new(),
                        edges: Vec::new(),
                    },
                )
            },
            |record| (record.revision, record.graph),
        );
        Ok(self.graph_inventory(revision, data))
    }
    pub(crate) fn save_graph(
        &self,
        graph: GraphData,
        expected_revision: u64,
    ) -> VaultResult<GraphSnapshot> {
        self.ensure_current_manifest()?;
        self.ensure_no_pending_mutations()?;
        graph.validate()?;
        if expected_revision >= MAX_REVISION {
            return Err(VaultError::conflict(
                "Graph revision exhausted. Preserve the graph before continuing.",
                None,
            ));
        }
        let record = GraphRecord {
            vault_id: self.id.clone(),
            revision: expected_revision + 1,
            graph,
        };
        let mut bytes = BoundedBytes(Vec::new());
        serde_json::to_writer_pretty(&mut bytes, &record)
            .map_err(|_| VaultError::invalid("Graph exceeds 32 MiB."))?;
        bytes
            .write_all(b"\n")
            .map_err(|_| VaultError::invalid("Graph exceeds 32 MiB."))?;
        let dir = mutations::admin_dir(self)?;
        let lock = capability::open_regular(&dir, Path::new("marker"))?.into_std();
        lock.try_lock().map_err(|error| {
            VaultError::conflict(
                format!("Graph storage is busy or could not be locked: {error}"),
                None,
            )
        })?;
        let previous = read_record(&dir, &self.id)?;
        if previous.as_ref().map_or(0, |(record, _)| record.revision) != expected_revision {
            return Err(VaultError::conflict(
                "Graph changed on disk. Keep your changes and reload before saving; nothing was overwritten.",
                None,
            ));
        }
        let staging = format!(".adamant-write-graph-{}.json", Uuid::new_v4());
        capability::write_new(&dir, Path::new(&staging), &bytes.0)?;
        self.ensure_current_manifest()?;
        capability::verify_directory(&self.vault_root.join(".adamant"), &dir)?;
        match &previous {
            None => {
                dir.hard_link(&staging, &dir, FILE)?;
                capability::sync_dir(&dir)?;
            }
            Some((_, original)) => {
                if capability::read_limited(&dir, Path::new(FILE), MAX_BYTES as u64)? != *original {
                    return Err(VaultError::conflict(
                        "Graph changed during save. Your proposed graph remains in its staging file.",
                        None,
                    ));
                }
                persistence::exchange(&dir, &staging, Path::new(FILE))?;
                capability::sync_dir(&dir)?;
                let displaced =
                    capability::read_limited(&dir, Path::new(&staging), MAX_BYTES as u64);
                let current = capability::read_limited(&dir, Path::new(FILE), MAX_BYTES as u64);
                if !displaced.as_ref().is_ok_and(|value| value == original)
                    || !current.as_ref().is_ok_and(|value| value == &bytes.0)
                {
                    return Err(VaultError::conflict(
                        format!(
                            "An external writer raced the graph save. Retained bytes remain at .adamant/{staging}; inspect both versions before continuing."
                        ),
                        None,
                    ));
                }
            }
        }
        dir.remove_file(&staging)?;
        capability::sync_dir(&dir)?;
        Ok(self.graph_inventory(record.revision, record.graph))
    }
}
