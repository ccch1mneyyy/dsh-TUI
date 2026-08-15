import { coerce } from 'semver'
import type { Writable } from 'stream'
import { appendFileSync } from 'node:fs'
import { env } from '../utils/env.js'
import { gte } from '../utils/semver.js'
import { getClearTerminalSequence } from './clearTerminal.js'
import type { Diff } from './frame.js'
import { cursorMove, cursorTo, eraseLines, SGR_RESET } from './termio/csi.js'
import { BSU, ESU, HIDE_CURSOR, SHOW_CURSOR } from './termio/dec.js'
import { link } from './termio/osc.js'

/**
 * Progress-report state for OSC 9;4: a state plus an optional percentage.
 */
export type Progress = {
  state: 'running' | 'completed' | 'error' | 'indeterminate'
  percentage?: number
}

/**
 * Checks if the terminal supports OSC 9;4 progress reporting.
 * Supported terminals:
 * - ConEmu (Windows) - all versions
 * - Ghostty 1.2.0+
 * - iTerm2 3.6.6+
 *
 * Note: Windows Terminal interprets OSC 9;4 as notifications, not progress.
 * @returns true when the terminal supports OSC 9;4 progress reporting.
 */
export function isProgressReportingAvailable(): boolean {
  // Only available if we have a TTY (not piped)
  if (!process.stdout.isTTY) {
    return false
  }

  // Explicitly exclude Windows Terminal, which interprets OSC 9;4 as
  // notifications rather than progress indicators
  if (process.env.WT_SESSION) {
    return false
  }

  // ConEmu supports OSC 9;4 for progress (all versions)
  if (
    process.env.ConEmuANSI ||
    process.env.ConEmuPID ||
    process.env.ConEmuTask
  ) {
    return true
  }

  const version = coerce(process.env.TERM_PROGRAM_VERSION)
  if (!version) {
    return false
  }

  // Ghostty 1.2.0+ supports OSC 9;4 for progress
  // https://ghostty.org/docs/install/release-notes/1-2-0
  if (process.env.TERM_PROGRAM === 'ghostty') {
    return gte(version.version, '1.2.0')
  }

  // iTerm2 3.6.6+ supports OSC 9;4 for progress
  // https://iterm2.com/downloads.html
  if (process.env.TERM_PROGRAM === 'iTerm.app') {
    return gte(version.version, '3.6.6')
  }

  return false
}

/**
 * Checks if the terminal supports DEC mode 2026 (synchronized output).
 * When supported, BSU/ESU sequences prevent visible flicker during redraws.
 * @returns true when the terminal supports DEC 2026.
 */
export function isSynchronizedOutputSupported(): boolean {
  // tmux parses and proxies every byte but doesn't implement DEC 2026.
  // BSU/ESU pass through to the outer terminal but tmux has already
  // broken atomicity by chunking. Skip to save 16 bytes/frame + parser work.
  if (process.env.TMUX) return false

  const termProgram = process.env.TERM_PROGRAM
  const term = process.env.TERM

  // Modern terminals with known DEC 2026 support
  if (
    termProgram === 'iTerm.app' ||
    termProgram === 'WezTerm' ||
    termProgram === 'WarpTerminal' ||
    termProgram === 'ghostty' ||
    termProgram === 'contour' ||
    termProgram === 'vscode' ||
    termProgram === 'alacritty'
  ) {
    return true
  }

  // kitty sets TERM=xterm-kitty or KITTY_WINDOW_ID
  if (term?.includes('kitty') || process.env.KITTY_WINDOW_ID) return true

  // Ghostty may set TERM=xterm-ghostty without TERM_PROGRAM
  if (term === 'xterm-ghostty') return true

  // foot sets TERM=foot or TERM=foot-extra
  if (term?.startsWith('foot')) return true

  // Alacritty may set TERM containing 'alacritty'
  if (term?.includes('alacritty')) return true

  // Zed uses the alacritty_terminal crate which supports DEC 2026
  if (process.env.ZED_TERM) return true

  // Windows Terminal
  if (process.env.WT_SESSION) return true

  // VTE-based terminals (GNOME Terminal, Tilix, etc.) since VTE 0.68
  const vteVersion = process.env.VTE_VERSION
  if (vteVersion) {
    const version = parseInt(vteVersion, 10)
    if (version >= 6800) return true
  }

  return false
}

