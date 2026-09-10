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

**Early development · M0 approved; M1 implemented and Linux-verified.**

Vault creation explicitly creates a new child folder inside a chosen parent; existing destinations, even empty folders, are refused. Adamant manifests use `format: "adamant-vault"`, `formatVersion: 1`, and a UUID. Supported loaded documents are case-insensitive `.md`, `.pdf`, and `.docx`; `vault.json` and `.meta.yaml` companions are internal metadata.

New Vaults create `content/` as their content root, recorded as `"contentRoot": "content"` in the manifest. The explorer shows its contents directly, without a wrapper folder or a default `notes/` prefix. Existing Vaults retain their original layout without migration. Validated Notes hide their metadata header in the editor and reading preview while preserving it when saving.

### Available now

- **Vault & Markdown:** create/open/reopen portable Vaults, explicit Ctrl+S/⌘S persistence, external-change conflicts, adoption/import, collision reporting, recovery copies retaining raw source and UUID, and a bounded incremental index with visible partial/cancelled states.
- **Markdown workbench:** editing, sanitized reading preview, and split view, with bundled fonts and a collapsible document explorer.
- **Local document previews:** PDF navigation, zoom, and text selection; approximate DOCX rendering; native file selection and external opening. Files are limited to 64 MiB.
- **Connection checks:** real, read-only GitHub and Jira Cloud identity requests, with successful credentials saved through the OS credential store. This does not yet synchronize work items.
- **Focused desktop interface:** integrated title bar, a persistent Adamant operations menu, icon navigation, and contextual Note actions beside the Vault name.

### Vault creation and local synchronization

Create Vault opens a two-step wizard: choose a parent folder, then name the new Vault. The parent may already contain files and is not changed by selection. Adamant previews the full destination and creates one new child directory exclusively; existing files and folders, including empty ones, are refused and never adopted. The parent's contents are not scanned or imported.

The persistent Adamant menu remains available even when the explorer is collapsed. New Note and Import actions are contextual to the open Vault. Filesystem watching updates clean notes and listings automatically; partial or stale inventories expose compact recovery details. Saving is explicit with Ctrl+S/⌘S—there is no autosave or cloud synchronization.

### Validation status

- 24 Rust vault tests and 4 dependency-free raw-source tests pass with the focused commands below.
- Native core evidence covers create/save/reopen/copy/cache rebuild, metadata/source preservation, guards, adoption/import/collisions, paged browsing, and bounded partial indexing.
- Resource-boundary evidence covers the 50,000-entry and 2,048-watch limits, partial state, and cancellation.
- Actual React+Monaco evidence covers BOM/mixed-EOL grouped undo/redo, simultaneous ranges, 140 undo/redo groups, and undo→branch.
- Actual PDF page 1 and DOCX text rendering, picker/read-failure preservation, and hidden-buffer guards were exercised.

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

The browser preview cannot pick local documents through Tauri, open external applications, or access native credentials. Vite currently reports a large lazy-loaded Monaco chunk; this warning is not suppressed.

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

The Bun audit gate fails on high/critical findings and emits unfiltered JSON so lower-severity advisories stay visible. Cargo Audit uses its default failure policy; advisory warnings remain visible. Current warnings include transitive DOMPurify in Monaco and Rust dependencies reported as unmaintained or unsound; a successful audit exit does not mean there are no advisories.

## Roadmap

| Milestone                         | Outcome                                                                                  | Status                      |
| --------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------- |
| **M0 · Technical validation**     | Exercise the desktop editor, document viewers, and account/credential boundaries.        | Approved                    |
| **M1 · Vault & Markdown**         | Create/open portable Vaults; save notes safely; recognize external edits and conflicts.  | Implemented; Linux verified |
| **M2 · Work context**             | Follow GitHub issues/PRs and Jira tasks, link notes, and consult cached context offline. | Planned                     |
| **M3 · Document library**         | Preserve originals, attach Markdown annotations, and capture technical documentation.    | Planned                     |
| **M4 · Knowledge navigation**     | Connect Topics, folders, tags, references, and resumption points.                        | Planned                     |
| **M5 · Local calendar**           | Plan local events and study blocks, with iCalendar import/export.                        | Planned                     |
| **M6 · Today**                    | Bring priorities, events, and the next activity into one view.                           | Planned                     |
| **M7 · Portable desktop release** | Package, export, move, and reopen the workspace on another installation.                 | Planned                     |

Google Calendar synchronization, remote writes to GitHub/Jira, in-app PDF/DOCX editing, and a plugin platform are outside the current roadmap. AI-friendly means portable, inspectable data—not a built-in chatbot or mandatory AI service.

## Architecture

| Layer                  | Technology and responsibility                                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Interface**          | React, TypeScript, and Vite inside Tauri 2's system WebView.                                                                                                                                              |
| **Editor and viewers** | Monaco, Marked, DOMPurify, PDF.js, and docx-preview.                                                                                                                                                      |
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
    markdown/                 Monaco editor, Markdown preview, source history, and tests
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
- Imported content is untrusted. Markdown and DOCX previews are sanitized and isolated; active content and remote resources are blocked. PDF scripts, forms, and link actions are not exposed.
- Credentials are not written into notes, browser storage, or portable exports. Existing credentials are not loaded automatically.
- PDF/DOCX originals are not modified. DOCX layout is approximate; use the external application when fidelity matters.

## Project documentation

- [Vault contract](docs/vault-contract.md) — domain vocabulary, file formats, identity, portability, and integrity rules.
- [Implementation plan](docs/implementation-plan.md) — milestones, reviewed technology baseline, acceptance criteria, and learning goals.

Inter and JetBrains Mono are bundled locally. Their redistribution notices are included in [public/licenses](public/licenses/).
