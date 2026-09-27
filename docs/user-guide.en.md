# dsh-TUI User Guide

[Documentation index](README.md) · [中文](user-guide.md)

> A user manual for day-to-day use: launch, keys, commands, session workflow, UI indicators, and tips.

## Table of contents

- [1. Quick start](#1-quick-start)
- [2. Keymap quick reference](#2-keymap-quick-reference)
- [3. Command reference](#3-command-reference)
- [4. Session workflow](#4-session-workflow)
- [5. UI and status bar](#5-ui-and-status-bar)
- [6. Model / preset / theme / language](#6-model--preset--theme--language)
- [7. Tips](#7-tips)

## 1. Quick start

### 1.1 Install and launch

```sh
# Install the CLI + this plugin (the plugin ships its own dsh-tui command)
npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui

# Start (first run auto-initializes the dsh-tui profile, needs pnpm)
dsh-tui
```

- `dsh-tui --resume`: resume the last session. On Windows you can also use `dsh-tui.cmd` from the repo (equivalent).
- `dsh-tui safe`: safe mode — read-only environment view, lists profile plugins, suggests fixes, and can create a clean rescue profile (see §5.5).
- `dsh --profile dsh-tui`: manual launch, equivalent to `dsh-tui` (`/update` only works this way).
- Running a model needs `DEEPSEEK_API_KEY`. Run `/doctor` to check the environment.
- Primary verified dsh engine version: `0.1.7-rc.2`. See `ADAPTER.md` for compatibility lines; versions outside that list show a drift note and the command to align on the logo page.
- If the logo page shows a ⚠ version-drift warning, align the dsh engine:
  `npm i -g @deepseek-ai/dsh@<版本>`

### 1.2 What you see on first launch

1. **Pixel whale header** (~3.4 s intro animation, then frozen): `✦ dsh-TUI` version,
   `DEEPSEEK / HARNESS` big text, current model and effort, working directory, and a
   **startup hint** (`/model` · `/help` · `Tab`). Hidden below 64 columns.
   When the dsh engine is out of the verified range, a **⚠ version-drift warning**
   appears with the align command.
2. **Bottom status bar**: working-status row, context bar, TPS gauge, and other live
   indicators (see [5. UI and status bar](#5-ui-and-status-bar)).
3. **Startup hint line**: one fixed line under the logo:
   `提示：<随机小技巧> · /tips 更多技巧` — changes each launch.
   `/tips` opens the full tips panel (`↑/↓` scroll, `Esc` close).
4. **First normal launch** (no `--resume`, no workspace, no prompt) enters the
   **session manager** to pick a workspace. `~/.dsh-tui/home.json` records "seen"
   so later launches go straight to chat. Open it any time with `/resume`, `/home`,
   `/agentview`, `/bg`, or `⌸` at the start of the input line.
5. Type `/` for the command menu, `?` for the shortcut help.

### 1.3 Core mental model

- Every command supports **Tab completion** (for commands with arguments,
  type `/命令 ` first, then Tab).
- Non-command input is a normal message. **Unknown commands are sent to the model as plain messages**.

## 2. Keymap quick reference

> In the tables, `Ctrl` on macOS can usually be swapped for `⌘` (`⌘V` `⌘O` `⌘R` `⌘T` `⌘L` `⌘Enter`);
> `Ctrl+C`/`Ctrl+D` stay `Ctrl`.
> `⌘` needs the extended keyboard protocol (see §5.4). Terminal.app: use Ctrl.

### 2.1 Send and deliver (three behaviors while the model is working)

| Key | Action |
|---|---|
| `Enter` | idle = send; **model working = steer** (inject a next-step boundary, no interrupt); menu open = confirm selection |
| `Tab` | complete `/` command or `@` file; **model working = follow-up** (queue after the current turn) |
| `Ctrl+Enter` (⌘Enter) | interrupt the current turn and send the input now |
| `Shift+Enter` / `Ctrl+J` | newline (`Option+Enter` is the mac Terminal.app fallback) |
| `Alt+Up` | bring the last unhandled message back to the input for editing (no interrupt) |
| `Esc` (working + pending) | interrupt the turn and re-send the pending message now |
| `/btw …` while working | Enter runs it directly (side question never interrupts the main turn) |

### 2.2 Interrupt / exit / system

| Key | Action |
|---|---|
| `Ctrl+C` | working = interrupt; if the interrupt won't settle, press again = force quit; idle with input = clear input; idle empty input = double-press exit (3 s window) |
| `Ctrl+D` | working = interrupt (press again if it won't settle = force quit); idle = double-press exit |
| `Ctrl+L` (⌘L) | clear screen and force redraw |
| `Ctrl+O` (⌘O) | expand/collapse details (full thinking, tool args and output) |
| `Ctrl+E` | in input = cursor to line end; in transcript = expand/collapse hidden old messages |
| `Ctrl+P` | toggle the loaded-context panel at startup (works when the panel is on screen) |
| `?` | empty input = open shortcut/command help menu |

### 2.3 Search

| Key | Action |
|---|---|
| `Ctrl+R` (⌘R) | history search; press again or `↓` for next match; `Enter` fills the input |
| `/` (transcript) | full-transcript search; `n` / `N` jump (only in Ctrl+O expanded state) |

### 2.4 Input editing

| Key | Action |
|---|---|
| `←` / `→` | move the cursor by character (with a selection, collapse to that edge) |
| `Ctrl+←` / `Ctrl+→` (⌘←/→) | jump by word |
| `Home` / `End`, `Ctrl+E` | logical line start / end (`Ctrl+A` now opens the subagent panel, see §2.7) |
| `Ctrl+U` / `Ctrl+K` | delete before the cursor (to line start) / after the cursor (to line end) |
| `Ctrl+W` | delete the previous word |
| `Backspace` / `Delete` | delete previous / next character; **with a selection, delete the whole selection** |
| `↑` / `↓` | move between lines when multi-line; browse input history when single-line (last 200 entries, kept across restarts) |
| `Ctrl+V` (⌘V) / `Alt+V` | paste: text / file path (images auto `@`-referenced) / clipboard bitmap (`[Image #N]` attachment); use `Alt+V` when the terminal swallows `Ctrl+V` |
| `Ctrl+G` | edit the input in the `$VISUAL`/`$EDITOR` external editor (`:cq` keeps the draft; prompts you to configure when unset) |
| `Ctrl+Shift+E` (⌘⇧E) | open the **full-screen draft editor** (or click `⛶` at the end of the input line): line numbers, current line highlighted, `Enter` newline, `Ctrl+Enter` send, `Esc` collapse (draft kept); off at `/settings → 全屏草稿编辑` |
| long draft auto-fold | pasting a block **≥6 lines or ≥600 chars** folds into a `▸ N 行・M 字` chip: click the chip or `▾` to toggle; `Enter` always submits the full text |
| `/vim` | **vim editing mode toggle** (per-session, not persisted): shows an `INSERT` badge, `Esc` to `NORMAL`, `i/I/a/A/o/O` back to INSERT. NORMAL keys below |
| typing | **replaces the whole selection when one exists** (like a standard editor), cursor lands after the inserted text |
| right-click / `Ctrl+Shift+V` | terminal-native paste (newlines inserted as-is) |
| `Esc` (input) | closes layer by layer: help → **image preview** → command menu → file menu (only the current `@` token) → **clear selection if any (text stays)** → re-send interrupt → clear input → double-press = time-travel |
| double-press `Esc` (empty input) | **time-travel rewind** (press twice within 3 s) |

**vim NORMAL keys**: move `h/l` `j/k` `0/^/$` `w/b`;
delete `x/X` `dd`/`d$`/`d0`/`d^`/`dw`; `u` undo, `Enter` send.
Unrecognized keys are ignored, `Esc` does nothing, clear with `Ctrl+C`/`dd`.

### 2.5 Navigation / modes

| Key | Action |
|---|---|
| `Shift+Tab` | cycle session mode (default → plan → full access); mounted third-party permission presets follow in registry order at the end of the cycle |
| `Shift+↑` | message selection mode (`↑/↓` move, `Enter` expand one, `Esc` exit) |
| `Ctrl+T` (⌘T) | open the trace scene (same as `/trace`) |

### 2.6 Mouse (fullscreen mode; drag/double-click/triple-click select-and-copy)

| Action | Effect |
|---|---|
| left-drag | select text, **copy on release** (OSC 52 + system clipboard tools as fallback), auto-clear the selection |
| double-click / triple-click | select word / line, copy immediately |
| wheel | scroll the message list (±3 rows/notch); **with a text selection, pan the selection with the content** |
| in the input box | drag / Shift+click / double-click build a selection; `Backspace`/`Delete` delete it, typing replaces, `←/→` collapse, `Esc` clears only the selection, `Ctrl+C` copies it |
| `Esc` | clear the selection (no copy) |
| single-click | message row = expand/collapse · hyperlink = open browser · 「加载更早消息」/StickyHeader/「↓ N new」= load/jump |
| hover truncated content | hover ~600 ms to show full content in a popover; no popover while dragging a selection |
| keyboard selection extend | with a selection, `Shift+←/→/↑/↓/Home/End` extends/shrinks (wraps across lines) |

### 2.7 Per-scene keys

**Questionnaire (model ask_user_question)**

- `↑/↓` select, `Space` multi-select, `Tab` jump to custom answer, `Enter` submit; `Ctrl+V` paste, `Ctrl+K` fold.
- `Esc` back from question 2 onward, cancel the whole batch on question 1; `Ctrl+C` cancel on any question.

**Plan review**

- `↑/↓` move, `1`/`2` quick pick; typing = fill feedback (`Ctrl+V` paste, `Enter` submit); `Esc` interrupt; **approve must have no feedback**.

**Tool approval**

- `↑/↓` move, `1` allow (this time only), `2` deny, `Enter` submit; `Esc`/`Ctrl+C` deny.

**Session manager** (`/resume`, `/home`, `/agentview`, `/bg`, `⌸` at the input line start — the same screen)

- Layout: left workspace column, right session column; ≥84 columns side-by-side, narrower hides the workspace column.
- Switch column `←/→`; move `↑/↓`/`PgUp`/`PgDn`; **typing = live filter** (by title/dir/branch/model).
- Enter `Enter` (row 0 = new session in that workspace); new `Ctrl+Enter`/`Ctrl+N`; stop background session `Ctrl+X`.
- `Ctrl+L` reload · `Shift+Tab` open action menu · `Esc` close hint → clear filter → leave.
- Mouse: click a session row = enter, click `★`/`☆` = toggle pin only, right-click a workspace row = action menu.
- Empty input + `←` (or `/bg`) = send to background and open this screen, session keeps running.

Switching sessions just parks the current one — the running turn keeps going.
A session taken by another terminal shows red with `占用 pid <pid>`
and can't be entered; it recovers after that terminal exits.
Fixed items live in `~/.dsh-tui/session-pins.json`.
The workspace menu has four items: edit / new here / rename / remove from list (**removes the entry only**, directory and session log stay).

**Image preview** (open by clicking `[Image #N]` in the input or a thumbnail in the transcript)

- `←/→` previous / next; bottom-button zoom: `适应`/`100%`/`200%`/`400%`/`800%`;
  drag or wheel to pan.
- `Esc`/`Ctrl+C`/`Enter` or click outside to close.
- The bottom 「打开原图」opens the original file in the system viewer.

**IDE selection** (VS Code companion extension `dsh-tui-vscode`, needs ≥ 0.7.0)

- Select code in the editor → a `⧉ N lines selected` badge appears **live** under the input, and the selected lines are **auto-attached** to context on submit.
- The transcript shows a 「⧉ Selected N lines from <相对路径>」
  indicator line (text from the editor, unsaved changes included).
- No IDE installed/connected → skipped automatically, nothing else affected (see [vscode.md](vscode.md)).

**History search (Ctrl+R)**
`↑/↓` select · press `Ctrl+R` again or `↓` for next · `Enter` fill · `Esc`/`Ctrl+C`/`Ctrl+D` cancel

**Trace scene (Ctrl+T / /trace)**
- `↑/↓`/`PgUp`/`PgDn` move · `←/→` (or `h`) switch timeline/hotspot · `g`/`G` top/bottom · `q`/`Esc` exit
- `[`/`]` jump failure · `{`/`}` jump turn · `m` cycle projection · `Enter` expand details (`j`/`k` page) · hotspot `t` sort
- `/` query line (prefixes `tool:` `kind:` `turn:` `err:` `run:` `>10s` `tok>1k`)

**/settings panel**
`↑/↓` move · `Enter` expand/toggle/edit · `←/→` cycle a field that has options (booleans still only respond to `Enter`) ·
changes save automatically, `Esc` exits

**/btw panel**
`↑/↓` scroll · `Space`/`Enter`/`Esc` close · `c` copy answer · `Esc` cancels while waiting

**/effort slider**
`←/→` adjust live (Esc does not revert) · `Enter`/`Esc` done

**@ file completion**
`@` triggers anywhere in the message · `↑/↓` move · `Tab`/`Enter` accept · directories drill down ·
`Esc` closes only the current token menu
- **Two query modes**: path-like input (`@src/` `@./` `@~/` `@D:\`) lists only that directory;
  plain fragments use **fuzzy subsequence match** (`@ink` hits `src/ink/Box.js`).
- Image paths auto-become `[Image #N]` attachments.

**Subagent panel (Ctrl+A)**
`↑/↓` browse · `Enter` view details · `Esc` close; details page `←/→` page, `X` interrupts while running; subagents render as live card rows. The panel mirrors every child this session dispatched — `subagent`/`send_message` runs, continuable re-dispatches (each new run resets the row), and workflow/ralph members — and re-folds durable discovery facts from the session log on resume, so restarting no longer blanks it. Historical rows without live timing show a `⚪` state instead of a fake duration.

**Double-press Esc time-travel (rewind)**
List `↑/↓` + `Enter` to confirm · confirm page `Enter` rewind / `Esc` back · only `Esc` responds while a plugin decision is pending

## 3. Command reference

The command menu = built-in commands (50) + DSH registry commands (`/plan` `/goal` etc.) + the skill catalog
(completion only, hidden from the `/help` menu). `/lang` switches the UI and command descriptions between English and Chinese.

### 3.1 Session

| Command | Args | Effect |
|---|---|---|
| `/new` | none | start a new session (no confirmation; the old session stays under `/resume`) |
| `/resume` | none | open the **session manager** (workspace + session columns, live filter, pins, cross-workspace): switching just parks the session, the running turn keeps going |
| `/home` / `/agentview` / `/bg` | none | the same session manager (`/home`=workspace view · `/agentview`=hosted session state · `/bg`=send to background and open, alias `/background`) |
| `/tree` | none | session fork tree: hover to preview, click to rewind / fork / switch branch |
| `/fork` | none | copy the current session into a resumable clone (original unaffected) |
| `/restart` | none | restart the process and resume this session (rejected mid-turn, `Ctrl+C` first) |
| `/rename` | `<新名称>` | rename the current session (no arg shows the current title and usage) |
| `/recap` | none | recent-activity summary (one line) + suggested title; press `a` or click to apply the title. With `dsh-tui.recapOnOpen` (default on), opening/resuming a session auto-shows a divider + `回顾：` summary line at the bottom; hover to view actions, click to expand, gone after the next message |
| `/workspace` | `resume` / `rename <名称>` / `open <路径或URI>` | manage workspaces; `open` accepts an absolute path, file URI, or plugin scheme |
| `/clear` | none | clear the current session view (reset expand/selection state) |
| `/compact` | none | compact session history (prompts when nothing to compact) |
| `/export` | none | export the session as Markdown to the working directory |
| `/btw` | `<问题>` | side question: single turn, no tools, doesn't interrupt the main turn, not written to history |
| `/trace` | none | open the trace scene (same as `Ctrl+T`) |
| `/rewind` | none | rewind selector (same as double-press Esc on empty input) |
| `/exit` (alias `/quit` `/q`) | none | exit dsh-tui |

### 3.2 Status and diagnostics

| Command | Args | Effect |
|---|---|---|
| `/context` | none | loaded-context detail (instructions/runtime context/skills/tools etc.) |
| `/status` | none | model+effort, working/idle, session id, dir+git branch, token, cache hit rate, context percentage, session title |
| `/cost` | none | token usage + cache hit rate (DSH provides no cost metering) |
| `/balance` | none | DeepSeek official account balance (free read-only API): summary line + hover detail, click refresh, `×` close |
| `/config` | none | config sources: `cordis.patch.yml` path, launch method, model routing |
| `/doctor` | none | environment check |
| `/init` | none | create `AGENTS.md` in the working directory (created / exists / failed) |
| `/agents` | none | subagent list for this session |
| `/jobs` | none | background-task panel: status/runtime/exit-code tracking, `↑/↓` select, `k` stop; while open, `Esc` **closes only the panel** and won't interrupt the turn (close the panel first, then `Ctrl+C`) |
| `/settings` | none | open the plugin settings editor (namespace read/edit) |
| `/help` | none | shortcut + command help menu (`?` entry) |

### 3.3 Model / display

| Command | Args | Effect |
|---|---|---|
| `/model` | none | model selector; **switching = fork the session** (history kept, only routing changes), choice persisted to `~/.dsh-tui/model.json` |
| `/effort` | `status` / `<id>` | reasoning effort: no-arg slider (`←/→` adjust); `status` current level; `<id>` set directly. Persisted to `~/.dsh-tui/effort.json`; new-session start level follows /settings `effortDefault` (§5.3) |
| `/thinking` | none | extended-thinking display toggle (thinking expands item by item while streaming) |
| `/tokens` | none | token usage + context percentage |
| `/activity` | `frames <名>` / `status` | working-status animation: no-arg selector, `frames <名>` sets directly (includes `random`), default `moon8`. Persisted to `~/.dsh-tui/working-activity.json` |
| `/preset` | `<id>` / `status` | agent preset: `standard` / `ptc` (old 0.1.1 name `code`) / `minimal` / `cordis` / **Liangshen mode `liangshen`**; **cannot switch an already-started session**. Persisted to `~/.dsh-tui/agent-preset.json` |
| `/theme` | `<名字>` / `status` | theme: no-arg selector; `<名字>` switch directly; `status` current theme (auto appends the OSC 11 result). Persisted to `~/.dsh-tui/theme.json` |
| `/color` | no-arg / `<名>` / `status` / `reset` | session accent color: no-arg opens the palette (`↑/↓` pick, `Enter` apply); `<名>` set directly; `reset` back to default. Colors `red/orange/yellow/green/blue/purple/pink/cyan`, saved per session |
| `/lang` | `en` / `zh` / `status` | hot-switch UI language. Priority: `DSH_TUI_LANG` > profile config (legacy: settings.yaml user layer > cordis.yml) > persisted |
| `/vim` | none | **vim editing mode toggle** (see §2.4): input switches to vim keys, per-session, not persisted |

### 3.4 Account / policy / extensions

| Command | Args | Effect |
|---|---|---|
| `/provider` | none | interactive model-provider wizard (add / edit / delete; with dsh-auth bound, **OAuth subscription login** for ChatGPT / Claude / Grok, no API key) |
| `/login` | none | credential status (source, store writability, base URL) |
| `/logout` | none | logout notes (env source: delete the variable and restart) |
| `/permission` | none / `<preset>` / `status` | view/switch permission preset and policy (no arg opens the selector) |
| `/add-dir` | none | file-policy scope notes (rooted at the working directory) |
| `/hooks` | none | placeholder: notes when DSH hooks aren't mounted in the composition |
| `/mcp` | none | MCP connection state (tools grouped as `mcp__服务器__工具`); shows a `cordis.patch.yml` snippet when unconfigured |
| `/skills` | none | skill-catalog selector (name+source+blurb); Enter fills a direct-call skill as `/name ` |
| `/plugins` | `check <dsh-plugin.json 路径>` | plugin diagnostics: trust banner + host descriptor + authorization matrix + ledger; `check` validates a manifest and reports compatibility |
| `/update` | none | update the TUI and auto-restart to resume the session (only via `dsh --profile`; rejected mid-turn) |
| `/terminal-setup` | none | terminal setup advice (Windows Terminal ≥110 columns, paste keys) |

### 3.5 Skills

dsh-TUI ships no generic skills; `/skills` browses skills DSH discovers, and a direct-call skill joins the command menu as `/name` (see §4.8).

### 3.6 Placeholder commands

`/connect`: placeholder — DSH has no remote-connection mechanism yet.

### 3.7 Registry commands (from the DSH ecosystem, merged into the `/` menu)

| Command | Effect |
|---|---|
| `/plan` | `[off\|message]` plan mode; `/plan off` exits |
| `/goal` | set/view the session goal |
| `/feedback` | submit usage feedback |
| `/permission` | view/switch presets from the DSH `permissionPresets` registry (third-party presets in registry order) |

> These commands come from the DSH command registry; this repo only merges them into the menu, completes, and dispatches.

## 4. Session workflow

### 4.1 Session lifecycle

| Action | Command/Key | Notes |
|---|---|---|
| New | `/new` | no confirmation — the old session is persisted, always reachable via `/resume`; also clears the resume marker |
| Resume | `/resume` (same as `/home` `/agentview` `/bg` and `⌸` at the input line start) | the three-in-one **session manager**: `←/→` switch column, type to filter, `Enter` enter, `Ctrl+N` new, `Ctrl+X` stop background session, `★`/`☆` pin. Switching just parks the session, the turn keeps running; a session taken by another terminal shows red and can't be entered (see §2.7) |
| Rename | `/rename <标题>` | rename immediately and persist (writes a session/title event, readable back in the session manager) |
| Compact | `/compact` | trigger DSH compaction manually; **rejected mid-turn**; unavailable under minimal preset; the compaction point renders as a Divider summary row |
| Export | `/export` | export Markdown from the full session log (thinking and tool-call sections), file `dsh-tui-export-<时间戳>.md` in the current session cwd |
| Clear | `/clear` | clears the view only, never the session log |
| Stop | session manager `Ctrl+X` | stop the **background** session under the cursor; the session the current terminal is using can't be stopped (exit the whole TUI with `/exit` or double-press `Ctrl+C`) |
| Exit | `/exit` (or `/quit` `/q`) | double-press `Ctrl+C` or `Ctrl+D` also exits when idle; mid-work, press `Ctrl+C`/`Ctrl+D` again to force quit when the interrupt won't settle |

Command-line resume: `dsh-tui --resume` (last session) / `dsh-tui --resume <id>` (specific session).
`-c` / `--continue` are equivalent.

### 4.2 Time-travel rewind (double-press Esc)

**Double-press `Esc` on empty input** (or `/rewind`) opens the rewind selector:

1. The selector lists **your own messages** (newest first), `↑/↓` + `Enter` to pick.
2. If the model is working: cancel the turn and wait for it to settle (up to 30 s).
3. The boundary is **before the turn** that message belongs to; **can't rewind past the first message**.
4. The system forks a new session and replays history to the rewind point, **puts the original message back in the input** for editing and resend.
5. The rewind branch stays in the `/resume` list, keeps the current model routing + the session's own preset.

### 4.3 Message delivery semantics (while the model is working)

Keys are in §2.1:
- `Enter` = **steer** (inject a next-step boundary, no interrupt)
- `Tab` = **follow-up** (queue after the turn)
- `Ctrl+Enter` = **interrupt** (interrupt and send)
- `Alt+Up` bring the last unhandled message back
- `↑` recalling a message that is still queued also withdraws that queued entry (same as `Alt+Up`, so the same text is not sent twice); once the running turn claimed it, only a notice appears
- `Esc` (with pending) interrupt and re-send
- `/btw …` side question never interrupts the main turn

### 4.4 Side question /btw

`/btw <问题>`: one no-tool, single-turn answer reusing the current context,
**not written to history, no token counted**.
Panel `↑/↓` scroll · `c` copy · `Esc` close.

### 4.5 Trace scene (Ctrl+T / /trace)

Full-screen view of the whole session timeline (doesn't pollute scrollback); keys are in §2.7.

### 4.6 Model switching and presets

- `/model`: selector. **Switching = fork the session** (history kept, only routing changes, the old session stays in `/resume`);
  persisted to `~/.dsh-tui/model.json`.
- Switching is rejected mid-turn.
- `/preset` options: `standard` (default full features), `ptc`, `minimal` (bash+editor only, no compaction),
  `cordis`, `liangshen` (Liangshen mode).
  **A session that already has messages can't switch** (blank-only): the choice only becomes the default for the next `/new`.
- Cycle session mode with `Shift+Tab`: default (workspace-write + approval) → plan (read-only) →
  full (danger-full-access).
- Third-party permission presets follow in registry order at the end.
- **After approving a plan or `/plan off`, sandbox and approval policy return to the pre-plan state**.

### 4.7 Questionnaires and approvals

Keys are in §2.7. Key points:
- Questionnaire **last line is a free-input line** (typing submits together with the option label).
- Plan review **approve must have no feedback text**.
- When an approval and a questionnaire hang at once, **approval wins**.
- A background-session approval is tagged `来自后台会话 <会话 id 前 8 位>`.

### 4.8 Skills / registry / Goals-Todos

- `/skills` browses the skill catalog; a direct-call skill joins the command menu as `/name` (dsh-TUI ships no generic skills).
- `/plan` `/goal` `/feedback` `/permission` come from the DSH registry, merged into the `/` menu.
- **Goals/Todos panel appears automatically**: when the model writes a goal/todo, it renders above the input
  (🎯 goal + phase badge + tree todo), no action needed.

### 4.9 MCP / Workspace / other

- `/mcp`: lists `mcp__服务器__工具` grouped by server;
  shows a `cordis.patch.yml` snippet when unconfigured.
- `/workspace`: `resume` / `rename <名>` / `open <路径|file:// URI>`
  (open and start a new session).
- `dsh-tui <路径>` also accepts a workspace target.
- `/doctor` check: Node/platform, API key, model routing, cwd, context window, session storage, plugin host.
- `/provider` interactive wizard to manage model providers: add / edit / delete.
  - With dsh-auth bound, **OAuth subscription login** (ChatGPT / Claude / Grok, no API key).
- Non-env-variable keys are written to `~/.dsh/.credentials.yaml` (0600), the UI shows only `••••••`.
  - Custom endpoints need route name, API key, baseURL, and protocol (`openai-completions` / `openai-responses` /
  `anthropic-messages`).
- After add/edit, run `/model` to switch to the new route.
- `/init` creates AGENTS.md; `/agents` subagent list; `/login` `/logout` credential management.
- `/permission` `/add-dir` permission notes; `/hooks` `/vim` `/connect` are placeholders.

## 5. UI and status bar

An empty session shows the whale logo area at the top (scrolls away with the conversation):

- **Intro animation** (~3.4 s, three picked each launch, `/deepseek` egg re-rolls): classic / heart / sleep.
- **Welcome idle animation** (`whaleIdle`, default on): fin, blink, tail wag, sleeps with Z after 10 s idle; **click to show a heart and wake it**.
- After the first agent task, it freezes to a static frame (`/new` re-enters the welcome period).
- Text column right of the whale: `✦ dsh-TUI v版本号` →
  `DEEPSEEK / HARNESS` big text → current model + effort → working directory → startup hint line.
- Out of the verified range, a **⚠ version-drift warning** appears (with the align command).
- Centered tagline under the whale: `探索未至之境！`.
- The whale is hidden **below 64 columns**.
- Pixel whale art and idle behavior ported from [dsh-ui-whale](https://github.com/lhh010/dsh-ui-whale) (author
  [@lhh010](https://github.com/lhh010)), with thanks.

**Long single-line fold** (default on)

- Text with **a single line over 1000 chars** folds into
  `… 已折叠 N 字符（点击或 ctrl+o 展开）` marker.
- Expand: **click the line** (tool card: click the card) to unfold, click again to fold; keyboard `Ctrl+O`.
- Thinking lines don't fold.

### 5.2 Bottom status bar (three rows under the input)

**Row 1 — context segment bar** (`/settings → statusBar.contextBar`, default on)

- Colored by content type (system / prompt / assistant / thinking / tools).
- The only text on the bar is the right-edge reading `13k/64k 19.5%` (narrow screens show only `19.5%`).
- The reading colors by usage: <80% gray-blue, **≥80% amber, ≥95% red**.
- Hover the whole bar for the legend: color block + name + token count (narrow screens shorten the names).

**Row 2 — status field row** (each field toggled separately, see `/settings`)
- left group: model → TPS → thinking → mode → ctx → cache hit rate → tokens (`1.2k→340` input→output) →
  cost (`≈¥0.05 谷`, **an estimate, the platform bill is authoritative**,
  official models only)
- right group: git branch → working directory (basename only in compact mode) → session title → short session ID (`#` + first 8 chars, for `--resume`)
- `statusBar.compact` merges the two sides into one row.
- Default on: compact, model, thinking, cwd, contextUsage, cache, cost, goal, contextBar.
- Default off: tokens, tps, gitBranch, sessionTitle, sessionId, mode, activity, trajectory.

**Row 3 — hints / working activity + mini trace bar**
- Idle shows `? for shortcuts`, running `esc to interrupt`, selecting `esc to return to input`.
- Idle also shows the working-activity animation (`statusBar.activity` on), context ≥80% amber, ≥95% red.
- Right-side **mini trace bar MiniWake** (`statusBar.trajectory`, default off): session projected as density glyphs, color per channel, failures red;
  degrades/hides on narrow screens.

**TPS gauge** (`statusBar.tps`, default off): streaming shows a live gauge + `N tps`, after the turn a sparkline;
speed **≥50 green / ≥20 yellow / <20 red**.

### 5.3 The /settings editor

`/settings` opens the plugin settings editor; **changes save automatically**, `Esc` exits directly.
On 0.1.7 the dsh-tui block writes to the active profile's `cordis.patch.yml`; older hosts use the settings.yaml user layer. Most settings apply live; fullscreen and image-preview need `/restart`.
Common items below, full list on the /settings screen:

| Field | Notes |
|---|---|
| lang | UI language zh/en (locked when DSH_TUI_LANG is pinned) |
| fullscreen | fullscreen mode (default on); takes effect after `/restart` |
| terminalImages | terminal image preview (default on, needs terminal support); takes effect after `/restart`. Off shows text only and skips preview decode, sending images to the model is unaffected |
| whale | pixel whale header (default on); three intro animations picked per launch (classic/heart/sleep), `/deepseek` egg re-rolls |
| whaleIdle | whale welcome idle animation (default on): fin/tail/blink, sleeps with Z after 10 s idle; click for a heart. Freezes after the first task |
| diffLayout | Edit/Write diff layout: auto (two columns ≥110 cols) / split / unified |
| thinkingFold | thinking block: preview (2-3 line preview + folded when settled) / full (expanded to end of turn) |
| effortDefault | default reasoning effort: auto / off / low / high / max. Start level for new sessions (details below) |
| smoothStreaming | smooth streaming output (default on): replies/thinking/tool-card text reveal at ~30fps; replay/history always direct |
| toolBackground | tool-card background emphasis: none / subtle / strong |
| mermaidDiagrams | Mermaid diagrams (default on): ```` ```mermaid ```` blocks render as character diagrams, forming while streaming; too-wide or unsupported types keep source with the required columns. Applies immediately |
| scrollGutter | transcript gutter: timeline (turn timeline, default) / scrollbar (proportional) / hidden. Applies immediately |
| pageMargin | page margin: inset from all four terminal edges. Presets none / slim / normal (default) / roomy, or custom `NxM` (details below). Applies immediately |
| foldTerminalCommand | fold terminal commands (default off): multi-line commands on terminal cards (Bash/PowerShell) fold to first line + count; `Ctrl+O` or click to expand |
| expandEditor | full-screen draft editor (default on): `⛶` at the input line end or `Ctrl+Shift+E` expands to a full-screen editor; `Ctrl+Enter` send, `Esc` collapse (draft kept); off hides both entries |
| statusBar.* | all status-bar toggles above (compact/model/thinking/cwd/contextUsage/cache/tokens/cost/tps/gitBranch/sessionTitle/sessionId/mode/contextBar/activity/trajectory; statusBar.sessionId is the bottom-bar display toggle, unrelated to cordis startup sessionId) |

**effortDefault**: when the model lacks that level, drop one level and show a notice; priority settings user layer > cordis `effort` >
last `/effort` (effort.json) > model default.

**scrollGutter**: the scrollbar track can be dragged directly; `Shift`/`Alt`/`Ctrl`+drag is still text selection.

**pageMargin**: custom `NxM` = `N` columns left/right, `M` rows top/bottom (cap 8x4); only `N` means 1 row top/bottom.

Namespaces not declared as TUI blocks are listed read-only; edit the profile config by hand (`~/.dsh/settings.yaml` on older hosts).
These settings are **not in /settings**, edit `$DSH_HOME/profiles/dsh-tui/cordis.patch.yml`:
provider / model / cwd / preset / workspace / sessionId / modes,
plus the startup-level `effort` key.

### 5.4 Terminal requirements

- Interactive TTY required; Windows Terminal recommended (≥110 columns, monospace, TrueColor).
- macOS `⌘` modifier needs the extended keyboard protocol (iTerm2 / kitty / WezTerm / ghostty / tmux).
- Terminal.app: use Ctrl.
- VS Code: install the companion extension `dsh-tui-vscode` (gets the **IDE selection channel**, needs ≥ 0.7.0).
- Or run `dsh-tui` directly in the integrated terminal.
- **Images**: thumbnails and full preview need Kitty graphics or Sixel (auto-detected, Kitty preferred).
  - `DSH_TUI_IMAGE_PROTOCOL=auto|kitty|sixel|none` overrides the protocol.
- `DSH_TUI_DISABLE_TERMINAL_IMAGES=1` forces preview off.
  - tmux/screen, non-TTY, and accessibility mode show text only; sending images to the model is unaffected.
- Environment check: `/doctor`.

### 5.5 Safe mode and rescue profile (`dsh-tui safe`)

When dsh exits unexpectedly, safe mode gives a **read-only** environment diagnosis, profile plugin list, and fix guidance.

- **Two entry points**: run `dsh-tui safe` manually; or follow the on-screen prompt after a non-zero dsh exit (non-interactive envs just print a line).
- **Read-only scope**: diagnosis/list/guidance change no state.
- Exception: retry normal startup, or create/reuse a blank rescue profile (writes only `$DSH_HOME/profiles/dsh-tui-safe/`).
- **The rescue profile must prove clean first** (no third-party plugins, no `cordis.patch.yml` entries), else it refuses and prints how to handle it.
- **Non-interactive**: `dsh-tui safe --rescue` only reports the verdict (ready exits 0, refused exits 1).
- **Run the fix commands yourself** (safe mode only lists them):
  - `dsh plugin --profile dsh-tui remove <第三方插件>` remove suspicious plugins.
  - `dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@<版本>`
    reinstall to align.
  - `dsh-tui doctor` environment diagnosis.

## 6. Model / preset / theme / language

| Item | Command | Notes |
|---|---|---|
| Model | `/model` | selector; **switching = fork the session** (history kept, routing only); persisted to `~/.dsh-tui/model.json`, reused on restart and `/new`. Never chosen → built-in default (currently `deepseek-flash`) |
| Reasoning effort | `/effort` | slider (`←/→` live) or `/effort <id>`; `/effort status` for current; new-session default in /settings → default reasoning effort |
| Agent preset | `/preset` | `standard` / `ptc` (old 0.1.1 name `code`) / `minimal` / `cordis` / **Liangshen mode `liangshen`**; **can't switch an already-started session** |
| Theme | `/theme` | `auto` (OSC 11 follows terminal background) / `light` / `dark` / `dark-ansi`; `/theme <名>` direct; `/theme status` for the result |
| Custom theme | manual | `~/.dsh-tui/themes/<名>.json`, `{base, colors}` format, hot-swap on select; naming it `auto` gets shadowed by the built-in |
| Language | `/lang` | `en` / `zh` hot switch; priority `DSH_TUI_LANG` > profile config (legacy: settings.yaml user layer > cordis.yml) > persisted |
| Status animation | `/activity` | selector or `/activity frames <名>`; default `moon8`, `random` randomizes |

**Theme priority**: `DSH_TUI_THEME` > `~/.dsh-tui/theme.json` > OSC 11 terminal-background detection > dark fallback.

**~/.dsh-tui/ preference files** (all best-effort, fall back on bad files):

- `theme.json`, `model.json`, `agent-preset.json`, `effort.json`, `working-activity.json`, `lang.json`,
  `trajectory.json`, `resume.txt` / `last-used.json`, `themes/<名>.json`

**Common environment variables**:

- `DSH_TUI_LANG`, `DSH_TUI_THEME`, `DSH_TUI_PRESET`, `DSH_TUI_PERSONA`
- `DSH_TUI_DISABLE_MOUSE`, `DSH_TUI_DISABLE_TERMINAL_IMAGES`, `DSH_TUI_IMAGE_PROTOCOL`,
  `DSH_TUI_ACCESSIBILITY` (accessibility: no animation/graphics preview)
- `DSH_TUI_RESUME_SESSION`, `DSH_TUI_WORKSPACE_TARGET`, `DSH_TUI_SESSION_ROOT`, `DSH_TUI_DEBUG`,
  `DSH_TUI_RENDER_LOG` (frame capture)
- `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `VISUAL`/`EDITOR` (`Ctrl+G` external editor),
  `DSH_PERMISSION_MODE`

## 7. Tips

**Getting started**

1. `?` for shortcuts, `/` for commands — both have Tab completion.
2. Not sure the environment is right? Run `/doctor`; for the whole session, `/status`.
3. Switch UI language `/lang en|zh`, applies immediately and persists.

**Efficiency**

4. Three deliveries while the model works: `Enter` inject a next step, `Tab` queue, `Ctrl+Enter` interrupt and send.
5. `Alt+Up` brings the last unhandled message back to edit and resend, no retyping.
6. A quick question without interrupting the main turn or writing history:
   `/btw <问题>`.
7. Made a mistake? **Double-press `Esc` on empty input to rewind** (or `/rewind`), edit and resend.
8. `@` completes files anywhere in the message, `@src/a.ts#L12-14` cites a precise line range.
9. `Ctrl+A` subagent panel: `Enter` for details, `X` to interrupt a running subagent.
10. `Ctrl+O` expand/collapse details; `Ctrl+T` for the trace (`[`/`]` jump failure, `/` field query).

**Troubleshooting**

11. Context pressure ≥80% turns amber, ≥95% red — time to `/compact` (unavailable under minimal preset).
12. Session manager (`/resume`, `/home`, `/agentview`, `/bg`, or `⌸` at the input line start):
    type to filter, `★` pin, `Ctrl+X` stop a background session; switching just parks it.
13. Mid-turn, `/compact`, `/model`, `/restart` are rejected — `Ctrl+C` first or wait for the turn to end.
14. `/model` switch = fork (history kept), persisted and reused on restart and `/new`.
