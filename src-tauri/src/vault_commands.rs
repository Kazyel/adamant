use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};

use notify::{
    EventKind, RecommendedWatcher, RecursiveMode, Watcher,
    event::{CreateKind, ModifyKind, RemoveKind},
};
use tauri::{Emitter, Manager, State};

use crate::{
    AppState, Document,
    vault::{
        IndexState, IndexStatus, NoteDocument, Vault, VaultError, VaultPage, VaultResult,
        VaultParent, VaultSnapshot,
    },
};

const WATCH_QUEUE: usize = 256;
const CHANGE_BATCH: usize = 1024;
const WATCH_DIRECTORIES: usize = 2048;
const INVALIDATION_INTERVAL: Duration = Duration::from_millis(150);

#[derive(Default, Clone)]
pub(crate) struct VaultState {
    session: Arc<Mutex<Session>>,
    // Updated only under the session lock; dialogs/runtime tasks can capture it without blocking.
    generation: Arc<AtomicU64>,
}

#[derive(Default)]
struct Session {
    active: Option<Arc<ActiveVault>>,
    parent: Option<Arc<VaultParent>>,
}

struct ActiveVault {
    vault: Arc<Vault>,
    background: Background,
}

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

struct Background {
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

fn admitted_path(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut depth = 0;
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return false;
        };
        depth += 1;
        if depth > 33 || name.to_str().is_some_and(Vault::ignored_directory) {
            return false;
        }
    }
    true
}

fn companion_original(path: &Path) -> Option<&str> {
    let name = path.file_name()?.to_str()?.strip_suffix(".meta.yaml")?;
    Path::new(name).extension()?.to_str().filter(|extension| {
        extension.eq_ignore_ascii_case("pdf") || extension.eq_ignore_ascii_case("docx")
    })?;
    Some(name)
}

fn receive_event(
    root: &Path,
    sender: &SyncSender<Work>,
    control: &WorkerControl,
    event: notify::Result<notify::Event>,
) {
    if control.stop.load(Ordering::Acquire) {
        return;
    }
    let event = match event {
        Ok(event) => event,
        Err(_) => {
            control.missed_changes();
            let _ = sender.try_send(Work::Wake);
            return;
        }
    };
    // Opening files/directories during indexing must not feed an invalidation loop.
    if matches!(event.kind, EventKind::Access(_)) {
        return;
    }
    if event.need_rescan() || event.paths.is_empty() {
        control.missed_changes();
        let _ = sender.try_send(Work::Wake);
    }
    let directory_candidate = matches!(
        event.kind,
        EventKind::Any
            | EventKind::Other
            | EventKind::Create(CreateKind::Any | CreateKind::Folder)
            | EventKind::Remove(RemoveKind::Any | RemoveKind::Folder)
            | EventKind::Modify(ModifyKind::Any | ModifyKind::Name(_) | ModifyKind::Metadata(_))
    );
    // Even a backend-provided event containing many paths cannot create unbounded callback work.
    if event.paths.len() > CHANGE_BATCH {
        control.missed_changes();
    }
    for path in event.paths.into_iter().take(CHANGE_BATCH) {
        if !admitted_path(root, &path) {
            continue;
        }
        if path
            .strip_prefix(root)
            .is_ok_and(|path| path == Path::new("vault.json"))
            || Vault::supported_path(&path)
            || companion_original(&path).is_some()
            || directory_candidate
        {
            enqueue_path(sender, control, path);
        }
    }
}

struct DirectoryWatches {
    watcher: RecommendedWatcher,
    paths: HashSet<PathBuf>,
    root: PathBuf,
}

