import type { ToolBackground, ScrollGutterMode, PageMarginSetting, PageMarginMode, PageMarginSpec, StatusBarConfig, JobGroupFoldMode } from './adapter/ports/channel-display.js'
export type { ToolBackground, ScrollGutterMode, PageMarginSetting, PageMarginMode, PageMarginSpec, StatusBarConfig, JobGroupFoldMode } from './adapter/ports/channel-display.js'


/** Defaults keep the essential route/context information visible. */
export const DEFAULT_STATUS_BAR: Readonly<StatusBarConfig> = Object.freeze({
  compact: true,
  model: true,
  thinking: true,
  cwd: true,
  contextUsage: true,
  cache: true,
  tokens: false,
  cost: true,
  tps: false,
  gitBranch: false,
  sessionTitle: false,
  sessionId: false,
  goal: true,
  mode: false,
  // On by default (2026-09-10, user ask): the segmented bar is the only place
  // the per-segment context breakdown shows, so users who never open
  // /settings were missing it entirely. `/settings → statusBar.contextBar`
  // (or cordis.yml `contextBar: false`) still turns it off.
  contextBar: true,
  activity: false,
  trajectory: false,
  shortcutHint: false,
})

const TOOL_BACKGROUNDS = new Set<ToolBackground>(['none', 'subtle', 'strong'])
const JOB_GROUP_FOLDS = new Set<JobGroupFoldMode>(['auto', 'always', 'never'])
const SCROLL_GUTTERS = new Set<ScrollGutterMode>(['timeline', 'scrollbar', 'hidden'])
const STATUS_BAR_KEYS = Object.keys(DEFAULT_STATUS_BAR) as (keyof StatusBarConfig)[]

/** Normalize untrusted/config-layer values without mutating the input. */
export function normalizeToolBackground(value: unknown): ToolBackground {
  return typeof value === 'string' && TOOL_BACKGROUNDS.has(value as ToolBackground)
    ? value as ToolBackground
    : 'none'
}

/** Same normalize contract as toolBackground; `auto` is the default. */
export function normalizeJobGroupFold(value: unknown): JobGroupFoldMode {
  return typeof value === 'string' && JOB_GROUP_FOLDS.has(value as JobGroupFoldMode)
    ? value as JobGroupFoldMode
    : 'auto'
}

/** Same normalize contract as toolBackground; `timeline` is the default. */
export function normalizeScrollGutter(value: unknown): ScrollGutterMode {
  return typeof value === 'string' && SCROLL_GUTTERS.has(value as ScrollGutterMode)
    ? value as ScrollGutterMode
    : 'timeline'
}

/** Merge a partial settings value over the stable status-bar defaults. */
export function normalizeStatusBar(value: unknown): StatusBarConfig {
  const normalized: StatusBarConfig = { ...DEFAULT_STATUS_BAR }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return normalized

  const input = value as Record<string, unknown>
  for (const key of STATUS_BAR_KEYS) {
    if (typeof input[key] === 'boolean') normalized[key] = input[key]
  }
  return normalized
}

function formatTokenCount(value: number): string {
  const rounded = Math.max(0, Math.round(value))
  if (rounded < 1_000) return String(rounded)
  if (rounded < 1_000_000) return `${(rounded / 1_000).toFixed(rounded < 10_000 ? 1 : 0)}k`
  return `${(rounded / 1_000_000).toFixed(rounded < 10_000_000 ? 1 : 0)}m`
}

/**
 * Format context-window usage for future status-line consumers.
 * Invalid or unavailable inputs intentionally produce no field.
 */
export function formatContextUsage(
  used: number | undefined,
  contextWindow: number | undefined,
  compact = true,
): string | undefined {
  if (!Number.isFinite(used) || !Number.isFinite(contextWindow) || used === undefined || contextWindow === undefined || contextWindow <= 0) {
    return undefined
  }
  const safeUsed = Math.max(0, used)
  const percent = Math.min(999, (safeUsed / contextWindow) * 100)
  const percentText = `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`
  const counts = `${formatTokenCount(safeUsed)}/${formatTokenCount(contextWindow)}`
  return compact ? `${percentText} (${counts})` : `${counts} (${percentText})`
}

/** Page inset per preset: `{ x }` = blank columns per side, `{ y }` = blank
 *  rows top/bottom. `normal` is the default and matches the original
 *  hard-coded inset (2 columns / 1 row). */
export const PAGE_MARGIN_PRESETS: Readonly<Record<PageMarginMode, { readonly x: number; readonly y: number }>> = Object.freeze({
  none: { x: 0, y: 0 },
  slim: { x: 1, y: 1 },
  normal: { x: 2, y: 1 },
  roomy: { x: 4, y: 2 },
})

