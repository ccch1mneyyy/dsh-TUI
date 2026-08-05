# @deepseek-ai/dsh-cc-tui

Claude Code style interactive TUI front door for DeepSeek Harness agents,
built on the **ported Ink core** — the React terminal renderer that Claude
Code's TUI is made of (reconciler, yoga layout, termio parser, differential
rendering). The Ink core is a nearly verbatim copy of the renderer that was
accidentally published with Claude Code's source; the harness-side screens and
channel wiring are written fresh for DSH.

> Personal-use port. The Ink-derived code is proprietary to Anthropic and has
> no open-source license; do not publish this package in a public registry.

## Layout

```
src/
├── ink/                    # Ported Ink core (renderer/yoga/termio/components/hooks)
├── native-ts/yoga-layout/  # Pure-TypeScript yoga port the Ink core lays out with
├── utils/                  # Minimal shims replacing CC app code (debug/log/env/...)
├── bootstrap/state.ts      # Interaction-time stubs (CC telemetry is not ported)
├── ui.ts                   # Themed public surface (ThemedBox/ThemedText + Ink hooks)
├── theme.ts                # Full CC dark theme (verbatim palette from the leak)
├── channel.ts              # DSH adapter: session/event → transcript rows, followup → send
├── cc/                     # Ported CC utilities (markdown, figures, spinner verbs, format)
├── hooks/                  # useBlink (ported)
├── components/             # MessageList, PromptInput, WorkingSpinner, messages/, design-system/, Spinner/
├── screens/                # Chat (fullscreen layout), StatusLine (footer)
└── index.tsx               # Cordis plugin entry (name/inject/Config/apply)
```

The runnable composition lives in
[`examples/cc-tui-agent/`](../../../examples/cc-tui-agent/README.md) — the
leaf's `cordis.yml` supplies the agent spine, DeepSeek adapter, and tool
plugins, and `scripts/run.ts` boots it through `dsh-app-boot`.

## DSH mechanism integration

Every harness-facing behavior rides a DSH service or event stream — nothing
parallel is persisted or executed around the framework:

| Surface | DSH mechanism |
| --- | --- |
| Transcript | `agent.session.events` replay + live `session/event` (session log) |
| Send / interrupt | `Agent.followup` / `Agent.cancel` (turn semantics) |
| `/resume` list | `sessionPersistence.list()` (`dsh-session-persistence-jsonl`) |
| `dsh-cc --resume` | `ctx.agents.resume()` — real log replay from persistence |
| Rewind (double-Esc) | `ctx.sessions.fork` boundary + `ctx.agents.create` on the seed |
| `!` / `!!` local commands | `ctx.bash` (`BashExecutor.resolve`/`run`, `dsh-bash-local`) |
| `@` file completion | `ctx.fs` (`FileSystem.resolve`/`listDir`, `dsh-fs-local`) |
| Git branch breadcrumb | `ctx.bash` |
| `/compact` | `ctx.compact.compactNow` (`dsh-compact-basic`) |
| `/model` candidates | `ctx.llm.listModels` |
| Token totals / context % | `assistant/message.usage` + `request/context.contextWindow` events |
| Session title | `session/title` event |
| Boot / teardown | `dsh-app-boot` on the leaf `cordis.yml`; `ctx.root.fiber.dispose()` |

