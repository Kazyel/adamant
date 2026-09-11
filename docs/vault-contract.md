# Vault Contract

Status: approved product and storage contract. M1 schemas are present in [`schemas/vault.schema.json`](../schemas/vault.schema.json), [`schemas/note.schema.json`](../schemas/note.schema.json), and [`schemas/document.schema.json`](../schemas/document.schema.json); this document remains the behavioral contract, not a claim of universal platform support.

The Adamant manifest is the identity marker for this format: `vault.json` must contain the exact marker `format: "adamant-vault"`, `formatVersion: 1`, and a UUID `id`. Unknown manifest fields are allowed, but a missing format marker or a different marker means the folder is not an Adamant Vault and must be rejected rather than adopted.

## Principles

- A Vault is an independent, portable directory.
- Ordinary files remain useful without Adamant.
- Authored content and relationships do not depend on an opaque database.
- An identity does not change when a file or work item is renamed.
- External edits are supported, not treated as corruption by default.
- Original documents and external-service records remain separate from user annotations.

## Domain vocabulary

| Term              | Meaning                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------- |
| Vault             | Independent directory with its own manifest, content, connections, and export boundary. |
| Note              | Authored Markdown content with a stable identity.                                       |
| Topic             | A Note used to organize a subject of study.                                             |
| Document          | An original attachment, such as PDF or DOCX, with optional companion metadata.          |
| DocumentationPage | A captured technical documentation page with its source recorded.                       |
| CalendarEvent     | A locally stored iCalendar event.                                                       |
| ExternalItem      | A GitHub or Jira Cloud item followed by the application.                                |
| Reference         | An explicit association between identified elements.                                    |

## Directory layout

```text
MyVault/
├── vault.json
└── content/
    ├── studies/
    │   ├── mathematics/
    │   └── distributed-systems/
    ├── documents/
    │   ├── paper.pdf
    │   ├── paper.pdf.meta.yaml
    │   ├── specification.docx
    │   └── specification.docx.meta.yaml
    ├── documentation/
    └── calendars/
        └── personal.ics
```

New Vaults declare `"contentRoot": "content"` in `vault.json` and create an empty `content/` directory. This directory is the entry point for content, not a folder shown in the explorer: listing, note creation, imports, and relative document paths start inside it. The example subdirectories above are user-organized content, not automatically created defaults.

Existing manifests without `contentRoot` keep their original container-relative layout, including ordinary folders named `notes` or `content`. No files are moved, renamed, or migrated. When declared, `contentRoot` must be exactly `"content"` and refer to an existing real directory, not a symlink. The manifest remains in the Vault container; its siblings outside `content/` are not indexed as content. Changing the declared root while open requires reopening the Vault.

### Supported document boundary

The document loader accepts only `.md`, `.pdf`, and `.docx` filenames, case-insensitively. `.markdown` is not an Adamant document extension. `vault.json` and document companion metadata (`<filename>.meta.yaml`) are internal metadata, not editable documents and are never opened as Markdown/PDF/DOCX content.

Creating a Vault requires explicit selection of a parent folder and a name for one new child directory. The parent may contain files; an existing destination is refused even when empty. Opening an existing folder requires a valid Adamant marker and version; discovery classifies supported extensions and validates metadata without rewriting or adopting files.

### Native creation and local synchronization

Creation is a two-step capability flow: `vault_select_parent` selects a parent directory without filesystem mutation. The interface previews the full destination before `vault_create` validates a single child name and creates that child exclusively through the selected directory capability. The destination must not already exist, even when empty. Parent contents are not adopted or scanned as part of creation; an existing Vault is opened through `vault_open`. Headless core callers use `VaultParent::select(parent)?.create(name, state_root)` and `Vault::open(root, state_root)`.

The interface keeps creation and opening in the persistent Adamant menu, with New Note and Import actions contextual to the active Vault. Filesystem watching updates clean buffers and expanded listings automatically. Partial or stale index states remain recoverable through compact problem details; healthy operation does not expose indexing controls or per-folder statistics. Ctrl+S/⌘S is the explicit persistence boundary. There is no autosave or cloud synchronization in M1.

The last successfully activated Vault is a machine-local preference: `last-vault.json` under Tauri's `app_local_data_dir()` contains its canonical container path and manifest UUID. Startup `vault_restore` accepts no frontend path, verifies that identity, and reuses normal session activation and indexing. A private, synced temporary record is atomically renamed at the generation-checked authority handoff; unsuccessful or superseded selections cannot replace the previous choice. This supports normal process restarts, not a stronger power-loss durability guarantee. Explicit Close Vault clears the preference, while exiting the application preserves it. Missing preferences are an ordinary empty startup; unavailable or replaced Vaults produce a notice without changing source files. Restoration blocks startup navigation and editing until settled, never replaces unsaved source, and returns an already-active session on webview reload rather than reactivating it.

### Incremental index boundary

