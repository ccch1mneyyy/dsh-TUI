# Interaction and Commands

[Documentation index](README.md) · [简体中文](interaction.md)

## Input and global shortcuts

| Key | Behavior |
| --- | --- |
| `Enter` | Send while idle; run a known `/` command (with or without arguments — while a turn runs its own gate decides); steer the remaining text into the running turn at its next step boundary; confirm an open menu |
| `Tab` | Complete a `/` command or `@` file; while the model is working, queue non-empty input as a post-turn follow-up |
| `Ctrl+Enter` | Interrupt the running turn and process the input immediately |
| `Shift+Enter` / `Ctrl+J` | Insert a newline at the caret; `Ctrl+J` (LF) is the fallback when the terminal cannot report the Shift modifier; macOS Terminal.app uses `Option+Enter` |
| `Shift+Tab` | Cycle the configured session modes (default: default → plan → full-access) |
| `Alt/Option+Up` | Pull the latest undelivered message back into the editor |
| `Up/Down` | Select menu items; in ordinary input, browse history or move through multiline text |
| `Ctrl+V` / `Alt+V` | Insert clipboard text or files; images are sent as durable attachments. Use `Alt+V` when the terminal intercepts `Ctrl+V` |
| `Ctrl+G` | Edit the current input in an external editor (`$VISUAL` → `$EDITOR`); saving and quitting fills it back, `:cq`/non-zero exit keeps the draft; with neither variable set the TUI asks you to configure one (no `vi` fallback) |
| `Ctrl+Shift+E` | Expand the fullscreen draft editor (or click the `⛶` affordance at the end of the input row): line numbers + current-line highlight + live line/char stats<br>`Enter` inserts a newline, `Ctrl+Enter` or the Send button sends, `Esc` or the Collapse button keeps the draft and returns<br>wheel-scrolls freely; click/drag/double-click selection work as in the inline prompt; remappable via `/settings` |
| `Esc` | Ladder: close help → close the image preview → close the command menu → close the file menu (only the current `@` token)<br>→ **with a selection in the prompt input: only clear it (text untouched)** → with the held-queue selector open: only leave the selector → interrupt the turn and hold the queued messages (no automatic re-send, see "Message delivery semantics") → clear non-empty input → double-tap on empty input = rewind<br>in fullscreen, an active mouse selection is cleared first (not copied) |
| `Ctrl+Z` | Undo the prompt draft's last word-level edit (text, caret and images together). Draft-only: a submit, a history recall (`Ctrl+R`/`↑`) or a session switch ends the history; it is NOT the message/conversation rewind behind `Esc Esc`. Remappable via `/settings` |
| `Esc` / `Ctrl+C` / `Enter` while an image preview is open | Close the preview and restore the surface underneath; other keys are not passed through |
| `Left` / `Right` in the image modal | Previous / next image, no wrapping; caret peeks keep arrows with the prompt |
| `←` (empty input) | Open the session manager (same as `/bg`); DSH backgrounds the current session first, while Claude/Codex keep it attached |
| `Ctrl+C` | Interrupt while working; press again while the interrupt is still settling to force-exit<br>clear non-empty idle input; **while idle with a selection in the prompt input, copy it to the clipboard (selection kept for editing)**; press twice on empty input to exit |
| `Ctrl+D` | Same ladder as `Ctrl+C`: interrupt while working (press again to force-exit if the interrupt stalls); press twice while idle to exit |
| `Ctrl+O` | Toggle transcript/verbose detail, including full reasoning and tool arguments/output; also the escape hatch for the **long-line fold** (a single line over 1000 chars is clipped to 1000 with a `… N chars folded` marker — see the user guide §5). Clicking the folded row (or the tool card face) toggles it too |
| `Ctrl+P` | Toggle the loaded-context panel shown at startup (while it is on screen) |
| `Ctrl+B` | Side panel, three states: closed → open and focus the right column; open with the chat focused → focus the right column; panel focused → close and return to the chat. Splits only under `fullscreen` at a content width of ≥93 columns; on narrow terminals and in inline mode the key does nothing (`/jobs` & co. keep their full-screen panels — see the user guide §2.8) |
| `Alt+Z` | Zoom the active side panel (the chat column keeps its minimum width); press again to restore |
| `Ctrl+T` | Open the trajectory scene (same as `/trace`); `q`/`Esc` returns to the conversation |
| `Ctrl+R` | Open input-history search; repeat or press `Down` for the next result |
| `Ctrl+L` | Clear and force a physical terminal redraw |
| `?` | Open shortcut and command help when the input is empty |
| In Help: `↑/↓`, `PgUp/PgDn`, `Home/End` | Scroll by line, page, or jump to either end; `Esc` closes |
| Transcript: `PgUp` / `PgDn` | Page the fullscreen transcript (one viewport minus one row per press); yielded to Help and open overlays, which page their own lists<br>inline mode does not claim them — history lives in the terminal's native scrollback there, and paging belongs to the terminal |
| `Shift+Up` | Enter message selection; arrows move, `Enter` expands one row, `Esc` exits |

**Remapping shortcuts**: paste, history search, external editor, `Ctrl+O/T/P/R/L`,
side panel (`Ctrl+B`/`Alt+Z`), subagent dashboard, show-all, and todo fold are remappable in
`/settings` → `dsh-tui` → `Shortcuts`.

- Enter combos like `alt+v`; comma-separate several; leave blank to restore defaults. Saves apply live.
- Combos that clash with the fixed editing keys or another action are rejected.
- Deployments can also pin them via `shortcuts.<action>` in cordis.yml.

**macOS modifier keys**:

- The `Ctrl+<key>` bindings above also work with `⌘<key>` on macOS (e.g. `⌘V` paste, `⌘O` expand details, `⌘Enter` send immediately).
- Only `Ctrl+C` / `Ctrl+D` (interrupt/exit) stay on Ctrl, to avoid clashing with muscle memory for macOS system-level `⌘C` copy and similar.
- `⌘` requires terminal support for the extended keyboard protocol (iTerm2 / kitty / WezTerm / ghostty / tmux).
- macOS's built-in Terminal.app consumes `⌘` shortcuts itself, so keep using `Ctrl`.

`/` has two meanings:

- In normal input it opens slash-command completion.
- In the `Ctrl+O` transcript view it opens full-session search; use `n` and `N` to move forward and backward through matches.

**Plugin combos and views**:

- Plugins may register additional combos through the `tuiShortcuts` seam; they must
  carry Ctrl or Alt. Built-in bindings always win, and conflicting combos are refused at
  registration.
- A managed plugin dialog (select/confirm/input) owns the keyboard while open: `↑`/`↓` to move, `Enter` to confirm, `Esc` to cancel.
- Plugins may also contribute one text line above the prompt, or a compact rich status view of up to three rows when the host exposes `tuiStatus.registerView`.
- Rich views receive only host `Box`, `Text`, `Image`, and terminal size. Click/hover/drag work in fullscreen, and the view never owns the keyboard.
- `Image` takes decoded RGBA pixels plus a same-size cell fallback.
- After a successful Kitty probe, the host centers the image at its natural aspect ratio
  using terminal-reported cell geometry (or a conservative default), adding transparent
  letterboxing and downsampling when needed. Otherwise it renders the fallback (including
  inline, accessibility, and multiplexer sessions).
