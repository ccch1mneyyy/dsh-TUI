<p align="center">
  <a href="../zh/technical-highlights.md">简体中文</a> | <strong>English</strong>
</p>

[← Documentation index](../Index_EN.md)

# Technical Highlights

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