impl DirectoryWatches {
    fn register(&mut self, path: &Path) -> VaultResult<()> {
        if !admitted_path(&self.root, path)
            || path
                .strip_prefix(&self.root)
                .map_or(true, |path| path.components().count() > 32)
        {
            return Err(VaultError::invalid(
                "The directory is outside the Vault indexing policy.",
            ));
        }
        if self.paths.len() >= WATCH_DIRECTORIES && !self.paths.contains(path) {
            return Err(VaultError::invalid(
                "The Vault reached its 2048 watched-directory limit.",
            ));
        }
        // notify takes ambient paths; never register a symlink substituted for an admitted dir.
        if path.canonicalize()? != path || !std::fs::symlink_metadata(path)?.is_dir() {
            return Err(VaultError::invalid(
                "A watched directory changed or became a link.",
            ));
        }
        // Re-arm an existing path as well: a directory may have been replaced at the same
        // pathname while its old OS watch was automatically removed.
        if self.paths.remove(path) {
            let _ = self.watcher.unwatch(path);
        }
        self.watcher
            .watch(path, RecursiveMode::NonRecursive)
            .map_err(|error| {
                VaultError::io(format!("Could not watch this Vault directory: {error}"))
            })?;
        if !path.canonicalize().is_ok_and(|canonical| canonical == path) {
            let _ = self.watcher.unwatch(path);
            return Err(VaultError::invalid(
                "A watched directory changed while being registered.",
            ));
        }
        self.paths.insert(path.to_owned());
        Ok(())
    }

