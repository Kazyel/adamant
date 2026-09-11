use std::fs;
use std::sync::atomic::AtomicBool;

use super::{Fixture, identified, reconciled};
use crate::vault::{
    IndexState, Vault, VaultResult,
    indexing::{SearchPage, SearchQuery},
};

#[test]
fn content_search_advances_incrementally_past_first_batch() {
    let fixture = Fixture::new();
    for index in 0..65 {
        let body = if index == 64 {
            "needle beyond first batch"
        } else {
            "other"
        };
        fs::write(
            fixture.root.join(format!("note-{index:03}.md")),
            identified(body),
        )
        .unwrap();
    }
    reconciled(&fixture.vault);
    let cancel = AtomicBool::new(false);
    let first = fixture
        .vault
        .search(
            SearchQuery {
                request_id: "first".into(),
                query: "needle",
                mode: "content",
                offset: 0,
                limit: 50,
                expected_generation: None,
            },
            &cancel,
        )
        .unwrap();
    assert_eq!(first.indexing.state, IndexState::Partial);
    let mut page = first;
    for round in 1..4 {
        if page.indexing.state == IndexState::Ready {
            break;
        }
        page = fixture
            .vault
            .search(
                SearchQuery {
                    request_id: format!("round-{round}"),
                    query: "needle",
                    mode: "content",
                    offset: 0,
                    limit: 50,
                    expected_generation: None,
                },
                &cancel,
            )
            .unwrap();
    }
    assert!(page.indexing.state == IndexState::Ready);
    assert_eq!(page.hits.len(), 1);
    assert_eq!(page.hits[0].path, "note-064.md");
}

#[test]
fn partial_content_continuation_is_actionably_rejected() {
    let fixture = Fixture::new();
    for index in 0..65 {
        fs::write(
            fixture.root.join(format!("note-{index:03}.md")),
            identified("needle"),
        )
        .unwrap();
    }
    reconciled(&fixture.vault);
    let cancel = AtomicBool::new(false);
    let first = fixture
        .vault
        .search(
            SearchQuery {
                request_id: "first".into(),
                query: "needle",
                mode: "content",
                offset: 0,
                limit: 50,
                expected_generation: None,
            },
            &cancel,
        )
        .unwrap();
    assert_eq!(first.indexing.state, IndexState::Partial);
    let continuation = fixture.vault.search(
        SearchQuery {
            request_id: "next".into(),
            query: "needle",
            mode: "content",
            offset: 50,
            limit: 50,
            expected_generation: Some(first.generation),
        },
        &cancel,
    );
    assert_eq!(continuation.unwrap_err().kind, "conflict");
}

#[test]
fn cancelled_search_reports_partial_results_without_reading_more_sources() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("cancel.md"), identified("needle")).unwrap();
    reconciled(&fixture.vault);
    let cancel = AtomicBool::new(true);
    let page = fixture
        .vault
        .search(
            SearchQuery {
                request_id: "cancel".into(),
                query: "needle",
                mode: "content",
                offset: 0,
                limit: 50,
                expected_generation: None,
            },
            &cancel,
        )
        .unwrap();
    assert_eq!(page.indexing.state, IndexState::Cancelled);
    assert!(page.hits.is_empty());
}

#[test]
fn unicode_occurrence_columns_count_source_characters() {
    let fixture = Fixture::new();
    let source = identified("a😀 日本語 needle");
    fs::write(fixture.root.join("unicode.md"), &source).unwrap();
    reconciled(&fixture.vault);
    let cancel = AtomicBool::new(false);
    let page = fixture
        .vault
        .search(
            SearchQuery {
                request_id: "unicode".into(),
                query: "日本",
                mode: "content",
                offset: 0,
                limit: 50,
                expected_generation: None,
            },
            &cancel,
        )
        .unwrap();
    assert_eq!(page.indexing.state, IndexState::Ready);
    assert_eq!(
        page.hits[0].line,
        source
            .lines()
            .position(|line| line.contains("日本"))
            .map(|line| line + 1)
    );
    assert_eq!(page.hits[0].column, Some(4));
}

