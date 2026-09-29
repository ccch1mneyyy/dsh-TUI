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

In-TUI equivalent: `/migrate`. Bare `/migrate` opens a **multi-select source
picker** — one row per agent (checkbox + scannable file count + an "active X
min ago" badge, most recently active first): Space toggles, `a` selects
all/none, Enter opens the **confirmation layer** (one line per checked
source with its count and the "existing sessions are skipped automatically,
safe to re-run" note; Enter imports / `d` dry-runs / Esc returns to the
picker), Esc closes. `/migrate <agent>` passes through the same layer (single
source); `/migrate <agent> --dry-run` previews directly since it writes
nothing. The completion notification carries per-source real counters
("imported X · already present Y"). The CLI stays direct for scripts. The import
runs in a child process so the interface never freezes; results arrive
through the notification flow and the output lands in a `/migrate` local
row. Both entry points share the same import logic and idempotency rules.

## Supported sources

| Source | Local store | Notes |
| --- | --- | --- |
| `claude-code` | `~/.claude/projects/` | Lines split from one response (sharing `message.id`) merge into one step; thinking, tool calls and results, compaction summaries, `/rename` and generated titles all migrate; `isMeta` context joins the next step; `subagents/` and auxiliary transcripts are not sessions |
| `codex` | `~/.codex/sessions/` | Tool calls with all three output shapes, reasoning summaries (the readable part), `compacted` summaries, interrupted turns and sub-agent reports migrate; the model is recorded per step from `turn_context`; injected blocks and sub-agent rollouts do not |
| `omp` | `~/.omp/agent/sessions/` | DSH-lineage store, a near-direct mapping (text and thinking) |
| `zcode` | `~/.zcode/v2/sessions/` | Single-JSON-object format; only user/assistant text is mapped, `meta.title` becomes the title |
| `grok-build` | `~/.grok/sessions/` (relocatable via `GROK_HOME`) | Reasoning rows attach to the assistant step that follows; tool calls and results (images as placeholders), compaction summaries, interrupted turns and the `session_summary` title migrate; `<user_query>` and similar wrappers keep only the body; synthetic rows and `<user_info>` do not migrate |

## Behavior contract

- **Read-only source**: migration only reads the foreign agent's local store;
  artifacts are written through the official `JsonlSessionPersistence` into
  `$DSH_HOME/sessions` — imported sessions are first-class (openable,
  continuable, rewindable).
- **Idempotent**: one deterministic UUID (v5) per source conversation.
  Re-importing skips what is already present instead of stacking duplicates
  or rewriting existing logs. Both entry points derive identical session ids
  from the same source data.
- **Structure preserved**: rebuilt turn by turn, one step per model call in
  the source: thinking, text, tool calls and their results sit in the step
  that produced them, so an imported session can pick the work straight up.
- **Wire-legal tool traffic**: each result pairs back by call id to the step
  that made the call (never to the newest step), in call order within the
  step; an unanswered call gets an empty result, a result with no call is
  dropped and counted, and a call id reused across steps is renamed. On
  resume every tool_call is followed by its tool message. One result keeps
  at most 64KB (the rest is cut and noted); images always become an
  `[image]` placeholder.
- **Compaction checkpoints**: a context-compaction boundary in the source is
  written as the same native compaction transaction `/compact` produces. The
  raw events stay in the log; the model sees "summary + what followed", the
  context the source agent itself continued with.
- **Injection filtering**: machine text a harness writes into the user role
  (environment blocks, AGENTS.md instructions, system reminders, local-command
  echoes) opens no turn and never titles a session; `<user_query>`, pasted
  envelopes and similar wrappers keep only their body. Model-visible machine
  context mid-turn (Claude's `isMeta`, Codex sub-agent reports) is kept as
  the next step's input.
- **Titles**: a title the source owns (`/rename`, generated titles,
  `session_summary`, `meta.title`) is written as `session/title`; without
  one the first real prompt serves as a fallback but is not written, so DSH
  derives it from the first user message itself. Titles are collapsed to one
  line and capped at 80 characters.
- **Ready to continue**: like a native session, an imported log reserves an
  empty system head in its first step; on resume the system prompt replaces
  it instead of landing after the imported history.
- **Not migrated**: per-message original timestamps (event times are
  import-time; the session start keeps the source record); the encrypted
  part of Codex reasoning; Grok's provider-side tools
  (`backend_tool_call`).
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

## Source tabs on the session screen

When you do not want a bulk import, browse by source on the session screen
(`/resume`, `/home`, `/agentview`): the title row shows a tab for every source
with conversations, and selecting one **imports just that conversation** and
opens it.

- Parsing is exactly `/migrate`'s, and the session id is derived from the source conversation the same way: both entries land a conversation on the same DSH session, and one already imported simply opens.
- Opening the session screen only checks whether each source has any conversation (each source's walk stops at its first candidate); a source's list is read when its tab is opened, from a summary scan (file heads/tails only). Within one run an unchanged conversation is not read again; no cache file is written.
- A conversation whose working directory no longer exists is not imported; the screen says so, and `/migrate` still imports it in bulk.
- The tabs do not change how `/migrate` or `dsh-tui migrate` behave.

## Smart migration hint

About 12 seconds after the TUI starts, one background pass checks whether any
source saw file writes within the last 20 minutes (newest file mtime per
source) and surfaces a single notification: "Just came from <agent>?
/migrate imports it quickly". The scan is off the render path (sub-second)
and fires at most once per session; a source with no data stays silent. While
the hint is up, Enter (with an empty prompt) jumps straight into the picker
with that source pre-checked; any other key dismisses it.

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

- Parsing is separate from IO: `adapters/<source>.parse.ts` are pure
  functions (raw text → turn model) over shared rules in `parse/` (jsonl
  bad-line counting, injection recognition and unwrapping, title
  normalization, tool-call pairing); adapters only discover files. OMP still
  produces a role list, folded into turns mechanically by `fromRoleTurns`.
- grok's `synthetic_reason` filter: only default and explicitly `human`
  user rows migrate; the summary row among `compaction_meta` becomes a
  compaction checkpoint.
- Claude's legacy (2.0.x) `summary` record is a one-line leaf title at the
  head of a file: it is treated as a title, not a compaction boundary.
- Codex `custom_tool_call` input is free-form (a patch, a JS snippet); it
  migrates wrapped as `{"input": …}` so call arguments stay JSON.
- zcode: no sample with tool traffic or reasoning has been available, so
  only the text roles are mapped and no field is guessed at.
- Timestamp boundary: grok rows carry no per-row time; the session start
  comes from `summary.json`.
- Terminology: "migrate" here means this feature; it is unrelated to the
  package-rename migration from `dsh-cc-tui` (see
  [Getting started](getting-started.en.md)).

Implementation and verification live in `src/dsh-adapter/migrate/`,
`scripts/verify-migrate-parse.mjs` (per-source parsing rules over synthetic
fixtures), `scripts/verify-migrate.mjs` (event synthesis and the round trip
through the official read chain, wire legality and compaction checkpoints
included) and `scripts/verify-migrate-command.tsx` (the `/migrate` interaction
regression, mounted against the real Chat screen).
