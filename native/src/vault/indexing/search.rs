use std::collections::BTreeMap;
use std::io::Read;
use std::ops::Range;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use cap_std::fs::File;
use sha2::{Digest, Sha256};

use crate::vault::{IndexState, Vault, VaultError, VaultResult};

use super::{IndexStatus, Inventory, SearchHit, SearchPage, SearchQuery};

mod documents;
pub(super) mod links;
#[cfg(test)]
mod tests;

const MAX_BODY_BYTES: usize = 256 * 1024 * 1024;
const MAX_HITS: usize = 500;
const MAX_QUERY_BYTES: usize = 4096;
const MAX_FILES_PER_QUERY: usize = 64;
const MAX_READ_BYTES_PER_QUERY: usize = 8 * 1024 * 1024;
const QUERY_WORK_TIME: Duration = Duration::from_millis(50);
const READ_CHUNK_BYTES: usize = 64 * 1024;

struct BodyDocument {
    kind: &'static str,
    text: String,
    pages: Vec<documents::PageText>,
    revision: String,
    id: Option<String>,
    identity: String,
    links: links::NoteLinkDocument,
}

struct PendingBody {
    file: File,
    information: cap_std::fs::Metadata,
    bytes: Vec<u8>,
    hash: Sha256,
    limit: usize,
    id: Option<String>,
    identity: String,
}

/// Incremental, disposable text cache. Markdown and extracted originals have separate budgets. `omitted` records documents
/// that could not be indexed, so failed documents never get retried on every
/// keystroke.
pub(crate) struct BodyIndex {
    documents_only: bool,
    epoch: u64,
    extracting: bool,
    generation: u64,
    valid: bool,
    order: Vec<(String, Option<String>)>,
    cursor: usize,
    bytes: usize,
    omitted: BTreeMap<String, (Option<String>, bool)>,
    pending: Option<PendingBody>,
    documents: BTreeMap<String, BodyDocument>,
    link_count: usize,
}

impl BodyIndex {
    pub(crate) fn new() -> Self {
        Self {
            documents_only: false,
            epoch: 0,
            extracting: false,
            generation: 0,
            valid: false,
            order: Vec::new(),
            cursor: 0,
            bytes: 0,
            omitted: BTreeMap::new(),
            pending: None,
            documents: BTreeMap::new(),
            link_count: 0,
        }
    }

    pub(crate) fn for_documents() -> Self {
        Self {
            documents_only: true,
            ..Self::new()
        }
    }

    fn capacity(&self) -> usize {
        if self.documents_only {
            64 * 1024 * 1024
        } else {
            MAX_BODY_BYTES
        }
    }

    /// Ambiguous events/full reconciliation rebuild all bodies. Known paths use scoped invalidation.
    pub(super) fn invalidate(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.valid = false;
        self.generation = 0;
        self.order.clear();
        self.cursor = 0;
        self.bytes = 0;
        self.omitted.clear();
        self.pending = None;
        self.documents.clear();
        self.link_count = 0;
    }

    fn invalidate_path(&mut self, path: &str) {
        let prefix = format!("{path}/");
        let previous_count = self.documents.len();
        self.documents
            .retain(|key, _| key != path && !key.starts_with(&prefix));
        if self.documents.len() < previous_count {
            // Freed capacity may make previously truncated references complete.
            self.documents
                .retain(|_, document| !document.links.truncated);
            self.omitted.retain(|_, (_, capacity)| !*capacity);
        }
        self.omitted
            .retain(|key, _| key != path && !key.starts_with(&prefix));
        self.epoch = self.epoch.wrapping_add(1);
        self.valid = false;
        self.pending = None;
    }

    fn sync(&mut self, inventory: &Inventory) {
        if self.valid && self.generation == inventory.generation {
            return;
        }
        let previous_count = self.documents.len();
        self.documents.retain(|path, document| {
            inventory.rows.get(path).is_some_and(|row| {
                searchable_kind(row.entry.kind, self.documents_only)
                    && row.identity.as_deref() == Some(&document.identity)
            })
        });
        if self.documents.len() < previous_count {
            self.documents
                .retain(|_, document| !document.links.truncated);
            self.omitted.retain(|_, (_, capacity)| !*capacity);
        }
        self.omitted.retain(|path, (identity, _)| {
            inventory.rows.get(path).is_some_and(|row| {
                searchable_kind(row.entry.kind, self.documents_only) && &row.identity == identity
            })
        });
        self.epoch = self.epoch.wrapping_add(1);
        self.generation = inventory.generation;
        self.valid = true;
        self.order = inventory
            .rows
            .values()
            .filter(|row| {
                searchable_kind(row.entry.kind, self.documents_only)
                    && !self.documents.contains_key(&row.entry.path)
                    && !self.omitted.contains_key(&row.entry.path)
            })
            .map(|row| (row.entry.path.clone(), row.identity.clone()))
            .collect();
        self.cursor = 0;
        self.bytes = self
            .documents
            .values()
            .map(|document| document.text.len())
            .sum();
        self.link_count = self
            .documents
            .values()
            .map(|document| document.links.outgoing.len())
            .sum();
        self.pending = None;
    }

