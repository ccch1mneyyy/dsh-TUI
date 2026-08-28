---
name: release-notes
description: Use when asked to generate release notes, or when the /release-notes command runs — derive user-facing release notes from the change history since the last release.
---

# Release Notes

Generate user-facing release notes for the current project since the last release.

## Procedure

1. Determine the last release point (git tags) and collect the change set since then (git log / diff of user-facing surfaces).
2. Classify changes:
   - **新功能** (new features)
   - **改进** (improvements / behavior changes)
   - **修复** (bug fixes)
   - **破坏性变更** (breaking changes — call these out first)
   - **内部** (chore/refactor — omit from user-facing notes or fold into a footnote)
3. Write notes in the user's language, focused on what changed for users — not implementation details.
4. Reference issues/PRs where known, keep each bullet one line, group under the sections above.

## Constraints

- Do not fabricate changes — only what the history shows.
- Breaking changes must be listed first, with migration hints.
