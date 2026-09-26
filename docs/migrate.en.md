# Session migration: import conversations from other coding agents

[Documentation index](README.md) · [简体中文](migrate.md)

Bring Claude Code, Codex, OMP, zcode, and Grok Build conversation histories
into the DSH session store. After importing, `/resume` browses and restores
them by their original working directory — switching agents no longer costs
your history.

```sh
dsh-tui migrate                # list per-agent scannable file counts (writes nothing)
dsh-tui migrate claude-code    # import every Claude Code conversation
dsh-tui migrate codex --dry-run  # preview what would land, write nothing
```

In-TUI equivalent: `/migrate`. Bare `/migrate` opens a **source picker** —
one row per agent showing its scannable file count and an "active X min ago"
badge (most recently active first); Enter imports the focused source, Esc
closes. `/migrate <agent> [--dry-run]` skips the picker and runs directly. The import
runs in a child process so the interface never freezes; results arrive
through the notification flow and the output lands in a `/migrate` local
row. Both entry points share the same import logic and idempotency rules.

## Supported sources

| Source | Local store | Notes |
| --- | --- | --- |
| `claude-code` | `~/.claude/projects/` | Thinking traces are preserved per turn |
| `codex` | `~/.codex/sessions/` | Model id carried forward from `turn_context`; encrypted reasoning stays unreadable and is not migrated |
| `omp` | `~/.omp/agent/sessions/` | DSH-lineage store, a near-direct mapping |
| `zcode` | `~/.zcode/v2/sessions/` | Single-JSON-object format; role/timestamps/cwd all present |
| `grok-build` | `~/.grok/sessions/` (relocatable via `GROK_HOME`) | Reasoning sibling rows attach to the assistant turn that follows; `synthetic_reason` injected rows (system reminders, …) are not migrated |

## Behavior contract

- **Read-only source**: migration only reads the foreign agent's local store;
  artifacts are written through the official `JsonlSessionPersistence` into
  `$DSH_HOME/sessions` — imported sessions are first-class (openable,
  continuable, rewindable).
- **Idempotent**: one deterministic UUID (v5) per source conversation.
  Re-importing skips what is already present instead of stacking duplicates
  or rewriting existing logs. Both entry points derive identical session ids
  from the same source data.
- **Structure preserved**: user/assistant messages and thinking traces are
  rebuilt turn by turn; multiple assistant messages inside one turn each get
  their own step.
- **Not migrated**: tool traffic (source formats cannot replay it faithfully
  — the contract is "re-read the conversation", not "resume the task"); and
  per-message original timestamps (event times are import-time; the session
  start keeps the source record).
- **Robustness**: malformed lines, legal JSON `null` (whole-line or nested),
  and files over 64MB are skipped safely; one failed conversation never
  aborts the batch — failures are listed and reported with exit code 1.

## Measured reference (real data, for scale expectations)

| Operation | Scale | Time |
| --- | --- | --- |
| List counts, five sources | ~3000 files | 0.7s (name matching, zero parsing) |
| Import zcode | 60 conversations | 2.3s |
| Import claude-code | 163 conversations (heavy thinking) | 39s |
| Import codex + omp | 728 + 1366 conversations | ~2.5 min |
| Re-import (idempotency) | any | < 1s, all already present |

Browse afterwards with `/resume`: sessions land in per-cwd directories
(named by the official encoding rules); titles and start times are readable;
conversations with thinking render as collapsible reasoning blocks in the
TUI.

## Smart migration hint

About 12 seconds after the TUI starts, one background pass checks whether any
source saw file writes within the last 20 minutes (newest file mtime per
source) and surfaces a single notification: "Just came from <agent>?
/migrate imports it quickly". The scan is off the render path (sub-second)
and fires at most once per session; a source with no data stays silent.

## Troubleshooting

- **`unknown agent`**: the authoritative source list is what bare
  `dsh-tui migrate` prints.
- **`needs the profile's compiled copy`**: the profile's compiled output is
  missing or too old — run `dsh-tui update` first.
- **Imports fewer than the scan count**: the scan count matches candidate
  files by name; import additionally filters unreadable and empty
  conversations, so landing slightly lower is expected.
- **Fresh `DSH_HOME` first run reports installation rejected**: profile
  bootstrap hit a stale npm tarball; upgrading dsh heals it, or use an
  existing profile meanwhile.
- **Nothing found at all**: confirm the foreign agent's data directory
  exists under the current home; set `GROK_HOME` when grok-build lives
  elsewhere.

## Design notes (for maintainers and contributors)

- Titles do not enter artifacts: the pipeline's sessionize step does not
  consume the title field (current behavior across all five sources).
- grok's `synthetic_reason` filter: only default and explicitly `human`
  user rows migrate.
- Timestamp boundary: grok rows carry no per-row time; turns inherit the
  `summary.json` clock.
- Terminology: "migrate" here means this feature; it is unrelated to the
  package-rename migration from `dsh-cc-tui` (see
  [Getting started](getting-started.en.md)).

Implementation and verification live in `src/dsh-adapter/migrate/` and
`scripts/verify-migrate.mjs` （38 checks, all against the official read
chain).
