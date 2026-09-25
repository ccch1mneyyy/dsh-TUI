# Configuration

[Documentation index](README.md) · [简体中文](configuration.md)

## Profiles and patch layers

After an npm/profile installation, user configuration lives at:

```text
$DSH_HOME/profiles/dsh-tui/cordis.patch.yml
```

When `DSH_HOME` is unset, it normally defaults to `~/.dsh`. The file is a
top-level YAML array and may use the `!!js` expressions supported by DSH.

Profile startup layers, in order:

- `dsh-base`
- Installed bundles
- The package's `cordis.patch.yml`
- The user patch (applied last)

A user configuration normally overrides an existing row by `id`; use `insert`
only for a genuinely new service.

> When a row is overridden, its `config` block is replaced as a whole. It is
> not deep-merged, so repeat every key that must remain active.

## TUI configuration

On DSH 0.1.7, `/settings` writes plugin Config fields to the active profile's
`cordis.patch.yml`. Older hosts still use `~/.dsh/settings.yaml`; that file is
not the new settings entry point. Language and layout preferences update live;
fullscreen and image previews require `/restart`.

A complete common override looks like this:

```yaml
- id: dsh-tui
  config:
    provider: deepseek-official
    model: deepseek-flash
    # Prefer leaving cwd unset — the default resolves to the git worktree
    # root containing the launch directory. To pin a fixed workspace, use an
    # absolute path (e.g. cwd: /repo/packages/app), NOT `!!js process.cwd()`
    # (that pins the workspace to the launch subdirectory, issue #96).
    effort: max
    activity: true
    activityFrames: moon8
    contextBar: true
    fullscreen: false
    terminalImages: true
    preset: !!js process.env.DSH_TUI_PRESET ?? undefined
    workspace: !!js process.env.DSH_TUI_WORKSPACE_TARGET ?? undefined
    sessionId: !!js process.env.DSH_TUI_RESUME_SESSION ?? undefined
```

