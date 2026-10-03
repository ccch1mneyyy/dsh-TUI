/**
 * dsh-tui plugin entry. The TUI implementation lives in `./plugin.tsx` (its
 * render path is JSX); this module owns the plugin surface (`name`/`inject`/
 * `Config`/`apply`) at the package entry module and delegates
 * `apply` through a dynamic import so entry-scanning tooling and the Loader
 * resolve a plain `.ts` module.
 * @module @deepseek-harness-tui/dsh-tui
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { SessionModeSpec } from '../sessionModes.js'
import { DEFAULT_COMPANION_SKIN, DEFAULT_SIDE_PANEL_IDS, DEFAULT_STATUS_BAR, normalizeCompanionSkin, normalizePageMargin, normalizeSidePanelPanels, normalizeSidePanelRatio, type ImageBacking, type MathImageBacking, type MathImageScale, type MathRendering, type PageMarginSetting, type ScrollGutterMode, type StatusBarConfig, type ToolBackground } from '../tuiDisplayPrefs.js'
import { SHORTCUT_ACTIONS, type ShortcutActionId } from '../utils/keymap.js'
import { normalizeSplashFont, type SplashFontSetting } from '../components/splashFonts.js'
import { editableConfig, type RuntimeConfig } from './compat/settings.js'
import { EDITABLE_CONFIG_KEYS } from '../settings/definitions.js'

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
  /** Settings default for future sessions; overrides the `effort` fallback. */
  effortDefault?: string
  /** Show the header whale and its idle animation. */
  whale?: boolean
  whaleIdle?: boolean
  /** Big-text face on the header splash (settings `dsh-tui.splashFont`):
   *  `daily` (the default) rotates by local date, any other value is a font
   *  id from `components/splashFonts.ts` (`bold`/`square`/…) pinning that one
   *  face. An unknown value falls back to `daily`. */
  splashFont?: SplashFontSetting
  /** Swap the header's pixel whale for the static maid portrait. */
  whaleGirl?: boolean
  /** Reduce decorative header content and colors. */
  minimal?: boolean
  /** Show the live working line derived in-process from base session events. */
  activity?: boolean
  /** Working-activity indicator preset (`moon8`/`moon`/`comet`/`dots`/…
   *  or `random`; see activityFrames.ts). When absent, the `/activity`
   *  choice persisted in `~/.dsh-tui/working-activity.json` wins, then the
   *  `moon8` default. */
  activityFrames?: string
  /** Show the segmented context bar (the band under the input with the
   *  `ctx used/window` readout) in the status footer; off hides that row
   *  while the status/mode lines stay (issue #29). */
  contextBar?: boolean
  /** Run in the terminal's alternate screen (full-screen terminal layout).
   *  Defaults to true — the fullscreen surface is the more complete one
   *  (mouse, timeline rail, scrollbar gutter, selection copy), so fresh
   *  installs start there; cordis.yml `fullscreen: false` or a /settings
   *  toggle opts back into the inline main-screen layout. */
  fullscreen?: boolean
  /** Allow terminal image previews when supported (default true). Saved
   *  /settings choices override this value after restart. The environment
   *  override DSH_TUI_DISABLE_TERMINAL_IMAGES can always force previews off. */
  terminalImages?: boolean
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
  /** Edit/Write diff look: `default` −/+ rows, or `bars` (▌
   *  bars + tinted rows). Editable live from `/settings`. */
  diffStyle?: 'default' | 'bars'
  /** Thinking-block display: `preview` (default) streams a 2-3 line live
   *  preview and folds each step when it settles; `full` keeps thinking
   *  expanded until the whole turn ends. Editable live from `/settings`. */
  thinkingFold?: 'preview' | 'full'
  /** Grouping/folding of consecutive background-job cards: `auto` (default)
   *  groups any run of ≥2 adjacent job cards and folds a run of 3+ into its
   *  summary line once every member settled; `always` folds any run of 2+
   *  immediately; `never` never folds on its own (a click on the group
   *  header still folds one run). Editable live from `/settings`. */
  jobGroupFold?: 'auto' | 'always' | 'never'
  /** Tool-card background strength; defaults to no added background. */
  toolBackground?: ToolBackground
  /** What the fullscreen transcript's right gutter shows (settings
   *  `dsh-tui.scrollGutter`): `timeline` turn rail (default), `scrollbar`
   *  proportional thumb, or `hidden`. */
  scrollGutter?: ScrollGutterMode
  /** Root page inset (settings `dsh-tui.pageMargin`): a preset name
   *  (`none` / `slim` / `normal` (default) / `roomy`) or a custom `NxM`
   *  spec (columns per side × rows top/bottom) that insets the whole UI
   *  from the terminal edges. Terminals without their own viewport padding
   *  (bare WSL, tmux, SSH) otherwise hug the screen border. */
  pageMargin?: PageMarginSetting
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
  /** Mermaid diagrams (settings `dsh-tui.mermaidDiagrams`): ```mermaid
   *  fences in replies render as Unicode box-drawing art — flowcharts,
   *  sequence/state/class/ER diagrams, pie, mindmap, timeline, gitGraph —
   *  laid out in-process, no browser or image protocol. A diagram wider
   *  than the viewport or of an unsupported type keeps the fenced source.
   *  On by default; off always shows the source. */
  mermaidDiagrams?: boolean
  /** LaTeX math (settings `dsh-tui.mathRendering`): `$…$` / `\(…\)` inline
   *  and `$$…$$` / `\[…\]` blocks in replies. `auto` (default) uses the best
   *  available renderer — today Unicode text: Greek and operator symbols,
   *  scripts, fractions and operator limits stacked in display blocks,
   *  matrices, cases; `unicode` pins it; `source` always shows the TeX.
   *  Unsupported, still-streaming, or too-wide formulas keep their source. */
  mathRendering?: MathRendering
  /** Display-formula image size (settings `dsh-tui.mathImageScale`), used
   *  with `mathRendering: image`: `auto` matches the body text, `large` and
   *  `xlarge` set display math bigger — which also hands the terminal more
   *  device pixels per stroke, the only sharpness lever a terminal image has.
   *  Inline formulas keep the base scale. */
  mathImageScale?: MathImageScale
  /** Formula-image backing (settings `dsh-tui.mathImageBacking`): `transparent`
   *  paints only the formula and lets the terminal background show through;
   *  `terminal` composites it onto the terminal's background colour. */
  mathImageBacking?: MathImageBacking
  /** Transcript-image backing (settings `dsh-tui.imageBacking`): `transparent`
   *  floats photos and illustrations on whatever the terminal shows;
   *  `terminal` composites them onto the terminal's background colour. */
  imageBacking?: ImageBacking
  /** @deprecated Use `mathRendering`; `false` still means `source`. */
  latexMath?: boolean
  /** Auto recap on open (settings `dsh-tui.recapOnOpen`): opening or resuming a
   *  session summarizes its recent activity into a dim line at the bottom of
   *  the transcript. On by default; off leaves `/recap` as the manual path. */
  recapOnOpen?: boolean
  /** Status-footer field visibility and compact presentation preferences. */
  statusBar?: Partial<StatusBarConfig>
  /** Side panel (settings `dsh-tui.sidePanel.*`): the two-column layout's
   *  master switch, its startup state, the chat-column fraction, and the
   *  enabled panels in PanelBar order. Every member is normalized at parse
   *  time, so a hand-edited value can never wedge the layout. */
  sidePanel?: {
    /** Master switch of the split layout; on by default. Off makes /panel
     *  and Ctrl+B fall back to the fullscreen panels. */
    splitEnabled?: boolean
    /** Whether a session opens with the sidebar expanded (off by default, so
     *  the upgrade leaves the layout alone); Ctrl+B toggles it live. */
    open?: boolean
    /** Chat column as a fraction of the content width, clamped to 0.1–0.95
     *  (default 0.68); +/- while the panel is focused nudges it live. */
    ratio?: number
    /** Enabled panel ids, comma-separated, in PanelBar order (default
     *  `todo,jobs,agents`; add `companion` to enable the pet panel). A
     *  malformed id is dropped, an unknown one survives for a plugin. */
    panels?: string
  }
  /** Companion pet (settings `dsh-tui.companion.*`): which skin the panel
   *  pet wears. */
  companion?: {
    /** 'deepy' (default, the deepy whale kit) or 'whale' (the splash's
     *  layered pixel whale). Unknown ids normalize to deepy. */
    skin?: string
  }
  /** Built-in action-shortcut overrides (`paste: 'alt+v'`), keyed by action
   *  id (see the keymap utility). Combos are `ctrl+`/`alt+`/`shift+` plus a
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

export const Config: Schema<Config, RuntimeConfig<Config>> = editableConfig<Config>(Schema.object({
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
  effortDefault: Schema.string().required(false),
  whale: Schema.boolean().default(true),
  whaleIdle: Schema.boolean().default(true),
  // The face registry grows with new releases, so this is a transform rather
  // than a union: any string parses and junk lands on `daily` at parse time
  // (a union would fail the whole boot on a stale id). The `/settings` field
  // offers exactly the registry's ids. The default is deliberately NOT a
  // `.default()` here — the volatile wrapper swallows it (same shape as
  // pageMargin, whose unset value also reads `undefined`), so `daily` comes
  // from `normalizeSplashFont` at every read site.
  splashFont: Schema.transform(
    Schema.string(),
    value => normalizeSplashFont(value),
  ),
  whaleGirl: Schema.boolean().default(false),
  minimal: Schema.boolean().default(false),
  activity: Schema.boolean().default(true),
  activityFrames: Schema.string().required(false),
  contextBar: Schema.boolean().default(true),
  fullscreen: Schema.boolean().default(true),
  terminalImages: Schema.boolean().default(true),
  lang: Schema.string().required(false),
  preset: Schema.string().required(false),
  diffLayout: Schema.union(['auto', 'split', 'unified']).default('auto'),
  diffStyle: Schema.union(['default', 'bars']).default('default'),
  thinkingFold: Schema.union(['preview', 'full']).default('preview'),
  jobGroupFold: Schema.union(['auto', 'always', 'never']).default('auto'),
  toolBackground: Schema.union(['none', 'subtle', 'strong']).default('none'),
  scrollGutter: Schema.union(['timeline', 'scrollbar', 'hidden']).default('timeline'),
  // Preset names AND custom `NxM` specs must survive validation (a custom
  // spec is not a fixed union member); junk is normalized to `normal` by
  // the transform, so every parsed config carries a valid setting.
  pageMargin: Schema.transform(
    Schema.string().default('normal'),
    value => normalizePageMargin(value),
  ),
  foldTerminalCommand: Schema.boolean().default(false),
  promptSessionLabel: Schema.boolean().default(false),
  expandEditor: Schema.boolean().default(true),
  smoothStreaming: Schema.boolean().default(true),
  mermaidDiagrams: Schema.boolean().default(true),
  mathRendering: Schema.union(['auto', 'image', 'unicode', 'source']),
  mathImageScale: Schema.union(['auto', 'large', 'xlarge']),
  mathImageBacking: Schema.union(['transparent', 'terminal']),
  imageBacking: Schema.union(['transparent', 'terminal']),
  latexMath: Schema.boolean(),
  // No `.default()` on purpose (the volatile wrapper swallows it; same rule as
  // splashFont): an unset key must stay distinguishable from an explicit
  // `false`, and the read site already treats undefined as on
  // (`describe().value.recapOnOpen !== false`, see channel.ts).
  recapOnOpen: Schema.boolean(),
  statusBar: Schema.object({
    compact: Schema.boolean().default(DEFAULT_STATUS_BAR.compact),
    model: Schema.boolean().default(DEFAULT_STATUS_BAR.model),
    thinking: Schema.boolean().default(DEFAULT_STATUS_BAR.thinking),
    cwd: Schema.boolean().default(DEFAULT_STATUS_BAR.cwd),
    contextUsage: Schema.boolean().default(DEFAULT_STATUS_BAR.contextUsage),
    cache: Schema.boolean().default(DEFAULT_STATUS_BAR.cache),
    tokens: Schema.boolean().default(DEFAULT_STATUS_BAR.tokens),
    // Session cost estimate (≈¥) beside the token totals; StatusLine gates the
    // chip on it. The slot must be declared here: schemastery drops an
    // undeclared key on the way back in, so the /settings row would read
    // "(unset)" and every edit would silently revert.
    cost: Schema.boolean().default(DEFAULT_STATUS_BAR.cost),
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
  // Side-panel preferences, same shape as statusBar: every member carries a
  // default so an unset cordis.yml block and a partially hand-written one
  // both resolve, and the transforms keep junk (a string ratio, an id with
  // illegal characters) out of the live stores.
  sidePanel: Schema.object({
    splitEnabled: Schema.boolean().default(true),
    open: Schema.boolean().default(false),
    ratio: Schema.transform(
      Schema.number().default(0.68),
      value => normalizeSidePanelRatio(value),
    ),
    panels: Schema.transform(
      Schema.string().default(DEFAULT_SIDE_PANEL_IDS),
      value => normalizeSidePanelPanels(value),
    ),
  }).default({ splitEnabled: true, open: false, ratio: 0.68, panels: DEFAULT_SIDE_PANEL_IDS }),
  companion: Schema.object({
    skin: Schema.transform(
      Schema.string().default(DEFAULT_COMPANION_SKIN),
      value => normalizeCompanionSkin(value),
    ),
  }).default({ skin: DEFAULT_COMPANION_SKIN }),
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
      permission: Schema.string().required(false),
    }),
  ).required(false),
}), EDITABLE_CONFIG_KEYS as readonly (keyof Config)[])

/**
 * Start the interactive TUI front door, delegating to the JSX implementation
 * in `./plugin.tsx` (see its module doc for the full contract).
 * @param ctx - the plugin context.
 * @param config - the validated dsh-tui configuration.
 * @returns a promise settling when the Loader entry has scheduled its runtime.
 */
export async function apply(ctx: Context, config: RuntimeConfig<Config>): Promise<void> {
  // Upstream drift is NO LONGER spammed to stderr here: per-package
  // console.warn lines interleave with the TUI frame redraw and arrive
  // garbled (typewriter animation repaints over them). The merged,
  // natural-language notice now renders in the logo header under the
  // startup tip (LogoV2 ← upstreamDriftSummary); CI keeps the hard gate
  // via scripts/verify-upstream-contract.ts.
  const { apply: tuiApply, handleStartupError } = await import('./plugin.js')
  let disposed = false
  ctx.effect(() => () => { disposed = true })
  // Registry diagnostics can await the whole Loader. Do not make this Host
  // row await the runtime in return. Let Host providers settle before starting
  // a Cordis-owned child; the original row still owns volatile Config.
  const loader = ctx.get('loader') as { await(): Promise<unknown> } | undefined
  void (loader?.await() ?? ctx.fiber.await()).then(() => {
    if (disposed) return
    return ctx.plugin({
      name: 'dsh-tui-runtime',
      apply: (runtimeCtx: Context) => tuiApply(runtimeCtx, config, ctx),
    })
  }).catch(error => {
    if (!disposed) handleStartupError(ctx, error)
  })
}
