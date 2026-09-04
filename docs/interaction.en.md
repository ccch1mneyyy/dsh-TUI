# Interaction and Commands

[Documentation index](README.md) · [简体中文](interaction.md)

## Input and global shortcuts

| Key | Behavior |
| --- | --- |
| `Enter` | Send while idle; steer text into the running turn at its next step boundary; confirm an open menu |
| `Tab` | Complete a `/` command or `@` file; while the model is working, queue non-empty input as a post-turn follow-up |
| `Ctrl+Enter` | Interrupt the running turn and process the input immediately |
| `Shift+Enter` / `Ctrl+J` | Insert a newline at the caret; `Ctrl+J` (LF) is the fallback when the terminal cannot report the Shift modifier; macOS Terminal.app uses `Option+Enter` |
| `Shift+Tab` | Cycle the configured session modes (default: default → plan → full-access) |
| `Alt/Option+Up` | Pull the latest undelivered message back into the editor |
| `Up/Down` | Select menu items; in ordinary input, browse history or move through multiline text |
| `Ctrl+V` / `Alt+V` | Insert clipboard text or files; images are sent as durable attachments. Use `Alt+V` when the terminal intercepts `Ctrl+V` |
| `Ctrl+G` | Edit the current input in an external editor (`$VISUAL` → `$EDITOR`); saving and quitting fills it back, `:cq`/non-zero exit keeps the draft; with neither variable set the TUI asks you to configure one (no `vi` fallback) |
| `Ctrl+Shift+E` | Expand the fullscreen draft editor (or click the `⛶` affordance at the end of the input row): line numbers + current-line highlight + live line/char stats, `Enter` inserts a newline, `Ctrl+Enter` or the Send button sends, `Esc` or the Collapse button keeps the draft and returns; wheel-scrolls freely, click/drag/double-click selection work as in the inline prompt; remappable via `/settings` |
| `Esc` | Ladder: close help → close the command menu → close the file menu (only the current `@` token) → **with a selection in the prompt input: only clear it (text untouched)** → interrupt the turn and redeliver pending messages → clear non-empty input → double-tap on empty input = rewind; in fullscreen, an active mouse selection is cleared first (not copied) |
| `Ctrl+C` | Interrupt while working; press again while the interrupt is still settling to force-exit; clear non-empty idle input; **while idle with a selection in the prompt input, copy it to the clipboard (selection kept for editing)**; press twice on empty input to exit |
| `Ctrl+D` | Same ladder as `Ctrl+C`: interrupt while working (press again to force-exit if the interrupt stalls); press twice while idle to exit |
| `Ctrl+O` | Toggle transcript/verbose detail, including full reasoning and tool arguments/output |
| `Ctrl+P` | Toggle the loaded-context panel shown at startup (while it is on screen) |
| `Ctrl+T` | Open the trajectory scene (same as `/trace`); `q`/`Esc` returns to the conversation |
| `Ctrl+R` | Open input-history search; repeat or press `Down` for the next result |
| `Ctrl+L` | Clear and force a physical terminal redraw |
| `?` | Open shortcut and command help when the input is empty |
| In Help: `↑/↓`, `PgUp/PgDn`, `Home/End` | Scroll by line, page, or jump to either end; `Esc` closes |
| `Shift+Up` | Enter message selection; arrows move, `Enter` expands one row, `Esc` exits |

The action shortcuts (paste, history search, external editor, `Ctrl+O/T/P/R/L`, subagent dashboard, show-all, todo fold) are remappable in `/settings` → `dsh-tui` → `Shortcuts`: enter combos such as `alt+v`, comma-separate several, leave blank to restore defaults — saves apply live. Combos clashing with the fixed editing keys or another action are rejected. Deployments can also pin them via `shortcuts.<action>` in cordis.yml.

`/` has two meanings. In normal input it opens slash-command completion. In
the `Ctrl+O` transcript view it opens full-session search; use `n` and `N` to
move forward and backward through matches.