export const DEFAULT_PAGE_MARGIN: PageMarginMode = 'normal'

/** Custom-spec bounds: beyond this a layout is either useless (a 40-col
 *  terminal would starve) or pure waste. */
export const PAGE_MARGIN_MAX_X = 8
export const PAGE_MARGIN_MAX_Y = 4

const PAGE_MARGIN_MODES = new Set<PageMarginMode>(['none', 'slim', 'normal', 'roomy'])
// `N` (rows default to 1) or `NxN` / `N×N` / `N,N` — the settings field and
// cordis.yml both write through this; CJK 全角逗号/乘号 also accepted for
// zh users typing without switching layouts.
const PAGE_MARGIN_SPEC_RE = /^(\d{1,2})(?:[x×,，](\d{1,2}))?$/u

export function isPageMarginMode(value: string): value is PageMarginMode {
  return PAGE_MARGIN_MODES.has(value as PageMarginMode)
}

/** Parse a custom spec (canonicalizes `N` → `Nx1`); undefined when invalid
 *  or out of bounds. */
export function parsePageMarginSpec(text: string): PageMarginSpec | undefined {
  const match = PAGE_MARGIN_SPEC_RE.exec(text.trim().toLowerCase())
  if (match === null) return undefined
  const x = Number.parseInt(match[1]!, 10)
  const y = match[2] === undefined ? 1 : Number.parseInt(match[2]!, 10)
  if (x > PAGE_MARGIN_MAX_X || y > PAGE_MARGIN_MAX_Y) return undefined
  return `${x}x${y}` as PageMarginSpec
}

/** Normalize untrusted/config-layer values without mutating the input:
 *  preset names and valid custom specs pass through, everything else falls
 *  back to the default preset. */
export function normalizePageMargin(value: unknown): PageMarginSetting {
  if (typeof value === 'string') {
    if (isPageMarginMode(value)) return value
    const spec = parsePageMarginSpec(value)
    if (spec !== undefined) return spec
  }
  return DEFAULT_PAGE_MARGIN
}

/** Resolve a stored setting to its geometry (presets via the table, custom
 *  specs via their numbers; anything unparseable → the default preset). */
export function resolvePageMargin(setting: PageMarginSetting): { readonly x: number; readonly y: number } {
  if (isPageMarginMode(setting)) return PAGE_MARGIN_PRESETS[setting]
  const spec = parsePageMarginSpec(setting)
  if (spec !== undefined) {
    const [x, y] = spec.split('x')
    return {
      x: Number.parseInt(x!, 10),
      y: Number.parseInt(y!, 10),
    }
  }
  return PAGE_MARGIN_PRESETS[DEFAULT_PAGE_MARGIN]
}

// ── Live module stores ─────────────────────────────────────────────────
// Settings that components read directly (useSyncExternalStore) instead of
// through the channel: PageMargin sits ABOVE Chat, so the channel's version
// bump (which re-renders everything below Chat) cannot reach it; Markdown
// is memoized by content and mounted from many parents, so threading a prop
// to every diagram would re-render the whole transcript on each edit. The
// settings watch mirrors each applied value into its store; the plugin
// seeds the stores from config before the tree mounts.

type LiveSetting<T> = {
  /** Subscribe to changes; returns the unsubscribe fn. */
  subscribe: (listener: () => void) => () => void
  /** Current applied value (normalized; a primitive, so its identity is stable). */
  get: () => T
  /** Apply a new value (normalized, no-op when unchanged); returns what was applied. */
  apply: (value: unknown) => T
}

function createLiveSetting<T>(initial: T, normalize: (value: unknown) => T): LiveSetting<T> {
  const listeners = new Set<() => void>()
  let state = initial
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    get: () => state,
    apply(value) {
      const next = normalize(value)
      if (next !== state) {
        state = next
        for (const listener of [...listeners]) listener()
      }
      return next
    },
  }
}

const pageMarginStore = createLiveSetting<PageMarginSetting>(DEFAULT_PAGE_MARGIN, normalizePageMargin)
export const subscribePageMargin = pageMarginStore.subscribe
export const getPageMarginSetting = pageMarginStore.get
/** Returns the value that ended up applied — the plugin mirrors it into the channel. */
export const applyPageMargin = pageMarginStore.apply

/** Whether ```mermaid fences render as box-drawing diagrams (settings
 *  `dsh-tui.mermaidDiagrams`, default on). Only an explicit `false` keeps
 *  the fenced source. */
