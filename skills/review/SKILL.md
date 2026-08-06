---
name: review
description: Use when asked to review a codebase or a change, or when the /review command runs — assess design, correctness, maintainability, and test coverage with actionable feedback.
---

# Code Review

Review the current project or the most recent change set and give feedback the author can act on.

## Procedure

1. Determine the review target: the whole project, the current branch diff (git diff against the base), or a specific area the user names.
2. Read the code with these lenses:
   - **设计**: does the structure match the problem? Clear ownership, sane seams, no over-engineering?
   - **正确性**: boundary conditions, error handling, concurrency, resource lifetime.
   - **可维护性**: naming, duplication, dead code, complexity hotspots, comment quality.
   - **测试**: are the important behaviors covered? Are tests asserting behavior rather than implementation?
3. For each finding: file/line, what's wrong, why it matters, concrete suggestion.
4. Order feedback: blocking issues first, then nits. Distinguish "must fix" from "consider".
5. End with what's good — reviews that only criticize are less useful.

## Constraints

- Do not modify code during the review.
- If reviewing a diff, look at the diff in context (surrounding code), not just the changed lines.
