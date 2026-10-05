use std::{
    collections::{BTreeSet, HashMap},
    path::Path,
    sync::atomic::AtomicBool,
};

use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};

use crate::vault::graph::{GraphNode, GraphReference, GraphReferences};
use crate::vault::{IndexState, IndexStatus, Vault, VaultError, VaultResult, mutations};

const MAX_NOTE_BYTES: usize = 1024 * 1024;
const MAX_NOTE_LINKS: usize = 256;
pub(super) const MAX_CACHED_LINKS: usize = 25_000;
const MAX_RESULTS: usize = 100;
const MAX_TARGETS: usize = 50;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutgoingLink {
    pub href: String,
    pub target_path: String,
    pub status: LinkStatus,
    pub line: usize,
    pub column: usize,
    pub snippet: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LinkStatus {
    Resolved,
    Missing,
    Unindexed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Backlink {
    pub path: String,
    pub title: String,
    pub identity: String,
    pub line: usize,
    pub column: usize,
    pub snippet: String,
    pub revision: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteTarget {
    pub path: String,
    pub title: String,
    pub identity: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteLinksSnapshot {
    pub path: String,
    pub outgoing: Vec<OutgoingLink>,
    pub incoming: Vec<Backlink>,
    pub targets: Vec<NoteTarget>,
    pub can_continue: bool,
    pub incoming_has_more: bool,
    pub outgoing_has_more: bool,
    pub targets_has_more: bool,
    pub references_truncated: bool,
    pub indexing: IndexStatus,
    pub generation: u64,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub(crate) struct NoteLinkLimits {
    pub incoming: usize,
    pub outgoing: usize,
    pub targets: usize,
}

impl Default for NoteLinkLimits {
    fn default() -> Self {
        Self {
            incoming: MAX_RESULTS,
            outgoing: MAX_RESULTS,
            targets: MAX_TARGETS,
        }
    }
}

pub(super) struct NoteLinkDocument {
    title: String,
    pub(super) outgoing: Vec<OutgoingLink>,
    pub(super) truncated: bool,
}

impl NoteLinkDocument {
    pub(super) fn empty() -> Self {
        Self {
            title: String::new(),
            outgoing: Vec::new(),
            truncated: false,
        }
    }
}

fn fallback_title(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .chars()
        .take(240)
        .collect()
}

pub(super) fn parse_note_links(path: &str, text: &str, remaining: usize) -> NoteLinkDocument {
    let mut document = NoteLinkDocument {
        title: fallback_title(path),
        outgoing: Vec::new(),
        truncated: text.len() > MAX_NOTE_BYTES,
    };
    if document.truncated {
        return document;
    }
    let metadata = crate::vault::metadata::note_metadata(text);
    let metadata_title = metadata
        .value
        .as_ref()
        .and_then(|value| value.get("title"))
        .and_then(serde_json::Value::as_str)
        .filter(|title| !title.trim().is_empty());
    let mut heading = None;
    let mut heading_title = String::new();
    let mut image_depth = 0;
    let mut line_starts = vec![0];
    line_starts.extend(text.match_indices('\n').map(|(index, _)| index + 1));
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES;
    let body_start = crate::vault::metadata::note_body_start(text);
    for (event, range) in Parser::new_ext(&text[body_start..], options).into_offset_iter() {
        match event {
            Event::Start(Tag::Image { .. }) => image_depth += 1,
            Event::End(TagEnd::Image) => image_depth -= 1,
            Event::Start(Tag::Heading {
                level: HeadingLevel::H1,
                ..
            }) if heading_title.is_empty() => heading = Some(HeadingLevel::H1),
            Event::End(TagEnd::Heading(_)) => heading = None,
            Event::Text(value) | Event::Code(value) if heading.is_some() => {
                heading_title.extend(value.chars().take(240 - heading_title.chars().count()));
            }
            Event::Start(Tag::Link { dest_url, .. }) if image_depth == 0 => {
                let Some(target_path) = mutations::local_link_target(&dest_url, path) else {
                    continue;
                };
                if crate::vault::capability::kind(Path::new(&target_path)) != "markdown" {
                    continue;
                }
                if document.outgoing.len() >= remaining.min(MAX_NOTE_LINKS) || dest_url.len() > 4096
                {
                    document.truncated = true;
                    continue;
                }
                let link_start = body_start + range.start;
                let line = line_starts.partition_point(|&start| start <= link_start);
                let start = line_starts[line - 1];
                let end = text[start..]
                    .find('\n')
                    .map_or(text.len(), |end| start + end);
                // Keep the link in view even when it occurs late on a long source line.
                let snippet_start = text[start..link_start]
                    .char_indices()
                    .rev()
                    .nth(79)
                    .map_or(start, |(offset, _)| start + offset);
                document.outgoing.push(OutgoingLink {
                    href: dest_url.into_string(),
                    target_path,
                    status: LinkStatus::Unindexed,
                    line,
                    column: text[start..link_start].chars().count() + 1,
                    snippet: text[snippet_start..end]
                        .trim_end_matches('\r')
                        .chars()
                        .take(240)
                        .collect(),
                });
            }
            _ => {}
        }
    }
    if let Some(title) = metadata_title {
        document.title = title.chars().take(240).collect();
    } else if !heading_title.trim().is_empty() {
        document.title = heading_title;
    }
    document
}

fn reference_status(inventory: &super::Inventory, bodies: &super::BodyIndex) -> IndexStatus {
    let mut indexing = super::status(inventory, Some(bodies), false);
    if bodies
        .documents
        .values()
        .any(|document| document.links.truncated)
    {
        indexing.state = IndexState::Partial;
        indexing.message = Some("Some note references were omitted: analysis is limited to 1 MiB per Note, 256 links per Note, and 25,000 links per Vault.".into());
    }
    indexing
}

impl Vault {
    pub(crate) fn graph_references(&self, nodes: &[GraphNode], generation: u64) -> GraphReferences {
        let inventory = self.inventory();
        self.body_index
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .sync(&inventory);
        drop(inventory);
        self.index_more(&AtomicBool::new(false), false);
        let inventory = self.inventory();
        let bodies = self
            .body_index
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !bodies.valid || bodies.generation != generation || inventory.generation != generation {
            let mut indexing = inventory.status.clone();
            indexing.state = IndexState::Partial;
            indexing.message = Some(
                "Note references changed while indexing. Refresh the graph to continue.".into(),
            );
            return GraphReferences {
                edges: Vec::new(),
                indexing,
                can_continue: true,
            };
        }
        // Use resolved node keys: saved keys can be opaque, and UUID nodes can move.
        let keys: HashMap<_, _> = nodes
            .iter()
            .filter(|node| node.kind == "markdown" && !node.identity.is_empty())
            .map(|node| (node.path.as_str(), node.key.as_str()))
            .collect();
        let mut pairs = BTreeSet::new();
        for (path, document) in &bodies.documents {
            let Some(&source) = keys.get(path.as_str()) else {
                continue;
            };
            for link in &document.links.outgoing {
                if let Some(&target) = keys.get(link.target_path.as_str())
                    && source != target
                {
                    pairs.insert((source, target));
                }
            }
        }
        GraphReferences {
            edges: pairs
                .into_iter()
                .map(|(source, target)| GraphReference {
                    source: source.into(),
                    target: target.into(),
                })
                .collect(),
            indexing: reference_status(&inventory, &bodies),
            can_continue: bodies.can_continue(),
        }
    }

    pub(crate) fn note_links(
        &self,
        path: &str,
        expected_identity: Option<&str>,
        query: &str,
        limits: NoteLinkLimits,
    ) -> VaultResult<NoteLinksSnapshot> {
        self.ensure_current_manifest()?;
        crate::vault::capability::note_path(path)?;
        if query.len() > super::MAX_QUERY_BYTES {
            return Err(VaultError::invalid(
                "Note search exceeds the 4,096-byte limit.",
            ));
        }
        let source = crate::vault::navigation::navigation_target(self, path)?;
        if expected_identity.is_some_and(|expected| expected != source.identity) {
            return Err(VaultError::conflict(
                "The Note identity changed. Open it again.",
                None,
            ));
        }
        let inventory = self.inventory();
        let generation = inventory.generation;
        self.body_index
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .sync(&inventory);
        drop(inventory);
        self.index_more(&AtomicBool::new(false), false);
        let inventory = self.inventory();
        let bodies = self
            .body_index
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !bodies.valid || bodies.generation != generation || inventory.generation != generation {
            return Err(VaultError::conflict(
                "Note links changed while indexing. Refresh the references.",
                None,
            ));
        }
        let mut outgoing = Vec::new();
        let mut incoming = Vec::new();
        let mut targets = Vec::new();
        let mut incoming_has_more = false;
        let mut outgoing_has_more = false;
        let mut targets_has_more = false;
        let mut omitted_links = false;
        let query = query.to_lowercase();
        for (candidate_path, document) in &bodies.documents {
            let references = &document.links;
            omitted_links |= references.truncated;
            if candidate_path != path
                && (candidate_path.to_lowercase().contains(&query)
                    || references.title.to_lowercase().contains(&query))
            {
                if targets.len() < limits.targets.clamp(1, 50_000) {
                    targets.push(NoteTarget {
                        path: candidate_path.clone(),
                        title: references.title.clone(),
                        identity: document.identity.clone(),
                    });
                } else {
                    targets_has_more = true;
                }
            }
            for link in &references.outgoing {
                if candidate_path == path {
                    if outgoing.len() < limits.outgoing.clamp(1, MAX_CACHED_LINKS) {
                        let mut link = link.clone();
                        link.status = match inventory.rows.get(&link.target_path) {
                            Some(row) if row.entry.kind == "markdown" && row.identity.is_some() => {
                                LinkStatus::Resolved
                            }
                            _ if inventory.complete
                                && inventory.status.state == IndexState::Ready =>
                            {
                                LinkStatus::Missing
                            }
                            _ => LinkStatus::Unindexed,
                        };
                        outgoing.push(link);
                    } else {
                        outgoing_has_more = true;
                    }
                }
                if link.target_path == path {
                    if incoming.len() < limits.incoming.clamp(1, MAX_CACHED_LINKS) {
                        incoming.push(Backlink {
                            path: candidate_path.clone(),
                            title: references.title.clone(),
                            identity: document.identity.clone(),
                            revision: Some(document.revision.clone()),
                            line: link.line,
                            column: link.column,
                            snippet: link.snippet.clone(),
                        });
                    } else {
                        incoming_has_more = true;
                    }
                }
            }
        }
        Ok(NoteLinksSnapshot {
            path: path.into(),
            outgoing,
            incoming,
            targets,
            can_continue: bodies.can_continue(),
            incoming_has_more,
            outgoing_has_more,
            targets_has_more,
            references_truncated: omitted_links,
            indexing: reference_status(&inventory, &bodies),
            generation,
        })
    }
}
