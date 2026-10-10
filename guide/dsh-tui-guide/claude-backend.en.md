# Claude backend (experimental)

[Documentation index](README.md) · [中文](claude-backend.md)

dsh-TUI can run its session on the Claude Agent backend instead of the DeepSeek
Harness agent: the same interface, driving the Claude Code CLI through the Claude
Agent SDK. Your project's `CLAUDE.md`, settings, hooks, MCP servers and plugins
load the way the CLI loads them. The backend is still experimental; the
implementation is described in [Agent backends](agent-backend-design.md)
(Chinese).

## Enabling it

You need:

- The Claude Agent SDK. It is an optional dependency and is not installed by
  default. The easiest install: open the kernel picker (the launchpad "Kernel"
  entry or `/kernel`) and press Enter on the dim Claude row — the wizard
  locates the profile directory and installs the pinned SDK via pnpm; the row
  lights up when it finishes (standalone builds and profile-less launches get
  manual instructions). Before installing, the wizard pins the profile's pnpm
  store to a stable path (storeDir: ../../.pnpm-store, written into
  pnpm-workspace.yaml), so store drift caused by environment overrides (a
  sandbox or relay that redirected XDG_DATA_HOME, and the like) cannot recur;
  if the drift predates the install, the installer rebuilds the dependencies
  automatically and retries — no manual cleanup needed. The manual equivalent,
  run once in the dsh-tui profile
  directory (`~/.dsh/profiles/dsh-tui`, or `$DSH_HOME/profiles/dsh-tui` when
  `DSH_HOME` is set):

  ```sh
  cd ~/.dsh/profiles/dsh-tui && pnpm add @anthropic-ai/claude-agent-sdk@0.3.287
  ```

- A Claude credential; see "Signing in" below.
- The `claude` command is optional: a working `claude` on `PATH` is used (same
  version and session store as the CLI you already use), otherwise the SDK's
  bundled binary.

To pick the backend, use any of:

- The launchpad's Kernel entry, the kernel block in its bottom-right corner, or
  `/kernel` inside a session, which open the kernel picker. Picking the other
  kernel remembers the choice (`~/.dsh-tui/kernel.json`) and restarts dsh-TUI
  into a new session on it; the old session stays in `/resume`. A running turn
  blocks the switch. Without the SDK or a credential the picker marks Claude as
  *Not installed* or *Not signed in*.
- `dsh-tui --backend claude` (this launch only).
- `backend: claude` in the dsh-tui config row.

An explicit `--backend` or config value wins over the picker's remembered choice.

## Signing in

Credentials are used in this order; `/login` shows which one the session runs on:

