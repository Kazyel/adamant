use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};

use tauri::Emitter;

use crate::vault::{IndexState, IndexStatus, Vault, VaultError, VaultResult};
use watching::DirectoryWatches;

mod watching;

const WATCH_QUEUE: usize = 256;
const CHANGE_BATCH: usize = 1024;
const INVALIDATION_INTERVAL: Duration = Duration::from_millis(150);

#[derive(Clone, Copy, PartialEq, Eq)]
enum IndexRequest {
    Idle,
    Reconcile,
    Cancel,
}

struct WorkerControl {
    request: Mutex<IndexRequest>,
    enabled: AtomicBool,
    stop: AtomicBool,
    cancel: AtomicBool,
    working: AtomicBool,
    pending_paths: AtomicUsize,
    overflow: AtomicBool,
    overflow_epoch: AtomicU64,
    auto_reconcile: AtomicBool,
}

impl WorkerControl {
    fn new() -> Self {
        Self {
            request: Mutex::new(IndexRequest::Idle),
            enabled: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            working: AtomicBool::new(false),
            pending_paths: AtomicUsize::new(0),
            overflow: AtomicBool::new(false),
            overflow_epoch: AtomicU64::new(0),
            auto_reconcile: AtomicBool::new(false),
        }
    }

    fn request(&self) -> std::sync::MutexGuard<'_, IndexRequest> {
        self.request
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn missed_changes(&self) {
        self.overflow_epoch.fetch_add(1, Ordering::AcqRel);
        // One automatic bounded recovery per overflow episode. A partial recovery stays stale
        // until the user explicitly retries, rather than endlessly rescanning a huge folder.
        if !self.overflow.swap(true, Ordering::AcqRel) {
            self.auto_reconcile.store(true, Ordering::Release);
        }
    }

    fn take_reconcile(&self) -> bool {
        let mut request = self.request();

        if *request == IndexRequest::Cancel {
            return false;
        }

        if *request != IndexRequest::Reconcile && !self.auto_reconcile.swap(false, Ordering::AcqRel)
        {
            return false;
        }

        *request = IndexRequest::Idle;
        self.auto_reconcile.store(false, Ordering::Release);
        self.cancel.store(false, Ordering::Release);
        self.working.store(true, Ordering::Release);

        true
    }

    fn project_status(&self, status: &mut IndexStatus) {
        let request = *self.request();
        if request == IndexRequest::Reconcile {
            status.state = IndexState::Indexing;
            status.message = Some("Reconciliation is scheduled.".into());
        } else if self.stop.load(Ordering::Acquire)
            || request == IndexRequest::Cancel
            || self.cancel.load(Ordering::Acquire)
        {
            status.state = IndexState::Cancelled;
            status.message = Some("Indexing was cancelled. Notes remain available.".into());
        } else if self.overflow.load(Ordering::Acquire) {
            status.state = IndexState::Stale;
            status.message =
                Some("Filesystem changes were missed. Bounded reconciliation is required.".into());
        } else if matches!(status.state, IndexState::Ready)
            && (self.working.load(Ordering::Acquire)
                || self.pending_paths.load(Ordering::Acquire) != 0
                || self.auto_reconcile.load(Ordering::Acquire))
        {
            // The callback never takes an inventory/session lock. Mask the small window between
            // its pending increment and the sequential worker marking the core inventory stale.
            status.state = IndexState::Stale;
            status.message = Some("Filesystem changes are pending.".into());
        }
    }
}

enum Work {
    Path(PathBuf),
    Wake,
}

pub(super) struct Background {
    control: Arc<WorkerControl>,
    sender: SyncSender<Work>,
}

fn enqueue_path(sender: &SyncSender<Work>, control: &WorkerControl, path: PathBuf) {
    control.pending_paths.fetch_add(1, Ordering::AcqRel);
    if let Err(error) = sender.try_send(Work::Path(path)) {
        control.pending_paths.fetch_sub(1, Ordering::AcqRel);
        if matches!(error, mpsc::TrySendError::Full(_)) {
            control.missed_changes();
        }
    }
}

struct Invalidations {
    app: tauri::AppHandle,
    generation: Arc<AtomicU64>,
    expected_generation: u64,
    last: Instant,
}

