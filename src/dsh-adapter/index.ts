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
import { DEFAULT_STATUS_BAR, type ScrollGutterMode, type StatusBarConfig, type ToolBackground } from '../tuiDisplayPrefs.js'
import { SHORTCUT_ACTIONS, type ShortcutActionId } from '../utils/keymap.js'

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
  /** Run in the terminal's alternate screen (Claude Code fullscreen layout).
   *  Defaults to true — the fullscreen surface is the more complete one
   *  (mouse, timeline rail, scrollbar gutter, selection copy), so fresh
   *  installs start there; cordis.yml `fullscreen: false` or a /settings
   *  toggle opts back into the inline main-screen layout. */
  fullscreen?: boolean
  /** UI language: `en` / `zh`. When absent, the `DSH_TUI_LANG` env var wins,
   *  then the `/lang` choice persisted in `~/.dsh-tui/lang.json`, then `zh`. */
  lang?: string
  /** Agent preset id new sessions compose from (standard/ptc/minimal/
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
  /** Tool-card background strength; defaults to no added background. */
  toolBackground?: ToolBackground
  /** What the fullscreen transcript's right gutter shows (settings
   *  `dsh-tui.scrollGutter`): `timeline` turn rail (default), `scrollbar`
   *  proportional thumb, or `hidden`. */
  scrollGutter?: ScrollGutterMode
  /** Terminal-card header folding (settings `dsh-tui.foldTerminalCommand`):
   *  `true` collapses a multi-line command title to its first line plus a
   *  `+N lines` hint; Ctrl+O / clicking the card expands it. Default off —
   *  the full title keeps rendering. */
  foldTerminalCommand?: boolean
  /** Show the session name as a chip on the prompt top border's right side
   *  (settings `dsh-tui.promptSessionLabel`); off by default. */
  promptSessionLabel?: boolean
  /** Fullscreen draft editor (settings `dsh-tui.expandEditor`): the ⛶
   *  affordance in the input row and the expandEditor shortcut (default
   *  Ctrl+Shift+E) expand the draft into a whole-screen editor. On by
   *  default; off removes both entry points. */
  expandEditor?: boolean
  /** Smooth streaming reveal (settings `dsh-tui.smoothStreaming`): live
   *  assistant text, expanded thinking, and tool call bodies paint through
   *  a ~30fps reveal instead of jumping per provider burst — bursty or
   *  one-shot deliveries read as an even flow. On by default. */
  smoothStreaming?: boolean
  /** Status-footer field visibility and compact presentation preferences. */
  statusBar?: Partial<StatusBarConfig>
  /** Built-in action-shortcut overrides (`paste: 'alt+v'`), keyed by action
   *  id (see src/utils/keymap.ts). Combos are `ctrl+`/`alt+`/`shift+` plus a
   *  key; several combos may be comma-separated. Unset actions keep their
   *  defaults; the `/settings` screen edits the same keys live (its user
   *  layer wins over this file). */
  shortcuts?: Partial<Record<ShortcutActionId, string>>
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
  fullscreen: Schema.boolean().default(true),
  lang: Schema.string().required(false),
  preset: Schema.string().required(false),
  diffLayout: Schema.union(['auto', 'split', 'unified']).default('auto'),
  thinkingFold: Schema.union(['preview', 'full']).default('preview'),
  toolBackground: Schema.union(['none', 'subtle', 'strong']).default('none'),
  scrollGutter: Schema.union(['timeline', 'scrollbar', 'hidden']).default('timeline'),
  foldTerminalCommand: Schema.boolean().default(false),
  promptSessionLabel: Schema.boolean().default(false),
  expandEditor: Schema.boolean().default(true),
  smoothStreaming: Schema.boolean().default(true),
  statusBar: Schema.object({
    compact: Schema.boolean().default(DEFAULT_STATUS_BAR.compact),
    model: Schema.boolean().default(DEFAULT_STATUS_BAR.model),
    thinking: Schema.boolean().default(DEFAULT_STATUS_BAR.thinking),
    cwd: Schema.boolean().default(DEFAULT_STATUS_BAR.cwd),
    contextUsage: Schema.boolean().default(DEFAULT_STATUS_BAR.contextUsage),
    cache: Schema.boolean().default(DEFAULT_STATUS_BAR.cache),
    tokens: Schema.boolean().default(DEFAULT_STATUS_BAR.tokens),
    tps: Schema.boolean().default(DEFAULT_STATUS_BAR.tps),
    gitBranch: Schema.boolean().default(DEFAULT_STATUS_BAR.gitBranch),
    sessionTitle: Schema.boolean().default(DEFAULT_STATUS_BAR.sessionTitle),
    sessionId: Schema.boolean().default(DEFAULT_STATUS_BAR.sessionId),
    goal: Schema.boolean().default(DEFAULT_STATUS_BAR.goal),
    mode: Schema.boolean().default(DEFAULT_STATUS_BAR.mode),
    contextBar: Schema.boolean().default(DEFAULT_STATUS_BAR.contextBar),
    activity: Schema.boolean().default(DEFAULT_STATUS_BAR.activity),
    trajectory: Schema.boolean().default(DEFAULT_STATUS_BAR.trajectory),
    shortcutHint: Schema.boolean().default(DEFAULT_STATUS_BAR.shortcutHint),
  }).default({ ...DEFAULT_STATUS_BAR }),
  // One optional combo string per customizable action (no defaults: unset
  // keeps the built-in binding; see Config.shortcuts).
  shortcuts: Schema.object(
    Object.fromEntries(SHORTCUT_ACTIONS.map(action => [action.id, Schema.string().required(false)])),
  ).required(false),
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
  // Upstream drift is NO LONGER spammed to stderr here: per-package
  // console.warn lines interleave with the TUI frame redraw and arrive
  // garbled (typewriter animation repaints over them). The merged,
  // natural-language notice now renders in the logo header under the
  // startup tip (LogoV2 ← upstreamDriftSummary); CI keeps the hard gate
  // via scripts/verify-upstream-contract.ts.
  const { apply: ccTuiApply } = await import('./plugin.js')
  return ccTuiApply(ctx, config)
}
