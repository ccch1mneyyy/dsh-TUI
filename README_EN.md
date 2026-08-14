<p align="center">
  <img src="docs/assets/logo.svg" alt="dsh-TUI - DeepSeek Harness terminal interface" width="560">
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-cc-tui"><img alt="npm" src="https://img.shields.io/npm/v/dsh-cc-tui?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/ccch1mneyyy/dsh-TUI/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ccch1mneyyy/dsh-TUI/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="Public beta" src="https://img.shields.io/badge/status-public%20beta-7da1de?style=flat-square">
</p>

# dsh-TUI

`dsh-TUI` is an interactive terminal front door for DeepSeek Harness. It is
mounted as a Cordis plugin and provides a Claude Code-style conversation, tool,
session, and fullscreen terminal experience while continuing to use the
official DSH agent, model, tool, session, and persistence services.

The project does not patch DeepSeek Harness core. Installing the plugin enables
the interface, and removing it leaves no core modifications behind.

> Status: public beta. It is suitable for daily use and extension work. Read
> [Architecture and limitations](docs/architecture.en.md) before relying on its
> permission model or terminal-specific behavior.

## Highlights

- **Terminal-native interaction**: streaming Markdown, structured tool cards,
  command and file completion, history search, message selection, and inline or
  alternate-screen rendering.
- **Visible agent state**: live activity, segmented context usage, TPS, cache
  hit rate, reasoning effort, input/output tokens, and Git/session metadata.
- **Complete session workflow**: `/resume`, `/new`, `/compact`, `/export`, model
  switching, and double-`Esc` rewind through a session fork.
- **Official DSH integrations**: agent presets, skills, MCP, goals, todos,
  subagents, and `ask_user_question` are connected through existing services
  and registries.
- **Designed for long sessions**: event-driven projection, differential output,
  message virtualization, replay coalescing, and bounded caches prevent render
  cost and memory from growing without limit.

## Preview

<p align="center">
  <img src="screenshots/splash.png" alt="dsh-TUI conversation with the pixel-whale header" width="100%">
</p>

Live activity, goal/todo state, and context metrics:

<p align="center">
  <img src="screenshots/working-line.png" alt="dsh-TUI live activity and context metrics" width="100%">
</p>

## Quick Start

Prerequisites: an interactive terminal TTY, the official `dsh` CLI, and
`pnpm`. Model requests also require `DEEPSEEK_API_KEY`.

```sh
# 1. Install the DeepSeek Harness CLI
npm install -g @deepseek-ai/dsh

# 2. Add the dsh-TUI profile plugin
dsh plugin --profile cc-tui add dsh-cc-tui

# 3. Start it
dsh --profile cc-tui
```

The repository's `sh install.sh` wraps step 2 and checks the required commands.
Windows users can also launch with `dsh-cc.cmd`; passing `--resume` restores the
most recently selected session.

See [Getting started](docs/getting-started.en.md) for profile composition,
source builds, and troubleshooting.

## Documentation

| Topic | Contents |
| --- | --- |
| [Getting started](docs/getting-started.en.md) | Prerequisites, installation, startup, profile lifecycle, source development |
| [Configuration](docs/configuration.en.md) | Cordis overrides, fields, agent presets, MCP, environment variables |
| [Themes](docs/themes.en.md) | Built-in themes, background detection, custom JSON themes, validation |
| [Interaction and commands](docs/interaction.en.md) | Keyboard, mouse, questionnaires, slash commands, session workflows |
| [Architecture and limitations](docs/architecture.en.md) | Runtime path, rendering, persistence, security boundary, known limitations |
| [Development guide](AGENTS.md) | Repository map, generated files, verification matrix, change rules |

The complete bilingual index is [`docs/README.md`](docs/README.md).

## How It Works

```text
dsh profile
  -> dsh-base
  -> dsh-TUI Cordis patch
  -> agent preset + DSH services
  -> session/event
  -> Channel projection
  -> React components
  -> ported Ink/Yoga renderer
  -> terminal
```

The TUI owns interaction and presentation only. The session log remains the
conversation source of truth, while model calls, tool execution, fork/resume,
compaction, and persistence remain owned by DSH services. See the
[architecture guide](docs/architecture.en.md) for module boundaries and
performance details.

## Development

CI uses Node 24 and pnpm 11. The package supports Node `^22.19 || >=24`.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm smoke
```

`pnpm build` compiles `src/` into the checked-in `lib/types/` output. Source
changes must include regenerated artifacts, and rendering, questionnaire, or
tool-card changes require the relevant regression scripts. See
[`AGENTS.md`](AGENTS.md) for the complete workflow.

## Permissions and Security Boundary

`dsh-TUI` does not implement a separate sandbox. It uses the filesystem,
shell, sandbox, and approval policies of the active DSH profile. The supplied
profile uses workspace confinement and approvals by default on non-Windows
platforms. Windows currently has no corresponding sandbox backend, so the
composition falls back to `danger-full-access` without approval prompts.
Inspect the profile before starting it around sensitive credentials or an
untrusted repository.

See [Permissions and security boundary](docs/architecture.en.md#permissions-and-security-boundary)
for details.

## Featured by DeepSeek Harness

The DeepSeek Harness official WeChat account featured this plugin among its
early user-built extensions. [View the feature screenshot](screenshots/wechat-official.png).

## License

[MIT](LICENSE)
