/**
 * Cross-platform terminal clearing with scrollback support.
 * Detects modern terminals that support ESC[3J for clearing scrollback.
 */

import {
  CURSOR_HOME,
  csi,
  scrollUp,
} from './termio/csi.js'

// HVP (Horizontal Vertical Position) - legacy Windows cursor home
const CURSOR_HOME_WINDOWS = csi(0, 'f')

function isWindowsTerminal(): boolean {
  return process.platform === 'win32' && !!process.env.WT_SESSION
}

function isMintty(): boolean {
  // mintty 3.1.5+ sets TERM_PROGRAM to 'mintty'
  if (process.env.TERM_PROGRAM === 'mintty') {
    return true
  }
  // GitBash/MSYS2/MINGW use mintty and set MSYSTEM
  if (process.platform === 'win32' && process.env.MSYSTEM) {
    return true
  }
  return false
}

function isModernWindowsTerminal(): boolean {
  // Windows Terminal sets WT_SESSION environment variable
  if (isWindowsTerminal()) {
    return true
  }

  // VS Code integrated terminal on Windows with ConPTY support
  if (
    process.platform === 'win32' &&
    process.env.TERM_PROGRAM === 'vscode' &&
    process.env.TERM_PROGRAM_VERSION
  ) {
    return true
  }

  // mintty (GitBash/MSYS2/Cygwin) supports modern escape sequences
  if (isMintty()) {
    return true
  }

  return false
}

/**
 * Returns the ANSI escape sequence to blank the screen while PRESERVING the
 * scrollback (user-scrolled history).
 *
 * NOT using ESC[2J / ESC[3J: inside a DEC 2026 sync-output block (BSU/ESU)
 * Windows Terminal snaps the viewport back to the top on those sequences
 * (claude-code#35580), and dsh-cc's full resets run inside sync blocks.
 * Scrolling the content far above the viewport (CSI <n> S) blanks the
 * screen the same way — everything is pushed into the scrollback, the
 * viewport shows empty rows — without moving the viewport.
 */
export function getClearTerminalSequence(): string {
  // Large enough to push any realistic screen + scrollback above the
  // viewport; scrolling past the buffer end just yields blank rows.
  return scrollUp(10000) + CURSOR_HOME
}

/**
 * Clears the terminal screen. On supported terminals, also clears scrollback.
 */
export const clearTerminal = getClearTerminalSequence()