    fn changed_paths(&mut self, paths: HashSet<PathBuf>, control: &WorkerControl) -> Vec<PathBuf> {
        let mut changes = Vec::with_capacity(paths.len());
        let mut directories_changed = false;
        for path in paths {
            if control.cancel.load(Ordering::Acquire) || control.stop.load(Ordering::Acquire) {
                break;
            }
            if let Some(original) = companion_original(&path) {
                let original = path.with_file_name(original);
                if std::fs::symlink_metadata(&original).is_ok_and(|metadata| metadata.is_file()) {
                    changes.push(original);
                }
            } else if self.paths.contains(&path)
                || (!Vault::supported_path(&path)
                    && std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_dir()))
            {
                directories_changed = true;
                changes.push(path);
            } else if path
                .strip_prefix(&self.root)
                .is_ok_and(|path| path == Path::new("vault.json"))
                || Vault::supported_path(&path)
            {
                changes.push(path);
            }
        }
        // A renamed/deleted directory's descendants must release their watch slots too.
        if directories_changed {
            self.remove_missing(control);
        }
        changes
    }

    fn remove_missing(&mut self, control: &WorkerControl) {
        let started = Instant::now();
        let mut removed = Vec::new();
        for path in &self.paths {
            if control.cancel.load(Ordering::Acquire)
                || control.stop.load(Ordering::Acquire)
                || started.elapsed() >= Duration::from_secs(5)
            {
                break;
            }
            if !std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
                removed.push(path.clone());
            }
        }
        for path in removed {
            let _ = self.watcher.unwatch(&path);
            self.paths.remove(&path);
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
    fn start(
        vault: Arc<Vault>,
        app: tauri::AppHandle,
        generation: Arc<AtomicU64>,
        expected_generation: u64,
    ) -> VaultResult<Self> {
        let (sender, receiver) = mpsc::sync_channel(WATCH_QUEUE);
        let control = Arc::new(WorkerControl::new());
        let events = sender.clone();
        let event_control = control.clone();
        let root = vault.root().to_owned();
        let watcher = notify::recommended_watcher(move |event| {
            receive_event(&root, &events, &event_control, event);
        })
        .map_err(|error| VaultError::io(format!("Could not watch this Vault: {error}")))?;
        let mut watches = DirectoryWatches {
            watcher,
            paths: HashSet::new(),
            root: vault.root().to_owned(),
        };
        watches.register(vault.root())?;
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

    fn reconcile(&self) {
        let mut request = self.control.request();
        self.control.cancel.store(true, Ordering::Release);
        *request = IndexRequest::Reconcile;
        let _ = self.sender.try_send(Work::Wake);
    }

    fn activate(&self) {
        self.reconcile();
        self.control.enabled.store(true, Ordering::Release);
    }

    fn cancel(&self) {
        let mut request = self.control.request();
        self.control.cancel.store(true, Ordering::Release);
        *request = IndexRequest::Cancel;
        self.control.auto_reconcile.store(false, Ordering::Release);
        let _ = self.sender.try_send(Work::Wake);
    }

    fn stop(&self) {
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
        let full = {
            let mut request = control.request();
            if *request == IndexRequest::Cancel {
                false
            } else if *request == IndexRequest::Reconcile
                || control.auto_reconcile.swap(false, Ordering::AcqRel)
            {
                *request = IndexRequest::Idle;
                control.auto_reconcile.store(false, Ordering::Release);
                control.cancel.store(false, Ordering::Release);
                control.working.store(true, Ordering::Release);
                true
            } else {
                false
            }
        };
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
            let result = if full {
                watches.remove_missing(&control);
                vault.reconcile(&control.cancel, &mut |path| {
                    if control.cancel.load(Ordering::Acquire)
                        || control.stop.load(Ordering::Acquire)
                    {
                        return Err(VaultError::invalid("Indexing was cancelled."));
                    }
                    watches.register(path)?;
                    invalidations.emit(&control, false);
                    Ok(())
                })
            } else {
                let paths = watches.changed_paths(paths, &control);
                if paths.is_empty() {
                    Ok(!control.cancel.load(Ordering::Acquire))
                } else {
                    vault.apply_changes(&paths, &control.cancel, &mut |path| {
                        if control.cancel.load(Ordering::Acquire)
                            || control.stop.load(Ordering::Acquire)
                        {
                            return Err(VaultError::invalid("Indexing was cancelled."));
                        }
                        watches.register(path)?;
                        invalidations.emit(&control, false);
                        Ok(())
                    })
                }
            };
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
                    Some(
                        "Filesystem changes were missed. Reconcile to retry a bounded scan.".into(),
                    ),
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
            } else if !complete && *request == IndexRequest::Idle {
                // Core supplies the actual budget/error message; only replace its nonterminal state.
                if let Some(status) = incomplete_status {
                    if matches!(status.state, IndexState::Indexing | IndexState::Stale) {
                        vault.set_index_state(IndexState::Partial, status.message);
                    }
                }
            }
            drop(request);
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

impl ActiveVault {
    fn snapshot(&self) -> VaultResult<VaultSnapshot> {
        let mut snapshot = self.vault.refresh()?;
        self.background
            .control
            .project_status(&mut snapshot.indexing);
        Ok(snapshot)
    }

    fn mutate(
        &self,
        operation: impl FnOnce(&Vault) -> VaultResult<NoteDocument>,
    ) -> VaultResult<NoteDocument> {
        let control = &self.background.control;
        if control.pending_paths.load(Ordering::Acquire) != 0
            || control.overflow.load(Ordering::Acquire)
            || control.working.load(Ordering::Acquire)
            || *control.request() != IndexRequest::Idle
        {
            // Identity-sensitive mutations must not certify against an old Ready state while
            // the callback's pending paths or a requested reconciliation wait for the worker.
            self.vault.set_index_state(
                IndexState::Stale,
                Some("Filesystem changes are pending.".into()),
            );
        }
        let note = operation(&self.vault)?;
        // Local writes mark core state stale. Do not depend on an OS notification arriving
        // (or that directory already being watched) to reconcile the successful write.
        enqueue_path(
            &self.background.sender,
            control,
            self.vault.root().join(&note.path),
        );
        Ok(note)
    }
}

impl VaultState {
    fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    fn active(&self, generation: u64) -> VaultResult<Arc<ActiveVault>> {
        let session = self
            .session
            .lock()
            .map_err(|_| VaultError::io("Vault session is unavailable. Restart Adamant."))?;
        self.ensure_generation(generation)?;
        session
            .active
            .clone()
            .ok_or_else(|| VaultError::invalid("Open a Vault first."))
    }

    fn ensure_generation(&self, generation: u64) -> VaultResult<()> {
        if self.generation() != generation {
            return Err(VaultError::invalid(
                "The Vault changed before this operation completed.",
            ));
        }
        Ok(())
    }
}

async fn with_vault<T: Send + 'static>(
    state: &VaultState,
    generation: u64,
    operation: impl FnOnce(&ActiveVault) -> VaultResult<T> + Send + 'static,
) -> VaultResult<T> {
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let active = state.active(generation)?;
        // The session lock protects the authority handoff, never filesystem/SQLite work.
        let result = operation(&active)?;
        state.ensure_generation(generation)?;
        Ok(result)
    })
    .await
    .map_err(|_| VaultError::io("The Vault operation stopped unexpectedly."))?
}

