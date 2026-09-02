/** Background treatment applied to tool-call cards. */
export type ToolBackground = 'none' | 'subtle' | 'strong'

/**
 * What the fullscreen transcript's right gutter shows:
 *  - `timeline`: Grok-style turn rail — one tick per user turn (conversation
 *    order, not scroll proportion), active turn highlighted, click to jump;
 *  - `scrollbar`: classic proportional thumb — position/size of the visible
 *    window over the whole content, click the track to scroll there;
 *  - `hidden`: no gutter; the transcript takes the full width.
 */
export type ScrollGutterMode = 'timeline' | 'scrollbar' | 'hidden'

/** Individually selectable fields in the status footer. */
export interface StatusBarConfig {
  /** Prefer the compact, single-line presentation when space permits. */
  compact: boolean
  /** Live model id. */
  model: boolean
  /** Reasoning effort / thinking mode. */
  thinking: boolean
  /** Session working directory. */
  cwd: boolean
  /** Current context-window consumption. */
  contextUsage: boolean
  /** Prompt-cache hit rate. */
  cache: boolean
  /** Running input/output token totals. */
  tokens: boolean
  /** Estimated session spend (≈¥, DeepSeek official pricing — only shown
   *  for official DeepSeek providers whose model has a known price). */
  cost: boolean
  /** Live and recent output speed. */
  tps: boolean
  /** Current git branch. */
  gitBranch: boolean
  /** Current session title. */
  sessionTitle: boolean
  /** Short session id (# + first 8 chars), matching the session log filename. */
  sessionId: boolean
  /** Compact goal chip (phase glyph + rounds) while a goal exists. */
  goal: boolean
  /** Non-default session mode. */
  mode: boolean
  /** Segmented context progress bar on its own footer row. */
  contextBar: boolean
  /** Idle working-activity summary. */
  activity: boolean
  /** Mini trajectory wake rendered at the footer's right edge. */
  trajectory: boolean
  /** Idle `? for shortcuts` reminder; shortcut keys remain available when hidden. */
  shortcutHint: boolean
}

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
  contextBar: false,
  activity: false,
  trajectory: false,
  shortcutHint: false,
})

const TOOL_BACKGROUNDS = new Set<ToolBackground>(['none', 'subtle', 'strong'])
const SCROLL_GUTTERS = new Set<ScrollGutterMode>(['timeline', 'scrollbar', 'hidden'])
const STATUS_BAR_KEYS = Object.keys(DEFAULT_STATUS_BAR) as (keyof StatusBarConfig)[]

/** Normalize untrusted/config-layer values without mutating the input. */
export function normalizeToolBackground(value: unknown): ToolBackground {
  return typeof value === 'string' && TOOL_BACKGROUNDS.has(value as ToolBackground)
    ? value as ToolBackground
    : 'none'
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

/**
 * Root page inset (settings `dsh-tui.pageMargin`): some terminals carry
 * their own viewport padding (Windows Terminal's 8px default, GUI
 * emulators), others — bare WSL, tmux, SSH — have none, so the UI text
 * touches the screen edges. A setting is either a preset name
 * (none/slim/normal/roomy) or a custom spec (see {@link PageMarginSpec}).
 * The resolved geometry is what `PageMargin` (the root inset box above
 * Chat) renders; the channel carries the setting for tests, the module
 * store below is what the box itself subscribes to (the channel's version
 * bump only re-renders below Chat).
 */
export type PageMarginMode = 'none' | 'slim' | 'normal' | 'roomy'

/** Custom spec: `NxM` — N blank columns per side, M blank rows top/bottom
 *  (e.g. `3x1`). */
export type PageMarginSpec = `${number}x${number}`

/** A stored page-margin setting: a preset name or a custom spec. */
export type PageMarginSetting = PageMarginMode | PageMarginSpec

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

// ── Live module store ──────────────────────────────────────────────────
// PageMargin sits ABOVE Chat in the tree, so it cannot observe the
// channel's version bump used to re-render everything below Chat. The
// settings watch therefore mirrors the applied setting through this store;
// PageMargin subscribes with useSyncExternalStore and re-lays out.
const pageMarginListeners = new Set<() => void>()
let pageMarginState: PageMarginSetting = DEFAULT_PAGE_MARGIN

/** Subscribe to page-margin setting changes; returns the unsubscribe fn. */
export function subscribePageMargin(listener: () => void): () => void {
  pageMarginListeners.add(listener)
  return () => { pageMarginListeners.delete(listener) }
}

/** Current applied setting (normalized; safe for useSyncExternalStore —
 *  a primitive string identity is stable). */
export function getPageMarginSetting(): PageMarginSetting {
  return normalizePageMargin(pageMarginState)
}

/** Apply a new setting (normalized, no-op when unchanged). Returns the
 *  value that ended up applied — useful for the plugin to mirror the
 *  channel. */
export function applyPageMargin(setting: unknown): PageMarginSetting {
  const next = normalizePageMargin(setting)
  if (next !== pageMarginState) {
    pageMarginState = next
    for (const listener of [...pageMarginListeners]) listener()
  }
  return next
}