// -- XTVERSION-detected terminal name (populated async at startup) --
//
// TERM_PROGRAM is not forwarded over SSH by default, so env-based detection
// fails when claude runs remotely inside a VS Code integrated terminal.
// XTVERSION (CSI > 0 q → DCS > | name ST) goes through the pty — the query
// reaches the *client* terminal and the reply comes back through stdin.
// App.tsx fires the query when raw mode enables; setXtversionName() is called
// from the response handler. Readers should treat undefined as "not yet known"
// and fall back to env-var detection.

let xtversionName: string | undefined

/**
 * Record the XTVERSION response. Called once from App.tsx when the reply
 * arrives on stdin. No-op if already set (defend against re-probe).
 * @param name - the terminal name reported by the XTVERSION reply.
 */
export function setXtversionName(name: string): void {
  if (xtversionName === undefined) xtversionName = name
}

/**
 * True if running in an xterm.js-based terminal (VS Code, Cursor, Windsurf
 * integrated terminals). Combines TERM_PROGRAM env check (fast, sync, but
 * not forwarded over SSH) with the XTVERSION probe result (async, survives
 * SSH — query/reply goes through the pty). Early calls may miss the probe
 * reply — call lazily (e.g. in an event handler) if SSH detection matters.
 * @returns true when the terminal is xterm.js-based.
 */
export function isXtermJs(): boolean {
  if (process.env.TERM_PROGRAM === 'vscode') return true
  return xtversionName?.startsWith('xterm.js') ?? false
}

// Terminals known to correctly implement the Kitty keyboard protocol
// (CSI >1u) and/or xterm modifyOtherKeys (CSI >4;2m) for ctrl+shift+<letter>
// disambiguation. We previously enabled unconditionally (#23350), assuming
// terminals silently ignore unknown CSI — but some terminals honor the enable
// and emit codepoints our input parser doesn't handle (notably over SSH and
// in xterm.js-based terminals like VS Code). tmux is allowlisted because it
// accepts modifyOtherKeys and doesn't forward the kitty sequence to the outer
// terminal.
// env.terminal is lowercased (utils/env.ts) and falls back to TERM when
// TERM_PROGRAM is unset — kitty doesn't set TERM_PROGRAM, so its TERM
// (xterm-kitty) is listed too. Warp sets TERM_PROGRAM=WarpTerminal and
// implements the kitty keyboard protocol (issue #110).
const EXTENDED_KEYS_TERMINALS = [
  'iterm.app',
  'kitty',
  'xterm-kitty',
  'wezterm',
  'ghostty',
  'tmux',
  'warpterminal',
  'windows-terminal',
]

/**
 * True if this terminal correctly handles extended key reporting
 * (Kitty keyboard protocol + xterm modifyOtherKeys).
 * @returns true when the terminal is on the extended-keys allowlist.
 */
export function supportsExtendedKeys(): boolean {
  return EXTENDED_KEYS_TERMINALS.includes(env.terminal ?? '')
}

/**
 * True if the terminal scrolls the viewport when it receives cursor-up
 * sequences that reach above the visible area. On Windows, conhost's
 * SetConsoleCursorPosition follows the cursor into scrollback
 * (microsoft/terminal#14774), yanking users to the top of their buffer
 * mid-stream. WT_SESSION catches WSL-in-Windows-Terminal where platform
 * is linux but output still routes through conhost.
 * @returns true when the cursor-up viewport-yank bug applies.
 */
export function hasCursorUpViewportYankBug(): boolean {
  return process.platform === 'win32' || !!process.env.WT_SESSION
}

/**
 * Whether synchronized output (DEC 2026) is available, computed once at
 * module load — terminal capabilities don't change mid-session. Exported
 * so callers can pass a sync-skip hint gated to specific modes.
 */
export const SYNC_OUTPUT_SUPPORTED = isSynchronizedOutputSupported()

