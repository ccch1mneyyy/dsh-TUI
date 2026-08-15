# Configuration

[Documentation index](README.md) · [简体中文](configuration.md)

## Profiles and patch layers

After an npm/profile installation, user configuration lives at:

```text
$DSH_HOME/profiles/dsh-tui/cordis.patch.yml
```

When `DSH_HOME` is unset, it normally defaults to `~/.dsh`. The file is a
top-level YAML array and may use the `!!js` expressions supported by DSH.

Profile startup layers `dsh-base`, installed bundles, the package's
`cordis.patch.yml`, and finally the user patch. A user configuration normally
overrides an existing row by `id`; use `insert` only for a genuinely new
service.

> When a row is overridden, its `config` block is replaced as a whole. It is
> not deep-merged, so repeat every key that must remain active.

## TUI configuration

A complete common override looks like this:

```yaml
- id: dsh-tui
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
    cwd: !!js process.cwd()
    effort: max
    activity: true
    activityFrames: claude
    contextBar: true
    fullscreen: false
    preset: !!js process.env.DSH_TUI_PRESET ?? undefined
    sessionId: !!js process.env.DSH_TUI_RESUME_SESSION ?? undefined
```

| Field | Default/source | Meaning |
| --- | --- | --- |
| `provider` | `deepseek-official` | DSH model route |
| `model` | `deepseek-v4-flash` | Startup model; `/model` can switch through a session fork |
| `cwd` | `process.cwd()` | Agent workspace and filesystem-policy root |
| `effort` | normally `max` in the bundle | Reasoning effort actually applied to every request (validated against model levels; deepseek supports only off/high/max and invalid levels silently fall back to the adapter default; wins over the persisted `/effort` choice), also shown in the header at startup |
| `modes` | built-in trio | Shift+Tab session-mode cycle (plan/sandbox/approval atom bundles); defaults to default → plan → full-access |
| `activity` | `true` | Show the live activity row |
| `activityFrames` | persisted choice or `claude` | Activity animation preset; `/activity` changes it at runtime |
| `contextBar` | `true` | Segmented context-usage bar below the input box; `false` hides the row |
| `fullscreen` | `false` | `true` uses the alternate screen, app scrolling, and mouse selection; `false` uses inline mode |
| `preset` | roster default `standard` | Agent preset for new sessions; explicit configuration wins over persisted preference |
| `sessionId` | unset | Session to resume, normally injected by the Windows `--resume` launcher |

## Live activity row

`dsh-working-activity` is installed with the package and inserted by its patch.
Override only the existing ID when tuning it:

```yaml
- id: working-activity
  config:
    publishIntervalMs: 500
```

Do not insert a second row and do not separately run
`dsh plugin ... add dsh-working-activity` for the same profile.

## Agent presets

Each session composes its model-visible tools and prompt through
`@deepseek-ai/dsh-agent-presets`:

| ID | Name | Capability |
| --- | --- | --- |
| `standard` | Standard (default) | Editing, shell, search, skills, planning, goals, subagents, and workflows |
| `code` | PTC | Standard plus Code Mode SDK presentation for composing operations in TypeScript |
| `minimal` | Minimal | Persistent Bash and `str_replace_editor` only, without compaction |
| `cordis` | Creation | Standard plus runtime inspection and plugin-experimentation tools |

Usage rules:

- `/preset` opens the picker.
- `/preset <id>` selects directly; `/preset status` reports the current state.
- A blank session can switch in place. Once a conversation has started, the
  official blank-only rule stores the choice as the new default for `/new` or
  the next launch.
- The default is stored in `~/.dsh-tui/agent-preset.json`.
- Precedence is explicit `config.preset` or `DSH_TUI_PRESET`, then persisted
  preference, then the roster default `standard`.
- Resuming a session restores the preset recorded in that session's log and
  does not overwrite it with the current default.

Place a custom preset at `$DSH_HOME/.agent-presets/<name>/` with an
`agent.cordis.yml` file. Under the default DSH home this is
`~/.dsh/.agent-presets/`.

