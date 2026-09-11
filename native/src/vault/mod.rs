//! Portable files are authoritative. `Vault::open` and all methods work without a window or dialog.

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use cap_std::fs::Dir;
use serde::Serialize;
use sha2::{Digest, Sha256};

mod capability;
pub(crate) mod commands;
mod indexing;
mod lifecycle;
mod metadata;
pub(crate) mod mutations;
pub(crate) mod navigation;
mod notes;
mod persistence;
pub(crate) mod workspace;

use indexing::Inventory;
pub use indexing::{IndexState, IndexStatus, VaultPage};

pub type VaultResult<T> = Result<T, VaultError>;
const MAX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultError {
    pub kind: &'static str,
    pub message: String,
    pub current: Option<Box<NoteDocument>>,
}

impl VaultError {
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self {
            kind: "invalid",
            message: message.into(),
            current: None,
        }
    }

    pub(crate) fn io(message: impl Into<String>) -> Self {
        Self {
            kind: "io",
            message: message.into(),
            current: None,
        }
    }

    fn conflict(message: impl Into<String>, current: Option<NoteDocument>) -> Self {
        Self {
            kind: "conflict",
            message: message.into(),
            current: current.map(Box::new),
        }
    }
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for VaultError {}

impl From<std::io::Error> for VaultError {
    fn from(error: std::io::Error) -> Self {
        Self::io(error.to_string())
    }
}

impl From<sqlx::Error> for VaultError {
    fn from(error: sqlx::Error) -> Self {
        Self::io(format!("Derived index: {error}"))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDocument {
    pub path: String,
    pub text: String,
    pub revision: String,
    pub id: Option<String>,
    pub metadata_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    pub path: String,
    pub kind: &'static str,
    pub id: Option<String>,
    pub metadata_error: Option<String>,
    pub modified_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultIssue {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSnapshot {
    pub id: String,
    pub name: String,
    pub root: String,
    pub content_root: &'static str,
    pub issues: Vec<VaultIssue>,
    pub issue_count: usize,
    pub indexing: IndexStatus,
}

pub struct Vault {
    root: PathBuf,
    dir: Dir,
    vault_root: PathBuf,
    manifest_dir: Dir,
    content_root_relative: &'static str,
    id: String,
    name: String,
    state_dir: PathBuf,
    inventory: Mutex<Inventory>,
    body_index: Mutex<indexing::BodyIndex>,
    index_work: Mutex<()>,
    identity_writes: Mutex<()>,
}

fn hash(bytes: &[u8]) -> String {
    hex_digest(&Sha256::digest(bytes))
}

fn hex_digest(digest: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut hex = String::with_capacity(64);
    for byte in digest {
        write!(&mut hex, "{byte:02x}").expect("Writing to a String cannot fail");
    }
    hex
}

/// A directory capability granted by the native parent-folder picker, never by an IPC path.
pub struct VaultParent {
    root: PathBuf,
    dir: Dir,
}

impl Vault {
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn vault_root(&self) -> &Path {
        &self.vault_root
    }

    pub fn index_path(&self) -> PathBuf {
        self.state_dir.join("index.sqlite")
    }

    pub fn recovery_directory(&self) -> PathBuf {
        self.state_dir.join("recovery")
    }
}

#[cfg(test)]
mod tests;
