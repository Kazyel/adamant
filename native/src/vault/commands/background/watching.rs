use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
    sync::{Arc, atomic::Ordering, mpsc::SyncSender},
    time::{Duration, Instant},
};

use notify::{
    EventKind, RecommendedWatcher, RecursiveMode, Watcher,
    event::{CreateKind, ModifyKind, RemoveKind},
};

use super::{CHANGE_BATCH, Work, WorkerControl, enqueue_path};
use crate::vault::{Vault, VaultError, VaultResult};

const WATCH_DIRECTORIES: usize = 2048;

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
    vault_root: &Path,
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
        // The container is watched nonrecursively for authority changes, not content discovery.
        if path == vault_root
            || path
                .strip_prefix(vault_root)
                .is_ok_and(|path| path == Path::new("vault.json"))
        {
            enqueue_path(sender, control, path);
            continue;
        }
        if !admitted_path(root, &path) {
            continue;
        }
        if Vault::supported_path(&path)
            || companion_original(&path).is_some()
            || directory_candidate
        {
            enqueue_path(sender, control, path);
        }
    }
}

pub(super) struct DirectoryWatches {
    watcher: RecommendedWatcher,
    paths: HashSet<PathBuf>,
    root: PathBuf,
    vault_root: PathBuf,
}

impl DirectoryWatches {
    pub(super) fn start(
        vault: &Vault,
        events: SyncSender<Work>,
        event_control: Arc<WorkerControl>,
    ) -> VaultResult<Self> {
        let root = vault.root().to_owned();
        let vault_root = vault.vault_root().to_owned();
        let watcher = notify::recommended_watcher(move |event| {
            receive_event(&root, &vault_root, &events, &event_control, event);
        })
        .map_err(|error| VaultError::io(format!("Could not watch this Vault: {error}")))?;
        let mut watches = DirectoryWatches {
            watcher,
            paths: HashSet::new(),
            root: vault.root().to_owned(),
            vault_root: vault.vault_root().to_owned(),
        };
        if vault.vault_root() != vault.root() {
            watches.register(vault.vault_root())?;
        }
        watches.register(vault.root())?;

        Ok(watches)
    }

    pub(super) fn register(&mut self, path: &Path) -> VaultResult<()> {
        if path != self.vault_root
            && (!admitted_path(&self.root, path)
                || path
                    .strip_prefix(&self.root)
                    .map_or(true, |path| path.components().count() > 32))
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

    pub(super) fn changed_paths(
        &mut self,
        paths: HashSet<PathBuf>,
        control: &WorkerControl,
    ) -> Vec<PathBuf> {
        let mut changes = Vec::with_capacity(paths.len());
        let mut directories_changed = false;
        for path in paths {
            if control.cancel.load(Ordering::Acquire) || control.stop.load(Ordering::Acquire) {
                break;
            }
            if path == self.root || path == self.vault_root {
                directories_changed = true;
                changes.push(path);
            } else if let Some(original) = companion_original(&path) {
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
                .strip_prefix(&self.vault_root)
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

    pub(super) fn remove_missing(&mut self, control: &WorkerControl) {
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
