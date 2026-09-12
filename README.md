<p align="center">
  <img src="assets/adamant.png" alt="Adamant — a faceted purple A" width="160" />
</p>

<h1 align="center">Adamant</h1>

<p align="center">
  A local-first desktop workspace for notes, documents, and the context behind your work.
</p>

<p align="center">
  <a href="#getting-started">Getting started</a> ·
  <a href="#current-status">Current status</a> ·
  <a href="#roadmap">Roadmap</a> ·
  <a href="#architecture">Architecture</a>
</p>

## Why Adamant?

Work and learning rarely live in one place. Notes, technical documentation, GitHub issues, Jira tasks, and personal plans all hold a piece of the context. Adamant is being built to bring those pieces together locally, so you can resume an activity without reconstructing everything first.

The goal is a portable, file-based workspace—not another hosted service or a replacement for your existing tools. Work items stay in GitHub and Jira; original documents remain intact; authored knowledge belongs in inspectable files.

Adamant is also a personal learning project, developed through small, verifiable milestones.

## Current status

**Early development · M0 approved; M1/M1.1 and the expanded M2 workspace implemented. Verification remains scoped; live provider writes are not certified.**

Vault creation explicitly creates a new child folder inside a chosen parent; existing destinations, even empty folders, are refused. Adamant manifests use `format: "adamant-vault"`, `formatVersion: 1`, and a UUID. Supported loaded documents are case-insensitive `.md`, `.pdf`, and `.docx`; `vault.json` and `.meta.yaml` companions are internal metadata.

PDF and DOCX originals can be opened without `.meta.yaml` companions. Missing companions are not Vault issues; existing invalid or orphaned companions are still reported, and original files remain unchanged.

New Vaults create `content/` as their content root, recorded as `"contentRoot": "content"` in the manifest. The explorer shows its contents directly, without a wrapper folder or a default `notes/` prefix. Existing Vaults retain their original layout without migration. Validated Notes hide their metadata header in the editor and reading preview while preserving it when saving.

### Available now

- **Vault & Markdown:** create/open/reopen portable Vaults, explicit Ctrl+S/⌘S persistence, external-change conflicts, adoption/import, collision reporting, recovery copies retaining raw source and UUID, and a bounded incremental index with visible partial/cancelled states.
- **Markdown workbench:** editing, sanitized reading preview, and split view, with bundled fonts and a collapsible document explorer. The reading column stays centered; long text wraps, and wide code blocks and tables scroll within their own bounds rather than widening the page. Preview links open web/email destinations externally, scroll to local headings, or navigate to relative documents inside the current Vault. Right-click in the editor or press `Shift+F10` for undo/redo, clipboard actions, selection deletion, and select-all. Actions preserve selection and undo history and respect read-only state.
- **Local document previews:** PDF navigation, zoom, and text selection; approximate DOCX rendering; native file selection and external opening. Files are limited to 64 MiB.
- **Project workspace:** project spaces with typed local/GitHub/Jira cards, saved list/board filters, adjustable personal columns, drag/menu/keyboard movement, expandable details, local task checklists/priorities/dates, and links. Personal columns never change remote status.
- **Connections and work context:** GitHub/Jira account verification with OS-keyring tokens, scoped source refresh/pagination, offline snapshots, and unsent comment/review drafts. Explicit provider actions include comments, supported field/state edits, general PR reviews and merge; immutable item identity and inspected commit checks guard remote targets.
- **Focused desktop interface:** a matte writing surface flush against the sidebar, with equal top/right/bottom gutters and separate tab and window-control blocks above the content. Gutters share the sidebar's continuous gradient rather than a separate frame background; there is no sidebar title. Hover and selected states use flat fills and text contrast, never lighting, bevels, or state-indicating borders. Atmosphere stays in the surrounding surfaces and sidebar crystal, separate from interaction feedback. Keyboard focus remains visible; focused tabs underline their label instead of drawing a border. The compact Adamant menu and contextual file actions remain familiar; **All commands…** (`Ctrl+Shift+P`) opens the full command palette, including recovery and maintenance operations. Warning/error colors and original PDF/DOCX content are preserved.
- **Sidebar atmosphere:** a centered, softly lit crystal dissolves into a subtle fade below. Its scale follows the window height; it stays behind file controls, respects reduced motion, and retains a static SVG fallback when WebGL is unavailable.
- **Surface rendering:** the editor footer, menus, dialogs, and small panels use solid fills. The icon ribbon shares the shell's continuous gradient; a tiny static monochrome dither tile reduces visible 8-bit banding without covering text or adding animated noise.
- **Sidebar navigation:** distinct Vault, folder, and file typography; consistent row spacing; and short CSS transitions for collapse, hover, and folder chevrons. The sort control uses the app's themed menu with checked Name/Type/Modified choices, keyboard navigation, and focus restoration instead of an unstyled native popup. Collapsed content is inert, and reduced motion disables sidebar transitions and menu animation.
- **Reading context:** breadcrumbs name the current Vault without repeating it in the status bar. Breadcrumb and status text have stronger contrast without brightening disabled controls. The writing column remains centered; split view stacks vertically when the document area—not the whole window—is too narrow for two comfortable columns.

