/**
 * Cross-platform terminal clearing with scrollback support.
 * Detects modern terminals that support ESC[3J for clearing scrollback.
 */

import {
  CURSOR_HOME,
  csi,
  SGR_RESET,
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
 * (claude-code#35580), and dsh-tui's full resets run inside sync blocks.
 * Scrolling the content far above the viewport (CSI <n> S) blanks the
 * screen the same way — everything is pushed into the scrollback, the
 * viewport shows empty rows — without moving the viewport.
 * @returns the escape sequence that pushes content into the scrollback and homes the cursor.
 */
export function getClearTerminalSequence(rows?: number): string {
  // SGR_RESET first: CSI S fills the scrolled-in rows with the CURRENT
  // background color (BCE). Frame-end resets normally guarantee SGR=none,
  // but a truncated frame (dropped bytes, interrupted write) can leave a
  // colored background active — without the reset, this scroll floods the
  // blanked viewport with that color (seen in the wild as a full-screen
  // red wash, issue #10).
  //
  // Scroll by ONE viewport height, not a huge constant: blanking the screen
  // only needs the visible rows pushed out. The former scrollUp(10000)
  // overshot the terminal's finite scrollback capacity (Windows Terminal
  // defaults to 9001 lines) and evicted the user's ENTIRE scroll history,
  // replacing it with blank rows — the opposite of the "preserving the
  // scrollback" intent documented above. xterm.js-family terminals splice
  // on CSI S, so the overshoot also cost O(10000) buffer operations there.
  const n = rows && rows > 0 ? rows : (process.stdout.rows ?? 80)
  return SGR_RESET + scrollUp(n) + CURSOR_HOME
}

/**
 * Clears the terminal screen. On supported terminals, also clears scrollback.
 */
export const clearTerminal = getClearTerminalSequence()
