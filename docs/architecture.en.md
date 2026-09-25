# Architecture and Limitations

[Documentation index](README.md) · [简体中文](architecture.md)

## Runtime path

```text
Cordis profile
  -> src/index.ts (plugin contract and Schema)
  -> src/dsh-adapter/plugin.ts (services, Agent, and React lifecycle)
  -> DSH Agent / session / tool services
  -> src/dsh-adapter/channel.ts (session/event -> Channel)
  -> src/screens/Chat.tsx (keyboard and mode orchestration)
  -> src/components/* (views)
  -> src/ui.ts (themed renderer facade)
  -> src/ink/* + Yoga (layout, terminal protocol, differential output)
  -> ANSI terminal
```

## Module ownership

| Module | Owns |
| --- | --- |
| `src/index.ts` | Cordis plugin name, injection declaration, config interface, and Schema; keep the entry small and lazy |
| `src/dsh-adapter/plugin.ts` | TTY guard, service assembly, Agent create/resume, React mount, and the single cleanup funnel |
| `src/dsh-adapter/questions-answerer.ts` / `preset-resolution.ts` | Prerelease dispatch for user questions and agent presets; consumers stay unaware of upstream version branches |
| `src/dsh-adapter/channel.ts` | Channel composition root: options/services, owner/binding, specialist wiring, one install, final start/release, and compatibility exports |
| `src/workspaces.ts` | Local-path fallback and generic workspace-provider registry; it must contain no provider protocol, copy, or dependency |
| `src/screens/Chat.tsx` | Modal precedence, global keys, scroll/search/selection state, and slash dispatch |
| `src/components/` | User views and design-system primitives; no Agent or session source of truth |
| `src/ui.ts` | Themed `Box`/`Text`, render, selection, scroll, and other public TUI primitives |
| `src/theme.ts`, `src/themeCatalog.ts` | Built-in, static JSON, and runtime plugin theme resolution and catalog ordering |
| `src/dsh-adapter/themes.ts` | The `ctx.tuiThemes` theme seam, registration lifecycle, and private host facade |
| `src/ink/` | Ink-based renderer, terminal protocol, events, selection, and Yoga bridge; sensitive infrastructure |
| `src/native-ts/yoga-layout/` | Pure JS/TS layout implementation |
| `cordis.patch.yml` | Profile bundle layer, service rows, overrides, and mount ordering |

The `channel.ts` responsibilities are split across these files:

- `channel/action-readiness.ts`: typed action forwarding/readiness.
- `channel/lifetime-resources.ts`: detached handles.
- `channel/context-bookkeeping.ts`: context-warning/pending bookkeeping
  (including the warning cell shared with compaction reset).
- `channel/state.ts`: neutral initial fields.
- `channel/command-completions.ts`: completion.
- `channel/local-actions.ts`: local transcript/shell/subagent-report actions.
- `channel/activity.ts`: the activity clock.
- `channel/binding-events.ts`: binding event routing.
- `channel/projection.ts`: the sole projector remains.

An uninstalled or released action fails explicitly; it never pretends
success with a no-op.

Do not duplicate DSH Agent, session, or tool services in a component. Connect new
capability through an existing service, registry, or channel seam.

Workspace extensions follow a one-way dependency: the TUI publishes only a
structural provider interface, while optional plugins register URIs, display
metadata, and command executors.

Theme extensions follow the same rule: plugins register complete semantic palettes
through `ctx.tuiThemes`. The host owns validation, ordering, rendering,
and lifecycle; plugins never rewrite the theme directory or host palette.

Protocol parsing and external connections belong entirely to the plugin.
Removing a plugin must leave local workspaces and session flows free of
missing configuration, placeholders, or fallback branches.

## The session log is the source of truth

`channel.ts` does not treat a React-local array as conversation truth. DSH
`session/event` records own:

- initial replay and incremental streaming events;
- assistant/reasoning/tool association and sequence anchors;
- rewind turn boundaries;
- reconstruction after resume, export, compact, and fork.

The Channel keeps a TUI-sized projection. Once a long transcript exceeds its
window, older rows fold into short previews while the complete content
remains in the session log and can be restored from events.

Tool results are associated by `callId`, never guessed from array position.

## Rendering and long-session performance

- **Differential output**: each frame writes only screen changes and uses
  capability detection to choose synchronized output, cursor, and Windows
  Terminal paths.
- **Message virtualization**: off-screen rows use the last measured fixed-height
  placeholder and do not participate in the full layout subtree.
- **Replay coalescing**: consecutive token chunks are merged during history
  replay, avoiding repeated string growth for long streamed messages.
- **Bounded caches**: transcript, render-node, and measurement caches are bounded;
  removing a bound requires measured evidence.
