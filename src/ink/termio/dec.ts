/**
 * DEC (Digital Equipment Corporation) Private Mode Sequences
 *
 * DEC private modes use CSI ? N h (set) and CSI ? N l (reset) format.
 * These are terminal-specific extensions to the ANSI standard.
 */

import { csi } from './csi.js'

/**
 * DEC private mode numbers
 */
export const DEC = {
  CURSOR_VISIBLE: 25,
  ALT_SCREEN: 47,
  ALT_SCREEN_CLEAR: 1049,
  MOUSE_NORMAL: 1000,
  MOUSE_BUTTON: 1002,
  MOUSE_ANY: 1003,
  MOUSE_SGR: 1006,
  FOCUS_EVENTS: 1004,
  BRACKETED_PASTE: 2004,
  SYNCHRONIZED_UPDATE: 2026,
} as const

/**
 * Generate a CSI ? N h sequence to set a DEC private mode.
 * @param mode - the DEC private mode number.
 * @returns the CSI sequence.
 */
export function decset(mode: number): string {
  return csi(`?${mode}h`)
}

/**
 * Generate a CSI ? N l sequence to reset a DEC private mode.
 * @param mode - the DEC private mode number.
 * @returns the CSI sequence.
 */
export function decreset(mode: number): string {
  return csi(`?${mode}l`)
}

// Pre-generated sequences for common modes

/** Enable synchronized output updates (DECSET 2026). */
export const BSU = decset(DEC.SYNCHRONIZED_UPDATE)

/** Disable synchronized output updates (DECRESET 2026). */
export const ESU = decreset(DEC.SYNCHRONIZED_UPDATE)

/** Enable bracketed paste mode (DECSET 2004). */
export const EBP = decset(DEC.BRACKETED_PASTE)

/** Disable bracketed paste mode (DECRESET 2004). */
export const DBP = decreset(DEC.BRACKETED_PASTE)

/** Enable focus event reporting (DECSET 1004). */
export const EFE = decset(DEC.FOCUS_EVENTS)

/** Disable focus event reporting (DECRESET 1004). */
export const DFE = decreset(DEC.FOCUS_EVENTS)

/** Show the cursor (DECSET 25). */
export const SHOW_CURSOR = decset(DEC.CURSOR_VISIBLE)

/** Hide the cursor (DECRESET 25). */
export const HIDE_CURSOR = decreset(DEC.CURSOR_VISIBLE)

/** Enter the alternate screen, clearing it (DECSET 1049). */
export const ENTER_ALT_SCREEN = decset(DEC.ALT_SCREEN_CLEAR)

/** Exit the alternate screen (DECRESET 1049). */
export const EXIT_ALT_SCREEN = decreset(DEC.ALT_SCREEN_CLEAR)
// Mouse tracking: 1000 reports button press/release/wheel, 1002 adds drag
// events (button-motion), 1003 adds all-motion (no button held — for
// hover), 1006 uses SGR format (CSI < btn;col;row M/m) instead of legacy
// X10 bytes. Combined: wheel + click/drag for selection + hover.
/**
 * Enable full mouse tracking: modes 1000 (click/release/wheel), 1002 (drag),
 * 1003 (hover), and 1006 (SGR format).
 */
export const ENABLE_MOUSE_TRACKING =
  decset(DEC.MOUSE_NORMAL) +
  decset(DEC.MOUSE_BUTTON) +
  decset(DEC.MOUSE_ANY) +
  decset(DEC.MOUSE_SGR)

/** Disable all mouse tracking modes enabled by ENABLE_MOUSE_TRACKING. */
export const DISABLE_MOUSE_TRACKING =
  decreset(DEC.MOUSE_SGR) +
  decreset(DEC.MOUSE_ANY) +
  decreset(DEC.MOUSE_BUTTON) +
  decreset(DEC.MOUSE_NORMAL)
