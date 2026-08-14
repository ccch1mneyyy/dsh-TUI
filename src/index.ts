/**
 * cc-tui plugin entry. The TUI implementation lives in `./plugin.tsx` (its
 * render path is JSX); this module owns the plugin surface (`name`/`inject`/
 * `Config`/`apply`) at the canonical `src/index.ts` location and delegates
 * `apply` through a dynamic import so entry-scanning tooling and the Loader
 * resolve a plain `.ts` module.
 * @module @deepseek-ai/dsh-cc-tui
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'cc-tui'
export const inject = ['agents']

/**
 * cc-tui plugin configuration: session attachment, model route, working
 * directory, and display preferences.
 */
export interface Config {
  /** Existing session to attach; a fresh session is created when absent. */
  sessionId?: string
  /** LLM provider route; the harness `deepseek-official` route by default. */
  provider?: string
  /** Model override passed to the agent (adapter default when absent). */
  model?: string
  /** Session working directory; defaults to the invoking directory. */
  cwd?: string
  /** Configured reasoning effort, displayed from startup (the live value
   *  from request headers replaces it once the first turn runs). */
  effort?: string
  /** Show the dsh-working-activity live working line on the status bar
   *  (consumes its log-only `activity/status` events; off hides it). */
  activity?: boolean
  /** Working-activity indicator preset: `claude`/`moon`/`comet`/`dots`/…
   *  or `random` (see activityFrames.ts). When absent, the `/activity`
   *  choice persisted in `~/.dsh-cc/working-activity.json` wins, then the
   *  `claude` default. */
  activityFrames?: string
  /** Run in the terminal's alternate screen (Claude Code fullscreen layout). */
  fullscreen?: boolean
  /** Agent preset id new sessions compose from (standard/code/minimal/
   *  cordis/… when the roster is mounted). When absent, the `/preset` choice
   *  persisted in `~/.dsh-cc/agent-preset.json` wins, then the roster
   *  default (`standard`). */
  preset?: string
}

export const Config: Schema<Config> = Schema.object({
  sessionId: Schema.string().required(false),
  provider: Schema.string().default('deepseek-official'),
  model: Schema.string().default('deepseek-v4-flash'),
  cwd: Schema.string().required(false),
  effort: Schema.string().required(false),
  activity: Schema.boolean().default(true),
  activityFrames: Schema.string().required(false),
  fullscreen: Schema.boolean().default(false),
  preset: Schema.string().required(false),
})

/**
 * Start the interactive TUI front door, delegating to the JSX implementation
 * in `./plugin.tsx` (see its module doc for the full contract).
 * @param ctx - the plugin context.
 * @param config - the validated cc-tui configuration.
 * @returns a promise settling when the TUI teardown completes.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const { apply: ccTuiApply } = await import('./plugin.js')
  return ccTuiApply(ctx, config)
}
