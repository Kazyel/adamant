---
name: m11-interaction
description: Implement coherent actions, accessible dialogs, command palette and preferences.
model: '@smol'
spawns: []
---

# Goal

Implement only the slice assigned by Main from docs/m1.1-usability-plan.md. Read that plan and the shared batch contracts before editing. All U-IDs are planned, not pre-certified.

# Target

Own typed action catalog, palette/help/preferences/dialog primitives and interaction-local CSS. Main owns shell composition, global event dispatch and shared DTOs; Explorer owns its local context menu and selection.

# Change

Implement U34–U38 and shared primitives for U11/U12/U32. Use one action vocabulary across menus/palette/shortcuts. Add essential preferences without resetting editor state, actionable error/progress feedback, keyboard focus rules and a shortcut reference.

# Constraints

Use existing patterns and applicable skills. Preserve user changes, raw source, identity rules and generation/revision guards. No stubs, mocks, no-op fallbacks or scope reduction. Do not modify another worker's files. Propose exact shared-file changes to Main. Do not spawn agents, commit, push, merge, install or change dependencies/configuration without Main's instruction.

Skip formatters, linters, builds and ALL test execution while implementing; Main runs integrated validation after the wave. You may write narrowly justified observable regression tests using existing conventions. Do not claim they passed.

# Acceptance

All exposed commands invoke real handlers and share applicability states. Verify correct focus intent and no shortcut interception in unrelated fields/editor contexts through concrete scenarios for Main. No decorative-only controls, generic plugin framework or filesystem implementation.

# Handoff

Return changed files, U-IDs delivered, contracts consumed/exposed, tests written but not run, unresolved risks and concrete native/UI verification scenarios. Explicitly identify missing integration or incomplete criteria; never self-certify the milestone. Main owns correctness/security review, shared integration, actual native verification and installed-binary acceptance.
