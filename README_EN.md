<p align="center">
  <a href="README.md">简体中文</a> | <strong>English</strong>
</p>

<p align="center">
  <img src="screenshots/splash.png" alt="dsh-cc-tui - A Claude Code-style terminal TUI for DeepSeek Harness" width="100%">
</p>

# dsh-TUI - An Anthropic-Inspired Full-Screen Interactive Terminal

> **DeepSeek Harness currently has no official terminal TUI (only a Web UI), so I built dsh-cc-tui!**
> A polished and practical Claude Code-style TUI plugin mounted through Cordis: a pixel whale header,
> dual shimmering display text, a live activity line, streaming thoughts, double-Esc rewind,
> a blue-and-white context meter, and a TPS gauge. No core modifications; everything is attached as a plugin.

![Type](https://img.shields.io/badge/type-cordis%20plugin-blue) ![Status](https://img.shields.io/badge/status-public%20beta-blue) ![Official feature](https://img.shields.io/badge/DeepSeek%20Harness-featured-brightgreen)

## 🎉 Featured by DeepSeek Harness

This plugin was featured by the **official DeepSeek Harness WeChat account** as a selected early-access community plugin:

<p align="center">
  <img src="screenshots/wechat-official.png" alt="dsh-cc-tui featured by the official DeepSeek Harness WeChat account" width="560">
</p>

## Interface Preview

![Start screen with pixel whale header](screenshots/splash.png)

![Live activity line and context meter](screenshots/working-line.png)

## Why Install It

- **Visual polish is productivity**: the header features a half-block pixel-rendered DeepSeek whale
  (a hand-drawn 40x25 sprite with a deep-blue outline, brand-blue body, ice-blue belly, and white mouth).
  On startup it plays a hand-animated sequence (blink -> water spray -> tail swish), then settles into
  a static frame without further repainting. Beside it, `DEEPSEEK HARNESS` is rendered as custom
  five-line block lettering with a brand-blue-to-ice-blue horizontal gradient and a looping white
  shimmer. The welcome message also carries an ice-blue shimmer. The whale automatically collapses
  in narrow terminals under 64 columns.
- **Live activity line** instead of Claude Code's random-verb spinner: while the agent works, the line
  above the input stays visible with live model activity - playful thinking messages (`Hmm... let me
  work through this`, late-night variants, and 30s/1m/5m tiers), the tool actually running
  (`Editing src/channel.ts · 12s`), and `⏵` model narration. It includes 28 animated indicators
  (Claude's official frame sequence by default), a white shimmer over the text, context warnings in
  bright yellow at >=80% and bright red at >=95% (`⚠ Context 85% · ...`), and a trailing
  `↓ N tokens` counter. At the end of a turn it becomes a compact summary such as
  `Done ✓ · N tools · thought Xs, worked Ys`.
- **Model state at a glance**: the bottom status bar includes a blue-and-white **segmented context
  meter** (system/prompt/assistant/thinking/tool segments plus a live
  `ctx 17k/1.0M 1.7% 983k` readout), `model · live TPS (streaming gauge / historical sparkline) ·
  reasoning effort · cache hit rate (one decimal) · input/output tokens`, and
  `git branch · working directory · session title` on the right.
- **Streaming thoughts remain visible**: thinking blocks expand while they are generated and collapse
  to `∴ Thinking · 12s` when the turn ends. Press Ctrl+O at any time to expand the full text.
- **Double-Esc time rewind**: roll the conversation back to any historical message. The DSH session
  is forked and replayed unchanged, while the selected message returns to the input for editing and
  resubmission.
- **Complete Claude Code interaction details**: a vertical `/` command menu with Enter execution and
  Tab completion, gray user-message bubbles, `●` assistant text with Markdown tables and code
  highlighting, tool-call cards, a `?` shortcut menu, `/` full-text search, Ctrl+R history search,
  `@` file completion, Shift+Enter multiline input, a pinned current-prompt bar while scrolling,
  and a `↓ N new messages` pill.
- **Official DSH mechanisms first**: messages come from the session-log event stream, while
  fork/resume/compact all use official services
  (agents/sessions/sessionPersistence/compact). Uninstalling the plugin restores the original
  experience completely.

## Installation

Prerequisites: the official `dsh` CLI (`npm install -g @deepseek-ai/dsh`) and `pnpm`.

```sh
# 1. Install the official CLI (skip if already installed)
npm install -g @deepseek-ai/dsh

# 2. Install this plugin (install.sh in the repository root wraps this command and checks pnpm)
sh install.sh
# Or run it manually:
dsh plugin --profile cc-tui add dsh-cc-tui

# 3. Start it
#    On Windows, you can also use dsh-cc.cmd from this repository
#    (equivalent, with --resume to restore the previous session)
dsh --profile cc-tui
```

What `add` does, according to the official app-boot and CLI implementation: on first use it
initializes a profile under `$DSH_HOME/profiles/cc-tui/`. The first entry in the manifest's
`dsh.profile.bundles` is `@deepseek-ai/dsh-base`. It then runs `pnpm add <package>` inside the
profile. After installation, it checks whether the dependency declares `dsh.bundle.patch` and,
if so, automatically appends the package as a bundle layer. **No files need to be edited manually.**
At startup, layers are merged in this order:
**dsh-base -> each bundle -> your profile's cordis.patch.yml**. The base layer supplies the core
LLM, session, filesystem, tools, skills, and approval lines; bundle patches override or insert their
own lines by ID. Running `add` repeatedly is safe because an initialized profile is left intact.

The live activity line is mounted automatically with this package. `dsh-working-activity` is an npm
dependency and is installed into the profile's `node_modules`; this package's bundle patch directly
inserts its line with `publishIntervalMs: 500`. **Do not add it separately.** Adding
`dsh-working-activity` again to the same profile would create duplicate lines. Its own self-mounting
patch is intended for profiles that do not include cc-tui, such as a Web UI-only setup.

> The compiled `lib/` output is included in the npm package, so **installation does not require a
> build**. Developers who want to modify the source can run `npm install` and then `npm run build`
> (tsc) from the Git repository.

## Configuration (`profile/cordis.patch.yml`)

Under the official profile model there is no standalone `cordis.yml` startup file. The
`$DSH_HOME/profiles/cc-tui/` directory contains only `cordis.patch.yml`, your patch layer represented
as a top-level YAML array with `!!js` support. The examples below show how to make common changes;
they are not a complete configuration:

```yaml
# Override a line's config. This replaces the whole block, so repeat every key you want to keep.
- id: cc-tui
  config:
    provider: deepseek-official   # LLM route
    model: deepseek-v4-flash      # Model
    effort: max                   # Reasoning effort shown in the header/status bar at startup
    activity: true                # Live activity line (enabled by default)
    activityFrames: claude        # Indicator preset: claude/moon/comet/dots/.../random
    cwd: !!js process.cwd()       # Working directory
    fullscreen: false             # Alternate-screen fullscreen mode (disabled by default)
    preset: !!js process.env.CC_TUI_PRESET ?? undefined  # Agent preset (see below)
    sessionId: !!js process.env.DSH_CC_RESUME_SESSION ?? undefined  # --resume

# Tune the live activity data source shared with the Web UI. The bundle patch inserts this line
# automatically, so override its config by ID instead of inserting another line.
# A 500 ms interval keeps the status timer responsive and is already the cc-tui default.
- id: working-activity
  config:
    publishIntervalMs: 500
```

Dependencies, all supplied by the dsh-base layer unless noted otherwise: llm-deepseek with thinking
enabled, session with SQLite persistence inserted by this package's patch, bash, fs,
**commands (the command registry) + command-goal (`/goal`)**, token-meter, and
dsh-working-activity for the live activity line. Since version 0.3, model-side tool and prompt lines
(tool-fs, tool-todo, subagent, plan-mode, compaction-basic, and others) are assembled by the session's
agent preset instead of being mounted at the host layer.

> Configuration note: when overriding `plan-mode`, `section` must be non-empty or the whole tree will
> fail to load. The core `subagent` service must be mounted before its spawn/fork lines. The base
> layer already guarantees this order; preserve it when inserting related lines yourself.

## Agent Presets (Four Official Agent Modes)

This integrates the official preset registry from `@deepseek-ai/dsh-agent-presets`. Each session's
toolset and prompt sections are assembled from one of four official presets instead of from the host
composition:

| ID | Name | Description |
|---|---|---|
| `standard` | Standard (default) | Full-featured coding agent with editing, shell, retrieval, skills, planning, goals, subagents, and workflows |
| `code` | PTC Mode | Standard capabilities plus Code Mode SDK tool presentation, allowing the model to compose multiple steps in one TypeScript program |
| `minimal` | Minimal | Only persistent bash and str_replace_editor, with no compaction |
| `cordis` | Creation Mode | Standard capabilities plus runtime inspection and plugin experimentation tools for authoring custom presets |

Usage:

- `/preset` opens the picker with localized names and descriptions; `✓` marks the current session preset.
- `/preset <id>` switches directly, while `/preset status` shows the current state.
- **Official locking rule**: a session cannot switch presets after conversation has begun. In that
  case, the selection is saved as the default for `/new` or the next startup. An empty session
  switches in place immediately: the toolset changes live, the change is recorded in the session
  log, and the new preset survives resume and fork.
- The default preset is stored in `~/.dsh-cc/agent-preset.json`. Precedence is:
  the `preset` key in cordis.yml (or the `CC_TUI_PRESET` environment variable) > preference file >
  registry default (`standard`).
- Resuming an old session always restores the preset recorded in that session's log, regardless of
  the current default.
- The `/model` choice is stored in `~/.dsh-cc/model.json`, with the same precedence as presets:
  the `provider`/`model` keys in cordis.yml > preference file > harness defaults
  (`deepseek-official` / `deepseek-v4-flash`). Resuming an old session restores the route recorded
  in its own log (request/header), independent of the current preference.
- To create a custom preset, place a directory containing `agent.cordis.yml` under
  `~/.dsh/.agent-presets/`. The registry discovers it immediately and exposes it in the `/preset`
  picker.

Implementation details: preset files ship with the official CLI. When profile-boot finds an
`agent-presets` line in the composition, it injects the shipped root automatically; this package
does not copy those files. The 24 model-side host lines (tool-bash/tool-web, subagent lines,
compaction-basic, and others) are disabled in the bundle patch after preset migration, matching the
official dsh-web-app behavior. As a result, the cc-tui-specific `CC_TUI_COMPACT_RATIO`,
`CC_TUI_COMPACT_RETAIN`, and depth-1 subagent settings have been retired in favor of each preset's
own compaction and delegation configuration.

## Custom Themes

In addition to the built-in `light`, `dark`, and `dark-ansi` Gentle Mist Blue palettes, you can place
JSON theme files under `~/.dsh-cc/themes/` and override any subset of Theme keys:

```json
{
  "name": "sakura",
  "displayName": "Sakura Pink",
  "base": "dark",
  "colors": {
    "claude": "#FF9EC7",
    "claudeShimmer": "#FFC0D5",
    "permission": "#FFB3CC",
    "promptBorder": "#B08B99",
    "text": "#E8E6E0",
    "inactive": "#A99BA0",
    "subtle": "#8A7A80",
    "selectionBg": "#5C3A44",
    "success": "#9CC7A8",
    "error": "#E08591",
    "warning": "#E0C08A"
  }
}
```

- **Directory**: `~/.dsh-cc/themes/<name>.json`, one theme per file. The filename becomes the theme
  name unless the file declares `name`, in which case the filename remains only as a loading alias.
- **Fields**: `base` is required and selects the built-in palette to override (`light`, `dark`, or
  `dark-ansi`). `colors` overrides any subset of Theme keys; see the `Theme` type in `src/theme.ts`
  for the complete list. `displayName` is shown in the picker and defaults to `name`; `name` defaults
  to the filename.
- **Validation**: colors accept `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(r,g,b)`, `ansi256(n)`, and the
  16 `ansi:` named colors used by the built-in palettes and Ink color engine. Unknown keys or invalid
  colors are skipped with a warning on stderr without affecting the rest of the file. An invalid
  `base`, malformed JSON, or a non-object `colors` value skips the entire file with a warning; the
  TUI does not crash.
- **Activation**: `/theme` opens a picker with built-ins first and custom themes afterward. Each row
  shows its base and previews three key color swatches. Press Enter to **hot-switch immediately** and
  persist the choice to `~/.dsh-cc/theme.json`. You can also run `/theme <name>` directly or
  `/theme status` to inspect the current theme. The persisted selection survives restarts.
- **Precedence**: `CC_TUI_THEME` (built-in or custom name) > persisted choice in
  `~/.dsh-cc/theme.json` > OSC 11 terminal-background detection. A missing theme referenced by the
  environment variable or persisted setting produces a warning and is ignored, allowing automatic
  detection to continue as normal.

## MCP

The official [`@deepseek-ai/dsh-mcp-client`](https://deepseek-harness.github.io/deepseek-harness/reference/config-catalog#deepseek-ai-dsh-mcp-client)
provides full MCP support. Each configuration line mounts one server, whose tools are registered in
the tool runtime as `mcp__<server>__<tool>` and become available to the model automatically.
Insert servers in the profile patch at `~/.dsh/profiles/cc-tui/cordis.patch.yml`:

```yaml
# stdio server (local command)
- insert:
    - id: mcp-context7
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: context7
        command: npx
        args: ['-y', '@upstash/context7-mcp']

# streamable-http server (remote)
- insert:
    - id: mcp-remote
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: streamable-http
        serverName: remote
        url: https://example.com/mcp
        headers: { Authorization: !!js process.env.MCP_TOKEN }
```

Use `/mcp` to view connected servers and their tool counts.

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Enter` | Send (`Shift+Enter` inserts a newline); execute the selected item when the command menu is open |
| `Ctrl+C` | Interrupt the current turn; press twice while idle to exit |
| `Esc` | Close command/file menus; double-tap while idle to clear input; **double-tap with empty input to rewind** |
| `Ctrl+O` | Expand/collapse details, including full thoughts, tool arguments, and output |
| `Ctrl+R` | Search message history |
| `/` | Full-text search within the session (`n`/`N` to navigate) |
| `Tab` | Complete commands or `@` file paths |
| `Ctrl+V` | Paste text at the cursor; **files/images copied in Explorer insert their file paths** |
| `?` | Open the shortcut menu |
| `Shift+Up` | Enter message-selection mode (Enter expands one message) |

**Mouse (`fullscreen: true` alternate-screen mode; disabled by default and enabled through a profile-patch override)**

| Action | Result |
|---|---|
| Drag to select | Select text inside the app and **copy immediately on release** using OSC 52 with native `wl-copy`/`xclip`/`xsel` fallbacks; tmux uses `load-buffer -w`. The selection clears and a `Copied N characters` notice appears. |
| Double/triple click | Select a word/line and copy it immediately |
| Wheel | Scroll the message list |
| `Esc` | Cancel an in-progress drag without copying |

> Fullscreen mode renders on the alternate screen, returning to the main screen when the TUI exits.
> Set `fullscreen: false` to use inline mode and return mouse selection to the terminal emulator;
> copy-on-select then depends on terminal settings such as kitty's `copy_on_select yes`.
> Set `CC_TUI_DISABLE_MOUSE=1` to temporarily disable mouse click handling in fullscreen mode.

**Questionnaire (when the model invokes `ask_user_question`)**

| Key | Action |
|---|---|
| `Up/Down` | Select an option |
| `Space` | Toggle an item in a multi-select question |
| `Tab` | Switch to a custom response and type without selecting an option |
| `Enter` | Submit the current selection |
| `Esc` | Abort the question; the model receives `ASK_ABORTED` and can continue |

**Local commands (the complete CC command set, all routed through official DSH mechanisms)**

| Group | Commands |
|---|---|
| Sessions | `/new` new session · `/resume` restore · `/clear` clear screen · `/compact` compact · `/export` export Markdown |
| Status | `/status` session info · `/cost` token usage · `/doctor` environment diagnostics · `/config` configuration sources · `/init` create AGENTS.md |
| Model | `/model` picker · `/thinking` thought display · `/tokens` token details · `/theme` theme picker |
| Account/policy | `/login` credential status · `/logout` logout help · `/permissions` permission info · `/add-dir` file-policy scope · `/hooks` · `/mcp` · `/memory` |
| Skills | `/audit` code audit · `/bug` bug report · `/review` code review · `/practice` coding practice · `/pr_comments` PR comments · `/release-notes` release notes · `/vuln-check` vulnerability check |
| Other | `/agents` subagent list · `/vim` · `/terminal-setup` · `/connect` · `/help` · `/exit` |
| Registry | `/plan` `/goal` (DSH command-registry plugins, automatically included in the `/` menu) |

> The `/` menu is the union of local and registry commands; registry descriptions come from each
> plugin. `/plan [off|message]` toggles plan mode, while
> `/goal [create/edit/pause/resume/clear target]` manages persistent goals.
> Skill commands use the DSH skill system. The `skills/` directory ships in the npm package and is
> registered automatically at plugin startup, with **no manual copying required**. You can override
> a skill by placing its SKILL.md in a discovery directory (`~/.dsh/skills`, `~/.agents/skills`, or
> the project's `.dsh/skills`). A command sends the activation prompt to the model, which loads the
> skill through the skill-directory/loading tools. The npm version of install.sh no longer installs
> skills separately.

## Technical Highlights

- **Gentle Mist Blue palette**: mist blue is reserved for branding, focus, interaction, and
  highlights, while body text stays neutral. At startup, the TUI queries the terminal background
  through OSC 11. Light terminals use the strict Gentle Mist Blue palette with ink-colored
  `#343945` body text and a warm off-white family; dark terminals use a mist-blue adaptation with
  warm gray-white `#E8E6E0` text and a soft mist-blue accent. It falls back to dark when the terminal
  does not respond. `CC_TUI_THEME=light|dark|dark-ansi` pins a palette and skips detection; custom
  themes under `~/.dsh-cc/themes/` are also supported as described above.
- **Event-driven rendering**: the `session/event` stream drives incremental differential rendering,
  with scroll state maintained independently.
- **Layout-level virtualization**: the layout engine is a pure-JavaScript port of Yoga, and every
  commit would otherwise re-layout the entire tree. That makes frame cost grow linearly with long
  sessions. The message list mounts only the visible window; offscreen rows become fixed-height
  placeholders based on their last Yoga measurement, and their subtrees do not participate in
  layout. Per-frame cost falls from O(full session) to O(visible window), while total height,
  bottom-follow behavior, scrollbars, and search navigation remain unchanged. Search first forces an
  unmounted row to mount before locating it.
- **Context meter**: based on the pi-nano-context algorithm, using largest-remainder segmentation and
  compact multilevel values on the right, with a DeepSeek blue-and-white palette.
- **TPS gauge**: based on pi-tps-meter, with a streaming 1/8-cell gauge, historical min-max
  sparkline, and semantic speed colors (>=50 green, >=20 yellow, <20 red).
- **working-activity ecosystem**: the activity line consumes log-only `activity/status` events from
  [dsh-working-activity](https://github.com/ccch1mneyyy/dsh-working-activity), the same data source as
  the Web UI. cc-tui only renders the events, and `⏵` narration is removed automatically from the
  normal chat body.
- **Session resume**: `/resume` titles use the first user message from each of the 20 most recent
  sessions in an eight-row scrolling window. Sessions are sorted by most recent use; sending a
  message, resuming, or switching moves the session to the front. Timestamps are stored in
  `~/.dsh-cc/last-used.json`, falling back to creation time when absent. Enter switches immediately
  and replays history; startup with `--resume` uses the same path.
- **Rollback semantics**: the fork boundary is the start of the message's turn in the DSH event
  sequence (`turn/start -> user/message -> turn/end`). An interrupted turn waits for persistence
  before forking.
- **Terminal paste**: Ctrl+V is handled by the app in raw mode. PowerShell `Get-Clipboard` reads the
  clipboard; files or images copied in Explorer return a FileDropList and insert paths, quoting paths
  with spaces automatically. Plain text is inserted unchanged at the cursor, including newlines,
  without accidental submission. Native terminal paste via Ctrl+Shift+V or right-click uses bracketed
  paste and likewise inserts rather than submits.
- **Questionnaire (`ask_user_question`)**: a TUI adapter for the DSH user-interaction ecosystem.
  Instead of appearing as a tool card, `ask_user_question` opens a Gentle Mist Blue questionnaire
  panel with one question per screen: an `x/N` progress header, title badge, options and descriptions,
  multi-select checkboxes, and a Tab-accessible custom response. Keyboard behavior matches the
  official dsh-tui semantics: Up/Down selects, Space toggles, Enter submits, and Esc aborts with
  `ASK_ABORTED`. A Q&A summary is folded into the session record afterward. Multiple questions in a
  batch and concurrent subagent questions are presented one by one in FIFO order. The service line
  comes from dsh-base; on a bare installation the plugin creates the service, registers the provider,
  and mounts the model-side tool itself.

## Known Limitations

- Injected context from plugin source content is not displayed separately; it is included in the
  system-prompt segment of the context meter.
- `/model` switches through a session fork because DSH has no in-place model-switch API. History is
  preserved unchanged in the new session, which routes to the new model; the old session remains in
  the `/resume` list. The choice is written to `~/.dsh-cc/model.json` and is honored after restarts
  and by `/new` (rewinds keep the current model too).
- Ctrl+V clipboard access depends on PowerShell `Get-Clipboard`. If another process such as Explorer
  briefly locks the clipboard, the TUI retries automatically; a persistent lock fails silently and
  shows `Clipboard is empty`.
- Exit terminates the process without waiting for the agent's asynchronous flush; the persistence
  plugin provides the fallback.
- DSH `/permission` sandbox switching is not adapted. It requires an approval service and approval
  UI, and this TUI deliberately does not mount a flow it cannot consume. `/permissions` only explains
  the current behavior.
- `/vim`, `/connect`, `/hooks`, and `/memory` are Claude Code-compatible placeholders. DSH has no
  equivalent mechanism or the corresponding leaf is not mounted, so each command provides an
  explicit explanation instead of failing silently.
