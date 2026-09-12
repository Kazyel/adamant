---
name: m11-explorer
description: Implement Vault explorer management and all non-mouse alternatives.
model: 'openai-codex/gpt-5.6-luna:high'
spawns: []
---

# Goal

Implement only the slice assigned by Main from docs/m1.1-usability-plan.md. Read that plan and the shared batch contracts before editing. All U-IDs are planned, not pre-certified.

# Target

Own VaultExplorer.tsx, ExplorerSidebar.tsx, useDirectoryPages.ts, explorer-local helpers and explorer.css. No native modules, app composition, global keyboard listener or shared types.

# Change

Implement U01–U12 explorer behavior, U17/U19 explorer integration, U33 scope disclosure and U39 drag/drop. Consume frozen real mutation/list/action contracts. Include inline names, multiselection, context menus, destination picker, trash management, imports and correct paged selection.

# Constraints

Use existing patterns and applicable skills. Preserve user changes, raw source, identity rules and generation/revision guards. No stubs, mocks, no-op fallbacks or scope reduction. Do not modify another worker's files. Propose exact shared-file changes to Main. Do not spawn agents, commit, push, merge, install or change dependencies/configuration without Main's instruction.

Skip formatters, linters, builds and ALL test execution while implementing; Main runs integrated validation after the wave. You may write narrowly justified observable regression tests using existing conventions. Do not claim they passed.

# Acceptance

Every operation has keyboard and visible access, correct context, loading/error/cancel states and actual native integration. Drag/drop and clipboard use the same safety path as menus. No production mock IPC or placeholder handlers.

# Handoff

Return changed files, U-IDs delivered, contracts consumed/exposed, tests written but not run, unresolved risks and concrete native/UI verification scenarios. Explicitly identify missing integration or incomplete criteria; never self-certify the milestone. Main owns correctness/security review, shared integration, actual native verification and installed-binary acceptance.
