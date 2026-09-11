use std::collections::BTreeMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use cap_std::fs::File;
use sha2::{Digest, Sha256};

use crate::vault::{IndexState, Vault, VaultError, VaultResult};

use super::{IndexStatus, Inventory, SearchHit, SearchPage, SearchQuery};

const MAX_BODY_BYTES: usize = 256 * 1024 * 1024;
const MAX_HITS: usize = 500;
const MAX_QUERY_BYTES: usize = 4096;
const MAX_FILES_PER_QUERY: usize = 64;
const MAX_READ_BYTES_PER_QUERY: usize = 8 * 1024 * 1024;
const QUERY_WORK_TIME: Duration = Duration::from_millis(50);
const READ_CHUNK_BYTES: usize = 64 * 1024;

struct BodyDocument {
    text: String,
    revision: String,
    id: Option<String>,
    identity: String,
}

struct PendingBody {
    file: File,
    information: cap_std::fs::Metadata,
    bytes: Vec<u8>,
    hash: Sha256,
    limit: usize,
}

/// Incremental, disposable Markdown body cache. `omitted` records documents
/// that could not be indexed, so failed documents never get retried on every
/// keystroke.
pub(crate) struct BodyIndex {
    generation: u64,
    valid: bool,
    order: Vec<(String, Option<String>)>,
    cursor: usize,
    bytes: usize,
    omitted: usize,
    pending: Option<PendingBody>,
    documents: BTreeMap<String, BodyDocument>,
}

impl BodyIndex {
    pub(crate) fn new() -> Self {
        Self {
            generation: 0,
            valid: false,
            order: Vec::new(),
            cursor: 0,
            bytes: 0,
            omitted: 0,
            pending: None,
            documents: BTreeMap::new(),
        }
    }

    /// Inventory mutations invalidate all bodies. This coarse reset prevents
    /// an event for an undiscovered replacement from leaving stale full text.
    pub(super) fn invalidate(&mut self) {
        self.valid = false;
        self.generation = 0;
        self.order.clear();
        self.cursor = 0;
        self.bytes = 0;
        self.omitted = 0;
        self.pending = None;
        self.documents.clear();
    }

    fn sync(&mut self, inventory: &Inventory) {
        if self.valid && self.generation == inventory.generation {
            return;
        }
        self.generation = inventory.generation;
        self.valid = true;
        self.order = inventory
            .rows
            .values()
            .filter(|row| row.entry.kind == "markdown")
            .map(|row| (row.entry.path.clone(), row.identity.clone()))
            .collect();
        self.cursor = 0;
        self.bytes = 0;
        self.omitted = 0;
        self.pending = None;
        self.documents.clear();
    }

    fn can_continue(&self) -> bool {
        self.cursor < self.order.len()
    }

    fn omit(&mut self) {
        self.pending = None;
        self.omitted += 1;
        self.cursor += 1;
    }
}

fn content_hits(
    path: &str,
    document: &BodyDocument,
    query: &str,
    hits: &mut Vec<SearchHit>,
    matched: &mut usize,
    cancel: &AtomicBool,
) {
    if query.is_empty() {
        return;
    }
    for (line_number, line) in document.text.split_inclusive('\n').enumerate() {
        if cancel.load(Ordering::Acquire) || *matched > MAX_HITS {
            return;
        }
        let line = line.trim_end_matches(['\r', '\n']);
        let folded = line.to_lowercase();
        let mut cursor = 0;
        let mut original = line.char_indices().enumerate();
        let mut boundary = 0;
        let mut position = (0, 0);
        while let Some(found) = folded[cursor..].find(query) {
            if cancel.load(Ordering::Acquire) || *matched > MAX_HITS {
                return;
            }
            let start = cursor + found;
            while boundary <= start {
                let Some((column, (byte, character))) = original.next() else {
                    break;
                };
                position = (column, byte);
                boundary += character.to_lowercase().map(char::len_utf8).sum::<usize>();
            }
            *matched += 1;
            if *matched > MAX_HITS {
                return;
            }
            let snippet_start = line[..position.1]
                .char_indices()
                .rev()
                .nth(79)
                .map_or(0, |(byte, _)| byte);
            hits.push(SearchHit {
                path: path.to_owned(),
                kind: "markdown".into(),
                id: document.id.clone(),
                identity: document.identity.clone(),
                line: Some(line_number + 1),
                column: Some(position.0 + 1),
                snippet: line[snippet_start..].chars().take(240).collect(),
                revision: Some(document.revision.clone()),
            });
            cursor = start + folded[start..].chars().next().map_or(1, char::len_utf8);
        }
    }
}

