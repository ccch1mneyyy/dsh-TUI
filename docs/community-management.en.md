# Community Management Framework

This document defines how the dsh-TUI community proposes, discusses, tracks, and delivers public work. It does not replace the [contributing guide](contributing.en.md), [Code of Conduct](../CODE_OF_CONDUCT.en.md), or the security reporting process.

## Goals

- Make the project's current priorities visible to users.
- Give contributors a clear path from an idea to an accepted and verifiable change.
- Let maintainers control scope, risk, and compatibility through documented decisions.
- Make public work traceable through Discussions, Issues, PRs, and verification evidence.

## Public Entry Points

| Entry point | Use it for | Output |
| --- | --- | --- |
| Bug form | Reproducible bugs, crashes, and regressions | Bug issue |
| Discussions Ideas | Features, behavior changes, and interaction improvements | Proposal; an accepted proposal gets a tracking issue |
| Discussions Q&A | Installation, configuration, and usage questions | Reusable answer or documentation fix |
| Discussions Show and tell | Plugins, themes, companion projects, and user cases | Community and ecosystem record |
| Roadmap tracker | Public status, owners, dependencies, and exit criteria | Trackable task table |
| Pull request | A scoped implementation with an approved entry point | Reviewable and verifiable change |

The routing follows the current repository rules: feature proposals start in Discussions, bugs do not require prior approval, and code PRs should link to their tracking issue. See the [contributing guide](contributing.en.md).

## Roles

| Role | Responsibility |
| --- | --- |
| Maintainer | Sets scope, accepts or rejects public proposals, maintains the roadmap, and makes final merge decisions |
| Area owner / PIC | Drives a workflow or module, updates status, coordinates verification, and handles handoff |
| Reviewer | Reviews design, behavior, compatibility, tests, and documentation without implicitly owning implementation |
| Contributor | Provides reproductions, documentation, tests, fixes, or approved feature implementations |
| Community member | Provides user feedback, cases, context, and design discussion |

Only assign a PIC when someone is actually responsible. Without an owner and exit criteria, an item stays `Design` or `Not started` rather than being presented as active work.

## Proposal Flow

```text
User problem or idea
  -> Discussion / Bug report
  -> Maintainer scope and value review
  -> Accept / defer / reject
  -> Tracking issue
  -> Design, implementation, and verification
  -> PR review
  -> Merge and release notes
  -> Roadmap update
```

### Minimum proposal information

- Who has the problem and in what workflow;
- current and expected behavior;
- why dsh-TUI should solve it rather than DSH or an external plugin;
- affected users, platforms, and compatibility versions;
- how completion will be verified;
- whether it requires a public API, configuration, or persistence change.

Acceptance does not freeze the implementation. The tracking issue must still define scope, non-goals, dependencies, and exit criteria before implementation starts.

## Roadmap Rules

Public roadmap items must satisfy all of the following:

1. They provide an explainable value to users, contributors, or the ecosystem.
2. They describe a concrete outcome rather than vague improvement language.
3. They can be tracked through one or more Issues.
4. They have a PIC or are explicitly marked as unassigned.
5. They have exit criteria and dependencies.
6. They explain why the work belongs in the current phase rather than Future Work.

Each roadmap task should include:

| Field | Content |
| --- | --- |
| Task | One user-understandable outcome |
| PIC | Current owner, or `TBD` |
| Issue | The single tracking entry for scope and discussion |
| PR | Implementation entry, or `-` before work starts |
| Status | A status from the shared legend |
| Depends on | Prerequisite work or external conditions |
| Exit criterion | Evidence that the task is complete |

The roadmap is a public status surface, not a promise that every item will ship in order. Update it when scope changes, a phase completes, work is deferred, or a task is rejected.

## Status Legend

| Status | Meaning |
| --- | --- |
| `✅ Done` | Merged and verified for the applicable scope |
| `🚧 In progress` | Has an owner and is being implemented or verified |
| `🟡 Design` | Under discussion; implementation scope is not frozen |
| `⚪ Not started` | Confirmed public direction, not started |
| `🧪 Experimental` | Usable for evaluation without a stable compatibility promise |
| `⏸ Deferred` | Deliberately postponed outside the current critical path |
| `❌ Rejected` | Discussed and declined, with the reason retained |

Status changes should leave a short reason in the tracking issue. Only call a task `Done` after the PR is merged and the applicable verification is complete.

## Maintenance Cadence

The following cadence is recommended and can be adjusted to the maintainer team's size:

- Regular triage for new bugs, duplicates, unreproducible reports, and proposal states;
- a roadmap check before each release;
- a phase summary with unfinished work and Future Work when a phase ends;
- an ADR or a decision record in the tracking issue for major design choices;
- marking stale work as `Deferred`, reconfirming its owner, or closing it with a reason.

## Decisions and Conflict Handling

- User feedback informs priority; it does not dictate implementation.
- PR discussions focus on code and evidence, not identity, contribution count, or popularity.
- Maintainers record final scope decisions in the tracking issue.
- Code of Conduct, security, and privacy concerns follow their dedicated channels.
- Private promises must not bypass public process; when an exception is necessary, maintainers should record the public scope in the relevant Issue.

## Health Metrics

Community health should be measured by:

- whether bugs can be reproduced, classified, and closed;
- whether roadmap tasks have owners and exit criteria;
- whether proposals receive timely decisions;
- whether releases include verification and known limitations;
- whether new contributors can make a useful contribution from the documentation;
- whether regressions are recorded and fed into future work.

Stars, PR count, commit count, and activity alone are not the primary measures of progress.
