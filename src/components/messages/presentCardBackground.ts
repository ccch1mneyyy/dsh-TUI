/**
 * The `present` delivery card's own surface. Deliverables are results, so they
 * keep a face even when the user turned tool-card backgrounds off:
 *
 *  - `none`   — the palette's warm delivery token (a blend would turn brown on
 *               a blue-grey base, so this is a token, not a mix);
 *  - `subtle` / `strong` — the palette's delivery tint over its dim/strong
 *    card surface. Dark palettes use a deep violet at 20/26% so the face gets
 *    more purple without getting lighter; light palettes keep the soft
 *    lavender at 18/24%.
 *
 * Hover lifts the same hue toward white instead of switching to
 * `toolCardBackground`, which would make the tint vanish under the pointer.
 */
import type { ToolBackground } from '../../adapter/ports/channel-display.js'
import type { Theme } from '../../theme.js'
import { colorLuma, lightenColor, mixColor } from '../../utils/colorMix.js'

/** Tint strengths: dark palettes need a heavier, deeper violet. */
const DARK_SUBTLE_AMOUNT = 0.20
const DARK_STRONG_AMOUNT = 0.26
const LIGHT_SUBTLE_AMOUNT = 0.18
const LIGHT_STRONG_AMOUNT = 0.24
const HOVER_LIFT = 0.06

/** Resting and hover faces for one card. */
export interface PresentCardSurface {
  readonly background: string
  readonly hover: string
}

/**
 * Resolve the delivery face for the user's tool-background setting.
 * @param mode - The global `toolBackground` choice.
 * @param theme - Active palette.
 */
export function presentCardSurface(mode: ToolBackground, theme: Theme): PresentCardSurface {
  // Light text means a dark palette; an ANSI text colour that cannot be
  // parsed also falls back to the dark recipe.
  const darkPalette = (colorLuma(theme.text) ?? 255) >= 140
  const background = mode === 'none'
    ? theme.presentCardWarm
    : mixColor(
        mode === 'subtle' ? theme.toolCardBackgroundDim : theme.toolCardBackground,
        theme.presentCardTint,
        darkPalette
          ? (mode === 'subtle' ? DARK_SUBTLE_AMOUNT : DARK_STRONG_AMOUNT)
          : (mode === 'subtle' ? LIGHT_SUBTLE_AMOUNT : LIGHT_STRONG_AMOUNT),
      )
  return { background, hover: lightenColor(background, HOVER_LIFT) }
}
