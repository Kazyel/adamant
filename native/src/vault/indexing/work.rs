//! Bounded batch lifecycle, inventory publication, and completion diagnostics.
use std::{
    collections::HashMap,
    ops::Bound::{Excluded, Unbounded},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use sqlx::SqliteConnection;
use uuid::Uuid;

use crate::vault::{Vault, VaultError, VaultResult};

use super::{
    IndexState, IndexedEntry, Issues, MAX_ENTRIES, MAX_ISSUES, MAX_METADATA_BYTES, message,
    parent_path,
};

mod cache;
mod discovery;
mod metadata;

use cache::{Delta, open_index, prune_index, write_changes};

const WORK_TIME: Duration = Duration::from_secs(5);
const COMMIT_ROWS: usize = 64;

impl Vault {
    pub fn reconcile(
        &self,
        cancel: &AtomicBool,
        on_directory: &mut dyn FnMut(&Path) -> VaultResult<()>,
    ) -> VaultResult<bool> {
        let _work = self
            .index_work
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.ensure_current_manifest()?;
        let mut work = Work::new(self, cancel, on_directory, true);
        let dir = self.dir.try_clone()?;
        work.directory(&dir, "", 0);
        work.finish(&[String::new()])
    }

    pub fn apply_changes(
        &self,
        paths: &[PathBuf],
        cancel: &AtomicBool,
        on_directory: &mut dyn FnMut(&Path) -> VaultResult<()>,
    ) -> VaultResult<bool> {
        let _work = self
            .index_work
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.ensure_current_manifest()?;
        let mut work = Work::new(self, cancel, on_directory, false);
        if work.full {
            // A missing cache cannot be reconstructed from one watcher delta. Reuse the
            // bounded full walk; cancellation/limits keep its partial state explicit.
            let dir = self.dir.try_clone()?;
            work.directory(&dir, "", 0);
            return work.finish(&[String::new()]);
        }
        let admitted = work.changed_scopes(paths);

        for path in &admitted {
            if !work.examine() {
                break;
            }

            work.changed_path(path);
        }

        work.finish(&admitted)
    }
}

struct Work<'a> {
    vault: &'a Vault,
    cancel: &'a AtomicBool,
    on_directory: &'a mut dyn FnMut(&Path) -> VaultResult<()>,
    started: Instant,
    progress: Instant,
    examined: usize,
    directories: usize,
    metadata_read: usize,
    incomplete: bool,
    halted: bool,
    full: bool,
    was_complete: bool,
    epoch: u64,
    token: String,
    issues: Issues,
    metadata_issues: Issues,
    pending: Vec<Delta>,
    database: Option<SqliteConnection>,
}

impl<'a> Work<'a> {
    fn new(
        vault: &'a Vault,
        cancel: &'a AtomicBool,
        on_directory: &'a mut dyn FnMut(&Path) -> VaultResult<()>,
        full: bool,
    ) -> Self {
        let started = Instant::now();
        let (epoch, was_complete) = {
            let mut inventory = vault.inventory();
            inventory.epoch += 1;
            inventory.status.state = if full {
                IndexState::Indexing
            } else {
                IndexState::Stale
            };
            inventory.status.scanned_entries = 0;
            inventory.status.message =
                Some("Reading bounded document metadata; source files remain available.".into());
            (inventory.epoch, inventory.complete)
        };
        let mut work = Self {
            vault,
            cancel,
            on_directory,
            started,
            progress: started,
            // Reserve both bounded manifest guards as part of the metadata read budget.
            examined: 0,
            directories: 0,
            metadata_read: 2 * MAX_METADATA_BYTES as usize,
            incomplete: false,
            halted: false,
            full,
            was_complete,
            epoch,
            token: Uuid::new_v4().to_string(),
            issues: Issues::default(),
            metadata_issues: Issues::default(),
            pending: Vec::with_capacity(COMMIT_ROWS),
            database: None,
        };
        if work.checkpoint() {
            match tauri::async_runtime::block_on(open_index(vault)) {
                Ok((connection, fresh)) => {
                    work.database = Some(connection);
                    if fresh && !full {
                        work.full = true;
                        vault.set_index_state(
                            IndexState::Indexing,
                            Some("The disposable SQLite index was recreated; rebuilding bounded metadata.".into()),
                        );
                    }
                }
                Err(error) => work.cache_error(error),
            }
        }
        work
    }

