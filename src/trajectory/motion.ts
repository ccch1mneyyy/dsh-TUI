/**
 * Trajectory motion — five verbs, one shared clock, one hard rule.
 *
 * ## The rule: SGR-only
 *
 * The renderer diffs frames cell by cell and emits the smallest patch that
 * reconciles them. A cell whose *style* changed costs a few bytes of SGR; a
 * row whose *layout* changed costs a full row rewrite, and in inline mode a
 * frame that got shorter takes the full-reset path that once deposited a copy
 * of the whole UI into scrollback on every repaint (issues #38/#39/#19/#10).
 *
 * So every verb below animates colour and colour only. Nothing here changes a
 * glyph count, a row count, or a box dimension. `verify-trace-motion` asserts
 * this mechanically by capturing the write stream across a hundred ticks and
 * failing on any row-level escape — the rule is machine-enforced, not a
 * convention someone has to remember.
 *
 * ## The verbs
 *
 * | verb        | shape                      | used for                        |
 * |-------------|----------------------------|---------------------------------|
 * | `arrive`    | one bright frame, settle   | a row or wave column just landed |
 * | `reproject` | dim → bright, two frames   | the same data, re-sorted/filtered |
 * | `alert`     | two flashes, then steady   | an error, a retry, a pending ask |
 * | `alive`     | slow breath, loops         | the running edge (1–2 cells max) |
 * | `navigate`  | *nothing*                  | cursor, viewport, inspector      |
 *
 * `navigate` having no animation is a decision, not an omission: easing on a
 * cursor is latency you can feel, and key auto-repeat already supplies the
 * sense of continuity.
 *
 * ## Cost
 *
 * No timer is created here. The imperative trajectory scene owns the shared
 * animation clock and repaints only while it is active, so an idle session
 * animates nothing.
 */

import { interpolateColor, parseRGB, type RGBColor } from '../components/Spinner/spinnerUtils.js'
type RawColor =
  | `rgb(${number},${number},${number})`
  | `#${string}`
  | `ansi256(${number})`
  | `ansi:${
    | 'black'
    | 'red'
    | 'green'
    | 'yellow'
    | 'blue'
    | 'magenta'
    | 'cyan'
    | 'white'
    | 'blackBright'
    | 'redBright'
    | 'greenBright'
    | 'yellowBright'
    | 'blueBright'
    | 'magentaBright'
    | 'cyanBright'
    | 'whiteBright'}`

/** Scene clock period. One tick drives every verb below. */
export const MOTION_TICK_MS = 100

/** Ticks a one-shot verb runs for before settling. */
export const MOTION_SPANS = {
  arrive: 2,
  reproject: 3,
  /** Two flashes: bright, dim, bright, dim, then steady. */
  alert: 8,
} as const

/** Ticks per half-breath of the `alive` verb (~600 ms in, 600 ms out). */
const BREATH_TICKS = 6

/** Format an RGB triple the way the theme and `<Text color>` expect. */
export function rgbString(color: RGBColor): RawColor {
  return `rgb(${color.r},${color.g},${color.b})`
}

/**
 * Blend two colours, accepting either theme values (`rgb(r,g,b)`) or hex.
 *
 * @param base - Colour at `t = 0`.
 * @param highlight - Colour at `t = 1`.
 * @param t - Blend position, clamped into [0, 1].
 * @returns A colour string `<Text color>` accepts, or `base` when either
 *   input could not be parsed (a custom theme may carry an ANSI name).
 */
export function mix(base: string, highlight: string, t: number): RawColor {
  const from = parseRGB(base)
  const to = parseRGB(highlight)
  // An unparseable input (a custom theme may carry an ANSI name, which has no
  // channels to interpolate) falls back to the base rather than to grey.
  if (from === null || to === null) return base as RawColor
  return rgbString(interpolateColor(from, to, Math.min(1, Math.max(0, t))))
}

/**
 * The `alive` verb: a triangular breath in [0, 1], synchronized across every
 * caller because they all read the same clock.
 *
 * @param tick - Current scene tick.
 * @returns Blend position for {@link mix}.
 */
export function alive(tick: number): number {
  const phase = ((tick % (BREATH_TICKS * 2)) + BREATH_TICKS * 2) % (BREATH_TICKS * 2)
  return phase < BREATH_TICKS ? phase / BREATH_TICKS : (BREATH_TICKS * 2 - phase) / BREATH_TICKS
}

/**
 * Progress of a one-shot verb.
 *
 * @param tick - Current scene tick.
 * @param startTick - Tick the verb was triggered on.
 * @param span - Duration in ticks.
 * @returns Elapsed ticks, or `null` once the verb has settled (or when
 *   `startTick` is in the future, which happens for one frame after a reset).
 */
function elapsed(tick: number, startTick: number, span: number): number | null {
  const age = tick - startTick
  return age < 0 || age >= span ? null : age
}

/**
 * The `arrive` verb: one bright frame, then settle.
 *
 * @returns Blend position, or 0 once settled.
 */
export function arrive(tick: number, startTick: number): number {
  const age = elapsed(tick, startTick, MOTION_SPANS.arrive)
  if (age === null) return 0
  return 1 - age / MOTION_SPANS.arrive
}

/**
 * The `reproject` verb: the view dims, then comes back up. Used when the same
 * rows are re-ordered or re-filtered, so the eye is told "this is the same
 * data, rearranged" rather than "this is a new screen".
 *
 * @returns Dim factor in [0, 1] where 1 is fully dimmed, 0 fully settled.
 */
export function reproject(tick: number, startTick: number): number {
  const age = elapsed(tick, startTick, MOTION_SPANS.reproject)
  if (age === null) return 0
  return 1 - (age + 1) / MOTION_SPANS.reproject
}

/**
 * The `alert` verb: two flashes, then steady. Deliberately one-shot — a
 * looping alarm is noise, and an error that keeps blinking after you have
 * seen it trains you to ignore it.
 *
 * @returns Blend position toward the highlight, or 0 once steady.
 */
export function alert(tick: number, startTick: number): number {
  const age = elapsed(tick, startTick, MOTION_SPANS.alert)
  if (age === null) return 0
  // 8 ticks: on, off, on, off — each phase two ticks wide.
  return Math.floor(age / 2) % 2 === 0 ? 1 : 0
}

/**
 * Colour for a running cell (the `alive` verb applied to a theme pair).
 *
 * @param tick - Current scene tick.
 * @param base - Settled colour.
 * @param highlight - Peak-of-breath colour.
 */
export function aliveColor(tick: number, base: string, highlight: string): RawColor {
  return mix(base, highlight, alive(tick))
}
