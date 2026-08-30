import { appendFileSync } from 'node:fs'
import { DATA_DIR } from './paths.js'
import { join } from 'node:path'

/**
 * Debug logger for the ported Ink core. Writes to stderr only when
 * `DSH_TUI_DEBUG` is set, so normal runs stay quiet.
 * @param message - The message to log.
 * @param fields - Optional JSON-serialized fields appended to the line.
 */
export function logForDebugging(message: string, fields?: Record<string, unknown>): void {
  if (!process.env.DSH_TUI_DEBUG) return
  const suffix = fields === undefined ? '' : ` ${JSON.stringify(fields)}`
  process.stderr.write(`[dsh-tui] ${message}${suffix}\n`)
}

/**
 * Mouse-chain diagnostics: appends to `~/.dsh-tui/mouse-debug.log` when
 * `DSH_TUI_DEBUG_MOUSE` is set. Unlike logForDebugging (stderr), a file
 * keeps the fullscreen alt screen unpolluted and survives the session for
 * post-mortem reading. Every append is try/catch-guarded — diagnostics
 * must never take the UI down.
 * @param message - Stage name (e.g. 'mouse arrive', 'dispatchClick').
 * @param fields - Optional JSON-serialized fields appended to the line.
 */
export function logMouseDebug(message: string, fields?: Record<string, unknown>): void {
  if (!process.env.DSH_TUI_DEBUG_MOUSE) return
  const suffix = fields === undefined ? '' : ` ${JSON.stringify(fields)}`
  try {
    const line = `${new Date().toISOString()} ${message}${suffix}\n`
    // 0600 on creation: the log mirrors UI activity, incl. message content
    appendFileSync(join(DATA_DIR, 'mouse-debug.log'), line, { mode: 0o600 })
  } catch {
    // ignore — see doc comment
  }
}
