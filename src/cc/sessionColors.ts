/**
 * Session accent colors for `/color` (CC's /color semantics): a small
 * named palette that overrides the prompt-input border (and its session
 * label chip) for ONE session, so side-by-side sessions can be told apart
 * at a glance. The name is persisted per session via a `session/color`
 * log event (channel.ts); these hex values are what the name resolves to
 * at render time.
 *
 * Values are mid-tone hues (Radix accent family, the same family CC's
 * /color palette comes from) chosen to stay readable as a border/accent
 * on both light and dark terminals.
 */

/** Named session accent colors: name → hex. */
export const SESSION_COLORS: Readonly<Record<string, `#${string}`>> = {
  red: '#E5484D',
  orange: '#F76B15',
  yellow: '#FFB224',
  green: '#46A758',
  blue: '#3E63DD',
  purple: '#8E4EC6',
  pink: '#D6409F',
  cyan: '#12A594',
}

/** The accepted `/color <name>` names, in display order. */
export const SESSION_COLOR_NAMES: readonly string[] = Object.keys(SESSION_COLORS)

/**
 * Whether `name` is a known session accent color (used by both the
 * command dispatch and the render-time resolution).
 */
export function isValidSessionColor(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(SESSION_COLORS, name)
}

/**
 * Resolve a session color name to its hex value, or undefined when the
 * name is unknown/empty (caller keeps the theme default).
 */
export function sessionColorHex(name: string): `#${string}` | undefined {
  return isValidSessionColor(name) ? SESSION_COLORS[name] : undefined
}
