# Interaction and Commands

[Documentation index](README.md) · [简体中文](interaction.md)

## Input and global shortcuts

| Key | Behavior |
| --- | --- |
| `Enter` | Send while idle; steer text into the running turn at its next step boundary; confirm an open menu |
| `Tab` | Complete a `/` command or `@` file; while the model is working, queue non-empty input as a post-turn follow-up |
| `Ctrl+Enter` | Interrupt the running turn and process the input immediately |
| `Shift+Enter` | Insert a newline at the caret |
| `Shift+Tab` | Cycle the configured session modes (default: default → plan → full-access) |
| `Alt/Option+Up` | Pull the latest undelivered message back into the editor |
| `Up/Down` | Select menu items; in ordinary input, browse history or move through multiline text |
| `Ctrl+V` | Insert clipboard text or files; images are sent as durable attachments |
| `Ctrl+X` | Edit the current input in an external editor (`$VISUAL` → `$EDITOR` → vi); saving and quitting fills it back, `:cq`/non-zero exit keeps the draft |
| `Esc` | Close the active menu, selection, or modal; clear input; interrupt a working model; double-tap on empty input to open the session tree |
| `Ctrl+C` | Interrupt while working; clear non-empty idle input; press twice on empty input to exit |
| `Ctrl+D` | Press twice while idle to exit |
| `Ctrl+O` | Toggle transcript/verbose detail, including full reasoning and tool arguments/output |
| `Ctrl+T` | Open the trajectory scene (same as `/trace`); `q`/`Esc` returns to the conversation |
| `Ctrl+R` | Open input-history search; repeat or press `Down` for the next result |
| `Ctrl+L` | Clear and force a physical terminal redraw |
| `?` | Open shortcut and command help when the input is empty |
| `Shift+Up` | Enter message selection; arrows move, `Enter` expands one row, `Esc` exits |

`/` has two meanings. In normal input it opens slash-command completion. In
the `Ctrl+O` transcript view it opens full-session search; use `n` and `N` to
move forward and backward through matches.

## Editing keys

| Key | Behavior |
| --- | --- |
| `Left/Right` | Move by character |
| `Ctrl+Left/Right` | Move by word |
| `Home/End` | Move to the start/end of the current logical line |
| `Ctrl+A` / `Ctrl+E` | In the editor, move to the start/end of the current logical line; `Ctrl+E` also expands or folds hidden older rows in long transcripts |
| `Ctrl+U` | Delete before the caret |
| `Ctrl+K` | Delete after the caret |
| `Ctrl+W` | Delete the preceding word |

Bracketed paste from right-click or the terminal's native paste command is
inserted verbatim, including newlines, and is never mistaken for an Enter key.

## @ file references

Typing `@` at **any position** of the message opens file completion: keep typing
path fragments to filter, `Tab`/`Enter` to pick, and directories can be entered
further. Text files and directory listings are attached as text; PNG, JPEG, WebP,
and GIF files are sent as durable Harness image blocks. Reads use the active
workspace filesystem, including provider-owned workspaces.

On `Ctrl+V`, files copied from a file manager (Windows Explorer, GNOME Files, KDE
Dolphin, …) insert as paths, while image files become `@` references. Clipboard
bitmaps are saved in the attachment store and appear as `[Image #N]`; submitting
the prompt sends a real image block. The prompt never contains base64.

## Interface language

`/lang` toggles the UI between Simplified Chinese and English (affects all UI
strings); the choice persists across restarts (0.3.7+).

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

Rewound branches fold into **families**: a session forked by a rewind is not a
new conversation but another branch of the same one, so the list shows only the
family's most recently active member (badged `▸N`, where N is the family size)
and tucks the rest underneath. `→` on the family row expands every member as an
indented row; `←` folds it back — from a member row it folds the family and
returns the cursor to the family row. Folding lifts while a search query is
live, so a folded member stays directly reachable and resumable.

| Key | Action |
| --- | --- |
| Type | Live search over titles, directories, branches, models |
| `↑` `↓` / `PgUp` `PgDn` | Move, page |
| `→` / `←` | Expand / fold the selected session's rewind-branch family (on a member row, `←` folds it and lands on the family row) |
| `Enter` | Resume the selected session |
| `Tab` | Preview that session's last few exchanges |
| `ctrl+a` | Toggle this project / all projects (grouped by directory) |
| `ctrl+b` | Only sessions last used on the current branch |
| `ctrl+s` | Expand / fold sub-agent runs |
| `ctrl+r` / `ctrl+d` | Rename / delete the selected session |
| `ctrl+x` | Remove sessions that hold no conversation |
| `Esc` | Clear the search first, leave second |

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

### Session tree (rewind)

Double-tap `Esc` on an empty editor (or run `/tree`; `/rewind` is an alias)
to open the session tree: the session family of the current directory
stitched into one branching view — every rewind spawns a new session with a
`parentSession` link, and the tree reassembles ancestors and sibling
branches, with `•` marking the active path to the live session.

Keys: `↑/↓` move (wrapping); `PgUp/PgDn` or `←/→` page; type to search
(multi-token AND); `Backspace` edits the query; `Ctrl+O` cycles the filter
(default → no tools → user only → all); `Ctrl+B` switches to the focused
entry's branch whole (keeping all its content — see below); `Enter` selects
with a confirmation; `Esc` clears a non-empty query first, then closes.