    fn open_source(&mut self, vault: &Vault) -> bool {
        let (path, identity) = &self.order[self.cursor];
        if identity.is_none() {
            self.omit();
            return false;
        }
        let source = crate::vault::navigation::navigation_target(vault, path).and_then(|target| {
            let file = target
                .source
                .ok_or_else(|| VaultError::invalid("Source is no longer a file."))?;
            let information = file.metadata()?;
            Ok((file, information, target.entry.id, target.identity))
        });
        let source_limit = if self.documents_only {
            documents::MAX_SOURCE_BYTES
        } else {
            crate::vault::MAX_BYTES as usize
        };
        let limit = (self.capacity() - self.bytes).min(source_limit);
        match source {
            Ok((file, information, id, identity)) if information.len() <= limit as u64 => {
                self.pending = Some(PendingBody {
                    file,
                    bytes: Vec::with_capacity(information.len() as usize),
                    information,
                    hash: Sha256::new(),
                    limit,
                    id,
                    identity,
                });
                true
            }
            Ok((_, information, _, _)) => {
                self.omit_with_capacity(information.len() <= source_limit as u64);
                false
            }
            Err(_) => {
                self.omit();
                false
            }
        }
    }

    fn finish(
        &mut self,
        path: String,
        kind: &'static str,
        text: Option<documents::ExtractedText>,
        pending: PendingBody,
    ) {
        let Some(documents::ExtractedText { text, pages }) = text else {
            self.omit();
            return;
        };
        if text.len() > self.capacity() - self.bytes {
            self.omit_with_capacity(true);
            return;
        }
        let links = if self.documents_only {
            links::NoteLinkDocument::empty()
        } else {
            links::parse_note_links(
                &path,
                &text,
                links::MAX_CACHED_LINKS.saturating_sub(self.link_count),
            )
        };
        self.link_count += links.outgoing.len();
        self.bytes += text.len();
        self.documents.insert(
            path,
            BodyDocument {
                kind,
                text,
                pages,
                links,
                revision: crate::vault::hex_digest(&pending.hash.finalize()),
                id: pending.id,
                identity: pending.identity,
            },
        );
        self.cursor += 1;
        if self.bytes == self.capacity() {
            while self.can_continue() {
                self.omit_with_capacity(true);
            }
        }
    }

    fn can_continue(&self) -> bool {
        self.cursor < self.order.len()
    }

    fn omit(&mut self) {
        self.omit_with_capacity(false);
    }

    fn omit_with_capacity(&mut self, capacity: bool) {
        self.pending = None;
        let (path, identity) = &self.order[self.cursor];
        self.omitted
            .insert(path.clone(), (identity.clone(), capacity));
        self.cursor += 1;
    }
}

fn searchable_kind(kind: &str, documents_only: bool) -> bool {
    if documents_only {
        matches!(kind, "pdf" | "docx")
    } else {
        kind == "markdown"
    }
}

fn same_source(before: &cap_std::fs::Metadata, after: &cap_std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || before.ctime() != after.ctime()
            || before.ctime_nsec() != after.ctime_nsec()
        {
            return false;
        }
    }
    before.len() == after.len() && before.modified().ok() == after.modified().ok()
}

fn content_status(
    inventory: &Inventory,
    notes: &BodyIndex,
    documents: &BodyIndex,
    cancelled: bool,
) -> IndexStatus {
    let mut result = status(inventory, Some(notes), cancelled);
    if cancelled || !inventory.complete {
        return result;
    }
    if notes.can_continue() || documents.can_continue() {
        result.state = IndexState::Partial;
        result.message =
            Some("Reading Markdown, PDF and DOCX text. Results are still incomplete.".into());
    } else if !notes.omitted.is_empty() || !documents.omitted.is_empty() {
        result.state = IndexState::Partial;
        result.message = Some(format!(
            "{} files omitted: unreadable, encrypted, no extractable text, or source/extraction limits reached. Scanned PDFs require OCR, which is not included.",
            notes.omitted.len() + documents.omitted.len()
        ));
    }
    result
}

