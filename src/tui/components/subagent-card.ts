/**
 * SubagentCardView — the transcript-inline subagent card (WP-03 imperative
 * port of the React `src/components/SubagentCard.tsx`).
 *
 * One compact header line per subagent — status glyph, prefixed description,
 * model, elapsed time, token and tool-call counts — plus, while the subagent
 * is still streaming, a second dim line previewing its newest output line
 * (it folds away at settlement, so settled subagents stay one line). The
 * dashboard scene (`../screens/subagent-scenes.ts`) embeds the same view per
 * row, and this module also carries the small pure helpers both subagent
 * scenes share — palette coloring, status visuals, duration/timestamp
 * formatting, token totals, tool-name colors — so the visual language of the
 * card, the dashboard and the detail scene has exactly one source.
 *
 * Imperative pi-tui Component: the host pushes state through update() /
 * setFocused() and pulls lines through render(width). No React/Ink/Yoga, no
 * Channel/Cordis/Agent, no stdio.
 */
import chalk from 'chalk'
import { truncateToWidth, type Component } from '../public.js'
import type { SubagentState } from '../../dsh-adapter/subagents.js'
import { getActiveTheme, type Theme } from '../../theme.js'
import { isMinimalMode } from '../../minimalMode.js'
import { t } from '../../i18n.js'

// ── palette coloring ──────────────────────────────────────────────────────

/** Palette value shapes emitted by src/theme.ts: `rgb(r,g,b)`, `ansi256(n)`. */
const RGB_COLOR = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/
const ANSI256_COLOR = /^ansi256\(\s?(\d+)\s?\)$/

/** Apply one palette value (`rgb()`, `#hex`, `ansi256()`, `ansi:name`) as a
 *  foreground color; unparsable/empty values leave the text unchanged. */
export function themeFg(color: string | undefined, text: string): string {
  if (!color) return text
  if (color.startsWith('#')) return chalk.hex(color)(text)
  const rgb = RGB_COLOR.exec(color)
  if (rgb !== null) return chalk.rgb(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]))(text)
  const ansi256 = ANSI256_COLOR.exec(color)
  if (ansi256 !== null) return chalk.ansi256(Number(ansi256[1]))(text)
  if (color.startsWith('ansi:')) {
    const fn = (chalk as unknown as Record<string, unknown>)[color.slice('ansi:'.length)]
    if (typeof fn === 'function') return (fn as (value: string) => string)(text)
  }
  return text
}

/** Foreground-color `text` with the active palette's `key` slot. */
export function themeKeyFg(key: keyof Theme | undefined, text: string): string {
  if (key === undefined) return text
  return themeFg(getActiveTheme()[key], text)
}

// ── shared formatting ─────────────────────────────────────────────────────

export interface SubagentStatusVisual {
  readonly glyph: string
  readonly color: keyof Theme | undefined
  readonly label: string
}

/** Status glyph/color/label, minimal-mode aware (same mapping as the old scenes). */
export function subagentStatusVisual(status: SubagentState['status']): SubagentStatusVisual {
  const minimal = isMinimalMode()
  if (status === 'completed') return { glyph: minimal ? '✓' : '🟢', color: minimal ? undefined : 'success', label: 'done' }
  if (status === 'failed') return { glyph: minimal ? '×' : '🔴', color: minimal ? undefined : 'error', label: 'failed' }
  if (status === 'cancelled') return { glyph: minimal ? '×' : '🔴', color: minimal ? undefined : 'error', label: 'cancelled' }
  return { glyph: minimal ? '·' : '🟡', color: minimal ? undefined : 'warning', label: 'running' }
}

/** True while the subagent is live — drives elapsed ticking and tail-follow. */
export function isSubagentRunning(subagent: SubagentState): boolean {
  return subagent.status === 'running' || subagent.status === 'starting'
}

/** Milliseconds since start (frozen at completion once the run settled). */
export function subagentElapsed(subagent: SubagentState, now: number = Date.now()): number {
  return subagent.completedAt !== undefined ? subagent.completedAt - subagent.startedAt : now - subagent.startedAt
}

