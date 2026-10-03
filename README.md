<p align="center">
  <img src="docs/assets/readme/logo-en.svg" alt="dsh-TUI animated whale logo" width="560">
</p>

<p align="center">
  <strong>English</strong> | <a href="README_ZH.md">简体中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui"><img alt="npm" src="https://img.shields.io/npm/v/@deepseek-harness-tui/dsh-tui?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/ccch1mneyyy/dsh-TUI/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ccch1mneyyy/dsh-TUI/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="Public beta" src="https://img.shields.io/badge/status-public%20beta-7da1de?style=flat-square">
  <a href="https://github.com/ccch1mneyyy/dsh-TUI/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/ccch1mneyyy/dsh-TUI?style=flat-square&color=4b6fff"></a>
  <a href="https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@deepseek-harness-tui/dsh-tui?style=flat-square&color=4b6fff"></a>
</p>

# dsh-TUI

> An interactive terminal UI plugin for DeepSeek Harness. It ships a
> pixel-whale header, live work status, streaming thinking, double-Esc time
> rewind, a context progress bar, and a TPS gauge. It mounts as a pure plugin,
> with no core changes. Install to enable; uninstall leaves no patches behind.

## Highlights

- **Pixel whale pet** — three startup intros, click to wake; freezes after the first task.
- **Launchpad and first-run guide** — every launch lands on a landing page with a **real input box** (big text + whale + quick actions, dropping whole blocks on short/narrow terminals); the first run walks a four-step wizard (API key / language+theme / model+workspace / shortcuts), re-runnable with `/setup`.
- **Terminal-native UI** — streaming Markdown, tool cards, `/` and `@` completion, `#L12-14` ranges, history search, zh/en UI.
- **Images** — Kitty/Sixel thumbnails, centered preview with zoom and pan, paste-time fitting, text fallback.
- **Mermaid diagrams** — ````mermaid ```` fences drawn as Unicode diagrams.
- **LaTeX math** — `$…$` and `$$…$$` formulas as Unicode text, fractions and limits stacked in display blocks; `mathRendering: image` typesets block and one-row inline formulas as terminal images on graphics terminals.
- **Timeline rail** — every turn clickable; timeline / scrollbar / hidden gutter.
- **Side panel** — `Ctrl+B` splits the chat with a panel column (todo / jobs) once the terminal is wide enough; narrow terminals and inline mode keep today's full-screen panels.
- **Live state** — activity animation, context bar, TPS, cache hit rate, effort, tokens, session cost estimate (main + subagents), Git and session metadata.
- **One session manager** — `/resume` `/home` `/agentview` `/bg` `⌸`.
- **Session workflow** — `/new` `/compact` `/export` `/btw`, model hot-switch, fork, rewind, vim, fullscreen draft editor.
- **IDE selection channel** — a VS Code selection lands in the prompt.
- **DSH integrations** — presets, skills, MCP, goals, todos, subagents, questionnaires.
- **Account sign-in** — the standard profile offers pi-ai OAuth for ChatGPT/Codex, Claude, and Grok (plus OpenAI direct and Meta Muse when available), and Host-owned DeepSeek browser sign-in as `deepseek-account` on DSH 0.2.0-rc.1+. Use `/provider` or `/auth` without another plugin.
  A profile-only update from a global TUI patch that already mounts `dsh-tui-auth` can still start the official loopback callback listener on demand; fixed-port SSH forwarding still requires the global package to be aligned.
- **Extensions** — browser interaction, computer use and more.
- **Built for long sessions** — event-driven projection, virtualization, bounded caches.

Keys and commands: [Interaction and commands](docs/interaction.en.md). Everything else: [documentation index](docs/README.md).

## Preview

<div align="center">
  <picture>
    <source media="(max-width: 640px)" srcset="docs/assets/readme/preview-en-mobile.svg">
    <img src="docs/assets/readme/preview-en.svg" alt="Recorded dsh-TUI session: welcome, completion, help and typing, with animated pixel whale." width="78%">
  </picture>
</div>

## Featured & Listed

Among the community plugins recommended by the **official lead of DeepSeek
Harness**, dsh-TUI is the first.