The confirmation says what the pick actually does, per entry kind: a user
message "drops the whole turn containing this message"; an assistant/tool
entry "keeps through the end of its step"; a cross-branch pick names the
source session. When the branch's entire own content sits inside the turn
being dropped (the common shape: the branch ran exactly one turn), the
confirmation additionally warns that the new session will not contain it —
that is exactly the "picked the branch's first message and the branch
vanished" trap. To move to a dead branch WITH all its content, use `Ctrl+B`:
it forks a new session at the branch tip and drops nothing (the gesture
refuses with a reason when the branch log wasn't fully loaded).

The rewind semantics follow pi's navigateTree: **selecting a user message**
drops its whole turn (rewind to the turn's start) and restores that turn's
prompt into the editor for revision; **selecting an assistant/tool/notice
entry keeps through the end of its enclosing step** (rewind to that step's
`step/end`), so the picked AI answer or tool call stays in history while the
turn's later steps are dropped. A DSH agentic turn can span many steps and
thousands of events per prompt, so turn-granular keeping would barely move
the visible history for a mid-turn pick; the step is the finest unit that
cuts safely and never dangles an unanswered tool call. When the cut lands
mid-turn, the fork seed appends a synthetic `turn/end` (`aborted/user` — the
exact shape a real Esc interrupt writes) to close the turn. After
confirmation, the TUI:

1. Computes the boundary: just before the owning turn's start for a user
   message; the enclosing step's `step/end` for anything else (or the owning
   turn's `turn/end` when no step marker stands between the entry and the
   turn's end).
2. Creates a branch session seeded up to that boundary (the header records
   `parentSession` + `seedLength`; a mid-turn cut first appends the
   synthetic `turn/end`).
3. Replays history before the boundary.
4. Restores the original message to the editor only when the entry's turn
   was dropped.

The very first turn's user message cannot be rewound (there is nothing
earlier to keep); selecting an entry inside the live session's last turn
would drop nothing, so the panel reports "already at the latest state"
instead of forking an identical branch.

Selecting an entry on another session (a dead branch) works the same way —
the fork starts from that session's point.

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

`fullscreen: false` is the default inline mode, where the terminal emulator
owns native scrollback and selection.

`fullscreen: true` uses the alternate screen and enables in-app mouse handling:

| Action | Behavior |
| --- | --- |
| Wheel | Scroll the transcript |
| Drag | Select text, copy on release, then clear the selection |
| Double/triple click | Select and copy a word/line |
| `Esc` | Cancel an active drag without copying |

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
| `Esc` | Cancel the whole batch of questions; the model receives `ASK_CANCELLED` (a harness-side abort still reports `ASK_ABORTED`) |

Batched questions and concurrent subagent questions are shown one at a time in
FIFO order. A compact Q&A summary is added to the local transcript afterward.

## Plan review

When the model calls `exit_plan_mode` in plan mode, the full plan is rendered
as markdown in the review panel (the dedicated decision layout for
`intent: plan-review`):

| Key | Behavior |
| --- | --- |
| `Up/Down` | Move between the options and the feedback input line at the bottom |
| `1`/`2` | Submit the corresponding option directly (when the feedback buffer is empty; otherwise digits are treated as feedback characters) |
| Typing | Enters the feedback input line |
| `Enter` (option row) | Submit that option; an approval row with feedback errors out — approval must carry no feedback, or the protocol treats it as “continue planning” |
| `Enter` (input line) | Submit “continue planning” with the feedback text |
| `Esc` | Interrupt the review to talk (`ASK_CANCELLED`); the model stays in plan mode |

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

## Slash commands

The command menu merges local commands with the DSH command registry. Type `/`
to inspect the complete surface available in the current composition. Command
descriptions follow the UI language (`/lang`): built-in commands and mapped
registry commands (`/plan`, `/goal`, `/feedback`) show Chinese translations in
zh; unmapped registry commands fall back to the registry's own text.

| Group | Commands |
| --- | --- |
| Sessions | `/new`, `/resume`, `/rename`, `/workspace resume|rename|open`, `/clear`, `/compact`, `/export`, `/btw`, `/trace` (trajectory scene, also `Ctrl+T`), `/tree` (session tree, `/rewind` alias, also double-`Esc`) |
| Status | `/status`, `/cost`, `/config`, `/doctor`, `/init`, `/agents` |
| Model and display | `/model`, `/effort`, `/thinking`, `/tokens`, `/activity`, `/preset`, `/theme`, `/lang` |
| Account and policy | `/provider`, `/login`, `/logout`, `/permissions`, `/add-dir`, `/hooks`, `/mcp` |
| Packaged skills | `/audit`, `/bug`, `/practice`, `/review`, `/pr_comments`, `/release-notes`, `/vuln-check` |
| Other | `/update`, `/vim`, `/terminal-setup`, `/connect`, `/help`, `/exit` |
| Registry | `/plan`, `/goal`, and any other command registered by the DSH composition |

Additional forms:

- `/activity` opens the animation picker; `/activity frames <name>` selects
  directly; `/activity status` reports the current choice.
- `/preset <id>` and `/preset status` are described in the configuration guide.
- `/effort` opens the reasoning-effort slider (←/→ adjusts live);
  `/effort <id>` sets a level directly; `/effort status` reports the current one.
- `/theme <name>` and `/theme status` are described in the theme guide.
- `/lang` toggles the interface language (see “Interface language”).
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
- Skill commands submit activation prompts. The actual skill is loaded through
  the DSH skill registry. Packaged `skills/` register at startup and may be
  overridden by same-name project or user skills.

`/vim`, `/connect`, and `/hooks` are currently compatibility
placeholders. When the DSH composition has no matching capability, each
command explains that explicitly rather than silently doing nothing.