fn content_hits(
    path: &str,
    document: &BodyDocument,
    query: &str,
    page: &Range<usize>,
    hits: &mut Vec<SearchHit>,
    matched: &mut usize,
    cancel: &AtomicBool,
) {
    if query.is_empty() {
        return;
    }
    let mut next_line_offset = 0;
    for (line_number, line) in document.text.split_inclusive('\n').enumerate() {
        if cancel.load(Ordering::Acquire) || *matched > MAX_HITS {
            return;
        }
        let line_offset = next_line_offset;
        next_line_offset += line.len();
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
            cursor = start + folded[start..].chars().next().map_or(1, char::len_utf8);
            *matched += 1;
            if *matched > MAX_HITS {
                return;
            }
            // Count all bounded matches, but only map columns and copy snippets for this page.
            if !page.contains(&(*matched - 1)) {
                continue;
            }
            while boundary <= start {
                let Some((column, (byte, character))) = original.next() else {
                    break;
                };
                position = (column, byte);
                boundary += character.to_lowercase().map(char::len_utf8).sum::<usize>();
            }
            let snippet_start = line[..position.1]
                .char_indices()
                .rev()
                .nth(79)
                .map_or(0, |(byte, _)| byte);
            hits.push(SearchHit {
                path: path.to_owned(),
                kind: document.kind.into(),
                id: document.id.clone(),
                identity: document.identity.clone(),
                line: (document.kind == "markdown").then_some(line_number + 1),
                column: (document.kind == "markdown").then_some(position.0 + 1),
                page: document
                    .pages
                    .iter()
                    .find(|range| (range.start..range.end).contains(&(line_offset + position.1)))
                    .map(|range| range.page),
                snippet: line[snippet_start..].chars().take(240).collect(),
                revision: Some(document.revision.clone()),
            });
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
                bodies.documents.len() + bodies.omitted.len() + bodies.order.len() - bodies.cursor
            ));
        } else if !bodies.omitted.is_empty() {
            status.state = IndexState::Partial;
            status.message = Some(format!(
                "Markdown search indexed {}/{} documents; {} were omitted because they were unreadable, invalid UTF-8, had unverifiable identities, or exceeded source/cache limits. No further sources can be indexed until the Vault changes.",
                bodies.documents.len(),
                bodies.documents.len() + bodies.omitted.len() + bodies.order.len() - bodies.cursor,
                bodies.omitted.len()
            ));
        }
    }
    status
}
impl Vault {
    pub(super) fn invalidate_search_index(&self) {
        for cache in [&self.body_index, &self.document_index] {
            cache
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .invalidate();
        }
    }

    pub(super) fn invalidate_search_path(&self, path: &str) {
        for cache in [&self.body_index, &self.document_index] {
            cache
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .invalidate_path(path);
        }
    }

