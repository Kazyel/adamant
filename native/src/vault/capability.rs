use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, File, OpenOptions};

use super::{MAX_BYTES, Vault, VaultError, VaultResult};

pub(super) fn kind(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if extension.eq_ignore_ascii_case("md") => "markdown",
        Some(extension) if extension.eq_ignore_ascii_case("pdf") => "pdf",
        Some(extension) if extension.eq_ignore_ascii_case("docx") => "docx",
        _ => "file",
    }
}

pub(super) fn relative(path: &str) -> VaultResult<&Path> {
    let value = Path::new(path);
    if path.is_empty()
        || path.contains('\0')
        || value.is_absolute()
        || value
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || path.split('/').any(|part| matches!(part, "" | "." | ".."))
    {
        return Err(VaultError::invalid(
            "Use a nonempty Vault-relative path without traversal or absolute components.",
        ));
    }
    Ok(value)
}

pub(super) fn note_path(path: &str) -> VaultResult<&Path> {
    let path = relative(path)?;
    if kind(path) != "markdown" {
        return Err(VaultError::invalid("A Note needs a .md filename."));
    }
    Ok(path)
}

pub(super) fn open_regular(dir: &Dir, name: &Path) -> VaultResult<File> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        // A malicious FIFO/device must not block a native command while its type is checked.
        options.custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32);
    }

    let file = dir.open_with(name, &options)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(VaultError::invalid(
            "Choose a regular file, not a link or device.",
        ));
    }
    Ok(file)
}

pub(super) fn read_limited(dir: &Dir, name: &Path, limit: u64) -> VaultResult<Vec<u8>> {
    let file = open_regular(dir, name)?;
    let length = file.metadata()?.len();
    if length > limit {
        return Err(VaultError::invalid(format!(
            "The file exceeds the {limit}-byte read limit."
        )));
    }

    let mut bytes = Vec::with_capacity(length as usize);
    file.take(limit + 1).read_to_end(&mut bytes)?;

    if bytes.len() as u64 > limit {
        return Err(VaultError::invalid(format!(
            "The file exceeds the {limit}-byte read limit."
        )));
    }
    Ok(bytes)
}

pub(super) fn read_regular(dir: &Dir, name: &Path) -> VaultResult<Vec<u8>> {
    read_limited(dir, name, MAX_BYTES)
}

pub(super) fn read_text(dir: &Dir, name: &Path) -> VaultResult<String> {
    String::from_utf8(read_regular(dir, name)?)
        .map_err(|_| VaultError::invalid("Markdown and metadata must contain UTF-8 source text."))
}

pub(super) fn write_new(dir: &Dir, name: &Path, bytes: &[u8]) -> VaultResult<File> {
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = dir.open_with(name, &options)?;
    if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        let _ = dir.remove_file(name);
        return Err(error.into());
    }
    Ok(file)
}

pub(super) fn sync_dir(dir: &Dir) -> VaultResult<()> {
    #[cfg(unix)]
    // Directory capabilities may use O_PATH; fsync needs a readable directory descriptor.
    dir.open(".")?.sync_all()?;
    Ok(())
}

pub(super) fn private_dir(path: &Path) -> VaultResult<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    Ok(())
}

pub(super) fn verify_directory(root: &Path, dir: &Dir) -> VaultResult<()> {
    let current = fs::symlink_metadata(root)?;
    if !current.is_dir() || root.canonicalize()? != root {
        return Err(VaultError::invalid(
            "The selected folder moved or was replaced. Choose it again.",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let opened = dir.try_clone()?.into_std_file().metadata()?;
        if current.dev() != opened.dev() || current.ino() != opened.ino() {
            return Err(VaultError::invalid(
                "The selected folder moved or was replaced. Choose it again.",
            ));
        }
    }
    Ok(())
}

impl Vault {
    pub(super) fn parent(&self, path: &str, create: bool) -> VaultResult<(Dir, PathBuf)> {
        self.ensure_current_manifest()?;
        let path = relative(path)?;
        let mut dir = self.dir.try_clone()?;
        let components = path.components().collect::<Vec<_>>();
        for component in &components[..components.len() - 1] {
            let name = Path::new(component.as_os_str());
            if create {
                match dir.create_dir(name) {
                    Ok(()) => sync_dir(&dir)?,
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error.into()),
                }
            }
            dir = dir.open_dir_nofollow(name).map_err(|error| {
                VaultError::invalid(format!("Unsafe or unavailable parent directory: {error}"))
            })?;
        }
        Ok((dir, PathBuf::from(components.last().unwrap().as_os_str())))
    }
}