/** Total tokens across the usage record (0 when nothing was reported). */
export function subagentTokensTotal(subagent: SubagentState): number {
  return subagent.tokens?.total ?? ((subagent.tokens?.input ?? 0) + (subagent.tokens?.output ?? 0) || 0)
}

/** Card-line duration: whole seconds (`12s`, `3m4s`). */
export function formatCardDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

/** Detail-page duration: finer precision under a minute (`820ms`, `4.2s`, `1m5s`). */
export function formatDetailDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60000)
  const sec = Math.floor((ms % 60000) / 1000)
  return `${min}m${sec}s`
}

/** Wall-clock rendering of a timestamp, as the old scenes showed it. */
export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

// Mirror of toolNameColor() in src/components/messages/AssistantToolUseMessage.tsx —
// that module is React-coupled and cannot be imported here; the category sets
// must stay identical to it.
const TOOL_NAME_MUTATE = new Set(['edit', 'write', 'multiedit', 'notebookedit'])
const TOOL_NAME_EXEC = new Set(['bash', 'bashpersistent', 'sh', 'shell', 'terminal'])

/** Tool-name color by category: read/search tools keep the brand blue,
 *  file-mutating tools get the warm gold accent, exec/terminal mist cyan. */
export function toolNameThemeKey(raw: string): keyof Theme {
  const n = raw.toLowerCase()
  if (TOOL_NAME_MUTATE.has(n)) return 'toolNameMutate'
  if (TOOL_NAME_EXEC.has(n)) return 'toolNameExec'
  return 'claude'
}

// ── the card ──────────────────────────────────────────────────────────────

/**
 * Transcript-inline subagent card. `render` is a pure function of the pushed
 * state; the result is memoized on a content signature that includes the
 * formatted elapsed time, so a running card still ticks on every render.
 */
export class SubagentCardView implements Component {
  private subagent: SubagentState | undefined
  private focused = false
  private cacheKey: string | undefined
  private cacheLines: string[] | undefined

  constructor(subagent?: SubagentState) {
    this.subagent = subagent
  }

  /** Push the newest snapshot (the projection shares it by reference; field
   *  values are re-read on every render). */
  update(subagent: SubagentState): void {
    this.subagent = subagent
  }

  /** Focus tint: the dashboard paints the focused row's title brand blue. */
  setFocused(focused: boolean): void {
    this.focused = focused
  }

  invalidate(): void {
    this.cacheKey = undefined
    this.cacheLines = undefined
  }

  render(width: number): string[] {
    const subagent = this.subagent
    if (subagent === undefined || width <= 0) return []
    const running = isSubagentRunning(subagent)
    const elapsed = formatCardDuration(subagentElapsed(subagent))
    const total = subagentTokensTotal(subagent)
    // Live preview: the newest streamed line rides under the header while
    // the subagent runs, then folds away at settlement.
    const liveLine = running ? subagent.output[subagent.output.length - 1] : undefined
    const key = [
      width,
      this.focused,
      subagent.status,
      subagent.description,
      subagent.model ?? subagent.provider ?? 'default',
      elapsed,
      total,
      subagent.toolCalls.length,
      liveLine ?? '',
    ].join('|')
    if (this.cacheLines !== undefined && this.cacheKey === key) return this.cacheLines

    const visual = subagentStatusVisual(subagent.status)
    const title = chalk.bold(`${t('subagent-card-prefix')}${subagent.description}`)
    const head =
      ` ${themeKeyFg(visual.color, visual.glyph)} ${themeKeyFg(this.focused ? 'claude' : undefined, title)}` +
      `${chalk.dim(' · ')}${subagent.model ?? subagent.provider ?? 'default'}` +
      chalk.dim(` · ${elapsed} · ${total || '—'} tok · ${subagent.toolCalls.length} tools`)
    const lines = [truncateToWidth(head, width, '')]
    if (liveLine !== undefined && liveLine !== '') {
      lines.push(truncateToWidth(chalk.dim(`  │ ${liveLine}`), width, ''))
    }
    this.cacheKey = key
    this.cacheLines = lines
    return lines
  }
}
