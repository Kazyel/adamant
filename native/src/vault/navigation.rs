use crate::vault::{VaultError, VaultResult};
use std::{io::Read, path::PathBuf};

#[derive(serde::Serialize)]
pub(crate) struct NavigationTarget {
    pub(crate) entry: crate::vault::VaultEntry,
    pub(crate) identity: String,
    #[serde(skip)]
    pub(crate) source: Option<cap_std::fs::File>,
}

impl NavigationTarget {
    pub(crate) fn read_bytes(&mut self) -> VaultResult<Vec<u8>> {
        let mut file = self
            .source
            .take()
            .ok_or_else(|| VaultError::invalid("Choose a regular document, not a folder."))?;
        let before = file.metadata()?;
        if before.len() > super::MAX_BYTES {
            return Err(VaultError::invalid("Documents are limited to 64 MiB."));
        }
        let mut bytes = Vec::with_capacity(before.len() as usize);
        file.by_ref()
            .take(super::MAX_BYTES + 1)
            .read_to_end(&mut bytes)?;
        let after = file.metadata()?;
        if bytes.len() as u64 > super::MAX_BYTES
            || before.len() != after.len()
            || before.modified()? != after.modified()?
        {
            return Err(VaultError::invalid(
                "The document changed while reading. Open it again; no source was changed.",
            ));
        }
        if self.entry.kind == "markdown" {
            let text = std::str::from_utf8(&bytes)
                .map_err(|_| VaultError::invalid("The Markdown document is not UTF-8."))?;
            if super::metadata::note_metadata(text).id != self.entry.id {
                return Err(VaultError::invalid(
                    "The Note identity could not be verified while reading. Open it again; source bytes were not changed.",
                ));
            }
        }
        Ok(bytes)
    }
}
pub(super) fn navigation_target(
    vault: &crate::vault::Vault,
    path: &str,
) -> VaultResult<NavigationTarget> {
    let (parent, name) = vault.parent(path, false)?;
    navigation_target_in(&parent, &name, path)
}

pub(super) fn navigation_target_in(
    parent: &cap_std::fs::Dir,
    name: &std::path::Path,
    path: &str,
) -> VaultResult<NavigationTarget> {
    use crate::vault::{capability, metadata};
    use std::{
        io::{Read, Seek, SeekFrom},
        path::Path,
    };
    let information = parent.symlink_metadata(name)?;
    let kind = if information.is_dir() {
        "directory"
    } else {
        capability::kind(name)
    };
    if information.is_symlink()
        || (!information.is_file() && !information.is_dir())
        || !matches!(kind, "directory" | "markdown" | "pdf" | "docx")
    {
        return Err(VaultError::invalid(
            "This target is not a supported document or real folder.",
        ));
    }
    let mut source = if information.is_file() {
        Some(capability::open_regular(parent, name)?)
    } else {
        None
    };
    let information = match &source {
        Some(file) => file.metadata()?,
        None => information,
    };
    let mut id = None;
    let mut metadata_error = None;
    if kind == "markdown" {
        let file = source
            .as_mut()
            .ok_or_else(|| VaultError::invalid("The Note is no longer a regular file."))?;
        let mut prefix = Vec::new();
        file.by_ref().take(256 * 1024).read_to_end(&mut prefix)?;
        file.seek(SeekFrom::Start(0))?;
        let text = match std::str::from_utf8(&prefix) {
            Ok(text) => text,
            Err(error) => std::str::from_utf8(&prefix[..error.valid_up_to()])
                .map_err(|_| VaultError::invalid("The Note metadata is not UTF-8."))?,
        };
        let parsed = metadata::note_metadata(text);
        id = parsed.id;
        metadata_error = parsed.error;
    } else if matches!(kind, "pdf" | "docx") {
        let companion = format!("{}.meta.yaml", name.to_string_lossy());
        match parent.symlink_metadata(&companion) {
            Ok(_) => {
                let bytes = capability::read_limited(parent, Path::new(&companion), 256 * 1024)?;
                let text = std::str::from_utf8(&bytes)
                    .map_err(|_| VaultError::invalid("Companion metadata is not UTF-8."))?;
                let parsed = metadata::companion_metadata(text);
                id = parsed.id;
                metadata_error = parsed.error;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let identity = target_identity(id.as_deref(), &information)?;
    let modified_at = information
        .modified()
        .ok()
        .and_then(|time| time.into_std().duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|time| u64::try_from(time.as_millis()).ok());
    Ok(NavigationTarget {
        entry: crate::vault::VaultEntry {
            path: path.to_owned(),
            kind,
            id,
            metadata_error,
            modified_at,
        },
        identity,
        source,
    })
}

pub(super) fn target_identity(
    id: Option<&str>,
    information: &cap_std::fs::Metadata,
) -> VaultResult<String> {
    if let Some(id) = id {
        return Ok(format!("uuid:{id}"));
    }
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        Ok(format!("file:{}:{}", information.dev(), information.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = information;
        Err(VaultError::invalid(
            "This platform cannot verify the identity of this unmanaged target. Open it explicitly from the explorer.",
        ))
    }
}
pub(super) fn retained_parent(path: &std::path::Path) -> VaultResult<(cap_std::fs::Dir, PathBuf)> {
    use cap_fs_ext::DirExt;
    use cap_std::{ambient_authority, fs::Dir};
    use std::path::Component;
    if !path.is_absolute() {
        return Err(VaultError::invalid(
            "The retained document path must be absolute.",
        ));
    }
    let mut root = PathBuf::new();
    let mut components = Vec::new();
    for part in path.components() {
        match part {
            Component::Prefix(prefix) => root.push(prefix.as_os_str()),
            Component::RootDir => root.push(std::path::MAIN_SEPARATOR.to_string()),
            Component::Normal(name) => components.push(name),
            _ => {
                return Err(VaultError::invalid(
                    "The retained document path is not normalized.",
                ));
            }
        }
    }
    let name = components
        .pop()
        .ok_or_else(|| VaultError::invalid("The retained document has no filename."))?;
    let mut directory = Dir::open_ambient_dir(root, ambient_authority())?;
    for component in components {
        directory = directory.open_dir_nofollow(component)?;
    }
    Ok((directory, PathBuf::from(name)))
}

pub(crate) fn retained_target(path: &str) -> VaultResult<NavigationTarget> {
    let (directory, name) = retained_parent(std::path::Path::new(path))?;
    let kind = super::capability::kind(&name);
    if !matches!(kind, "markdown" | "pdf" | "docx") {
        return Err(VaultError::invalid(
            "The retained file is not a supported document.",
        ));
    }
    navigation_target_in(&directory, &name, path)
}