### Project workspace

Open **Project workspace** from the ribbon or command palette, then create a space in an open Vault. **New task** creates local work; **Add existing** shares an item with another space without sharing its column position. **Columns** adjusts the flow. Alt+Left/Right moves the focused card across columns; the action menu and list column selector provide non-drag alternatives.

Connect accounts under **Connections** and add repository/project scopes under **Sources**, with optional GitHub search qualifiers or Jira JQL. **Follow URL** includes an individual GitHub issue/PR or Jira issue. Refresh is manual and every five minutes while the workspace is visible; additional pages load explicitly. Previously followed items are retained when filters or sources change.

Details separate local organization from provider state and actions. Comments/field edits use explicit Send/Save; approval, change requests, state transitions, and merge require confirmation. Reviews and merge are pinned to the inspected head SHA. No write is automatically retried, including after reconnecting. GitHub inline reviews and remote item creation are outside M2; Jira transitions requiring additional fields must be completed in Jira.

Portable work state lives in `.adamant/work-context.json`, without tokens. Detailed offline discussions/diffs use an account-scoped machine-local cache of the 16 most recent snapshots (up to 2 MiB each); summaries, tasks, links, and drafts remain in the Vault. Failed local writes keep edits in memory and block normal app/Vault departure until resolved; unsaved failures are not claimed as restart-durable. Note links are relative paths and are not rewritten automatically by file moves. See the [work-context storage contract](docs/vault-contract.md#m2-project-workspace) for revision, recovery, and platform limits.

### Vault creation and local synchronization

Create Vault opens a two-step wizard: choose a parent folder, then name the new Vault. The parent may already contain files and is not changed by selection. Adamant previews the full destination and creates one new child directory exclusively; existing files and folders, including empty ones, are refused and never adopted. The parent's contents are not scanned or imported.

The persistent Adamant menu sits in the bottom icon group, immediately above Trash, and remains available when the explorer is collapsed. Its panel opens upward within the window. Trash stays directly above Connections; selection stays highlighted in the file list without a separate footer strip. New Note and Import actions are contextual to the open Vault. Filesystem watching updates clean notes and listings automatically; partial or cancelled indexing exposes compact recovery controls. Markdown saving is explicit with Ctrl+S/⌘S. Project-workspace changes save automatically to the Vault; provider writes remain explicit.

Routine saves, copies, and local navigation do not show success or processing banners. Longer saves show progress only in the Save button. The unsaved marker clears only after a confirmed write; edits made during that write remain pending. Background navigation keeps loaded editors usable, while operations that can replace buffers or mutate files retain their safety guards. Errors, conflicts, recovery details, and partial or cancelled indexing remain visible. A stale index does not produce workspace warnings; search still reports incomplete coverage where relevant.

Successful file operations update the explorer and tabs without a result dialog; incomplete outcomes or pending recovery still open a review. Destructive confirmations are unchanged. Automatic indexing and listing refreshes are silent. Folder, Trash, Markdown, PDF, and DOCX loading uses a small local indicator only after 500 ms, with accessible labels and reduced-motion support.

Adamant remembers the last successfully opened or created Vault and restores it at startup. Its canonical container path and UUID are stored in `last-vault.json` in Tauri's local application data directory, outside the portable Vault. Closing Adamant preserves this preference; **Close Vault** clears it. Cancelled or failed selections keep the previous choice. An unavailable folder or changed Vault identity produces a notice without modifying source files or blocking a new selection.

The last active document is restored with its Vault session. Without a Vault, Adamant remembers the active standalone Markdown, PDF, or DOCX file in `last-document.json`, verifies its identity before reopening it, and restores its view and position. No file, or an unavailable remembered file, leaves a writable draft; unavailable files also produce a notice. Drafts without a saved path stay in the editor and tabs, not the file explorer. Save keeps the existing workflow of creating a named Note in a Vault; the remembered-file record never contains unsaved text.

For restored Vault tabs, the active tab loads before recovery drafts are read; inactive tabs load on activation. Loading is distinct from failure. A read or identity-validation failure shows its reason and a retry action in the tab, without changing the source file or retained draft.

The pristine initial **New document** tab has no close control. Its inline writing prompt focuses the editor and disappears on input; real files and drafts with content retain their close controls. Without a Vault, the sidebar offers **Open document…**, **Open Vault…**, and **Create Vault…** directly. Save status distinguishes a document not saved yet, pending changes, saved content, and file conflicts; unloaded tabs and read-only originals are identified separately. Duplicate tab names show the shortest distinguishing parent path, while tooltips expose the full known path.

### Validation status

- 74 native Rust tests and 24 TypeScript tests pass with the focused commands below.
- Native core evidence covers create/save/reopen/copy/cache rebuild, metadata/source preservation, guards, adoption/import/collisions, paged browsing, and bounded partial indexing.
- Resource-boundary evidence covers the 50,000-entry and 2,048-watch limits, partial state, and cancellation.
- CodeMirror history tests cover BOM/mixed-EOL grouped undo/redo, simultaneous ranges, 140 undo/redo groups, undo→branch, and validated frontmatter. A React+CodeMirror browser smoke covers text input, Unicode, select-all, undo/redo bindings, search, read-only mode, and remount cleanup.
- Actual PDF page 1 and DOCX text rendering, picker/read-failure preservation, and hidden-buffer guards were exercised.
- Last-Vault coverage includes identity validation, atomic preference replacement, and failed-write preservation. An isolated native process exercised startup restoration, restart persistence, Close Vault followed by an empty restart, and an unavailable remembered folder.
- PR-review regressions cover confirmed mutation scope, ambiguous import identities, legacy administration exclusion, search identity, stable pagination, and preferred views for newly opened Notes.
- An isolated Tauri/Wry process exercised the production IPC permissions and verified that workspace loading grants no document access; only an identity-validated tab read grants access to its exact path.
- The React workspace was exercised in Chromium with controlled IPC responses: keyboard selection and deletion targets, pending creation, combined recovery errors, identity-preserving history, directory favorites, stale watcher responses after saves, replacement protection, and search/filter reset across Vaults. These checks do not certify native dialogs or filesystem behavior.

```sh
bun run test:ts
bun run test:rust
```

Native source creation and atomic overwrite were exercised on Linux tmpfs and btrfs. Unsupported filesystems may refuse safely; other operating systems and installers remain unverified. The native executable build previously passed with `tauri build --no-bundle` and produced `native/target/release/adamant`; this is not an installer, bundle, or universal OS/filesystem claim.

## Getting started

### Prerequisites

Development has been exercised on Linux with:

- [Bun **1.4.2**](https://bun.sh/docs/installation), pinned by `packageManager` in `package.json`, for dependency management and project commands.
- Node.js **24.14.1** (pinned in `.node-version`) remains the runtime for existing Node-based tools, scripts, and `node:test` tests.
- Rust **1.98.1**, Cargo, rustfmt, and Clippy (pinned in `rust-toolchain.toml`; rustup installs these components automatically).
- GTK 3 and WebKit2GTK 4.1 development libraries, plus a desktop session. Follow the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your distribution.
- Default applications associated with Markdown, PDF, or DOCX for external opening.
- An unlocked Secret Service collection on the session D-Bus for secure credential storage on Linux.

For editor diagnostics, rust-analyzer also needs the standard-library sources. With rustup, install them using `rustup component add rust-src`. When Rust is installed through Pacman on Arch/CachyOS, use `sudo pacman -S --needed rust-src` instead. If Zed reports `can't load standard library from sysroot /usr`, install this package and run `editor: restart language server` from its command palette.

### Run in development

```sh
git clone https://github.com/Kazyel/adamant.git
cd adamant
bun install --frozen-lockfile
bun run tauri dev
```

### Build the desktop application

```sh
bun run tauri build --no-bundle
./native/target/release/adamant
```

This produces a local executable, not an installer. The production application does not need the Vite development server.

### Install or update locally (Linux)

With the prerequisites and dependencies installed through Bun, run from this checkout:

```sh
bun run app:update
```

This builds the current local source in release mode and installs **Adamant** in your applications menu, without sudo. It does not pull Git changes or download published releases. Build tools may download missing dependencies.

The executable and icon live in `${XDG_DATA_HOME:-$HOME/.local/share}/adamant/app/`; the launcher lives in the same data directory under `applications/io.adamant.desktop.desktop`. The launcher starts the installed executable directly: no build, updater, or development server runs when opening it. This is a local executable installation, not an AppImage or a portable bundle; Linux runtime libraries are still required.

A failed build leaves the installed version untouched. Installation replaces the executable by atomic rename, so an already running instance can keep running; close and reopen it to use the new build. The update command does not modify Vaults or application settings.

### Frontend preview

```sh
bun run dev                     # Browser preview; native features unavailable
bun run build                   # TypeScript check and frontend production build
```

The browser preview cannot pick local documents through Tauri, open external applications, or access native credentials. CodeMirror is loaded on demand for Markdown editing; the sanitized reading preview remains separate. The migration reduced the minified editor chunk from about 2.62 MB to 531 kB (673 kB to 184 kB gzip), without an editor worker. Vite still flags the chunk above its 500 kB threshold; the warning is not suppressed.

### Quality workflow

```sh
bun run fmt          # Oxfmt and rustfmt; rewrites formatting only
bun run fmt:check    # Check formatting without modifying files
bun run lint         # Type-aware Oxlint; warnings fail
bun run typecheck    # Strict TypeScript, including tests and Vite config
bun run lint:rust    # Clippy for all native targets; warnings fail
bun run knip         # Unused files, exports, and dependencies
bun run test         # Existing TypeScript and Rust tests
bun run check        # All checks above, without dependency audits
```

`bun.lock` is the only JavaScript dependency lockfile. Use `bun install --frozen-lockfile` for reproducible installs, `bun add`/`bun remove` for dependency changes, and commit the resulting lockfile. Use `bun run test`, not `bun test`: the project script runs both the existing Node test runner and Rust tests without changing their runtimes.

Configure your editor to use Oxc for frontend/configuration formatting and rust-analyzer for Rust. `.editorconfig`, Oxfmt, and rustfmt standardize indentation, line endings, and wrapping. Keep blank lines between declarations and logical groups.

Oxlint limits modified cyclomatic complexity to **15** and nesting depth to **4**, forbids nested ternaries, requires braces and type-only imports, and checks React hooks, accessibility, unsafe promises, and import cycles. Clippy limits cognitive complexity to **15** and function arguments to **7**; broad pedantic/restriction sets are intentionally not enabled.

`bun install` installs the Lefthook pre-commit hook. It checks formatting and lint on staged paths using their current working-tree contents; Rust formatting does not traverse unstaged child modules. Hooks never rewrite or restage files. Standalone type checks, native compilation, tests, and audits are not pre-commit steps. Run `bun run prepare` to reinstall hooks if needed.

GitHub Actions runs the same quality gates, the frontend build, and dependency audits on pushes and pull requests. It uses pinned action revisions and read-only repository permissions. Neither the hooks nor CI run `app:update`; installing a release remains an explicit operation.

Dependency audits require network access:

```sh
cargo install --locked cargo-audit --version 0.22.2
bun run audit:js
bun run audit:rust
```

The Bun audit gate fails on high/critical findings and emits unfiltered JSON so lower-severity advisories stay visible. Cargo Audit uses its default failure policy; advisory warnings remain visible. Rust dependencies have been reported as unmaintained or unsound; a successful audit exit does not mean there are no advisories.

## Roadmap

| Milestone                         | Outcome                                                                                       | Status                           |
| --------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------- |
| **M0 · Technical validation**     | Exercise the desktop editor, document viewers, and account/credential boundaries.             | Approved                         |
| **M1 · Vault & Markdown**         | Create/open portable Vaults; save notes safely; recognize external edits and conflicts.       | Implemented; Linux verified      |
| **M2 · Work context**             | Project spaces, personal Kanban, typed details, offline drafts and explicit provider actions. | Implemented; scoped verification |
| **M3 · Document library**         | Preserve originals, attach Markdown annotations, and capture technical documentation.         | Planned                          |
| **M4 · Knowledge navigation**     | Connect Topics, folders, tags, references, and resumption points.                             | Planned                          |
| **M5 · Local calendar**           | Plan local events and study blocks, with iCalendar import/export.                             | Planned                          |
| **M6 · Today**                    | Bring priorities, events, and the next activity into one view.                                | Planned                          |
| **M7 · Portable desktop release** | Package, export, move, and reopen the workspace on another installation.                      | Planned                          |

Google Calendar synchronization, in-app PDF/DOCX editing, and a plugin platform are outside the current roadmap. M2 explicitly includes guarded GitHub/Jira writes; it does not include remote item creation or inline PR review. AI-friendly means portable, inspectable data—not a built-in chatbot or mandatory AI service.

## Architecture

| Layer                  | Technology and responsibility                                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Interface**          | React, TypeScript, and Vite inside Tauri 2's system WebView.                                                                                                                                              |
| **Editor and viewers** | CodeMirror 6, Marked, DOMPurify, PDF.js, and docx-preview.                                                                                                                                                |
| **Native core**        | Rust commands for bounded file access, identity requests, secure credentials, and external opening.                                                                                                       |
| **Portable Vault**     | Authoritative Notes, PDF/DOCX originals, and document companions; only `.md`, `.pdf`, and `.docx` are loaded as documents. Future formats remain roadmap work; manifest/companions are internal metadata. |
| **Local index**        | Bounded, cancellable incremental SQLite-derived index; source files remain authoritative and partial states are visible.                                                                                  |

The explorer presents the bounded native Vault inventory and loaded original documents; source files remain authoritative and future workflows follow the [Vault contract](docs/vault-contract.md).

### Source layout

```text
ui/
  main.tsx                    React bootstrap and global font setup
  app/                        Application shell, navigation, menus, panes, and status
    App.tsx                   Top-level state and composition
    workspaceView.ts          Shared view types and presentation helpers
    styles/                   Base, shell, explorer, workbench, viewers, dialogs, and responsive rules
  features/
    workspace/                Vault/buffer workflows and their feature-owned state
      useWorkspace.ts         Save/navigation guards, session ordering, and refresh coordination
      useDirectoryPages.ts    Paged inventory, request generations, and expanded branches
      buffer.ts               Synchronous buffer state, revisions, and disk conflicts
      useWorkspacePrompt.ts   Prompt resolution and Vault selection
      workspaceEvents.ts      Native notifications, save shortcuts, and unload listeners
      WorkspaceDialog.tsx     Guard/path dialogs; CreateVaultDialog owns the creation wizard
    markdown/                 CodeMirror editor/state, raw-source preservation, preview, and tests
    documents/                PDF/DOCX viewers and selected-document types
    connections/              GitHub/Jira connection-check interface
  shared/
    errors.ts                 Error presentation shared across features
    ui/                       Icons and the sandboxed preview frame
    styles/                   Shared font definitions

native/src/
  main.rs                     Native executable entry point
  lib.rs                      Tauri setup, feature state, and command registration
  documents/mod.rs            Bounded reads, native selection, and external opening
  connections/mod.rs          Identity checks, HTTPS policy, and credential storage
  vault/
    mod.rs                    Domain types, storage, and module wiring
    capability.rs             Confined path traversal and bounded filesystem access
    lifecycle.rs              Parent selection, creation, manifest admission, and opening
    notes.rs                  Reads, adoption, imports, and note identity checks
    persistence.rs            Checked saves, raw copies, atomic exchange, and recovery
    commands.rs               Native IPC handlers
    commands/                 Sessions, background work, and filesystem watching
    indexing.rs               Inventory, snapshots, pagination, and identity guards
    indexing/work.rs          Bounded batch lifecycle and index publication
    indexing/work/            Discovery, metadata extraction, and SQLite cache persistence
    metadata.rs               Manifest, Note, and companion validation
    tests.rs                  Shared test fixtures
    tests/                    Lifecycle, notes, persistence, and inventory regression coverage
```

Keep feature-owned code beside its consumers. `app/` composes the frontend features; `shared/` contains only code reused across features and does not depend on them. Markdown tests are colocated with their source and discovered by `bun run test:ts`; Rust tests stay inside the Vault module. Moves do not introduce barrel files, compatibility paths, or new IPC names.

Keep related state and its mutation together: the workspace coordinator owns session and operation ordering, while paging, buffer transitions, and prompts own their narrower state. Native modules extend the same `Vault` through focused implementations rather than adding service wrappers. CSS is loaded centrally, with responsive overrides last.

### Privacy and document safety

- No mandatory hosted backend. Account checks explicitly contact GitHub or Jira Cloud.
- The interface receives specific native operations, not unrestricted filesystem or credential access.
- Imported content is untrusted. Markdown and DOCX previews are sanitized and isolated; document scripts and remote resources are blocked. Markdown uses an opaque sandbox with one nonce-authorized navigation bridge, also hash-allowlisted in the production CSP. Messages must match the current frame and document token; only HTTP, HTTPS, and mailto URLs reach the native link opener. DOCX links remain inactive. PDF scripts, forms, and link actions are not exposed.
- Credentials are not written into notes, browser storage, or portable exports. Existing credentials are not loaded automatically.
- PDF/DOCX originals are not modified. DOCX layout is approximate; use the external application when fidelity matters.

## Project documentation

- [Vault contract](docs/vault-contract.md) — domain vocabulary, file formats, identity, portability, and integrity rules.
- [Implementation plan](docs/implementation-plan.md) — milestones, reviewed technology baseline, acceptance criteria, and learning goals.

Inter and JetBrains Mono are bundled locally. Their redistribution notices are included in [public/licenses](public/licenses/).
