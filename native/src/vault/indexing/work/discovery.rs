//! Capability-relative traversal and admission of incremental filesystem changes.
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

use cap_fs_ext::DirExt;
use cap_std::fs::Dir;

use crate::vault::capability::{kind, relative};
use crate::vault::{Vault, VaultEntry, VaultResult};

use super::super::{IndexedEntry, MAX_DIRECTORIES, parent_path};
use super::{Work, covered};

const MAX_DEPTH: usize = 32;

impl Vault {
    pub fn ignored_directory(name: &str) -> bool {
        matches!(
            name,
            ".git"
                | ".hg"
                | ".svn"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | ".next"
                | ".cache"
                | ".generated"
                | ".venv"
                | "venv"
                | "__pycache__"
        )
    }

    pub fn supported_path(path: &Path) -> bool {
        matches!(kind(path), "markdown" | "pdf" | "docx")
    }

    fn index_directory(&self, path: &str) -> VaultResult<Dir> {
        let mut dir = self.dir.try_clone()?;
        if !path.is_empty() {
            for component in relative(path)?.components() {
                dir = dir.open_dir_nofollow(Path::new(component.as_os_str()))?;
            }
        }
        Ok(dir)
    }
}

pub(super) fn companion_original(path: &str) -> Option<&str> {
    path.strip_suffix(".meta.yaml")
        .filter(|original| matches!(kind(Path::new(original)), "pdf" | "docx"))
}