1. The active channel in `/channel` (see
   [Channel profiles](interaction.en.md#channel-profiles-channel-claude-only)).
2. Your dsh-auth `anthropic` sign-in, the same OAuth `/provider` offers. `/login`
   in a Claude session opens it directly and reconnects the session afterwards
   (after the running turn, if there is one). While it is used,
   `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from your environment are kept
   away from the CLI so an old key cannot override the sign-in you just made.
3. `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` or cloud-provider routing
   variables in your environment.
4. Your existing `claude login`.

The subscription sign-in is used only for Anthropic's own API. When
`ANTHROPIC_BASE_URL` (in your environment or a Claude settings `env`) points
anywhere other than `https://api.anthropic.com`, or a Unix socket, a cloud
provider or gateway route, or an `apiKeyHelper` is configured, dsh-TUI does not
use the subscription token, passes your environment through untouched, and
`/login` names the route instead. A token about to expire is refreshed before
the CLI starts; if the CLI rejects it mid-session, dsh-TUI refreshes it and
reconnects the same session once, then asks you to `/login`. Token material is
never logged.

## Compared with the DSH backend

Works the same as on DSH: streaming replies, thinking (a token count only when the
model sends no thinking text), tool cards, `Ctrl+C` cancel, queued messages and
holding the queue on `Esc`, `/new`, `/status`, `/export`, `!cmd` / `!!cmd`, the IDE selection,
the git branch in the status line, `/clear` (clears the view only; Claude keeps
its context).

Works, served by Claude:

| Feature | Notes |
| --- | --- |
| `/model` | Claude's own model list, no provider prefix (`/model sonnet`); the choice is remembered for later sessions |
| `/effort` | The levels the current model declares; none for a model without effort support |
| `/permission`, `Shift+Tab` | Claude's permission modes, see below |
| `/compact`, `/context` | Claude's compaction and context report |
| `/mcp` | Server status; `/mcp reconnect <server>` and `/mcp toggle <server> on\|off`, server names complete |
| `/cost`, status-line cost | The USD cost Claude reports; hover the cost field for subscription usage (5h / 7d) |
| `/doctor` | CLI path and version, SDK version, start permission mode, credential and account |
| `/rename`, `/color` | The title goes into Claude's session list; the accent is stored per session by dsh-TUI |
| `/btw`, `/recap` | One question over a throwaway copy of the conversation (no tools, one turn, nothing written to the transcript), one model call each; no automatic recap when a session opens |
| Claude's own slash commands | Listed in completion and sent to Claude as typed; where a name matches a dsh-TUI built-in, the built-in wins |
| `/channel` | Claude only: model names and connection of a relay channel, see [Channel profiles](interaction.en.md#channel-profiles-channel-claude-only) |

`/init` delegates to Claude's native initialization command. `/logout` only removes the Anthropic login stored by dsh-auth; it does not invoke native Claude logout. A running child may retain the managed token until a normal restart.

Not available (hidden from completion; typing one shows a notice and nothing is
sent to the model): `/tree`, `/agentview`, `/bg`, `/home`, `/workspace`,
`/preset`, `/provider`, `/balance`, `/config`, `/reload`,
`/setup`, `/migrate`, `/skills`, `/plugins`, `/hooks`, `/add-dir`,
`/goal` (Claude has no goal capability). Other commands the DSH composition
registers (such as `/plan`) do not appear either.

Startup still lands on the launchpad; the first-run guide and the workspace home
are DSH-only. A launch with a resume target goes straight into the session.

## Approvals and questions

- Tool approvals use the same panel as DSH: allow once, allow always, reject.
  *Allow always* appears only when the CLI suggests a rule, and its label says
  what the CLI will remember (for example auto-accepting edits for this session,
  or a permission rule for this project); the CLI stores it, dsh-TUI writes no
  settings file. With the focus on the reject row (`↓` / `Tab`) you can type a
  reason to send with the rejection; *allow always* then has no digit shortcut,
  so move to it and press `Enter`.
- Questions from the model (`AskUserQuestion`) use the questionnaire. A plan from
  plan mode opens the plan review: approve with auto-accepted edits, approve with
  per-edit approval, or keep planning with feedback.
- An MCP server asking for input uses the questionnaire too: one question per
  form field, checked against the field (an invalid answer is asked again with the
  reason), then *Send* or *Decline*. A server that needs a browser step shows its
  link.
- When the model declines a request and a fallback model is configured, a
  question offers retrying on it.
- `Esc` cancels any of these.

## Permission modes

`/permission` lists Claude's modes: `default` (ask each time), `acceptEdits`
(auto-accept edits), `plan` (read-only planning), `bypassPermissions` (skip every
check), plus `auto` where the model supports it. `Shift+Tab` cycles default →
acceptEdits → plan (→ auto) and never reaches `bypassPermissions`; that one can
only be picked explicitly in `/permission`.

The `/permission` pick is remembered (`~/.dsh-tui/backends/claude/prefs.json`) and
the next session starts in it, except `bypassPermissions`: it lasts for the current
session only, a new session says once that it was not carried over, and you turn it
on again with `/permission` when you want it. Start-mode precedence: the
`DSH_TUI_CLAUDE_PERMISSION_MODE` environment variable (the only way to start in
bypass) > the remembered pick > Claude settings > `default`. A
`defaultMode: bypassPermissions` in Claude settings is downgraded to `default` with
a notice, so a cloned repository cannot silently switch off every check.

## Sessions

- `/resume` opens the session browser on your Claude sessions, the current project
  by default, all projects on request. Sessions dsh-TUI created are listed too
  (Claude Code's own `/resume` picker hides them; open them there with
  `claude --resume <id>`). `Enter` resumes (history is replayed, then the
  conversation continues), `Ctrl+R` renames, `Ctrl+D` deletes; the open session and
  one another dsh-TUI terminal is using cannot be deleted. Pins are kept per
  backend.
  Reopening or restarting first paints the last complete list while the SDK refreshes it.
  First-paint snapshots are isolated by Claude configuration directory. Without a snapshot,
  up to 32 recent sessions from the current directory appear first, then the rest of that
  workspace and other workspaces. Other Git worktrees in the same repository stay out of
  the first batch. Failed reads preserve the last complete snapshot.
- From a shell: `dsh-tui --backend claude --resume <id>`; without an id it resumes
  the last Claude session this install used. dsh-TUI prints that command on exit.
  A session another dsh-TUI terminal has open is refused, and a `--resume` that
  cannot open fails instead of starting a fresh session. The short session id in
  the status line is the id `--resume` takes.
- `/fork` writes a copy you can resume later; the open session is untouched.
- Double-`Esc` rewinds to an earlier prompt: the conversation (continuing in a
  copy cut just before it, with the prompt back in the input), the files Claude
  edited since (restored from Claude's file checkpoints, previewed before you
  confirm), or both.
- When Claude itself resets the conversation (leaving plan mode with *clear
  context*), the view, subagents and background jobs are cleared with a notice and
  the session continues under the new id Claude gives it.
- A session resumed after a compaction shows *load earlier* at the top; each use
  brings back one compacted stretch, read-only from Claude's own transcript file.
  Long sessions fold old rows to bound memory, and the same entry restores them.

## Subagents and background jobs

- Each `Agent` delegation is a subagent card in the transcript; its text, tool
  calls and token count go into the card, never into the main conversation.
  `/agents` lists them, `Ctrl+A` opens the subagent dashboard and its detail view,
  where a running one can be stopped.
- A command Claude runs in the background (`Bash` with `run_in_background`, or a
  running command moved to the background) is a job card with the status-line job
  marker; `/jobs` lists them, and `k` twice stops one. While on screen, the card and
  the panel show the tail of the job's output file (read-only, the last 64 KiB, at
  most once a second).
- Interrupting a turn never stops a job. A job or subagent Claude stops reporting
  shows as *status unknown*.

## Images

Paste an image or `@`-mention an image file (PNG, JPEG, GIF, WebP) and it is sent
with the message. Limits: 5 MiB, 2000 px per side and 4 megapixels per image; 20
images and 20 MiB per message. Oversized images are scaled down when sharp is
available. Staged images are held in memory only. Resumed sessions show the images
their prompts carried.

## Known limitations

- One dsh-TUI process runs one backend; switching restarts through `/kernel`.
- In a Claude session the side panel's workspace panel reports it is unsupported
  and the trajectory panel stays empty.
- No `/add-dir`; the refusal dialog offers only *Retry* and *Cancel*; an MCP
  request that needs a browser step does not open the browser for you.
- dsh-TUI cannot tell when the same session is also open in a plain
  `claude --resume`.
- Using a claude.ai subscription sign-in in a third-party client is subject to
  Anthropic's terms; use an API key if that is a concern.
