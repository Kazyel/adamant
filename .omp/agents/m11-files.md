---
name: m11-files
description: Implement safe Vault file operations, reference updates and recoverable trash.
model: 'openai-codex/gpt-5.6-luna:high'
spawns: []
---

# Goal

Implement only the slice assigned by Main from docs/m1.1-usability-plan.md. Read that plan and the shared batch contracts before editing. All U-IDs are planned, not pre-certified.

# Target

Own new native mutation/trash/reference modules and necessary capability.rs, metadata.rs, notes.rs and persistence.rs changes. Do not edit indexing, IPC registries, session authority or frontend.

# Change

Implement U01–U10 native behavior and U27–U33 integrity contracts in assigned integrated slices: capability-safe creation, prepare/commit mutations, stable versus duplicated identity, syntax-aware reference updates, companion handling, recoverable trash and per-item outcomes. Do not repurpose recovery save_copy as duplication.

# Constraints

Use existing patterns and applicable skills. Preserve user changes, raw source, identity rules and generation/revision guards. No stubs, mocks, no-op fallbacks or scope reduction. Do not modify another worker's files. Propose exact shared-file changes to Main. Do not spawn agents, commit, push, merge, install or change dependencies/configuration without Main's instruction.

Skip formatters, linters, builds and ALL test execution while implementing; Main runs integrated validation after the wave. You may write narrowly justified observable regression tests using existing conventions. Do not claim they passed.

# Acceptance

Real-file behavior tests cover collisions, concurrent external changes, links, companions, physical recursive scope, interrupted multi-file changes and source preservation. Return exact revision/path/identity mappings for Main and the UI.

# Handoff

Return changed files, U-IDs delivered, contracts consumed/exposed, tests written but not run, unresolved risks and concrete native/UI verification scenarios. Explicitly identify missing integration or incomplete criteria; never self-certify the milestone. Main owns correctness/security review, shared integration, actual native verification and installed-binary acceptance.
