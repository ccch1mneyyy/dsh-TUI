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
    workspace: !!js process.env.DSH_TUI_WORKSPACE_TARGET ?? undefined
    sessionId: !!js process.env.DSH_TUI_RESUME_SESSION ?? undefined
```

| Field | Default/source | Meaning |
| --- | --- | --- |
| `provider` | Harness `agentDefaultModel`; bare compositions fall back to `deepseek-official` | DSH model route; provider and model must both be set to form an explicit route |
| `model` | Harness `agentDefaultModel`; bare compositions fall back to `deepseek-v4-flash` | Startup model; `/model` can switch through a session fork |
| `cwd` | git worktree root containing the launch directory (`process.cwd()` when outside any worktree; a dotfiles repo at `$HOME` does not count) | TUI-side session workspace: agent meta, `@` completion/mention expansion, /resume filtering, statusline; resuming an existing session adopts that session's persisted cwd. Note the bash/fs-policy/sandbox roots are still owned by the composition layer's cordis config (default: the launch directory, governed by dsh-base) and may differ from this session-side cwd |
| `workspace` | unset | Startup workspace target: a local path, `file://` URL, or plugin-provided URI; takes precedence over `cwd` |
| `effort` | normally `max` in the bundle | Reasoning effort applied to every request (validated against the runtime model's levels; invalid levels silently fall back to the adapter default and the configured value wins over the persisted `/effort` choice), also shown in the header at startup |
| `modes` | built-in trio | Shift+Tab session-mode cycle (plan/sandbox/approval atom bundles); defaults to default → plan → full-access |
| `activity` | `true` | Show the live activity row |
| `activityFrames` | persisted choice or `claude` | Activity animation preset; `/activity` changes it at runtime |
| `contextBar` | `true` | Segmented context-usage bar below the input box; `false` hides the row |
| `fullscreen` | `true` (factory default since 0.9.0) | `true` uses the alternate screen, app scrolling, and mouse selection; `false` uses inline mode |
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
| `ptc` (0.1.2) / `code` (legacy 0.1.1) | PTC | Standard plus the PTC SDK presentation for composing operations in TypeScript; both names resolve compatibly across versions |
| `minimal` | Minimal | Persistent Bash and `str_replace_editor` only, without compaction |
| `cordis` | Creation | Standard plus runtime inspection and plugin-experimentation tools |
| `liangshen` | Liangshen mode | Minimal's two-tool surface first for root and delegated agents, the full catalog after the first tool call, and a fresh anchor after compaction |

Usage rules:

- `/preset` opens the picker.
- `/preset <id>` selects directly; `/preset status` reports the current state.
- Picker names and descriptions come verbatim from each preset's `preset.yml`
  (written in Chinese). Under the `en` UI language (`/lang en`), the built-in
  presets (`standard` / `minimal` / `code` / `cordis` / `liangshen`) show
  localized English names and descriptions; custom presets are shown as-is.
- A blank session can switch in place. Once a conversation has started, the
  official blank-only rule stores the choice as the new default for `/new` or
  the next launch.
- The default is stored in `~/.dsh-tui/agent-preset.json`.
- A legacy `code` preference resolves to `ptc` when the active roster no
  longer provides `code`, then migrates after that successful resolution;
  rc rosters keep their real `code` id, and session logs are never rewritten.
- Precedence is explicit `config.preset` or `DSH_TUI_PRESET`, then persisted
  preference, then the roster default `standard`.
- Resuming a session restores the preset recorded in that session's log and
  does not overwrite it with the current default.
- Liangshen mode ships with dsh-tui and is installed into the user preset root
  at startup. An existing unmanaged directory with the same id is preserved.
- Liangshen mode's first-round `bash` on Windows runs an auto-discovered Git
  Bash: candidates are the installation tree of a `git.exe` found on PATH
  (covers installer, portable, and Scoop layouts; Scoop shims are followed),
  then conventional install roots and Scoop's conventional directories, then
  bare `bash` on PATH — never accepting the System32 WSL launcher as Git Bash.
  Set `DSH_TUI_LIANGSHEN_BASH_PATH` to an absolute `bash.exe` path to pin it
  explicitly (the pin is the only candidate; a miss warns and skips
  registration, exposing the full tool catalog on the first round).

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
| `VISUAL` / `EDITOR` | External editor opened by `Ctrl+G` (`VISUAL` wins; arguments like `code --wait` are allowed; with neither set the TUI prompts you to configure one — no `vi` fallback) |
| `DEEPSEEK_API_KEY` | Required DeepSeek credential |
| `DEEPSEEK_BASE_URL` | Override the compatible DeepSeek API endpoint |
| `DSH_TUI_PERSONA` | Override the Agent persona injected by the composition |
| `DSH_TUI_PRESET` | Override the default Agent preset for new sessions |
| `DSH_TUI_THEME` | Pin a built-in (`auto`/`light`/`dark`/`dark-ansi`), static theme, or registered plugin theme ahead of persisted selection |
| `DSH_TUI_DISABLE_MOUSE` | Temporarily disable mouse handling in fullscreen mode |
| `DSH_TUI_RESUME_SESSION` | Resume a session at startup, normally set by a launcher |
| `DSH_TUI_WORKSPACE_TARGET` | Workspace path or URI resolved at startup, normally set by `dsh-tui <target>` |
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

## `/provider`: manage model providers at runtime

`/provider` opens an interactive wizard that manages model providers without a
restart. The first step picks an action:

- **Add a new provider**: built-in catalog or custom API endpoint (below).
- **Edit an existing provider**: pick one of the routes your **user settings
  layer** carries (providers inherited from the composition base cannot be
  removed from the user layer, so they stay out of the edit/delete menu),
  then edit through a menu. Built-in routes offer **Edit API Key**, **Edit
  model list**, and **Delete this provider**; custom endpoints additionally
  get **Edit Base URL** and **Edit wire protocol** (a built-in route stays
  built-in even when its profile carries an explicit `api` override). Any
  edit patches only the picked field in place and exits immediately — no
  further confirmation; every other profile field (including keys the TUI
  does not model, like `headers`, `timeoutMs`, `retryPolicy`) never enters
  the write and survives untouched. "Edit model list" pre-checks the models
  you already enabled, and the stored entries of kept models are preserved
  verbatim too. "Delete this provider" is the one exception: it asks for
  confirmation, then removes the profile and the API key — an
  environment-provided key, or one shared with another provider, is kept
  (only the configuration is deleted); if the profile was removed but the
  key cleanup failed, the wizard says so and points you at the store
  (the provider itself is gone).

The **add** branch offers the following sources (the third appears only while
the bundled dsh-auth plugin is mounted):

- **Built-in provider**: pick a catalog route (openai, anthropic, deepseek, …)
  from `llm.listConfigurableProviders()`; only the API key is required. The
  baseURL can optionally be overridden (proxy gateways); the protocol and
  model catalog are inherited.
- **Custom API endpoint**: enter a route name, API key, baseURL, and the wire
  protocol (`openai-completions` / `openai-responses` / `anthropic-messages`).
  The wizard probes the endpoint with the draft credential and offers the
  advertised models for selection (manual id entry as fallback).
- **Subscription sign-in (OAuth)**: this option appears only while the bundled
  dsh-auth plugin is mounted. Pick a subscription account (ChatGPT / Claude /
  Grok, …) from the list and sign in through the browser / device-code flow —
  **no API key**. Every account carries a masked status line (signed in, with
  the token expiry, or expired); an already-signed-in account offers **Sign in
  again** (switch accounts or refresh the credential) and **Sign out** (remove
  the locally stored OAuth credential). Credential storage and route
  registration belong to dsh-auth; `/auth status|login|logout` shares the same
  source. Without the plugin the option is absent and the wizard behaves
  exactly as before; with the plugin mounted but no OAuth-capable provider,
  the wizard says so.

What gets written/removed (on a profile start, where dsh-base provides the
settings/credentials services):

| Artifact | Location |
| --- | --- |
| Provider profile | `llm-pi-ai.providers.<route>` in `~/.dsh/settings.yaml`; the route registers on write and unregisters on delete |
| API key | `~/.dsh/.credentials.yaml` (mode 0600), referenced as `<ROUTE>_API_KEY` |

Key answers render as `••••••` in the transcript; when the process environment
already provides the same-named variable, the write is skipped and the value
resolves from the environment at request time (deletion never touches it). The
configuration is shared with the dsh web UI's Models settings page (same
settings section). A bare `dsh --config cordis.yml` start lacks these services
and `/provider` reports itself unavailable. After adding or editing, run
`/model` to switch to the route's models.

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
