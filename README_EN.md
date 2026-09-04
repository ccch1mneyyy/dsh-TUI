<p align="center">
  <img src="docs/assets/logo.svg" alt="dsh-TUI - DeepSeek Harness terminal interface" width="560">
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui"><img alt="npm" src="https://img.shields.io/npm/v/@deepseek-harness-tui/dsh-tui?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/ccch1mneyyy/dsh-TUI/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ccch1mneyyy/dsh-TUI/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="Public beta" src="https://img.shields.io/badge/status-public%20beta-7da1de?style=flat-square">
  <a href="https://github.com/ccch1mneyyy/dsh-TUI/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/ccch1mneyyy/dsh-TUI?style=flat-square&color=4b6fff"></a>
  <a href="https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@deepseek-harness-tui/dsh-tui?style=flat-square&color=4b6fff"></a>
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/146168" title="GitHub Trending Daily #7 · TypeScript"><img alt="Trendshift" src="https://trendshift.io/api/badge/trendshift/repositories/146168/daily?language=TypeScript"></a>
</p>

# dsh-TUI

`dsh-TUI` is an interactive terminal front door for DeepSeek Harness. It is
mounted as a Cordis plugin and provides a Claude Code-style conversation, tool,
session, and fullscreen terminal experience while continuing to use the
official DSH agent, model, tool, session, and persistence services.

The project does not patch DeepSeek Harness core. Installing the plugin enables
the interface, and removing it leaves no core modifications behind.

> Status: public beta. It is suitable for daily use and extension work. Read
> [Architecture and limitations](docs/architecture.en.md) before relying on its
> permission model or terminal-specific behavior.

<p align="center">
  <a href="https://dshfind.com/en/plugins/ccch1mneyyy/dsh-TUI"><img src="https://dshfind.com/api/card/ccch1mneyyy/dsh-TUI?lang=en" alt="dsh-TUI on dshfind"></a>
</p>

## Highlights

- **Terminal-native interaction**: streaming Markdown, structured tool cards
  (terminal-card multi-line command headers fold to the first line plus a
  count via `/settings`; Ctrl+O or a card click expands), command and file completion, `@` file references (complete anywhere; text
  files attach content, directories attach listings, and PNG/JPEG/WebP/GIF are
  sent as durable image blocks; `@path#L12-14` line ranges attach only the
  requested lines, clamping past-EOF ranges or falling back to the whole file
  with a note), history
  search, message selection, inline or alternate-screen rendering, and `/lang`
  zh/en UI language switching.
