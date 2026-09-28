import React from 'react'
import { Box, Text } from '../ui.js'
import { renderCellRows } from './Whale.js'
import { WHALE_GIRL_COLS, WHALE_GIRL_SPRITE, WHALE_GIRL_SPRITE_ROWS } from './whaleGirlSprite.js'

/**
 * The maid portrait (鲸鱼娘) that can stand in for the header's pixel whale
 * (settings `dsh-tui.whaleGirl`): the author-designed 30×30 true-color
 * sprite in `whaleGirlSprite.ts`, rendered with the same half-block
 * technique as the whale — one `▀`/`▄` cell packs two sprite rows, so the
 * portrait shows at 30 columns × 15 rows. A static portrait by design: the
 * whale's idle planner and click-hearts stay whale-only, so `dsh-tui.whaleIdle`
 * has nothing to animate here (documented with the setting).
 */

/** Pre-rendered ANSI rows, computed once at module load. */
export const WHALE_GIRL_ROWS: readonly string[] = renderCellRows(
  WHALE_GIRL_COLS,
  WHALE_GIRL_SPRITE_ROWS,
  (x, y) => WHALE_GIRL_SPRITE[y]?.[x] ?? undefined,
)

/**
 * The portrait's center column when it fills the whale's 40-column box
 * (indented (40−30)/2 = 5, so the art spans columns 5..34 → center 19.5).
 * The welcome tagline centers on this instead of `WHALE_CENTER` in maid
 * mode, keeping the caption under the art it belongs to.
 */
export const WHALE_GIRL_CENTER = 19.5

/**
 * The maid portrait as an Ink component: 15 rows × 30 columns. `width` pins
 * the box (the header passes the whale's 40-column box so the neighbouring
 * text column never shifts) and centers the portrait inside it; without it
 * the component is exactly the portrait's own 30 columns (the star modal).
 */
export function WhaleGirlArt({ width }: { width?: number }): React.ReactNode {
  const pad = width === undefined ? 0 : Math.max(0, Math.floor((width - WHALE_GIRL_COLS) / 2))
  return (
    <Box flexDirection="column" flexShrink={0} width={width}>
      {WHALE_GIRL_ROWS.map((row, index) => (
        <Text key={index} wrap="truncate-end">
          {pad > 0 ? ' '.repeat(pad) : ''}{row}
        </Text>
      ))}
    </Box>
  )
}
