/**
 * Persisted fullscreen preference (`~/.dsh-tui/fullscreen.json`). Set via the
 * /settings `fullscreen` toggle: cordis inject callbacks always run after the
 * TUI bootstrap, so the settings document cannot feed the boot-time layout
 * decision directly — the toggle mirrors its choice here and the next boot
 * reads it synchronously. The file is best-effort: a missing/corrupt file
 * falls back to cordis.yml's `fullscreen`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

const PREFS_DIR = DATA_DIR

/**
 * The persisted fullscreen choice, or undefined when unset or invalid.
 * @param dir - Prefs directory (injectable for tests).
 * @returns The persisted fullscreen flag, if any.
 */
export function readFullscreenPref(dir: string = PREFS_DIR): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'fullscreen.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const fullscreen = (parsed as Record<string, unknown>).fullscreen
    return typeof fullscreen === 'boolean' ? fullscreen : undefined
  } catch {
    return undefined
  }
}

/**
 * Persist the fullscreen choice (best effort).
 * @param fullscreen - Fullscreen flag to persist.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was written, false on failure.
 */
export function writeFullscreenPref(fullscreen: boolean, dir: string = PREFS_DIR): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'fullscreen.json'), JSON.stringify({ fullscreen }, null, 2))
    return true
  } catch {
    return false
  }
}