#[test]
fn reset_generation_does_not_retain_old_body_results() {
    let fixture = Fixture::new();
    let source = identified("oldneedle");
    fs::write(fixture.root.join("note.md"), &source).unwrap();
    reconciled(&fixture.vault);
    let cancel = AtomicBool::new(false);
    fixture
        .vault
        .search(
            SearchQuery {
                request_id: "old".into(),
                query: "oldneedle",
                mode: "content",
                offset: 0,
                limit: 50,
                expected_generation: None,
            },
            &cancel,
        )
        .unwrap();
    fs::write(
        fixture.root.join("note.md"),
        source.replace("oldneedle", "newneedle"),
    )
    .unwrap();
    reconciled(&fixture.vault);
    let old = fixture
        .vault
        .search(
            SearchQuery {
                request_id: "old-again".into(),
                query: "oldneedle",
                mode: "content",
                offset: 0,
                limit: 50,
                expected_generation: None,
            },
            &cancel,
        )
        .unwrap();
    assert!(old.hits.is_empty());
    let new = fixture
        .vault
        .search(
            SearchQuery {
                request_id: "new".into(),
                query: "newneedle",
                mode: "content",
                offset: 0,
                limit: 50,
                expected_generation: None,
            },
            &cancel,
        )
        .unwrap();
    assert_eq!(new.hits[0].path, "note.md");
}

#[test]
fn legacy_owned_admin_is_excluded_but_unmarked_directory_is_visible() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.root.join(".adamant")).unwrap();
    fs::write(fixture.root.join(".adamant/payload.md"), "user").unwrap();
    reconciled(&fixture.vault);
    assert!(
        fixture
            .vault
            .list_entries("", 0, 100)
            .unwrap()
            .entries
            .iter()
            .any(|entry| entry.path == ".adamant")
    );

    fs::remove_dir_all(fixture.root.join(".adamant")).unwrap();
    fs::create_dir(fixture.root.join(".adamant")).unwrap();
    fs::write(fixture.root.join(".adamant/marker"), b"adamant-admin-v1\n").unwrap();
    fs::write(fixture.root.join(".adamant/payload.md"), "trash").unwrap();
    reconciled(&fixture.vault);
    assert!(
        !fixture
            .vault
            .list_entries("", 0, 100)
            .unwrap()
            .entries
            .iter()
            .any(|entry| entry.path == ".adamant")
    );
}

#[test]
fn listing_sorts_folders_first_and_rejects_stale_inventory_generation() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.root.join("folder")).unwrap();
    fs::write(fixture.root.join("z.md"), "z").unwrap();
    fs::write(fixture.root.join("a.md"), "a").unwrap();
    reconciled(&fixture.vault);
    let page = fixture
        .vault
        .list_entries_filtered("", 0, 50, "modified", "", None)
        .unwrap();
    assert_eq!(
        page.entries.first().map(|entry| entry.kind),
        Some("directory")
    );
    assert!(
        fixture
            .vault
            .list_entries_filtered("", 0, 50, "name", "", Some(page.generation + 1))
            .is_err()
    );
}

fn search_page(
    vault: &Vault,
    mode: &str,
    offset: usize,
    generation: Option<u64>,
) -> VaultResult<SearchPage> {
    vault.search(
        SearchQuery {
            request_id: format!("{mode}-{offset}"),
            query: "needle",
            mode,
            offset,
            limit: 1,
            expected_generation: generation,
        },
        &AtomicBool::new(false),
    )
}

#[cfg(unix)]
#[test]
fn search_hits_reject_unmanaged_replacements_at_the_same_path() {
    let fixture = Fixture::new();
    for path in ["needle.md", "needle.pdf", "needle.docx"] {
        fs::write(fixture.root.join(path), "needle").unwrap();
    }
    reconciled(&fixture.vault);
    for (offset, path) in ["needle.docx", "needle.md", "needle.pdf"]
        .into_iter()
        .enumerate()
    {
        let page = search_page(
            &fixture.vault,
            "path",
            offset,
            Some(fixture.vault.list_entries("", 0, 1).unwrap().generation),
        )
        .unwrap();
        let hit = &page.hits[0];
        assert_eq!(hit.path, path);
        assert_eq!(hit.id, None);
        let target = crate::vault::navigation::navigation_target(&fixture.vault, path).unwrap();
        assert_eq!(hit.identity, target.identity);
        let content =
            (path == "needle.md").then(|| search_page(&fixture.vault, "content", 0, None).unwrap());
        if let Some(content) = &content {
            assert_eq!(content.hits[0].identity, hit.identity);
        }

        // Retain the old inode so replacement detection cannot depend on inode reuse timing.
        fs::rename(
            fixture.root.join(path),
            fixture.root.join(format!("{path}.retained")),
        )
        .unwrap();
        fs::write(fixture.root.join(path), "needle").unwrap();
        let replacement =
            crate::vault::navigation::navigation_target(&fixture.vault, path).unwrap();
        assert_ne!(hit.identity, replacement.identity);
        if let Some(content) = content {
            for stale in [hit, &content.hits[0]] {
                assert_eq!(
                    fixture
                        .vault
                        .read_note_identified(path, &stale.identity)
                        .unwrap_err()
                        .kind,
                    "conflict",
                );
            }
        }
    }
}

