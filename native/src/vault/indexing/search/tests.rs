use super::{BodyDocument, BodyIndex, Inventory, links};
use crate::vault::{VaultEntry, indexing::IndexedEntry};

fn row(path: &str) -> IndexedEntry {
    IndexedEntry {
        entry: VaultEntry {
            path: path.into(),
            kind: "markdown",
            id: None,
            metadata_error: None,
            modified_at: None,
        },
        identity: Some(format!("file:{path}")),
        metadata: None,
        references: Vec::new(),
        epoch: 1,
    }
}

fn body(path: &str, text: &str, remaining_links: usize) -> BodyDocument {
    BodyDocument {
        kind: "markdown",
        text: text.into(),
        pages: Vec::new(),
        revision: "revision".into(),
        id: None,
        identity: format!("file:{path}"),
        links: links::parse_note_links(path, text, remaining_links),
    }
}

#[test]
fn freed_cache_capacity_requeues_omissions_and_truncated_references() {
    for explicit_invalidation in [true, false] {
        let mut inventory = Inventory::new();
        for path in [
            "removed.md",
            "omitted.md",
            "truncated.md",
            "stable.md",
            "broken.md",
        ] {
            assert!(inventory.put(row(path)));
        }
        let mut cache = BodyIndex::new();
        cache
            .documents
            .insert("removed.md".into(), body("removed.md", "removed", 256));
        cache
            .documents
            .insert("stable.md".into(), body("stable.md", "unchanged", 256));
        cache.documents.insert(
            "truncated.md".into(),
            body("truncated.md", "[target](stable.md)", 0),
        );
        // Simulate exhausted cache capacity without allocating hundreds of MiB.
        cache
            .omitted
            .insert("omitted.md".into(), (Some("file:omitted.md".into()), true));
        cache
            .omitted
            .insert("broken.md".into(), (Some("file:broken.md".into()), false));
        cache.sync(&inventory);
        assert!(!cache.can_continue());
        assert!(cache.documents["truncated.md"].links.truncated);

        if explicit_invalidation {
            cache.invalidate_path("removed.md");
        }
        inventory.remove("removed.md");
        cache.sync(&inventory);

        assert_eq!(
            cache
                .order
                .iter()
                .map(|(path, _)| path.as_str())
                .collect::<Vec<_>>(),
            vec!["omitted.md", "truncated.md"]
        );
        assert!(cache.can_continue());
        assert_eq!(cache.documents.len(), 1);
        assert_eq!(cache.documents["stable.md"].text, "unchanged");
        assert_eq!(cache.bytes, "unchanged".len());
        assert_eq!(cache.link_count, 0);
        assert!(!cache.omitted.contains_key("omitted.md"));
        assert!(cache.omitted.contains_key("broken.md"));
    }
}

#[test]
fn extraction_epoch_survives_reads_but_changes_on_invalidation_or_new_inventory() {
    let mut inventory = Inventory::new();
    assert!(inventory.put(row("note.md")));
    let mut cache = BodyIndex::for_documents();
    cache.sync(&inventory);
    cache.extracting = true;
    let extraction_epoch = cache.epoch;

    cache.sync(&inventory);
    assert_eq!((cache.epoch, cache.extracting), (extraction_epoch, true));

    // Invalidations reject the old result without releasing the running parser's slot.
    cache.invalidate_path("note.md");
    assert_ne!(cache.epoch, extraction_epoch);
    assert_eq!((cache.valid, cache.extracting), (false, true));

    cache.sync(&inventory);
    let extraction_epoch = cache.epoch;
    assert!(inventory.put(row("other.md")));
    cache.sync(&inventory);
    assert_ne!(cache.epoch, extraction_epoch);
    assert!(cache.extracting);

    let extraction_epoch = cache.epoch;
    cache.invalidate();
    assert_ne!(cache.epoch, extraction_epoch);
    assert_eq!(
        (
            cache.extracting,
            cache.valid,
            cache.documents.len(),
            cache.omitted.len()
        ),
        (true, false, 0, 0)
    );
}