const mermaidDiagramsStore = createLiveSetting<boolean>(true, value => value !== false)
export const subscribeMermaidDiagrams = mermaidDiagramsStore.subscribe
export const getMermaidDiagrams = mermaidDiagramsStore.get
export const applyMermaidDiagrams = mermaidDiagramsStore.apply

/**
 * How fenced code blocks frame themselves (settings
 *  `dsh-tui.codeFrameStyle`): `light` (default) is the open rail frame
 * — corner + language label on top, a left rail with one padding
 * column, no right wall or bottom edge; `full` closes the box with a
 * right wall (continuous across wrapped rows, it rides the layout
 * border) and a bottom edge. The narrow-terminal fallback (net body
 * width < 8) always stays the plain ANSI fence, whatever this says.
 */
export type CodeFrameStyle = 'light' | 'full'
const CODE_FRAME_STYLES = new Set<CodeFrameStyle>(['light', 'full'])

export function normalizeCodeFrameStyle(value: unknown): CodeFrameStyle {
  return typeof value === 'string' && CODE_FRAME_STYLES.has(value as CodeFrameStyle)
    ? value as CodeFrameStyle
    : 'light'
}

/** Read at render time, so settled code blocks re-render on change. */
const codeFrameStyleStore = createLiveSetting<CodeFrameStyle>('light', normalizeCodeFrameStyle)
export const subscribeCodeFrameStyle = codeFrameStyleStore.subscribe
export const getCodeFrameStyle = codeFrameStyleStore.get
export const applyCodeFrameStyle = codeFrameStyleStore.apply

/**
 * How LaTeX math in replies renders (settings `dsh-tui.mathRendering`):
 * `auto` picks the best available backend (today the Unicode renderer),
 * `image` typesets complete block formulas as terminal images where the
 * terminal supports graphics (Unicode everywhere else; opt-in until it has
 * been validated across terminals, after which `auto` adopts it),
 * `unicode` pins the Unicode renderer, `source` always shows the TeX.
 */
export type MathRendering = 'auto' | 'image' | 'unicode' | 'source'
const MATH_RENDERING_MODES = new Set<MathRendering>(['auto', 'image', 'unicode', 'source'])

export function normalizeMathRendering(value: unknown): MathRendering {
  return typeof value === 'string' && MATH_RENDERING_MODES.has(value as MathRendering)
    ? value as MathRendering
    : 'auto'
}

/**
 * Resolve the effective mode across the settings user layer and cordis.yml.
 * `latexMath` predates `mathRendering` (unreleased main builds wrote it): at a
 * layer without `mathRendering`, `false` means `source` and `true` means
 * `auto`, and either one overrides the layers below.
 */
export function resolveMathRendering(
  user: { mathRendering?: unknown; latexMath?: unknown },
  config: { mathRendering?: unknown; latexMath?: unknown },
): MathRendering {
  for (const layer of [user, config]) {
    if (layer.mathRendering !== undefined) return normalizeMathRendering(layer.mathRendering)
    // An explicit legacy switch overrides lower layers either way: a user who
    // turned math back on over a cordis.yml `false` keeps it on.
    if (typeof layer.latexMath === 'boolean') return layer.latexMath ? 'auto' : 'source'
  }
  return 'auto'
}

/** Read at render time, so settled transcript blocks re-render on change. */
const mathRenderingStore = createLiveSetting<MathRendering>('auto', normalizeMathRendering)
export const subscribeMathRendering = mathRenderingStore.subscribe
export const getMathRendering = mathRenderingStore.get
export const applyMathRendering = mathRenderingStore.apply

/**
 * How large a display formula is set when it renders as an image (settings
 * `dsh-tui.mathImageScale`): `auto` matches the body text, `large` and
 * `xlarge` set display math bigger. Size is the only sharpness lever a
 * terminal image has — the raster is drawn one device pixel per pixel, so a
 * larger formula is literally more pixels per stroke. Inline formulas keep the
 * base scale: their single row of cells caps the resolution.
 */
export type MathImageScale = 'auto' | 'large' | 'xlarge'
const MATH_IMAGE_SCALES = new Set<MathImageScale>(['auto', 'large', 'xlarge'])

export function normalizeMathImageScale(value: unknown): MathImageScale {
  return typeof value === 'string' && MATH_IMAGE_SCALES.has(value as MathImageScale)
    ? value as MathImageScale
    : 'auto'
}

/** Read at render time, so settled transcript blocks re-render on change. */
const mathImageScaleStore = createLiveSetting<MathImageScale>('auto', normalizeMathImageScale)
export const subscribeMathImageScale = mathImageScaleStore.subscribe
export const getMathImageScale = mathImageScaleStore.get
export const applyMathImageScale = mathImageScaleStore.apply

