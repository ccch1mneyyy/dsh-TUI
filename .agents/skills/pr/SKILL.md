---
name: pr
description: Open or update a pull request in this repository, including writing or rewriting its description. Use for every PR you create or edit here, and for /pr.
---

Ship the current change as a pull request a reviewer can understand from the description alone: why it exists, the shape of the implementation, and what was actually verified.

1. Make sure a code PR has a closing issue: the `issue-link` CI check fails one without it. Docs-only PRs and PRs a maintainer labels `no-issue-needed` are exempt (`docs/contributing.md`). Reuse the issue the work came from; when there is none, open a tracking issue first — title `[功能]`/`[Bug] …`, body with 目标, 范围, and 非目标 sections, as in #919 — and link it.
2. Commit and push. Title the commit and the PR in English, `type(scope): summary` (conventional commits, as in #1110); the commit body is English too. Stage explicit paths only, leave `lib/` and unrelated worktree changes out, and push a branch whose upstream is itself, never `main`. Reuse the PR already open for the branch (`gh pr view`) instead of opening a second one.
3. Read the complete diff against the base, the linked issue, and enough surrounding code to explain ownership and behavior. Collect the verification you actually ran; run what `docs/contributing.md` requires for the changed area when it has not run yet.
4. Write the body from `.github/PULL_REQUEST_TEMPLATE.md`, following the HTML comments in it and then deleting them:
   - **Why the change** is exactly one sentence.
   - **Special things to note** holds 1–3 reviewer warnings; deliberate divergences, omissions, and unrun checks go here.
   - **Change outline** is a visual outline, not prose or a file-by-file changelog: the smallest set of views — file tree, call or data flow, key shapes — each beside one short sentence, `diff` for a changed shape and a full block for a new one. For a terminal-visible change include the real rendered screen as a `text` block, captured headlessly the way the `scripts/verify-*.tsx` regressions render (`renderToScreen` or an `@xterm/headless` terminal).
   - **Verification** lists the commands that ran and their results.
   Write the body in Chinese, plainly, one person to another.
5. Publish with `gh pr create --body-file` or `gh pr edit --body-file`, then confirm the rendered body with `gh pr view`. Report the PR URL, the linked issue, and the CI state.
