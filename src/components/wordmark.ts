/**
 * Welcome wordmark designs for the header splash.
 *
 * `classic` is the shipped `DEEPSEEK` / `HARNESS` pair. `deepsleep` is the
 * wordplay from the whale-wordmark art study
 * (`design/whale-wordmarks`): the first line reads `DEEPS` in the brand-blue
 * gradient and `LEEP` in narrow four-column ice-blue letters — one glyph
 * tighter, so `DEEPSLEEP` reads as a single word — while `HARNESS` below uses
 * a wider letter gap and ends on exactly the same column, and a single
 * floating sleep-Z hangs above the right edge of the pair, copied from the
 * whale sprite's `Z` plane.
 */
import { bigTextWidth, renderBigLine, renderBigText, type BigTextSegment, type Rgb } from './bigfont.js'
import { renderSpriteRows } from './Whale.js'

/** The wordmark designs the splash can draw. */
export type WordmarkStyle = 'classic' | 'deepsleep'

/** Every style, for pickers and probes. */
export const WORDMARK_STYLES: readonly WordmarkStyle[] = ['classic', 'deepsleep']

/** The style the header ships with. */
export const DEFAULT_WORDMARK: WordmarkStyle = 'deepsleep'

/** Header colors a style paints with (all three come from the active theme). */
export interface WordmarkPalette {
  /** Brand blue — `theme.accent`. */
  readonly brand: Rgb
  /** Ice blue — `theme.activity`. */
  readonly ice: Rgb
  /** Pale highlight closing the ice ramp. */
  readonly pale: Rgb
}

/** Five ANSI rows per line, plus the width both lines are built to. */
export interface WordmarkLines {
  readonly top: readonly string[]
  readonly bottom: readonly string[]
  readonly width: number
}

/**
 * The letter gap that makes 7 letters of `HARNESS` end on the same column as
 * `DEEPS` (gap 2) + a one-column separator + the narrow 4-column `LEEP`:
 * 5·5+4·2 + 1 + 4·4+3·1 = 53 = 7·5+6·3.
 */
const BALANCED_LETTER_GAP = 3

/** Width of the `DEEP SLEEP` pair — both rows measure this. */
export const DEEP_SLEEP_WIDTH = 53

/**
 * The 4×4 sleep-Z drawn above the wordmark's right edge, from the art
 * study's extended frame (`extraZ`) — the same glyph the whale's sleep
 * frames carry in their `Z` plane.
 */
const SLEEP_Z_GLYPH: readonly string[] = ['████', '···█', '··█·', '████']

/** The whale sprite's gray sleep-Z tone (`Z` in the sprite palette). */
const SLEEP_Z_RGB: readonly [number, number, number] = [128, 128, 128]

/** Column the floating sleep-Z starts on, right-aligned inside the wordmark. */
export const SLEEP_Z_COLUMN = DEEP_SLEEP_WIDTH - SLEEP_Z_GLYPH[0].length

/** The floating sleep-Z as two half-block ANSI rows (upper pixels, lower pixels). */
export const SLEEP_Z_ROWS: readonly string[] = renderSpriteRows(SLEEP_Z_GLYPH, { '█': SLEEP_Z_RGB })

/** Display width a style needs before the big title is drawn. */
export function wordmarkWidth(style: WordmarkStyle): number {
  return style === 'deepsleep' ? DEEP_SLEEP_WIDTH : bigTextWidth('DEEPSEEK')
}

/** The `DEEPS` + narrow `LEEP` segments of the `DEEP SLEEP` first line. */
export function deepSleepSegments(palette: WordmarkPalette): readonly BigTextSegment[] {
  return [
    { text: 'DEEPS', from: palette.brand, to: palette.ice },
    { text: 'LEEP', from: palette.ice, to: palette.pale, narrow: true, gap: 1, separator: 1 },
  ]
}

/** Render one style's two block-font lines with the palette's gradients. */
export function renderWordmark(
  style: WordmarkStyle,
  time: number,
  palette: WordmarkPalette,
  flash: Rgb,
  stepMs = 60,
): WordmarkLines {
  if (style === 'deepsleep') {
    return {
      top: renderBigLine(deepSleepSegments(palette), time, flash, stepMs),
      bottom: renderBigLine(
        [{ text: 'HARNESS', from: palette.brand, to: palette.ice, gap: BALANCED_LETTER_GAP }],
        time, flash, stepMs,
      ),
      width: DEEP_SLEEP_WIDTH,
    }
  }
  return {
    top: renderBigText('DEEPSEEK', time, palette.brand, palette.ice, flash, stepMs),
    bottom: renderBigText('HARNESS', time, palette.ice, palette.pale, flash, stepMs),
    width: bigTextWidth('DEEPSEEK'),
  }
}
