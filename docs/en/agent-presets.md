<p align="center">
  <a href="../zh/agent-presets.md">简体中文</a> | <strong>English</strong>
</p>

[← Documentation index](../Index_EN.md)

# Agent Presets (Four Official Agent Modes)

This integrates the official preset registry from `@deepseek-ai/dsh-agent-presets`.

| ID | Name | Description |
|---|---|---|
| `standard` | Standard (default) | Full-featured coding agent with editing, shell, retrieval, skills, planning, goals, subagents, and workflows |
| `code` | PTC Mode | Standard capabilities plus Code Mode SDK tool presentation, allowing the model to compose multiple steps in one TypeScript program |
| `minimal` | Minimal | Only persistent bash and str_replace_editor, with no compaction |
| `cordis` | Creation Mode | Standard capabilities plus runtime inspection and plugin experimentation tools for authoring custom presets |

Usage:

- `/preset` opens the picker with localized names and descriptions; `✓` marks the current session preset.
- `/preset <id>` switches directly, while `/preset status` shows the current state.
- **Official locking rule**: a session cannot switch presets after conversation has begun. In that
  case, the selection is saved as the default for `/new` or the next startup. An empty session
  switches in place immediately: the toolset changes live, the change is recorded in the session
  log, and the new preset survives resume and fork.
- The default preset is stored in `~/.dsh-cc/agent-preset.json`. Precedence is:
  the `preset` key in cordis.yml (or the `CC_TUI_PRESET` environment variable) > preference file >
  registry default (`standard`).
- Resuming an old session always restores the preset recorded in that session's log, regardless of
  the current default.
- The `/model` choice is stored in `~/.dsh-cc/model.json`, with the same precedence as presets:
  the `provider`/`model` keys in cordis.yml > preference file > harness defaults
  (`deepseek-official` / `deepseek-v4-flash`). Resuming an old session restores the route recorded
  in its own log (request/header), independent of the current preference.
- To create a custom preset, place a directory containing `agent.cordis.yml` under
  `~/.dsh/.agent-presets/`. The registry discovers it immediately and exposes it in the `/preset`
  picker.

Implementation details: preset files ship with the official CLI. When profile-boot finds an
`agent-presets` line in the composition, it injects the shipped root automatically; this package
does not copy those files. The 24 model-side host lines (tool-bash/tool-web, subagent lines,
compaction-basic, and others) are disabled in the bundle patch after preset migration, matching the
official dsh-web-app behavior. As a result, the cc-tui-specific `CC_TUI_COMPACT_RATIO`,
`CC_TUI_COMPACT_RETAIN`, and depth-1 subagent settings have been retired in favor of each preset's
own compaction and delegation configuration.