Plugins may register additional combos through the `tuiShortcuts` seam (they
must carry Ctrl or Alt); built-in bindings always win and conflicting combos
are refused at registration. A managed plugin dialog (select/confirm/input)
owns the keyboard while open: `↑`/`↓` to move, `Enter` to confirm, `Esc` to
cancel. Plugins may also contribute display-only text to the status line
above the prompt.

## Editing keys

| Key | Behavior |
| --- | --- |
| `Left/Right` | Move by character; **with a selection, collapse to the corresponding edge** |
| `Ctrl+Left/Right` | Move by word |
| `Home/End` | Move to the start/end of the current logical line |
| `Ctrl+A` / `Ctrl+E` | `Ctrl+A` opens the subagent dashboard (`Mod+A` in the editor still moves to line start); `Ctrl+E` moves to line end and also expands or folds hidden older rows in long transcripts |
| `Ctrl+U` | Delete before the caret |
| `Ctrl+K` | Delete after the caret |
| `Ctrl+W` | Delete the preceding word |
| `Backspace` / `Delete` | Delete the character before / after the caret; **with a selection, delete the whole selection** |
| Typing | **Replaces an active selection** (standard editor semantics), caret after the inserted text |

### vim editing mode (`/vim`)

`/vim` toggles vim editing for the prompt (session-scoped, not persisted): the
prompt shows an `INSERT` badge and typing works as usual; `Esc` switches to the
`NORMAL` badge, where bare keys follow vim semantics.

| NORMAL key | Behavior |
| --- | --- |
| `h` / `l` | Move left / right one character |
| `j` / `k` | Move down / up one line (multi-line input) |
| `0` / `^` / `$` | Line start / first non-blank / line end |
| `w` / `b` | Next / previous word start (whitespace-split) |
| `x` / `X` | Delete the character at / before the caret (`x` deletes the last char at line end) |
| `d` + second key | `dd` delete whole line (newline included) · `d$` delete to line end · `d0`/`d^` delete to line start · `dw` delete to word end |
| `u` | Undo the last vim edit (stack capped at 100) |
| `i` / `I` / `a` / `A` | INSERT at caret / first non-blank of the line / after caret / line end |
| `o` / `O` | New line below / above, then INSERT |
| `/` | Inserts `/` and returns to INSERT (opens the command menu) |
| `Esc` | Cancel a pending `d`; otherwise no-op (the usual clear / double-Esc rewind semantics stay off) |
| `Enter` / `Tab` / arrows / `Ctrl+*` combos | Pass through unchanged (submit, completion, history, edit shortcuts…) |
| Other bare keys | Ignored, never inserted |

While vim mode is on, `Esc` belongs to vim — use `/rewind` or exit vim mode
then double-Esc for time rewind; during a running turn, `Esc` in INSERT just
returns to NORMAL (interrupt with `Ctrl+C` / `Ctrl+Enter`). Clear the draft in
NORMAL with `Ctrl+C` or `dd`.

Bracketed paste from right-click or the terminal's native paste command keeps
ordinary text and newlines and is never mistaken for an Enter key. To keep
rendering, click mapping, and selection geometry identical, terminal ANSI
controls are stripped and tabs are expanded to spaces on entry.

### Fullscreen draft editor (`Ctrl+Shift+E` / `⛶`)

Long drafts stop squeezing into the 5-row window: `Ctrl+Shift+E`
(remappable) or the `⛶` affordance at the end of the input row expands the
current draft into a whole-screen editor sharing the exact editing state
(caret/selection/fold/vim mode) with the inline prompt. Turn it off in
`/settings` → `dsh-tui` (`expandEditor`, on by default) — both entry
points (the `⛶` affordance and the shortcut) then disappear.

