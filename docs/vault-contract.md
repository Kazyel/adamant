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
| ProjectSpace      | A project context inside a Vault, with its own sources, view, and personal column flow. |
| LocalTask         | A user-authored task with priority, due date, checklist, and explicit links.            |
| Card              | An item's membership and personal position in one ProjectSpace, not its remote status.  |
| RemoteDraft       | An unsent comment or general review retained locally until explicit submission.         |

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

The manifest contains a format version and a Vault identifier, not a central inventory of all files. Machine-specific preferences, generated previews, search indexes, detailed external caches, and credentials live outside the portable directory. M2's followed-item summary snapshots accompany portable authored work context as described below; they do not become authoritative provider records.

### M1.1 workspace and recovery

File management uses native prepare/commit operations bound to the active Vault generation and source revisions. Rename/move preserves identities, remaps affected local links, and treats original documents and companions as one logical item. Independent duplication creates new identities; raw recovery copies retain their original source and identity. Occupied destinations are not silently overwritten.

Recoverable trash and transaction journals live in a verified, owned `.adamant/` namespace inside the portable Vault container. They are authoritative recovery content, unlike disposable indexes. Recovery reports completed mappings and retained versions; it does not promise a globally atomic filesystem transaction. Permanent deletion requires explicit scope confirmation.

Open documents have independent buffers, editor histories, positions, and view state. Hiding the tab bar retains documents in the current session but disables saving and reopening document tabs across restarts, including the last standalone file. Navigation and Vault draft recovery remain independent and persisted. Quick Open includes session documents, standalone files, and unsaved drafts; next/previous document commands activate the same retained sessions. Restored documents hydrate before activation. Document editing/closing actions are scoped to the workbench, while history navigation brings that view forward. Source saving remains explicit. Unsaved-draft snapshots and workspace restoration are local recovery state scoped to the canonical root and Vault identity; they do not overwrite externally changed sources automatically. Invalid local workspace/draft records can be explicitly preserved as sibling `.preserved-<UUID>` files before local persistence resumes.

Content search covers saved Markdown and extracted PDF/DOCX text. It is incremental and bounded, with up to 50 hits per page and 500 hits per query; queries are limited to 4,096 bytes. Pending coverage is distinguished from exhausted partial coverage. Continuation pages require the first page's inventory generation and completed source coverage; stale pages restart rather than mixing generations. Markdown results retain source lines and columns. Binary results contain excerpts and verified source identity. PDF extraction retains page boundaries, and each hit carries its one-based page and the source's SHA-256 revision. Navigation verifies the opened bytes against that revision before applying the page position. A stale result requires a new search. DOCX hits open the original without an exact page position.

Search accepts tag, folder, and file-type filters before counting or paging results. Tags use exact, case-sensitive AND matching. File types use OR matching across Markdown, PDF, and DOCX; an empty list includes every supported type. A folder includes itself and descendants separated by `/`, so `notes` does not match `notes-other`. An empty or absent folder covers the Vault. Filters can be used without a text query. Search and graph use the same filter meanings; neither changes source documents.

Markdown body text has a 256 MiB in-memory cache. PDF/DOCX extracted text has a separate 64 MiB cache. Known changed paths invalidate their own cached bodies, parsed references, and failed-source records; unchanged identities retain their cached text. Full reconciliation clears both caches. Removing cached files releases capacity and permits capacity-omitted sources or references to be considered again. Caches remain disposable and never replace original source files or authored relationships.

PDF/DOCX extraction accepts sources up to 16 MiB and output text up to 8 MiB. PDFs are limited to 256 pages; DOCX reads only `word/document.xml`, including body paragraphs and tables. External relationships, embedded resources, and scripts are not loaded. OCR and encrypted PDF extraction are not included. Unreadable files, missing text, and extraction/source/cache limits report partial coverage. The two-second extraction budget and cancellation are cooperative checks between parser operations, not hard deadlines within a parser call. PDF loading bounds each decoded object/cross-reference stream to 8 MiB; page extraction bounds decoded page content. These are per-operation limits, not a global bound on parser memory. Parsing runs outside the cache mutex; publication rechecks the cache epoch and original identity/metadata so invalidated work cannot restore stale text.

Preferences, navigation history, favorites, and document positions remain machine-local state outside portable authored content.

### M2 project workspace

`.adamant/work-context.json` stores versioned project spaces, local tasks, followed-item summary snapshots, per-space memberships and column order, saved views, explicit links, and unsent comment/review drafts. Remote identity and content are shared across spaces; membership order and personal progress are not. Moving a card never writes to GitHub or Jira. Note links are Vault-content-relative paths; external links are credential-free HTTP(S) URLs. These work-context links are not currently included in Markdown link rewriting during file moves.

Work-context saves are automatic and serialized, unlike explicit Markdown source saves. Native commands bind both the selected canonical root and Vault UUID, validate the complete bounded record, and reject stale revisions. Frontend sessions also distinguish root plus UUID, so two copied Vaults with the same portable identity do not share live edits. App/Vault transitions wait for writes and are blocked by unresolved save failures or pending remote mutations.