fn status(inventory: &Inventory, bodies: Option<&BodyIndex>, cancelled: bool) -> IndexStatus {
    let mut status = inventory.status.clone();
    if cancelled {
        status.state = IndexState::Cancelled;
        status.message =
            Some("Search indexing was cancelled; results cover the indexed subset.".into());
    } else if !inventory.complete {
        status.state = IndexState::Partial;
        status.message =
            Some("Search coverage is incomplete while the Vault inventory is changing.".into());
    } else if let Some(bodies) = bodies {
        if bodies.can_continue() {
            status.state = IndexState::Partial;
            status.message = Some(format!(
                "Markdown search coverage is incomplete ({}/{} documents indexed); search again to continue indexing.",
                bodies.documents.len(),
                bodies.order.len()
            ));
        } else if bodies.omitted > 0 {
            status.state = IndexState::Partial;
            status.message = Some(format!(
                "Markdown search indexed {}/{} documents; {} were omitted because they were unreadable, invalid UTF-8, had unverifiable identities, or exceeded source/cache limits. No further sources can be indexed until the Vault changes.",
                bodies.documents.len(),
                bodies.order.len(),
                bodies.omitted
            ));
        }
    }
    status
}
impl Vault {
    pub(super) fn invalidate_search_index(&self) {
        let mut bodies = self
            .body_index
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        bodies.invalidate();
    }

