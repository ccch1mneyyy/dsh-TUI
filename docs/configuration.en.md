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
    # Prefer leaving cwd unset — the default resolves to the git worktree
    # root containing the launch directory. To pin a fixed workspace, use an
    # absolute path (e.g. cwd: /repo/packages/app), NOT `!!js process.cwd()`
    # (that pins the workspace to the launch subdirectory, issue #96).
    effort: max
    activity: true
    activityFrames: claude
    contextBar: true
    fullscreen: false
    preset: !!js process.env.DSH_TUI_PRESET ?? undefined
    smart: !!js "process.env.DSH_TUI_SMART === '1' ? true : process.env.DSH_TUI_SMART === '0' ? false : undefined"
    workspace: !!js process.env.DSH_TUI_WORKSPACE_TARGET ?? undefined
    sessionId: !!js process.env.DSH_TUI_RESUME_SESSION ?? undefined
```

| Field | Default/source | Meaning |
| --- | --- | --- |
| `provider` | Harness `agentDefaultModel`; bare compositions fall back to `deepseek-official` | DSH model route; provider and model must both be set to form an explicit route |
| `model` | Harness `agentDefaultModel`; bare compositions fall back to `deepseek-v4-flash` | Startup model; `/model` can switch through a session fork |
| `cwd` | git worktree root containing the launch directory (`process.cwd()` when outside any worktree; a dotfiles repo at `$HOME` does not count) | TUI-side session workspace: agent meta, `@` completion/mention expansion, /resume filtering, statusline; resuming an existing session adopts that session's persisted cwd. Note the bash/fs-policy/sandbox roots are still owned by the composition layer's cordis config (default: the launch directory, governed by dsh-base) and may differ from this session-side cwd |
| `workspace` | unset | Startup workspace target: a local path, `file://` URL, or plugin-provided URI; takes precedence over `cwd` |
| `effort` | normally `max` in the bundle | Reasoning effort actually applied to every request (validated against model levels; deepseek supports only off/high/max and invalid levels silently fall back to the adapter default; wins over the persisted `/effort` choice), also shown in the header at startup |
| `modes` | built-in trio | Shift+Tab session-mode cycle (plan/sandbox/approval atom bundles); defaults to default → plan → full-access |
| `activity` | `true` | Show the live activity row |
| `activityFrames` | persisted choice or `claude` | Activity animation preset; `/activity` changes it at runtime |
| `contextBar` | `true` | Segmented context-usage bar below the input box; `false` hides the row |
| `fullscreen` | `false` | `true` uses the alternate screen, app scrolling, and mouse selection; `false` uses inline mode |
| `preset` | roster default `standard` | Agent preset for new sessions; explicit configuration wins over persisted preference |
| `smart` | persisted choice or `false` | Enable Smart over the selected Agent preset |
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
| `liangshen` | Liangshen mode | Minimal's two-tool surface first for root and delegated agents, the full catalog after the first tool call, and a fresh anchor after compaction |

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
- Liangshen mode ships with dsh-tui and is installed into the user preset root
  at startup. An existing unmanaged directory with the same id is preserved.


### Smart enhancement

Smart is an independent routing overlay over the selected Agent preset, not an
additional preset. `/preset` chooses the base capability. Switching Smart forks
at the end of current history, preserves the conversation, model route, cwd,
preset, and workflow boundaries, and reassembles the replacement agent's
prompt, context, tool schemas, and services. The standalone `liangshen` preset
owns its own tool surface, promotion, and compaction semantics and cannot be
stacked with Smart.

Smart is tuned only for the DeepSeek V4 family. It primarily targets V4 Flash
while retaining a V4 Pro routing policy. The TUI hard-gates the enhancement by
route string and accepts only recognizable DeepSeek V4 family names;
custom-provider aliases must retain a `deepseek-v4` form.

Control Smart with `/smart on|off|status`, `smart: true`, or
`DSH_TUI_SMART=1`.

Smart is based on [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite), pinned to suite `eb1b00d` and historical Router Pro
commit `7426c9c`. Upstream has deleted the `v0.3.0` tag, and current suite
`a09eb0a` rolls its preset pointer back to Router v0.2. That reviewed rollback is
explicitly excluded so the DeepSeek V4 Pro policy is not silently removed.
Smart primarily targets V4 Flash. On `deepseek-v4-pro`, it uses Router Pro:
maintenance/fix selects
the RL shell/editor interface, greenfield build selects the doer write-first
interface, and ambiguous input uses router-v2 few-shot. Flash and unknown
models keep Router Standard. These first-request prompt/context and tool
surfaces run only over the `standard` base preset; other presets retain their
complete native catalogs while receiving non-destructive classification and
near-field guidance. Top-level Standard Smart also mounts the required
`str_replace_editor`. Skills,
plugin tools, runtime policy contexts, and the complete Standard sections
return after the first durable `tool/call`; a tool-less first answer promotes
the next user turn, and `/smart on` over existing history starts promoted
instead of pretending to be a clean first request. Router Pro does not change
the request output budget. The suite's new `dsh-mode-boost` overlaps Router and
currently violates this TUI's first-message, promoted-context, and shell-less
child boundaries, so its provenance is recorded without double-mounting it.
`dev_mode_subagent` is an isolated,
output-bounded text consultation without a tool catalog; it is not an
executable task worker. Super Injector v0.3.3 is not redistributed because its upstream release declares
BSD-3-Clause but includes no LICENSE/NOTICE artifact. When the official payload
is already installed in the active or `web` profile, Smart verifies its version and host-bundle SHA-256
before mounting the complete upstream host tool set. `DSH_SMART_RUNTIME_PATH`
may point to that package directory. The terminal compatibility layer does not
start a web server, so the upstream browser settings panel is unavailable.
Once the optional host is active, its restore/watch loop and routes, timers,
services, or other side effects from dynamically loaded plugins may remain
process-global. `/smart off` removes the agent-scoped Smart prompt and Router
and hides known host management tools and context, but it does not unload
arbitrary injected plugins. Full isolation requires a separate process/profile;
stopping all activated host behavior requires restarting the current process.