The record is limited to 32 MiB, 10,000 items, 128 spaces, 64 columns per space, 256 sources per space, and 1,000 drafts. Descriptions and draft bodies are bounded to 512 KiB; provider limits can be smaller. The administration ownership marker and capability-confined I/O reject file/directory symlink escapes. A kernel lock coordinates cooperating work-context writers; external editors must preserve the schema and advance the revision when changing the record. Changes detected during replacement retain recovery bytes rather than silently discarding them.

Creation uses exclusive hard-link installation; replacement uses the existing Linux/macOS atomic-exchange primitive. Unsupported platforms/filesystems refuse safely rather than fall back to unsafe overwrite. `.adamant-write-work-*` staging files retained after an error or interrupted write are manual recovery material, not automatically recovered mutation journals. Existing hard-link aliases are not updated by replacing the canonical work-context file.

Connections are machine-local: `connections/accounts.json` beneath application-local data stores account metadata (including Jira account email); tokens remain exclusively in the OS keyring. Reconnecting replaces the account's token without putting credentials in browser storage or the Vault. `connections/details.json` retains at most 16 recent detailed snapshots, each at most 2 MiB, partitioned by account and remote target. Thus saved summary context remains portable, while offline discussions/diffs depend on this bounded machine-local cache. Evicted or never-fetched details require a live refresh.

Remote reads report stale/partial results, authentication failures, denied permissions, and rate limits. Cached detail cannot authorize a write. Every mutation validates the expected immutable item identity against the provider; reviews and merge also require the inspected head SHA. Ordinary comments/field edits have explicit Send/Save controls; approval, change requests, state changes, and merge require target/effect confirmation. Provider permissions, required checks, and workflow validators remain authoritative. Jira transitions requiring additional fields report the provider's validation error; those fields must be supplied in Jira.

No remote write is automatically retried or queued for reconnect. An ambiguous network failure retains the draft and instructs the user to inspect the provider before retrying. Background refresh never submits drafts or changes personal columns.

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

### Tags and note templates

`tags` is a string array in Markdown frontmatter or PDF/DOCX companion metadata. Tags preserve case and match exactly. Tag writes accept at most 64 tags, each containing 1–128 UTF-8 bytes. Empty values, control characters, and surrounding whitespace are rejected. Repeated values are deduplicated while preserving order. Reads return existing lists in full, including lists beyond the write limit.

Tag edits require a verified document identity and the current source revision. Markdown must already have valid identity metadata; tag editing never adopts a note implicitly. A tag edit changes only the metadata sequence and preserves unrelated fields, comments, the body, BOM, and line endings. Aliases and other layouts that cannot be changed safely require an explicit source edit. Dirty or conflicted Markdown buffers block tag editing. Source saves and tag changes use the existing conflict and recovery checks.

PDF/DOCX tags use the companion metadata without changing original bytes or annotation links. The first explicit, nonempty tag save creates a companion UUID when none exists; the returned identity replaces the prior file identity in the workspace. Saving an empty list without a companion creates nothing. Companion writes retain the existing bounded, revision-checked publication and recovery behavior.

Tag suggestions derive from indexed metadata and return up to 100 matches for the current suggestion query. Folder suggestions derive from the bounded directory inventory. Responses expose truncation and indexing state; an incomplete inventory does not imply a complete catalog. Graph nodes include derived tags, but those tags are not persisted in `graph.json`.

The Explorer's inline New Note form offers Blank note, Technical decision, Meeting, and Study templates. Templates supply ordinary Markdown body text and do not carry an authored identity. Normal native note creation assigns a fresh UUID. Users can edit or remove every supplied section; no template or learning heading is required.

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

The Markdown backlinks panel derives note-to-note links from saved Markdown bodies, including reference-style links. Code, image destinations, external URLs, and fragment-only links do not participate. It shows incoming excerpts with source positions and outgoing destinations. A missing destination is distinguished from one not yet resolved by an incomplete inventory. Unsaved editor buffers do not replace the saved source in this derived index. File watcher changes invalidate affected cached notes, and rebuilding requires no authored-data migration. Refreshing the same note keeps the displayed snapshot and focused reference mounted while a replacement loads; failure preserves the last snapshot. Changing Vault, note identity, or picker query does not reuse another source's results. Each mounted panel serializes requests and skips superseded queued queries. Structured metadata references and manual graph connections are not included in this panel.

Reference analysis uses the existing bounded body-index batches. It parses up to 1 MiB per note and retains up to 256 links per note and 25,000 links per Vault. Initial display limits are 100 incoming references, 100 outgoing references, and 50 search targets. Each list expands independently as a growing window, capped at 25,000 references per direction and 50,000 targets; every response replaces the snapshot atomically. The `incomingHasMore`, `outgoingHasMore`, and `targetsHasMore` flags describe display continuation. `referencesTruncated` and partial coverage describe analysis omissions separately. Large notes remain editable and their original bytes are unchanged.

Structured `refs` live in Markdown metadata or document companion metadata. Interactive graph connections and node positions instead live in `.adamant/graph.json`, without changing the documents or their metadata. Both representations are portable authored content; neither depends on SQLite. Missing targets from external changes remain visible as unresolved references.

