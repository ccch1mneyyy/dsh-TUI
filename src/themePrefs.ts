/**
 * Persisted color-theme preference. The `/theme` choice (built-in palette
 * or user theme name) survives restarts in `~/.dsh-tui/theme.json`, mirroring
 * the working-activity preference (`~/.dsh-tui/working-activity.json`). The
 * file is best-effort: a missing or corrupt file just falls back to the
 * default (terminal-background auto-detection). The preference only wins
 * when DSH_TUI_THEME is unset — see ThemeProvider.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSafeThemeName } from './customTheme.js'
import { DATA_DIR } from './utils/paths.js'

const PREFS_DIR = DATA_DIR

/**
 * Parse a persisted `{ theme }` value; anything else yields undefined.
 * @param text - Raw file contents.
 * @returns The theme name when valid, else undefined.
 */
export function parseThemePref(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const theme = (parsed as Record<string, unknown>).theme
    return typeof theme === 'string' && isSafeThemeName(theme) ? theme : undefined
  } catch {
    return undefined
  }
}

/**
 * The persisted theme name, or undefined when unset or invalid.
 * @param dir - Prefs directory (injectable for tests).
 * @returns The persisted theme name, if any.
 */
export function readThemePref(dir: string = PREFS_DIR): string | undefined {
  try {
    return parseThemePref(readFileSync(join(dir, 'theme.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Persist the chosen theme name (best effort).
 * @param name - Theme name to persist.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was written, false on failure.
 */
export function writeThemePref(name: string, dir: string = PREFS_DIR): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'theme.json'), JSON.stringify({ theme: name }, null, 2))
    return true
  } catch {
    return false
  }
}
