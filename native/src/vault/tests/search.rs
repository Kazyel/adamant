use std::fs;
use std::sync::atomic::AtomicBool;

use super::{Fixture, identified, reconciled};
use crate::vault::{
    IndexState, Vault, VaultResult,
    indexing::{SearchFilters, SearchPage, SearchQuery},
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
                filters: Default::default(),
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
                    filters: Default::default(),
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
                filters: Default::default(),
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
            filters: Default::default(),
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
                filters: Default::default(),
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
                filters: Default::default(),
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
                filters: Default::default(),
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
                filters: Default::default(),
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
                filters: Default::default(),
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
            filters: Default::default(),
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

#[test]
fn content_pages_preserve_unicode_columns_and_the_global_result_limit() {
    let fixture = Fixture::new();
    let source = "😀 İi İİi\n".repeat(101);
    fs::write(fixture.root.join("unicode.md"), &source).unwrap();
    reconciled(&fixture.vault);
    let query = |offset, limit, generation| {
        fixture
            .vault
            .search(
                SearchQuery {
                    request_id: format!("unicode-{offset}"),
                    query: "i",
                    mode: "content",
                    offset,
                    limit,
                    expected_generation: generation,
                    filters: Default::default(),
                },
                &AtomicBool::new(false),
            )
            .unwrap()
    };
    let first = query(0, 1, None);
    assert!(first.truncated);
    assert!(first.has_more);
    assert!(!first.can_continue);
    assert_eq!(first.hits[0].column, Some(3));
    let middle = query(1, 2, Some(first.generation));
    assert_eq!(
        middle.hits.iter().map(|hit| hit.column).collect::<Vec<_>>(),
        vec![Some(4), Some(6)]
    );
    assert!(
        middle
            .hits
            .iter()
            .all(|hit| hit.line == Some(1) && hit.snippet == "😀 İi İİi")
    );
    let last = query(499, 50, Some(first.generation));
    assert_eq!(last.hits.len(), 1);
    assert_eq!(last.hits[0].line, Some(100));
    assert_eq!(last.hits[0].column, Some(8));
    assert!(!last.has_more);
    assert!(last.truncated);
    let exhausted = query(500, 50, Some(first.generation));
    assert!(exhausted.hits.is_empty());
    assert!(!exhausted.has_more);
    assert!(exhausted.truncated);
}

#[test]
fn path_search_distinguishes_exact_capacity_from_truncation() {
    let fixture = Fixture::new();
    for index in 0..500 {
        fs::write(fixture.root.join(format!("needle-{index:03}.md")), "source").unwrap();
    }
    reconciled(&fixture.vault);
    let first = search_page(&fixture.vault, "path", 0, None).unwrap();
    assert!(!first.truncated);
    assert!(first.has_more);
    let last = search_page(&fixture.vault, "path", 499, Some(first.generation)).unwrap();
    assert_eq!(last.hits[0].path, "needle-499.md");
    assert!(!last.has_more);
    assert!(!last.truncated);

    fs::write(fixture.root.join("needle-500.md"), "source").unwrap();
    reconciled(&fixture.vault);
    let truncated = search_page(&fixture.vault, "path", 0, None).unwrap();
    assert!(truncated.truncated);
    let last = search_page(&fixture.vault, "path", 499, Some(truncated.generation)).unwrap();
    assert_eq!(last.hits[0].path, "needle-499.md");
    assert!(!last.has_more);
    assert!(last.truncated);
    let exhausted = search_page(&fixture.vault, "path", 500, Some(truncated.generation)).unwrap();
    assert!(exhausted.hits.is_empty());
    assert!(!exhausted.has_more);
    assert!(exhausted.truncated);
}

#[test]
fn watcher_change_reuses_unaffected_body_cache_and_replaces_changed_text() {
    let fixture = Fixture::new();
    for index in 0..130 {
        fs::write(
            fixture.root.join(format!("note-{index:03}.md")),
            identified("oldneedle"),
        )
        .unwrap();
    }
    reconciled(&fixture.vault);
    for _ in 0..20 {
        if !search_page(&fixture.vault, "content", 0, None)
            .unwrap()
            .can_continue
        {
            break;
        }
    }
    let changed = fixture.root.join("note-000.md");
    let original = fs::read_to_string(&changed).unwrap();
    fs::write(&changed, original.replace("oldneedle", "newneedle")).unwrap();
    assert!(
        fixture
            .vault
            .apply_changes(&[changed], &AtomicBool::new(false), &mut |_| Ok(()))
            .unwrap()
    );
    let page = search_page(&fixture.vault, "content", 0, None).unwrap();
    // A complete reset would need at least three 64-file batches to reach this state.
    assert!(!page.can_continue);
    let result = fixture
        .vault
        .search(
            SearchQuery {
                request_id: "new".into(),
                query: "newneedle",
                mode: "content",
                offset: 0,
                limit: 50,
                expected_generation: None,
                filters: Default::default(),
            },
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(result.hits.len(), 1);
    assert_eq!(result.hits[0].path, "note-000.md");
    let old = fixture
        .vault
        .search(
            SearchQuery {
                request_id: "old".into(),
                query: "oldneedle",
                mode: "content",
                offset: 0,
                limit: 50,
                expected_generation: None,
                filters: Default::default(),
            },
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(old.hits.iter().all(|hit| hit.path != "note-000.md"));
    assert_eq!(old.hits.len(), 50);
}

fn pdf_source(text: &str) -> Vec<u8> {
    pdf_pages(&[text])
}

fn pdf_pages(texts: &[&str]) -> Vec<u8> {
    use lopdf::{
        Document, Object, Stream,
        content::{Content, Operation},
        dictionary,
    };
    let mut pdf = Document::with_version("1.5");
    let pages = pdf.new_object_id();
    let font = pdf.add_object(
        dictionary! {"Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica"},
    );
    let resources = pdf.add_object(dictionary! {"Font" => dictionary! {"F1" => font}});
    let mut page_ids = Vec::new();
    for text in texts {
        let contents = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![50.into(), 700.into()]),
                Operation::new("Tj", vec![Object::string_literal(*text)]),
                Operation::new("ET", vec![]),
            ],
        };
        let contents = pdf.add_object(Stream::new(dictionary! {}, contents.encode().unwrap()));
        let page = pdf.add_object(dictionary! {"Type" => "Page", "Parent" => pages, "Contents" => contents, "Resources" => resources, "MediaBox" => vec![0.into(), 0.into(), 600.into(), 800.into()]});
        page_ids.push(page.into());
    }
    pdf.objects.insert(
        pages,
        dictionary! {"Type" => "Pages", "Kids" => page_ids, "Count" => texts.len() as u32}.into(),
    );
    let catalog = pdf.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages});
    pdf.trailer.set("Root", catalog);
    let mut bytes = Vec::new();
    pdf.save_to(&mut bytes).unwrap();
    bytes
}

