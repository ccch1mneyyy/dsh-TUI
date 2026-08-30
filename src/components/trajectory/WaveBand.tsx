import React from 'react'
import chalk from 'chalk'
import { Box, Text, useTheme } from '../../ui.js'
import type { ClickEvent } from '../../ink/events/click-event.js'
import { getTheme } from '../../theme.js'
import { alert, alive, mix } from '../../trajectory/motion.js'
import { parseRGB } from '../Spinner/spinnerUtils.js'
import type { WaveBand as Band, WaveChannel } from '../../dsh-adapter/types.js'
import { dominantChannel } from '../../dsh-adapter/trajectory/index.js'

/**
 * The wake — the whole session drawn as one row of glyphs.
 *
 * A session is a shape before it is a list: dense here, idle there, one red
 * mark where it broke. Three lanes of coloured blocks (the form the official
 * web overview uses, where vertical space is free) collapse badly into a
 * terminal, so they are composed into a single band whose **height** carries
 * cost and whose **colour** carries what kind of work it was.
 *
 * ## One row, two rows deep in information
 *
 * A two-row stack was tried for the extra eight levels of resolution and read
 * WORSE: with a log scale anchored at the smallest column, a typical column
 * lands near 55%, which in a two-row bar means "lower row solid, upper row a
 * sliver" — the band turns into a slab. One row of eight levels, over weights
 * that now carry real cost, produces the varied silhouette the band is for.
 * The rows saved go to the ledger, which always wants more.
 *
 * ## Failures ride in the band, not above it
 *
 * A dedicated marker row spends a whole line to show three glyphs. A failed
 * column is simply drawn in the failure colour instead: red among amber and
 * violet is unmissable, and the failure becomes *part of* the session's shape
 * rather than an annotation over it.
 *
 * Every animated cell changes colour only — never a glyph count, never a row
 * count (see `trajectory/motion.ts`).
 */

/** Eight fill levels. */
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const
const FULL = '█'
/** A column with no activity at all. */
const IDLE = '·'
/** The live edge. */
const RUNNING = '▶'
const LEVELS = BLOCKS.length

/** Lane colour per channel, resolved from the active theme. */
function channelColor(channel: WaveChannel | undefined, theme: ReturnType<typeof getTheme>): string {
  switch (channel) {
    case 'input': return theme.professionalBlue
    case 'tool': return theme.chromeYellow
    case 'model': return theme.autoAccept
    default: return theme.subtle
  }
}

export function WaveBand({
  band,
  width,
  cursorColumn,
  viewportStart,
  viewportEnd,
  matches,
  tick,
  alertTick,
  onColumnClick,
}: {
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
  /**
   * Mouse pick (fullscreen): reports the clicked column (0-based within the
   * band; the ruler row counts too — its ▐▌ bracket is the seek affordance).
   * The scene jumps to that column's nearest event via bucket.firstIndex,
   * which empty columns inherit from their predecessor for exactly this
   * purpose. No hover: column density makes per-cell indication noise.
   */
  onColumnClick?: (column: number, event: ClickEvent) => void
}): React.ReactNode {
  const [themeName] = useTheme()
  const theme = getTheme(themeName)

  if (band.buckets.length === 0) {
    return (
      <Box flexDirection="column" flexShrink={0}>
        <Text color="subtle">{IDLE.repeat(Math.max(0, width))}</Text>
        <Text color="subtle">{' '.repeat(Math.max(0, width))}</Text>
      </Box>
    )
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
      wave += chalk.hex(toHex(theme.subtle))(IDLE)
      continue
    }

    if (bucket.running) {
      wave += chalk.hex(toHex(mix(theme.success, theme.planMode, breath) as string))(RUNNING)
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
    const hex = toHex(colour)

    // A failed column is never allowed to be one pixel tall: it is raised to
    // at least half height so the red is visible at a glance, which is the
    // whole point of colouring it.
    const shown = failed ? Math.max(level, Math.ceil(LEVELS / 2)) : level
    wave += chalk.hex(hex)(shown >= LEVELS ? FULL : BLOCKS[shown - 1]!)
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
    rulerText += inViewport
      ? chalk.hex(toHex(theme.permission))(glyph)
      : chalk.hex(toHex(theme.subtle))(glyph)
  }

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      onClick={
        onColumnClick === undefined
          ? undefined
          : (event: ClickEvent) => {
              const column = Math.max(0, Math.min(band.buckets.length - 1, event.localCol))
              onColumnClick(column, event)
            }
      }
    >
      <Text>{wave}</Text>
      <Text>{rulerText}</Text>
    </Box>
  )
}

/**
 * Convert a theme colour to the `#rrggbb` form chalk needs.
 *
 * Theme values are `rgb(r,g,b)` strings; a custom theme may instead carry an
 * ANSI name, which cannot be blended — those fall back to a neutral grey
 * rather than crashing chalk's hex parser.
 */
function toHex(colour: string): string {
  if (colour.startsWith('#')) return colour
  const parsed = parseRGB(colour)
  if (parsed === null) return '#8D95A6'
  const hex = (value: number): string => value.toString(16).padStart(2, '0')
  return `#${hex(parsed.r)}${hex(parsed.g)}${hex(parsed.b)}`
}

/** Shared by the scene so every chalk colour goes through one conversion. */
export { toHex as waveHex }
