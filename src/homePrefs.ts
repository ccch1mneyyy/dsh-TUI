/**
 * Landing-screen preference for the TUI's workspace home screen.
 *
 * A one-key preference under `~/.dsh-tui/home.json`, deliberately NOT a cordis
 * config value: "has this installation shown the user the workspace home on a
 * fresh launch yet" is per-machine UI state, like the lang and tray
 * preferences next to it — not a deployment choice a cordis.yml row should own.
 *
 * The rule it enables is one-shot: the FIRST ordinary launch (no explicit
 * `--resume`, no workspace target) lands on the workspace home instead of a
 * blank conversation, because that is the launch where "which project am I
 * working on" has no answer yet. After that the chat screen is the landing
 * surface again, and the home screen stays reachable as a screen.
 *
 * A preference file that cannot be read or written is never fatal: the worst
 * outcome is one extra home screen, or a chat screen where the home was
 * expected. Both are recoverable with a single keypress.
 *
 * @module @deepseek-harness-tui/dsh-tui/homePrefs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

const PREFS_FILE = join(DATA_DIR, 'home.json')

interface HomePrefs {
  /** True once the workspace home has been shown as the landing screen. */
  seen?: boolean
}

/** Read the persisted landing preference; an unreadable file reads as unset. */
export function readHomePrefs(): HomePrefs {
  try {
    const parsed: unknown = JSON.parse(readFileSync(PREFS_FILE, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const seen = (parsed as { seen?: unknown }).seen
    return typeof seen === 'boolean' ? { seen } : {}
  } catch {
    return {}
  }
}

/**
 * Record that the workspace home has been shown.
 *
 * @returns True when the preference was durably written; false when the data
 *   directory is not writable (the caller stays silent — see the module note).
 */
export function markHomeSeen(): boolean {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(PREFS_FILE, `${JSON.stringify({ ...readHomePrefs(), seen: true }, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}