impl Invalidations {
    fn emit(&mut self, control: &WorkerControl, completion: bool) {
        if !control.stop.load(Ordering::Acquire)
            && self.generation.load(Ordering::Acquire) == self.expected_generation
            && (completion || self.last.elapsed() >= INVALIDATION_INTERVAL)
        {
            let _ = self.app.emit("vault-changed", ());
            self.last = Instant::now();
        }
    }
}

impl Background {
    pub(super) fn start(
        vault: Arc<Vault>,
        app: tauri::AppHandle,
        generation: Arc<AtomicU64>,
        expected_generation: u64,
    ) -> VaultResult<Self> {
        let (sender, receiver) = mpsc::sync_channel(WATCH_QUEUE);
        let control = Arc::new(WorkerControl::new());
        let watches = DirectoryWatches::start(&vault, sender.clone(), control.clone())?;

        let worker_control = control.clone();
        // The worker owns the watcher, not ActiveVault. Dropping its handle detaches; shutdown
        // signals cancellation and the worker drops every OS watch as soon as its batch returns.
        thread::Builder::new()
            .name("adamant-vault-index".into())
            .spawn(move || {
                run_worker(
                    vault,
                    worker_control,
                    receiver,
                    watches,
                    Invalidations {
                        app,
                        generation,
                        expected_generation,
                        last: Instant::now(),
                    },
                );
            })?;
        Ok(Self { control, sender })
    }

    pub(super) fn project_status(&self, status: &mut IndexStatus) {
        self.control.project_status(status);
    }

    pub(super) fn has_pending_changes(&self) -> bool {
        self.control.pending_paths.load(Ordering::Acquire) != 0
            || self.control.overflow.load(Ordering::Acquire)
            || self.control.working.load(Ordering::Acquire)
            || *self.control.request() != IndexRequest::Idle
    }

    pub(super) fn enqueue_path(&self, path: PathBuf) {
        enqueue_path(&self.sender, &self.control, path);
    }

    pub(super) fn reconcile(&self) {
        let mut request = self.control.request();
        self.control.cancel.store(true, Ordering::Release);
        *request = IndexRequest::Reconcile;
        let _ = self.sender.try_send(Work::Wake);
    }

    pub(super) fn activate(&self) {
        self.reconcile();
        self.control.enabled.store(true, Ordering::Release);
    }

    pub(super) fn cancel(&self) {
        let mut request = self.control.request();
        self.control.cancel.store(true, Ordering::Release);
        *request = IndexRequest::Cancel;
        self.control.auto_reconcile.store(false, Ordering::Release);
        let _ = self.sender.try_send(Work::Wake);
    }

    pub(super) fn stop(&self) {
        self.control.stop.store(true, Ordering::Release);
        self.control.cancel.store(true, Ordering::Release);
        let _ = self.sender.try_send(Work::Wake);
    }
}

