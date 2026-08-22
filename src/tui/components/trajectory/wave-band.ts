/**
 * The wake — the whole session drawn as one row of glyphs, ported from the
 * Ink `WaveBand.tsx` to a pure string renderer for pi-tui.
 *
 * A session is a shape before it is a list: dense here, idle there, one red
 * mark where it broke. Three lanes of coloured blocks (the form the official
 * web overview uses, where vertical space is free) collapse badly into a
 * terminal, so they are composed into a single band whose **height** carries
 * cost and whose **colour** carries what kind of work it was.
 *
 * A failed column is simply drawn in the failure colour instead of on a
 * marker row: red among amber and violet is unmissable, and the failure
 * becomes *part of* the session's shape rather than an annotation over it.
 *
 * Every animated cell changes colour only — never a glyph count, never a row
 * count (see `src/trajectory/motion.ts`).
 *
 * One deliberate difference from the Ink version: colours go through
 * `paint.ts`, which understands `ansi:` palette entries natively, so the
 * `dark-ansi` theme now colours the band instead of falling back to the
 * neutral grey `toHex` used for unparseable values.
 */

import { alert, alive, mix } from '../../../trajectory/motion.js'
import { dominantChannel } from '../../../dsh-adapter/trajectory/index.js'
import type { Theme } from '../../../theme.js'
import type { WaveBand as Band, WaveChannel } from '../../../dsh-adapter/types.js'
import { activeTheme, fg, fgValue } from './paint.js'

/** Eight fill levels. */
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const
const FULL = '█'
/** A column with no activity at all. */
const IDLE = '·'
/** The live edge. */
const RUNNING = '▶'
const LEVELS = BLOCKS.length

/** Lane colour per channel, resolved from the active theme. */
function channelColor(channel: WaveChannel | undefined, theme: Theme): string {
  switch (channel) {
    case 'input': return theme.professionalBlue
    case 'tool': return theme.chromeYellow
    case 'model': return theme.autoAccept
    default: return theme.subtle
  }
}

export interface WaveBandProps {
  band: Band
  /** Rendered width in cells; equals `band.buckets.length`. */
  width: number
  /** Column the ledger cursor currently sits in. */
  cursorColumn: number
  /** First and last column covered by the visible ledger window. */
  viewportStart: number
  viewportEnd: number
  /**
   * Columns containing a query match, or `undefined` when no query is active.
   * Non-matching columns drop to grey so the match distribution across the
   * whole session is visible at a glance; the silhouette never changes.
   */
  matches?: ReadonlySet<number>
  /** Scene clock tick. */
  tick: number
  /** Tick the most recent alert was triggered on. */
  alertTick: number
}

/** Render the band as exactly two lines: the wave and the ruler. */
export function renderWaveBand({
  band,
  width,
  cursorColumn,
  viewportStart,
  viewportEnd,
  matches,
  tick,
  alertTick,
}: WaveBandProps): string[] {
  const theme = activeTheme()

  if (band.buckets.length === 0) {
    return [fg('subtle', IDLE.repeat(Math.max(0, width))), ' '.repeat(Math.max(0, width))]
  }

  // Normalize between the smallest non-empty column and the p95 column, both
  // in log space: the smallest real activity is one level, the busiest tops
  // out, and four orders of magnitude in between stay distinguishable.
  const logFloor = Math.log1p(Math.max(0, band.floor))
  const logSpan = Math.max(1e-6, Math.log1p(Math.max(1, band.peak)) - logFloor)
  const alertPhase = alert(tick, alertTick)
  const breath = alive(tick)

  let wave = ''

  for (let column = 0; column < band.buckets.length; column++) {
    const bucket = band.buckets[column]!
    const dimmed = matches !== undefined && !matches.has(column)
    const isCursor = column === cursorColumn

    if (bucket.count === 0) {
      wave += fg('subtle', IDLE)
      continue
    }

    if (bucket.running) {
      wave += fgValue(mix(theme.success, theme.planMode, breath) as string, RUNNING)
      continue
    }

    // 1..LEVELS — a non-empty column is never invisible.
    const level = Math.min(
      LEVELS,
      Math.max(1, Math.round(((Math.log1p(bucket.weight) - logFloor) / logSpan) * (LEVELS - 1)) + 1),
    )
    const failed = bucket.error || bucket.retry
    const base = failed
      ? (mix(theme.error, theme.warningShimmer, alertPhase) as string)
      : channelColor(dominantChannel(bucket), theme)
    const colour = dimmed
      ? theme.subtle
      : isCursor
        ? (mix(base, theme.permissionShimmer, 0.55) as string)
        : base

    // A failed column is never allowed to be one pixel tall: it is raised to
    // at least half height so the red is visible at a glance, which is the
    // whole point of colouring it.
    const shown = failed ? Math.max(level, Math.ceil(LEVELS / 2)) : level
    wave += fgValue(colour, shown >= LEVELS ? FULL : BLOCKS[shown - 1]!)
  }

  // ── ruler: turn numbers plus the viewport bracket ─────────────────────────
  const ruler = Array.from({ length: band.buckets.length }, () => ' ')
  // Turn numbers, not anonymous ticks: the ruler is how `{ }` navigation is
  // aimed. A label that would collide with the previous one degrades to a
  // tick rather than overwriting digits into nonsense.
  let lastLabelEnd = -Infinity
  for (const [turn, column] of band.turns) {
    if (column >= ruler.length) continue
    const label = String(turn)
    if (column - 1 <= lastLabelEnd) {
      ruler[column] = '╵'
      continue
    }
    for (let offset = 0; offset < label.length && column + offset < ruler.length; offset++) {
      ruler[column + offset] = label[offset]!
    }
    lastLabelEnd = column + label.length
  }
  const from = Math.max(0, Math.min(band.buckets.length - 1, viewportStart))
  const to = Math.max(from, Math.min(band.buckets.length - 1, viewportEnd))
  let rulerText = ''
  for (let column = 0; column < ruler.length; column++) {
    const inViewport = column >= from && column <= to
    const glyph = inViewport ? (column === from ? '▐' : column === to ? '▌' : '▀') : ruler[column]!
    rulerText += fg(inViewport ? 'permission' : 'subtle', glyph)
  }

  return [wave, rulerText]
}