    fn partial(&mut self, path: &str, description: impl Into<String>) {
        self.incomplete = true;
        self.issues.push(path, description);
    }

    fn checkpoint(&mut self) -> bool {
        if self.halted {
            return false;
        }
        if self.cancel.load(Ordering::Acquire) {
            self.halted = true;
            self.partial(
                "",
                "Indexing was cancelled. Unseen inventory rows were retained.",
            );
        } else if self.started.elapsed() >= WORK_TIME {
            self.halted = true;
            self.partial(
                "",
                "The five-second indexing budget was reached. Unseen inventory rows were retained.",
            );
        }
        !self.halted
    }

    fn examine(&mut self) -> bool {
        if !self.checkpoint() {
            return false;
        }
        if self.examined >= MAX_ENTRIES {
            self.halted = true;
            self.partial("", "The 50,000-entry inspection budget was reached. Narrow the Vault or reconcile after reducing its contents.");
            return false;
        }
        self.examined += 1;
        if self.examined.is_multiple_of(COMMIT_ROWS)
            || self.progress.elapsed() >= Duration::from_millis(150)
        {
            self.flush();
        }
        true
    }

    fn put(&mut self, row: IndexedEntry) {
        if !self.checkpoint() {
            return;
        }
        if !self.vault.inventory().put(row.clone()) {
            self.halted = true;
            self.partial(&row.entry.path, "The bounded in-memory entry, directory or metadata capacity was reached. Existing rows were retained.");
            return;
        }
        self.pending.push(Delta::Put(row));
        if self.pending.len() >= COMMIT_ROWS {
            self.flush();
        }
    }

    fn subtree_paths(&self, path: &str) -> Vec<String> {
        let inventory = self.vault.inventory();
        let prefix = format!("{path}/");
        let mut paths: Vec<String> = inventory
            .rows
            .range(prefix.clone()..)
            .take_while(|(key, _)| key.starts_with(&prefix))
            .map(|(key, _)| key.clone())
            .collect();
        if inventory.rows.contains_key(path) {
            paths.push(path.into());
        }
        paths
    }

    fn delete_subtree(&mut self, path: &str) {
        for path in self.subtree_paths(path) {
            if !self.checkpoint() {
                break;
            }
            self.vault.inventory().remove(&path);
        }
        // Also invalidate cached rows from an earlier process that have not entered memory.
        self.pending.push(Delta::DeleteSubtree(path.into()));
        if self.pending.len() >= COMMIT_ROWS {
            self.flush();
        }
    }

    fn cache_error(&mut self, error: VaultError) {
        self.issues.push("vault.json", format!("Files and the in-memory inventory remain available; the disposable SQLite index could not be updated: {}", error.message));
        self.database = None;
    }

    fn flush(&mut self) {
        if let Some(database) = self.database.as_mut()
            && !self.pending.is_empty()
            && let Err(error) =
                tauri::async_runtime::block_on(write_changes(database, &self.pending, &self.token))
        {
            self.cache_error(error);
        }

        self.pending.clear();
        let mut inventory = self.vault.inventory();
        inventory.status.scanned_entries = self.examined;
        inventory.issues = self.issues.clone();
        inventory.issues.append(&self.metadata_issues);
        self.progress = Instant::now();
    }

