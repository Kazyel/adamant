use std::fs;

use super::{Fixture, identified};
use crate::vault::{
    IndexState,
    indexing::NoteLinksSnapshot,
    mutations::{MutationKind, MutationRequest},
};

fn complete(fixture: &Fixture, path: &str, query: &str) -> NoteLinksSnapshot {
    for _ in 0..20 {
        let snapshot = fixture
            .vault
            .note_links(path, None, query, Default::default())
            .unwrap();
        if !snapshot.can_continue {
            return snapshot;
        }
    }
    panic!("Note indexing did not finish within its bounded batches");
}

#[test]
fn note_links_parse_relative_reference_links_and_preserve_source_lines() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.root.join("notes")).unwrap();
    let source = identified(
        "# Decision\n\nSee [auth](../Auth%20%28v2%29.md#login) and [again][auth].\n\n[auth]: ../Auth%20%28v2%29.md\n\n`[inline](../Auth%20%28v2%29.md)`\n\n```md\n[code](../Auth%20%28v2%29.md)\n```\n\n![image](../Auth%20%28v2%29.md)\n![alt [nested](../Auth%20%28v2%29.md)](image.png)\n[external](https://example.com/auth.md)\n[fragment](#login)\n[missing](missing.md)\n",
    );
    fs::write(fixture.root.join("notes/decision.md"), &source).unwrap();
    fs::write(
        fixture.root.join("Auth (v2).md"),
        identified("# Authentication\n"),
    )
    .unwrap();
    fixture.reconcile();
    let links = complete(&fixture, "notes/decision.md", "authentication");
    assert_eq!(links.outgoing.len(), 3);
    assert_eq!(
        (
            links.outgoing[0].target_path.as_str(),
            links.outgoing[0].line
        ),
        ("Auth (v2).md", 7)
    );
    assert!(links.outgoing[0].snippet.contains("See [auth]"));
    assert_eq!(
        serde_json::to_value(&links.outgoing[0]).unwrap()["status"],
        "resolved"
    );
    assert_eq!(
        serde_json::to_value(&links.outgoing[2]).unwrap()["status"],
        "missing"
    );
    assert_eq!(
        (links.targets.len(), links.targets[0].title.as_str()),
        (1, "Authentication")
    );
    let incoming = complete(&fixture, "Auth (v2).md", "");
    assert_eq!(
        incoming
            .incoming
            .iter()
            .map(|link| (
                link.path.as_str(),
                link.line,
                link.column,
                link.title.as_str()
            ))
            .collect::<Vec<_>>(),
        vec![
            ("notes/decision.md", 7, 5, "Decision"),
            ("notes/decision.md", 7, 45, "Decision"),
        ]
    );
    assert_eq!(
        incoming.incoming[0].revision.as_deref(),
        Some(crate::vault::hash(source.as_bytes()).as_str())
    );
    assert_eq!(
        fs::read_to_string(fixture.root.join("notes/decision.md")).unwrap(),
        source
    );
}

#[test]
fn note_links_ignore_frontmatter_and_use_metadata_titles() {
    let fixture = Fixture::new();
    let source = format!(
        "\u{feff}--- \r\nid: {}\r\ntitle: Saved title\r\ncustom: '[not a link](target.md)'\r\n... \r\n# Other title\r\n[real](target.md)\r\n",
        uuid::Uuid::new_v4(),
    );
    fs::write(fixture.root.join("source.md"), source).unwrap();
    fs::write(fixture.root.join("target.md"), identified("# Target")).unwrap();
    fixture.reconcile();
    let result = complete(&fixture, "target.md", "saved");
    assert_eq!(result.incoming.len(), 1);
    assert_eq!(result.incoming[0].line, 7);
    assert_eq!(result.targets[0].title, "Saved title");
}

#[test]
fn note_links_follow_saved_changes_and_managed_renames() {
    let fixture = Fixture::new();
    fixture
        .vault
        .create_note("source.md", "[target](target.md)")
        .unwrap();
    fixture.vault.create_note("target.md", "# Target").unwrap();
    fixture.reconcile();
    assert_eq!(complete(&fixture, "target.md", "").incoming.len(), 1);
    let plan = fixture
        .vault
        .prepare_mutation(MutationRequest {
            kind: MutationKind::Rename,
            paths: vec!["target.md".into()],
            destination: Some("renamed (target).md".into()),
        })
        .unwrap();
    fixture.vault.commit_mutation(&plan.id).unwrap();
    fixture.reconcile();
    assert_eq!(
        complete(&fixture, "renamed (target).md", "").incoming.len(),
        1
    );
    let source = fixture.vault.read_note("source.md").unwrap();
    fixture
        .vault
        .save_note("source.md", "No links remain", &source.revision)
        .unwrap();
    fixture.reconcile();
    assert!(
        complete(&fixture, "renamed (target).md", "")
            .incoming
            .is_empty()
    );
}