#[tauri::command]
pub(crate) async fn vault_select_parent(
    state: State<'_, VaultState>,
) -> VaultResult<Option<String>> {
    let generation = state.generation();
    let Some(folder) = rfd::AsyncFileDialog::new()
        .set_title("Choose a parent folder for the new Vault")
        .pick_folder()
        .await
    else {
        return Ok(None);
    };
    let root = folder.path().to_owned();
    let parent = tauri::async_runtime::spawn_blocking(move || VaultParent::select(&root))
        .await
        .map_err(|_| VaultError::io("Reading the parent folder stopped unexpectedly."))??;
    let path = parent.root().to_string_lossy().into_owned();
    let mut session = state.session.lock().map_err(|_| VaultError::io("Vault session is unavailable."))?;
    state.ensure_generation(generation)?;
    session.parent = Some(Arc::new(parent));
    Ok(Some(path))
}

#[tauri::command]
pub(crate) async fn vault_open(
    state: State<'_, VaultState>,
    app_state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> VaultResult<Option<VaultSnapshot>> {
    let generation = state.generation();
    let Some(folder) = rfd::AsyncFileDialog::new()
        .set_title("Open an Adamant Vault")
        .pick_folder()
        .await
    else {
        return Ok(None);
    };
    let root = folder.path().to_owned();
    activate_vault(state, app_state, app, generation, move |data| Vault::open(&root, data)).await.map(Some)
}

#[tauri::command]
pub(crate) async fn vault_create(
    name: String,
    state: State<'_, VaultState>,
    app_state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> VaultResult<VaultSnapshot> {
    let generation = state.generation();
    let parent = state.session.lock().map_err(|_| VaultError::io("Vault session is unavailable."))?
        .parent.clone().ok_or_else(|| VaultError::invalid("Choose a parent folder first."))?;
    activate_vault(state, app_state, app, generation, move |data| parent.create(&name, data)).await
}

async fn activate_vault(
    state: State<'_, VaultState>,
    app_state: State<'_, AppState>,
    app: tauri::AppHandle,
    generation: u64,
    open: impl FnOnce(&Path) -> VaultResult<Vault> + Send + 'static,
) -> VaultResult<VaultSnapshot> {
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|error| VaultError::io(error.to_string()))?;
    let state = state.inner().clone();
    let selected_paths = app_state.selected_paths.clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        state.ensure_generation(generation)?;
        // Validation, root watching and the immediate snapshot all happen before session handoff.
        // An invalid selection leaves the prior Vault and its document authorizations untouched.
        let vault = Arc::new(open(&data)?);
        let next_generation = generation.wrapping_add(1);
        let background = Background::start(
            vault.clone(),
            app,
            state.generation.clone(),
            next_generation,
        )?;
        let active = Arc::new(ActiveVault { vault, background });
        let snapshot = active.snapshot()?;
        let old = {
            let mut session = state
                .session
                .lock()
                .map_err(|_| VaultError::io("Vault session is unavailable."))?;
            state.ensure_generation(generation)?;
            selected_paths
                .lock()
                .map_err(|_| VaultError::io("Document access is unavailable."))?
                .clear();
            let old = session.active.replace(active.clone());
            session.parent = None;
            state.generation.store(next_generation, Ordering::Release);
            if let Some(old) = &old {
                old.background.stop();
            }
            active.background.activate();
            old
        };
        drop(old);
        Ok::<_, VaultError>(snapshot)
    })
    .await
    .map_err(|_| VaultError::io("Opening the Vault stopped unexpectedly."))??;
    Ok(snapshot)
}

#[tauri::command]
pub(crate) async fn vault_refresh(state: State<'_, VaultState>) -> VaultResult<VaultSnapshot> {
    with_vault(&state, state.generation(), ActiveVault::snapshot).await
}

