---
name: pr-comments
description: Use when the user asks to review pull request comments, or when the /pr_comments command runs — fetch and analyze PR review comments on the current branch and summarize actionable items.
---

# Pull Request Comments Review

Review the pull request comments associated with the current branch and turn them into an actionable summary.

## Procedure

1. Identify the PR for the current branch (git remote, branch name → PR). If no PR is found or git hosting tools are unavailable, say so and fall back to reviewing local uncommitted changes.
2. Gather review comments (inline + general) and group them by theme: blocking changes, open questions, nits.
3. For each actionable comment: restate the concern in your own words, locate the affected code, and propose a concrete change.
4. Produce a summary: what the reviewers want changed, what's already addressed, and a suggested order of work.

## Constraints

- Never invent comments — summarize only what is actually there.
- Mark unresolved vs resolved comments explicitly.