Featured by the **DeepSeek Harness official WeChat account**, listed in the
[dshfind](https://dshfind.com/en/plugins/ccch1mneyyy/dsh-TUI) plugin
directory, and ranked **#7 on [GitHub Trending](https://trendshift.io/repositories/146168)
daily** (TypeScript).

<div align="center">
  <table>
    <tr>
      <td align="center" valign="middle" width="50%">
        <img src="screenshots/wechat-official.png" alt="dsh-TUI featured by the DeepSeek Harness official WeChat account" width="480">
        <br>
        <strong>Featured by the official WeChat account</strong>
      </td>
      <td align="center" valign="middle" width="50%">
        <a href="https://dshfind.com/en/plugins/ccch1mneyyy/dsh-TUI"><img src="https://dshfind.com/api/card/ccch1mneyyy/dsh-TUI?lang=en" alt="dsh-TUI on dshfind" width="420"></a>
        <br>
        <strong>Listed in the dshfind directory</strong>
        <br><br>
        <a href="https://trendshift.io/repositories/146168" title="GitHub Trending Daily #7 · TypeScript"><img alt="Trendshift" src="https://trendshift.io/api/badge/trendshift/repositories/146168/daily?language=TypeScript"></a>
        <br>
        <strong>GitHub Trending Daily #7</strong>
      </td>
    </tr>
  </table>
</div>

## Quick Start

Prerequisites: [Node.js](https://nodejs.org/en) and
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
The `deepseek-official` API-key route needs `DEEPSEEK_API_KEY`. On DSH
0.2.0-rc.1+, the standard profile can instead use `/auth login deepseek-account`
and select the separate account route through `/model`. Other supported
accounts can sign in through `/provider` or `/auth` after startup.

The primary compatibility target is DSH `0.2.0-rc.2`. This adapter supports its
Shell API, V4 session messages, declarative presets, and profile-backed settings;
older supported hosts retain their compatibility paths. See [configuration](docs/configuration.en.md).

On DSH 0.1.7, `/settings` uses the TUI's actual Loader entry ID, including custom
IDs. It requires matching profile dependencies with `@deepseek-ai/schemastery`
3.18.3 or newer; an incompatible schema stops TUI startup with repair guidance
instead of showing an uneditable settings page. Older hosts keep their legacy settings scope.

```sh
# Install the CLI and this plugin globally (ships the dsh-tui command)
npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui

# Start (first run auto-initializes the profile; needs pnpm)
dsh-tui
# Both `dsh-tui` and the short `dst` alias start the same TUI.
dst
```

Manual alternative: `dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui`.
The repo's `sh install.sh` runs that step and checks the required commands.
Afterwards `dsh-tui` and `dsh --profile dsh-tui` are equivalent.

> **New-user note**: pnpm ≥11 blocks dependencies with install scripts by
> default and reports `ERR_PNPM_IGNORED_BUILDS`. Updates skip foreign-platform
> `@img/sharp-*` native packages, saving about 200MB of downloads. `/update`
> and `dsh-tui update` write both settings automatically. No manual step
> needed. Details:
> [Getting started](docs/getting-started.en.md#pnpm-install-script-blocks-and-foreign-platform-natives).

After startup the TUI checks for newer versions in the background. It never
blocks the first frame. Type `/update` for a one-shot upgrade. It restarts
automatically and resumes the current session. See
[Getting started](docs/getting-started.en.md) for the profile lifecycle,
source builds, and troubleshooting, including migration from the former
`dsh-cc-tui` package.

### CLI

| Command | Purpose |
| --- | --- |
| `dsh-tui` / `dst` | Start the TUI; `dst` is a short alias for the same program |
| `dsh-tui --resume [id]` · `dsh-tui update` · `dsh-tui doctor` | Resume a session · update the profile and align the launcher · pre-flight environment checks |
| `dsh-tui safe` | Read-only diagnostics, plugin inventory and repair guidance; `safe --rescue` builds a clean rescue profile |
| `dsh-tui version` · `dsh-tui help` | Launcher and profile versions and usage; both work even without a `dsh` install |

Leading DSH options such as `--dump-config` and `--patch <path>` are forwarded
unchanged; other arguments go to the app in `dsh --profile dsh-tui`. Use
`dsh-tui -- --resume=sid-1 ./notes` to send `--resume=sid-1 ./notes` as literal
prompt text, without selecting a session or workspace. When invoking DSH
directly, use `dsh --profile dsh-tui -- -- --resume=sid-1 ./notes`: the first
`--` belongs to DSH, the second to the app. Host options can precede a literal
prompt: `dsh-tui --patch ./overlay.yml -- --resume=sid-1` applies the overlay
and sends `--resume=sid-1` as prompt text without resuming that session.
Safe mode: [Getting started](docs/getting-started.en.md).

### Importing conversations from other agents (`dsh-tui migrate`)

Bring Claude Code, Codex, OMP, zcode, or Grok Build conversation histories into the DSH session store, then browse and resume them by their original working directory via `/resume`:

```sh
dsh-tui migrate                # list importable counts per agent (writes nothing)
dsh-tui migrate claude-code    # import every Claude Code conversation (likewise codex / omp / zcode / grok-build)
dsh-tui migrate codex --dry-run  # preview what would land, write nothing
```

- **Read-only source**: migration only reads the foreign agent's local store; artifacts are written through the official `JsonlSessionPersistence` backend, so imported sessions are first-class (openable, continuable).
- **Idempotent**: one deterministic UUID per source conversation — re-importing skips what is already present instead of stacking duplicates.
- **Structure preserved**: user/assistant messages, reasoning traces, tool calls with their results, and the source's context compactions (as native compaction checkpoints) are rebuilt turn by turn; harness-injected machine text opens no turn. An imported session can pick the work straight up.
In-TUI browsing: the session screen (`/resume`) shows a tab per agent that has conversations; picking one imports just that conversation and opens it.
In-TUI: `/migrate` (optionally `/migrate <agent> [--dry-run]`) runs the same import in a child process and reports through the notification flow.
CLI alternative: `dsh-tui migrate ...` from any shell runs the same import.
Full guide: [Session migration](docs/migrate.en.md).

- More agents (pi, opencode, …) extend the adapter registry as adapters land; grok-build reads `GROK_HOME` when set.

**VS Code**: use the integrated terminal or the `dsh-tui-vscode` extension. See [VS Code guide](docs/vscode.en.md). **Herdr**: run `dsh-tui` in a [Herdr](https://herdr.dev) pane; `idle` / `working` / `blocked` are reported through its local integration API.

### Experimental: Claude backend

dsh-TUI can run its session on the **Claude Agent** backend instead of the
DeepSeek Harness agent: the same TUI, driving your local `claude` CLI through
the Claude Agent SDK.

```sh
# once, in the dsh-tui profile (the SDK is an optional peer dependency)
cd ~/.dsh/profiles/dsh-tui && pnpm add @anthropic-ai/claude-agent-sdk@0.3.287
dsh-tui --backend claude     # or `backend: claude` in the dsh-tui config row
```

- **Credentials**, in this order: your dsh-auth `anthropic` sign-in (the
  same OAuth `/provider` offers; `/login` opens it preselected and reconnects
  the session afterwards — while it is used, `ANTHROPIC_API_KEY` /
  `ANTHROPIC_AUTH_TOKEN` are kept away from the CLI so your explicit sign-in
  wins), else `ANTHROPIC_API_KEY` / cloud-provider variables in your
  environment, else your existing `claude login`. `/login` shows which one the
  session runs on. The dsh-auth sign-in is used **only for Anthropic's own
  API**: when `ANTHROPIC_BASE_URL` (in your environment or a Claude settings
  `env`) points anywhere other than `https://api.anthropic.com`, or a Unix
  socket, a cloud-provider or gateway route, or an `apiKeyHelper`
  is configured, your environment is passed through untouched and `/login`
  names the route instead. A token that expires is refreshed before the CLI
  starts; if the CLI rejects it mid-session, dsh-TUI renews it and resumes the
  same session once, then asks you to `/login` (a `/login` during a running
  turn reconnects after it). Token material is never logged.
- **Executable**: `claude` on `PATH`, else the SDK's bundled binary. Project
  `CLAUDE.md`, settings, hooks, MCP servers and plugins load exactly as the CLI
  loads them.
- **Approvals** use the same panel as DSH: allow once, allow always (the label
  says what the CLI will remember — e.g. auto-accepting edits for this session
  or a permission rule for this project; the CLI stores it, dsh-TUI writes no
  settings file) and reject; with the focus on the reject row (↓ / Tab), type
  a reason to send with the rejection (allow always is never a single digit
  there — move to it and press Enter). Questions from the model (`AskUserQuestion`) use the
  questionnaire, and a plan from plan mode opens the plan review (approve with
  auto-accepted edits, approve with per-edit approval, or keep planning with
  feedback). An MCP server asking for input uses the questionnaire too: one
  question per form field (choices, yes/no, checkboxes, or typed text checked
  against the field — an invalid answer is asked again with the reason), then
  *Send* or *Decline*; a server that needs a browser step shows its link in a
  notice and in the question (clickable where the terminal supports links).
  When the model declines a request and a fallback model is configured, a
  question offers retrying on it. `Esc` cancels any of these.
- **Controls**: `/model` (Claude's own model list, no provider prefix —
  `/model sonnet`; the choice is remembered for new sessions), `/effort`, `Shift+Tab`
  cycles default → accept edits → plan (auto where the model supports it; the
  mode shows in the status line when its `mode` field is on), `/compact`,
  `/context` (Claude's context report), `/mcp` (status; `/mcp reconnect
  <server>` and `/mcp toggle <server> on|off`, server names complete),
  `/doctor` (CLI, SDK, credential and account), and Claude's own slash
  commands in completion (sent to Claude as typed). Hovering the cost field
  shows subscription usage (5h / 7d); approaching or hitting a usage limit,
  API retries, model fallbacks, automatic permission denials, sign-in errors
  and recalled memories show as notices.
- **Also works**: streaming replies, thinking token counts, tool cards (Read,
  Write, Edit, Bash, Glob, Grep, web and MCP tools), Ctrl+C cancel, `/new`
  (a `/new` that a message overtakes while the new session is still starting
  is cancelled, the message stays in the current session), `/status`, `/cost`
  (the backend-reported USD cost), `/export` (the transcript as shown),
  `!cmd` / `!!cmd`, the IDE selection channel and the git branch in the
  status line. `/rename` names the session (the title Claude's own session
  list shows), `/color` keeps an accent per Claude session (stored by
  dsh-TUI).
- **`/btw` and `/recap`** ask one side question over the conversation through
  a throwaway copy of it (no tools, one turn, nothing written to the
  session's transcript) — each is one model call; the automatic recap when a
  session opens stays off for Claude so opening a session never costs
  anything.
- **Images**: paste an image or `@`-mention an image file (PNG, JPEG, GIF,
  WebP; resized to at most 2000 px per side, at most 5 MiB each and 20 per
  message) and it is sent with the message; staged images are held in memory
  only. Resumed sessions show the images their prompts carried.
- **`/clear`** clears the view only, as with DSH: Claude keeps its context.
  When Claude itself resets the conversation (leaving plan mode with
  *clear context*), the view, subagents and jobs are cleared with a notice,
  and the session continues under the new session id Claude gives it.
- **Sessions**: `/resume` opens the session browser on your Claude sessions —
  this project's first, then every project (sessions dsh-TUI created are
  listed too, although Claude Code's own picker hides them); Enter resumes
  one (its history is replayed, then the conversation continues), `Ctrl+R`
  renames, `Ctrl+D` deletes (never the open session, never one another
  dsh-TUI terminal is using), pins are kept per backend. From a shell:
  `dsh-tui --backend claude --resume <id>`, or a bare `--resume` for the last
  Claude session this install used (DSH's own `--resume` marker is never
  touched); on exit dsh-TUI prints that command. A session another dsh-TUI
  terminal has open is refused (a concurrent plain `claude --resume` cannot
  be detected), and a `--resume` that cannot open fails instead of starting
  a fresh session. `/fork` writes a copy you can resume later (the open
  session is untouched). Double-`Esc` rewinds to an earlier prompt: the
  conversation (continuing in a copy cut just before it, the prompt back in
  the input), the files Claude edited since (restored from Claude's file
  checkpoints, previewed before you confirm), or both. The status line's
  short session id is the Claude session id `--resume` takes, and a resumed
  session shows its context window before its first reply.
- **Subagents**: each `Agent` delegation is a subagent card in the transcript
  (its own text, tool calls and token count stream into the card, never into
  the main conversation); `/agents` lists them, `Ctrl+A` opens the subagent
  dashboard and its detail view, where a running one can be stopped. A
  resumed session shows its subagents with their recorded output; one whose
  end the transcript never recorded shows as *status unknown*.
- **Background jobs**: a command Claude runs in the background (`Bash` with
  `run_in_background`, or a running command moved to the background) is a job
  card with the status-line chip, `/jobs` lists them (`k` twice stops one);
  the card and the panel show the tail of the job's output file while they
  are on screen (read-only, the last 64 KiB, at most once a second, only the
  file Claude itself reported). Interrupting a turn never stops a job;
  a job Claude stops reporting shows as *status unknown*.
- **Older history**: a session resumed after a compaction shows *load earlier*
  at the top; it brings back the conversation the compaction cut off, one
  compaction at a time, read-only from Claude's own transcript file. Long
  sessions fold old rows to keep memory bounded, and *load earlier* restores
  them from the same file.
- **Not yet**: `/tree`, and switching between backends inside one running
  dsh-TUI. DeepSeek-specific commands (`/setup` among them) are hidden while
  this backend is active, and the DSH launch screens (launchpad, first-run
  guide, workspace home) are skipped: a Claude session opens straight into
  its conversation.

## Keybindings & Mouse

`Enter` send · `Tab` complete · `Ctrl+Enter` interrupt and send · `Alt+Up` recall the last message · `Esc` dismiss, double-`Esc` rewinds · `Ctrl+B` side panel · `Ctrl+O` details · `Ctrl+R` history (`↑`/`↓` and `Ctrl+R` are scoped to the current project) · `Ctrl+V` paste · `Ctrl+Shift+E` fullscreen draft editor · `?` shortcuts · `←` background the session.

While the model is working: `Enter` steers, `Tab` queues a follow-up, `Ctrl+Enter` interrupts and sends.

On native Windows, fragmented Win32 input records are reassembled across short input delays instead of appearing as numeric protocol text. The platform check only reports that this machine might run the private mode (win32-input-mode); a bare `ESC[` fragment is held only after one record has actually been decoded, while a fragment whose own shape is already record-specific holds on its own (which is how even the first record can survive a split). Windows terminals that never enter the mode (mintty, GitBash) therefore keep the classic VT path: a lone `Esc` keeps its normal response time, and a letter typed after a timed-out `ESC[` is not swallowed.

Incomplete records are held for a bounded recovery window (1 second from first capture, never extended by later input; 64 bytes max); past either bound the hold ends and input is handled as before. Unrecognized complete CSI sequences are not inserted as text; after a damaged CSI prefix, a bare ASCII letter can be consumed as its terminator, while normal Win32 key records and bracketed-paste text retain their own boundaries.

A session's very first record can still leave residue if it is split before its record-specific shape forms; once any record has been decoded, every split position is covered. Inside the recovery window, literal input starting with `[digit;…` cannot be told apart from a protocol prefix — it may be held, or re-joined to a preceding `Esc`. To type it, wait for the window to close, or avoid that shape right after `Esc`.

Terminal replies that arrive split are reassembled the same way (native Windows ConPTY is the common source): while the app still has a query awaiting its answer, an unfinished DA1 / DA2 / DSR / DECRPM / XTVERSION tail — even one split again after the introducer `Esc` was flushed — is held across input delays, but only while its shape can still complete into the response type that query expects. It is then consumed as the reply it completes instead of entering the prompt as protocol text.

That claim is evidence-gated, and this is the difference from earlier builds: no query awaiting an answer means nothing is claimed, so a literal `[?61;4c` typed right after `Esc` still enters the prompt exactly as before.

The window is bounded like the record hold (about a second, never extended by later input; 64 bytes max); past either bound it ends, and bytes still shaped like an unfinished reply prefix are dropped rather than shown.

Inside that window, with a query of the matching response type outstanding, same-shaped literal input can still be claimed as a reply; to type it, wait for the window to close (about a second), or avoid that shape while a query is outstanding.

Fragmented SGR mouse reports no longer land in the prompt as text: an incomplete report header is held until the rest arrives, and a report that completes is handled as a mouse event. The hold is armed only while mouse reporting is actually active (fullscreen, with mouse tracking enabled); inline sessions and terminals that never enable tracking keep the existing behavior. The claim window is bounded from first capture (at most 1 second; 64 bytes max), and a continuation arriving inside it is still claimed rather than replayed. Release has no timer: once a parse call sees either bound exceeded, it replays the held bytes as ordinary keys in arrival order — literal input can be delayed, but is never dropped.

Mouse (fullscreen): drag to select and copy, double/triple click to select a word or line, click tool cards, timeline ticks and `[Image #N]` previews.

File paths in prose can open the file-action menu; automatic detection does not extract a path from inside a slash-delimited token such as `working/idle/needs-input` or a date such as `2024/01/15`.

**Pasting**: native and bracketed paste keeps ordinary text and newlines, and never submits itself on arrival. On Windows terminals that deliver a paste as win32-input-mode key records, the residue is stripped at the entry point (a multi-line paste no longer leaves stray `_`) and pasted CRLF collapses to a single newline; genuine underscores and bracketed-paste text are untouched.

**Dropped files**: a native Windows desktop drop (Windows Terminal / OpenConsole) arrives as an OSC 8 hyperlink; the parser restores its `file://` URI to a decoded local path before paste hygiene runs, so the `]8;id=…;` parameter bytes never reach the draft. Image paths enter the existing image staging pipeline; other files are inserted as a referenceable path (a path containing whitespace arrives in the composer's quoted `"…"` single-token form). Only `file://` URIs are restored, and it is fail-closed: a remote authority/UNC, a payload carrying several distinct URIs, or a URI that carries several tokens is refused and stays literal text rather than guessed.

Full reference: [Interaction and commands](docs/interaction.en.md).

## Built-in Commands

`/resume` · `/home` · `/agentview` · `/bg` · `⌸` open the same session manager: workspace rail, live state, filter, ★ pins. Also `/model` `/new` `/compact` `/export` `/btw` `/tree` `/fork` `/rewind` `/settings` `/setup` `/status` `/cost` `/jobs` `/skills` `/mcp` `/provider` `/auth` `/login` `/update`.

The session manager paints the last successful list immediately while it checks the persistence store for changes. Titles that require a deeper log scan appear first with a fallback name and update in place when recovery finishes.
Removing a workspace registration keeps its sessions accessible under a "History only" directory in the rail.
History-only directories offer edit and new-session actions; rename and remove are available for registered workspaces.

**Background sessions**: `/bg` or `←` on an empty prompt; `Esc` returns. They run in this process and stop when the TUI exits. Logs survive.

Full commands: [Interaction and commands](docs/interaction.en.md).

## Configuration & Extensions

Agent presets, themes, MCP servers, environment variables: [Configuration](docs/configuration.en.md) · [Themes](docs/themes.en.md).

## How It Works

```text
dsh profile → dsh-base → dsh-TUI Cordis patch → agent preset + DSH services
  → session/event → Channel projection → React components → Ink/Yoga renderer → terminal
```

The TUI handles interaction and presentation. The session log is the source of truth. DSH services own models, tools, and persistence. Long sessions render in O(visible window).

Runtime path, module boundaries, performance notes and persistence locations: [Architecture and limitations](docs/architecture.en.md).

## Known Limitations

- Injected plugin context has no standalone display; it counts into the context segments.
- `/model` switches by forking the session; the old session stays in `/resume` (a session nobody has typed into records no branch, so your first prompt there still gets a generated title).
- `Ctrl+V` needs platform clipboard tools; unsupported bitmap formats are rejected.
- A dropped file is restored from its OSC 8 `file://` URI alone: multi-file drops, non-Windows terminal drop encodings and terminator-less truncated frames are not covered, and the hyperlink's own display name is never used.
- A background session lives inside this process and stops when the TUI exits.
- `/thinking` is not persisted; the kernel `minimal` agent preset (极简模式, one persistent-shell tool) mounts no compaction and does not prune tool results — a long session can hit the context limit, oversized tool output stays in the context in full, and `/compact` plus the questionnaire are unavailable under it (Help and `/` completion mark the entry, and entering the preset says so once); that is a different thing from the `/settings → Minimal UI` (极简界面) display switch; `/update` needs a `dsh --profile` launch and is refused while a turn is running.
- The status-bar `≈¥` and `/cost` are session estimates that include subagent usage (priced per each agent's model × peak/idle × cache components); unofficial or unlisted models show tokens only and are marked unpriced. **The platform bill is authoritative.**
- Fragmented SGR mouse reports are covered at the mechanism level with controlled fixture comparisons; the reporter environments (macOS → SSH, WSL2 with `dsh web`) have not been re-tested.

Full list: [Architecture and limitations → Known limitations](docs/architecture.en.md#known-limitations).

## Development

CI uses Node 24 and pnpm 11. The package supports Node `^22.19 || >=24`.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm smoke
```

`lib/types/` is ignored generated output. `pnpm build` recompiles it from a
clean output directory and runs the build gates. **Git URL installs are not
supported.** The source manifest keeps `@dsh-std/*` as workspace deps and
`vendor/dsh-std` as a submodule. pnpm ≥11 also refuses git-hosted `prepare`
scripts by default. Install the registry package instead:
`dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui`. Rendering,
questionnaire, or tool-card changes also need the matching regression scripts.

## Plugin Ecosystem

Plugin development: [admission & development guide](tui-profile/docs/plugin-admission-and-development.md) · [plugin-template](https://github.com/dsh-tui-ecosystem/plugin-template) · [dsh-tui-ecosystem](https://github.com/dsh-tui-ecosystem). Reference implementation: `dsh-working-activity`.

Seam grading and API notes: [Plugin development](docs/plugins.en.md). The organization maintains the listing only; it does not endorse community plugins.

## Documentation

- **Start** — [Getting started](docs/getting-started.en.md) · [VS Code](docs/vscode.en.md)
- **Use** — [Keys and commands](docs/interaction.en.md) · [User guide](docs/user-guide.en.md) · [Themes](docs/themes.en.md)
- **Configure** — [Configuration](docs/configuration.en.md)
- **Internals** — [Architecture and limitations](docs/architecture.en.md) · [Session mounting](docs/session-mount-runtime.en.md)
- **Plugins** — [Admission and development](tui-profile/docs/plugin-admission-and-development.md) · [Seams](docs/plugins.en.md)
- **Contribute** — [Contributing](docs/contributing.en.md) · [Roadmap](docs/roadmap.en.md) · [Community](docs/community-management.en.md)

Everything, bilingual: [docs/README.md](docs/README.md).

## Community

- **Ecosystem organization**: [dsh-tui-ecosystem](https://github.com/dsh-tui-ecosystem)
  hosts community plugins, templates, and the curated list. Come ship a
  plugin, pitch an idea, or just hang out 🐋
- **Chat groups** (Chinese-language): usage questions, plugin ideas, and
  feature wishes are all welcome.
- **Code of conduct**: please read the
  [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.en.md) before taking
  part.

| WeChat group (dsh-TUI community 4) | QQ group (ID 572549239) |
| :---: | :---: |
| <img src="screenshots/wechat-group.jpg" alt="dsh-TUI community WeChat group 4 QR code" width="200"> | <img src="screenshots/qq-group.png" alt="dsh-TUI community QQ group QR code" width="200"> |

> The WeChat QR code expires roughly every 7 days; if it stops working, use
> the QQ group (572549239) or open an issue to nudge us for a refresh.

## Permissions and Security Boundary

> **Windows security warning:** the Windows profile defaults to `danger-full-access` with approval set to `never`, so tools have unrestricted access. Inspect and tighten the profile before starting next to sensitive credentials or in an untrusted repository.

No sandbox of its own: dsh-TUI uses the active DSH profile's filesystem, shell, sandbox and approval policies. Permission presets come from the DSH `permissionPresets` registry.

Details: [Permissions and security boundary](docs/architecture.en.md#permissions-and-security-boundary).

## Acknowledgments

- The pixel whale's 22 hand-drawn frames and its idle behaviors are ported
  from **[dsh-ui-whale](https://github.com/lhh010/dsh-ui-whale)**. The frames
  were drawn cell by cell in Excel. The idle behaviors are fin flutters, tail
  thumps, sleep Z's, and click hearts. dsh-ui-whale is the DeepSeek Harness
  web whale-pet plugin by [@lhh010](https://github.com/lhh010), BSD-3-Clause.
  Thank you for the art and the inspiration 🐋💜

## Friends' Links

Community, related projects, and companion tools built by friends:
[see the links page](docs/links.md)

## Stars

[![Star History](https://raw.githubusercontent.com/ccch1mneyyy/dsh-TUI/bot-star-history/assets/star-history/star-history.png)](https://star-history.com/#ccch1mneyyy/dsh-TUI&Date)

## License

[MIT](LICENSE)