- Plugins provide the keyboard path for the same action through a slash command or `tuiShortcuts`.
- A refused rich registration returns `undefined`; an admitted one returns a disposer that removes both the view and its Cordis effect.

### Launchpad and first-run guide

The startup **launchpad** and the **first-run wizard** each own the keyboard; both only hand
results back to the chat screen and add no new behavior.

- **Launchpad**: printable input goes into the input box (the prefix turns from `❯` to `⌘` when the line
  starts with `/`), `Backspace`/`Delete`/`←`/`→`/`Home`/`End` edit it; the **native terminal cursor**
  inherits your terminal's shape, color, blinking, and enabled animation or trail effects.
  Cursor movement never adds a cell or eats a character. Static rendering retains the
  [theme-painted fallback](themes.en.md); `Alt+R` continues the most recent session
  (= the first entry row slot, bound only on this screen, no-op when there is nothing to continue,
  remappable in `/settings`);
  a leading `/` opens the
  **command palette** (the same data source and component as the chat composer: `↑`/`↓` move the selection,
  `Tab` **completes** the selected command in the input box with the caret at the end,
  `Enter`/click **run** it and clear the input, `Esc` dismisses only the palette and keeps the draft);
  with the palette dismissed, `Enter` **sends** the line straight away (a leading `/` line — including
  plugin/registry commands — goes through the chat page's merged command table and never reaches the model);
  `↑`/`↓`/`Tab` walk the focus ring (input box → the four param segments under the box → the quick
  actions → the Tips line) and `Enter` activates the focused one (`Enter` on the Tips line rotates the
  tip), while typing returns focus to the input box; `Esc` clears
  a non-empty line and opens sessions when empty, and `Ctrl+C` on an empty line takes the exit funnel.
- **Launchpad param row** (under the box: model · effort · mode · permission; model shows the bare model
  name and mode shows the agent preset's display name — Standard/PTC/minimal…): each segment is
  **clickable** and opens the very same picker the chat page uses (`/model` · `/effort` · `/preset` ·
  `/permission`); the picker renders **above** the launchpad and owns the keyboard
  (`Esc` closes it back onto the launchpad), the picked value updates the row in place and the typed draft
  is untouched; clicking inside the picker selects, **clicking elsewhere closes it and clicking another
  segment switches to that picker**.
 All four segments **stay on the row**: they are drawn verbatim
  when they fit; when they do not, only the **over-long segments** are truncated at the tail with a
  trailing `…` (the permission segment is **never truncated**), and hovering a truncated segment
  shows its **full name** in a card after ~600ms (mouse tracking is always on for the launchpad
  screen, inline mode included); only when the **full permission name does not fit the budget** —
  widening the terminal past 76 columns changes nothing, while a narrower terminal or a longer
  permission name triggers it earlier — does the row fall back to dropping **whole segments from
  the tail** (permission → mode → effort → model), which also drops them from the focus ring.
- **Entry row**: `Continue "…"` (Alt+R; the slot is absent when
  there is nothing to continue) · `Sessions & workspaces` (`/home` — history and workspaces merged into
  one entry) · `Settings` (`/settings`) · `Kernel · <current kernel>` (`/kernel`, opens the kernel
  picker, see the commands section) · a **conditional slot** (priority: background jobs running → `Background
  jobs`; update detected → `Update available`; usage milestone reached and never starred → `Feed us a
  star`; fallback `Help`). Full screens opened from the launchpad (sessions & workspaces / settings /
  background jobs / the family tree / the wizard) render **above the launchpad** — `Esc` closes them
  back onto the launchpad (draft, params and focus intact); **the only way off the launchpad into the
  chat is submitting a non-command line with Enter**. Overlays on the launchpad side (pickers, the
  command palette) are a **clean cutout** — every cell in the overlay rect is space-filled (host
  glyphs never bleed through), yet no background color is emitted (no white block; Kitty splash
  art still shows through the terminal-default cells; the chat page's pickers are unaffected).
- **Tips line**: click to rotate (three tips cycle; the first-run tip has top priority and never rotates);
  keyboard path = focus ring + `Enter`; it also **auto-rotates** (~10s per tip; a manual
  rotate resets the timer) — the switch changes only the text, never the row height or centering.
- **Corner plates**: the bottom-left working directory is **clickable** — it opens the existing
  `/workspace` menu (rendered above the launchpad; `Esc` returns to the launchpad), keyboard path =
  the focus ring's last slot + `Enter`, hover/focus = text highlight; the bottom-right plate starts
  with `dsh-tui v<TUI>`, followed by one row for **each registered backend**:
  `▸ DSH · dsh-core v<kernel>` / `Claude · claude-code v<CLI>` (then `Codex · codex-cli v<CLI>`, and any
  installed plugin backend after it). The name is the backend manifest's short label; `▸` marks the
  current kernel and the other rows stay dim; an unavailable kernel adds the reason after its version (such as *Not installed*
  or *Not signed in*), a row whose version cannot be read shows just the name, and *Checking…* shows
  while the probe runs. The whole block is clickable and opens the same kernel picker (keyboard path =
  focus ring + `Enter`). Rows are right-aligned, the cwd plate is top-aligned to the first row, and
  narrow terminals truncate per the existing truncate-middle contract.
- **Wizard**: `←`/`→` change step (except the effort slider in step 3 and a drilled-in model list, where the
  horizontal keys belong to the child control), `Tab` switches between the language/theme and
  model/effort/workspace panes, `↑`/`↓` move the selection; `Enter` runs the step (step 1 = re-check
  connectivity, step 3 = drill into a provider / switch model / open the workspace picker — **effort is not
  on Enter**, it is `←`/`→` only and applies as you move); the theme pane previews on cursor move while the
  **language pane applies on `Enter`**; `Enter` on the last step finishes and records the guide when the
  focused card is a shortcut card, and tries the command when it is a command card; `Esc` skips
  (**not recorded**, asked again next launch).
- **Mouse** (mouse tracking is always on for this screen): the launchpad's quick actions (hover = the
  label turns accent-blue and bold, leaving restores the dim look), param segments, command palette,
  Tips line, the wizard's "Try it" cards and the workspace picker are clickable, and a click lands on
  the same command path as the keyboard.

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

`/vim` toggles vim editing for the prompt (session-scoped, not persisted).

- The prompt shows an `INSERT` badge and typing works as usual.
- `Esc` switches to the `NORMAL` badge, where bare keys follow vim semantics.

| NORMAL key | Behavior |
| --- | --- |
| `h` / `l` | Move left / right one character |
| `j` / `k` | Move down / up one line (multi-line input) |
| `0` / `^` / `$` | Line start / first non-blank / line end |
| `w` / `b` | Next / previous word start (whitespace-split) |
| `x` / `X` | Delete the character at / before the caret (`x` deletes the last char at line end) |
| `d` + second key | `dd` delete whole line (newline included)<br>`d$` delete to line end<br>`d0`/`d^` delete to line start<br>`dw` delete to word end |
| `u` | Undo the last vim edit (stack capped at 100) |
| `i` / `I` / `a` / `A` | INSERT at caret / first non-blank of the line / after caret / line end |
| `o` / `O` | New line below / above, then INSERT |
| `/` | Inserts `/` and returns to INSERT (opens the command menu) |
| `Esc` | Cancel a pending `d`; otherwise no-op (the usual clear / double-Esc rewind semantics stay off) |
| `Enter` / `Tab` / arrows / `Ctrl+*` combos | Pass through unchanged (submit, completion, history, edit shortcuts…) |
| Other bare keys | Ignored, never inserted |

While vim mode is on, `Esc` belongs to vim:

- Use `/rewind` (or exit vim mode, then double-Esc) for time rewind.
- During a running turn, `Esc` in INSERT just returns to NORMAL; interrupt with `Ctrl+C` / `Ctrl+Enter`.
- Clear the draft in NORMAL with `Ctrl+C` or `dd`.

Bracketed paste from right-click or the terminal's native paste command keeps ordinary
text and newlines, and is never mistaken for an Enter key. To keep rendering, click
mapping, and selection geometry consistent:

- Terminal ANSI controls are stripped on entry.
- A multi-line paste no longer leaves a stray `_`, and no longer drops characters: when a Windows terminal delivers the paste as win32-input-mode records, the key records that leak into the payload (`ESC[Vk;Sc;Uc;Kd;Cs;Rc_`, or the ESC-less tail left by a split record) are decoded back into the characters their `Uc` field encodes — newlines included, through the same CR+LF fold — which is why the chip's line count equals the paste's real line count. **The decode needs evidence**: only a *transition pair* (the same `Uc` pressed and released) is decoded back into characters; a **lone** record — with no pair to prove it is a record stream rather than literal text in the payload — is still stripped whole as a protocol token and its `Uc` is **not** restored, as are records with no character meaning (a `Uc=0` synthesized record, a key record with no text). The promise is therefore "no character is dropped silently **once the bytes are proven to be a record stream**", not "every record shape is decoded back".
- Both stripping and decoding need evidence: complete records are consumed before ESC-less tails (so a record is never sliced open and its orphan ESC never eats the payload character behind it), and a tail must stand alone as its own token — a record-shaped run welded into the payload's own word is kept byte-for-byte (visible residue beats silent loss). Only the five-separator record grammar matches, so genuine underscores and bracket text that merely resembles a record are untouched.
- Pasted CRLF collapses: a CR+LF pair produces one newline instead of two; LF-only and lone CR keep their previous behavior.
- Tabs are expanded to spaces on entry.

### Fullscreen draft editor (`Ctrl+Shift+E` / `⛶`)

Long drafts stop squeezing into the 5-row window. `Ctrl+Shift+E` (remappable) or the
`⛶` affordance at the end of the input row expands the current draft into a whole-screen
editor that shares the exact editing state (caret/selection/fold/vim mode) with the inline
prompt.

- Turn it off in `/settings` → `dsh-tui` (`expandEditor`, on by default); both entry points (the `⛶` affordance and the shortcut) then disappear.
- **Chrome**:
  - A round border following the session accent / plan color.
  - A line-number gutter on the left (width scales with the row count; the caret row's number is highlighted).
  - The caret row carries a soft background.
  - The title row shows live line/char stats; the status row shows `Ln L, Col C` plus the vim badge (when `/vim` is on).
- **Keys**:
  - `Enter` inserts a newline (never mis-sends).
  - `Ctrl+Enter` or the `⏎ Send` button sends and collapses.
  - `Esc` is layered: clear the selection first, then collapse keeping the draft.
  - `Tab` inserts a 4-space indent.
  - Every other editing key (arrows, word jumps, Home/End, Ctrl+U/K/W, vim NORMAL keys) matches the inline prompt.
- **Fold blocks are mutually exclusive with it**: a big paste still folds into a chip while
  collapsed, but expanding the editor unfolds it (same semantics as clicking the chip);
  pastes inside the editor are plain, directly editable text; collapsing never re-folds them.
- **Mouse**:
  - Click positions the caret; drag builds a selection; double-click selects a word; `Ctrl+C` copies the selection. Geometry is corrected for the gutter width.
  - The wheel scrolls the viewport freely: browsing does not snap back to the caret; any caret move re-engages following.
  - The Send/Collapse buttons are clickable with hover feedback.
- Complements `Ctrl+G`: no `$VISUAL/$EDITOR` needed, never leaves the terminal.

## @ file references

### File completion

Type `@` at **any position** of the message to open file completion.

- Keep typing to filter; `Tab`/`Enter` to pick; directories can be entered further.
- Plain fragments match **fuzzily** — `@ment` matches `src/utils/mentions.ts` (prefix/boundary and short-path boosts).
- Path-shaped queries (`@src/`, `@./`, `@../`, `@~/`, `@D:\`, or anything containing a separator) read **only that directory** for local completion.
- `Esc` closes only the current `@` token's menu; async refreshes keep your selected candidate.
- Text files and directory listings are attached as text; PNG, JPEG, WebP, and GIF files are sent as durable Harness image blocks.
- Reads use the active workspace filesystem, including provider-owned workspaces.

### Pasted files and staged image tokens

On `Ctrl+V`, files copied from a file manager insert as paths.

- File managers include Finder, Windows Explorer, GNOME Files, KDE Dolphin, …
- Copied image files are staged into the attachment store exactly like clipboard bitmaps, and appear as `[Image #N]`.
- If staging fails, the token falls back to an `@` reference.
- Submitting the prompt sends a real image block.
- The prompt never contains base64.

- A terminal that forwards a drop as pasted text (Ghostty sends a shell-escaped path
  through the PTY) stages it only when it is exactly one existing local image path —
  anything ambiguous stays verbatim text.
- A staged `[Image #N]` is one unit in the composer:
  - The caret never rests inside it.
  - ←/→ step over it.
  - Backspace at its end, Delete at its start, and Ctrl+W remove it whole.
  - A selection edge inside it grows to cover the token.
- It renders in the theme accent and inverts whole while the caret sits at its start; clicking it places the caret at its start and opens the preview.
- The preview opens by itself while the token is selected (the caret at its start) and
  closes when the caret leaves; the cell just after the token does not count.
- The keyboard stays with the prompt meanwhile, so ←/→ walk from image to image with the card following.

### Image preview card

Click a staged `[Image #N]` token or a transcript thumbnail to open one shared, centered preview.

- Esc or a click outside the card dismisses the preview until the caret leaves and returns; a click on the token always shows it.
- The prompt, status rows and sticky header stay visible.
- Open original opens the unchanged bytes in the system viewer and preserves colors and animation.
- Without Kitty/Sixel graphics, the preview falls back to a metadata-only card; narrow terminals get the same.

### Zoom, pan, and switching

- Left/Right (or the bottom ‹/› controls) step to the previous / next image — no wrapping, with a current/total counter.
- Each image starts in Fit.
- Fit returns to the whole image; 100% displays original pixels; +/- selects 100%, 200%, 400%, or 800%, shown in the title.
- Pan with drag, wheel, or the arrow buttons.
- Actual pixels requires measured terminal cell dimensions.
- Session changes or blocking dialogs close the preview.

## Interface language

`/lang` toggles the UI between Simplified Chinese and English (affects all UI strings); the choice persists across restarts (0.3.7+).

- The **dsh-tui → Language** select in `/settings` switches it too: applies immediately and saves `dsh-tui.lang` in the active profile config (`~/.dsh/settings.yaml` on older hosts).
- The `DSH_TUI_LANG` env var always wins.

## Message delivery semantics

While the model is working, three paths have different placement:

| Action | Placement |
| --- | --- |
| `Enter` | known `/` command (with or without arguments) → run it, its own gate decides; anything else → steer: deliver to the running turn at its next step boundary |
| `Tab` | Follow-up: wait until the current turn finishes |
| `Ctrl+Enter` | Interrupt: stop the turn and deliver immediately |

**While a turn is running, a command is always a command; only two kinds of input steer: plain text that is not a command, and a direct skill gesture (`/skill-name …`).** The completion overlay groups commands by their impact on the current conversation: the harmless ones stay on top in their normal style, while gated, interrupting, replacing or steering commands sink to the bottom in the theme's grey (`subtle`, no header row) — where they stay selectable.

- Undelivered messages appear above the editor.
- `Alt/Option+Up` retrieves the latest one.
- Pressing `Esc` while the model works interrupts the turn and holds the queued
  messages above the input instead of re-sending them; the hint row reads
  `Press ↑ to edit queued messages, ⏎ to send now`. DSH and Claude behave the same.
  - With messages held and idle, `↑` on an empty input opens the queued-message
    selector: `↑`/`↓` move, `⏎` takes the selected message back into the input
    for editing, `Esc` leaves the selector. You can also click a held message
    (takes it back for editing; with a draft in the input the two swap, and
    `Ctrl+Z` swaps them back) or click the hint row (sends everything).
  - `⏎` on an empty input sends all held messages in order, exactly once; with a
    draft in the input `⏎` sends only the draft and the held messages stay, so
    they are never bundled with it.
  - `Ctrl+Enter` (with a draft) interrupts the turn and sends the held messages together
    with the draft right away.
  - When a turn ends normally, queued messages still flow into the next turn;
    `Ctrl+C` keeps the queue.
  - Only messages the backend confirmed as withdrawn are held. With an older
    Claude CLI that cannot withdraw them, or when the withdrawal request fails,
    the backend still runs them next turn; dsh-TUI stops holding them, says so,
    and never sends them twice.

## Session workflows

### Session management (`/resume`, `/home`, `/agentview`, `/bg`, prompt `⌸`)

The four commands and the `⌸` entry at the head of the prompt row all open the **same screen**:

- The workspace rail (the durable registry) on the left.
- The sessions of the selected workspace on the right, every row carrying that session's live state.
- Focus starts on the most recently used session in the current workspace, ready for `Enter`; with no history, it starts on the new-session card.

They used to be three implementations that grew apart — a session browser, an agent view,
a workspace home — each listing the same session with its own selection model and its own
idea of what "open" meant. Now there is one screen and one selection model.

The screen describes the runtime as it actually is: **one TUI process hosts several sessions at once**.

- Switching away PARKS a session, it does not end it — a turn in flight keeps running and is still there when you come back.
- Leaving a session therefore needs no confirmation, and there is no "stop" meaning to it.

Opening this screen **does not lose an unsent draft**: the composer unmounts with the
screen, and Chat keeps the draft — text, caret position, the staged image references, and
the edit state around them (fold block, fullscreen draft editor, vim mode) — until `Esc`
brings it back.

- A draft belongs to its **session**, so it never follows you into another conversation.
- The message `/rewind` hands back belongs to the session the rewind created, so it does stay in the input.

| Key | Action |
| --- | --- |
| `←` `→` | Choose the column that owns the keyboard (rail / sessions); exactly one `❯` is on screen |
| `↑` `↓` / `PgUp` `PgDn` / wheel | Move in the rail; move in the session list (row 0 is the new-session card) |
| Type | Filter the selected workspace's sessions live (title, directory, branch, model) |
| `Enter` | Sessions: enter the row under the cursor (row 0 = start a session in this workspace). Rail: open that workspace's action menu |
| `Ctrl+Enter` | Start a session in the workspace under the cursor (either column) |
| `Ctrl+N` | Start a session in the workspace under the cursor |
| `Ctrl+X` | Stop the **background** session under the cursor (the attached one cannot be stopped) |
| `Ctrl+L` | Re-read the workspace registry and the session listing |
| `Tab` / `Shift+Tab` | Next / previous source tab (when other agents have sessions) |
| `Esc` | Dismiss a notice → clear the filter → leave the screen |

The right side of the title row is the **source strip**: `DSH │ Claude Code  Codex …`.

- A tab appears only for another coding agent on this machine (Claude Code, Codex, Grok Build, zcode) that has conversations, in a fixed order; with none, there is no strip. Opening the screen only checks whether each source has any conversation; a source's list is read when its tab is opened.
- The screen always opens on `DSH`; click a tab or press `Tab` / `Shift+Tab` to switch, which clears the filter.
- On a narrow terminal the subtitle goes first, then trailing tabs fold into `+N` (click it for the rest); the active tab never folds.
- A source tab has the same two columns: the rail groups conversations by working directory (a registered directory keeps its workspace name; conversations with no recorded directory share an "Unknown directory" group), and the list shows that directory's conversations, filtered live by title and directory.
- There is no new-session card; `Enter` or a click **imports and opens** — just that one conversation is written into the DSH session store and entered. A conversation imported before opens directly, without a second copy.
- If the conversation's working directory no longer exists, nothing is imported and the notice line says so.
- On a source tab `Ctrl+N`, `Ctrl+X` and pins do nothing; `Ctrl+L` rescans the source.
- The import uses the same parsing and deterministic ids as `/migrate`, so both entries land a conversation on the same DSH session.

The rail's menu has four entries:

- **edit** — select that workspace, listing its sessions on the right.
- **new session**.
- **rename**.
- **remove from list** — the registration only; the directory and every session log survive.

A workspace joins by *starting dsh-tui in that directory* (the startup attach); there is no "add workspace" picker on this screen.

A session row's live state comes from the channel's own agent-view projection — the same
source as the status bar's "needs input" hint: working / needs input / idle / completed /
failed / stopped, and the session this terminal is attached to is marked `current`.

- Clicking a row enters that session (same as `Enter`).
- Clicking the in-row `★`/`☆` toggles the pin only (persisted in `~/.dsh-tui/session-pins.json`) and never enters the session.

A session held by **another** TUI terminal is still listed, but the row turns red, ends
with `held by pid <pid>`, and **cannot be clicked**: two processes driving one append-only
log would interleave its events and corrupt the transcript.

- Occupancy is re-read from the ledger on the screen's own 2-second tick, so the row becomes enterable again on its own once that process exits.
- A session this process parked is not "occupied".

See [session-mount-runtime.en.md](session-mount-runtime.en.md).

The rail carries an "Unregistered" group when the workspace service is absent (a bare
composition) or a session's directory is **not registered**. The group lists and resumes
those sessions as usual — "no registration" is not "no history".

- The group lives only inside this screen and is never written back to the registry.

**Behaviour changes versus the old screens** (deliberately removed, and no longer covered by regressions):

- Session-level right-click menu (rename/delete one session).
- `Ctrl+P` pin shortcut.
- `Ctrl+S` to reveal delegated runs.
- `Ctrl+A` this-project/all-projects.
- `Ctrl+B` branch filter.
- `Tab` preview, `Ctrl+R` rename, `Ctrl+D` delete, `Ctrl+X` clearing empty sessions.
- Pinning is still reachable by clicking the row's `★`.
- Not returned to the new screen: dispatching a background session and replying to one,
  the `Space` peek panel, and `Shift+Enter` dispatch-and-attach. After `/bg`, reach a
  background session by pressing `Enter` on it in the workspace list.

On Windows, `dsh-tui.cmd --resume` uses the session ID last written to `~/.dsh-tui/resume.txt`.

### Background sessions

On DSH, `/bg` (alias `/background`) moves the current session to the background and keeps it
running, switches the terminal to a fresh session, and opens the session-management screen;
`←` on an empty prompt does the same. On Claude/Codex, both entries open the session manager
without backgrounding the attached session.

- While a background session waits on you, the prompt footer shows `← N agents`.
- A background session awaiting approval shows as **needs input**, and the approval panel labels which session it comes from.

### Rewind

Double-tap `Esc` on an empty editor to open the user-message list. After a selection is confirmed, the TUI:

1. Finds the beginning of the turn containing that message.
2. Creates a branch session through DSH session fork.
3. Replays history before the boundary.
4. Restores the original message to the editor for revision and resubmission.

- The boundary is taken **before** the turn that contained the message; you **cannot rewind past the first message**.
- If the model is working, the TUI cancels the turn first and waits for it to settle (up to 30s).
- The rewound branch is not a sub-agent (it records `parentSession` without `origin`) and keeps using the current model route plus the session's own preset.

Plugins can intervene via the `tui/rewind-prompt` decision event:

- Veto the rewind (with a reason).
- Offer extra rewind modes in the confirm pane — e.g. "rewind the conversation AND restore the files changed since".

The first option is always "Conversation only". When a plugin mode is picked, the plugin
receives `tui/rewind-done` (with the chosen mode id and both session ids) once the rewind
completes, and may reply with a summary toast.

### Side question /btw

`/btw <question>` asks a quick side question without disturbing the main task: it reuses
the current session context (system prompt + existing history) for a single **tool-less,
one-turn** model call, and shows the answer in a scrollable panel.

Notes:

- **Never enters conversation history**: the exchange is not written to the session log
  and never reaches the main context or token counts (closing the panel discards it).
- **Never interrupts the running turn**: it can be triggered while the model is streaming; the main task keeps going.
- Inside the panel: `↑`/`↓` scroll, `Space`/`Enter`/`Esc` dismiss, `c` copies the answer; `Esc` cancels while the answer is still pending.
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

`/settings` opens the plugin settings editor, read/edit by namespace.

- Edits **auto-save**: `↑`/`↓` to move, `Enter` to expand/toggle/edit, booleans/selects write on the spot, text drafts confirm on Enter, `Esc` just exits.
- Fields under the dsh-tui namespace are written to the active profile config (legacy: settings.yaml user layer) and take **effect immediately** (`lang`, `statusBar.*`, …).
- Namespaces without a declared TUI section are listed read-only and need manual edits to the profile config (`~/.dsh/settings.yaml` on older hosts).

### Model and preset

`/model` shows the model list and the highlighted model's reasoning effort on one page. DSH also has provider tabs, with **Recently used** first; opening records the current model as the latest use and moves it to the front without duplicates, initially focusing it when it is still in the catalog.
Codex and Claude show their complete model catalogs directly, without provider or recents tabs; the current model is initially focused when the catalog loads.
In DSH, `Tab` selects the next provider and `Shift+Tab` the previous one, wrapping at either end; all backends use `↑/↓` to select a model and `←/→` to adjust its effort.
Confirmation submits only explicit effort drafts. Changing only the model leaves saved-effort validation to the backend; candidate defaults do not become new preferences. While the picker is open, `Ctrl+B` and `Alt+Z` still control the sidebar, and picker navigation stays with the model picker.
`Enter` applies the model and effort; `Esc` cancels the draft. Shortcuts sit below the title, and a separate effort heading and level strip sit below the models, with the `←/→` hint beside the effort heading. Selectable levels use the body text color and the current level is highlighted. DSH, Claude, and Codex share the same overlay behavior: text and portrait images behind the picker are covered, without adding a permanent panel color.
Click tabs, models, and effort levels, then click **select** or **cancel** below the title; the wheel moves through the model list. When space above the input is tight, navigation hints, model descriptions and neighboring models are omitted, effort collapses to one row, and Select / Cancel stay at the bottom. With only two rows, effort is hidden too, keeping the focused model and actions visible.

`/model` switches through a session fork at the end of current history, because DSH has no in-place model-switch API. The old session remains in `/resume`.

- A session nobody has typed into records no branch: switching models there yields an independent session with no `parentSession` (inheriting the same session-scaffolding prefix), so the first real prompt you send still triggers automatic session-title generation. A session that already holds a conversation keeps its lineage as before.

- `/preset` switches in place only for a blank session. In a started session, the choice becomes the default for the next `/new` or launch.

See [Configuration](configuration.en.md#agent-presets).

### Channel profiles (/channel, Claude only)

Relay channels often route a request to a different model while keeping a Claude
tier name (such as Opus 5.5 (1M)). A channel profile records each channel's model
mappings and connection, in `~/.dsh-tui/backends/claude/channels.json`:

```json
{
  "active": "zhipu",
  "channels": [
    {
      "id": "zhipu",
      "name": "Zhipu",
      "baseUrl": "https://open.bigmodel.cn/api/anthropic",
      "tokenRef": "CHANNEL_ZHIPU_TOKEN",
      "models": { "claude-opus-5-5[1m]": "glm-5.3[1M]" },
      "tiers": { "opus": "glm-5.3[1M]", "haiku": "glm-5.3-flash" }
    }
  ]
}
```

- `models` is an exact map: exact match first, then a match that strips the `[1m]`
  suffix and ignores case. `tiers` matches tier keywords (`haiku`/`opus`/`sonnet`/
  `fable`); the reserved `default` matches every other model (like
  `ANTHROPIC_MODEL`). Both fields are optional.
- The `id` is derived from `name` (lowercase, non-alphanumerics folded into `-`);
  importing again updates the channel with the same id.
- The model name shown is taken in this order: the active channel's `models` > its
  `tiers` > the legacy `model-names.json` > the tier variables in the Claude
  settings `env` > the raw id. Without an active channel it is as if the file did
  not exist.
- `baseUrl`, `tokenRef` and a channel-private `env` are the connection; all are
  optional. The active channel decides where the session connects and outranks the
  dsh-auth subscription sign-in. The token is stored in `~/.dsh/.credentials.yaml`
  (0600, the same credential store `/provider` uses, referenced as
  `CHANNEL_<ID>_TOKEN` by default); `channels.json` keeps only the reference, never
  the token.
- The connection reaches the CLI twice: in the child environment and through the
  SDK `settings` option (the CLI's `--settings` layer, which outranks the `env` of
  `~/.claude/settings.json`, so values a tool such as cc-switch wrote there cannot
  override the channel). `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` issued for a
  different endpoint are never carried to the new host.

`/channel` opens the picker, in this order:

- The channels (the active one ticked, the sub-row shows the mapping counts).
  `Enter` switches the active channel. Between channels with the same connection
  the switch is in place and the footer and `/model` names refresh at once; a
  different connection restarts into a new session (a running CLI cannot change
  its connection).
- *Import from settings.json*: names the channel after the `ANTHROPIC_BASE_URL`
  host, takes `ANTHROPIC_DEFAULT_{HAIKU,OPUS,SONNET,FABLE}_MODEL` and
  `ANTHROPIC_MODEL` as `tiers` (exact `models` are never guessed), and takes the
  `baseUrl` and `ANTHROPIC_AUTH_TOKEN` too (the token goes to the credential store
  as above). Importing again updates the same-id channel and keeps hand-written
  `models`.
- *Add a channel* and *Manage channels*: open the same question panel `/provider`
  uses. Adding asks for the name, base URL, token (input hidden), mapping source
  (take the tiers from the settings or skip) and whether to switch now; managing
  edits the base URL or token, refreshes the mappings from the settings, or deletes
  the channel along with its stored token.
- *View mappings*: prints the active channel's `models` and `tiers` as a local
  transcript block. To edit single entries, edit `channels.json`; the display
  follows the order above live.

A corrupt file reads as empty, a failed write only reaches the debug log, and
writes go through a same-directory temporary file and an atomic rename. dsh-tui
never edits `~/.claude/settings.json`; when its `ANTHROPIC_BASE_URL` or credentials
conflict with the active channel, the session start shows one notice that this
session connects per the channel profile. The command appears only in Claude
sessions.

### Workspaces

- `/workspace resume` opens the workspace picker.
- `/workspace rename <name>` renames the current workspace.
- `/workspace open <target>` opens a workspace and starts a fresh session.
- `/resume` and `/rename` continue to switch sessions within the current workspace and rename the current session.
- A local target may be an absolute path, a path relative to the current local workspace, or a standard `file://` URL.
- Other URI schemes and `/workspace` subcommands are registered by optional plugins; the TUI has no built-in knowledge of any external protocol.
- When a plugin owns the current workspace, it also resolves relative paths in its own path space.

After `/workspace `, the completion menu includes both built-in and plugin-contributed subcommands.

- Type a prefix and press Tab, for example `/workspace rem`.
- Plugin aliases participate in matching as well.

The launcher accepts the same target, for example `dsh-tui .`, `dsh-tui ../project`, or `dsh-tui file:///path/to/project`.

- Without any workspace plugin installed, local paths, `!command`, and all normal TUI session flows remain available.

## Fullscreen and mouse

`fullscreen: false` restores inline mode (fullscreen is the factory default since 0.9.0).
In inline mode, the terminal emulator owns native scrollback and selection.

`fullscreen: true` uses the alternate screen and enables in-app mouse handling:

- **Wheel** — Routed by position. Moves the selected row in the completion/command menu
  under the pointer; scrolls the topmost scroll container (transcript / help / subagent
  panel); elsewhere scrolls the message list (±3 lines per notch). Never scrolls the
  transcript behind an open overlay. Moves the cursor in the trajectory scene (±3 rows per
  notch on the timeline, ±1 in hotspot; scrolls the detail while expanded). Walks the
  focused row in /settings.
- **Drag** — Select text and copy on release, keeping the selection; a "Copied N characters"
  notice pops up. A new selection replaces the retained one. With
  `dsh-tui.scrollGutter: scrollbar`, the right-edge scrollbar is a drag
  target: an unmodified left drag scrubs the transcript to the track position (same mapping
  as a track click — drag to point), while `Shift`/`Alt`/`Ctrl`+drag still selects text (the
  drag protocol opens only for unmodified left presses).
- **Double/triple click** — Select and copy a word/line (exception: the
  `scrollGutter: scrollbar` track is a drag target, so multi-clicks there no longer select a line).
- **`Esc`** — Cancel an active drag (or an existing selection) without copying.
- **Single-click a message row** — Plain text rows (user/assistant) do nothing — the
  transcript is a reading surface, selection is the mouse's job there.
- **Single-click a tool card / thinking / compact summary** — Expand / collapse (header
  brightens on hover; trailing blank cells do not trigger).
- **Single-click a subagent card** — Open that subagent's detail scene (status glyph
  brightens on hover).
- **Single-click the input box** — Place the text caret at the click (multi-line, wrapped
  rows and CJK all width-aligned).
- **Click a `[Image #N]` token in the input box / a transcript thumbnail** — Open the
  centered image preview (image metadata when Kitty/Sixel graphics is unavailable); clicking
  outside the preview closes it.
- **Drag inside the prompt input** — Build an in-input selection (rendered highlight, caret
  rides the drag end). `Backspace`/`Delete` delete it, typing replaces it, `←/→` collapse it
  to the corresponding edge, `Esc` only clears it. Drags map only visible rows (no edge
  auto-scroll yet). A folded paste block keeps the selection on the clicked side (never
  across the chip row).
- **`Shift+click` in the prompt input** — Extend the selection from its start edge (or the
  caret) to the clicked position.
- **Double-click a word in the prompt input** — Select the whole word (detected in the
  component, 500 ms / 1 cell; paths and punctuation runs select as one).
- **`Ctrl+C` with a prompt selection** — Copy the selection to the clipboard (OSC 52 +
  native fallback) and keep it for editing.
- **Fullscreen editor (expanded via `Ctrl+Shift+E`)** — Click/drag/double-click follow the
  prompt-input paths (geometry corrected for the gutter). The wheel scrolls the editor
  viewport (position-routed; caret moves re-engage following). The Send/Collapse buttons
  execute on click and brighten on hover. The input row's `⛶` expands.
- **Single-click "load earlier messages" / "ctrl+e show previous N"** — Load earlier
  messages / expand all.
- **Single-click the sticky header / "↓ N new messages"** — Jump back to the pinned message /
  scroll to bottom.
- **Single-click a hyperlink** — Open it in the browser.
- **Single-click a picker / menu row** — Select and apply immediately (model / skills /
  activity frames / preset / permissions / plan / language / theme / effort / command & file
  completion / history / session rows / thinking mode / workspace targets, submenu & flow
  choices) — the keyboard Enter path. Rows are inert while a picker is busy or mid-input.
- **Single-click a rewind candidate / confirm row** — List page: click selects only
  (stepping into the confirm state stays an explicit keyboard Enter). Confirm page: clicking
  the message / mode row executes the rewind directly — the confirm pane is itself the
  confirmation layer.
- **Single-click an approval / questionnaire / plan-review / plugin dialog row** — Submit
  that decision directly (unblock a waiting agent with the mouse).
- **Single-click in the trajectory scene** — Timeline/hotspot rows jump the cursor (a
  hotspot row jumps back to the timeline at that group — same as Enter; hover shows a dim ▸
  pointer). Tabs switch views; the sort/projection label cycles; the query line and the tab
  gap open the `/` search; a wave-band column (ruler included) jumps to its nearest event.
- **Single-click a /settings field / group row** — Focus it and run that row's Enter action
  (boolean/select cycles, text enters edit, groups open). Hover moves the focus
  (lazygit-style). The edit mode ignores the mouse entirely.
- **Single-click a session-browser confirm row** — Confirm the delete/clean (same as Enter);
  cancelling stays on keyboard Esc.
- **Single-click a help-menu command row** — Fill `/name ` into the prompt and close the
  help (the Tab completion's mouse equivalent).
- **Click a timeline-rail tick** — Jump to that turn — the rail covers every turn (folded
  ones included); a folded tick reveals its turn first, then scrolls it into place.
- **Keyboard selection extension** — With a selection, `Shift+←/→/↑/↓/Home/End` extends /
  shrinks it (wraps across lines).

These mouse behaviors apply only under `fullscreen: true` (alternate screen). Inline mode
enables no mouse reporting, so scrollbar dragging does not apply there — the terminal's
native scrollback and selection stay in charge.

- Copy prefers OSC 52.
- Local fallbacks include `wl-copy`, `xclip`, and `xsel`; tmux uses `load-buffer -w`.
- Set `DSH_TUI_DISABLE_MOUSE=1` to temporarily disable fullscreen mouse handling.

## `ask_user_question` questionnaires

When the model invokes the questionnaire tool, its panel temporarily owns the keyboard:

| Key | Behavior |
| --- | --- |
| `Up/Down` | Move through options |
| `Space` | Toggle a multi-select option |
| `Tab` | Switch to a custom text answer |
| `Enter` | Submit the current question |
| `Left` / `Right` | Switch questions and keep the current draft (does not submit). On the free-text row, arrows still move the caret; they switch questions only when the caret is already at the start or end |
| `Esc` (from question 2 onward) | Return to the previous question and keep the current draft |
| `Esc` (from question 1) | Cancel the whole batch; the model receives `ASK_CANCELLED` |
| `Ctrl+C` | Cancel the whole batch from any question; the model receives `ASK_CANCELLED` (a harness-side abort still reports `ASK_ABORTED`) |
| `Ctrl+K` | Fold/unfold the ask_user_question questionnaire panel (the ask keeps waiting; while folded, `Esc`/`Ctrl+C` expand first) |

The last row is a free-form input line:

- Typing directly on an option row submits that option's label **plus** your custom text together (no need to `Tab` first).
- `Tab` jumps straight to the input line.

- Batched questions and concurrent subagent questions are shown one at a time in FIFO order.
- A compact Q&A summary is added to the local transcript afterward.

## Plan review

When the model calls `exit_plan_mode` in plan mode, the full plan is rendered as markdown
in the review panel (the dedicated decision layout for `intent: plan-review`):

| Key | Behavior |
| --- | --- |
| `Up/Down` | Move between the options and the feedback input line at the bottom |
| Mouse wheel | Scroll the plan body; Approve / Keep planning / feedback stay pinned in view |
| `1`/`2` | Submit the corresponding option directly (when the feedback buffer is empty; otherwise digits are treated as feedback characters) |
| Typing | Enters the feedback input line |
| `Enter` (option row) | Submit that option; an approval row with feedback errors out — approval must carry no feedback, or the protocol treats it as "continue planning" |
| `Enter` (input line) | Submit "continue planning" with the feedback text |
| `Esc` | Interrupt the review to talk (`ASK_CANCELLED`); the model stays in plan mode |

- Approving a plan or running `/plan off` restores the actual sandbox and approval policy from before plan entry.
- `Shift+Tab` keeps the selected target mode, including switches deferred while a turn is running.
- Resumed sessions recover pre-plan permissions from event history; unknown historical
  permissions stay unchanged instead of falling back to full access when no configured
  mode matches.

## Tool approval

When the permission layer issues an `approval/request`, the approval panel shows the tool
name, the full command extracted from the paired tool call, and the reason. It temporarily
owns the keyboard (when a questionnaire is also pending, approval takes priority):

| Key | Behavior |
| --- | --- |
| `Up/Down` | Move through options |
| `1` / `2` | Allow (this time only) / deny |
| `Enter` | Submit the focused item |
| `Esc` / `Ctrl+C` | Deny (fail closed) |

The protocol offers only "allow once / deny" — there is **no "always allow"**.

On the Claude backend the approval comes from the CLI: it adds *allow always*
when the CLI suggests a rule, and with the focus on the reject row you can type a
reason; see [Claude backend](claude-backend.en.md#approvals-and-questions).

## Slash commands

The command menu merges local commands with the DSH command registry. Type `/` to inspect the complete surface available in the current composition.

- **While a turn is running**, the overlay groups commands by their impact on the current conversation: the harmless ones stay on top in their normal style, while gated, interrupting, replacing or steering commands sink to the bottom in the theme's grey (`subtle`, no header row) — and stay selectable there.
- Command descriptions follow the UI language (`/lang`).
- Built-in commands and mapped registry commands (`/plan`, `/goal`, `/feedback`) show Chinese translations in zh.
- Unmapped registry commands fall back to the registry's own text.

**Sessions**

- `/new`, `/resume`, `/home`, `/agentview` — all three open the same session-management screen.
- `/bg` — alias `/background`, opens the session manager; DSH backgrounds the session first, while Claude/Codex keep it attached.
- `/rename`.
- `/recap` — session recap: apply the suggested title in one key; `/settings` can enable an
  auto-summary on session open, on by default — a divider + `Recap:` line appears at the
  bottom of the transcript when resuming, and bows out once you send a new message.
- `/workspace resume|rename|open`.
- `/clear`, `/compact`, `/export`, `/btw`.
- `/trace` — trajectory scene, also `Ctrl+T`.
- `/rewind` — time travel, same as double-`Esc` on an empty input.
- `/tree` — session family tree: every fork branch stitched together; hover previews a node,
  click opens a rewind / fork-here / adopt-branch menu.
- `/fork` — copy the current session into a resumable twin; the original is untouched.

**Status**

- `/context`, `/status`, `/cost`, `/balance` — official DeepSeek balance: summary row + hover details, click to refresh.
- `/config`, `/doctor`, `/init`, `/agents`, `/jobs` — background jobs panel: status/elapsed/exit code, `k` kills; with the split layout on and the terminal wide enough it opens as a right-column panel instead (narrow terminals and inline mode keep the full-screen panel).
- `/settings`.

**Model and display**

- `/model`, `/effort`, `/thinking`, `/tokens`, `/activity`, `/preset`, `/theme`.
- `/channel` — the channel-profile picker (Claude backend only; see the Channel profiles section).
- `/color` — session accent color: bare opens the palette picker, `<name>` sets directly, `status`/`reset`;
  input border + session-name chip at the top-right, per-session; chip off by default, enable
  in `/settings`.
- `/panel` — side panel: toggle / focus / zoom / switch panels (subcommands in the user guide §2.8).
- `/lang`.

**Account and policy**

- `/provider`, `/login`, `/logout`, `/permission`, `/add-dir`, `/hooks`, `/mcp`, `/plugins` — `check <path>` validates a plugin manifest.
- After `/auth login deepseek-account` or `/provider` signs in, a Platform-confirmed, unshown login bonus appears with its amount and expiry as a “Whale coupon” in the whale-maid dialog; Enter/Esc closes it.

**Skills**

- `/skills` — lists skills DSH discovers from the active profile, user, and project; user-invocable skills join the menu as `/name`.

**Other**

- `/update`, `/vim` — vim editing mode toggle, see "Editing keys".
- `/terminal-setup`, `/connect`, `/help`, `/exit` — aliases `/quit`, `/q`.
- `/kernel` — opens the kernel picker (the current kernel is ticked; every row
  carries a version and a one-line explanation), on DSH and Claude sessions alike.
  Picking the other kernel remembers it and restarts into it with a new session;
  the old session stays in `/resume`, and if the new session fails to start you
  are back on the old one. A running turn blocks the switch. The launchpad's
  Kernel entry and its bottom-right kernel block open the same picker. When
  `--backend` or the config row names a kernel, this restart follows your pick but
  a later direct launch follows the flag. A fresh launch lands on the launchpad
  whichever kernel is remembered; a launch with a resume target goes straight
  into the session.

**Registry**

- `/plan`, `/goal`, and any other command registered by the DSH composition.

> Unknown commands are sent to the model as ordinary messages (e.g. in a composition where `/permission` is not mounted).

dsh-TUI does not preinstall general-purpose skills; DSH and the active composition own skill content and discovery.

Additional forms:

- `/activity` opens the animation picker.
- `/activity frames <name>` selects directly. Current names: `random`, `star2`, `sand`,
  `triangle`, `box`, `box2`, `corners`, `point`, `layer`, `flip`, `aesthetic`,
  `hamburger`, `moon`, `moon8`, `whale-spout`, `whale-spin`, `whale-bubbles`, `clock`,
  `traffic_lights`, `comet`, `breathe`, `dots`, `arrow`, `spark`, `bar`, `braille`, `arc`,
  `circle`, `grow`, `noise`, `bounce`, `rainbow`, `bar2`, `dqpb`, `toggle`; default `moon8`.
- A legacy local `claude` setting is read as `moon8`, and the picker does not show that legacy preset.
- `/activity status` reports the current choice.
- `/preset <id>` and `/preset status` are described in the configuration guide.
- `/effort` opens the reasoning-effort slider (←/→ adjusts live); `/effort <id>` sets a level directly; `/effort status` reports the current one.
- `/model` opens a two-level picker:
  - A pinned **Recently used** group first — the last 10 switched models, persisted at `~/.dsh-tui/model-recents.json` — then provider groups.
  - `Enter` drills into a group's models, and a single provider with no recents skips straight to the list.
  - Switching = fork continuation, history preserved.
- `/theme <name>` and `/theme status` are described in the theme guide.
- `/permission` reads the DSH `permissionPresets` registry, preserving registry order for
  the picker, completion and the `Shift+Tab` cycle. Third-party presets need no TUI
  hard-coding.
- While the service snapshot is usable, the TUI owns `/permission` as a local command:
  bare run opens the picker, an argument switches directly, `status` prints the current
  preset and policy explainer.
- Switches prefer the official `/permission <preset>` command. When the command row never
  reaches this agent's registry, the TUI falls back to the service's own official write
  path (the same handler, real events) and confirms via event/readback. When neither is
  available, it fails loudly instead of sending the input to the model.
- Exiting plan mode restores the pre-plan atoms first, then the durable preset you were on before plan mode (while the registry still offers it).
- The DSH `/permission` pick is persisted the same way at `~/.dsh-tui/permission.json`: every durable
  preset switch teaches it (picker, typed command, Shift+Tab static mode, or a switch the official
  command performed on its own), and a session that never customized its permission planes starts on
  the remembered preset — applied through the same official switch path. "Never customized" means the
  USER never touched it: the composition itself writes its default preset into every fresh session at
  creation (`dsh-permission-presets`' `session/created` → `pinInitialPermission`), and those events are
  not a user choice — only a session that ran a turn, or whose identity is not the composition default,
  keeps its own planes. Plan-mode transients are excluded (entering plan keeps the pre-plan memory; the
  exit restore teaches it again), `DSH_PERMISSION_MODE` is this launch's initial permission plane and
  outranks the file when set, and an identity the mounted roster no longer offers is skipped.
- When the registry service is absent, TUI uses its legacy three-row compatibility roster; a mounted but broken service is unavailable and fails closed.
- Non-DSH backends (Claude) that declare native permission modes answer
  `/permission` with that backend's own modes: `default` (ask before each risky
  action), `acceptEdits` (auto-accept file edits), `plan` (read-only planning),
  `bypassPermissions` (skip every permission check), plus `auto` where the model
  supports it, each with a one-line explanation. `bypassPermissions` can only be
  picked explicitly here; the `Shift+Tab` cycle default → acceptEdits → plan
  (→ auto) never reaches it. The footer always shows the current mode
  (`bypassPermissions`/`dontAsk` in the warning colour), except under Minimal UI.
  A Claude settings file with `defaultMode: bypassPermissions` is downgraded to
  `default` with a transcript notice, so a cloned repository cannot silently turn
  every prompt off.
- The `/permission` pick is saved to `~/.dsh-tui/backends/claude/prefs.json` (the
  same file as the model and effort picks) and later sessions start on it.
  Precedence: the `DSH_TUI_CLAUDE_PERMISSION_MODE` environment variable > the
  remembered pick > Claude settings > `default`. Starting in `bypassPermissions`
  from the remembered pick is announced in the transcript.
- `/lang` toggles the interface language (see "Interface language").
- `/compact` compresses the session history; unavailable under the kernel Minimal agent preset (`minimal`, a single persistent-shell tool), which mounts no compaction and does not prune tool results — a long session can hit the context limit and oversized tool output stays in full (Help and `/` completion mark the entry, and entering the preset says so once) — unrelated to the display-side Minimal UI switch.
- `/thinking` toggles extended reasoning display; UI state only — **not persisted**.
- After startup, the TUI checks npm for a newer version in the background and shows a notification when one is available.
- The check follows the npm registry configuration (`NPM_CONFIG_REGISTRY` or `~/.npmrc`),
  so mirror users see the versions their package manager actually installs.
- `/update` updates the installed `@deepseek-harness-tui/dsh-tui`, then restarts and
  resumes the current session automatically; wait for an active turn to finish first.
- It is only available under a `dsh --profile <name>` launch (source checkouts get an
  unavailable notice), and an already-latest install is reported as such without
  restarting.
- `/plan [off|message]` and `/goal ...` are handled by DSH command plugins and recorded as session events.
- Skill commands are executed by the host injecting the corresponding `SKILL.md` body,
  with arguments passed through unchanged; DSH and the active composition own their
  content and discovery.

`/connect` and `/hooks` are currently compatibility placeholders.

- When the DSH composition has no matching capability, each command explains that explicitly rather than silently doing nothing.
