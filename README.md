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

- 23 Rust vault tests and 3 dependency-free raw-source tests pass with the focused commands below.
- Native core evidence covers create/save/reopen/copy/cache rebuild, metadata/source preservation, guards, adoption/import/collisions, paged browsing, and bounded partial indexing.
- Resource-boundary evidence covers the 50,000-entry and 2,048-watch limits, partial state, and cancellation.
- Actual React+Monaco evidence covers BOM/mixed-EOL grouped undo/redo, simultaneous ranges, 140 undo/redo groups, and undo→branch.
- Actual PDF page 1 and DOCX text rendering, picker/read-failure preservation, and hidden-buffer guards were exercised.

```sh
node --experimental-strip-types --test tests/markdownSource.test.ts
cargo test --manifest-path src-tauri/Cargo.toml --lib vault::tests -- --test-threads=1
```

Native source creation and atomic overwrite were exercised on Linux tmpfs and btrfs. Unsupported filesystems may refuse safely; other operating systems and installers remain unverified. The executable build passed with `npm run tauri -- build --no-bundle` and produced `src-tauri/target/release/adamant`; this is not an installer, bundle, or universal OS/filesystem claim.

## Getting started

### Prerequisites

Development has been exercised on Linux with:

- Node.js **24.14.1 or newer** and npm.
- Rust and Cargo; the current application has built with **Rust 1.97.1**.
- GTK 3 and WebKit2GTK 4.1 development libraries, plus a desktop session. Follow the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your distribution.
- Default applications associated with Markdown, PDF, or DOCX for external opening.
- An unlocked Secret Service collection on the session D-Bus for secure credential storage on Linux.

### Run in development

```sh
git clone https://github.com/Kazyel/adamant.git
cd adamant
npm ci
npm run tauri dev
```

### Build the desktop application

```sh
npm run tauri build -- --no-bundle
./src-tauri/target/release/adamant
```

This produces a local executable, not an installer. The production application does not need the Vite development server.

### Frontend preview and checks

```sh
npm run dev                     # Browser preview; native features unavailable
npm run build                   # TypeScript check and frontend production build
cargo check --manifest-path src-tauri/Cargo.toml
```

The browser preview cannot pick local documents through Tauri, open external applications, or access native credentials. Vite currently reports a large lazy-loaded Monaco chunk; this warning is not suppressed.

## Roadmap

| Milestone | Outcome | Status |
| --- | --- | --- |
| **M0 · Technical validation** | Exercise the desktop editor, document viewers, and account/credential boundaries. | Approved |
| **M1 · Vault & Markdown** | Create/open portable Vaults; save notes safely; recognize external edits and conflicts. | Implemented; Linux verified |
| **M2 · Work context** | Follow GitHub issues/PRs and Jira tasks, link notes, and consult cached context offline. | Planned |
| **M3 · Document library** | Preserve originals, attach Markdown annotations, and capture technical documentation. | Planned |
| **M4 · Knowledge navigation** | Connect Topics, folders, tags, references, and resumption points. | Planned |
| **M5 · Local calendar** | Plan local events and study blocks, with iCalendar import/export. | Planned |
| **M6 · Today** | Bring priorities, events, and the next activity into one view. | Planned |
| **M7 · Portable desktop release** | Package, export, move, and reopen the workspace on another installation. | Planned |

Google Calendar synchronization, remote writes to GitHub/Jira, in-app PDF/DOCX editing, and a plugin platform are outside the current roadmap. AI-friendly means portable, inspectable data—not a built-in chatbot or mandatory AI service.

## Architecture

| Layer | Technology and responsibility |
| --- | --- |
| **Interface** | React, TypeScript, and Vite inside Tauri 2's system WebView. |
| **Editor and viewers** | Monaco, Marked, DOMPurify, PDF.js, and docx-preview. |
| **Native core** | Rust commands for bounded file access, identity requests, secure credentials, and external opening. |
| **Portable Vault** | Authoritative Notes, PDF/DOCX originals, and document companions; only `.md`, `.pdf`, and `.docx` are loaded as documents. Future formats remain roadmap work; manifest/companions are internal metadata. |
| **Local index** | Bounded, cancellable incremental SQLite-derived index; source files remain authoritative and partial states are visible. |

The explorer presents the bounded native Vault inventory and loaded original documents; source files remain authoritative and future workflows follow the [Vault contract](docs/vault-contract.md).

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