- **Zero-allocation hot paths**: the visibleRows pipeline (slice/filter/margins)
  is memoized on rows identity, length, and a Uint8Array streaming-bit
  fingerprint — zero array/Map allocations per scroll tick.
- **Global LRU caches**: wrapText and markdown tokens flow through global
  LRU caches that reuse measurements across mounts.
- **Framed backfill**: opening the main screen mounts the tail window first
  and backfills history in frames.
- **Landing anchor**: `/resume` asserts a final state where the newest
  message's last row is visible and reachable, and long-session restores
  skip the splash animation to land straight on content.
- **Display-cell width**: ANSI escapes, combining marks, emoji, and East Asian
  wide characters use terminal cell width, not JavaScript `string.length`.

When changing `src/ink/` or Yoga, run the CI questionnaire/tool-card
regressions and the affected scroll, resize, copy-on-select, or PTY harness.

Do not print diagnostics to an active TUI's stdout; use stderr
`DSH_TUI_DEBUG` or `DSH_TUI_RENDER_LOG`.

## Status meters and working activity

- **Context progress bar**: based on the pi-nano-context algorithm
  (largest-remainder segmented coloring + multi-level condensed readouts).
- **TPS meter**: based on pi-tps-meter — a streaming 1/8-block gauge,
  historical min-max sparkline, and speed-based semantic colors (≥50 green /
  ≥20 yellow / <20 red).
