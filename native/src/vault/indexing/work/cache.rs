//! Disposable SQLite metadata cache and cancellable generation pruning.
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use sqlx::{Connection, Row, SqliteConnection, sqlite::SqliteConnectOptions};

use crate::vault::{Vault, VaultResult};

use super::super::IndexedEntry;
use super::WORK_TIME;

pub(super) enum Delta {
    Put(IndexedEntry),
    DeleteSubtree(String),
}

pub(super) async fn open_index(vault: &Vault) -> VaultResult<(SqliteConnection, bool)> {
    let options = SqliteConnectOptions::new()
        .filename(vault.index_path())
        .create_if_missing(true)
        .busy_timeout(Duration::from_millis(100));
    let mut connection = SqliteConnection::connect_with(&options).await?;
    let columns = sqlx::query("PRAGMA table_info(entries)")
        .fetch_all(&mut connection)
        .await?;
    let fresh = columns.is_empty();
    if fresh {
        sqlx::query("CREATE TABLE IF NOT EXISTS entries (path TEXT PRIMARY KEY, kind TEXT NOT NULL, id TEXT, metadata TEXT, metadata_error TEXT, generation TEXT)")
            .execute(&mut connection).await?;
    }
    // One-time migration of the previous disposable source-copy cache, not a refresh rebuild.
    for column in &columns {
        let name: &str = column.try_get("name")?;
        match name {
            "source" => {
                sqlx::query("ALTER TABLE entries DROP COLUMN source")
                    .execute(&mut connection)
                    .await?;
            }
            "revision" => {
                sqlx::query("ALTER TABLE entries DROP COLUMN revision")
                    .execute(&mut connection)
                    .await?;
            }
            _ => {}
        }
    }
    if !fresh
        && !columns.iter().any(|column| {
            column
                .try_get::<&str, _>("name")
                .is_ok_and(|name| name == "generation")
        })
    {
        sqlx::query("ALTER TABLE entries ADD COLUMN generation TEXT")
            .execute(&mut connection)
            .await?;
    }
    sqlx::query("CREATE INDEX IF NOT EXISTS entries_id ON entries(id)")
        .execute(&mut connection)
        .await?;
    Ok((connection, fresh))
}

pub(super) async fn write_changes(
    connection: &mut SqliteConnection,
    changes: &[Delta],
    token: &str,
) -> VaultResult<()> {
    let mut transaction = connection.begin().await?;
    for change in changes {
        match change {
            Delta::Put(row) => {
                sqlx::query("INSERT INTO entries (path,kind,id,metadata,metadata_error,generation) VALUES (?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET kind=excluded.kind,id=excluded.id,metadata=excluded.metadata,metadata_error=excluded.metadata_error,generation=excluded.generation")
                    .bind(&row.entry.path).bind(row.entry.kind).bind(&row.entry.id).bind(&row.metadata)
                    .bind(&row.entry.metadata_error).bind(token).execute(&mut *transaction).await?;
            }
            Delta::DeleteSubtree(path) => {
                let prefix = format!("{path}/");
                sqlx::query("DELETE FROM entries WHERE path = ? OR substr(path,1,?) = ?")
                    .bind(path)
                    .bind(prefix.chars().count() as i64)
                    .bind(prefix)
                    .execute(&mut *transaction)
                    .await?;
            }
        }
    }
    transaction.commit().await?;
    Ok(())
}

pub(super) async fn prune_index(
    connection: &mut SqliteConnection,
    scopes: &[String],
    token: &str,
    cancel: &AtomicBool,
    started: Instant,
) -> VaultResult<bool> {
    let mut transaction = connection.begin().await?;
    for scope in scopes {
        if cancel.load(Ordering::Acquire) || started.elapsed() >= WORK_TIME {
            transaction.rollback().await?;
            return Ok(false);
        }
        if scope.is_empty() {
            sqlx::query("DELETE FROM entries WHERE generation IS NULL OR generation != ?")
                .bind(token)
                .execute(&mut *transaction)
                .await?;
        } else {
            let prefix = format!("{scope}/");
            sqlx::query("DELETE FROM entries WHERE (generation IS NULL OR generation != ?) AND (path = ? OR substr(path,1,?) = ?)")
                .bind(token).bind(scope).bind(prefix.chars().count() as i64).bind(prefix)
                .execute(&mut *transaction).await?;
        }
    }
    if cancel.load(Ordering::Acquire) || started.elapsed() >= WORK_TIME {
        transaction.rollback().await?;
        return Ok(false);
    }
    transaction.commit().await?;
    Ok(true)
}