#[tauri::command]
pub(crate) async fn vault_list_entries(
    directory: String,
    offset: usize,
    limit: usize,
    state: State<'_, VaultState>,
) -> VaultResult<VaultPage> {
    with_vault(&state, state.generation(), move |active| {
        let mut page = active.vault.list_entries(&directory, offset, limit)?;
        active.background.control.project_status(&mut page.indexing);
        Ok(page)
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_reconcile(state: State<'_, VaultState>) -> VaultResult<VaultSnapshot> {
    with_vault(&state, state.generation(), |active| {
        active.background.reconcile();
        active.snapshot()
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_cancel_index(state: State<'_, VaultState>) -> VaultResult<VaultSnapshot> {
    with_vault(&state, state.generation(), |active| {
        active.background.cancel();
        active.snapshot()
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_close(
    state: State<'_, VaultState>,
    app_state: State<'_, AppState>,
) -> VaultResult<()> {
    let state = state.inner().clone();
    let generation = state.generation();
    let selected_paths = app_state.selected_paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let old = {
            let mut session = state
                .session
                .lock()
                .map_err(|_| VaultError::io("Vault session is unavailable."))?;
            state.ensure_generation(generation)?;
            selected_paths
                .lock()
                .map_err(|_| VaultError::io("Document access is unavailable."))?
                .clear();
            let old = session.active.take();
            session.parent = None;
            state
                .generation
                .store(generation.wrapping_add(1), Ordering::Release);
            if let Some(old) = &old {
                old.background.stop();
            }
            old
        };
        // No join and no watcher teardown on the native/UI path, even if a note command has
        // retained the old ActiveVault. Its worker has already received the stop/cancel signal.
        drop(old);
        Ok::<_, VaultError>(())
    })
    .await
    .map_err(|_| VaultError::io("Closing the Vault stopped unexpectedly."))?
}

#[tauri::command]
pub(crate) async fn vault_read_note(
    path: String,
    state: State<'_, VaultState>,
) -> VaultResult<NoteDocument> {
    with_vault(&state, state.generation(), move |active| {
        active.vault.read_note(&path)
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_create_note(
    path: String,
    text: String,
    state: State<'_, VaultState>,
) -> VaultResult<NoteDocument> {
    with_vault(&state, state.generation(), move |active| {
        active.mutate(|vault| vault.create_note(&path, &text))
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_save_note(
    path: String,
    text: String,
    expected_revision: String,
    state: State<'_, VaultState>,
) -> VaultResult<NoteDocument> {
    with_vault(&state, state.generation(), move |active| {
        active.mutate(|vault| vault.save_note(&path, &text, &expected_revision))
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_save_copy(
    path: String,
    text: String,
    state: State<'_, VaultState>,
) -> VaultResult<NoteDocument> {
    with_vault(&state, state.generation(), move |active| {
        active.mutate(|vault| vault.save_copy(&path, &text))
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_adopt_note(
    path: String,
    expected_revision: String,
    state: State<'_, VaultState>,
) -> VaultResult<NoteDocument> {
    with_vault(&state, state.generation(), move |active| {
        active.mutate(|vault| vault.adopt_note(&path, &expected_revision))
    })
    .await
}

#[tauri::command]
pub(crate) async fn vault_import_note(
    path: String,
    state: State<'_, VaultState>,
) -> VaultResult<Option<NoteDocument>> {
    let generation = state.generation();
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("Import a Markdown Note")
        .add_filter("Markdown", &["md"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let source: PathBuf = file.path().to_owned();
    with_vault(&state, generation, move |active| {
        active.mutate(|vault| vault.import_note(&path, &source))
    })
    .await
    .map(Some)
}

#[tauri::command]
pub(crate) async fn vault_open_document(
    path: String,
    state: State<'_, VaultState>,
    app_state: State<'_, AppState>,
) -> VaultResult<Document> {
    let generation = state.generation();
    let authority = state.inner().clone();
    let selected_paths = app_state.selected_paths.clone();
    with_vault(&state, generation, move |active| {
        let (absolute, kind, bytes) = active.vault.read_document(&path)?;
        let name = absolute
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| VaultError::invalid("The document filename must be Unicode."))?
            .to_owned();
        // Keep the generation check and grant atomic with respect to choose/close clearing grants.
        let _session = authority
            .session
            .lock()
            .map_err(|_| VaultError::io("Vault session is unavailable."))?;
        authority.ensure_generation(generation)?;
        selected_paths
            .lock()
            .map_err(|_| VaultError::io("Document access is unavailable."))?
            .insert(absolute.clone());
        Ok(Document {
            path: absolute.to_string_lossy().into_owned(),
            name,
            kind,
            bytes,
        })
    })
    .await
}
