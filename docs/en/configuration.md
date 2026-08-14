<p align="center">
  <a href="../zh/configuration.md">简体中文</a> | <strong>English</strong>
</p>

[← Documentation index](../Index_EN.md)

# Configuration (`profile/cordis.patch.yml`)

Under the official profile model there is no standalone `cordis.yml` startup file. The
`$DSH_HOME/profiles/cc-tui/` directory contains only `cordis.patch.yml`, your patch layer represented
as a top-level YAML array with `!!js` support. The examples below show how to make common changes;
they are not a complete configuration:

```yaml
# Override a line's config. This replaces the whole block, so repeat every key you want to keep.
- id: cc-tui
  config:
    provider: deepseek-official   # LLM route
    model: deepseek-v4-flash      # Model
    effort: max                   # Reasoning effort shown in the header/status bar at startup
    activity: true                # Live activity line (enabled by default)
    activityFrames: claude        # Indicator preset: claude/moon/comet/dots/.../random
    cwd: !!js process.cwd()       # Working directory
    fullscreen: false             # Alternate-screen fullscreen mode (disabled by default)
    preset: !!js process.env.CC_TUI_PRESET ?? undefined  # Agent preset (see below)
    sessionId: !!js process.env.DSH_CC_RESUME_SESSION ?? undefined  # --resume

# Tune the live activity data source shared with the Web UI. The bundle patch inserts this line
# automatically, so override its config by ID instead of inserting another line.
# A 500 ms interval keeps the status timer responsive and is already the cc-tui default.
- id: working-activity
  config:
    publishIntervalMs: 500
```

Dependencies, all supplied by the dsh-base layer unless noted otherwise: llm-deepseek with thinking
enabled, session with SQLite persistence inserted by this package's patch, bash, fs,
**commands (the command registry) + command-goal (`/goal`)**, token-meter, and
dsh-working-activity for the live activity line. Since version 0.3, model-side tool and prompt lines
(tool-fs, tool-todo, subagent, plan-mode, compaction-basic, and others) are assembled by the session's
agent preset instead of being mounted at the host layer.

> Configuration note: when overriding `plan-mode`, `section` must be non-empty or the whole tree will
> fail to load. The core `subagent` service must be mounted before its spawn/fork lines. The base
> layer already guarantees this order; preserve it when inserting related lines yourself.
