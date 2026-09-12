use std::{
    fs,
    path::{Path, PathBuf},
};

use cap_std::{ambient_authority, fs::Dir};
use uuid::Uuid;

use super::capability::{note_path, private_dir, read_regular, sync_dir, write_new};
use super::notes::document;
use super::{IndexState, MAX_BYTES, NoteDocument, Vault, VaultError, VaultResult, hash};

impl Vault {
    pub fn save_copy(&self, path: &str, text: &str) -> VaultResult<NoteDocument> {
        self.create_raw(path, text)
    }

    pub(super) fn create_raw(&self, path: &str, text: &str) -> VaultResult<NoteDocument> {
        note_path(path)?;
        if text.len() as u64 > MAX_BYTES {
            return Err(VaultError::invalid("The Note exceeds 64 MiB."));
        }
        let (dir, name) = self.parent(path, true)?;
        let staging = format!(".adamant-write-{}.md", Uuid::new_v4());
        write_new(&dir, Path::new(&staging), text.as_bytes())?;
        let result = dir.hard_link(&staging, &dir, &name);
        let _ = dir.remove_file(&staging);
        result.map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                VaultError::conflict(
                    "The destination already exists. Choose another path.",
                    self.read_note(path).ok(),
                )
            } else {
                error.into()
            }
        })?;
        sync_dir(&dir)?;
        self.set_index_state(
            IndexState::Stale,
            Some("A local write is awaiting indexing.".into()),
        );
        Ok(document(path, text.to_owned()))
    }

    fn retain(&self, path: &str, text: &[u8], label: &str) -> VaultResult<PathBuf> {
        let recovery = self.recovery_directory();
        private_dir(&recovery)?;
        let dir = Dir::open_ambient_dir(&recovery, ambient_authority())?;
        let name = format!("{}-{}-{label}.md", hash(path.as_bytes()), Uuid::new_v4());
        write_new(&dir, Path::new(&name), text)?;
        sync_dir(&dir)?;
        Ok(recovery.join(name))
    }

    pub(super) fn stale(
        &self,
        path: &str,
        text: &str,
        current: Option<NoteDocument>,
    ) -> VaultResult<NoteDocument> {
        let retained = self.retain(path, text.as_bytes(), "submitted")?;
        Err(VaultError::conflict(
            format!(
                "The on-disk Note changed or was deleted. Your submitted version is retained at {}. Reload disk or save a recovery copy; no force overwrite is available.",
                retained.display()
            ),
            current,
        ))
    }

    pub fn save_note(
        &self,
        path: &str,
        text: &str,
        expected_revision: &str,
    ) -> VaultResult<NoteDocument> {
        let _identity = self
            .identity_writes
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.save_note_inner(path, text, expected_revision, || {})
    }

    pub(super) fn save_note_inner(
        &self,
        path: &str,
        text: &str,
        expected_revision: &str,
        before_exchange: impl FnOnce(),
    ) -> VaultResult<NoteDocument> {
        self.save_note_checked(path, text, expected_revision, before_exchange, false)
    }

    pub(super) fn save_note_checked(
        &self,
        path: &str,
        text: &str,
        expected_revision: &str,
        before_exchange: impl FnOnce(),
        generated_identity: bool,
    ) -> VaultResult<NoteDocument> {
        note_path(path)?;
        if text.len() as u64 > MAX_BYTES {
            return Err(VaultError::invalid("The Note exceeds 64 MiB."));
        }
        self.ensure_current_manifest()?;
        let current = match self.read_note(path) {
            Ok(current) => current,
            Err(error) => {
                // Only genuine absence is a deleted-note conflict; unsafe/unreadable files remain errors.
                let absent = error.kind == "conflict" && error.current.is_none();
                if absent {
                    return self.stale(path, text, None);
                }
                return Err(error);
            }
        };
        if current.revision != expected_revision {
            return self.stale(path, text, Some(current));
        }
        let next = document(path, text.to_owned());
        if current.id.is_some() && next.id.is_some() && current.id != next.id {
            return Err(VaultError::invalid(
                "Ordinary Save cannot replace an existing identity. Use a new Note or preserve this ID; source was not changed.",
            ));
        }
        if !generated_identity && current.id.is_none() && next.id.is_some() {
            self.ensure_identity_available(path, text)?;
        }
        if current.text == text {
            return Ok(current);
        }
        let (dir, name) = self.parent(path, false)?;
        let old_permissions = dir.symlink_metadata(&name)?.permissions();
        let staging = format!(".adamant-write-{}.md", Uuid::new_v4());
        let file = write_new(&dir, Path::new(&staging), text.as_bytes())?;
        file.set_permissions(old_permissions)?;
        file.sync_all()?;
        // Retain submitted bytes before the replacement, including crash/error paths.
        let retained = self.retain(path, text.as_bytes(), "submitted")?;
        before_exchange();
        if let Err(mut error) = self.ensure_current_manifest() {
            let _ = dir.remove_file(&staging);
            error.message.push_str(&format!(
                " Submitted version retained at {}.",
                retained.display()
            ));
            return Err(error);
        }
        if let Err(error) = exchange(&dir, &staging, &name) {
            let _ = dir.remove_file(&staging);
            if error.kind() == std::io::ErrorKind::NotFound {
                return self.stale(path, text, None);
            }
            return Err(VaultError::io(format!(
                "Safe replacement failed: {error}. Submitted version: {}",
                retained.display()
            )));
        }
        sync_dir(&dir)?;
        // The exchange captures the actual displaced file, not a racy pre-rename snapshot.
        // This observes the replacement boundary, not writes continuing indefinitely to detached handles.
        let displaced = read_regular(&dir, Path::new(&staging));
        let matches = displaced
            .as_ref()
            .is_ok_and(|bytes| hash(bytes) == expected_revision);
        let now = self.read_note(path).ok();
        if matches
            && now
                .as_ref()
                .is_some_and(|document| document.revision == next.revision)
        {
            dir.remove_file(&staging)?;
            sync_dir(&dir)?;
            fs::remove_file(&retained)?;
            self.set_index_state(
                IndexState::Stale,
                Some("A local write is awaiting indexing.".into()),
            );
            return Ok(next);
        }
        let backup = displaced.and_then(|bytes| self.retain(path, &bytes, "displaced"));
        let recovery_path = match backup {
            Ok(backup) => {
                dir.remove_file(&staging)?;
                backup
            }
            Err(_) => {
                // If machine-local recovery storage fails, retain authored source beside the Note.
                let displaced_name = format!(".adamant-recovery-{}.md", Uuid::new_v4());
                dir.rename(&staging, &dir, &displaced_name)?;
                self.root
                    .join(Path::new(path).parent().unwrap_or(Path::new("")))
                    .join(displaced_name)
            }
        };
        sync_dir(&dir)?;
        Err(VaultError::conflict(
            format!(
                "An external writer raced the save. Both versions are retained: submitted at {}; displaced at {}. Reload to inspect the current disk version.",
                retained.display(),
                recovery_path.display()
            ),
            now,
        ))
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(super) fn exchange(dir: &Dir, staging: &str, destination: &Path) -> std::io::Result<()> {
    rustix::fs::renameat_with(
        dir,
        staging,
        dir,
        destination,
        rustix::fs::RenameFlags::EXCHANGE,
    )
    .map_err(Into::into)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(super) fn exchange(_dir: &Dir, _staging: &str, _destination: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "This platform has no supported atomic exchange primitive. Save a recovery copy instead; the original was not overwritten.",
    ))
}
