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
  /** Park plugin status contributions as styled chips in the footer. */
  pluginChips: boolean
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
  pluginChips: true,
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

/**
 * Overlay only the boolean keys actually present in a settings user layer
 * onto a cordis/config base. Schema-filled defaults must not be passed as
 * `overlay` — they would shadow an explicit profile `statusBar`.
 */
export function mergeStatusBar(base: unknown, overlay: unknown): StatusBarConfig {
  const merged: StatusBarConfig = { ...normalizeStatusBar(base) }
  if (overlay === null || typeof overlay !== 'object' || Array.isArray(overlay)) {
    return merged
  }
  const input = overlay as Record<string, unknown>
  for (const key of STATUS_BAR_KEYS) {
    if (typeof input[key] === 'boolean') merged[key] = input[key]
  }
  return merged
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
