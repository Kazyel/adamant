---
name: m11-session
description: Implement independent document tabs, session persistence and draft recovery.
model: 'openai-codex/gpt-5.6-luna:high'
spawns: []
---

# Goal

Implement only the slice assigned by Main from docs/m1.1-usability-plan.md. Read that plan and the shared batch contracts before editing. All U-IDs are planned, not pre-certified.

# Target

Own document/tab controller, buffer.ts, WorkspaceTabs.tsx, new native workspace/draft persistence and necessary Markdown editor integration. Main owns useWorkspace.ts, workspaceEvents.ts and remembered-Vault authority.

# Change

Implement U21–U26 and persistence support for U18/U20/U36. Preserve independent CodeMirror state/history and typed document viewers. Save remains explicit; drafts never overwrite source automatically. Guard all affected dirty tabs and referrers during file operations.

# Constraints

Use existing patterns and applicable skills. Preserve user changes, raw source, identity rules and generation/revision guards. No stubs, mocks, no-op fallbacks or scope reduction. Do not modify another worker's files. Propose exact shared-file changes to Main. Do not spawn agents, commit, push, merge, install or change dependencies/configuration without Main's instruction.

Skip formatters, linters, builds and ALL test execution while implementing; Main runs integrated validation after the wave. You may write narrowly justified observable regression tests using existing conventions. Do not claim they passed.

# Acceptance

Cover close/switch cancellation, independent histories, edits arriving during save, per-document Save all failure, interruption/recovery against changed source, copied-root isolation, invalid local state and privacy permissions. Report shared integration needed; do not silently fall back to one buffer.

# Handoff

Return changed files, U-IDs delivered, contracts consumed/exposed, tests written but not run, unresolved risks and concrete native/UI verification scenarios. Explicitly identify missing integration or incomplete criteria; never self-certify the milestone. Main owns correctness/security review, shared integration, actual native verification and installed-binary acceptance.
