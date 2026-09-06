/**
 * Persisted reasoning-effort preference (`~/.dsh-tui/effort.json`). Set via
 * `/effort` (slider or `/effort <id>`; `/effort status` reports the current
 * level) — note Shift+Tab cycles session modes (default/plan/full), not
 * effort levels. The choice lands here so the next boot starts on it. The
 * file is best-effort: a missing/corrupt file or a level the current adapter
 * does not offer just falls back to the provider default — the first
 * request/header event always re-asserts the truth on the status line.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

const PREFS_DIR = DATA_DIR

/**
 * The persisted reasoning-effort id, or undefined when unset or invalid.
 * @param dir - Prefs directory (injectable for tests).
 * @returns The persisted effort id, if any.
 */
export function readEffortPref(dir: string = PREFS_DIR): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'effort.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const effort = (parsed as Record<string, unknown>).effort
    return typeof effort === 'string' && effort !== '' ? effort : undefined
  } catch {
    return undefined
  }
}

/**
 * Default reasoning-effort precedence for sessions that do not carry their
 * own choice: the /settings 默认推理强度 user layer (`settings.yaml
 * dsh-tui.effortDefault`; the plugin folds the `auto` option to undefined
 * before calling), then the cordis.yml `effort` pin, then this persisted
 * `/effort` file, then the adapter/model default (undefined). Mirrors the
 * lang chain (settings user layer > cordis.yml > lang.json).
 * @param settingsDefault - settings user-layer level (undefined = auto).
 * @param configured - cordis.yml `effort` value, if any.
 * @param persisted - The /effort choice, if any.
 * @returns The winning level id, or undefined for the adapter default.
 */
export function resolveEffortDefault(
  settingsDefault: string | undefined,
  configured: string | undefined,
  persisted: string | undefined,
): string | undefined {
  return settingsDefault ?? configured ?? persisted
}

/**
 * Persist the chosen reasoning-effort id (best effort).
 * @param effort - Adapter-owned effort id to persist.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was written, false on failure.
 */
export function writeEffortPref(effort: string, dir: string = PREFS_DIR): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'effort.json'), JSON.stringify({ effort }, null, 2))
    return true
  } catch {
    return false
  }
}