impl Drop for Background {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run_worker(
    vault: Arc<Vault>,
    control: Arc<WorkerControl>,
    receiver: Receiver<Work>,
    mut watches: DirectoryWatches,
    mut invalidations: Invalidations,
) {
    while !control.enabled.load(Ordering::Acquire) {
        if control.stop.load(Ordering::Acquire) {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let mut complete = false;
    let mut was_cancelled = false;
    let mut first = None;
    while !control.stop.load(Ordering::Acquire) {
        let full = control.take_reconcile();
        let (paths, consumed) = collect_changes(&receiver, &control, &mut first, full);

        if *control.request() == IndexRequest::Cancel {
            complete = false;
            control.pending_paths.fetch_sub(consumed, Ordering::AcqRel);
            control.working.store(false, Ordering::Release);
            vault.set_index_state(
                IndexState::Cancelled,
                Some("Indexing was cancelled. Notes remain available.".into()),
            );
            if !was_cancelled {
                invalidations.emit(&control, true);
                was_cancelled = true;
            }
        } else if full || !paths.is_empty() {
            was_cancelled = false;
            control.working.store(true, Ordering::Release);
            vault.set_index_state(
                if full {
                    IndexState::Indexing
                } else {
                    IndexState::Stale
                },
                None,
            );
            invalidations.emit(&control, false);
            let overflow_epoch = control.overflow_epoch.load(Ordering::Acquire);
            let result = index_changes(
                &vault,
                &control,
                &mut watches,
                &mut invalidations,
                full,
                paths,
            );
            control.pending_paths.fetch_sub(consumed, Ordering::AcqRel);
            match result {
                Ok(finished) => {
                    complete = finished && (full || complete);
                    if full
                        && finished
                        && control.overflow_epoch.load(Ordering::Acquire) == overflow_epoch
                    {
                        control.overflow.store(false, Ordering::Release);
                        // A callback racing this clear must not have its overflow forgotten.
                        if control.overflow_epoch.load(Ordering::Acquire) != overflow_epoch {
                            control.overflow.store(true, Ordering::Release);
                        }
                    }
                }
                Err(error) => {
                    complete = false;
                    vault.set_index_state(IndexState::Partial, Some(error.message));
                }
            }
            publish_index_state(&vault, &control, complete);
            invalidations.emit(&control, true);
        }
        if control.stop.load(Ordering::Acquire) {
            break;
        }
        let request = *control.request();
        if request == IndexRequest::Reconcile
            || (control.auto_reconcile.load(Ordering::Acquire) && request != IndexRequest::Cancel)
            || control.pending_paths.load(Ordering::Acquire) != 0
        {
            continue;
        }
        match receiver.recv_timeout(INVALIDATION_INTERVAL) {
            Ok(work) => first = Some(work),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn collect_changes(
    receiver: &Receiver<Work>,
    control: &WorkerControl,
    first: &mut Option<Work>,
    full: bool,
) -> (HashSet<PathBuf>, usize) {
    let mut paths = HashSet::new();
    let mut consumed = 0;
    let collected_at = Instant::now();

    for _ in 0..CHANGE_BATCH {
        let work = first
            .take()
            .or_else(|| receiver.try_recv().ok())
            .or_else(|| {
                if full || paths.is_empty() || *control.request() != IndexRequest::Idle {
                    return None;
                }

                let remaining = INVALIDATION_INTERVAL.checked_sub(collected_at.elapsed())?;

                receiver.recv_timeout(remaining).ok()
            });

        match work {
            Some(Work::Path(path)) => {
                consumed += 1;
                paths.insert(path);
            }
            Some(Work::Wake) => {}
            None => break,
        }
    }

    (paths, consumed)
}

fn index_changes(
    vault: &Vault,
    control: &WorkerControl,
    watches: &mut DirectoryWatches,
    invalidations: &mut Invalidations,
    full: bool,
    paths: HashSet<PathBuf>,
) -> VaultResult<bool> {
    let paths = if full {
        watches.remove_missing(control);
        Vec::new()
    } else {
        watches.changed_paths(paths, control)
    };
    let mut on_directory = |path: &Path| {
        if control.cancel.load(Ordering::Acquire) || control.stop.load(Ordering::Acquire) {
            return Err(VaultError::invalid("Indexing was cancelled."));
        }

        watches.register(path)?;
        invalidations.emit(control, false);

        Ok(())
    };

    if full {
        vault.reconcile(&control.cancel, &mut on_directory)
    } else if paths.is_empty() {
        Ok(!control.cancel.load(Ordering::Acquire))
    } else {
        vault.apply_changes(&paths, &control.cancel, &mut on_directory)
    }
}

fn publish_index_state(vault: &Vault, control: &WorkerControl, complete: bool) {
    // Manifest checking is IO: do it before taking the command/cancellation gate.
    let incomplete_status = if !complete {
        vault.refresh().ok().map(|snapshot| snapshot.indexing)
    } else {
        None
    };

    control.working.store(false, Ordering::Release);

    let request = control.request();

    if *request == IndexRequest::Cancel || control.cancel.load(Ordering::Acquire) {
        vault.set_index_state(
            IndexState::Cancelled,
            Some("Indexing was cancelled. Notes remain available.".into()),
        );
    } else if control.overflow.load(Ordering::Acquire) {
        vault.set_index_state(
            IndexState::Stale,
            Some("Filesystem changes were missed. Reconcile to retry a bounded scan.".into()),
        );
    } else if control.pending_paths.load(Ordering::Acquire) != 0 {
        vault.set_index_state(
            IndexState::Stale,
            Some("Filesystem changes are pending.".into()),
        );
    } else if complete
        && *request == IndexRequest::Idle
        && !control.auto_reconcile.load(Ordering::Acquire)
    {
        vault.set_index_state(IndexState::Ready, None);
    } else if !complete
        && *request == IndexRequest::Idle
        && let Some(status) = incomplete_status
        && matches!(status.state, IndexState::Indexing | IndexState::Stale)
    {
        // Core supplies the actual budget/error message; only replace its nonterminal state.
        vault.set_index_state(IndexState::Partial, status.message);
    }
}
