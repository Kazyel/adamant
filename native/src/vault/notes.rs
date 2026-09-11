use std::path::{Path, PathBuf};

use cap_fs_ext::DirExt;

use super::capability::{kind, note_path, read_regular, read_text, relative};
use super::metadata::{adopt, note_metadata};
use super::{NoteDocument, Vault, VaultError, VaultResult, hash};

pub(super) fn document(path: &str, text: String) -> NoteDocument {
    let metadata = note_metadata(&text);
    NoteDocument {
        path: path.into(),
        revision: hash(text.as_bytes()),
        text,
        id: metadata.id,
        metadata_error: metadata.error,
    }
}

impl Vault {
    fn note_is_absent(&self, path: &str) -> bool {
        let Ok(mut dir) = self.dir.try_clone() else {
            return false;
        };
        let mut components = Path::new(path).components().peekable();
        while let Some(component) = components.next() {
            let name = Path::new(component.as_os_str());
            if components.peek().is_none() {
                return dir
                    .symlink_metadata(name)
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound);
            }
            match dir.open_dir_nofollow(name) {
                Ok(child) => dir = child,
                Err(error) => return error.kind() == std::io::ErrorKind::NotFound,
            }
        }
        false
    }

    pub fn read_note(&self, path: &str) -> VaultResult<NoteDocument> {
        note_path(path)?;
        let result = self
            .parent(path, false)
            .and_then(|(dir, name)| read_text(&dir, &name));
        match result {
            Ok(text) => Ok(document(path, text)),
            Err(error) => {
                // A missing path is a deletion conflict only while the original root and
                // manifest still authorize this Vault; links and unreadable files are not deletions.
                self.ensure_current_manifest()?;
                if self.note_is_absent(path) {
                    return Err(VaultError::conflict(
                        "The Note or its parent directory was deleted. Reload or save a recovery copy.",
                        None,
                    ));
                }
                Err(error)
            }
        }
    }

    pub(crate) fn read_note_identified(
        &self,
        path: &str,
        expected_identity: &str,
    ) -> VaultResult<NoteDocument> {
        note_path(path)?;
        let mut target = super::navigation::navigation_target(self, path)?;
        if target.identity != expected_identity {
            return Err(VaultError::conflict(
                "The document identity changed before it could be opened. Reopen the current file explicitly.",
                None,
            ));
        }
        let text = String::from_utf8(target.read_bytes()?)
            .map_err(|_| VaultError::invalid("The Note is not UTF-8."))?;
        Ok(document(path, text))
    }

    /// Return authorized bytes via the capability, not a second ambient-path read.
    pub fn read_document(&self, path: &str) -> VaultResult<(PathBuf, &'static str, Vec<u8>)> {
        let relative = relative(path)?;
        let kind = kind(relative);
        if !matches!(kind, "markdown" | "pdf" | "docx") {
            return Err(VaultError::invalid(
                "Choose a Markdown, PDF or DOCX document.",
            ));
        }
        let (dir, name) = self.parent(path, false)?;
        let bytes = read_regular(&dir, &name)?;
        let absolute = self.root.join(relative);
        if absolute.canonicalize()? != absolute {
            return Err(VaultError::invalid(
                "The document path changed or became a link. Refresh the Vault.",
            ));
        }
        Ok((absolute, kind, bytes))
    }

    pub fn create_note(&self, path: &str, text: &str) -> VaultResult<NoteDocument> {
        let _identity = self
            .identity_writes
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let text = if note_metadata(text).id.is_some() {
            self.ensure_identity_available(path, text)?;
            text.to_owned()
        } else {
            adopt(text)?
        };
        self.create_raw(path, &text)
    }

    pub fn adopt_note(&self, path: &str, expected_revision: &str) -> VaultResult<NoteDocument> {
        let _identity = self
            .identity_writes
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let current = self.read_note(path)?;
        if current.revision != expected_revision {
            return self.stale(path, &current.text, Some(current.clone()));
        }
        let text = adopt(&current.text)?;
        self.save_note_checked(path, &text, expected_revision, || {}, current.id.is_none())
    }

    pub(super) fn ensure_identity_available(&self, path: &str, text: &str) -> VaultResult<()> {
        if let Some(id) = note_metadata(text).id
            && let Some(existing) = self
                .identity_paths(&id)?
                .into_iter()
                .find(|candidate| candidate != path)
        {
            let existing = self.matching_note(&existing, &id)?;

            return Err(VaultError::conflict(
                format!(
                    "Identity collision with {}. Use Import to deduplicate identical content or save a raw recovery copy explicitly.",
                    existing.path
                ),
                Some(existing),
            ));
        }

        Ok(())
    }
}