Since 0.3, model-side tools, planning, compaction, and delegation are owned by
the preset. Profile mode no longer uses the old `CC_TUI_COMPACT_RATIO`,
`CC_TUI_COMPACT_RETAIN`, or the former TUI's subagent-depth customization; configure
those policies in the preset instead.

## MCP

The official `@deepseek-ai/dsh-mcp-client` supports both stdio and streamable
HTTP. Mounted tools are registered as `mcp__<server>__<tool>` and enter the
model tool set automatically.

Insert servers in the user `cordis.patch.yml`:

```yaml
- insert:
    - id: mcp-context7
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: context7
        command: npx
        args: ['-y', '@upstash/context7-mcp']

    - id: mcp-remote
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: streamable-http
        serverName: remote
        url: https://example.com/mcp
        headers:
          Authorization: !!js process.env.MCP_TOKEN
```

Run `/mcp` to inspect connected servers and tool counts. Consult the
[DeepSeek Harness configuration catalog](https://deepseek-harness.github.io/deepseek-harness/reference/config-catalog#deepseek-ai-dsh-mcp-client)
for the complete field reference.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DEEPSEEK_API_KEY` | Required DeepSeek credential |
| `DEEPSEEK_BASE_URL` | Override the compatible DeepSeek API endpoint |
| `DSH_TUI_PERSONA` | Override the Agent persona injected by the composition |
| `DSH_TUI_PRESET` | Override the default Agent preset for new sessions |
| `DSH_TUI_THEME` | Pin a built-in or custom theme ahead of persisted selection |
| `DSH_TUI_DISABLE_MOUSE` | Temporarily disable mouse handling in fullscreen mode |
| `DSH_TUI_RESUME_SESSION` | Resume a session at startup, normally set by a launcher |
| `DSH_TUI_SESSION_ROOT` | Override the session persistence location; the profile uses a SQLite database path, while bare `cordis.yml` uses a JSONL root directory |
| `DSH_PERMISSION_MODE` | Override non-Windows sandbox policy, such as `workspace-write` or `danger-full-access` |
| `DSH_TUI_WORKSPACE` | Working directory used by the Windows `dsh-tui.cmd` launcher |
| `DSH_TUI_DEBUG` | Enable dsh-tui diagnostics on stderr |
| `DSH_TUI_RENDER_LOG` | File path for raw ANSI frame capture |

The old `CC_TUI_*` and `DSH_CC_*` names no longer take effect as of this
release; startup prints one warning line whenever a legacy name is still set
(repeated on every launch while it remains set). The only exception is
`DSH_TUI_RESUME_SESSION`: the reader prefers the new name but still accepts
the old `DSH_CC_RESUME_SESSION`, and the writer sets both variables to ease
the transition for older launchers.

`DSH_TUI_RENDER_LOG` may capture visible prompts, tool arguments, and output.
Do not attach it to a public issue without reviewing and redacting it.

## Composition constraints

- `user-interaction` normally comes from `dsh-base`. The plugin creates a
  fallback in a bare composition, but the profile patch must not insert a
  duplicate.
- When manually inserting a subagent provider, mount the core `subagent`
  service first.
- A custom `plan-mode` override requires a non-empty `section`.
- Profile mode uses this package's SQLite `sessions` row and disables base
  JSONL persistence so one writer owns each session.
- `cordis.yml` is a bare-composition example and may have a different service
  topology. Normal installation and user overrides should follow
  `cordis.patch.yml`.

`DSH_TUI_SESSION_ROOT` is interpreted by the active composition: `dsh --profile
dsh-tui` uses the SQLite row inserted by this package and defaults to
`~/.dsh-tui/sessions.sqlite`; direct `dsh --config cordis.yml` uses the example's
JSONL persistence and defaults to `$DSH_HOME/sessions` (i.e. `~/.dsh/sessions/`).
Do not point both
startup modes at the same existing data directory.

See [Architecture and limitations](architecture.en.md#permissions-and-security-boundary)
for permission behavior and platform differences.