Services are read via `ctx.get` at use time (cordis' lazy service lookup), so
a leaf without e.g. `fs` or `compact` degrades gracefully instead of failing
to load. Local-only state (input history `~/.dsh-cc/history.jsonl`, the
`resume.txt` launcher handoff, terminal chrome) follows CC's own conventions
— DSH has no counterpart for those.

## Run

```sh
DEEPSEEK_API_KEY=sk-... pnpm --filter @deepseek-ai/dsh-cc-tui run tui
```

Or, from any terminal on this machine, use the launcher:

```sh
dsh-cc        # requires this repo directory in PATH, or run D:\code\projects\test-ccch1mneyyy\dsh-cc.cmd
```

`dsh-cc.cmd` (repo root) `cd`s into the workspace, loads `DEEPSEEK_API_KEY`
from the environment or a workspace `.env`, and boots
`examples/cc-tui-agent/cordis.yml` through `tsx` (a global install is
required: `npm install -g tsx`).

Boots `examples/cc-tui-agent/cordis.yml` and hands the terminal to the TUI.
`Ctrl+C` exits (the plugin disposes the app tree, then exits the process). Set
`CC_TUI_DEBUG=1` for renderer diagnostics, `CC_TUI_DISABLE_MOUSE=1` to turn
off mouse handling. `scripts/probe.ts` imports every leaf plugin the way the
Loader does, for diagnosing assembly failures.

> Environment note: the workspace `node_modules` links are created by the
> Windows-side pnpm. Running `pnpm install` from WSL replaces them with
> WSL-only symlinks that Windows Node cannot read — if `dsh-cc` starts
> failing with `ERR_MODULE_NOT_FOUND`, rerun `pnpm install --no-frozen-lockfile`
> from a Windows shell.

## Build & smoke

```sh
pnpm --filter @deepseek-ai/dsh-cc-tui run build   # tsc -> lib/types (no bundler needed)
pnpm --filter @deepseek-ai/dsh-cc-tui run smoke   # headless render check over in-memory streams
```

The package is tsc-only: `main`/`exports` point at `lib/types/index.js`, so
the plugin runs as plain Node ESM with dependencies resolved from
`node_modules`. There is no `tsdown.config.ts` (the repo's bundler path needs
per-platform rolldown bindings; drop one in later if you want a single-file
marketplace artifact).

## UI surface (ported from Claude Code)

The chat screen is a faithful port of the CC fullscreen layout (`src/screens/Chat.tsx`,
`FullscreenLayout`/`StickyPromptHeader`/`NewMessagesPill` from the leak):

- **Fullscreen layout** (alt screen, `config.fullscreen`, default on):
  transcript in a scrollable `ScrollBox` under the header splash — the
  DeepSeek pixel whale (a 24×18 true-color sprite rendered with half-block
  `▀`/`▄` cells at 24×9, `Whale.tsx`) beside the wordmark (`✦ dsh-cc` with
  a shimmer sweep + version), the `DEEPSEEK`/`HARNESS` tagline in a 5-row
  block font (`bigfont.ts`: brand-blue → ice-blue horizontal gradient with
  a white flowing highlight), the active `model · Max effort` line, the
  session cwd, and the startup tip (`Tip: /model … /help … Tab …`); below
  the block sits the `探索未至之境！` welcome line in ice blue with a white
  sweep (`LogoV2.tsx`). Narrow terminals (< 64 cols) drop the whale and
  keep the text column. The current turn's prompt is **pinned above the
  viewport while you scroll up** (`❯ text` on the user-message grey, click
  jumps back to it); a `↓ N new messages` pill
  (Enter jumps back to bottom); the working spinner, bordered prompt input and
  status line are pinned at the bottom.
- **Status line** (footer, three rows): row 1 spreads the status fields
  apart — left group `model · tps · effort · cache N.N% · tokens in→out`,
  right group `git branch · cwd · session title` right-aligned. Contrast is
  tuned per field: the left-group values sit at soft white
  (`inactiveShimmer`), the git branch in muted steel blue, and
  separators stay dim. The cache figure is the **hit rate** of the context
  fed to the model (read / (input + read + write), one decimal). The tps
  readout follows [pi-tps-meter](https://www.npmjs.com/package/pi-tps-meter):
  a live 1/8-cell gauge (`▕███████▋···▏ 47 tps`) while streaming, then a
  min-max normalized sparkline (`▁▄▇▅▂▁▇█▅▃▆▇ 42 tps`) once messages have
  samples — one number only, colored green ≥ 50 tps, yellow ≥ 20, red
  below. Row 2 is the
  [pi-nano-context](https://www.npmjs.com/package/pi-nano-context)-style
  segmented context bar on its own full-width line — DeepSeek blue palette
  (deep navy → brand blue segments per content type: system/prompt/
  assistant/thinking/tools, labels shrinking to fit), the free remainder in
  white with the usage readout (`ctx 748/1.0M 0.1% 999k`) right-aligned.
  Row 3 is the mode hint (`esc to interrupt` while working,
  `? for shortcuts` when idle). Effort comes from
  the `request/header` call config (seeded at startup by the plugin's
  `effort` config key), cache read tokens and the context total
  (input + cache hits) from `assistant/message.usage`, the window from
  `request/context`, and segment shapes from a chars/4 estimate over the
  session log.
- **Working-activity line** (replaces the CC random-verb spinner slot while
  a turn runs; the status bar shows the idle turn-summary card): when the
  leaf mounts [`dsh-working-activity`](../../activity/working-activity/README.md),
  the live working line — waiting/thinking copy, the running tool, the `⏵`
  self-narration — renders in the spinner slot above the input (with the
  spinner's `↓ N tokens` counter preserved as a suffix), consuming the
  plugin's log-only `activity/status` session events (no plugin code
  shared; the web UI and cc-tui render the same source). Rendered
  pi-working-activity style: an animated indicator (28 presets,
  `config.activityFrames`, default `claude`), a white shimmer sweep over
  the line, and an amber/red `⚠ 上下文N%` prefix when context pressure
  passes 80%/95% (computed locally from `lastUsage` + `contextWindow`).
  Once idle, the turn summary (`搞定 ✓ · N 工具 · 想Xs 干Ys`) sits on the
  status line. The `⏵` self-narration first line is stripped from the
  transcript body (it lives in the working line). Before the first
  activity event — or with `activity: false` — the classic CC verb spinner
  still renders.
- **Themed palette**: the full CC dark theme (`src/theme.ts`, verbatim RGB
  values) resolved through ported design-system wrappers (`ThemedBox`,
  `ThemedText`) — every CC color key (`claude`, `subtle`, `inactive`,
  `userMessageBackground`, …) works in ported components.
- **Transcript**:
  - user prompts: `❯ text` on the `userMessageBackground` grey block
    (`UserPromptMessage`);
  - assistant replies: `● ` bullet + the ported Markdown pipeline
    (`src/cc/markdown.ts` — marked lexer + ANSI formatter + cli-highlight
    syntax highlighting; bold/headings/code/lists/links); **tables render as
    bordered flexbox tables** with column sizing, cell wrapping and a
    vertical key-value fallback on narrow terminals (`MarkdownTable.tsx`,
    verbatim from the leak);
  - thinking: folded `∴ Thinking (ctrl+o to expand)` after the turn settles,
    but **streaming reasoning renders expanded live** and only folds when the
    turn ends (Ctrl+O or a single-row expansion keeps it open; the folded
    label carries the settled duration — `∴ Thinking · 12s`); Ctrl+O shows the full
    reasoning text indented and dim (`AssistantThinkingMessage`);
  - tool cards: blinking `●` status dot (green ✓ / red on error), **bold tool
    name** (`Bash`, `Read`, …), `(args)` suffix, then `Running…` or the
    result/error line; results use CC's line truncation — first 3 wrapped
    rows plus a dim `… +N lines (ctrl+o to expand)` hint, Ctrl+O shows the
    full output (`AssistantToolUseMessage` + `ToolUseLoader` +
    `src/cc/terminal.ts` from the leak);
  - interruptions: a dim `Interrupted · What should Claude do instead?` row
    when a turn is stopped (`InterruptedByUser.tsx`).
- **Working spinner** (ported `Spinner/SpinnerAnimationRow`): the `·✢*✶✻✽`
  glyph in claude-orange, a random verb with a moving shimmer highlight
  (`Topsy-turvying…`), and `(elapsed · ↓ N tokens · thinking)` status parts
  with a smooth animated token counter; turns red when stalled.
- **Prompt input** (CC chrome): rounded border box (top+bottom lines only,
  `promptBorder` grey), `❯ ` prompt char (dimmed while working), the dim
  CC example-command placeholder (`Summarize the changes in this branch`)
  with an inverted-block cursor on its first char, block cursor at the
  caret, ←/→ cursor movement, ↑/↓ history, Esc
  clears, Enter submits (Windows ConPTY whole-line delivery also submits).
  **Multi-line + wrap**: Shift+Enter inserts a newline, ↑/↓ move between
  lines, long lines wrap automatically (CJK-aware hard wrap at the input
  width), and the visible window scrolls to keep the caret row on screen
  past 5 visual rows (CC's maxVisibleLines behavior).
- **Message-selection mode** (CC's Shift+↑ message actions): Shift+↑ enters
  selection (highlighting rows in `messageActionsBackground`), ↑/↓ move
  between messages, Enter expands/collapses the selected row on its own,
  Esc exits; rows also toggle on click in mouse-capable terminals.
- **`!` local commands** (CC's `!` mode): `!cmd` runs the command on the
  user's machine (`cmd /c` on Windows, `sh -c` elsewhere) and renders the
  echo (`! cmd` in bash-border pink) plus the truncated output in the
  transcript — never sent to the model; `!!cmd` additionally sends the
  output to the model as a user message in CC's `<bash-stdout>` envelope.
- **Slash commands**: typing `/` opens the CC suggestion overlay (name column
  padded + truncated description, selected row in the `suggestion` color —
  ported `PromptInputFooterSuggestions`); ↑/↓ move the selection, Tab
  completes, Enter runs. Built-ins: `/clear`, `/help`, `/model`,
  `/thinking`, `/tokens`, `/exit` (`src/commands.ts` — the seam where
  `ctx.commands` integration lands).
- **Session resume** (`/resume`): lists sessions through **DSH's own
  persistence seam** — the leaf mounts `dsh-session-persistence-jsonl`
  (`~/.dsh-cc/sessions/`, one durable JSONL log per session), `/resume`
  opens a CC-style picker of `sessionPersistence.list()` results (title +
  time, `✓` on the current session); choosing one marks it in
  `~/.dsh-cc/resume.txt`, and `dsh-cc --resume` boots with
  `DSH_CC_RESUME_SESSION`, which `ctx.agents.resume()` turns into a real
  log-replay of the persisted transcript. A dedicated two-stage probe
  (`scripts/pty-resume-probe.mjs`) boots the TUI, messages the agent, exits,
  marks the session, reboots — and verifies the old transcript replays.
- **Compaction** (`/compact`, CC's `/compact`): calls the leaf's
  `ctx.compact.compactNow()` (the `dsh-compact-basic` service wired in the
  example leaf) to summarize and shrink the session history; busy turns are
  rejected with a warning, failures surface as red notifications, and a leaf
  without a compaction service explains itself instead of failing silently.
  The compaction checkpoint (dsh-compact's `COMPACT_CHECKPOINT_SOURCE`
  user message) renders as a `Conversation compacted` Divider plus the dim
  summary block, mirroring CC's post-compact transcript.
- **Dialogs** (CC's Pane + Select chrome, ported from the leak's
  design-system): `/model`, `/resume` and `/thinking` open permission-blue
  Pane dialogs — a colored Divider top line, a bold title, Select rows with
  `❯` focus pointer / `✓` selected checkmark / indented descriptions
  (`ListItem.tsx`), and the dim `Enter to confirm · Esc to exit` hint line.
- **Model picker** (`/model`): lists the provider's advertised models via
  `ctx.llm.listModels()`; shows CC's `LoadingState` (animated glyph +
  `Loading models` + subtitle) while the catalog loads; ↑/↓ move, Enter
  confirms, Esc cancels. The agent's model is fixed at creation, so a
  selection notifies `restart dsh-cc to apply`.
- **Thinking dialog** (`/thinking`): CC's `Toggle thinking mode` dialog
  (Enabled/Disabled with descriptions); choosing `Disabled` hides the
  `∴ Thinking` rows for the session. Mid-conversation toggles go through
  CC's confirmation step (warning text + Enter confirm / Esc cancel).
- **History search** (Ctrl+R): CC's `historySearch` dialog — every submit is
  persisted to `~/.dsh-cc/history.jsonl` (deduped, capped at 200); Ctrl+R
  opens the permission-blue Pane with the `⌕` SearchBox (block cursor,
  `Type to search…` placeholder, ported `SearchBox.tsx`), live substring
  filtering of the history as ListItem rows (relative age description:
  `now`/`5m ago`/`2h ago`), ↑/↓ navigate, repeated Ctrl+R jumps to the next
  match (CC's `historySearch:next`), Enter fills the prompt input, Esc or
  Ctrl+C cancels.
- **Editing keys** (CC/readline): Home/End, Ctrl+A/E (line start/end),
  Ctrl+U (delete to line start), Ctrl+K (delete to line end), Ctrl+W
  (delete word), **Ctrl+←/→ jump word boundaries** (readline alt+b/f);
  double-tap Esc clears a non-empty input (CC semantics).
- **Rewind** (CC's "Double-tap esc to rewind the code and/or conversation to
  a previous point in time"): double-tap Esc on an **empty** input opens a
  picker of your past messages (newest first); picking one and confirming
  forks the session through just before that message's turn, swaps in a
  fresh agent on the forked history, and puts the message back into the
  input for re-editing (`channel.rewindTo` — forks via the session store's
  `fork` boundary; queued followups inside an aborted turn settle first).
- **`@` file completion**: typing `@` deep-scans the session cwd (up to 3
  levels, skipping `node_modules`/`.git`/`dist`/`build`, capped at 100
  entries) and shows CC-style `+ name` suggestions with a file/directory
  tag; matching works on the relative path prefix **or** the basename
  (`@src/ink` and `@ink` both find `src/ink/Box.js`); up/down move, Tab
  completes `@name `.
- **Hover polish** (CC's `userMessageBackgroundHover`): the sticky prompt
  header and the `↓ N new messages` pill brighten on hover; rows expanded
  on their own (message-selection mode) keep a persistent hover-grey
  background like CC's VirtualMessageList.
- **Help menu**: `?` opens the CC three-column shortcut help
  (`PromptInputHelpMenu` layout), Esc or typing dismisses it.
- **Notifications**: CC's floating layer — transient messages float one row
  above the prompt border (absolute-positioned, right-aligned, zero layout
  height), turn errors in red, command results dim; auto-dismiss after a few
  seconds (`channel.notify`, `NotificationItem`).
- **Ctrl+C semantics** (CC double-press): while working, Ctrl+C aborts the
  turn via `Agent.cancel({ kind: 'user' })` and prints the dim
  `Interrupted · What should Claude do instead?` row; while idle, the first
  Ctrl+C arms an exit (`Press Ctrl+C again to exit`) and the second exits.
  **Esc also interrupts** a running turn (CC's `chat:cancel` — the prompt
  input keeps its idle-only double-Esc meaning: clear, or open the rewind
  picker on an empty input); **Ctrl+D** exits with
  the same double-press semantics (CC's `app:exit`); **Ctrl+L** clears and
  repaints the screen (CC's `app:redraw`).
  `render()` runs with `exitOnCtrlC: false` so the UI owns the key.
- **Streaming**: assistant text renders through the ported
  `StreamingMarkdown` (stable-prefix split — only the final block re-parses
  per delta, no flicker).
- **Long-session cap**: past 300 rows older messages fold behind a CC-style
  Divider (`ctrl+e to show N previous messages`); Ctrl+E expands them all
  (CC's MAX_MESSAGES_WITHOUT_VIRTUALIZATION behavior).
- **Transcript search** (`/`, CC's REPL incsearch): in transcript mode
  (Ctrl+O expanded) `/` opens the less-style search bar — incremental
  matching over user/assistant/thinking/tool/local rows with a screen-space
  inverse highlight on every hit, a block cursor in the query line, the
  `current/count` counter (red `no matches` when nothing hits), Enter
  commits (0-match queries don't persist), Esc/ctrl+c cancels back to the
  pre-search scroll position, and `n`/`N` keep walking the matches after
  the bar closes (`TranscriptSearchBar.tsx` in Chat).
- **Transcript metadata** (Ctrl+O): like CC's transcript mode, assistant
  text rows show a right-aligned `HH:MM · model` metadata line
  (`MessageTimestamp` + `MessageModel` from the leak).
- **Status line / footer**: `model · in→out tok · git · cwd · title` on top;
  below it `esc to interrupt` while working or `? for shortcuts` when idle.
- **Context warning** (CC's `TokenWarning`): when the model route advertises a
  context capacity (`request/context` events), a completed turn whose input
  usage passes `contextWindow − 20k` tokens pops a one-shot amber
  `Context low (N% remaining)` notification — CC's
  `WARNING_THRESHOLD_BUFFER_TOKENS` semantics.
- **Terminal tab title** (CC's `AnimatedTerminalTitle`): the session title
  when set, else `dsh-cc`, prefixed with a `⠂/⠐` spinner while a turn is
  working (960ms cadence, only while the terminal is focused) and a static
  `✳` when idle.
- **Markdown**: the leak's `Ansi` span parser drops SGR 1 (bold), so the
  Markdown component renders the ANSI string inside raw `Text` instead.

## Extend

- **Screens**: add or replace components under `src/screens/`; the ported Ink
  core supplies `Box`, `Text`, `ScrollBox`, `Spacer`, `Newline`, `useInput`,
  `useStdin`, `useAnimationFrame`, `useBlink` via `src/ui.ts`.
- **Row rendering**: `src/channel.ts` maps `session/event` records to
  transcript rows; extend the `renderEvent` switch for new event types
  (e.g. `todo/write`, `llm/retry`, context cards).
- **Commands**: extend `src/commands.ts` with more local commands, or wire
  `ctx.commands` into `runCommand` (the DSH command registry is
  human-command neutral; this TUI is one consumer).
- **Input**: `PromptInput` is a line editor with history + command
  completion; the CC source ships a full editor/autocomplete stack under
  `src/components/PromptInput/` in the leak if you want to port that later.
- **Reference extraction**: `extract-maps.mjs` (D:\root) recovers original
  TS sources from the leak's inline sourcemaps into `.leak/` (gitignored) for
  future component ports — e.g. `VirtualMessageList`, `PromptInputFooter`,
  `design-system/Pane`, `LogoV2`.

## Known Limitations (v0)

- Injected context rows (`user/message` with non-user source) are skipped.
- The agent's model is fixed at creation; `/model` only notifies
  `restart dsh-cc to apply`.
- TUI exit calls `process.exit(0)` directly; graceful agent flush is deferred.
- Sticky header/pill depend on the ScrollBox wheel events (mouse tracking);
  keyboard-only users get the pill's Enter-to-jump path.
- The e2e harness (`scripts/pty-e2e.mjs`) must set `TERM`/`COLORTERM` in the
  spawned env — `cmd.exe` leaves them unset and chalk drops to level 0.
- Probe scripts: `pty-narrow-probe.mjs` (80-col layout, help menu must not
  wrap), `pty-cjk-probe.mjs` (Chinese + mixed-width input rendering),
  `pty-resume-probe.mjs` (two-stage boot → message → exit → resume replay),
  `pty-int-probe.mjs` (interrupt row), `pty-meta-probe.mjs` (Ctrl+O
  metadata), `pty-e2e-keys.mjs` (editing keys), `pty-e2e-multiline.mjs`
  (multi-line + selection), `pty-rewind-probe.mjs` (double-Esc rewind:
  picker → confirm → forked session → post-rewind turn).
- Rewinding right after interrupting a long thinking turn waits for the
  aborted `turn/end` to land (up to 30s) before forking; the fork boundary
  sits before the chosen message's `turn/start`, so the message itself
  returns to the input for re-editing.