/**
 * What sits behind a formula image (settings `dsh-tui.mathImageBacking`):
 * `transparent` paints only the formula's own pixels, so the terminal
 * background (a wallpaper included) shows through; `terminal` composites it
 * onto the terminal's background colour first, which is the calmer choice on
 * busy backgrounds and the only one that keeps soft anti-aliased edges smooth
 * (Sixel has no partial alpha).
 */
export type MathImageBacking = 'transparent' | 'terminal'
const MATH_IMAGE_BACKINGS = new Set<MathImageBacking>(['transparent', 'terminal'])

export function normalizeMathImageBacking(value: unknown): MathImageBacking {
  return typeof value === 'string' && MATH_IMAGE_BACKINGS.has(value as MathImageBacking)
    ? value as MathImageBacking
    : 'transparent'
}

const mathImageBackingStore = createLiveSetting<MathImageBacking>('transparent', normalizeMathImageBacking)
export const subscribeMathImageBacking = mathImageBackingStore.subscribe
export const getMathImageBacking = mathImageBackingStore.get
export const applyMathImageBacking = mathImageBackingStore.apply

/**
 * What sits behind a transcript photo or illustration (settings
 * `dsh-tui.imageBacking`): `transparent` paints only the raster's own
 * pixels, so the terminal background (a wallpaper included) shows through
 * at anti-aliased edges and transparent corners — Sixel's binary alpha
 * drops their softest pixels, so edges trade a little smoothness for the
 * float; `terminal` composites onto the terminal's background colour
 * first (smooth edges on any background). Photographs are mostly opaque,
 * so the visible difference lives at the edges.
 */
export type ImageBacking = 'transparent' | 'terminal'
const IMAGE_BACKINGS = new Set<ImageBacking>(['transparent', 'terminal'])

export function normalizeImageBacking(value: unknown): ImageBacking {
  return typeof value === 'string' && IMAGE_BACKINGS.has(value as ImageBacking)
    ? value as ImageBacking
    : 'transparent'
}

const imageBackingStore = createLiveSetting<ImageBacking>('transparent', normalizeImageBacking)
export const subscribeImageBacking = imageBackingStore.subscribe
export const getImageBacking = imageBackingStore.get
export const applyImageBacking = imageBackingStore.apply

// ── Side panel (侧栏) ────────────────────────────────────────────────
// Settings `dsh-tui.sidePanel.*`. These are module-level live stores (not
// channel state): the layout needs them above the channel's version bump —
// a Ctrl+B toggle must re-render Chat even though nothing about the
// session changed — and /settings + cordis.yml write through the same
// apply* functions (plugin's applyDisplay mirrors them here, exactly like
// pageMargin). Key toggles are session-level: they move the live store but
// never write the user settings layer, so a restart returns to the
// configured default.

/** Panel id grammar (plugins register under a `plugin:sub` namespace). */
export const SIDE_PANEL_ID_PATTERN = /^[a-z][a-z0-9_-]*(:[a-z][a-z0-9_-]*)*$/

export const DEFAULT_SIDE_PANEL_IDS = 'todo,jobs,agents'

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Chat fraction of the content width; junk collapses to the default and
 *  the value is sanity-clamped (geometry clamps further per width). */
export function normalizeSidePanelRatio(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.68
  return Math.min(0.95, Math.max(0.1, value))
}

/** Comma-separated enabled-panel ids: tokens that fail the id grammar are
 *  dropped (a typo must never wedge the layout); unknown-but-well-formed
 *  ids survive — a plugin may register them later in the session. */
export function normalizeSidePanelPanels(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SIDE_PANEL_IDS
  const seen = new Set<string>()
  for (const token of value.split(',')) {
    const id = token.trim().toLowerCase()
    if (id !== '' && SIDE_PANEL_ID_PATTERN.test(id)) seen.add(id)
  }
  return seen.size > 0 ? [...seen].join(',') : DEFAULT_SIDE_PANEL_IDS
}

/** Enabled panel ids in PanelBar order. */
export function parseSidePanelIds(value: string): readonly string[] {
  return normalizeSidePanelPanels(value).split(',')
}

const sidePanelSplitEnabledStore = createLiveSetting<boolean>(true, value => normalizeBoolean(value, true))
export const subscribeSidePanelSplitEnabled = sidePanelSplitEnabledStore.subscribe
export const getSidePanelSplitEnabled = sidePanelSplitEnabledStore.get
export const applySidePanelSplitEnabled = sidePanelSplitEnabledStore.apply

