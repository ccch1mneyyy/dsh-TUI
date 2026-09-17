# Interactive Web Preview

[README](../README_EN.md#preview) · [简体中文](web-preview.md)

## What Runs

This is neither a recording nor an HTML recreation. xterm.js displays ANSI
output from the repository's real Ink renderer and sends keyboard, mouse and
resize events to its `Chat` component. A demo channel supplies fixed thinking,
tool results and responses. It creates no DSH Agent, calls no model and runs
no shell commands. Interface behavior comes from the checked-out source;
demo content is not actual model reasoning or tool execution.

GitHub README pages do not run scripts or interactive iframes, and GitHub Pages
does not host Node processes. The README therefore links here; interaction
runs in a separate browser page. This is a local preview tool, not a deployed
public demo or an internet-facing remote terminal.

## Start

Use Node.js 24 and the repository's pinned pnpm version. Check out the PR branch
and initialize all three submodules:

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile --ignore-scripts
pnpm compile
pnpm preview:web
```

Open the printed URL, normally `http://127.0.0.1:4173`. An occupied port produces
an explicit error. Set `DSH_TUI_PREVIEW_PORT` to another port, or `0` to let the OS
choose a free port. Preview scripts are source-development tools, not npm
package contents.

## Interactions

| Action | Behavior |
| --- | --- |
| Submit ordinary text | Fixed demo turn: streamed thinking, Read tool card, Markdown response |
| `/theme`, `/model`, `/effort` | Native pickers; model and effort only change demo state |
| `/vim`, expanded editor, input history | Real input component |
| `/thinking`, Ctrl+O, scrolling | Real display and navigation |
| `/new`, `/clear`, rewind | Temporary demo conversation only; no durable session |
| `/settings` | TUI display options; no real DSH settings service |
| Browser reset button | Terminate the old process and create a fresh demo session |
| Accounts, files, plugins, MCP, background Agents | Not connected; operations explicitly report unavailability |

Each connection has a dedicated process and temporary HOME, without inherited
credentials or real DSH configuration. Node permissions allow reads from the
repository/temporary directory and writes only inside the temporary directory;
subprocesses, Workers and native addons are disabled. The server binds only to
`127.0.0.1`, validates Host, Origin and a same-origin session cookie, and bounds
messages, input rate, dimensions and concurrent connections. Disconnecting
terminates the process and removes its temporary directory. This is not a
complete OS sandbox for untrusted code; do not proxy or forward it publicly.

## Verify

```sh
pnpm verify:web-preview
pnpm exec playwright install chromium
pnpm verify:web-preview-browser
```

The server test checks protocol limits, asset routing, cross-origin rejection,
real rendering, input, resize and process cleanup. Browser tests cover desktop
and mobile viewports, streaming, menus, reset and layout; screenshots go to
`.validation/web-preview/`. Set `PLAYWRIGHT_CHANNEL=chrome` to use installed Chrome.