Trash operations through Adamant remove supported local Markdown links and structured UUID references to deleted items from surviving notes and document companions. Markdown labels retain their original content and formatting. External URLs, code examples, unrelated metadata, and PDF/DOCX original bytes remain unchanged. UUID references are removed only when no surviving file owns that identity. Local note links on work cards are removed through the existing revision-checked work-state save, preserving pending task edits and remote drafts.

Preflight lists changed referrers in `affectedPaths` and checks scanned source revisions before deletion. Open edited referrers require the existing save-or-discard guard. The mutation journal stages original and updated bytes and retains versions for explicit recovery after failure. Partial batches remove references only to completed deletions, including references in selected files that remain live. Recovery verifies recorded cleanup changes before resuming those files and preserves their original Trash payloads. Unsupported source layouts or unsafe metadata reject preparation instead of rewriting them. Restoring deleted originals does not recreate references already removed from surviving files. External deletion never implicitly rewrites surviving authored files.

### Interactive document graph

The [document graph contract](graph-contract.md) and [graph schema](../schemas/graph.schema.json) define the versioned JSON record, file resolution, limits, and external-writer protocol. Graph reads include Markdown, PDF, and DOCX files without adopting them. Graph writes save only manual connections and coordinates in the owned `.adamant/` directory. Saved Markdown links appear as a separate derived projection, deduplicated with manual connections only for rendering. They are not persisted in `graph.json`; their source notes remain authoritative. Existing document annotations remain a separate `refs` workflow and are not imported into the graph.

Existing unique file UUIDs resolve moves. Files without UUIDs bind by their content-root-relative paths; their graph paths are not currently rewritten during moves or renames. Once a ready inventory confirms absence, graph reads remove missing nodes and incident connections from the displayed graph. Incomplete inventory preserves unseen nodes. Reads retain the saved graph record, so restoring a file can recover its positions and manual connections before a later save persists pruning. Graph undo cannot recreate connections to absent files.

The local graph projects the neighborhood of a fixed center at depth one or two, using both manual and resolved Markdown connections. Enabling it chooses the selected resolved file, falling back to the active Vault document. Selecting another node does not move the center; recentering is explicit. Tag, folder, and type filters apply to the graph view with the same meanings as search. Local scope and filters are transient view state and never rewrite graph nodes, edges, or coordinates.

Graph saves use expected revisions and the owned marker lock. External writers must advance the revision and exclude concurrent writes; replacing JSON atomically is not a substitute for that coordination. The record and retained recovery versions are authoritative Vault content, not disposable index data.

## Documents and technical documentation

PDF and DOCX originals are never replaced by converted representations. Companion metadata stores identity, optional title, tags, and references to annotation Notes. Generated previews and extracted text are disposable derivatives.

Reading an original does not require a `<filename>.meta.yaml` companion. Its absence means there is no authored UUID or relationship metadata, not a Vault issue. Opening and indexing never create a companion implicitly. Existing invalid or unreadable companions and orphaned associations remain visible as issues.

Moving a Document through Adamant moves its companion metadata as well. Moving only the original externally may require explicit reassociation; filenames alone are not sufficient evidence to guess identity.

Document annotations use `refs` entries with `kind: note` and the Note UUID in the companion. The first explicit association creates a companion if none exists. Creating an annotation creates an ordinary Markdown Note; linking an existing Note requires valid metadata and an unambiguous identity. The Note's source-document list is derived from these references, without writing a second association into the Note. Unlinking preserves both files. Links cover the whole document, without page or selection anchors.

Annotation changes check the original's identity and the companion's revision. They preserve unrelated metadata fields and source spelling, rejecting YAML layouts that cannot be safely edited. Missing and duplicate targets remain unresolved. Reads report incomplete inventory coverage and return at most 100 matching links and 50 candidate Notes, with explicit truncation flags and filtering by path or linked UUID. Linking an existing Note requires a ready inventory; generated-UUID annotation creation and revision-checked unlinking remain available with incomplete indexing. Source-document resolution rejects known duplicate Note identities. Topics and captured documentation pages are not offered as annotation Notes. If creating a Note succeeds but linking fails, the error identifies the retained Note for explicit relinking. No automatic retry deletes or recreates it.

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
| A referenced item is deleted through Adamant             | Remove its links and UUID references from surviving content, preserving labels and related Notes.      |
| A referenced item is removed externally                  | Keep authored references unresolved; do not rewrite or delete related Notes implicitly.                |
| External synchronization fails                           | Keep the last available cache and display its freshness.                                               |
| The index is removed                                     | Reconstruct local authored relationships and search from the Vault.                                    |
| A Vault is copied to another installation                | Recover its content without the old database or credentials.                                           |

## Isolation

Each Vault has independent connection configuration, cache, credential association, and export operations. There are no cross-Vault references in this stage. Corporate data must not appear in a personal Vault through shared search or background synchronization.

Open, AI-friendly storage does not grant agents or external services automatic access to corporate or personal content.
