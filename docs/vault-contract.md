# Vault Contract

Status: approved product and storage contract. This document defines required behavior; it is not a claim that the behavior has been implemented. Formal schemas will be implemented in M1.

## Principles

- A Vault is an independent, portable directory.
- Ordinary files remain useful without Adamant.
- Authored content and relationships do not depend on an opaque database.
- An identity does not change when a file or work item is renamed.
- External edits are supported, not treated as corruption by default.
- Original documents and external-service records remain separate from user annotations.

## Domain vocabulary

| Term | Meaning |
| --- | --- |
| Vault | Independent directory with its own manifest, content, connections, and export boundary. |
| Note | Authored Markdown content with a stable identity. |
| Topic | A Note used to organize a subject of study. |
| Document | An original attachment, such as PDF or DOCX, with companion metadata. |
| DocumentationPage | A captured technical documentation page with its source recorded. |
| CalendarEvent | A locally stored iCalendar event. |
| ExternalItem | A GitHub or Jira Cloud item followed by the application. |
| Reference | An explicit association between identified elements. |

## Directory layout

```text
MyVault/
├── vault.json
├── notes/
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

Only `vault.json` is structurally required. Other directory names are initial conventions, not mandatory classifications. Users may reorganize directories and name their content in any language. Adamant must not automatically translate or rename existing content.

The manifest contains a format version and a Vault identifier, not a central inventory of all files. Machine-specific preferences, generated previews, search indexes, external caches, and credentials live outside the portable directory.

## Identity and authoritative storage

| Element | Identity | Authoritative representation |
| --- | --- | --- |
| Note | UUID in YAML frontmatter | Markdown file. |
| Topic | The underlying Note UUID | Markdown with `kind: topic`. |
| Document | UUID in companion metadata | Original plus `<filename>.meta.yaml`. |
| DocumentationPage | UUID in its Markdown frontmatter | Saved Markdown, source metadata, and local resources. |
| CalendarEvent | iCalendar `UID` | Event component in an `.ics` file. |
| ExternalItem | Provider, instance, and stable API identifier | External provider; locally authored references are portable, fetched records are cached. |

An individual occurrence of an imported recurring event is identified by `UID` and `RECURRENCE-ID`. Imported UIDs are preserved rather than replaced with UUIDs. See the [iCalendar identity specification](https://icalendar.org/iCalendar-RFC-5545/3-8-4-7-unique-identifier.html).

External URLs, Jira keys, titles, and statuses are useful attributes, not substitutes for stable identity. GitHub node IDs and Jira issue IDs must remain scoped to the corresponding service instance.

## Markdown metadata

Illustrative Note:

```markdown
---
id: "7f27ae62-a642-44ce-9da4-8b34a380f91c"
kind: topic
tags:
  - distributed-systems
refs:
  - kind: document
    id: "22edcb7d-c5b2-48a6-86e0-8459845837e5"
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

| Scenario | Required behavior |
| --- | --- |
| A script edits a Note while the user edits it in Adamant | Preserve both versions and expose conflict resolution; modification time alone cannot choose a winner. |
| A file temporarily has invalid YAML | Show the metadata error and retain access to the source text; do not destructively repair it. |
| Two Notes contain the same UUID | Report a collision rather than merge their content or relationships. |
| A Document is moved without its companion | Show an unresolved association and allow reassociation. |
| A referenced item is deleted | Keep the reference as unresolved; do not delete related Notes. |
| External synchronization fails | Keep the last available cache and display its freshness. |
| The index is removed | Reconstruct local authored relationships and search from the Vault. |
| A Vault is copied to another installation | Recover its content without the old database or credentials. |

## Isolation

Each Vault has independent connection configuration, cache, credential association, and export operations. There are no cross-Vault references in this stage. Corporate data must not appear in a personal Vault through shared search or background synchronization.

Open, AI-friendly storage does not grant agents or external services automatic access to corporate or personal content.
