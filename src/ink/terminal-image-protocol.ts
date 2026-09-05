export type TerminalImageProtocol = 'kitty' | 'sixel' | 'none'

/** Overrides only choose a protocol; TTY/accessibility/handoff guards still apply. */
export function selectTerminalImageProtocol(
  kittyStatus: string | undefined,
  attributes: readonly number[] | undefined,
  override: string | undefined,
): TerminalImageProtocol {
  if (override === 'none' || override === 'kitty' || override === 'sixel') return override
  if (kittyStatus?.startsWith('OK')) return 'kitty'
  return attributes?.slice(1).includes(4) ? 'sixel' : 'none'
}
