---
name: review
description: Review a code change, pull request, or named area for correctness, maintainability, and unnecessary complexity. Use for review requests or /review; use audit for a repository-wide assessment.
---

Review the requested scope and report actionable findings. If the user also asked for fixes, implement and verify them after establishing the cause.

1. Identify the target and actual base. For a stacked PR, compare with its parent branch; for a local change, include the requested staged or unstaged work. Read changed code with its callers and relevant tests.
2. Trace behavior across the affected boundaries: DSH event projection, channel actions, input precedence, or terminal lifecycle. Check failure paths and resource cleanup, and whether tests cover the changed behavior rather than mirror the implementation. Before calling code dead or an abstraction unnecessary, check exports, dynamic registration, compatibility requirements, and other consumers.
3. Verify each suspected issue against the implementation and existing guards. Report its location, concrete trigger, impact, and smallest useful fix, ordered by severity. Separate demonstrated defects from optional simplifications.
4. Use a short call tree or before/after diff when it explains an ownership or ordering problem more clearly than prose. Show only the affected path and use real symbols from the code.
5. State what was reviewed and any verification limits. If there are no actionable findings, say so; do not manufacture nits or add a compulsory praise section.