- **Pixel whale pet**: one of three randomized startup intros plays on every
  launch; **clicking the whale pops a heart pass** any time, and with
  `/settings → whaleIdle` enabled the settled whale keeps fluttering its fins
  and thumping its tail, swims continuously while the agent works, falls
  asleep with Z's after 10s of inactivity, and wakes on any work. The 22
  hand-drawn frames and the idle behaviors are ported from
  [dsh-ui-whale](https://github.com/lhh010/dsh-ui-whale) by [@lhh010](https://github.com/lhh010).
- **Timeline navigation**: a Grok-style turn rail covering **every turn
  (folded ones included)** — even when the fold window only exposes the last
  few turns, the full history stays one click away (clicking a folded tick
  reveals that turn and scrolls to it). When not pinned to the bottom,
  `Enter`/`End` jump back in one step (no blank flash from long distances)
  and a clickable new-messages pill stays in view; the right gutter offers
  timeline / scrollbar / hidden modes.
- **Visible agent state**: live activity, segmented context usage, TPS, cache
  hit rate, reasoning effort, input/output tokens, and Git/session metadata.
  In fullscreen, hovering a truncated tool header, wrapped user prompt, or
  session title for ~600ms opens a tooltip with the full content.
- **Complete session workflow**: `/resume` groups history by working directory
  with search and preview (left-click resumes, right-click opens an action
  menu; pin frequent sessions — a `Pinned` group floats them to the top, the
  in-row star or `Ctrl+P` toggles, pins persist in `~/.dsh-tui`), alongside
  `/new`, `/workspace`, `/compact`, `/export`,
  the `/btw` side question, model switching, double-`Esc` rewind through a
  session fork, vim editing for the prompt (`/vim`), mouse selection
  editing in the prompt (drag to select, Shift+click to extend,
  double-click word select, `Ctrl+C` to copy the selection), and a
  fullscreen draft editor (`Ctrl+Shift+E` or the `⛶` row button: line
  numbers, current-line highlight, `Enter` = newline, `Ctrl+Enter` = send,
  wheel scrolling, click/drag selection — long drafts get the whole
  screen; disable it in `/settings`).
- **Official DSH integrations**: agent presets, skills, MCP, goals, todos,
  subagents, and `ask_user_question` are connected through existing services
  and registries. `/skills` shows skills discovered from the active profile,
  user, and project; dsh-TUI does not preinstall general-purpose skills.
- **Designed for long sessions**: event-driven projection, differential output,
  message virtualization, replay coalescing, and bounded caches prevent render
  cost and memory from growing without limit; fingerprint-memoized hot paths
  render with **zero per-frame allocations** (~200KB of GC churn saved every
  16ms tick in a 3200-row session), wrapText and markdown tokens reuse global
  LRU caches across mounts, the main screen paints in frames (fold window
  300→120 rows), and long-session resume lands straight on content (splash
  skipped, anchored to the newest message's last row).

## Preview

<p align="center">
  <img src="screenshots/splash.png" alt="dsh-TUI conversation with the pixel-whale header" width="100%">
</p>

Live activity, goal/todo state, and context metrics:

<p align="center">
  <img src="screenshots/working-line.png" alt="dsh-TUI live activity and context metrics" width="100%">
</p>

## Quick Start

Prerequisites: an interactive terminal TTY, the official `dsh` CLI, and
`pnpm` 10+. Model requests also require `DEEPSEEK_API_KEY`.

```sh
# 1. Install the CLI and this plugin globally (ships the dsh-tui command)
npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui

# 2. Start it (first run auto-initializes the dsh-tui profile; needs pnpm)
dsh-tui
# Both `dsh-tui` and the short `dst` alias start the same TUI.
dst
```

Manual alternative: `dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui`
(the repository's `sh install.sh` wraps this step and checks the required
commands), then `dsh-tui` (or `dst`) and `dsh --profile dsh-tui` are equivalent.

> **New-user note**: if `dsh plugin` fails with `ERR_PNPM_IGNORED_BUILDS`
> (pnpm ≥11 blocks dependencies that carry install scripts by default, e.g.
> `@google/genai` and `protobufjs` — none of these scripts is needed at
> runtime, so they can safely be ignored), add to the profile's
> `pnpm-workspace.yaml`:
>
> ```yaml
> allowBuilds:
>   '@google/genai': false
>   protobufjs: false
> ```
>
> `/update` and `dsh-tui update` seed this configuration automatically —
> no manual step needed.

`dsh-tui` (or its `dst` alias) with `--resume` restores the most recently selected session; on Windows
the repository's `dsh-tui.cmd` works the same way.

CLI subcommands (`dsh-tui help` or `dst help` prints the full usage; the `dst` alias accepts the same commands):

| Command | Purpose |
|---|---|
| `dsh-tui update` | Update the profile to the latest release and align the launcher (same install logic as the in-TUI `/update`, without restarting into the TUI) |
| `dsh-tui doctor` | Pre-flight environment checks: dsh/pnpm, profile install and version alignment, whether the API key is set (state only, never the value), config file presence; complements the in-TUI `/doctor` session diagnostics |
| `dsh-tui version` | Show the launcher and profile versions (`--version`/`-v` are equivalent) |
| `dsh-tui help` | Show usage (`--help`/`-h` are equivalent) |

`help`/`version` work even when dsh is missing or the profile is not initialized; `update` needs dsh (a missing dsh gets an install hint);
every other argument is still forwarded verbatim to `dsh --profile dsh-tui`.
The repository-root `dsh-tui.cmd` is a launch wrapper that goes straight to
`dsh --profile` and carries no subcommands — subcommands belong to the
npm-installed `dsh-tui` command.

### Herdr

Run `dsh-tui` directly in a [Herdr](https://herdr.dev) pane; no extra setup is
required. dsh-TUI reports `idle`, `working`, and `blocked` through Herdr's local
integration API and marks questionnaires and tool approvals as `blocked`. The
integration is completely inactive outside Herdr. `herdr agent start --kind
dsh-tui`, session identity, and automatic restoration after a Herdr server
restart still require a native dsh-TUI agent kind upstream; manually launched
panes already retain, reconnect, and expose their live state.

For running dsh-TUI inside VS Code — directly in the integrated terminal or
via the `dsh-tui-vscode` companion extension (real-integrated-terminal
sessions, an experience almost identical to the official Claude Code
extension; available on the VS Code Marketplace) — see
[Running dsh-TUI in VS Code](docs/vscode.en.md).

See [Getting started](docs/getting-started.en.md) for profile composition,
source builds, and troubleshooting.

The TUI checks the configured registry for newer versions in the background
after startup (the check never blocks the first frame and silently ignores
offline or registry errors). When an update is available, just type `/update`
for a one-shot upgrade: it updates the runtime actually running in the current
`dsh-tui` profile, verifies the install result, then restarts automatically and
resumes the current session.

When launched through the global `dsh-tui` command, newer versions
automatically migrate/align the global entry to a delegating launcher: the
global command only forwards to the copy inside the profile, so the startup
logic always follows the profile version.

Under normal circumstances no extra manual step is needed:

```sh
npm install -g @deepseek-harness-tui/dsh-tui
```

For migration from the former `dsh-cc-tui` package and `cc-tui` profile, see
[Getting started](docs/getting-started.en.md#migrate-from-the-former-package).

## Keybindings

| Key | Action |
|---|---|
| `Enter` | Idle = send (`Shift+Enter` for a newline, or `Ctrl+J` when the terminal cannot report modified Enter; `Option+Enter` is the fallback on macOS Terminal.app, issue #110); **while the model is working = steer** (inject a next-step boundary without interrupting); executes the selected item when a command menu is open |
| `Ctrl+Enter` (⌘Enter) | **Interrupt the current turn and send immediately** (interrupt) |
| `Alt+Up` | Pull the last unhandled message back into the input for editing (without interrupting the turn) |
| `Tab` | Complete `/` commands or `@` files (keep drilling into directories); **while the model is working = follow-up** (queued after the current turn) |
| `Ctrl+C` | Interrupt the current turn; press again while the interrupt is still settling to force-exit; press twice while idle to exit; **with an active mouse selection in the prompt, copies it to the clipboard and keeps it** |
| `Esc` | Close the command/file menu; **with an active selection in the prompt: only clears the selection**; double-press while idle clears the input; **double-press on empty input = time rewind** |
| `←` (empty input) | **Background this session and open the agent view** (CC agent view; with text, ← moves the caret as usual) |
| `Ctrl+O` | Expand/collapse details (full thinking text, tool arguments and output) |
| `Ctrl+Shift+E` | Expand the fullscreen draft editor (Enter = newline, `Ctrl+Enter` = send, `Esc` = collapse keeping the draft; line numbers, wheel scrolling, click/drag selection) |
| `Ctrl+R` | History search |
| `/` | In-session full-text search (`n`/`N` to jump) |
| `Ctrl+V` / `Alt+V` | Paste text or files from the file manager; images show as `[Image #N]` and are sent as durable attachments. Use `Alt+V` when the terminal intercepts `Ctrl+V` |
| `Ctrl+G` | Edit the current input with `$VISUAL`/`$EDITOR` (e.g. nvim); content is filled back in on save and exit |
| `/vim` | Toggle vim editing for the prompt (session-scoped): `Esc` switches to NORMAL (`h/l/j/k`, `0/^/$`, `w/b`, `x/X`, `dd`/`d$`/`d0`/`dw`, `u` undo), `i/a/o` back to INSERT |
| `?` | Keybinding menu (responds only when the input is empty) |
| `Shift+↑` | Message selection mode (`Enter` expands a single message) |
| `Ctrl+P` | Toggle the startup loaded-context panel while it is on screen; inside `/resume`, pin/unpin the selected session |
| `Home` / `End`, `Ctrl+A` / `Ctrl+E` | `Ctrl+A` opens the subagent dashboard (in-editor `Mod+A` still moves to line start); `Ctrl+E` is dual-purpose: line end in the input, expand/collapse hidden older messages during transcription |
| `Ctrl+←` / `Ctrl+→` (⌘←/→) | Jump by word |
| `Ctrl+U` / `Ctrl+K` | Delete before the cursor (to line start) / after the cursor (to line end) |
| `Ctrl+W` | Delete the previous word |

**Three delivery modes while the model is working**: `Enter` = steer (inject a next-step boundary, no interruption) · `Tab` = follow-up (queued after the current turn) · `Ctrl+Enter` = interrupt (break in and send immediately).

**Custom keybindings**: the action shortcuts above (paste, history search, external editor, transcript expand, trajectory, subagent dashboard, loaded-context panel, show-all, redraw, todo fold) are remappable in `/settings` → `dsh-tui` → `Shortcuts`: enter combos like `alt+v` or `ctrl+shift+v`, comma-separate several, leave blank to restore the default; saves apply live with no restart. Combos that clash with the fixed editing keys (`Ctrl+A/E/U/K/W`, `Ctrl+←/→`) or with another action are rejected. Deployments can also pin them statically via `shortcuts.<action>` in cordis.yml (the settings user layer wins).

**macOS modifier keys**: the `Ctrl+<key>` bindings above also work with `⌘<key>`
on macOS (e.g. `⌘V` paste, `⌘O` expand details, `⌘Enter` send immediately);
only `Ctrl+C` / `Ctrl+D` (interrupt/exit) stay on Ctrl, to avoid clashing
with muscle memory for macOS system-level `⌘C` copy and similar. `⌘` requires
terminal support for the extended keyboard protocol (iTerm2 / kitty / WezTerm /
ghostty / tmux); macOS's built-in Terminal.app consumes `⌘` shortcuts itself,
so keep using `Ctrl`.

**Mouse** (fullscreen is the factory default since 0.9.0; set `fullscreen: false` to restore the inline main screen; updating from an older version clears a previously saved inline choice once — you can still pick inline again afterwards)

| Action | Function |
|---|---|
| Drag to select | In-app text selection, **copied on release** (OSC 52 with native `wl-copy`/`xclip`/`xsel` fallback; `load-buffer -w` inside tmux); the selection is cleared after copying and a "Copied N characters" notice pops up |
| Double / triple click | Select word / line, copied on selection just the same |
| Drag inside the prompt input | Build an in-input selection (rendered highlight): `Backspace`/`Delete` delete it, typing replaces it, `←/→` collapse it to the corresponding edge, `Esc` only clears it; a folded paste block keeps the selection on the clicked side |
| `Shift+click` in the prompt input | Extend the selection from its start edge (or the caret) to the clicked position |
| Double-click a word in the prompt input | Select the whole word (paths and punctuation runs select as one; detected in the component, 500 ms / 1 cell) |
| `Ctrl+C` with a prompt selection | Copy the selection to the clipboard (OSC 52 + native fallback) and keep it for editing |
| Scroll wheel | Only with fullscreen mouse tracking: scroll Help while it is open, otherwise scroll messages (±3 lines per notch); default inline mode does not deliver wheel events to the TUI |
| Click a timeline-rail tick | Jump to that turn — the rail covers every turn (folded ones included); a folded tick reveals its turn first, then scrolls it into place |
| `Esc` | Cancel an in-progress drag selection (no copy) |
| Single-click a message line | Expand/collapse that line |
| Click "load earlier messages" / "ctrl+e show previous N" | Load earlier messages / expand all |
| Click the StickyHeader / "↓ N new messages" | Jump back to the pinned message / scroll to the bottom |
| Click a hyperlink | Open it in your browser |
| Keyboard selection extension | With a selection active, `Shift+←/→/↑/↓/Home/End` extends or shrinks it (wrapping across lines) |

**Questionnaires** (when the model fires `ask_user_question`)

| Key | Action |
|---|---|
| `↑/↓` | Choose an option |
| `Space` | Toggle multi-select options |
| `Tab` | Switch to a custom answer (type directly without picking an option) |
| `Enter` | Submit the current selection |
| `Esc` (from question 2 onward) | Return to the previous question and keep the current draft |
| `Esc` (from question 1) / `Ctrl+C` | Cancel the whole question batch (the model receives ASK_CANCELLED and can continue the conversation) |

**Local commands** (a full replica of the CC command set, all routed through the official DSH pipeline)

| Group | Commands |
|---|---|
| Session | `/new` new session · `/resume` working-directory/session browser (visible directory scope, search, preview, cross-project, sub-agent runs folded) · `/agentview` agent view (all sessions) · `/bg` (alias `/background`) background this session and open the view · `/rename` rename session · `/recap` session recap (apply the suggested title in one key; `/settings` can enable an auto-summary on session open — on by default: a divider + `Recap:` line appears at the bottom of the transcript when resuming, and bows out once you send a new message) · `/workspace resume|rename|open` manage workspaces · `/clear` clear screen · `/compact` compact · `/export` export Markdown · `/trace` trace timeline (or `Ctrl+T`) · `/rewind` rewind picker (same as double-`Esc` on empty input) · `/tree` session family tree (every fork branch stitched together; hover previews a node, click opens a rewind/fork-here/adopt-branch menu) · `/fork` copy the current session into a resumable twin (the original is untouched) · `/btw <question>` side question (never interrupts the main turn, writes no history) |
| Status | `/context` loaded-context details · `/status` session info · `/cost` token usage · `/doctor` environment self-check · `/config` configuration sources · `/init` create AGENTS.md · `/settings` settings panel (namespace read/edit) |
| Model | `/model` two-level picker (a pinned **Recently used** group first — the last 10 switched models, persisted at `~/.dsh-tui/model-recents.json` — then provider groups; Enter drills into a group's models; a single provider with no recents skips straight to the list; **switching = fork continuation, history preserved**) · `/effort` reasoning effort (slider / `status` / `<id>`) · `/preset` agent preset (**cannot switch once the session has started** — blank-only) · `/thinking` thinking display · `/tokens` token details · `/activity` working animation (`frames <name>` / `status`) · `/theme` theme picker · `/color` (bare opens the palette picker; `<name>` sets directly; `status`/`reset`) session accent color (input border + session-name chip at the top-right, per-session; chip off by default, enable in `/settings`) · `/lang` zh/en UI switch (also selectable in `/settings`) |
| Accounts/Policy | `/provider` manage model providers — add a provider, or edit an existing one via a menu (API key · model list · delete the provider; custom endpoints also get base URL · wire protocol; a targeted edit patches only that field, the rest of the profile survives untouched; the model list pre-checks what you already enabled; only user-layer providers are editable) (includes the bundled dsh-auth **subscription OAuth sign-in** branch — ChatGPT / Claude / Grok, no API key; same source as `/auth status\|login\|logout`) · `/login` credential & account status · `/logout` logout notes · `/permission` dynamic preset/status notes · `/add-dir` file-policy scope · `/hooks` · `/mcp` |
| Skills | `/skills` lists skills discovered by DSH; user-invocable skills join the `/` menu as `/name` |
| Other | `/agents` subagent list · `/plugins check <path>` plugin diagnostics · `/update` auto-update and restart · `/vim` vim editing mode toggle · `/terminal-setup` · `/connect` · `/help` · `/exit` (aliases `/quit` `/q`) |
| Registry | `/plan` `/goal` `/feedback` `/permission` (DSH command-registry plugins, merged into the `/` menu automatically with the plugin) |

> Unknown commands are sent to the model as ordinary messages (e.g. in a composition where `/permission` is not mounted).

**Agent view** (`/agentview`)

One full-screen surface for every session in this process: the attached conversation, the background sessions dispatched here, and the stopped TUI sessions persisted on disk. The header shows CC-style "model · directory" plus state counts (awaiting input · working · completed); rows are grouped by state (needs input > working > failed > completed > idle > stopped), **working rows animate their glyph with CC's `·✢*✶✻✽` frame cycle**, each with a one-line activity summary derived from the session's own output (no extra model calls) — a row waiting on input shows the question it is blocked on. **Only sessions this TUI dispatched, backgrounded, or attached to from the view are listed** — the ordinary `/resume` history and sessions created by other front doors (e.g. web) never appear.

| Key | Action |
|---|---|
| `↑/↓`, `PgUp/PgDn` | Move between rows |
| `Enter` / `→` | Attach to the selected session (with input text: dispatch it) |
| `Shift+Enter` | Dispatch and attach immediately |
| `Space` | Toggle the peek panel (when the input is empty); type a reply inside and `Enter` to send |
| `Ctrl+X` | Stop a background session; press again within 2s to delete it (log removed) |
| `Ctrl+R` | Rename the selected session |
| `Esc` | Close peek → clear input → exit; **when opened via ← `/bg`, the final Esc returns to the backgrounded session** |
| `Ctrl+C` | Clear input; press again to exit |
| `?` | Show all shortcuts |

- Type a task in the input at the bottom and press `Enter` to dispatch a **background session**: it runs independently inside this process (turns, tools, approvals all work) without you watching it.
- **Press `←` on an empty prompt** to jump straight into the view: the attached session moves to the background — it keeps running — the terminal lands on a fresh session, and the view opens (same as `/bg`), with a "Your conversation moved to the background — Enter opens it · Esc returns to it · Ctrl+C twice quits" notice on top. The prompt footer keeps a live "← N agents" count whenever background sessions are waiting on you.
- A background session that needs approval shows as **needs input**; the approval panel pops up right inside the view and is answered there (labelled with its session).
- `/bg` (alias `/background`) moves the attached session to the background — it keeps running — switches the terminal to a fresh session, and opens the view. `Enter` on any row switches back.
- Peek and reply work live for running sessions; a stopped session needs an `Enter` attach before you can talk to it.
- **Background sessions live inside this process**: they stop when the TUI exits (logs survive; `/resume` or `Enter` in the view brings them back). There is no supervisor process.

## Documentation

| Topic | Contents |
| --- | --- |
| [Getting started](docs/getting-started.en.md) | Prerequisites, installation, startup, profile lifecycle, source development |
| [Configuration](docs/configuration.en.md) | Cordis overrides, fields, agent presets, MCP, environment variables |
| [Themes](docs/themes.en.md) | Built-in themes, background detection, static JSON and npm plugin themes, validation |
| [Interaction and commands](docs/interaction.en.md) | Keyboard, mouse, questionnaires, slash commands, session workflows |
| [Architecture and limitations](docs/architecture.en.md) | Runtime path, rendering, persistence, security boundary, known limitations |
| [VS Code guide](docs/vscode.en.md) | Running dsh-tui in the VS Code integrated terminal; the `dsh-tui-vscode` companion extension offers an experience almost identical to the official Claude Code extension (on the Marketplace) |
| [Contributing](docs/contributing.en.md) | Contribution workflow, repository map, build artifacts, verification matrix, change rules |
| [Plugin admission & development](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md) | Interface & compatibility agreement / plugin admission spec / seams / contracts / verification checklist (merged into dsh-ecosystem-spec) |

The complete bilingual index is [`docs/README.md`](docs/README.md).

## Configuration & Extensions

- **Agent presets**: four official agent modes (`standard` / `ptc` / `minimal` / `cordis`)
  plus the TUI-bundled Liangshen mode (`liangshen`),
  switched with `/preset`; sessions that already have a conversation cannot switch, while
  blank sessions take effect immediately. The default preset persists in
  `~/.dsh-tui/agent-preset.json`; `/model` selections persist in `~/.dsh-tui/model.json`.
  Under the `en` UI language the `/preset` picker shows localized English names
  and descriptions for the built-in presets.
  See [Configuration](docs/configuration.en.md#agent-preset).
- **Themes**: the `/theme` picker (`auto` follows the system/terminal background,
  built-in `light` / `dark` / `dark-ansi`) accepts static themes from
  `~/.dsh-tui/themes/<name>.json` and runtime themes registered by npm plugins through
  `ctx.tuiThemes` — selecting one hot-swaps and persists it; precedence is
  `DSH_TUI_THEME` env var > persisted selection > OSC 11 terminal-background auto-detection.
  See [Themes](docs/themes.en.md).
- **MCP**: servers are mounted via `@deepseek-ai/dsh-mcp-client`, with tools registered as
  `mcp__<server>__<tool>`; `/mcp` shows connection status.
  See [Configuration](docs/configuration.en.md#mcp).

## How It Works

```text
dsh profile
  -> dsh-base
  -> dsh-TUI Cordis patch
  -> agent preset + DSH services
  -> session/event
  -> Channel projection
  -> React components
  -> ported Ink/Yoga renderer
  -> terminal
```

The TUI owns interaction and presentation only. The session log remains the
conversation source of truth, while model calls, tool execution, fork/resume,
compaction, and persistence remain owned by DSH services. See the
[architecture guide](docs/architecture.en.md) for module boundaries and
performance details.

```text
chat / tool base events ──> persisted Session log ──> TUI / Web
          └───────────────> ActivityTracker (memory) ──> TUI status only
```

## Technical Notes

- **Gentle Mist Blue palette**: mist blue carries only branding, focus, interaction,
  and highlights; body text stays neutral gray. On startup the terminal background
  color (OSC 11) is queried to auto-select a light or dark palette, falling back to
  dark when the terminal does not respond.
- **Event-driven rendering**: the `session/event` stream drives incremental differential
  rendering; scroll state is maintained independently.
- **Layout-level virtualization**: per-frame cost for long sessions drops from
  O(entire session) to O(visible window) — off-screen message lines render as
  height-only placeholders whose subtrees never take part in layout.
- **Zero-allocation hot paths**: the visibleRows pipeline (slice/filter/margins)
  is memoized on rows identity, length, and a Uint8Array streaming-bit
  fingerprint — zero array/Map allocations per scroll tick, while in-place
  settle writes still rebuild the cache instantly (empty-row filtering never
  lags); wrapText and markdown tokens flow through global LRU caches that
  reuse measurements across mounts.
- **Framed backfill and landing anchor**: opening the main screen mounts the
  tail window first and backfills history in frames; `/resume` asserts a final
  state where the newest message's last row is visible and reachable, and
  long-session restores skip the splash animation to land straight on content.
- **Context progress bar**: based on the pi-nano-context algorithm (largest-remainder
  segmented coloring + multi-level condensed readouts).
- **TPS meter**: based on pi-tps-meter — a streaming 1/8-block gauge, historical
  min-max sparkline, and speed-based semantic colors (≥50 green / ≥20 yellow / <20 red).
- **working-activity ecosystem**: the working-status line reuses the pure state machine of
  [dsh-working-activity](https://github.com/ccch1mneyyy/working-activity),
  deriving it in-process from base session events without writing UI state into the shared log.
- **Terminal paste**: in raw mode `Ctrl+V` is handled by the app and reads the system
  clipboard per platform — PowerShell `Get-Clipboard` on Windows, `osascript`/`pbpaste`
  on macOS, and auto-detected `wl-paste`/`xclip`/`xsel` on Linux; regular files insert
  their path, image files generate an `@` reference, clipboard bitmaps are written to
  the attachment library and shown in the input as `[Image #N]`, and plain text is
  inserted at the cursor.

## Known Limitations

- Injected context (plugin source content) has no standalone display and is merged
  into the progress-bar statistics along with the system prompt.
- `/model` live switching works via "session fork continuation" (DSH has no in-place
  model-switch API): history is preserved as-is, the new session routes to the new
  model, and the old session stays in the `/resume` list; the choice is written to
  `~/.dsh-tui/model.json` and survives both restart and `/new`.
- `Ctrl+V` clipboard reads depend on external tools per platform: PowerShell
  `Get-Clipboard` on Windows (auto-retries when the clipboard is briefly locked by
  another process, silently gives up when persistently locked); `osascript`/`pbpaste`
  on macOS (multi-file copies in Finder have no stable AppleScript read path, falling
  back to text/images); Linux needs one of `wl-paste`/`xclip`/`xsel` and a connectable
  session (a missing tool or unreachable session shows a "no clipboard tool available"
  notice). Unsupported image formats or an unavailable attachment service keep a
  temporary file reference as a degraded fallback.
- Exit finishes with a process exit and does not wait for the agent's async disk writes
  (persistence is covered by the persistence plugin as a backstop).
- **Agent view background sessions live inside this process**: they all stop when the
  TUI exits (CC's supervisor process and survival across restarts are out of v1 scope);
  row summaries come from the session's own output with no extra summary-model calls;
  worktree isolation, pinning, directory grouping, and shell background jobs are not
  shipped yet.
- Tool-level approval is implemented: the approval service + TUI answerer (CC-style
  approval panel) consumes the approval stream, and privilege-escalation commands pop
  an approval bar. `/permission` preset switching comes from dsh-base's
  `permission-presets` plugin and is available in the profile composition by default.
  If that registry service is absent, TUI uses its legacy three-row compatibility
  roster; a malformed mounted service is unavailable and fails closed. If the
  external `/permission` command is not registered, input keeps the existing
  default/model dispatch behavior.
- `/connect` `/hooks` are CC-named placeholders: the corresponding
  capabilities have no equivalent mechanism on the DSH side, and the commands give an
  explicit explanation rather than staying silent.
- The `/thinking` display toggle is **not persisted**; restarts and new sessions fall
  back to the default.
- `/compact` is unavailable under the `minimal` preset (that preset does not compose
  compaction).
- `/update` works only when started via `dsh --profile` and is refused while a turn is
  running.

See [Architecture and limitations](docs/architecture.en.md) for the complete list of
known limitations and the security boundary.

## Development

CI uses Node 24 and pnpm 11. The package supports Node `^22.19 || >=24`.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm smoke
```

`lib/types/` is ignored generated output. `pnpm build` recompiles it from a
clean output directory and runs the build gates. **Git URL installs are not supported** (the source manifest keeps
`@dsh-std/*` as workspace deps, `vendor/dsh-std` is a submodule, and pnpm ≥11 refuses
git-hosted `prepare` scripts by default); install the registry package:
`dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui`. Rendering, questionnaire, or tool-card
changes also require the relevant regression scripts.

## Plugin Ecosystem

Want to build a plugin or extension for dsh-TUI? Join the ecosystem:

- **Interface & compatibility agreement / Plugin development guide**: [Terminal Interactive Ecosystem Plugin Admission and Development Guide](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md) (admission spec, seams, contracts, verification checklist)
- **Organization**: [dsh-tui-ecosystem](https://github.com/dsh-tui-ecosystem)
  (home of community plugins and templates)
- **Template repository**: [plugin-template](https://github.com/dsh-tui-ecosystem/plugin-template)
  (start from the template and ship a plugin in minutes)
- **Reference implementation**: `dsh-working-activity` (live working-status
  line with dual outlets: TUI prompt slot + `activity/status` session events)

### Seam stability reference

An **informal** maturity grading to help plugin authors gauge investment;
the authoritative status and compatibility agreement live in the
[admission & development guide](https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md):

| Tier | Seams |
| --- | --- |
| Stable candidate (shape frozen; breaking changes go through a minor-version deprecation warning before removal) | VI settings sections · VIII full-screen scenes · X managed dialogs · XI status line · XII keyboard shortcuts · XIII entry renderers |
| Experimental (may still shift with dsh-std / admission-spec evolution) | IX decision events · toast notifications (`ctx.tuiToast`, new) |
| Upstream-tracked (stability owned by the cordis / dsh mechanisms underneath) | I session events · II official prompt slots · III bundled skills · IV themes · V system-prompt sections · VII profile composition |

Also experimental public surfaces: `@deepseek-harness-tui/dsh-tui/test-utils`
(headless admission/mounting test helpers) and `@deepseek-harness-tui/dsh-tui/api`
(types-only entry).

The core repository remains independent; community plugins live in their own
repos. The organization only maintains the listing and admission rules — it
does not endorse or warrant the functionality, quality, or safety of community
plugins. Plugin authors keep full ownership of their repositories and are
responsible for their maintenance and security.

## Community

- **Ecosystem organization**: [dsh-tui-ecosystem](https://github.com/dsh-tui-ecosystem) —
  the home of community plugins, templates, and the curated list. Come ship a
  plugin, pitch an idea, or just hang out 🐋
- **Chat groups** (Chinese-language): usage questions, plugin ideas, and
  feature wishes are all welcome.
- **Code of conduct**: please read the
  [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.en.md) before taking
  part.

| WeChat group | QQ group (ID 572549239) | WeChat group 4 |
| :---: | :---: | :---: |
| <img src="screenshots/wechat-group.jpg" alt="dsh-TUI community WeChat group QR code" width="200"> | <img src="screenshots/qq-group.png" alt="dsh-TUI community QQ group QR code" width="200"> | <img src="screenshots/wechat-group4.jpg" alt="dsh-TUI community WeChat group 4 QR code" width="200"> |

> The WeChat QR code expires roughly every 7 days; if it stops working, use
> the QQ group (572549239) or open an issue to nudge us for a refresh.

## Permissions and Security Boundary

> **Windows security warning:** The Windows profile defaults to `danger-full-access` with approval set to `never`. Tools therefore have unrestricted access; before starting in an environment with sensitive credentials or an untrusted repository, inspect and tighten the profile configuration.

`dsh-TUI` does not implement a separate sandbox. It uses the filesystem,
shell, sandbox, and approval policies of the active DSH profile. Permission
presets come from the mounted DSH `permissionPresets` registry: third-party
presets appear automatically in the picker, completion and the `Shift+Tab`
cycle (excluding `custom`/`status`, canonical presets, duplicate identities
and unsafe tokens), with the registry's declaration order kept stable across
refreshes. `custom` is a current-state label only, never a selectable target.
While the service snapshot is usable, `/permission` is surfaced as a first-class
local command: switches prefer the official `/permission <preset>` command; when
the command row never reaches the agent's registry, the TUI falls back to the
permissionPresets service's own official write path (the same handler the
command drives — real `permission/preset`/`sandbox/mode`/`approval/policy`
events, never fabricated by the TUI) and confirms via event/readback; when
neither path exists it fails loudly instead of silently falling through.
Exiting plan mode restores the pre-plan atoms first, then returns the durable
identity to the preset you were on before plan mode (while the registry still
offers it).
When the `permissionPresets` service is absent, TUI keeps its legacy three-row
compatibility roster. A mounted but unusable service is marked unavailable and
fails closed instead of inventing a roster. Inspect
the profile before starting it around sensitive credentials or an untrusted
repository.

See [Permissions and security boundary](docs/architecture.en.md#permissions-and-security-boundary)
for details.

## Featured by DeepSeek Harness

The DeepSeek Harness official WeChat account featured this plugin among its
early user-built extensions. [View the feature screenshot](screenshots/wechat-official.png).

## Acknowledgments

- The pixel whale's 22 hand-drawn frames (drawn cell by cell in Excel) and
  its idle behaviors (fin flutters, tail thumps, sleep Z's, click hearts)
  are ported from **[dsh-ui-whale](https://github.com/lhh010/dsh-ui-whale)**
  (the DeepSeek Harness web whale-pet plugin, by [@lhh010](https://github.com/lhh010),
  BSD-3-Clause) — thank you for the art and the inspiration 🐋💜

## Friends' Links

Community, related projects, and companion tools built by friends:
[see the links page](docs/links.md)

## Trend

[![Star History](https://raw.githubusercontent.com/ccch1mneyyy/dsh-TUI/bot-star-history/assets/star-history/star-history.png)](https://star-history.com/#ccch1mneyyy/dsh-TUI&Date)

## License

[MIT](LICENSE)
