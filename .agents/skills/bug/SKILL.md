---
name: bug
description: Turn a reported defect into an actionable bug report or issue draft. Use when the user asks to capture or document a bug; a request to fix broken behavior should proceed to diagnosis and repair.
---

Produce a concise report another person can reproduce or investigate. If the user asked for a fix, use the report as working context and continue the repair.

1. Extract the symptom, expected behavior, and reproduction details already supplied. Inspect available logs and relevant code before asking for facts the workspace can provide.
2. Ask only for missing information that materially affects reproduction or diagnosis, such as terminal mode or the triggering input. Continue independent investigation while waiting; label unknowns instead of guessing.
3. Include the symptom in the title, then the smallest known reproduction, expected versus actual result, relevant environment, and impact. Distinguish a reproduction you ran from one reported by the user.
4. Include a cause or workaround only when evidence supports it; label hypotheses and cite the relevant code. Omit empty sections and speculative severity labels.

Keep credentials and private session content out of the report. Drafting a report does not itself authorize posting an issue; use any posting authorization already given in the conversation.
