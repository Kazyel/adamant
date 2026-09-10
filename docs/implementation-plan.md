# Implementation Plan

Status: approved roadmap and revised technology baseline. M0 was approved by the owner on September 6, 2026; M1 is implemented and Linux-verified with focused native/frontend evidence. The executable build and Linux tmpfs/btrfs source-write smoke are verified; M2–M7 remain planned, with other operating systems and installers unverified.

## Delivery strategy

Build complete user workflows rather than disconnected infrastructure. Early milestones are usable increments, not permission to omit GitHub, Jira Cloud, Markdown, PDF, DOCX, technical documentation, the knowledge library, or the local calendar from the complete application.

Tauri 2, TypeScript, Rust, local-first storage, and the [Vault contract](vault-contract.md) are fixed architectural decisions. The application remains a single desktop product without a mandatory backend.

## Reviewed technology baseline

Snapshot: 2026-09-05. Versions were checked against upstream releases, npm, and crates.io; star counts were fetched from the GitHub API. Popularity is used among suitable alternatives, not as evidence of performance or compatibility. Recheck stable releases when implementation begins and lock the compatible dependency graph.

Markdown editor update: the owner subsequently selected CodeMirror 6 instead of Monaco. Its modular packages are pinned in `package.json` and `bun.lock`; the editor row below reflects that decision rather than the original popularity snapshot.

