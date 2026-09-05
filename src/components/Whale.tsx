import React from 'react'
import { Box, Text } from '../ui.js'
import { WHALE_FRAMES, type WhaleFrame } from './whaleFrames.js'
import { composeWhaleGrid, poseKey, type WhaleLayerPose } from './whaleLayers.js'

/**
 * The DeepSeek pixel whale from the hand-drawn Excel art (whale_frames.zip):
 * a 40×25 sprite in six true-color tones (deep-navy outline, DeepSeek-blue
 * body, ice-blue belly, white mouth, pink heart, gray sleep-Z). Rendered
 * with the half-block technique — each terminal cell packs two vertical
 * pixels into one `▀`/`▄` glyph (foreground = upper pixel, background =
 * lower), so the whale shows at 40 columns × 13 rows with visually square
 * pixels.
 */

type Rgb = readonly [number, number, number]

/** Sprite palette: D outline · B body · L belly · W mouth · H heart · Z sleep-Z · `.` transparent. */
const PALETTE: Record<string, Rgb | undefined> = {
  D: [20, 38, 96],
  B: [78, 111, 255],
  L: [190, 225, 255],
  W: [255, 255, 255],
  H: [204, 51, 153],
  Z: [128, 128, 128],
}

const fg = (rgb: Rgb): string => `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
const bg = (rgb: Rgb): string => `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
const RESET = '\x1b[0m'
/** Erase from the cursor to the end of the physical line (default colors). */
const ERASE_TO_EOL = '\x1b[K'
/** Reset the background plane to the terminal default (fg keeps its SGR). */
const BG_DEFAULT = '\x1b[49m'

/**
 * Render one frame to ANSI rows (one per sprite row pair) under its own
 * palette. Consecutive cells sharing one style are run-length encoded; every
 * row spans the full sprite width (transparent cells write plain spaces, so
 * the blank cells of a diff region are re-output and overwrite whatever the
 * previous frame painted there), and each row closes with an erase-to-EOL:
 * the text pipeline may trim trailing whitespace, and the erase guarantees
 * the terminal itself clears every cell past the row's last glyph — no
 * ghost pixels can survive a frame switch.
 */
export function renderSpriteRows(sprite: readonly string[], palette: Record<string, Rgb | undefined>): string[] {
  const rows: string[] = []
  for (let r = 0; r < sprite.length; r += 2) {
    const upper = sprite[r]
    const lower = sprite[r + 1] ?? ''
    let out = ''
    let current = ''
    for (let x = 0; x < upper.length; x++) {
      const up = palette[upper[x]]
      const lo = palette[lower[x]]
      let seq: string
      let ch: string
      if (up !== undefined && lo !== undefined) {
        seq = fg(up) + bg(lo)
        ch = '▀'
      } else if (up !== undefined) {
        // Half-filled cell: the empty half must show the terminal's default
        // background, and SGR persists across cells — a bg left over from
        // the previous cell would paint a phantom pixel into the empty half
        // (the contour noise of the sprite). Reset it explicitly.
        seq = fg(up) + BG_DEFAULT
        ch = '▀'
      } else if (lo !== undefined) {
        seq = fg(lo) + BG_DEFAULT
        ch = '▄'
      } else {
        seq = ''
        ch = ' '
      }
      if (seq !== current) {
        out += seq === '' ? RESET : seq
        current = seq
      }
      out += ch
    }
    // Always close the row's style — a row ending on a colored cell would
    // otherwise leak its SGR into the line's remaining padding — then append
    // the erase pass (see the doc above).
    let row = out
    if (!row.endsWith(RESET)) row += RESET
    rows.push(row + ERASE_TO_EOL)
  }
  return rows
}

/** Pre-rendered ANSI rows for every whale frame, computed once at module load. */
const RENDERED: readonly string[][] = WHALE_FRAMES.map(frame => renderSpriteRows(frame.rows, PALETTE))

/**
 * Layered-pose render cache: composed grids are pure functions of the pose,
 * and idle ticks repaint the same handful of poses thousands of times.
 */
const LAYERED_CACHE = new Map<string, string[]>()

/** Render one composed pose (body + action layers) to ANSI rows, cached. */
export function layeredWhaleRows(pose: WhaleLayerPose): string[] {
  const key = poseKey(pose)
  const cached = LAYERED_CACHE.get(key)
  if (cached !== undefined) return cached
  const rows = renderSpriteRows(composeWhaleGrid(pose).map(row => row.join('')), PALETTE)
  LAYERED_CACHE.set(key, rows)
  return rows
}


/** Index of the `standard` frame — the settled header's static pose. */
export const STANDARD_FRAME_INDEX = 0

/**
 * One whale pose as an Ink component: 13 rows × 40 columns, never
 * shrinking. Pass `frameIndex` from the opening sequence while animating, or
 * STANDARD_FRAME_INDEX for the static header whale. `width` pins the box
 * width so the neighbouring text column never shifts when frames widen
 * (the tail-wag frames reach 4 columns further right than standard).
 */
export function WhaleArt({
  frameIndex = STANDARD_FRAME_INDEX,
  pose,
  width,
}: {
  frameIndex?: number
  /** Layered pose (parallel actions composited); wins over `frameIndex`. */
  pose?: WhaleLayerPose
  width?: number
}): React.ReactNode {
  const rows = pose !== undefined ? layeredWhaleRows(pose) : RENDERED[frameIndex] ?? RENDERED[STANDARD_FRAME_INDEX]
  return (
    <Box flexDirection="column" flexShrink={0} width={width}>
      {rows.map((row, index) => (
        <Text key={index} wrap="truncate-end">
          {row}
        </Text>
      ))}
    </Box>
  )
}

