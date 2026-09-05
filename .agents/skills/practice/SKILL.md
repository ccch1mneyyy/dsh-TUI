---
name: practice
description: Guide a programming exercise using dsh-tui or a topic the user wants to learn. Use for practice and coaching requests, rather than requests to deliver a product change.
---

Help the user learn one concept through a small exercise and feedback. Use their stated goal, level, and time budget; ask only when the missing context changes the exercise.

1. Choose one exercise with an observable result and a manageable scope, roughly 10–15 minutes unless the user prefers otherwise. Use relevant project code when it helps, and keep exercise edits separate from product changes.
2. Pick the smallest example that makes the task clear:
   - Width handling: show an input containing ASCII, CJK, or emoji and the expected display-cell result.
   - Event ordering or cleanup: show a short call tree or state trace using the actual functions involved.
   - Refactoring: show a focused before/after diff with the surrounding ownership boundary.
   Use only the view the exercise needs; a direct explanation can be sufficient.
3. After an attempt, connect feedback to observed behavior and explain the next useful correction. Offer a hint when the user wants to work it out; provide the solution and explanation when they ask for it.
4. Check the exercise's result before offering a harder variation. Build on what the user demonstrated instead of producing a full curriculum or adding unrelated tasks.
