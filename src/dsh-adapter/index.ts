/**
 * dsh-tui plugin entry. The TUI implementation lives in `./plugin.tsx` (its
 * render path is JSX); this module owns the plugin surface (`name`/`inject`/
 * `Config`/`apply`) at the canonical `src/index.ts` location and delegates
 * `apply` through a dynamic import so entry-scanning tooling and the Loader
 * resolve a plain `.ts` module.
 * @module @deepseek-harness-tui/dsh-tui
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { SessionModeSpec } from '../sessionModes.js'

export const name = 'dsh-tui'
// `tuiWorkspaces` must stay OUT of this code-level inject (issue #183): the
// dsh CLI resolves the bundle's cordis.patch.yml from the FIRST copy of this
// package found from its own install anchor (typically the global launcher),
// while the Loader imports the plugin module from the profile's copy. When
// the two copies skew, the patch may predate the dsh-tui-workspaces row — a
// hard inject here then deadlocks the whole tree at boot ("pending (waiting
// for service: tuiWorkspaces)"). The bundle patch keeps tuiWorkspaces in the
// row-level inject purely as an ordering guarantee when the row exists; when
// it does not, plugin.ts/channel.ts fall back to a local workspace runtime.
export const inject = ['agents']

/**
 * dsh-tui plugin configuration: session attachment, model route, working
 * directory, and display preferences.
 */
export interface Config {
  /** Existing session to attach; a fresh session is created when absent. */
  sessionId?: string
  /** LLM provider route. The route resolves atomically (issue #67): when
   *  cordis.yml names BOTH `provider` and `model`, that pair wins; otherwise
   *  the `/model` choice persisted in `~/.dsh-tui/model.json` wins whole;
   *  otherwise `agentDefaultModel` supplies the provider-neutral Harness
   *  default. A bare embedder without that service falls back to DeepSeek.
   *  A provider-only pin never half-overrides the persisted choice. */
  provider?: string
  /** Model override passed to the agent; resolved together with `provider`
   *  as one atomic route (see `provider`). */
  model?: string
  /** Session working directory. When absent, the git worktree root
   *  containing the invoking directory wins (the invoking directory itself
   *  outside any worktree) — never a bare launch subdirectory (issue #96). */
  cwd?: string
  /** Absolute local path, file URL, or provider URI resolved before the
   *  initial agent is created. */
  workspace?: string
  /** Reasoning effort applied to every request, validated against the live
   *  route's adapter levels (an unlisted level is ignored and the adapter
   *  default applies). Wins over the persisted /effort choice; also seeds
   *  the startup status line until the first request header reports the
   *  live value. */
  effort?: string
  /** Show the live working line derived in-process from base session events. */
  activity?: boolean
  /** Working-activity indicator preset: `claude`/`moon`/`comet`/`dots`/…
   *  or `random` (see activityFrames.ts). When absent, the `/activity`
   *  choice persisted in `~/.dsh-tui/working-activity.json` wins, then the
   *  `claude` default. */
  activityFrames?: string
  /** Show the segmented context bar (the band under the input with the
   *  `ctx used/window` readout) in the status footer; off hides that row
   *  while the status/mode lines stay (issue #29). */
  contextBar?: boolean
  /** Run in the terminal's alternate screen (Claude Code fullscreen layout). */
  fullscreen?: boolean
  /** UI language: `en` / `zh`. When absent, the `DSH_TUI_LANG` env var wins,
   *  then the `/lang` choice persisted in `~/.dsh-tui/lang.json`, then `zh`. */
  lang?: string
  /** Agent preset id new sessions compose from (standard/code/minimal/
   *  cordis/… when the roster is mounted). When absent, the `/preset` choice
   *  persisted in `~/.dsh-tui/agent-preset.json` wins, then the roster
   *  default (`standard`). */
  preset?: string
  /** Edit/Write diff presentation: `auto` picks side-by-side on wide
   *  terminals (≥110 cols) and unified below; `split`/`unified` force one
   *  layout. Editable live from the `/settings` screen. */
  diffLayout?: 'auto' | 'split' | 'unified'
  /** Thinking-block display: `preview` (default) streams a 2-3 line live
   *  preview and folds each step when it settles; `full` keeps thinking
   *  expanded until the whole turn ends. Editable live from `/settings`. */
  thinkingFold?: 'preview' | 'full'
  /** Shift+Tab session-mode cycle (array order IS the cycle order; index 0
   *  is the unmarked base mode). Each entry bundles any subset of the
   *  `plan`/`sandbox`/`approval` atoms; absent → the built-in
   *  default/plan/full cycle (see sessionModes.ts). */
  modes?: SessionModeSpec[]
}

export const Config: Schema<Config> = Schema.object({
  sessionId: Schema.string().required(false),
  // No schema defaults on the route: a `.default()` here would make an
  // unset key indistinguishable from an explicit cordis.yml choice and the
  // persisted `/model` preference could never win (issue #30). The defaults
  // live at the end of the fallback chain in modelRoute.ts instead.
  provider: Schema.string().required(false),
  model: Schema.string().required(false),
  cwd: Schema.string().required(false),
  workspace: Schema.string().required(false),
  effort: Schema.string().required(false),
  activity: Schema.boolean().default(true),
  activityFrames: Schema.string().required(false),
  contextBar: Schema.boolean().default(true),
  fullscreen: Schema.boolean().default(false),
  lang: Schema.string().required(false),
  preset: Schema.string().required(false),
  diffLayout: Schema.union(['auto', 'split', 'unified']).default('auto'),
  thinkingFold: Schema.union(['preview', 'full']).default('preview'),
  modes: Schema.array(
    Schema.object({
      id: Schema.string(),
      label: Schema.string().required(false),
      plan: Schema.boolean().required(false),
      sandbox: Schema.union(['read-only', 'workspace-write', 'danger-full-access']).required(false),
      approval: Schema.union(['ask', 'never']).required(false),
    }),
  ).required(false),
})

/**
 * Start the interactive TUI front door, delegating to the JSX implementation
 * in `./plugin.tsx` (see its module doc for the full contract).
 * @param ctx - the plugin context.
 * @param config - the validated dsh-tui configuration.
 * @returns a promise settling when the TUI teardown completes.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const { upstreamDrift, UPSTREAM_VALIDATED_VERSION } = await import('./contract.js')
  for (const entry of upstreamDrift()) {
    console.warn(
      `[dsh-tui] upstream drift: ${entry.package} installed=${entry.installed ?? 'missing'} ` +
      `validated=${UPSTREAM_VALIDATED_VERSION} — the TUI was validated against ` +
      `${UPSTREAM_VALIDATED_VERSION}; upgrade the profile when upstream is bumped.`,
    )
  }
  const { apply: ccTuiApply } = await import('./plugin.js')
  return ccTuiApply(ctx, config)
}