    fn diagnostics(&mut self, complete: bool, scopes: &[String]) {
        if !self.checkpoint() {
            return;
        }
        // Count eligible identities once. Repeatedly filtering a large collision group for
        // every member would become quadratic when a reconciliation has unseen old rows.
        let identities: HashMap<String, usize> = {
            let inventory = self.vault.inventory();
            inventory
                .identities
                .iter()
                .filter_map(|(id, paths)| {
                    let count = paths
                        .iter()
                        .filter(|path| {
                            !complete
                                || inventory.rows.get(*path).is_some_and(|row| {
                                    row.epoch == self.epoch || !covered(path, scopes)
                                })
                        })
                        .count();
                    (count > 0).then(|| (id.clone(), count))
                })
                .collect()
        };
        let mut after = None;
        loop {
            if !self.checkpoint() {
                break;
            }
            let rows = {
                let inventory = self.vault.inventory();
                inventory
                    .rows
                    .range::<String, _>((after.as_ref().map_or(Unbounded, Excluded), Unbounded))
                    .take(COMMIT_ROWS)
                    .map(|(_, row)| (row.entry.clone(), row.references.clone(), row.epoch))
                    .collect::<Vec<_>>()
            };
            if rows.is_empty() {
                break;
            }
            after = rows.last().map(|(entry, _, _)| entry.path.clone());
            for (entry, references, epoch) in rows {
                let path = &entry.path;
                if complete && epoch != self.epoch && covered(path, scopes) {
                    continue;
                }
                if epoch != self.epoch
                    && let Some(error) = entry.metadata_error
                {
                    self.issues.push(path, error);
                }

                if let Some(id) = &entry.id
                    && identities.get(id).is_some_and(|count| *count > 1)
                {
                    self.issues.push_with(path, || format!("UUID collision {id}: multiple documents share this identity. Content was not merged."));
                }
                if complete {
                    for id in &references {
                        if !identities.contains_key(id) {
                            if self.issues.items.len() < MAX_ISSUES {
                                let issue_path = if matches!(entry.kind, "pdf" | "docx") {
                                    format!("{path}.meta.yaml")
                                } else {
                                    path.clone()
                                };
                                self.issues.push_with(&issue_path, || {
                                    format!("Unresolved reference: {id}")
                                });
                            } else {
                                self.issues.count = self.issues.count.saturating_add(1);
                            }
                        }
                    }
                }
            }
        }
    }

    fn finish(mut self, scopes: &[String]) -> VaultResult<bool> {
        self.checkpoint();
        if let Err(error) = self.vault.ensure_current_manifest() {
            self.partial("vault.json", error.message.clone());
            self.database = None;
            self.flush();
            self.vault.inventory().complete = false;
            self.vault
                .set_index_state(IndexState::Partial, Some(message(error.message.clone())));
            return Err(error);
        }
        self.diagnostics(!self.incomplete && (self.full || self.was_complete), scopes);
        self.flush();
        // No sweep after an incomplete traversal. Positive changes and observed deletions
        // already committed above remain useful; all unobserved rows stay intact.
        if !self.incomplete {
            let missing = {
                let inventory = self.vault.inventory();
                inventory
                    .rows
                    .iter()
                    .filter(|(path, row)| row.epoch != self.epoch && covered(path, scopes))
                    .map(|(path, _)| path.clone())
                    .collect::<Vec<_>>()
            };
            if self.checkpoint() {
                let result = if let Some(database) = self.database.as_mut() {
                    tauri::async_runtime::block_on(prune_index(
                        database,
                        scopes,
                        &self.token,
                        self.cancel,
                        self.started,
                    ))
                } else {
                    Ok(true)
                };
                match result {
                    Ok(false) => {
                        self.checkpoint();
                    }
                    Err(error) => {
                        self.cache_error(error);
                        self.checkpoint();
                    }
                    Ok(true) => {}
                }
                if !self.incomplete {
                    // All source enumeration and cancellable SQL work is complete. This small
                    // in-memory commit has no I/O; cancellation after this boundary is a new state.
                    for paths in missing.chunks(COMMIT_ROWS) {
                        let mut inventory = self.vault.inventory();
                        for path in paths {
                            inventory.remove(path);
                        }
                    }
                }
            }
        }
        let complete = !self.incomplete;
        {
            let mut inventory = self.vault.inventory();
            inventory.complete = complete && (self.full || self.was_complete);
            inventory.issues = self.issues.clone();
            inventory.issues.append(&self.metadata_issues);
            inventory.status.scanned_entries = self.examined;
            // Never Ready here: events may have arrived while the traversal was running.
            inventory.status.state = if self.cancel.load(Ordering::Acquire) {
                IndexState::Cancelled
            } else if !complete {
                IndexState::Partial
            } else if self.full {
                IndexState::Indexing
            } else {
                IndexState::Stale
            };
            inventory.status.message = Some(if complete {
                "Metadata batch complete; waiting for pending filesystem events to drain.".into()
            } else {
                self.issues.items.first().map(|issue| issue.message.clone()).unwrap_or_else(|| "Metadata indexing is incomplete. Existing rows and source files were retained.".into())
            });
        }
        Ok(complete)
    }
}

fn covered(mut path: &str, scopes: &[String]) -> bool {
    loop {
        if scopes
            .binary_search_by(|scope| scope.as_str().cmp(path))
            .is_ok()
        {
            return true;
        }
        if path.is_empty() {
            return false;
        }
        path = parent_path(path);
    }
}