fn docx_source(xml: &str) -> Vec<u8> {
    use std::io::{Cursor, Write};
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    archive
        .start_file(
            "word/document.xml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    archive.write_all(xml.as_bytes()).unwrap();
    archive.finish().unwrap().into_inner()
}

#[test]
fn document_search_extracts_pdf_and_docx_without_modifying_originals() {
    let fixture = Fixture::new();
    let pdf = pdf_source("searchable needle inside PDF");
    let docx = docx_source(
        r#"<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Olá 😀 needle &amp; context</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table needle</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>"#,
    );
    fs::write(fixture.root.join("a.pdf"), &pdf).unwrap();
    fs::write(fixture.root.join("b.docx"), &docx).unwrap();
    fs::write(fixture.root.join("c.md"), identified("Markdown needle")).unwrap();
    reconciled(&fixture.vault);
    let mut page = search_page(&fixture.vault, "content", 0, None).unwrap();
    for _ in 0..20 {
        if !page.can_continue {
            break;
        }
        page = search_page(&fixture.vault, "content", 0, None).unwrap();
    }
    let page = fixture
        .vault
        .search(
            SearchQuery {
                request_id: "all".into(),
                query: "needle",
                mode: "content",
                offset: 0,
                limit: 50,
                expected_generation: None,
                filters: Default::default(),
            },
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(page.indexing.state, IndexState::Ready);
    assert_eq!(
        page.hits
            .iter()
            .map(|hit| hit.kind.as_str())
            .collect::<Vec<_>>(),
        vec!["pdf", "docx", "docx", "markdown"]
    );
    assert!(
        page.hits[..3]
            .iter()
            .all(|hit| hit.line.is_none() && hit.column.is_none())
    );
    assert!(page.hits[1].snippet.contains("Olá 😀 needle & context"));
    assert_eq!(
        page.hits[0].revision.as_deref(),
        Some(crate::vault::hash(&pdf).as_str())
    );
    let continuation = search_page(&fixture.vault, "content", 1, Some(page.generation)).unwrap();
    assert_eq!(continuation.hits[0].path, "b.docx");
    assert_eq!(fs::read(fixture.root.join("a.pdf")).unwrap(), pdf);
    assert_eq!(fs::read(fixture.root.join("b.docx")).unwrap(), docx);

    fs::write(fixture.root.join("a.pdf"), pdf_source("updated only")).unwrap();
    fixture
        .vault
        .apply_changes(
            &[fixture.root.join("a.pdf")],
            &AtomicBool::new(false),
            &mut |_| Ok(()),
        )
        .unwrap();
    let refreshed = search_page(&fixture.vault, "content", 0, None).unwrap();
    assert!(!refreshed.can_continue);
    assert!(refreshed.hits.iter().all(|hit| hit.path != "a.pdf"));
}

#[test]
fn document_search_reports_unextractable_sources_without_affecting_note_links() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("broken.pdf"), b"%PDF invalid").unwrap();
    fs::write(fixture.root.join("empty.pdf"), pdf_source("")).unwrap();
    fs::write(fixture.root.join("external.docx"), docx_source(r#"<!DOCTYPE document [<!ENTITY leak SYSTEM "file:///etc/passwd">]><document><t>&leak;</t></document>"#)).unwrap();
    fs::write(fixture.root.join("note.md"), identified("needle")).unwrap();
    reconciled(&fixture.vault);
    let mut page = search_page(&fixture.vault, "content", 0, None).unwrap();
    for _ in 0..20 {
        if !page.can_continue {
            break;
        }
        page = search_page(&fixture.vault, "content", 0, None).unwrap();
    }
    assert!(!page.can_continue);
    assert_eq!(page.indexing.state, IndexState::Partial);
    assert_eq!(page.hits.len(), 1);
    let references = fixture
        .vault
        .note_links("note.md", None, "", Default::default())
        .unwrap();
    assert!(!references.can_continue);
    assert_eq!(references.indexing.state, IndexState::Ready);
}

#[test]
fn pdf_search_keeps_page_locations_across_empty_pages_and_result_pagination() {
    let fixture = Fixture::new();
    let pdf = pdf_pages(&[
        "needle first\nwith multiple lines",
        "",
        "third needle\x0cwithin page",
    ]);
    fs::write(fixture.root.join("pages.pdf"), &pdf).unwrap();
    fs::write(fixture.root.join("z.md"), identified("needle")).unwrap();
    reconciled(&fixture.vault);
    let first = search_page(&fixture.vault, "content", 0, None).unwrap();
    assert_eq!(
        (first.hits[0].path.as_str(), first.hits[0].page),
        ("pages.pdf", Some(1))
    );
    let second = search_page(&fixture.vault, "content", 1, Some(first.generation)).unwrap();
    assert_eq!(
        (second.hits[0].path.as_str(), second.hits[0].page),
        ("pages.pdf", Some(3))
    );
    assert!(second.hits[0].line.is_none());
    let third = search_page(&fixture.vault, "content", 2, Some(first.generation)).unwrap();
    assert_eq!(
        (third.hits[0].path.as_str(), third.hits[0].page),
        ("z.md", None)
    );
    assert_eq!(
        first.hits[0].revision.as_deref(),
        Some(crate::vault::hash(&pdf).as_str())
    );
    assert_eq!(fs::read(fixture.root.join("pages.pdf")).unwrap(), pdf);
}

#[test]
fn search_filters_apply_before_global_hit_limits_and_page_offsets() {
    let fixture = Fixture::new();
    for index in 0..501 {
        fs::write(
            fixture.root.join(format!("a-needle-{index:03}.md")),
            identified("needle"),
        )
        .unwrap();
    }
    for directory in ["z-wanted", "z-wanted-extra"] {
        fs::create_dir(fixture.root.join(directory)).unwrap();
    }
    for path in [
        "z-wanted/needle-a.md",
        "z-wanted/needle-b.md",
        "z-wanted-extra/needle-c.md",
    ] {
        fs::write(
            fixture.root.join(path),
            format!(
                "---\nid: {}\ntags: [work, focus]\n---\nneedle",
                uuid::Uuid::new_v4()
            ),
        )
        .unwrap();
    }
    fs::write(
        fixture.root.join("z-wanted/needle-partial.md"),
        format!(
            "---\nid: {}\ntags: [work]\n---\nneedle",
            uuid::Uuid::new_v4()
        ),
    )
    .unwrap();
    fs::write(
        fixture.root.join("z-wanted/needle.pdf"),
        pdf_source("needle"),
    )
    .unwrap();
    fs::write(
        fixture.root.join("z-wanted/needle.pdf.meta.yaml"),
        format!("id: {}\ntags: [work, focus]\n", uuid::Uuid::new_v4()),
    )
    .unwrap();
    reconciled(&fixture.vault);
    let query = |mode, offset, generation| {
        fixture
            .vault
            .search(
                SearchQuery {
                    request_id: format!("filtered-{mode}-{offset}"),
                    query: "needle",
                    mode,
                    offset,
                    limit: 1,
                    expected_generation: generation,
                    filters: SearchFilters {
                        tags: vec!["work".into(), "focus".into()],
                        directory: Some("z-wanted".into()),
                        kinds: vec!["markdown".into()],
                    },
                },
                &AtomicBool::new(false),
            )
            .unwrap()
    };
    for _ in 0..30 {
        if !query("content", 0, None).can_continue {
            break;
        }
    }
    for mode in ["path", "content"] {
        let first = query(mode, 0, None);
        assert_eq!(
            (
                first.hits.len(),
                first.has_more,
                first.truncated,
                first.can_continue
            ),
            (1, true, false, false)
        );
        assert_eq!(first.hits[0].path, "z-wanted/needle-a.md");
        let second = query(mode, 1, Some(first.generation));
        assert_eq!(
            (second.hits.len(), second.has_more, second.truncated),
            (1, false, false)
        );
        assert_eq!(second.hits[0].path, "z-wanted/needle-b.md");
    }
    for mode in ["path", "content"] {
        let files = fixture
            .vault
            .search(
                SearchQuery {
                    request_id: format!("filter-only-{mode}"),
                    query: "",
                    mode,
                    offset: 0,
                    limit: 50,
                    expected_generation: None,
                    filters: SearchFilters {
                        tags: vec!["work".into(), "focus".into()],
                        directory: Some("z-wanted".into()),
                        kinds: vec!["markdown".into(), "pdf".into()],
                    },
                },
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(
            files
                .hits
                .iter()
                .map(|hit| hit.path.as_str())
                .collect::<Vec<_>>(),
            vec![
                "z-wanted/needle-a.md",
                "z-wanted/needle-b.md",
                "z-wanted/needle.pdf"
            ]
        );
        assert!(
            files
                .hits
                .iter()
                .all(|hit| hit.page.is_none() && hit.revision.is_none())
        );
    }
}
