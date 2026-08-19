# Using dsh-TUI in VS Code

[Documentation index](README.md) · [中文](vscode.md)

dsh-TUI is a terminal program: it writes ANSI into a PTY and reads keys back
from the PTY, so any compatible terminal can host it — including the **VS Code
integrated terminal** (xterm.js). This page covers two ways to use it:

1. **The `dsh-tui-vscode` companion extension (recommended)** — sessions run
   in a REAL VS Code integrated terminal (a new column beside the editor),
   with an experience **almost identical to the official Claude Code VS Code
   extension**: multiple concurrent sessions, a sidebar session history, and
   one-click start/resume / specific-session resume. This is the full
   implementation of
   [issue #161](https://github.com/ccch1mneyyy/dsh-TUI/issues/161), and the
   extension is published on the VS Code Marketplace.
2. **Run directly in the built-in terminal** — zero install, seconds to
   start; for when you do not want the extension.

> Version note: `dsh-tui` on this page refers to this repository (the TUI
> plugin, currently **0.7.1**; 0.7.0+ recommended); `dsh-tui-vscode` refers
> to the companion extension (currently **0.5.1**). The two version and
> release independently. See the
> [baobaolaodie/dsh-tui-vscode](https://github.com/baobaolaodie/dsh-tui-vscode)
> README for the extension's full documentation.

## Option 1: the dsh-tui-vscode companion extension (recommended)

[`baobaolaodie/dsh-tui-vscode`](https://github.com/baobaolaodie/dsh-tui-vscode)
runs dsh-tui inside a REAL VS Code integrated terminal — the same shape as the
official Claude Code extension's terminal mode (`createTerminal` + run the CLI
inside it), with no webview and no xterm emulation. It does not touch the
TUI's rendering core — it only **hosts** it and adds editor integration.

### Experience comparison with the official Claude Code extension

| Capability | Official Claude Code extension | dsh-tui-vscode |
| --- | --- | --- |
| Entry points | Activity-bar icon + editor-title button + command palette | Same (DeepSeek whale icon) |
| Session position | NEW column beside the active one (`ViewColumn.Beside`) | Same — never takes the current column |
| Terminal tab | `Claude Code` + logo icon | `DeepSeek` + whale icon |
| Session host | Real integrated terminal (default shell — PowerShell on Windows) | Same |
| Multiple sessions | Every click opens a new session terminal | Same; old sessions keep running |
| Sidebar | Sessions list | Session history (grouped by project — stronger) |
| Auto start/stop | Open = start; closing the terminal = end | Same |
| Env injection | — | `DSH_TUI_LANG` / `$VISUAL` / `$DSH_HOME` / session id |

### Prerequisites

- VS Code >= 1.90;
- Global `dsh` CLI and `dsh-tui` (**dsh-tui 0.7.0+ recommended**, see
  [Getting started](getting-started.en.md)):

  ```sh
  npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui
  ```

- `DEEPSEEK_API_KEY` for running models (in the terminal environment or the
  dsh configuration).

### Install

**From the VS Code extension panel (recommended)**: press `Ctrl+Shift+X`,
search for **`dsh-tui`** and install with one click (publisher
`baobaolaodie`), or open the
[Marketplace page](https://marketplace.visualstudio.com/items?itemName=baobaolaodie.dsh-tui-vscode)
directly.

Or build from source:

```sh
git clone https://github.com/baobaolaodie/dsh-tui-vscode.git
cd dsh-tui-vscode
npm install
npm run package && code --install-extension dsh-tui-vscode-0.5.1.vsix --force
# or: npm run install:local
```

### Quick start

1. Click the **editor-title whale button** (or the command-palette entry
   `dsh-tui: Start new session / 启动新会话`) — a **DeepSeek** terminal opens
   on the Beside column and runs dsh-tui automatically; the **activity-bar
   whale icon** opens the sidebar session history (its welcome view offers
   start/resume buttons);
2. Click again = **another concurrent session**; older sessions keep running
   in their own terminals;
3. **Resume the last session**: `dsh-tui: Resume last session / 恢复上次会话`;
4. **Resume a specific session**: expand a project group in the sidebar
   "会话历史" and click the session entry;
5. **Terminate**: close the terminal tab (ends only that session), or double
   `Ctrl+C` inside the TUI; the command
   `dsh-tui: Terminate session / 终止会话` sends Ctrl+C to the most recent
   terminal.

While sessions are running, a **status-bar** item (`dsh-tui`, bottom-left)
appears; clicking it starts a new session (`dsh-tui-vscode.open`).

### Command reference

| Command ID | Title | Action |
| --- | --- | --- |
| `dsh-tui-vscode.open` | Open panel / 打开会话面板 | Start a new session (same as the editor-title button) |
| `dsh-tui-vscode.start` | Start new session / 启动新会话 | Start a new session |
| `dsh-tui-vscode.resume` | Resume last session / 恢复上次会话 | Resume via `--resume` |
| `dsh-tui-vscode.focus` | Focus session panel / 聚焦会话面板 | Focus the most recent terminal, else start one |
| `dsh-tui-vscode.kill` | Terminate session / 终止会话 | Send Ctrl+C to the most recent terminal |
| `dsh-tui-vscode.refreshSessions` | Refresh sessions / 刷新会话列表 | Manually refresh the sidebar |
| `dsh-tui-vscode.resumeSession` | Resume session / 恢复会话 | Resume a specific session (sidebar click) |
| `dsh-tui-vscode.insertAtMention` | Insert @-mention / 插入 @文件引用 | With editor focus press `Ctrl+Alt+K` (macOS `Cmd+Alt+K`) or the editor context menu: inserts the current file / selection as `@absolute/path Lstart-end` into the dsh-tui input box (the absolute path is independent of the dsh-tui session cwd; whole file when nothing is selected; falls back to the clipboard with no running session) |

### Architecture

**Session launch** (same shape as the official extension):

```ts
createTerminal({
  name: 'DeepSeek',                                   // terminal tab title
  cwd,                                                // workspace root
  env,                                                // env injection (below)
  iconPath: <whale icon>,                             // tab icon
  location: { viewColumn: ViewColumn.Beside },        // new column beside
  isTransient: true,                                  // not restored
})
terminal.show()
// runs the launch command once the shell is ready (shell-integration event,
// or a 1.2s fallback delay)
```

The launch command comes from `dsh-tui-vscode.command` (default `dsh-tui`).
The extension first resolves a bare command to an ABSOLUTE path against the
HOST PATH (quoting it for the shell when it contains spaces) — the terminal
shell's PATH is not trustworthy (login shells rebuild it; verified
empirically) — then appends the configured extra args, adding `--resume` at
the end when resuming the last session.

**Env injection**: `DSH_TUI_LANG`, `$DSH_HOME` (optional override) and
`$VISUAL` (`code -w` when neither is set) are passed through
`createTerminal`'s env; resuming a specific session additionally injects
`DSH_TUI_RESUME_SESSION` (and compatibly `DSH_CC_RESUME_SESSION`).

**Multiple concurrent sessions**: every "Start new session" click creates a
new terminal and process; older sessions keep running in their own terminals
(same as the official extension). "Focus" and "Terminate" act on the most
recently created terminal; closing a terminal ends only that session.

**Specific-session resume**: clicking a sidebar entry injects the target
session id into the terminal env via `DSH_TUI_RESUME_SESSION` and deliberately
does NOT pass `--resume`: this profile's `cordis.patch.yml` reads that env at
boot (`sessionId: !!js process.env.DSH_TUI_RESUME_SESSION ??
process.env.DSH_CC_RESUME_SESSION ?? undefined` — the reader prefers the new
name and still accepts the old one) and the TUI resumes the session. Passing a
bare `--resume` (or `-c`/`--continue`) would make the launcher
(`bin/dsh-tui.js`) overwrite the env from `~/.dsh-tui/resume.txt` — that is
the "resume last session" path; the two do not interfere (verified in the
launcher source). CLI users can also use **`dsh-tui --resume <id>`** or
`--resume=<id>` (supported since 0.7.0) to resume a specific session — same
effect as the extension's env channel.

**Sidebar session history**:
- Data sources: session logs under `~/.dsh/sessions` (zstd JSONL), the
  dsh-storage ledger (`~/.dsh/storages/session_projcache.json`, the source of
  the web session list's titles), and the TUI's last-used map
  (`~/.dsh-tui/last-used.json`);
- Title precedence: log `session/title` event → storage-ledger title → first
  user message → "未命名会话"; the full cwd path and session id go into the
  item tooltip;
- Grouped by project (cwd short name), most recently active project first;
  within a group, most recently used first;
- Auto-refresh: watches the session directories (including each project
  group — per-directory watches on Linux), so new sessions appear
  immediately; terminal open/close and the manual refresh button also trigger
  a refresh.

**Start/stop semantics**: open = start; closing the terminal ends that
session's process; double `Ctrl+C` inside the TUI exits. No button panels, no
background daemons.

### Configuration

| Key | Default | Description |
| --- | --- | --- |
| `dsh-tui-vscode.command` | `dsh-tui` | Launch command (resolved to an absolute path against the host PATH) |
| `dsh-tui-vscode.extraArgs` | `[]` | Extra CLI args, e.g. `["--lang","en"]` |
| `dsh-tui-vscode.lang` | `""` | `""`/`zh`/`en`, exported as `DSH_TUI_LANG` |
| `dsh-tui-vscode.injectEditor` | `true` | Export `$VISUAL` when unset |
| `dsh-tui-vscode.editorCommand` | `code -w` | Value exported as `$VISUAL` |
| `dsh-tui-vscode.dshHome` | `""` | `$DSH_HOME` override (empty = inherit) |

### Development and verification

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # compile + node --test (data-layer unit tests)
npm run test:e2e    # real extension-host tests (xvfb-run -a on Linux)
npm run package     # compile + build the .vsix
```

The e2e suite covers: command registration, real terminal creation with env
injection, input round-trip, multiple sessions, Ctrl+C termination,
`--resume` resume, specific-session resume (env channel, no `--resume`), and a
**guarded REAL dsh-tui resume test** (a successful resume creates no new
session — observable).

The extension repository's CI (GitHub Actions) additionally runs a test
matrix (Linux/Windows × Node 22/24), an e2e job (real extension host),
quality (bilingual mirror symmetry / BOM guard / actionlint), pr-policy
(Conventional Commits / PR template), release-consistency (five-place
version consistency + per-version PR links), security-scan and docs-links
(dead-link check) jobs; local commit hooks (pre-commit / commit-msg) are
shipped in the repository's `.githooks/`.

### Known limitations

- Session content is terminal content: scrollback is managed by the VS Code
  terminal (same as Claude Code's terminal mode);
- Specific-session resume requires this profile's `cordis.patch.yml`
  (dsh-tui 0.7.0+);
- For logs without a `session` header, the project name comes from decoding
  the cwd-encoded group dir, which is lossy for hyphenated project names
  (e.g. `flow-comet` → `flow\comet`); the real cwd is still available in the
  item tooltip.

## Option 2: run directly in the VS Code integrated terminal

When you do not want the extension, run dsh-tui directly in the integrated
terminal. Prerequisites match [Getting started](getting-started.en.md): global
`dsh` CLI and `dsh-tui` (the first run bootstraps the profile; pnpm is
required).

1. Open the VS Code integrated terminal (`` Ctrl+` ``) and run:

   ```sh
   dsh-tui
   ```

2. Resume the last session:

   ```sh
   dsh-tui --resume
   ```

dsh-TUI has dedicated compatibility paths for xterm.js (VS Code / Cursor /
code-server): truecolor, OSC 8 links (rendered clickable by VS Code itself),
OSC 52 clipboard (VS Code prompts for permission on first use), synchronized
output and smooth draining — handled in `src/ink/` under the
`TERM_PROGRAM=vscode` detection branches. Streaming Markdown, tool cards,
scrolling, and double-Esc time travel behave the same as in a standalone
terminal.

### Make `Ctrl+X` edit the current input in VS Code

The TUI's `Ctrl+X` uses `$VISUAL`/`$EDITOR`. To edit in VS Code, export
`code -w` in the terminal environment (`settings.json`, key
`terminal.integrated.env.<platform>`):

```jsonc
{
  "terminal.integrated.env.windows": { "VISUAL": "code -w" },
  "terminal.integrated.env.linux":   { "VISUAL": "code -w" },
  "terminal.integrated.env.osx":     { "VISUAL": "code -w" }
}
```

(The companion extension exports `code -w` automatically when neither
`$VISUAL` nor `$EDITOR` is set — see Option 1.)

### UI language

`DSH_TUI_LANG` defaults to Chinese; for the English UI, add
`"DSH_TUI_LANG": "en"` to the env block above.

### Known differences (built-in terminal)

| Capability | Behavior in the integrated terminal |
| --- | --- |
| Mouse wheel / drag selection | Handled by the integrated terminal; "copy on release" surfaces as OS-level copy behavior |
| Extended keyboard protocol | modifyOtherKeys / win32-input-mode behavior is decided by xterm.js and may differ from kitty / WezTerm |
| OSC 52 clipboard | First use triggers VS Code's own permission prompt |

For behavior identical to a standalone terminal (e.g. complex mouse
semantics), use an external terminal window (Windows Terminal / kitty /
WezTerm / iTerm2 / tmux).

## Which option to choose

| Scenario | Choice |
| --- | --- |
| Want the Claude Code extension-like experience (Beside column, multiple sessions, session-history sidebar, specific-session resume) | Option 1: companion extension |
| Occasional use, no extension wanted | Option 2: built-in terminal |
| Need a standalone terminal's full protocol behavior (complex mouse semantics, etc.) | External terminal window |

## Acceptance baseline

Per [Contributing](contributing.en.md), VS Code is a supported terminal
platform: any rendering change should be walked through inside the VS Code
integrated terminal in both inline and fullscreen modes at narrow widths —
startup, resize, scroll, input, cancel, and clean exit.