/**
 * Render forensics: when DSH_TUI_RENDER_LOG names a file path, every painted
 * frame's raw ANSI bytes append to it (one JSON-escaped line per frame,
 * prefixed with a timestamp header). Real-terminal rendering corruption
 * (missing rows, stale attributes) cannot be reproduced in headless xterm
 * harnesses — this captures the exact byte stream the terminal received so
 * the corrupt frame can be diffed against the expected screen. Opt-in and
 * zero-cost when unset: the env read happens once at module load.
 */
const RENDER_LOG_PATH = process.env.DSH_TUI_RENDER_LOG ?? ''

function dumpFrame(buffer: string): void {
  if (RENDER_LOG_PATH === '') return
  try {
    appendFileSync(RENDER_LOG_PATH, `\n===== frame ${new Date().toISOString()} (${buffer.length} bytes) =====\n${JSON.stringify(buffer)}\n`)
  } catch {
    // Forensics must never break rendering: an unwritable log path (bad
    // directory, permissions) drops the dump, not the frame.
  }
}

/**
 * The output streams a terminal renders to.
 */
export type Terminal = {
  stdout: Writable
  stderr: Writable
}

/**
 * Write a frame diff to the terminal as a single buffered write. Wraps
 * the output in BSU/ESU synchronized-update markers unless skipSyncMarkers
 * is set. No-op when the diff contains no patches.
 * @param terminal - the terminal to write to.
 * @param diff - the frame diff patches to render.
 * @param skipSyncMarkers - when true, omit the BSU/ESU wrapping.
 */
export function writeDiffToTerminal(
  terminal: Terminal,
  diff: Diff,
  skipSyncMarkers = false,
): void {
  // No output if there are no patches
  if (diff.length === 0) {
    return
  }

  // BSU/ESU wrapping is opt-out to keep main-screen behavior unchanged.
  // Callers pass skipSyncMarkers=true when the terminal doesn't support
  // DEC 2026 (e.g. tmux) AND the cost matters (high-frequency alt-screen).
  const useSync = !skipSyncMarkers

  // Buffer all writes into a single string to avoid multiple write calls.
  // SGR_RESET + link('') head every frame: the diff engine computes style
  // and hyperlink transitions from a frame-start baseline of none — normally
  // guaranteed by the previous frame's tail resets, but a truncated frame
  // (interrupted write, dropped PTY bytes) leaves the terminal stuck with a
  // colored SGR / an open hyperlink. Every erase, hardware scroll, and LF
  // scroll fills blank cells with the CURRENT background (BCE), so one stuck
  // red background floods whole regions (issue #10). ~12 bytes per frame
  // turn the baseline assumption into a per-frame guarantee; on healthy
  // frames both sequences are idempotent no-ops.
  let buffer = (useSync ? BSU : '') + SGR_RESET + link('')

  for (const patch of diff) {
    switch (patch.type) {
      case 'stdout':
        buffer += patch.content
        break
      case 'clear':
        if (patch.count > 0) {
          buffer += eraseLines(patch.count)
        }
        break
      case 'clearTerminal':
        // Pass the live row count: the blank only needs one viewport worth
        // of scroll (see getClearTerminalSequence on why overshooting
        // evicts the user's real scrollback).
        buffer += getClearTerminalSequence(
          (terminal.stdout as unknown as { rows?: number }).rows,
        )
        break
      case 'cursorHide':
        buffer += HIDE_CURSOR
        break
      case 'cursorShow':
        buffer += SHOW_CURSOR
        break
      case 'cursorMove':
        buffer += cursorMove(patch.x, patch.y)
        break
      case 'cursorTo':
        buffer += cursorTo(patch.col)
        break
      case 'carriageReturn':
        buffer += '\r'
        break
      case 'hyperlink':
        buffer += link(patch.uri)
        break
      case 'styleStr':
        buffer += patch.str
        break
    }
  }

  // Add synchronized update end and flush buffer
  if (useSync) buffer += ESU
  dumpFrame(buffer)
  terminal.stdout.write(buffer)
}