#[test]
fn row_publication_rejects_directory_and_search_continuations_in_one_reconciliation() {
    let fixture = Fixture::new();
    for path in ["a-checkpoint", "c-checkpoint"] {
        fs::create_dir(fixture.root.join(path)).unwrap();
    }
    for path in ["needle-a.md", "needle-z.md"] {
        fs::write(fixture.root.join(path), identified("needle")).unwrap();
    }
    reconciled(&fixture.vault);
    fs::write(fixture.root.join("b-needle.md"), identified("needle")).unwrap();
    let mut first = None;
    let mut checked = false;
    assert!(
        fixture
            .vault
            .apply_changes(
                &["a-checkpoint", "b-needle.md", "c-checkpoint"].map(Into::into),
                &AtomicBool::new(false),
                &mut |path| {
                    if path.ends_with("a-checkpoint") {
                        let listing = fixture
                            .vault
                            .list_entries_filtered("", 0, 1, "name", ".md", None)?;
                        let path_search = search_page(&fixture.vault, "path", 0, None)?;
                        let content_search = search_page(&fixture.vault, "content", 0, None)?;
                        assert_eq!(listing.entries[0].path, "needle-a.md");
                        assert_eq!(path_search.hits[0].path, "needle-a.md");
                        assert_eq!(content_search.hits[0].path, "needle-a.md");
                        first = Some((
                            listing.generation,
                            path_search.generation,
                            content_search.generation,
                        ));
                    } else if path.ends_with("c-checkpoint") {
                        let (listing, path_search, content_search) =
                            first.expect("First checkpoint ran");
                        assert_eq!(
                            fixture
                                .vault
                                .list_entries_filtered("", 1, 1, "name", ".md", Some(listing))
                                .unwrap_err()
                                .kind,
                            "conflict",
                        );
                        for (mode, generation) in
                            [("path", path_search), ("content", content_search)]
                        {
                            assert_eq!(
                                search_page(&fixture.vault, mode, 1, Some(generation))
                                    .unwrap_err()
                                    .kind,
                                "conflict"
                            );
                            let restarted = search_page(&fixture.vault, mode, 0, None)?;
                            assert_eq!(restarted.hits[0].path, "b-needle.md");
                        }
                        checked = true;
                    }
                    Ok(())
                },
            )
            .unwrap()
    );
    assert!(checked);
}

#[test]
fn unchanged_directory_and_search_snapshots_paginate_without_skips() {
    let fixture = Fixture::new();
    for path in ["needle-a.md", "needle-b.md", "needle-c.md"] {
        fs::write(fixture.root.join(path), identified("needle")).unwrap();
    }
    reconciled(&fixture.vault);
    let first = fixture
        .vault
        .list_entries_filtered("", 0, 1, "name", "", None)
        .unwrap();
    let second = fixture
        .vault
        .list_entries_filtered("", 1, 1, "name", "", Some(first.generation))
        .unwrap();
    assert_eq!(first.entries[0].path, "needle-a.md");
    assert_eq!(second.entries[0].path, "needle-b.md");
    assert_eq!(first.generation, second.generation);
    for mode in ["path", "content"] {
        let first = search_page(&fixture.vault, mode, 0, None).unwrap();
        let second = search_page(&fixture.vault, mode, 1, Some(first.generation)).unwrap();
        let third = search_page(&fixture.vault, mode, 2, Some(first.generation)).unwrap();
        assert_eq!(first.hits[0].path, "needle-a.md");
        assert_eq!(second.hits[0].path, "needle-b.md");
        assert_eq!(third.hits[0].path, "needle-c.md");
        assert_eq!(first.generation, second.generation);
        assert_eq!(first.generation, third.generation);
        assert!(!third.has_more);
        assert_eq!(
            first.hits[0].identity,
            format!("uuid:{}", first.hits[0].id.as_ref().unwrap())
        );
    }
}
