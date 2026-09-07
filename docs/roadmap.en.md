# dsh-TUI Roadmap

> This file defines the long-term direction. Live task status belongs in the GitHub Roadmap tracker.

## Goal

Build a reliable, recoverable, observable, and extensible DeepSeek Harness terminal workbench for long-running coding and Agent workflows.

## Current Focus

1. Establish a public and trackable community workflow.
2. Improve long-session, recovery, error-handling, and terminal compatibility reliability.
3. Make DSH Agent, session, model, preset, permission, workspace, and plugin capabilities understandable in the terminal.
4. Stabilize extension seams for community themes, commands, scenes, status lines, and workspace plugins.
5. Improve installation, diagnostics, documentation, releases, and contributor experience.

## Non-goals

- Do not use feature count or one-to-one matching with another product as the project goal.
- Do not reimplement Agent, session, sandbox, or policy services already owned by DSH.
- Do not scale the plugin catalog before public APIs are stable.
- Do not put animation, decoration, or user-value-free features on the critical path.
- Do not use stars, PR count, or commit count as primary progress metrics.

## Status Legend

| Status | Meaning |
| --- | --- |
| `✅ Done` | Merged and verified for the applicable scope |
| `🚧 In progress` | Has an owner and is being implemented or verified |
| `🟡 Design` | Direction confirmed, scope still under discussion |
| `⚪ Not started` | Confirmed but not started |
| `🧪 Experimental` | Experimental capability without a stable compatibility promise |
| `⏸ Deferred` | Deliberately postponed outside the current critical path |
| `❌ Rejected` | Discussed and declined |

## Phase 0: Community Baseline

**Goal:** Give every public effort an entry point, owner, tracking Issue, and exit criterion.

| Task | PIC | Issue | PR | Status | Depends on | Exit criterion |
| --- | --- | --- | --- | --- | --- | --- |
| Publish the community management framework | Maintainers | - | - | 🚧 In progress | - | Framework is merged and linked from the documentation index |
| Establish the public Roadmap tracker | Maintainers | TBD | - | 🟡 Design | Community framework | All current-phase tasks have status and tracking entries |
| Align proposal, bug, Q&A, and show-and-tell routing | Maintainers | TBD | - | ⚪ Not started | Roadmap tracker | New users can find the correct channel from the repository entry points |
| Establish phase summaries and Future Work rules | Maintainers | TBD | - | ⚪ Not started | Roadmap tracker | Completed, deferred, and rejected work are distinct at phase close |

## Phase 1: Reliability and Recovery

**Goal:** Let users start, work, pause, resume, and diagnose failures reliably.

| Task | PIC | Issue | PR | Status | Depends on | Exit criterion |
| --- | --- | --- | --- | --- | --- | --- |
| Long-session stability and memory bounds | TBD | TBD | - | ⚪ Not started | Phase 0 | Focused regressions cover long transcripts, streaming, and scrolling |
| Error handling for session resume, rewind, and fork | TBD | TBD | - | ⚪ Not started | Phase 0 | Failure paths provide a clear cause and recovery path |
| `/doctor` diagnostics for model, preset, and permission state | TBD | TBD | - | ⚪ Not started | Phase 0 | Common configuration failures can be located inside the TUI |
| Windows Terminal, ConPTY, inline, and fullscreen matrix | TBD | TBD | - | ⚪ Not started | Phase 0 | Supported environments and known limitations are documented |
| Terminal cleanup after restart and abnormal exit | TBD | TBD | - | ⚪ Not started | Phase 0 | Success, failure, and interruption paths have regression evidence |

## Phase 2: DSH-Native Workflows

**Goal:** Make DSH core capabilities understandable, usable, and recoverable in the terminal.

| Task | PIC | Issue | PR | Status | Depends on | Exit criterion |
| --- | --- | --- | --- | --- | --- | --- |
| Agent, model, and preset state presentation | TBD | TBD | - | ⚪ Not started | Phase 1 | Users can confirm the runtime configuration of the current work |
| Explainable permission and approval state | TBD | TBD | - | ⚪ Not started | Phase 1 | Permission failures explain policy, scope, and next steps |
| Unified Agent view, subagent, and background-job workflow | TBD | TBD | - | ⚪ Not started | Phase 1 | Background work can be inspected, resumed, stopped, and identified |
| Consistent goals, todos, and activity projection | TBD | TBD | - | ⚪ Not started | Phase 1 | State comes from session/event truth and has regression coverage |
| Workspace switching and session association | TBD | TBD | - | ⚪ Not started | Phase 1 | Switching, persistence, and failure paths are documented |

## Phase 3: Extension Ecosystem

**Goal:** Let the community build maintainable extensions inside stable boundaries.

| Task | PIC | Issue | PR | Status | Depends on | Exit criterion |
| --- | --- | --- | --- | --- | --- | --- |
| Public documentation for stable plugin API and test-utils | TBD | TBD | - | 🟡 Design | Phase 2 | Each public seam has a stability level, example, and verification method |
| Templates for theme, command, scene, and status-line plugins | TBD | TBD | - | ⚪ Not started | API documentation | A new author can build a minimal plugin from a template |
| Plugin compatibility checks and diagnostics | TBD | TBD | - | ⚪ Not started | API documentation | Incompatible plugins report a clear reason |
| Ecosystem catalog and community examples | TBD | TBD | - | ⚪ Not started | Plugin templates | Community plugins have consistent metadata and a discovery entry |

## Phase 4: Documentation and Release Quality

**Goal:** Make installation, upgrade, diagnosis, and contribution predictable.

| Task | PIC | Issue | PR | Status | Depends on | Exit criterion |
| --- | --- | --- | --- | --- | --- | --- |
| Installation, upgrade, recovery, and troubleshooting guides | TBD | TBD | - | ⚪ Not started | Phase 1 | The new-user path matches actual commands |
| Supported-platform and upstream-version matrix | TBD | TBD | - | ⚪ Not started | Phase 1 | Support scope can be checked before a release |
| Release checklist, change summaries, and known limitations | TBD | TBD | - | ⚪ Not started | Phase 0 | Every release has reviewable verification records |
| Security, maintenance ownership, and contributor documentation | TBD | TBD | - | 🚧 In progress | Phase 0 | Community entry points, responsibilities, and security channels are clear |

## Future Work

The following items are outside the current critical path and should be reevaluated only after the prerequisite phases are stable:

- More complex remote runtimes;
- a large official plugin collection;
- additional terminal graphics protocols and decorative features;
- a cross-frontend unified workbench;
- independent Agent services beyond DSH's current capability boundary.

## Update Policy

- Roadmap status follows the tracking Issue and merged verification results.
- Update phase summaries and Future Work when a phase ends.
- Record scope changes, deferrals, and rejections in the relevant Issue.
- Team-internal implementation strategy, refactoring plans, and non-public technical details do not belong in this public roadmap.

Last updated: 2026-09-07