| Role                  | Technology                                                       | Stable version at review    | GitHub stars |
| --------------------- | ---------------------------------------------------------------- | --------------------------- | -----------: |
| Desktop               | [Tauri](https://github.com/tauri-apps/tauri)                     | Rust crate `2.11.5`         |       110826 |
| Frontend language     | [TypeScript](https://github.com/microsoft/TypeScript)            | `7.0.2`                     |       110904 |
| UI                    | [React](https://github.com/react/react)                          | `19.2.8`                    |       249105 |
| Build tooling         | [Vite](https://github.com/vitejs/vite)                           | `8.2.2`                     |        82694 |
| Markdown editor       | [CodeMirror 6](https://codemirror.net/)                          | `state 6.7.4; view 6.43.11` |            — |
| Markdown parsing      | [Marked](https://github.com/markedjs/marked)                     | `18.0.11`                   |        37120 |
| HTML sanitization     | [DOMPurify](https://github.com/cure53/DOMPurify)                 | `3.4.14`                    |        17358 |
| PDF viewing           | [PDF.js](https://github.com/mozilla/pdf.js)                      | `pdfjs-dist 6.3.289`        |        53836 |
| DOCX viewing          | [docx-preview](https://github.com/VolodymyrBaydalka/docxjs)      | `0.4.0`                     |         2079 |
| Calendar UI           | [FullCalendar](https://github.com/fullcalendar/fullcalendar)     | `@fullcalendar/react 7.1.0` |        20630 |
| iCalendar parsing     | [ical.js](https://github.com/kewisch/ical.js)                    | `2.2.1`                     |         1177 |
| SQLite access         | [SQLx](https://github.com/transact-rs/sqlx)                      | `0.9.0`                     |        17449 |
| OS credential storage | [keyring](https://github.com/open-source-cooperative/keyring-rs) | `4.2.0`                     |          765 |
| HTTP client           | [reqwest](https://github.com/seanmonstar/reqwest)                | `0.13.4`                    |        11811 |
| Serialization         | [Serde](https://github.com/serde-rs/serde)                       | `1.0.229`                   |        10800 |
| JSON                  | [serde_json](https://github.com/serde-rs/json)                   | `1.0.151`                   |         5635 |
| Filesystem watching   | [notify](https://github.com/notify-rs/notify)                    | `8.2.0`                     |         3447 |

Toolchain baseline:

- [Rust 1.98.1](https://github.com/rust-lang/rust/releases/tag/1.98.1).
- [Node.js 26.8.1](https://nodejs.org/dist/index.json), Current rather than LTS. Node is development tooling, not an embedded application runtime.
- Tauri npm packages have independent versions: [`@tauri-apps/api 2.11.1`](https://registry.npmjs.org/@tauri-apps%2fapi/2.11.1) and [`@tauri-apps/cli 2.11.4`](https://registry.npmjs.org/@tauri-apps%2fcli/2.11.4).
- TypeScript 7.0.2 is stable, not the former native preview. Do not substitute nightly or preview packages.
- notify 9 was a release candidate at review; use the stable 8.2.0 line rather than automatically choosing the highest-looking version.

### Selection decisions and constraints

**CodeMirror 6 replaces Monaco (owner decision):** use the modular editor directly, without a React wrapper or editor worker. Load Markdown editing on demand and retain the separate Marked/DOMPurify preview. CodeMirror owns selection, changes, and undo/redo; a persistent newline map recorded in its native history retains the original BOM and mixed line endings. Validated metadata stays outside the editable document. External document replacement remounts the editor instead of injecting non-history edits. Native history retains at least 200 edit groups; regression coverage exercises 140 groups and abandoned redo branches.

**Migration verification:** the four source-preservation tests now exercise actual CodeMirror transactions and history, including grouped newline edits, simultaneous unequal ranges, whole-body replacement, and frontmatter delimiters at EOF. A browser-mounted React smoke exercised text insertion/Unicode, select-all/undo/redo key bindings, current callbacks, read-only blocking, search, and StrictMode/remount cleanup. This is functional evidence, not visual acceptance or a new cross-platform claim.

**Marked plus DOMPurify:** Marked has more stars than the compared markdown-it and react-markdown repositories. [Marked does not sanitize its output](https://marked.js.org/). Sanitize previews and enforce a separate local-resource/URL policy. Preview rendering must not rewrite the authoritative source.

**SQLx without an ORM:** use explicit SQL and only the SQLite/runtime features needed. Avoid enabling unrelated database backends and query macros by default. SQLx 0.9.0 requires Rust 1.94.0 or newer. The [SQLite upstream version](https://sqlite.org/download.html) was 3.53.4 at review, but the bundled engine depends on the compatible libsqlite3-sys dependency selected by SQLx. Confirm the actual engine and FTS5 in a real build; do not force incompatible transitive versions to match an upstream number.

**FullCalendar Standard:** use the MIT standard calendar features, not Premium/Scheduler features. [Version 7 reorganized its packages](https://fullcalendar.io/docs/upgrading-from-v6); standard views use the appropriate `@fullcalendar/react/*` entrypoints, not a mixture of v7 adapters and v6 plugins. Respect the temporal-polyfill peer dependency. ical.js uses MPL-2.0 and handles calendar parsing, not UI rendering.

**docx-preview over Mammoth:** Mammoth has more stars but prioritizes semantic HTML over document styling. docx-preview is closer to the approved viewing requirement, while still limited by HTML/CSS and unable to promise Word-identical pagination. Preserve originals and keep external opening available.

**keyring over Stronghold:** native OS storage is the approved credential model. Stronghold is an encrypted vault with a different operating model, not an interchangeable popularity-based replacement. Do not silently fall back to plaintext when secure storage is unavailable.

**PDF.js:** bundle matching viewer/worker resources locally, including required fonts, maps, and WASM assets. Do not depend on a CDN or assume ordinary browser file URLs work unchanged inside the system WebView.

## Milestones

### M0 — Technical Validation

**Workflow:** run the actual Tauri desktop surface with the mandatory document and integration building blocks.

Work:

- Run Markdown editing, PDF.js, and docx-preview in the system WebView.
- Exercise representative documents with tables, images, code, accents, and multiple pages.
- Open original documents in external applications.
- Confirm native credential storage and authorized read access to GitHub and Jira Cloud.
- Record production-build startup, memory across application processes, and interaction responsiveness during loading.

Acceptance: usable typing while content loads, readable representative documents, successful external opening, and an authorized real read from each integration. Replace inadequate components rather than silently removing required capabilities.

Learning goal: understand the boundary between the WebView, Rust commands, filesystem access, credentials, and permissions.

### M1 — Vault & Markdown

**Workflow:** create/open a Vault, write a Note, save, close, reopen, and move the Vault to another location.

**Implemented scope:** formal manifest/frontmatter/companion schemas; explicit creation, adoption, and import; source/unknown metadata preservation; external changes, invalid metadata, identity collisions, safe writes, concurrent conflicts; bounded incremental indexing with paged discovery and partial/cancelled visibility; derived local indexing without database authority.

Acceptance: an externally edited Note is recognized correctly; conflicting versions are not silently lost; a copied Vault opens without the original index.

Learning goal: identity, ownership, serialization, filesystem operations, and data-loss boundaries.

**Evidence:** Native Linux/Tauri WebKitGTK validation exercised create/save/reopen/copy/cache rebuild, external and invalid metadata/source preservation, Cancel/Discard/Save guards, adoption/import/collision behavior, paged 250-sibling browsing with 200 retained across save, 50,010 unsupported files capped at 50,000 with partial state, 2,055 directories producing partial state at the 2,048-watch cap, source read/Close Vault timing observations, real PDF page 1 and DOCX text rendering, picker/read-failure/hidden-buffer guard preservation, and the shipped release GUI creating/saving exact bytes on btrfs. Frontend React+Monaco validation exercised BOM/mixed-EOL grouped undo/redo, unequal simultaneous ranges, 140 undo/redo groups, and undo→branch. At this milestone, 3 raw-source tests and 23 Rust tests passed; the current commands are `bun run test:ts` and `bun run test:rust`. The executable was built with `tauri build --no-bundle` at `native/target/release/adamant`; this is not an installer or distribution bundle.

#### M1 UX and native evidence

M1 now creates a Vault through `vault_select_parent` followed by `vault_create`: the parent picker is selection-only, the child name and full destination are previewed, and an existing destination is refused exclusively, including an empty directory. Parent contents remain untouched and are not adopted or scanned. Existing callers use `vault_open` for opening; the former combined `vault_choose` API is removed.

The persistent Adamant menu remains reachable with the explorer collapsed. New Note and Import are contextual actions beside the Vault name. Healthy indexing has no operational clutter; partial/stale conditions provide compact details and recovery. Local filesystem watching refreshes clean notes and listings automatically, while Ctrl+S/⌘S remains the explicit save boundary. M1 has no autosave or cloud synchronization.

Verified in an isolated Linux WebKitGTK/Tauri runtime: parent selection and Back/change-picker cancellation retain the chosen location and name; an existing-folder collision and wizard cancellation leave existing files unchanged; creation produces the named child and valid manifest; contextual New Note and physical Ctrl+S persist the exact editor source; external edits and new files refresh the clean editor and expanded listing without manual reload; cancelling a dirty-buffer guard retains the draft for a later explicit save.

The persistent menu was exercised by keyboard with the sidebar collapsed and Connections active. Screenshots at 1440, 900, and 760 pixels verified the ready, partial, and wizard states. A real depth-limit fixture exposed one partial warning; the collapsed footer opened the details and transferred keyboard focus to recovery. The wizard rejected a path-like name without creating files. The 23 passing Rust tests include native child-name, collision, symlink, and replaced-parent boundaries; all 3 raw-source tests also passed. M2 and later milestones remain planned; other platforms and installers remain unverified.

### M2 — Work Context

**Workflow:** connect accounts, choose relevant repositories/projects, follow a work item, attach a Note, and act in the original tool.

Work:

- Query GitHub issues/PRs and Jira Cloud tasks, including available description, state, assignee, updates, and discussions.
- Select relevant scope rather than importing an entire organization indiscriminately.
- Create explicit portable references between work context and authored content.
- Support manual/background updates, pagination, and provider rate limits.
- Expose expired credentials, denied access, partial data, and stale cache states.

Acceptance: follow one real item from each service, observe a change made in the original tool, and consult the saved context offline. No operation modifies remote content.

Learning goal: HTTP, authentication, asynchronous work, stable remote identity, idempotent synchronization, and failure states.

### M3 — Document Library

**Workflow:** import a document, view it, annotate through Markdown, and open its original externally.

Work:

- Preserve PDF/DOCX originals and create companion metadata.
- Implement viewing, navigation, zoom, and text selection where available.
- Associate Markdown annotations and invalidate derived previews when originals change.
- Capture technical documentation with source metadata and local resources.
- Isolate imported content and prevent document scripts or remote resources from accessing privileged APIs or credentials.

Acceptance: PDF, DOCX, and captured documentation are usable offline; originals remain intact; annotations survive moving the Vault. Missing capture resources are reported honestly.

Learning goal: untrusted inputs, derived data, resource lifecycle, and asynchronous document processing.

### M4 — Knowledge Navigation

**Workflow:** find a Topic, navigate its materials, record understanding, and leave a resumption point.

Work:

- Organize Topics with folders, tags, and references.
- Provide optional learning templates without enforcing section names.
- Derive backlinks and expose missing references.
- Search Notes, saved documentation, metadata, and extractable document text.
- Update the index incrementally and rebuild it from authoritative files.

Acceptance: find the same authored content after rebuilding the index; identity-based relationships survive Note renames. Scanned PDFs remain viewable, but OCR is not implicitly included in text extraction.

Learning goal: data modeling, graph relationships, indexing, and consistency between primary and derived state.

### M5 — Local Calendar

**Workflow:** reserve a local block, associate study context, and resume through the event.

Work:

- Create, edit, and remove local events; provide agenda and calendar views.
- Associate events with Notes and Topics.
- Import/export iCalendar with stable identity, time zones, and supported recurrence semantics.
- Preserve unknown fields and identify imported constructs that cannot be safely edited.

Acceptance: export/import without duplicating events or shifting times; open a study event and access its material. No Google Calendar synchronization is introduced.

Learning goal: interoperability, temporal modeling, recurrence, and round-trip preservation.

### M6 — Today

**Workflow:** open Adamant, choose the next activity, and access the required context without rebuilding it manually.

Work:

- Bring together local events, followed work, and resumption points.
- Allow local priority selection without mutating remote services.
- Persist authored selections in portable files rather than only in SQLite.
- Provide keyboard navigation and quick search.
- Keep corporate and personal contexts separated by Vault.

Acceptance: navigate from Today to a real work or study session with its context intact. A Vault must not display another Vault's data or use its credentials.

Learning goal: application state, context boundaries, and connecting existing capabilities without duplicating their data.

### M7 — Portable Desktop Release

**Workflow:** install, use, export, and reopen in another installation.

Work:

- Package for the agreed desktop targets; validate on each claimed supported platform.
- Export/import the complete Vault consistently, including attachments, references, resources, and calendars.
- Exclude credentials and default external caches from exports.
- Exercise the full workflow without network access and with revoked credentials.
- Measure performance with a representative Vault and active integrations, not just an empty window.

Acceptance: a new installation reconstructs its index and preserves authored content; GitHub/Jira require separate authentication. All earlier workflows work together.

Learning goal: reproducibility, packaging, compatibility, and end-to-end verification.

## Dependencies and execution order

M0 precedes commitment to the runtime integrations. M1 establishes the Vault behavior used by the remaining milestones. Work Context, Document Library, and Local Calendar have independent implementation work after that shared base. Knowledge Navigation connects content; Today integrates the user workflows; Portable Desktop Release verifies the full product.

Use the milestone sequence as the default learning order. Do not create every module or dependency upfront merely because it appears in the roadmap.

## Jira Cloud authentication boundary

Jira Cloud is confirmed. Target platform REST API v3 for the required operations.

For this strictly personal, local application, an account API token is the initial approach only if allowed by the employer's policy. Store it in the OS credential store, scoped to its connection, never in the Vault or repository. Access to corporate repositories, SSO approval, allowed scopes, and local caching policy must be checked against the real organization before integration validation.

The [documented Jira Cloud OAuth 3LO flow](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/) requires a client secret for token exchange. Do not embed a shared secret into a distributed desktop binary. Distribution to other users would require a separate authentication and policy review; this plan does not authorize a new backend or claim that personal token usage is appropriate for a distributed product. See also [Atlassian's authentication guidance](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/) and [GitHub authentication guidance](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api).

## Verification throughout development

- Exercise every changed user workflow in the actual desktop surface.
- Validate commands in Rust as well as restricting [Tauri capabilities](https://v2.tauri.app/security/capabilities/).
- Protect import/export against path traversal and unintended access through filesystem links.
- Keep expensive indexing and document work off the interaction path.
- Retain deterministic regression tests for real risks: concurrent writes, round-trip preservation, identity collisions, paging, Vault isolation, and time-zone handling.
- Do not add tests that merely repeat implementation wiring or pin incidental wording.
- Treat requirements, upstream feature claims, and measured runtime behavior as different evidence levels.

## Learning loop

**Concept → Small change → Run → Explain → Next step**

Each milestone should include a bounded part the owner can implement or experiment with, supported by explanations, implementation help, and review as needed. Avoid delivering large unexplained code dumps. Record the decision, observed behavior, and next step so that resuming the project does not require reconstructing the whole context.

Study architecture through actual persistence, concurrency, synchronization, security, and interoperability problems. Do not turn the application into a distributed deployment just to study distributed-system concepts. Mathematics can remain a separate, gradual study track rather than a prerequisite to building Adamant.

## M0 verification record

- `cargo check` passed with Rust 1.97.1.
- The original frontend build passed with Node 24.14.1, TypeScript 7.0.2, and Vite 8.2.2. That Monaco-based build reported a large lazy-loaded editor chunk; Monaco has since been replaced by CodeMirror as recorded above.
- The Tauri production build passed and a native Linux window launched. Native file picking and Markdown viewing were observed.
- Actual browser keyboard interaction verified rapid Markdown entry, accented text, tables, code, tab navigation, and buffer retention between views. A reproduced cursor/source synchronization bug was fixed.
- Browser component checks with real fixture bytes verified PDF page navigation, 75% zoom, text selection, and worker cleanup; DOCX displayed a table, multiple sections, and an embedded PNG. These checks did not mock native IPC and do not constitute full native document-path verification.
- Markdown previews strip scripts, remote image sources, and active link targets. Preview frames retain their sandbox and CSP.
- The session Secret Service was available, but successful token storage and authorized GitHub/Jira reads were not exercised. No existing credentials were loaded.
- Native automation was stopped when interaction overlapped with user-opened content. User-owned windows/buffers were not closed or overwritten.

Owner acceptance (September 6, 2026): M0 is approved, with initial connections and rendering reported working. This supersedes the earlier pending M0 acceptance status; the automated observations above remain a historical record, not a claim that the agent independently exercised the owner's credentials.

Integrated window controls: native decorations are disabled; tab-bar drag regions and minimize, maximize/restore, and close actions use narrowly scoped Tauri permissions. Production build passed. Native Wayland maximize/restore changed the window size and restored it; closing an empty X11 test instance exited successfully. On the tested Niri session, minimize left the window visible. Dragging is wired through Tauri's native drag-region handling but has not been verified with a physical pointer gesture in this session. No compositor-specific hide/recovery workaround is implemented.

Next: assess other operating systems, installers, and unsupported filesystem behavior. M2 and later workflows remain planned.
