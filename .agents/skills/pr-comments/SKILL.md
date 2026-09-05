---
name: pr-comments
description: Read and triage existing pull request review comments, or address them when requested. Use for PR comment requests or /pr-comments; use review to inspect code without existing reviewer feedback.
---

Turn the requested PR's review feedback into concrete next steps, using the current code to assess each concern.

1. Identify the requested PR, repository, head, and base; use the current branch when no PR is specified. If no matching PR exists or access fails, report that limitation. Do not substitute a local code review for unavailable comments.
2. Fetch inline threads, review summaries, and general comments, including pagination. Preserve comment links and thread resolution state. If resolution metadata is unavailable, mark it unknown.
3. Read the affected code at the current PR head. Distinguish still-applicable concerns, already addressed feedback, and questions requiring a reply. A thread's resolved status and whether the code addresses it are separate facts.
4. Group related feedback without losing distinct requests. Summarize each actionable concern, its evidence, and the smallest useful change; order by impact. If the user requested fixes, implement and validate them using [the contributing guide](../../../docs/contributing.md).
5. Report what remains and link to the original comments. Reply, resolve threads, or post other messages only when the user has authorized those actions; summarize or draft otherwise.