Explicit `smart` configuration wins the persisted default. State is stored in
`~/.dsh-tui/smart.json` by default; `DSH_TUI_DATA_DIR` relocates it to an
isolated data directory. The per-session sidecar is the sole source of truth;
neither `request/header` nor the model-visible system prompt carries mode
state. `/resume`, rewind, `/model`, `/new`, and workspace ownership recompose
against the target session's sidecar. While Smart is active, the input and
persistent status line show Smart. Entering the enhancement plays one short
label/arrow pulse; idempotent commands and failed switches do not play a false
transition. The default state adds no marker.

Native DSH spawn, fork, and continuable children inherit the parent's Smart
state. The overlay never registers new tools in child scope or bypasses the
delegation `toolFilter`; child persona and delegation, sandbox, and approval
contexts are preserved, and routing stays within the already allowed catalog.

Place a custom preset at `$DSH_HOME/.agent-presets/<name>/` with an
`agent.cordis.yml` file. Under the default DSH home this is
`~/.dsh/.agent-presets/`.

Since 0.3, model-side tools, planning, compaction, and delegation are owned by
the preset. Profile mode no longer uses the old `DSH_TUI_COMPACT_RATIO`,
`DSH_TUI_COMPACT_RETAIN`, or the former TUI's subagent-depth customization; configure
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
| `VISUAL` / `EDITOR` | External editor opened by `Ctrl+X` (`VISUAL` wins; arguments like `code --wait` are allowed; POSIX falls back to `vi`) |
| `DEEPSEEK_API_KEY` | Required DeepSeek credential |
| `DEEPSEEK_BASE_URL` | Override the compatible DeepSeek API endpoint |
| `DSH_TUI_PERSONA` | Override the Agent persona injected by the composition |
| `DSH_TUI_PRESET` | Override the default Agent preset for new sessions |
| `DSH_TUI_SMART` | `1`/`0`: override the Smart enhancement default for new sessions |
| `DSH_SMART_RUNTIME_PATH` | Optional Smart host runtime package directory or `lib/index.js` path |
| `DSH_TUI_THEME` | Pin a built-in (`auto`/`light`/`dark`/`dark-ansi`) or custom theme ahead of persisted selection |
| `DSH_TUI_DISABLE_MOUSE` | Temporarily disable mouse handling in fullscreen mode |
| `DSH_TUI_RESUME_SESSION` | Resume a session at startup, normally set by a launcher |
| `DSH_TUI_WORKSPACE_TARGET` | Workspace path or URI resolved at startup, normally set by `dsh-tui <target>` |
| `DSH_TUI_DATA_DIR` | Override the data directory for themes, history, the resume pointer, and the Smart sidecar; disables automatic migration from legacy `~/.dsh-cc` |
| `DSH_TUI_SESSION_ROOT` | Override the JSONL session root; profile default `$DSH_HOME/sessions`, bare `cordis.yml` default `~/.dsh-tui/sessions` |
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

## `/provider`: add a model provider at runtime

`/provider` opens an interactive wizard that adds a model provider without a
restart:

- **Built-in provider**: pick a catalog route (openai, anthropic, deepseek, …)
  from `llm.listConfigurableProviders()`; only the API key is required. The
  baseURL can optionally be overridden (proxy gateways); the protocol and
  model catalog are inherited.
- **Custom API endpoint**: enter a route name, API key, baseURL, and the wire
  protocol (`openai-completions` / `openai-responses` / `anthropic-messages`).
  The wizard probes the endpoint with the draft credential and offers the
  advertised models for selection (manual id entry as fallback).

What gets written (on a profile start, where dsh-base provides the
settings/credentials services):

| Artifact | Location |
| --- | --- |
| Provider profile | `llm-pi-ai.providers.<route>` in `~/.dsh/settings.yaml`; the route registers on write |
| API key | `~/.dsh/.credentials.yaml` (mode 0600), referenced as `<ROUTE>_API_KEY` |

Key answers render as `••••••` in the transcript; when the process environment
already provides the same-named variable, the write is skipped and the value
resolves from the environment at request time. The configuration is shared
with the dsh web UI's Models settings page (same settings section). A bare
`dsh --config cordis.yml` start lacks these services and `/provider` reports
itself unavailable. After adding, run `/model` to switch to the new route's
models.

## Composition constraints

- `user-interaction` normally comes from `dsh-base`. The plugin creates a
  fallback in a bare composition, but the profile patch must not insert a
  duplicate.
- When manually inserting a subagent provider, mount the core `subagent`
  service first.
- A custom `plan-mode` override requires a non-empty `section`.
- Profile mode uses the base JSONL persistence row rooted at the shared
  `~/.dsh/sessions`, allowing TUI and Web to read the same history.
- `cordis.yml` is a bare-composition example and may have a different service
  topology. Normal installation and user overrides should follow
  `cordis.patch.yml`.

`DSH_TUI_SESSION_ROOT` always names a JSONL root. `dsh --profile dsh-tui`
defaults to `$DSH_HOME/sessions` (normally `~/.dsh/sessions/`); direct
`dsh --config cordis.yml` defaults to `~/.dsh-tui/sessions/`.

See [Architecture and limitations](architecture.en.md#permissions-and-security-boundary)
for permission behavior and platform differences.