Indexing is a derived, bounded, cancellable, incremental operation. It must expose `state` (`indexing`, `ready`, `partial`, `stale`, or `cancelled`), scanned-entry and indexed-document counts, and an optional message. `ready` means the scan is complete with no queued changes; partial, stale, and cancelled states remain visible and never imply a complete inventory. Directory listing is paged (default 100, maximum 200) with `offset`, `total`, and `hasMore`; collapsed directories are not loaded. Cancellation signals independently of save/navigation work and returns the current snapshot immediately. The source files remain authoritative throughout indexing.

#### M1 resource budgets

Implemented M1 limits. The five-second work budget is cooperative, not a preemptive filesystem I/O deadline:

| Resource                                   |                                                Budget |
| ------------------------------------------ | ----------------------------------------------------: |
| Examined directory entries                 |                                                50,000 |
| Watched directories                        |                                                 2,048 |
| Directory depth                            |                                                    32 |
| Aggregate metadata                         |                                                32 MiB |
| Manifest                                   |                                               256 KiB |
| One frontmatter or companion record        |                                               256 KiB |
| Cooperative work budget per reconciliation |                                                   5 s |
| Listing page                               |                              100 default, 200 maximum |
| Surfaced issues                            | First 200, with full count; maximum 1 KiB per message |
| Event queue                                |                                                   256 |
| Changed-path batch                         |                                                 1,024 |

Discovery excludes `.git`, `.hg`, `.svn`, `node_modules`, `target`, `dist`, `build`, `.next`, `.cache`, `.generated`, `.venv`, `venv`, and `__pycache__`. It must not read or hash unsupported originals during discovery: only Markdown headers and associated document metadata are examined.

Traversal limits (entries, watched directories, depth, metadata) produce explicit `partial` state; partial never claims a complete inventory or infers deletion from unseen entries. A watcher queue overflow produces `stale` state and bounded reconciliation. Page limits bound each request. Imports with supplied IDs refuse an incomplete index, while ordinary reads, same-ID saves, generated-UUID creation, and recovery copies remain available.

The manifest contains a format version and a Vault identifier, not a central inventory of all files. Machine-specific preferences, generated previews, search indexes, external caches, and credentials live outside the portable directory.

### M1.1 workspace and recovery

File management uses native prepare/commit operations bound to the active Vault generation and source revisions. Rename/move preserves identities, remaps affected local links, and treats original documents and companions as one logical item. Independent duplication creates new identities; raw recovery copies retain their original source and identity. Occupied destinations are not silently overwritten.

Recoverable trash and transaction journals live in a verified, owned `.adamant/` namespace inside the portable Vault container. They are authoritative recovery content, unlike disposable indexes. Recovery reports completed mappings and retained versions; it does not promise a globally atomic filesystem transaction. Permanent deletion requires explicit scope confirmation.

Open documents have independent buffers, editor histories, positions, and view state. Source saving remains explicit. Unsaved-draft snapshots and workspace restoration are local recovery state scoped to the canonical root and Vault identity; they do not overwrite externally changed sources automatically. Invalid local workspace/draft records can be explicitly preserved as sibling `.preserved-<UUID>` files before local persistence resumes.

Markdown content search is incremental, cancellable, and bounded. Pending coverage is distinguished from exhausted partial coverage; stale inventory pages restart rather than silently mix generations. Preferences, navigation history, favorites, and document positions remain machine-local state outside portable authored content.

## Identity and authoritative storage

| Element           | Identity                                      | Authoritative representation                                                             |
| ----------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Note              | UUID in YAML frontmatter                      | Markdown file.                                                                           |
| Topic             | The underlying Note UUID                      | Markdown with `kind: topic`.                                                             |
| Document          | UUID in companion metadata                    | Original plus `<filename>.meta.yaml`.                                                    |
| DocumentationPage | UUID in its Markdown frontmatter              | Saved Markdown, source metadata, and local resources.                                    |
| CalendarEvent     | iCalendar `UID`                               | Event component in an `.ics` file.                                                       |
| ExternalItem      | Provider, instance, and stable API identifier | External provider; locally authored references are portable, fetched records are cached. |