    fn index_more(&self, cancel: &AtomicBool) {
        let mut bodies = self
            .body_index
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let started = Instant::now();
        let mut processed = 0;
        let mut read_bytes = 0;
        let mut buffer = [0; READ_CHUNK_BYTES];
        while bodies.can_continue() {
            if cancel.load(Ordering::Acquire)
                || processed >= MAX_FILES_PER_QUERY
                || read_bytes >= MAX_READ_BYTES_PER_QUERY
                || started.elapsed() >= QUERY_WORK_TIME
            {
                return;
            }
            if bodies.pending.is_none() {
                if bodies.order[bodies.cursor].1.is_none() {
                    bodies.omit();
                    processed += 1;
                    continue;
                }
                let path = &bodies.order[bodies.cursor].0;
                let source = self.parent(path, false).and_then(|(dir, name)| {
                    let file = crate::vault::capability::open_regular(&dir, &name)?;
                    let information = file.metadata()?;
                    Ok((file, information))
                });
                let limit = (MAX_BODY_BYTES - bodies.bytes).min(crate::vault::MAX_BYTES as usize);
                match source {
                    Ok((file, information)) if information.len() <= limit as u64 => {
                        bodies.pending = Some(PendingBody {
                            file,
                            bytes: Vec::with_capacity(information.len() as usize),
                            information,
                            hash: Sha256::new(),
                            limit,
                        });
                    }
                    Ok(_) | Err(_) => {
                        bodies.omit();
                        processed += 1;
                        continue;
                    }
                }
            }
            // Keep the current source and its bytes on cancellation or budget exhaustion.
            // The extra byte detects growth beyond the source/cache limit without a full read.
            if cancel.load(Ordering::Acquire) || started.elapsed() >= QUERY_WORK_TIME {
                return;
            }
            let pending = bodies.pending.as_mut().expect("A source is open");
            let available = buffer
                .len()
                .min(MAX_READ_BYTES_PER_QUERY - read_bytes)
                .min(pending.limit - pending.bytes.len() + 1);
            match pending.file.read(&mut buffer[..available]) {
                Ok(0) => {
                    let pending = bodies.pending.take().expect("A source is open");
                    let document = String::from_utf8(pending.bytes).ok().and_then(|text| {
                        let id = crate::vault::metadata::note_metadata(&text).id;
                        let identity = crate::vault::navigation::target_identity(
                            id.as_deref(),
                            &pending.information,
                        )
                        .ok()?;
                        let (path, expected) = &bodies.order[bodies.cursor];
                        if expected.as_deref() != Some(identity.as_str()) {
                            return None;
                        }
                        Some((
                            path.clone(),
                            BodyDocument {
                                text,
                                revision: crate::vault::hex_digest(&pending.hash.finalize()),
                                id,
                                identity,
                            },
                        ))
                    });
                    match document {
                        Some((path, document)) => {
                            bodies.bytes += document.text.len();
                            bodies.documents.insert(path, document);
                            bodies.cursor += 1;
                            if bodies.bytes == MAX_BODY_BYTES {
                                let remaining = bodies.order.len() - bodies.cursor;
                                bodies.omitted += remaining;
                                bodies.cursor = bodies.order.len();
                            }
                        }
                        None => bodies.omit(),
                    }
                    processed += 1;
                }
                Ok(length) => {
                    read_bytes += length;
                    if pending.bytes.len() + length > pending.limit {
                        bodies.omit();
                        processed += 1;
                    } else {
                        pending.hash.update(&buffer[..length]);
                        pending.bytes.extend_from_slice(&buffer[..length]);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => {
                    bodies.omit();
                    processed += 1;
                }
            }
        }
    }

    pub fn search(&self, search: SearchQuery<'_>, cancel: &AtomicBool) -> VaultResult<SearchPage> {
        let SearchQuery {
            request_id,
            query,
            mode,
            offset,
            limit,
            expected_generation,
        } = search;
        self.ensure_current_manifest()?;
        if query.len() > MAX_QUERY_BYTES {
            return Err(VaultError::invalid(
                "Search query exceeds the 4,096-byte limit.",
            ));
        }
        if !matches!(mode, "path" | "content") {
            return Err(VaultError::invalid("Search mode must be path or content."));
        }
        let limit = limit.clamp(1, 50);
        let inventory = self.inventory();
        let generation = inventory.generation;
        if offset > 0 {
            let Some(expected) = expected_generation else {
                return Err(VaultError::conflict(
                    "Search continuation requires the generation returned by the first page.",
                    None,
                ));
            };
            if expected != generation {
                return Err(VaultError::conflict(
                    "Search coverage changed. Restart the search from the first page.",
                    None,
                ));
            }
        }
        if mode == "path" {
            let needle = query.to_lowercase();
            let mut hits = Vec::new();
            let mut matched = 0;
            for row in inventory.rows.values() {
                if row.entry.kind == "directory" {
                    continue;
                }
                if cancel.load(Ordering::Acquire) {
                    break;
                }
                let Some(identity) = &row.identity else {
                    continue;
                };
                if row.entry.path.to_lowercase().contains(&needle) {
                    matched += 1;
                    if matched > offset && hits.len() < limit && matched <= MAX_HITS {
                        hits.push(SearchHit {
                            path: row.entry.path.clone(),
                            kind: row.entry.kind.into(),
                            id: row.entry.id.clone(),
                            identity: identity.clone(),
                            line: None,
                            column: None,
                            snippet: row.entry.path.clone(),
                            revision: None,
                        });
                    }
                }
            }
            let available = matched.min(MAX_HITS);
            return Ok(SearchPage {
                request_id,
                hits,
                has_more: available > offset.saturating_add(limit),
                can_continue: false,
                truncated: matched > MAX_HITS,
                indexing: status(&inventory, None, cancel.load(Ordering::Acquire)),
                generation,
            });
        }
        let mut bodies = self
            .body_index
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        bodies.sync(&inventory);
        if offset > 0 && (!inventory.complete || bodies.can_continue()) {
            return Err(VaultError::conflict(
                "Search coverage can still change; continue only after source indexing finishes.",
                None,
            ));
        }
        drop(bodies);
        drop(inventory);
        self.index_more(cancel);

        let inventory = self.inventory();
        let bodies = self
            .body_index
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !bodies.valid || inventory.generation != generation || bodies.generation != generation {
            return Err(VaultError::conflict(
                "Search coverage changed while indexing. Restart the search from the first page.",
                None,
            ));
        }
        if offset > 0 && (!inventory.complete || bodies.can_continue()) {
            return Err(VaultError::conflict(
                "Search coverage can still change; restart from the first page after source indexing finishes.",
                None,
            ));
        }
        let query = query.to_lowercase();
        let mut all = Vec::new();
        let mut matched = 0;
        for (path, document) in &bodies.documents {
            if cancel.load(Ordering::Acquire) {
                break;
            }
            content_hits(path, document, &query, &mut all, &mut matched, cancel);
            if matched > MAX_HITS {
                break;
            }
        }
        let page = all.into_iter().skip(offset).take(limit).collect::<Vec<_>>();
        let available = matched.min(MAX_HITS);
        Ok(SearchPage {
            request_id,
            hits: page,
            has_more: inventory.complete
                && !bodies.can_continue()
                && available > offset.saturating_add(limit),
            can_continue: bodies.can_continue(),
            truncated: matched > MAX_HITS,
            indexing: status(&inventory, Some(&bodies), cancel.load(Ordering::Acquire)),
            generation,
        })
    }
}