- **Chrome**: a round border following the session accent / plan color; a
  line-number gutter on the left (width scales with the row count, the
  caret row's number is highlighted); the caret row carries a soft
  background; the title row shows live line/char stats and the status row
  shows `Ln L, Col C` plus the vim badge (when `/vim` is on).
- **Keys**: `Enter` inserts a newline (never mis-sends), `Ctrl+Enter` or
  the `⏎ Send` button sends and collapses; `Esc` is layered (clear the
  selection first, then collapse keeping the draft); `Tab` inserts a
  4-space indent; every other editing key (arrows, word jumps, Home/End,
  Ctrl+U/K/W, vim NORMAL keys) matches the inline prompt. **Fold blocks are
  mutually exclusive with it**: a big paste still folds into a chip while
  collapsed, but expanding the editor unfolds it (same semantics as
  clicking the chip), pastes inside the editor are plain, directly
  editable text, and collapsing never re-folds them.
- **Mouse**: click positions the caret, drag builds a selection,
  double-click selects a word, `Ctrl+C` copies the selection — geometry is
  corrected for the gutter width; the wheel scrolls the viewport freely
  (browsing does not snap back to the caret; any caret move re-engages
  following); the Send/Collapse buttons are clickable with hover feedback.
- Complements `Ctrl+G`: no `$VISUAL/$EDITOR` needed, never leaves the
  terminal.

## @ file references

Typing `@` at **any position** of the message opens file completion: keep typing
to filter, `Tab`/`Enter` to pick, and directories can be entered
further (plain fragments match **fuzzily** — `@ment` matches
`src/utils/mentions.ts`, with prefix/boundary and short-path boosts; path-shaped
queries — `@src/`, `@./`, `@../`, `@~/`, `@D:\`, or anything containing a
separator — read **only that directory** for local completion. `Esc` closes only
the current `@` token's menu; async refreshes keep your selected candidate).
Text files
and directory listings are attached as text; PNG, JPEG, WebP,
and GIF files are sent as durable Harness image blocks. Reads use the active
workspace filesystem, including provider-owned workspaces.

On `Ctrl+V`, files copied from a file manager (Windows Explorer, GNOME Files, KDE
Dolphin, …) insert as paths, while image files become `@` references. Clipboard
bitmaps are saved in the attachment store and appear as `[Image #N]`; submitting
the prompt sends a real image block. The prompt never contains base64.

## Interface language

`/lang` toggles the UI between Simplified Chinese and English (affects all UI
strings); the choice persists across restarts (0.3.7+). The **dsh-tui →
Language** select in `/settings` switches it too (applies immediately and saves
to `dsh-tui.lang` in `~/.dsh/settings.yaml`; the `DSH_TUI_LANG` env var always
wins).

## Message delivery semantics

While the model is working, three paths have different placement:

| Action | Placement |
| --- | --- |
| `Enter` | Steer: deliver to the running turn at its next step boundary |
| `Tab` | Follow-up: wait until the current turn finishes |
| `Ctrl+Enter` | Interrupt: stop the turn and deliver immediately |

Undelivered messages appear above the editor. `Alt/Option+Up` retrieves the
latest one. Pressing `Esc` while pending messages exist interrupts and
redelivers them immediately.

## Session workflows

### Resume

`/resume` opens the session browser — a full screen, not a floating panel. It
lists the conversations in the current working directory, most recently active
first; confirming switches the Agent and replays persisted events.

The browser shows **conversations** only. Sub-agent runs the model delegated to
itself are persisted as sessions too (the session header records
`origin: 'subagent'`); they are folded away by default, counted in the header,
and revealed as indented rows under their parent with `ctrl+s`. Rewound
branches from `/rewind` are unaffected — those record `parentSession` without
`origin`, and they are the user's own conversations. Sessions that recorded
only their boot policy and hold no conversation are never listed, only counted,
with `ctrl+x` to clear them (scoped to the current list, never across
projects).

| Key | Action |
| --- | --- |
| Type | Live search over titles, directories, branches, models |
| `↑` `↓` / `PgUp` `PgDn` | Move, page |
| `Enter` | Resume the selected session |
| `Tab` | Preview that session's last few exchanges |
| `ctrl+a` | Toggle this project / all projects (grouped by directory) |
| `ctrl+b` | Only sessions last used on the current branch |
| `ctrl+s` | Expand / fold sub-agent runs |
| `ctrl+p` | Pin / unpin the selected session (to the top of the current filtered view) |
| `ctrl+r` / `ctrl+d` | Rename / delete the selected session |
| `ctrl+x` | Remove sessions that hold no conversation |
| `Esc` | Clear the search first, leave second |

Clicking a row resumes it. Click ★/☆ or press `ctrl+p` to toggle its pin;
pins are atomically persisted in `~/.dsh-tui/session-pins.json`. The right-click
menu offers Open, Pin/Unpin, Rename, and Delete. Revealed sub-agent runs can be
pinned too and are promoted into the Pinned group as independent rows.

Each row carries the title, last activity, the git branch this install was on
when it last used the session, the log size, and the model. Titles are graded
by evidence: a `/rename`, an automatically generated title, an excerpt of the
opening prompt, or — when none of those can be read — the directory name,
which is dimmed to say it is not really a name.

The list reads only bounded windows at each end of a session log and caches the
result against the persistence layer's own change token, so opening it costs
the same regardless of how long the history is or how large a session got.

On Windows, `dsh-tui.cmd --resume` uses the session ID last written to
`~/.dsh-tui/resume.txt` (also dual-written to the old path
`~/.dsh-cc/resume.txt` for older launchers that only read it).

### Agent view

`/agentview` opens the agent view — a full screen listing every session in
this process: the attached conversation, the background sessions dispatched
here, and the stopped sessions persisted on disk. Rows are grouped by state
(needs input > working > failed > completed > idle > stopped), each with a
one-line activity summary derived from the session's own output — no extra
summary-model calls.

| Key | Action |
| --- | --- |
| Type | Write a task into the input at the bottom |
| `Enter` | With input text: dispatch a new background session; otherwise attach to the selected session |
| `Shift+Enter` | Dispatch and attach immediately |
| `↑` `↓` / `PgUp` `PgDn` | Move, page |
| `→` | Attach to the selected session |
| `Space` | Toggle the peek panel (when the input is empty); type a reply inside and `Enter` to send |
| `Ctrl+X` | Stop a background session; press again within 2s to delete it |
| `Ctrl+R` | Rename the selected session |
| `Esc` | Close peek → clear input → exit |
| `Ctrl+C` | Clear input; press again to exit |
| `?` | Show all shortcuts |

Dispatched sessions run independently inside this process (turns, tools,
approvals all work); switching the TUI elsewhere never interrupts them. A
background session's approval request shows as "needs input" and its panel
pops up inside the view (labelled with the session); the row's summary shows
the question it is blocked on. `/bg` (alias `/background`) moves the attached
session to the background — it keeps running — switches the terminal to a
fresh session and opens the view. **`←` on an empty prompt does the same
thing**: the session moves to the background and the view opens (with text,
`←` moves the caret as usual); the view tops out with "Your conversation
moved to the background — Enter opens it · Esc returns to it · Ctrl+C twice
quits" and the final Esc returns to the backgrounded session; the prompt
footer keeps a live "← N agents" count of sessions waiting on you. Peek and
reply work live for running sessions; a stopped session needs an `Enter`
attach first. Background sessions stop when the TUI process exits (logs
survive for resume); there is no supervisor process.

### Rewind

Double-tap `Esc` on an empty editor to open the user-message list. After a
selection is confirmed, the TUI:

1. Finds the beginning of the turn containing that message.
2. Creates a branch session through DSH session fork.
3. Replays history before the boundary.
4. Restores the original message to the editor for revision and resubmission.

- The boundary is taken **before** the turn that contained the message; you
  **cannot rewind past the first message**.
- If the model is working, the TUI cancels the turn first and waits for it to
  settle (up to 30s).
- The rewound branch is not a sub-agent (it records `parentSession` without
  `origin`) and keeps using the current model route plus the session's own
  preset.

Plugins can intervene (`tui/rewind-prompt` decision event): veto the rewind
(with a reason), or offer extra rewind modes in the confirm pane — e.g.
"rewind the conversation AND restore the files changed since". The first
option is always "Conversation only"; when a plugin mode is picked, the
plugin receives `tui/rewind-done` (with the chosen mode id and both session
ids) once the rewind completes, and may reply with a summary toast.

### Side question /btw

`/btw <question>` asks a quick side question without disturbing the main
task: it reuses the current session context (system prompt + existing
history) for a single **tool-less, one-turn** model call, and shows the
answer in a scrollable panel. Notes:

- **Never enters conversation history**: the exchange is not written to the
  session log and never reaches the main context or token counts (closing
  the panel discards it).
- **Never interrupts the running turn**: it can be triggered while the
  model is streaming; the main task keeps going.
- Inside the panel: `↑`/`↓` scroll, `Space`/`Enter`/`Esc` dismiss, `c`
  copies the answer; `Esc` cancels while the answer is still pending.
- Triggering `/btw` again aborts the previous side question.

### Trajectory scene (/trace / Ctrl+T)

A full-screen scene (no scrollback pollution) over the whole session timeline:

| Key | Action |
| --- | --- |
| `←`/`→` (or `h`) | Switch timeline / hotspot view |
| `↑` `↓` / `PgUp` `PgDn` | Move, page |
| `[` / `]` | Jump to previous / next failed point |
| `{` / `}` | Jump to previous / next turn |
| `/` | Query line: `tool:` `kind:` `turn:` `err:` `run:` `>10s` `tok>1k` prefixes, ANDed together; hits highlight in place |
| `m` | Cycle projection modes (equal / wall-clock / collapsed idle) |
| `g` / `G` | Jump to top / bottom |
| `Enter` | Expand details; `j`/`k` page inside the details |
| `t` (hotspot view) | Cycle sorting (time / count / tokens) |
| `q` / `Esc` | Exit; Esc is layered: fold details → clear query → close |

### /settings editor

`/settings` opens the plugin settings editor, read/edit by namespace. Edits
**auto-save**: `↑`/`↓` to move, `Enter` to expand/toggle/edit, booleans/selects
write on the spot, text drafts confirm on Enter, `Esc` just exits. Fields under the
dsh-tui namespace are written to the user layer of settings.yaml and take
**effect immediately** (`lang`, `statusBar.*`, …); namespaces without a
declared TUI section are listed read-only and need manual edits to
`~/.dsh/settings.yaml`.

### Model and preset

`/model` switches through a session fork at the end of current history because
DSH has no in-place model-switch API. The old session remains in `/resume`.

`/preset` switches in place only for a blank session. In a started session,
the choice becomes the default for the next `/new` or launch. See
[Configuration](configuration.en.md#agent-presets).

### Workspaces

`/workspace resume` opens the workspace picker. `/workspace rename <name>`
renames the current workspace, while `/workspace open <target>` opens a
workspace and starts a fresh session. `/resume` and `/rename` continue to
switch sessions within the current workspace and rename the current session.
A local target may be an absolute path,
a path relative to the current local workspace, or a standard `file://` URL.
Other URI schemes and `/workspace` subcommands are registered by optional plugins; the TUI has no built-in
knowledge of any external protocol. When a plugin owns the current workspace,
it also resolves relative paths in its own path space.

After `/workspace `, the completion menu includes both built-in and
plugin-contributed subcommands. Type a prefix and press Tab, for example
`/workspace rem`; plugin aliases participate in matching as well.

The launcher accepts the same target, for example `dsh-tui .`,
`dsh-tui ../project`, or `dsh-tui file:///path/to/project`. Without any
workspace plugin installed, local paths, `!command`, and all normal TUI session
flows remain available.

## Fullscreen and mouse

`fullscreen: false` restores inline mode (fullscreen is the factory default since 0.9.0), where the terminal emulator
owns native scrollback and selection.

`fullscreen: true` uses the alternate screen and enables in-app mouse handling:

| Action | Behavior |
| --- | --- |
| Wheel | Routed by position: moves the selected row in the completion/command menu under the pointer; scrolls the topmost scroll container (transcript / help / subagent panel); elsewhere scrolls the message list; never scrolls the transcript behind an open overlay; moves the cursor in the trajectory scene (±3 rows per notch on the timeline, ±1 in hotspot, scrolls the detail while expanded); walks the focused row in /settings |
| Drag | Select text, copy on release, then clear the selection |
| Double/triple click | Select and copy a word/line |
| `Esc` | Cancel an active drag (or an existing selection) without copying |
| Single-click a message row | Plain text rows (user/assistant) do nothing — the transcript is a reading surface, selection is the mouse's job there |
| Single-click a tool card / thinking / compact summary | Expand / collapse (header brightens on hover; trailing blank cells do not trigger) |
| Single-click a subagent card | Open that subagent's detail scene (status glyph brightens on hover) |
| Single-click the input box | Place the text caret at the click (multi-line, wrapped rows and CJK all width-aligned) |
| Drag inside the prompt input | Build an in-input selection (rendered highlight, caret rides the drag end): `Backspace`/`Delete` delete it, typing replaces it, `←/→` collapse it to the corresponding edge, `Esc` only clears it; drags map only visible rows (no edge auto-scroll yet); a folded paste block keeps the selection on the clicked side (never across the chip row) |
| `Shift+click` in the prompt input | Extend the selection from its start edge (or the caret) to the clicked position |
| Double-click a word in the prompt input | Select the whole word (detected in the component, 500 ms / 1 cell; paths and punctuation runs select as one) |
| `Ctrl+C` with a prompt selection | Copy the selection to the clipboard (OSC 52 + native fallback) and keep it for editing |
| Fullscreen editor (expanded via `Ctrl+Shift+E`) | Click/drag/double-click follow the prompt-input paths (geometry corrected for the gutter); the wheel scrolls the editor viewport (position-routed; caret moves re-engage following); the Send/Collapse buttons execute on click and brighten on hover; the input row's `⛶` expands |
| Single-click “load earlier messages” / “ctrl+e show previous N” | Load earlier messages / expand all |
| Single-click the sticky header / “↓ N new messages” | Jump back to the pinned message / scroll to bottom |
| Single-click a hyperlink | Open it in the browser |
| Single-click a picker / menu row | Select and apply immediately (model / skills / activity frames / preset / permissions / plan / language / theme / effort / command & file completion / history / session rows / thinking mode / workspace targets, submenu & flow choices) — the keyboard Enter path; rows are inert while a picker is busy or mid-input |
| Single-click a rewind candidate / confirm row | List page: click selects only (stepping into the confirm state stays an explicit keyboard Enter); confirm page: clicking the message / mode row executes the rewind directly — the confirm pane is itself the confirmation layer |
| Single-click an approval / questionnaire / plan-review / plugin dialog row | Submit that decision directly (unblock a waiting agent with the mouse) |
| Single-click in the trajectory scene | Timeline/hotspot rows jump the cursor (a hotspot row jumps back to the timeline at that group — same as Enter; hover shows a dim ▸ pointer); tabs switch views; the sort/projection label cycles; the query line and the tab gap open the `/` search; a wave-band column (ruler included) jumps to its nearest event |
| Single-click a /settings field / group row | Focus it and run that row's Enter action (boolean/select cycles, text enters edit, groups open); hover moves the focus (lazygit-style); the edit mode ignores the mouse entirely |
| Single-click a session-browser confirm row | Confirm the delete/clean (same as Enter); cancelling stays on keyboard Esc |
| Single-click a help-menu command row | Fill `/name ` into the prompt and close the help (the Tab completion's mouse equivalent) |
| Keyboard selection extension | With a selection, `Shift+←/→/↑/↓/Home/End` extends / shrinks it (wraps across lines) |

Copy prefers OSC 52. Local fallbacks include `wl-copy`, `xclip`, and `xsel`;
tmux uses `load-buffer -w`. Set `DSH_TUI_DISABLE_MOUSE=1` to temporarily disable
fullscreen mouse handling.

## `ask_user_question` questionnaires

When the model invokes the questionnaire tool, its panel temporarily owns the
keyboard:

| Key | Behavior |
| --- | --- |
| `Up/Down` | Move through options |
| `Space` | Toggle a multi-select option |
| `Tab` | Switch to a custom text answer |
| `Enter` | Submit the current question |
| `Esc` (from question 2 onward) | Return to the previous question and keep the current draft |
| `Esc` (from question 1) | Cancel the whole batch; the model receives `ASK_CANCELLED` |
| `Ctrl+C` | Cancel the whole batch from any question; the model receives `ASK_CANCELLED` (a harness-side abort still reports `ASK_ABORTED`) |

The last row is a free-form input line: typing directly on an option row
submits that option's label **plus** your custom text together (no need to
`Tab` first); `Tab` jumps straight to the input line.

Batched questions and concurrent subagent questions are shown one at a time in
FIFO order. A compact Q&A summary is added to the local transcript afterward.

## Plan review

When the model calls `exit_plan_mode` in plan mode, the full plan is rendered
as markdown in the review panel (the dedicated decision layout for
`intent: plan-review`):

| Key | Behavior |
| --- | --- |
| `Up/Down` | Move between the options and the feedback input line at the bottom |
| Mouse wheel | Scroll the plan body; Approve / Keep planning / feedback stay pinned in view |
| `1`/`2` | Submit the corresponding option directly (when the feedback buffer is empty; otherwise digits are treated as feedback characters) |
| Typing | Enters the feedback input line |
| `Enter` (option row) | Submit that option; an approval row with feedback errors out — approval must carry no feedback, or the protocol treats it as “continue planning” |
| `Enter` (input line) | Submit “continue planning” with the feedback text |
| `Esc` | Interrupt the review to talk (`ASK_CANCELLED`); the model stays in plan mode |

Approving a plan or running `/plan off` restores the actual sandbox and
approval policy from before plan entry. `Shift+Tab` keeps the selected target
mode, including switches deferred while a turn is running. Resumed sessions
recover pre-plan permissions from event history; unknown historical permissions
stay unchanged instead of falling back to full access when no configured mode matches.

## Tool approval

When the permission layer issues an `approval/request`, the approval panel
shows the tool name, the full command extracted from the paired tool call, and
the reason, and temporarily owns the keyboard (when a questionnaire is also
pending, approval takes priority):

| Key | Behavior |
| --- | --- |
| `Up/Down` | Move through options |
| `1` / `2` | Allow (this time only) / deny |
| `Enter` | Submit the focused item |
| `Esc` / `Ctrl+C` | Deny (fail closed) |

The protocol offers only "allow once / deny" — there is **no "always allow"**.

## Slash commands

The command menu merges local commands with the DSH command registry. Type `/`
to inspect the complete surface available in the current composition. Command
descriptions follow the UI language (`/lang`): built-in commands and mapped
registry commands (`/plan`, `/goal`, `/feedback`) show Chinese translations in
zh; unmapped registry commands fall back to the registry's own text.

| Group | Commands |
| --- | --- |
| Sessions | `/new`, `/resume`, `/agentview` (agent view), `/bg` (alias `/background`, backgrounds the session and opens the view), `/rename`, `/recap` (recent-activity summary + one-key suggested title), `/workspace resume|rename|open`, `/clear`, `/compact`, `/export`, `/btw`, `/trace` (trajectory scene, also `Ctrl+T`), `/rewind` (time travel, same as double-`Esc` on an empty input) |
| Status | `/context`, `/status`, `/cost`, `/balance` (official DeepSeek balance: summary row + hover details, click to refresh), `/config`, `/doctor`, `/init`, `/agents`, `/jobs` (background jobs panel: status/elapsed/exit code, `k` kills), `/settings` |
| Model and display | `/model`, `/effort`, `/thinking`, `/tokens`, `/activity`, `/preset`, `/theme`, `/color` (session accent color: bare opens the palette picker, `<name>` sets directly, `status`/`reset`; input border + session-name chip at the top-right, per-session; chip off by default, enable in `/settings`), `/lang` |
| Account and policy | `/provider`, `/login`, `/logout`, `/permission`, `/add-dir`, `/hooks`, `/mcp`, `/plugins` (`check <path>` validates a plugin manifest) |
| Skills | `/skills` lists skills DSH discovers from the active profile, user, and project; user-invocable skills join the menu as `/name` |
| Other | `/update`, `/vim` (vim editing mode toggle — see “Editing keys”), `/terminal-setup`, `/connect`, `/help`, `/exit` (aliases `/quit`, `/q`) |
| Registry | `/plan`, `/goal`, and any other command registered by the DSH composition |

dsh-TUI does not preinstall general-purpose skills; DSH and the active
composition own skill content and discovery.

Additional forms:

- `/activity` opens the animation picker; `/activity frames <name>` selects
  directly (30 frame names: `random` + `claude` `star2` `sand` `triangle`
  `box` `box2` `corners` `point` `layer` `flip` `aesthetic` `hamburger`
  `moon` `moon8` `comet` `breathe` `dots` `arrow` `spark` `bar` `braille`
  `arc` `circle` `grow` `noise` `bounce` `rainbow` `dqpb` `toggle`; default
  `moon8`); `/activity status` reports the current choice.
- `/preset <id>` and `/preset status` are described in the configuration guide.
- `/effort` opens the reasoning-effort slider (←/→ adjusts live);
  `/effort <id>` sets a level directly; `/effort status` reports the current one.
- `/theme <name>` and `/theme status` are described in the theme guide.
- `/permission` reads the DSH `permissionPresets` registry, preserving registry order for the picker and completion. Third-party presets need no TUI hard-coding; `custom` is a current-state label only, never a selectable target. When the registry service is absent, TUI uses its legacy three-row compatibility roster; a mounted but broken service is unavailable and fails closed. If the external `/permission` command is not registered, input follows the existing default/model dispatch path.
- `/lang` toggles the interface language (see “Interface language”).
- `/compact` compresses the session history; unavailable under the minimal
  preset (bash + editor only).
- `/thinking` toggles extended reasoning display; UI state only — **not
  persisted**.
- After startup, the TUI checks npm for a newer version in the background and
  shows a notification when one is available. The check follows the npm
  registry configuration (`NPM_CONFIG_REGISTRY` or `~/.npmrc`), so mirror
  users see the versions their package manager actually installs. `/update`
  updates the installed `@deepseek-harness-tui/dsh-tui`, then restarts and
  resumes the current session automatically; wait for an active turn to finish first. It is only
  available under a `dsh --profile <name>` launch (source checkouts get an
  unavailable notice), and an already-latest install is reported as such
  without restarting.
- `/plan [off|message]` and `/goal ...` are handled by DSH command plugins and
  recorded as session events.
- Skill commands are executed by the host injecting the corresponding
  `SKILL.md` body, with arguments passed through unchanged; DSH and the active
  composition own their content and discovery.

`/connect` and `/hooks` are currently compatibility
placeholders. When the DSH composition has no matching capability, each
command explains that explicitly rather than silently doing nothing.