#[test]
fn note_links_advance_batches_and_report_permanent_limits() {
    let fixture = Fixture::new();
    for index in 0..65 {
        fs::write(
            fixture.root.join(format!("note-{index:03}.md")),
            identified("[missing](missing.md)"),
        )
        .unwrap();
    }
    fs::write(
        fixture.root.join("oversized.md"),
        "a".repeat(1024 * 1024 + 1),
    )
    .unwrap();
    fixture.reconcile();
    let first = fixture
        .vault
        .note_links("note-000.md", None, "", Default::default())
        .unwrap();
    assert!(first.can_continue);
    assert_eq!(first.indexing.state, IndexState::Partial);
    let final_page = complete(&fixture, "note-000.md", "");
    assert_eq!(final_page.indexing.state, IndexState::Partial);
    assert!(final_page.targets_has_more);
    assert_eq!(final_page.targets.len(), 50);
}

#[test]
fn note_links_refuse_replaced_source_identity_and_escape_links() {
    let fixture = Fixture::new();
    fs::write(
        fixture.root.join("source.md"),
        identified("[escape](../outside.md) [encoded](%2Foutside.md) [local](missing.md)"),
    )
    .unwrap();
    fixture.reconcile();
    assert_eq!(
        fixture
            .vault
            .note_links("source.md", Some("uuid:wrong"), "", Default::default())
            .unwrap_err()
            .kind,
        "conflict"
    );
    let result = complete(&fixture, "source.md", "");
    assert_eq!(result.outgoing.len(), 1);
    assert_eq!(result.outgoing[0].target_path, "missing.md");
}

#[cfg(unix)]
#[test]
fn note_links_do_not_read_symlinks() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let outside = fixture.state.join("outside.md");
    fs::create_dir_all(&fixture.state).unwrap();
    fs::write(&outside, "[secret](source.md)").unwrap();
    symlink(&outside, fixture.root.join("symlink.md")).unwrap();
    fs::write(fixture.root.join("source.md"), identified("# Source")).unwrap();
    fixture.reconcile();
    assert!(complete(&fixture, "source.md", "").incoming.is_empty());
    assert!(
        fixture
            .vault
            .note_links("symlink.md", None, "", Default::default())
            .is_err()
    );
}

#[test]
fn note_links_only_mark_missing_with_complete_inventory() {
    let fixture = Fixture::new();
    fs::write(
        fixture.root.join("source.md"),
        identified("[missing](missing.md)"),
    )
    .unwrap();
    fixture.reconcile();
    fixture
        .vault
        .set_index_state(IndexState::Stale, Some("Pending changes".into()));
    let uncertain = complete(&fixture, "source.md", "");
    assert_eq!(
        serde_json::to_value(&uncertain.outgoing[0]).unwrap()["status"],
        "unindexed"
    );
    fixture.reconcile();
    let ready = complete(&fixture, "source.md", "");
    assert_eq!(
        serde_json::to_value(&ready.outgoing[0]).unwrap()["status"],
        "missing"
    );
    fs::write(
        fixture.root.join("missing.md"),
        identified("# Added externally"),
    )
    .unwrap();
    fixture.reconcile();
    let resolved = complete(&fixture, "source.md", "");
    assert_eq!(
        serde_json::to_value(&resolved.outgoing[0]).unwrap()["status"],
        "resolved"
    );
}

#[test]
fn note_link_lists_expand_independently_and_report_only_their_own_limits() {
    use crate::vault::indexing::NoteLinkLimits;
    let fixture = Fixture::new();
    fs::write(
        fixture.root.join("target.md"),
        identified(&"[out](source-000.md)\n".repeat(110)),
    )
    .unwrap();
    for index in 0..110 {
        fs::write(
            fixture.root.join(format!("source-{index:03}.md")),
            identified("[target](target.md)"),
        )
        .unwrap();
    }
    fixture.reconcile();
    let first = complete(&fixture, "target.md", "");
    assert_eq!(
        (
            first.incoming.len(),
            first.outgoing.len(),
            first.targets.len()
        ),
        (100, 100, 50)
    );
    assert_eq!(
        (
            first.incoming_has_more,
            first.outgoing_has_more,
            first.targets_has_more,
            first.references_truncated
        ),
        (true, true, true, false)
    );
    let incoming = fixture
        .vault
        .note_links(
            "target.md",
            None,
            "",
            NoteLinkLimits {
                incoming: 200,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(incoming.incoming.len(), 110);
    assert_eq!(
        (
            incoming.incoming_has_more,
            incoming.outgoing_has_more,
            incoming.targets_has_more
        ),
        (false, true, true)
    );
    let all = fixture
        .vault
        .note_links(
            "target.md",
            None,
            "",
            NoteLinkLimits {
                incoming: 200,
                outgoing: 200,
                targets: 150,
            },
        )
        .unwrap();
    assert_eq!(
        (all.incoming.len(), all.outgoing.len(), all.targets.len()),
        (110, 110, 110)
    );
    assert_eq!(
        (
            all.incoming_has_more,
            all.outgoing_has_more,
            all.targets_has_more
        ),
        (false, false, false)
    );

    let no_links = complete(&fixture, "source-109.md", "");
    assert_eq!(
        (
            no_links.incoming_has_more,
            no_links.outgoing_has_more,
            no_links.targets_has_more,
            no_links.references_truncated
        ),
        (false, false, true, false)
    );
}
