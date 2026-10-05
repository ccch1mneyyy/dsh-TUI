import React from 'react'
import chalk from 'chalk'
import { Box, NoSelect, Text, useTheme } from '../../ui.js'
import { useAnimationFrame } from '../../ink/hooks/use-animation-frame.js'
import { getTheme } from '../../theme.js'
import { alive, mix } from '../../trajectory/motion.js'
import { parseRGB } from '../Spinner/spinnerUtils.js'
import { dominantChannel } from '../../dsh-adapter/trajectory/index.js'
import type { WaveBand, WaveChannel } from '../../dsh-adapter/types.js'

/**
 * The mini wake — the whole session as a dozen glyphs in the status line.
 *
 * This is the conversation's only permanent mention that a second view of the
 * session exists, and it is deliberately not a label. A chip that says
 * `trajectory · ctrl+t` is read once and then becomes furniture; a strip that
 * *shows the session's shape* keeps earning its columns, because the shape
 * changes. Density says how hard the session is working, colour says at what,
 * a red column says something broke, and the breathing edge says it is still
 * going. Wanting to zoom in on that is a more reliable motivation than being
 * told a key exists.
 *
 * It also subsumes the unread-failure badge it replaces: a failure is already
 * a red column here, in the position where it happened, which is strictly more
 * information than a count in the corner.
 *
 * Cost is one row of nothing (it shares the hint row) and, at the default
 * width, sixteen columns. The band itself is memoized by the caller against
 * the row count, so a frame that only ticks the animation clock re-colours
 * these cells and computes nothing.
 */

/** Eight fill levels, same ramp as the full-scene wake. */
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const
const FULL = '█'
const IDLE = '·'
const RUNNING = '▶'

/** Lane colour per channel. */
function channelColor(channel: WaveChannel | undefined, theme: ReturnType<typeof getTheme>): string {
  switch (channel) {
    case 'input': return theme.professionalBlue
    case 'tool': return theme.chromeYellow
    case 'model': return theme.autoAccept
    default: return theme.subtle
  }
}

/**
 * Column budget for the mini wake at a given terminal width.
 *
 * It is the first thing to go on a narrow terminal: the status line's own
 * fields (model, tps, branch, cwd) are what a user reads constantly, and a
 * decoration that squeezes them is a decoration that has overstayed.
 *
 * @param columns - Terminal width in cells.
 * @returns Glyph count, or 0 when the strip should not render at all.
 */
export function miniWakeWidth(columns: number): number {
  if (columns >= 120) return 16
  if (columns >= 100) return 12
  if (columns >= 84) return 8
  return 0
}

export function MiniWake({
  band,
  hint,
  animate,
  onOpen,
  hoverHint,
}: {
  /** The session projected onto {@link miniWakeWidth} columns. */
  band: WaveBand
  /**
   * Key hint shown once beside the strip, until the trajectory has been
   * opened for the first time. Absent afterwards.
   */
  hint?: string
  /** Breathe the running cell. The strip owns this clock so its ticks
   *  re-render the strip alone, not the screen around it (#1207). */
  animate: boolean
  /**
   * Open the trajectory scene. The strip is the conversation's permanent
   * pointer at that second view, so pointing AT it and clicking is the
   * gesture the affordance implies — the key chord stays as the alternative,
   * not the only way in.
   */
  onOpen?: () => void
  /** Key chord revealed while the pointer rests on the strip (the first-run
   *  hint has already retired by then). */
  hoverHint?: string
}): React.ReactNode {
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const [hovered, setHovered] = React.useState(false)
  const [clockRef, time] = useAnimationFrame(animate ? 120 : null)
  if (band.buckets.length === 0) return null

  const logFloor = Math.log1p(Math.max(0, band.floor))
  const logSpan = Math.max(1e-6, Math.log1p(Math.max(1, band.peak)) - logFloor)
  const breath = alive(Math.floor(time / 120))

  let strip = ''
  for (const bucket of band.buckets) {
    if (bucket.count === 0) {
      strip += chalk.hex(toHex(theme.subtle))(IDLE)
      continue
    }
    if (bucket.running) {
      strip += chalk.hex(toHex(mix(theme.success, theme.planMode, breath) as string))(RUNNING)
      continue
    }
    const level = Math.min(
      BLOCKS.length,
      Math.max(1, Math.round(((Math.log1p(bucket.weight) - logFloor) / logSpan) * (BLOCKS.length - 1)) + 1),
    )
    const failed = bucket.error || bucket.retry
    // A failure is raised to at least half height: at this size a one-level
    // red cell is easy to miss, and missing it defeats the point.
    const shown = failed ? Math.max(level, 4) : level
    const colour = failed ? theme.error : channelColor(dominantChannel(bucket), theme)
    strip += chalk.hex(toHex(colour))(shown >= BLOCKS.length ? FULL : BLOCKS[shown - 1]!)
  }

  // The hint slot narrates the affordance: first-run chord, then — while the
  // pointer is on the strip — the chord again, because that is the moment the
  // user is asking "what does this thing do".
  const shownHint = hint ?? (hovered && onOpen !== undefined ? hoverHint : undefined)
  return (
    <NoSelect>
      <Box
        ref={clockRef}
        flexShrink={0}
        flexDirection="row"
        gap={1}
        onClick={onOpen}
        onMouseEnter={onOpen !== undefined ? (): void => setHovered(true) : undefined}
        onMouseLeave={onOpen !== undefined ? (): void => setHovered(false) : undefined}
      >
        <Text>{strip}</Text>
        {shownHint !== undefined ? <Text color={hovered && hint === undefined ? 'accent' : 'subtle'}>{shownHint}</Text> : null}
      </Box>
    </NoSelect>
  )
}

/** Theme colour → `#rrggbb`, the form chalk needs. */
function toHex(colour: string): string {
  if (colour.startsWith('#')) return colour
  const parsed = parseRGB(colour)
  if (parsed === null) return '#8D95A6'
  const hex = (value: number): string => value.toString(16).padStart(2, '0')
  return `#${hex(parsed.r)}${hex(parsed.g)}${hex(parsed.b)}`
}
