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

**Early development · M0 technical workbench.** The desktop application runs, but the full workspace is not implemented yet.

> **Notes are not saved yet.** The current Markdown buffer exists only in memory. Copy anything you want to keep before closing the application. Vault creation, persistence, and a filesystem explorer are planned for M1.

### Available now

- **Markdown workbench:** editing, sanitized reading preview, and split view, with bundled fonts and a collapsible document explorer.
- **Local document previews:** PDF navigation, zoom, and text selection; approximate DOCX rendering; native file selection and external opening. Files are limited to 64 MiB.
- **Connection checks:** real, read-only GitHub and Jira Cloud identity requests, with successful credentials saved through the OS credential store. This does not yet synchronize work items.
- **A focused desktop interface:** an Obsidian-inspired layout, deep black surfaces, purple accents, and a restrained WebGL atmosphere. Reduced motion and a static graphics fallback are supported.

### Still to validate

The Linux production build, browser interactions, and system WebKitGTK text rendering have been exercised. Full native document workflows, authorized GitHub/Jira access and credential persistence, and representative performance measurements remain part of M0 acceptance. Other operating systems are not yet verified.

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
| **M0 · Technical validation** | Exercise the desktop editor, document viewers, and account/credential boundaries. | Implemented; acceptance checks remain |
| **M1 · Vault & Markdown** | Create/open portable Vaults; save notes safely; recognize external edits and conflicts. | Next |
| **M2 · Work context** | Follow GitHub issues/PRs and Jira tasks, link notes, and consult cached context offline. | Planned |
| **M3 · Document library** | Preserve originals, attach Markdown annotations, and capture technical documentation. | Planned |
| **M4 · Knowledge navigation** | Connect Topics, folders, tags, references, and resumption points. | Planned |
| **M5 · Local calendar** | Plan local events and study blocks, with iCalendar import/export. | Planned |
| **M6 · Today** | Bring priorities, events, and the next activity into one view. | Planned |
| **M7 · Portable desktop release** | Package, export, move, and reopen the workspace on another installation. | Planned |

Google Calendar synchronization, remote writes to GitHub/Jira, in-app PDF/DOCX editing, and a plugin platform are outside the current roadmap. AI-friendly means portable, inspectable data—not a built-in chatbot or mandatory AI service.

## Architecture

One desktop application, with explicit boundaries rather than independently deployed services:

| Layer | Technology and responsibility |
| --- | --- |
| **Interface** | React, TypeScript, and Vite inside Tauri 2's system WebView. |
| **Editor and viewers** | Monaco, Marked, DOMPurify, PDF.js, and docx-preview. |
| **Native core** | Rust commands for bounded file access, identity requests, secure credentials, and external opening. |
| **Portable Vault — planned** | Authoritative Markdown, metadata, attachments, references, and local events. |
| **Local index — planned** | Rebuildable SQLite indexes and external-service caches; not the source of truth. |

The current explorer shows the in-memory Markdown buffer and selected original document, not a simulated Vault tree. Future Vault operations follow the [Vault contract](docs/vault-contract.md).

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
