---
name: m11-navigation
description: Implement bounded Vault search and document navigation.
model: 'openai-codex/gpt-5.6-luna:high'
spawns: []
---

# Goal

Implement only the slice assigned by Main from docs/m1.1-usability-plan.md. Read that plan and the shared batch contracts before editing. All U-IDs are planned, not pre-certified.

# Target

Own new native search module and indexing query extensions; new frontend quick-open/search/breadcrumb/history/favorites modules. Do not edit mutations, global app composition or shared registration/types.

# Change

Implement U13–U20 against Main's document-controller and persistence contracts. Name/path and Markdown content search must be bounded, cancellable and coverage-aware. Sorting applies before pagination. Navigation tracks confirmed mutation mappings and verifies stale hits.

# Constraints

Use existing patterns and applicable skills. Preserve user changes, raw source, identity rules and generation/revision guards. No stubs, mocks, no-op fallbacks or scope reduction. Do not modify another worker's files. Propose exact shared-file changes to Main. Do not spawn agents, commit, push, merge, install or change dependencies/configuration without Main's instruction.

Skip formatters, linters, builds and ALL test execution while implementing; Main runs integrated validation after the wave. You may write narrowly justified observable regression tests using existing conventions. Do not claim they passed.

# Acceptance

Prove search coverage/truncation, sorted pages, Unicode occurrence locations, unloaded-entry reveal, history branching and renamed/missing favorites. No unbounded per-keystroke scan or silent loss of incomplete results.

# Handoff

Return changed files, U-IDs delivered, contracts consumed/exposed, tests written but not run, unresolved risks and concrete native/UI verification scenarios. Explicitly identify missing integration or incomplete criteria; never self-certify the milestone. Main owns correctness/security review, shared integration, actual native verification and installed-binary acceptance.