An individual occurrence of an imported recurring event is identified by `UID` and `RECURRENCE-ID`. Imported UIDs are preserved rather than replaced with UUIDs. See the [iCalendar identity specification](https://icalendar.org/iCalendar-RFC-5545/3-8-4-7-unique-identifier.html).

External URLs, Jira keys, titles, and statuses are useful attributes, not substitutes for stable identity. GitHub node IDs and Jira issue IDs must remain scoped to the corresponding service instance.

## Markdown metadata

For validated Vault Notes, the editor and reading preview hide the YAML frontmatter, including `id` and `kind`. Editing operates on the body; saving retains the metadata prefix verbatim, including BOM and original line endings. A closing delimiter at EOF gains a matching newline only when a body is added. Unvalidated, changed, or unclosed frontmatter remains visible for correction. Selecting all editable text cannot remove a hidden metadata header.

Illustrative Note:

```markdown
---
id: '7f27ae62-a642-44ce-9da4-8b34a380f91c'
kind: topic
tags:
  - distributed-systems
refs:
  - kind: document
    id: '22edcb7d-c5b2-48a6-86e0-8459845837e5'
---

# Eventual consistency

## Learning goals

When can a read return an older value?

## Experiment

Compare two replicas with propagation delay.

## Next step

Record behavior during a network partition.
```

- `id` is stable.
- `kind` distinguishes ordinary notes, topics, and saved references.
- `tags` and `refs` are optional.
- Unknown metadata fields must survive edits made by Adamant.
- Markdown content, language, and section names remain unrestricted.
- Learning sections are optional templates, not mandatory forms.

Formal schema work must preserve these decisions rather than silently introduce a second storage convention.

## References and ordinary links

Structured `refs` allow the application to understand associations to Notes, Documents, CalendarEvents, and ExternalItems. External references preserve provider, instance, stable identifier, and an opening URL.

Ordinary relative Markdown links remain supported:

```markdown
See the [replication experiment](../notes/replication-experiment.md).
```

The two mechanisms have different guarantees:

- Identity-based references survive path changes when the identified content remains available.
- Relative links remain readable in other Markdown tools but can break after external moves.
- Moves performed through Adamant update affected local links.
- External moves trigger reconciliation and broken-link reporting, not speculative rewrites.
- Backlinks are derived from forward references; there is no second authoritative backlink file.

Explicit authored relationships live in Markdown metadata or document companion metadata, not only in SQLite. Missing targets remain visible as unresolved references.

## Documents and technical documentation

PDF and DOCX originals are never replaced by converted representations. Companion metadata stores identity, optional title, and references to annotation Notes. Generated previews and extracted text are disposable derivatives.

Reading an original does not require a `<filename>.meta.yaml` companion. Its absence means there is no authored UUID or relationship metadata, not a Vault issue. Opening and indexing never create a companion implicitly. Existing invalid or unreadable companions and orphaned associations remain visible as issues.

Moving a Document through Adamant moves its companion metadata as well. Moving only the original externally may require explicit reassociation; filenames alone are not sufficient evidence to guess identity.

Saved technical documentation contains:

- Readable Markdown content.
- Original source URL and capture date.
- Necessary captured resources, such as images, stored locally.
- Explicit indication of resources that were not saved and still require network access.

A capture is a reading representation, not a promise to reproduce website JavaScript, authentication flows, or every interactive feature.

## Calendar and priorities

Local events use iCalendar. Import/export must preserve identities, time zones, and supported recurrence semantics. Unknown fields must be preserved; imported constructs that cannot be edited safely must be identified rather than silently flattened or discarded.

Associations between study context and events are portable references, not database-only state. User-selected priorities and resumption context must likewise be represented in portable authored content. Transient window layout is machine-specific application state.

Google Calendar synchronization is outside this stage; local calendar creation remains required.

## Opening, importing, and exporting

### Open a Vault

Validate the manifest format and rebuild indexes when needed. Local content does not require external-service credentials. Merely discovering a file must not cause the application to rewrite it.

### Import individual files

Import is an explicit adoption operation. Preserve original documents and Markdown bodies; create the necessary identity metadata without converting authored content to a proprietary format.

On identity collisions:

- Identical content is not duplicated.
- Different content is presented as a conflict, never silently substituted.

### Export a complete Vault

Copy or archive the directory, preserving IDs, originals, companions, references, resources, and calendars. Export must not present a partially inconsistent snapshot as complete.

Credentials and external caches are excluded by default. A new installation reconstructs indexes and authenticates separately with GitHub and Jira. Notes and external references remain available even before authentication.

Import must not write outside its destination through archive paths or follow filesystem links into unrelated content.

## Integrity requirements

| Scenario                                                 | Required behavior                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A script edits a Note while the user edits it in Adamant | Preserve both versions and expose conflict resolution; modification time alone cannot choose a winner. |
| A file temporarily has invalid YAML                      | Show the metadata error and retain access to the source text; do not destructively repair it.          |
| Two Notes contain the same UUID                          | Report a collision rather than merge their content or relationships.                                   |
| A Document is moved without its companion                | Show an unresolved association and allow reassociation.                                                |
| A referenced item is deleted                             | Keep the reference as unresolved; do not delete related Notes.                                         |
| External synchronization fails                           | Keep the last available cache and display its freshness.                                               |
| The index is removed                                     | Reconstruct local authored relationships and search from the Vault.                                    |
| A Vault is copied to another installation                | Recover its content without the old database or credentials.                                           |

## Isolation

Each Vault has independent connection configuration, cache, credential association, and export operations. There are no cross-Vault references in this stage. Corporate data must not appear in a personal Vault through shared search or background synchronization.

Open, AI-friendly storage does not grant agents or external services automatic access to corporate or personal content.