const sidePanelOpenStore = createLiveSetting<boolean>(false, value => normalizeBoolean(value, false))
export const subscribeSidePanelOpen = sidePanelOpenStore.subscribe
export const getSidePanelOpen = sidePanelOpenStore.get
export const applySidePanelOpen = sidePanelOpenStore.apply

const sidePanelRatioStore = createLiveSetting<number>(0.68, normalizeSidePanelRatio)
export const subscribeSidePanelRatio = sidePanelRatioStore.subscribe
export const getSidePanelRatio = sidePanelRatioStore.get
export const applySidePanelRatio = sidePanelRatioStore.apply

const sidePanelPanelsStore = createLiveSetting<string>(DEFAULT_SIDE_PANEL_IDS, normalizeSidePanelPanels)
export const subscribeSidePanelPanels = sidePanelPanelsStore.subscribe
export const getSidePanelPanels = sidePanelPanelsStore.get
export const applySidePanelPanels = sidePanelPanelsStore.apply

/**
 * btw 线程上下文设置（设置 `dsh-tui.btw.*`）：追问携带的最近完成轮数
 * 与总字符预算。clamp 规则与线程 store 的防御性钳制（sidePanel/btw/
 * threads.ts 的 normalizeRecentTurnsLimit / selectContextTurns）一致——
 * 两道闸门同规则，先到者生效；这里管 /settings 与 cordis.yml 的入口，
 * store 侧兜住不经设置的直接调用。
 */
export const BTW_CONTEXT_TURNS_MIN = 1
export const BTW_CONTEXT_TURNS_MAX = 8
export const BTW_CONTEXT_TURNS_DEFAULT = 4

/** 总预算下限护住单答派生（perAnswer = min(8k, budget/2)）：再小就只剩
 *  当前问句本身，上下文功能名存实亡。 */
export const BTW_CONTEXT_BUDGET_MIN = 1_000
export const BTW_CONTEXT_BUDGET_MAX = 200_000
export const BTW_CONTEXT_BUDGET_DEFAULT = 24_000

export function normalizeBtwContextTurns(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return BTW_CONTEXT_TURNS_DEFAULT
  return Math.min(BTW_CONTEXT_TURNS_MAX, Math.max(BTW_CONTEXT_TURNS_MIN, Math.round(value)))
}

export function normalizeBtwContextBudget(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return BTW_CONTEXT_BUDGET_DEFAULT
  return Math.min(BTW_CONTEXT_BUDGET_MAX, Math.max(BTW_CONTEXT_BUDGET_MIN, Math.round(value)))
}

const btwContextTurnsStore = createLiveSetting<number>(BTW_CONTEXT_TURNS_DEFAULT, normalizeBtwContextTurns)
export const subscribeBtwContextTurns = btwContextTurnsStore.subscribe
export const getBtwContextTurns = btwContextTurnsStore.get
export const applyBtwContextTurns = btwContextTurnsStore.apply

const btwContextBudgetStore = createLiveSetting<number>(BTW_CONTEXT_BUDGET_DEFAULT, normalizeBtwContextBudget)
export const subscribeBtwContextBudget = btwContextBudgetStore.subscribe
export const getBtwContextBudget = btwContextBudgetStore.get
export const applyBtwContextBudget = btwContextBudgetStore.apply

/**
 * Companion 皮肤（设置 `dsh-tui.companion.skin`）：内置 'deepy'（默认，
 * assets/deepy 素材包）、'whaleGirl'（用户提供的鲸娘素材包，assets/
 * whaleGirl）与 'whale'（开屏像素鲸鱼同款分层动画）；插件
 * 皮肤 id（'plugin:sub' 命名空间）随 Phase 7 开放注册后同样可写——
 * 未注册/未知的 id 一律回退 deepy，不阻断启动。
 */
export type CompanionSkinSetting = string
export const COMPANION_SKIN_IDS = ['deepy', 'whaleGirl', 'whale'] as const
export const DEFAULT_COMPANION_SKIN: CompanionSkinSetting = 'deepy'

export function normalizeCompanionSkin(value: unknown): CompanionSkinSetting {
  if (typeof value === 'string' && (COMPANION_SKIN_IDS as readonly string[]).includes(value)) return value
  return DEFAULT_COMPANION_SKIN
}

const companionSkinStore = createLiveSetting<CompanionSkinSetting>(DEFAULT_COMPANION_SKIN, normalizeCompanionSkin)
export const subscribeCompanionSkin = companionSkinStore.subscribe
export const getCompanionSkin = companionSkinStore.get
export const applyCompanionSkin = companionSkinStore.apply