| Field | Default/source | Meaning |
| --- | --- | --- |
| `provider` | Harness `agentDefaultModel`; bare compositions fall back to `deepseek-official` | DSH model route; provider and model must both be set to form an explicit route |
| `model` | Harness `agentDefaultModel`; bare compositions fall back to `deepseek-flash` | Startup model; `/model` can switch through a session fork |
| `cwd` | git worktree root containing the launch directory (`process.cwd()` when outside any worktree; a dotfiles repo at `$HOME` does not count) | TUI-side session workspace: agent meta, `@` completion/mention expansion, /resume filtering, statusline; resuming an existing session adopts that session's persisted cwd. Note the bash/fs-policy/sandbox roots are still owned by the composition layer's cordis config (default: the launch directory, governed by dsh-base) and may differ from this session-side cwd |
| `workspace` | unset | Startup workspace target: a local path, `file://` URL, or plugin-provided URI; takes precedence over `cwd` |
| `effort` | normally `max` in the bundle | Reasoning effort applied to every request (validated against the runtime model's levels; invalid levels silently fall back to the adapter default), also shown in the header at startup. Precedence: /settings `effortDefault` (`auto` defers) > this field > the persisted `/effort` choice (`~/.dsh-tui/effort.json`) > the model default |
| `effortDefault` | unset | Default reasoning effort for new sessions; `auto` defers to `effort`; editable through `/settings` |
| `whale` / `whaleIdle` | `true` / `true` | Header whale and welcome-page idle animation |
| `minimal` | `false` | Reduce header decoration and colors |
| `modes` | built-in trio | Shift+Tab session-mode cycle (plan/sandbox/approval atom bundles); defaults to default → plan → full-access |
| `activity` | `true` | Show the live activity row |
| `activityFrames` | `moon8` | Activity animation preset; `/activity` changes it at runtime. A legacy saved value of `claude` is read as `moon8`, and the picker no longer offers that legacy preset |
| `contextBar` | `true` | Segmented context-usage bar below the input box; `false` hides the row. Both this and `/settings → statusBar.contextBar` (also on by default) must be on for it to render |
| `fullscreen` | `true` (factory default since 0.9.0) | `true` uses the alternate screen, app scrolling, and mouse selection; `false` uses inline mode |
| `terminalImages` | `true` | Allow previews in supported terminals; `false` keeps text metadata and skips image probing and preview decoding. Restart to apply changes |
| `preset` | roster default `standard` | Agent preset for new sessions; explicit configuration wins over persisted preference |
| `sessionId` | unset | Session to resume, normally injected by the Windows `--resume` launcher |

### Precedence and force-off

- `/settings → Terminal image previews` overrides `config.terminalImages`.
- Without a saved choice, the config value applies and defaults to on.
- Enabling still needs Kitty graphics support and a display mode that allows
  image rendering.
- `DSH_TUI_DISABLE_TERMINAL_IMAGES=1` always forces previews off.
- Disabled previews do not read or decode image data or send image rendering
  commands; sending images to the model is unaffected.
- The checkbox edits the preview preference; an environment override is shown
  separately as “Image previews (forced off)” in the settings list.

### Restart

- This switch is read at startup.
- Use `/restart` after changing it to restart the TUI and resume the current
  session; `/reload` does not apply it.
- If a turn is running, wait for it to finish or stop it with `Ctrl+C` before
  restarting.

## Diagnostic environment variables

The following variables are for diagnostics or experimental terminal
integration. They are all off by default and take effect only when explicitly
set:

| Variable | Purpose |
| --- | --- |
| `DSH_TUI_DEBUG_REPAINTS=1` | Record repaint diagnostics |
| `DSH_TUI_COMMIT_LOG=1` | Record render-commit diagnostics |
| `DSH_TUI_ACCESSIBILITY=1` | Enable accessibility related display paths |
| `DSH_TUI_TMUX_TRUECOLOR=1` | Enable the truecolor detection path in tmux |
| `DSH_TUI_TAB_STATUS=1` | Experimental terminal tab-status opt-in; off by default, with no guarantee of support in every terminal |

Diagnostic output does not change session events or model routing. Enable
only the variable needed for the terminal or rendering issue being
investigated.

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

Each session composes its model-visible tools and prompt through the official
preset registry: `@deepseek-ai/dsh-agent-preset-registry` on 0.1.7, or
`@deepseek-ai/dsh-agent-presets` on older hosts:

| ID | Name | Capability |
| --- | --- | --- |
| `standard` | Standard (default) | Editing, shell, search, skills, planning, goals, subagents, and workflows |
| `ptc` (0.1.2) / `code` (legacy 0.1.1) | PTC | Standard plus the PTC SDK presentation for composing operations in TypeScript; both names resolve compatibly across versions |
| `minimal` | Minimal | Persistent Bash and `str_replace_editor` only, without compaction |
| `cordis` | Creation | Standard plus runtime inspection and plugin-experimentation tools |
| `liangshen` | Liangshen mode | Minimal's two-tool surface first for root and delegated agents, the full catalog after the first tool call, and a fresh anchor after compaction |

### Selecting and switching

- `/preset` opens the picker.
- `/preset <id>` selects directly; `/preset status` reports the current state.
- Picker names and descriptions come from registry declarations (from
  `preset.yml` on older hosts).
- Under the `en` UI language (`/lang en`), the built-in presets show localized
  English names and descriptions.
- Built-in presets: `standard` / `minimal` / `ptc` (legacy `code`) / `cordis` / `liangshen`;
  custom presets are shown as-is.
- A blank session can switch in place. Once a conversation has started, the
  official blank-only rule stores the choice as the new default for `/new` or
  the next launch.

### Default and precedence

- The default is stored in `~/.dsh-tui/agent-preset.json`.
- Precedence: explicit `config.preset` or `DSH_TUI_PRESET`, then persisted
  preference, then the roster default `standard`.
- A legacy `code` preference resolves to `ptc` when the active roster no
  longer provides `code`, then migrates after that successful resolution;
  rc rosters keep their real `code` id, and session logs are never rewritten.
- Resuming a session restores the preset recorded in that session's log and
  does not overwrite it with the current default.

### Liangshen mode

- Liangshen mode ships with dsh-tui. On 0.1.7 it registers with the official
  registry; an existing profile declaration with the same id takes precedence.
  Older hosts install it into the user preset root, preserving unmanaged directories.
- The first-round `bash` on Windows runs an auto-discovered Git Bash, trying
  in order:
  - The installation tree of a `git.exe` found on PATH (covers installer,
    portable, and Scoop layouts; Scoop shims are followed)
  - Conventional install roots and Scoop's conventional directories
  - Bare `bash` on PATH (final fallback)
  - It never accepts the System32 WSL launcher as Git Bash
- Set `DSH_TUI_LIANGSHEN_BASH_PATH` to an absolute `bash.exe` path to pin it.
- The pin is the only candidate; a miss warns and skips registration, exposing
  the full tool catalog on the first round.

### Custom presets

On 0.1.7, declare `@deepseek-ai/dsh-agent-preset` through a profile/bundle with
`id`, `name`, and `plugins` in its config. Migrate old directory presets to
bundles using the upstream workflow; TUI no longer scans directories itself.
Older hosts still discover `$DSH_HOME/.agent-presets/<name>/agent.cordis.yml`.

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
| `DSH_HOME` | Harness home (profiles, sessions, credentials, attachments); falls back to the upstream default `~/.dsh` |
| `DSH_TUI_PERSONA` | Override the Agent persona injected by the composition |
| `DSH_TUI_PRESET` | Override the default Agent preset for new sessions |
| `DSH_TUI_THEME` | Pin a built-in (`auto`/`light`/`dark`/`dark-ansi`), static theme, or registered plugin theme ahead of persisted selection |
| `DSH_TUI_DISABLE_MOUSE` | Temporarily disable mouse handling in fullscreen mode |
| `DSH_TUI_DISABLE_TERMINAL_IMAGES` | Set to `1` to force Kitty/Sixel probing, preview reads/decoding, and terminal image rendering off, overriding config and /settings; text metadata remains visible |
| `DSH_TUI_IMAGE_PROTOCOL` | `auto` (default), `kitty`, `sixel`, or `none`; override protocol selection without bypassing the preview preference, disable switch, non-fullscreen, accessibility or multiplexer guards |
| `DSH_TUI_RESUME_SESSION` | Resume a session at startup, normally set by a launcher |
| `DSH_TUI_WORKSPACE_TARGET` | Workspace path or URI resolved at startup, normally set by `dsh-tui <target>` |
| `DSH_TUI_SESSION_ROOT` | Override the JSONL session root; profile default `$DSH_HOME/sessions`, bare `cordis.yml` default `~/.dsh-tui/sessions` |
| `DSH_PERMISSION_MODE` | Override non-Windows sandbox policy, such as `workspace-write` or `danger-full-access` |
| `DSH_TUI_WORKSPACE` | Working directory used by the Windows `dsh-tui.cmd` launcher |
| `DSH_TUI_DEBUG` | Enable dsh-tui diagnostics on stderr |
| `DSH_TUI_RENDER_LOG` | File path for raw ANSI frame capture |

The old `CC_TUI_*` and `DSH_CC_*` names come from earlier release naming and
are no longer read as of this release; use the `DSH_TUI_*` prefix.

Two directories are involved and neither substitutes for the other:

- **Harness home**: `$DSH_HOME`, falling back to the upstream default `~/.dsh`.
  Holds profiles, sessions, credentials, and attachments. Early releases pinned
  it to `~/.dsh-cc`.
- **TUI data directory**: `~/.dsh-tui` (a fixed path, independent of
  `$DSH_HOME`). Holds `/model` (persisted at `~/.dsh-tui/model.json`, surviving
  restart and `/new`), `/lang`, `/theme` and similar preferences plus
  `resume.txt`. Early releases wrote these under `$DSH_HOME` instead.

`DSH_TUI_RENDER_LOG` may capture visible prompts, tool arguments, and output.
Do not attach it to a public issue without reviewing and redacting it.

## `/provider`: manage model providers at runtime

`/provider` opens an interactive wizard to add, edit, or delete model
providers without a restart.

- Sources: built-in catalog routes or custom API endpoints.
- Only providers written by the **user settings layer** can be edited or
  deleted; ones inherited from the composition base cannot be removed.
- Keys are written to `~/.dsh/.credentials.yaml` (mode 0600) and render as
  `••••••`.
- Only non-environment keys are written to the store; a key shared with
  another provider is kept on delete.

Where it writes:

| Artifact | Location |
| --- | --- |
| Provider profile | `llm-pi-ai.providers.<route>` in the active profile config on 0.1.7, or `~/.dsh/settings.yaml` on older hosts; the route registers on write and unregisters on delete |
| API key | `~/.dsh/.credentials.yaml` (mode 0600), referenced as `<ROUTE>_API_KEY` |

With the bundled dsh-auth plugin mounted, the add branch also offers
**Subscription sign-in (OAuth)**: sign in to ChatGPT / Claude / Grok through
the browser or device-code flow (no API key); `/auth status|login|logout`
shares the same source.

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