impl<'a> Work<'a> {
    pub(super) fn directory(&mut self, dir: &Dir, path: &str, depth: usize) {
        if !self.checkpoint() {
            return;
        }
        if depth > MAX_DEPTH {
            self.partial(path, "The directory depth limit of 32 was reached.");
            return;
        }
        if self.directories >= MAX_DIRECTORIES {
            self.halted = true;
            self.partial(
                path,
                "The 2,048-directory discovery/watch budget was reached.",
            );
            return;
        }
        self.directories += 1;
        let absolute = self.vault.root.join(path);
        if !absolute
            .canonicalize()
            .is_ok_and(|current| current == absolute)
        {
            self.partial(
                path,
                "A directory moved or became a link before watcher registration.",
            );
            return;
        }
        if let Err(error) = (self.on_directory)(&absolute) {
            self.partial(
                path,
                format!("Directory watcher unavailable: {}", error.message),
            );
            return;
        }
        if !self.checkpoint() {
            return;
        }
        let mut entries = match dir.entries() {
            Ok(entries) => entries,
            Err(error) => {
                self.partial(path, error.to_string());
                return;
            }
        };
        loop {
            if !self.checkpoint() {
                break;
            }
            // Probe exhaustion before charging an entry, so exactly 50,000 entries can complete.
            let Some(entry) = entries.next() else { break };
            if !self.examine() {
                break;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    self.partial(path, error.to_string());
                    continue;
                }
            };
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                self.partial(path, "A filename is not valid Unicode and cannot be shown.");
                continue;
            };
            if Vault::ignored_directory(name) {
                continue;
            }
            let child = if path.is_empty() {
                name.to_owned()
            } else {
                format!("{path}/{name}")
            };
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    self.partial(&child, error.to_string());
                    continue;
                }
            };
            if file_type.is_dir() {
                self.put_directory(&child);
                if self.halted {
                    break;
                }
                match dir.open_dir_nofollow(name) {
                    Ok(dir) => self.directory(&dir, &child, depth + 1),
                    Err(error) => self.partial(&child, error.to_string()),
                }
            } else if file_type.is_file() {
                self.file(dir, Path::new(name), &child);
            } else {
                self.issues.push(
                    &child,
                    "Filesystem links and non-regular files are not followed.",
                );
            }
        }
    }

    fn put_directory(&mut self, path: &str) {
        self.put(IndexedEntry {
            entry: VaultEntry {
                path: path.into(),
                kind: "directory",
                id: None,
                metadata_error: None,
            },
            metadata: None,
            references: Vec::new(),
            epoch: self.epoch,
        });
    }

    pub(super) fn changed_scopes(&mut self, paths: &[PathBuf]) -> Vec<String> {
        if paths.len() > 1024 {
            self.partial(
                "",
                "The incremental path budget was exceeded. Reconcile the Vault.",
            );
        }

        let mut scopes = BTreeSet::new();

        for path in paths.iter().take(1024) {
            if !self.checkpoint() {
                break;
            }

            self.admit_change(path, &mut scopes);
        }

        // One parent event subsumes its descendants; no duplicate subtree walks in a batch.
        let mut admitted = Vec::new();

        for path in scopes {
            if !covered(&path, &admitted) {
                admitted.push(path);
            }
        }

        admitted
    }

    fn admit_change(&mut self, path: &Path, scopes: &mut BTreeSet<String>) {
        let path = if path.is_absolute() {
            match path.strip_prefix(&self.vault.root) {
                Ok(path) => path,
                // Container events only invalidate authority; never traverse its siblings.
                Err(_)
                    if path == self.vault.vault_root
                        || path
                            .strip_prefix(&self.vault.vault_root)
                            .is_ok_and(|path| path == Path::new("vault.json")) =>
                {
                    return;
                }
                Err(_) => {
                    self.partial("", "A watcher path was outside the Vault and was ignored.");
                    return;
                }
            }
        } else {
            path
        };
        let Some(path) = path.to_str() else {
            self.partial("", "A changed filename is not valid Unicode.");
            return;
        };
        #[cfg(windows)]
        let normalized = path.replace('\\', "/");
        #[cfg(windows)]
        let path = normalized.as_str();

        if path.is_empty() {
            scopes.insert(String::new());
            return;
        }

        if relative(path).is_err() {
            self.partial("", "An unsafe watcher path was ignored.");
            return;
        }

        if path.split('/').any(Vault::ignored_directory) {
            return;
        }

        let path = companion_original(path).unwrap_or(path);

        if path == "vault.json" && self.vault.content_root_relative == "." {
            return;
        }

        scopes.insert(path.to_owned());
    }

    pub(super) fn changed_path(&mut self, path: &str) {
        if path.is_empty() {
            match self.vault.dir.try_clone() {
                Ok(dir) => self.directory(&dir, "", 0),
                Err(error) => self.partial(path, error.to_string()),
            }

            return;
        }

        let parent = match self.vault.index_directory(parent_path(path)) {
            Ok(dir) => dir,
            Err(error) => {
                if self
                    .vault
                    .dir
                    .symlink_metadata(path)
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                {
                    self.delete_subtree(path);
                } else {
                    self.partial(path, error.message);
                }

                return;
            }
        };
        let name = Path::new(path)
            .file_name()
            .expect("Validated relative path");

        match parent.symlink_metadata(name) {
            Ok(metadata) if metadata.is_dir() => {
                self.put_directory(path);

                match parent.open_dir_nofollow(name) {
                    Ok(dir) => self.directory(&dir, path, path.split('/').count()),
                    Err(error) => self.partial(path, error.to_string()),
                }
            }
            Ok(metadata) if metadata.is_file() => {
                self.delete_subtree(path);
                self.file(&parent, Path::new(name), path);
            }
            Ok(_) => {
                self.delete_subtree(path);
                self.issues.push(
                    path,
                    "Filesystem links and non-regular files are not followed.",
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.delete_subtree(path);

                if matches!(kind(Path::new(path)), "pdf" | "docx") {
                    let companion = format!("{path}.meta.yaml");
                    let name = Path::new(&companion)
                        .file_name()
                        .expect("Companion filename");

                    if parent
                        .symlink_metadata(name)
                        .is_ok_and(|metadata| metadata.is_file())
                    {
                        self.issues.push(&companion, "Companion metadata has no original document; reassociation is required.");
                    }
                }
            }
            Err(error) => self.partial(path, error.to_string()),
        }
    }
}