- **working-activity**: the working-status line reuses the pure state machine
  of [dsh-working-activity](https://github.com/ccch1mneyyy/working-activity).
- It derives in-process from base session events without writing UI state
  into the shared log.

## Inline and fullscreen modes

- **Inline**: content remains on the main screen, and the terminal
  emulator owns scrollback and native text selection.
- **Fullscreen**: `AlternateScreen` switches to the alternate screen, where the
  TUI owns scrolling, mouse selection, OSC 52 copy, and screen restoration.

Both modes share the Channel and React views but use different terminal
protocol paths.

Changes involving input, scrolling, mouse, cursor, resize, or cleanup must
be checked in both modes, especially on narrow terminals and Windows ConPTY.

## Persistence locations

| Path | Contents |
| --- | --- |
| `~/.dsh/sessions/` | Shared JSONL session events for profile TUI and Web |
| `~/.dsh-tui/sessions/` | JSONL session events for direct `cordis.yml` runs |
| `~/.dsh-tui/resume.txt` | Recent session ID used by the Windows launcher and exit hint |
| `~/.dsh-tui/last-used.json` | `/resume` recency metadata |
| `~/.dsh-tui/theme.json` | Current built-in, static, or plugin theme ID |
| `~/.dsh-tui/themes/` | User theme JSON files; runtime plugin themes do not write here |
| `~/.dsh-tui/working-activity.json` | Activity animation selection |
| `~/.dsh-tui/agent-preset.json` | Default Agent preset for new sessions |

`DSH_TUI_SESSION_ROOT` overrides the JSONL root in either composition. The
profile defaults to `$DSH_HOME/sessions` (normally `~/.dsh/sessions/`);
direct `cordis.yml` runs default to `~/.dsh-tui/sessions/`.

Preference files are optional state: malformed or missing files fall back
silently rather than preventing startup.

The data directory is `~/.dsh-tui` (early releases used `~/.dsh-cc`; code
since the rename reads and writes only `~/.dsh-tui` and does not migrate the
old directory automatically).

## VS Code channel details

The `dsh-tui-vscode` companion extension's integration surface with the TUI,
relevant when maintaining the dsh-tui side:

- **Specific-session resume (env channel)**: clicking a sidebar entry injects
  the target session id into the terminal env via `DSH_TUI_RESUME_SESSION`
  and deliberately does NOT pass `--resume`. This profile's
  `cordis.patch.yml` reads that env at boot (`sessionId: !!js
  process.env.DSH_TUI_RESUME_SESSION ?? undefined`) and the TUI resumes the
  session. Passing a bare `--resume` (or `-c`/`--continue`) would make the
  launcher (`bin/dsh-tui.js`) overwrite the env from `~/.dsh-tui/resume.txt` —
  that is the "resume last session" path; the two do not interfere (verified
  in the launcher source). CLI users can also use `dsh-tui --resume <id>` or
  `--resume=<id>` (since 0.7.0) to resume a specific session — same effect as
  the extension's env channel.
- **Sidebar session-history data sources**: session logs under
  `~/.dsh/sessions` (zstd JSONL), the dsh-storage ledger
  (`~/.dsh/storages/session_projcache.json`, the source of the web session
  list's titles), and the TUI's last-used map (`~/.dsh-tui/last-used.json`).
  Title precedence: log `session/title` event → storage-ledger title → first
  user message → "未命名会话"; the full cwd path and session id go into the
  item tooltip. Grouped by project (cwd short name), most recently active
  first; within a group, most recently used first; auto-refresh watches the
  session directories.

## Permissions and security boundary

`dsh-TUI` does not provide a separate sandbox. It implements the tool-level
approval UI (a local panel answering the `approval/request` waterfall), while
`/permission` preset switching comes from the dsh-base `permission-presets` row.

Effective capability comes from the DSH services mounted by
`cordis.patch.yml`:

- On non-Windows platforms, `DSH_PERMISSION_MODE` defaults to `workspace-write`;
  the filesystem policy requires observed files and the approval policy is
  normally `ask`.
- Windows has no usable local sandbox backend in the current composition, so it
  uses `danger-full-access` and `never` approval to match the terminal trust
  model.
- `DEEPSEEK_API_KEY` should come from the environment or controlled runtime
  injection. Status output only reports presence or a redacted fragment.
- MCP, shell, filesystem tools, and custom presets expand what the model can
  access and should be treated as code-execution surfaces in the same policy
  domain.
- `/permission` reads the mounted DSH `permissionPresets` registry in declared
  order.
- Third-party presets appear in the picker, Tab completion and the
  `Shift+Tab` cycle automatically (excluding `custom`/`status`, canonical
  presets, duplicate identities and unsafe tokens).
- The first observation follows registry order, while later refreshes keep
  the relative order of identities already seen.
- `custom` is a current-state projection, never a selectable target.
- While the service snapshot is usable, the TUI owns `/permission` locally.
- Switches PREFER the official `/permission <preset>` command.
- When the command row never reaches this agent's registry
  (composition-dependent), the TUI FALLS BACK to the permissionPresets
  service's own official write path `set(session, preset)` — the same
  handler the command drives.
- It writes real `permission/preset`/`sandbox/mode`/`approval/policy`
  events (never fabricated by the TUI) and confirms via event/readback.
- When neither path exists, it fails loudly with a toast + log instead of
  sending the input to the model.
- Exiting plan mode restores the pre-plan atoms first, then the durable
  preset identity from before plan mode (while the registry offers it).
- The TUI distinguishes `runtime`, `legacy`, and `unavailable`: the legacy
  three-row roster is used only when the service is truly absent.
- A mounted service that is empty, inconsistent, broken, or unsafe fails
  closed instead of inferring identity from sandbox/approval knobs.
- The adapter reads the real service contract — `current(session)` through
  the session-projection seam — with a compatibility fallback for the older
  event-log shape.

Inspect the active profile patch before running in an untrusted repository; the
visual TUI alone does not describe the effective policy.

## Known limitations

- Plugin-source context injected into the system prompt is not shown as a
  separate UI segment; it is included in the system/context meter.
- `/model` switches through a session fork rather than an in-place update; the
  old session remains in `/resume`.
- `Ctrl+V` clipboard reads dispatch per platform:
  - Windows: PowerShell `Get-Clipboard` (a competing process can lock the
    clipboard and make the read appear empty after retries).
  - macOS: `osascript`/`pbpaste`.
  - Linux/Unix: the first usable of `wl-paste`/`xclip`/`xsel` (missing tools
    are skipped, an unreachable session falls through to the next candidate,
    and paste reports no usable clipboard tool when all fail).
- Supported clipboard bitmaps are exported through a 0600 temporary file in
  a 0700 private directory, stored in the Harness attachment library, and
  shown as `[Image #N]`; the temporary export is then deleted, so the prompt
  contains neither a path nor base64.
- Unsupported bitmap formats warn and delete the export.
- An unavailable attachment service leaves the bitmap out of the draft.
- Image files copied from a file manager can still fall back to an `@`
  reference when staging fails.
- Exit restores the terminal and ends the process without waiting for the
  Agent's asynchronous flush; the persistence plugin is the fallback.
- **Background sessions live inside this process**: they stop when the TUI
  exits; state and summaries come from the session's own output with no extra
  summary-model calls; worktree isolation is not provided yet.
- The tool-level approval panel is implemented (approval service + TUI
  answerer); `/permission` preset switching is provided by the dsh-base
  `permission-presets` plugin and works in profile compositions.
- When that registry service is absent, TUI uses its legacy three-row
  compatibility roster; a malformed mounted service is unavailable and
  fails closed.
- If the external `/permission` command is not registered, input follows
  the existing default/model dispatch behavior.
- `/vim`, `/connect`, and `/hooks` are compatibility placeholders,
  not evidence that those DSH capabilities are mounted.
- There is no automated full-flow suite that requires real model
  credentials; CI uses headless rendering and fake services.
- This L4 batch has **not** manually exercised a real TTY in inline/fullscreen
  mode, at narrow width, or on Windows ConPTY; live model integration still
  needs a target-terminal check. Full RFC state (L5) is deferred from this batch.
- L4 has completed one independent local review and targeted fixes. Final
  compile, build/package gates, all 58 channel-ui checks, and the three CI
  renderer regressions passed; this is not real-TTY or long-term memory stress evidence.

## Debugging and verification

| Goal | Method |
| --- | --- |
| Environment and profile | Run `/doctor`, `/config`, and `/permission status` inside the TUI |
| stderr diagnostics | `DSH_TUI_DEBUG=1 dsh --profile dsh-tui` |
| Raw ANSI frames | `DSH_TUI_RENDER_LOG=/path/to/render.log dsh --profile dsh-tui` |
| Theme regression | `node --import tsx/esm scripts/verify-themes.mjs` |

`DSH_TUI_RENDER_LOG` and session exports may contain sensitive content. Redact
them before sharing.

## Image rendering budgets

User-facing actions — open/close the preview, zoom, pan, switching, and open
original — are documented in [Interaction and commands](interaction.en.md#image-preview-card).
This section records the internal rendering budgets and behaviour.

### Preview card

- Look-alike text typed by hand or restored from history without an attachment
  capability stays ordinary text.
- In fullscreen, the shared preview centers over the transcript area and targets
  about 95% of its width and height while preserving the image aspect ratio.
- While the preview is open, the conversation outside the card fades:
  - Explicit foreground and background colours (pixel art, tool cards, syntax
    highlighting) blend halfway toward the terminal background (from OSC 11;
    black or white by theme lightness when unknown).
  - Uncoloured text takes the terminal's faint attribute.
- The card, the prompt and the status rows are not touched, and closing restores
  everything.
- The card's title sits centered in its top border as
  `Image #N — format · width×height · size · file name`.
- The card is at least as wide as the title, so a small image never squeezes the
  file name; a title wider than the transcript area shortens the file name in its
  middle first.
- Images staged from a file or the clipboard in this session show their source
  path on the card's bottom row (`Open original: …`, head and tail kept, middle
  elided); historical images use their file name.
- "Open original" opens the unchanged attachment bytes in the system image viewer,
  independent of deleted or modified source paths.
- Only an explicit click exports a file to a private `dsh-tui-original-*` system
  temporary directory; it survives TUI exit for the external viewer and can later
  be removed with system temporary-file cleanup.
- A stale `[Image #N]` placeholder (evicted past 128 staged images or cleared by a
  session switch) warns on click, on submit, and when it appears as a
  slash-command argument.

### Thumbnails and decode

- After submission, user images are re-projected from durable session events into
  the transcript. Assistant messages and tool results use the same preview path
  whenever their content contains image blocks.
- Fullscreen sessions with a successful Kitty graphics or Sixel probe show
  bounded, aspect-preserving thumbnails.
- Inline, accessibility, multiplexer, and read-failure paths reserve the same
  layout with a text fallback.
- Visible attachments are read and decoded only when graphics are available;
  other paths use metadata without loading the decoder.
- Resumed sessions do not depend on the original local path.
- Sixel thumbnails are cropped to the visible transcript while scrolling, without
  squeezing the whole image into the remaining rows or painting over the prompt.
- Opening a full preview withdraws background thumbnails; closing it restores
  them from cache.
- Unrelated text updates do not retransmit unchanged images.
- Decode and transport concurrency, queues and byte budgets are bounded, with
  text fallback on overflow or failure.

### Pixel and memory budgets

- Large previews allow a 2048-pixel edge with at most 2,097,152 pixels
  (8 MiB RGBA), so square previews are smaller than 2048 by 2048.
- Thumbnails still decode at 384; ordinary plugin images remain at 1024 / 4 MiB,
  frames at 16 MiB, and Sixel output at 4 MiB.
- Cropping precedes nearest-neighbor zoom; budget limits reduce the viewport
  instead of scaling original pixels.
- Pan bursts coalesce and stale results are discarded.
- Each inspection retains one encoded original (up to 64 MiB), with a
  64-megapixel input limit and no full-size JS RGBA cache.
- Some formats still require scanning the original file.
- Sixel retains its 256-color quantization: 100% describes spatial pixels, not
  lossless color.
- Keyboard ownership and Escape remain unchanged.

### Modal gallery

- Transcript galleries follow conversation message order and never prefetch
  unvisited images.
- Draft galleries follow capability-backed token order; clicking gallery
  navigation promotes the caret peek to a modal without editing the draft.
- A plain caret peek still leaves arrows with the input.
- Stale image jobs cancel.
