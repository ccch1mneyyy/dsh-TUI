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
| `Ctrl+V` | Insert system clipboard text; files/images copied in Windows Explorer insert paths |
| `Esc` | Close the active menu, selection, or modal; clear input; interrupt a working model; double-tap on empty input to rewind |
| `Ctrl+C` | Interrupt while working; clear non-empty idle input; press twice on empty input to exit |
| `Ctrl+D` | Press twice while idle to exit |
| `Ctrl+O` | Toggle transcript/verbose detail, including full reasoning and tool arguments/output |
| `Ctrl+T` | Expand or collapse the startup loaded-context panel |
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
further. When you send, the selected file content or directory listing is attached
to the message automatically (0.3.7+).

On `Ctrl+V`, files/images copied from Windows Explorer are inserted as file paths
(quoted automatically when they contain spaces) instead of pasting the path text.

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

`/resume` lists recent resumable sessions for the current working directory.
Titles come from the first user message, and entries are ordered by most recent
use. Confirming switches the Agent and replays persisted events.

On Windows, `dsh-tui.cmd --resume` uses the session ID last written to
`~/.dsh-tui/resume.txt` (also dual-written to the old path
`~/.dsh-cc/resume.txt` for older launchers that only read it).

### Rewind

Double-tap `Esc` on an empty editor to open the user-message list. After a
selection is confirmed, the TUI:

1. Finds the beginning of the turn containing that message.
2. Creates a branch session through DSH session fork.
3. Replays history before the boundary.
4. Restores the original message to the editor for revision and resubmission.

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
| `Esc` | Cancel; the model receives `ASK_ABORTED` |

Batched questions and concurrent subagent questions are shown one at a time in
FIFO order. A compact Q&A summary is added to the local transcript afterward.

## Slash commands

The command menu merges local commands with the DSH command registry. Type `/`
to inspect the complete surface available in the current composition. Command
descriptions follow the UI language (`/lang`): built-in commands and mapped
registry commands (`/plan`, `/goal`, `/feedback`) show Chinese translations in
zh; unmapped registry commands fall back to the registry's own text.

| Group | Commands |
| --- | --- |
| Sessions | `/new`, `/resume`, `/clear`, `/compact`, `/export`, `/btw`, `/trace` |
| Status | `/status`, `/cost`, `/config`, `/doctor`, `/init`, `/agents` |
| Model and display | `/model`, `/effort`, `/thinking`, `/tokens`, `/activity`, `/preset`, `/theme`, `/lang` |
| Account and policy | `/login`, `/logout`, `/permissions`, `/add-dir`, `/hooks`, `/mcp`, `/memory` |
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

`/vim`, `/connect`, `/hooks`, and `/memory` are currently compatibility
placeholders. When the DSH composition has no matching capability, each
command explains that explicitly rather than silently doing nothing.