    fn index_more(&self, cancel: &AtomicBool, documents_only: bool) {
        let cache = if documents_only {
            &self.document_index
        } else {
            &self.body_index
        };
        let mut bodies = cache.lock().unwrap_or_else(|error| error.into_inner());
        if !bodies.valid || bodies.extracting {
            return;
        }
        let started = Instant::now();
        let mut processed = 0;
        let mut read_bytes = 0;
        let mut buffer = [0; READ_CHUNK_BYTES];
        while bodies.can_continue() {
            if cancel.load(Ordering::Acquire)
                || processed
                    >= if documents_only {
                        1
                    } else {
                        MAX_FILES_PER_QUERY
                    }
                || read_bytes >= MAX_READ_BYTES_PER_QUERY
                || started.elapsed() >= QUERY_WORK_TIME
            {
                return;
            }
            if bodies.pending.is_none() && !bodies.open_source(self) {
                processed += 1;
                continue;
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
                    let mut pending = bodies.pending.take().expect("A source is open");
                    let (path, expected) = bodies.order[bodies.cursor].clone();
                    let kind = crate::vault::capability::kind(std::path::Path::new(&path));
                    let current = crate::vault::navigation::navigation_target(self, &path).ok();
                    let verified = expected.as_deref() == Some(&pending.identity)
                        && current.as_ref().is_some_and(|target| {
                            target.identity == pending.identity
                                && target
                                    .source
                                    .as_ref()
                                    .and_then(|file| file.metadata().ok())
                                    .is_some_and(|metadata| {
                                        same_source(&pending.information, &metadata)
                                    })
                        })
                        && pending
                            .file
                            .metadata()
                            .is_ok_and(|metadata| same_source(&pending.information, &metadata));
                    let text = if verified {
                        if documents_only {
                            let epoch = bodies.epoch;
                            bodies.extracting = true;
                            drop(bodies);
                            let text = documents::extract(kind, &pending.bytes, cancel);
                            bodies = cache.lock().unwrap_or_else(|error| error.into_inner());
                            bodies.extracting = false;
                            if bodies.epoch != epoch {
                                return;
                            }
                            // The source may have changed while the parser ran without the cache lock.
                            text.filter(|_| {
                                crate::vault::navigation::navigation_target(self, &path)
                                    .ok()
                                    .is_some_and(|target| {
                                        target.identity == pending.identity
                                            && target
                                                .source
                                                .and_then(|file| file.metadata().ok())
                                                .is_some_and(|metadata| {
                                                    same_source(&pending.information, &metadata)
                                                })
                                    })
                            })
                        } else {
                            String::from_utf8(std::mem::take(&mut pending.bytes))
                                .ok()
                                .map(documents::ExtractedText::plain)
                        }
                    } else {
                        None
                    };
                    if documents_only && cancel.load(Ordering::Acquire) {
                        bodies.pending = Some(pending);
                        return;
                    }
                    bodies.finish(path, kind, text, pending);
                    processed += 1;
                }
                Ok(length) => {
                    read_bytes += length;
                    if pending.bytes.len() + length > pending.limit {
                        let capacity = pending.limit
                            < if documents_only {
                                documents::MAX_SOURCE_BYTES
                            } else {
                                crate::vault::MAX_BYTES as usize
                            };
                        bodies.omit_with_capacity(capacity);
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
            filters,
        } = search;
        self.ensure_current_manifest()?;
        filters.validate()?;
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
        if mode == "path" || query.trim().is_empty() {
            let needle = query.trim().to_lowercase();
            let mut hits = Vec::new();
            let mut matched = 0;
            for row in inventory.rows.values() {
                if row.entry.kind == "directory" || !filters.matches(row) {
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
                    // The extra match proves truncation; later rows cannot affect this page.
                    if matched > MAX_HITS {
                        break;
                    }
                    if matched > offset && hits.len() < limit {
                        hits.push(SearchHit {
                            path: row.entry.path.clone(),
                            kind: row.entry.kind.into(),
                            id: row.entry.id.clone(),
                            identity: identity.clone(),
                            line: None,
                            column: None,
                            page: None,
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
        let mut extracted = self
            .document_index
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        extracted.sync(&inventory);
        if offset > 0 && (!inventory.complete || bodies.can_continue() || extracted.can_continue())
        {
            return Err(VaultError::conflict(
                "Search coverage can still change; continue only after source indexing finishes.",
                None,
            ));
        }
        drop(extracted);
        drop(bodies);
        drop(inventory);
        self.index_more(cancel, false);
        self.index_more(cancel, true);

        let inventory = self.inventory();
        let bodies = self
            .body_index
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let extracted = self
            .document_index
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !bodies.valid
            || !extracted.valid
            || inventory.generation != generation
            || bodies.generation != generation
            || extracted.generation != generation
        {
            return Err(VaultError::conflict(
                "Search coverage changed while indexing. Restart the search from the first page.",
                None,
            ));
        }
        if offset > 0 && (!inventory.complete || bodies.can_continue() || extracted.can_continue())
        {
            return Err(VaultError::conflict(
                "Search coverage can still change; restart from the first page after source indexing finishes.",
                None,
            ));
        }
        let query = query.to_lowercase();
        let mut hits = Vec::with_capacity(limit);
        let page = offset..offset.saturating_add(limit);
        let mut matched = 0;
        let all: BTreeMap<_, _> = bodies
            .documents
            .iter()
            .chain(extracted.documents.iter())
            .filter(|(path, _)| {
                inventory
                    .rows
                    .get(*path)
                    .is_some_and(|row| filters.matches(row))
            })
            .collect();
        for (path, document) in all {
            if cancel.load(Ordering::Acquire) {
                break;
            }
            content_hits(
                path,
                document,
                &query,
                &page,
                &mut hits,
                &mut matched,
                cancel,
            );
            if matched > MAX_HITS {
                break;
            }
        }
        let available = matched.min(MAX_HITS);
        Ok(SearchPage {
            request_id,
            hits,
            has_more: inventory.complete
                && !bodies.can_continue()
                && !extracted.can_continue()
                && available > offset.saturating_add(limit),
            can_continue: bodies.can_continue() || extracted.can_continue(),
            truncated: matched > MAX_HITS,
            indexing: content_status(
                &inventory,
                &bodies,
                &extracted,
                cancel.load(Ordering::Acquire),
            ),
            generation,
        })
    }
}
