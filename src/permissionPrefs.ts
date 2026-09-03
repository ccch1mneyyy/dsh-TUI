/**
 * Persisted permission-preset preference (`~/.dsh-tui/permission.json`). The
 * selected preset is a user default for fresh sessions; resumed sessions keep
 * the permission events recorded in their own history. The file is best
 * effort: a missing, corrupt, or no-longer-advertised preset falls back to
 * the host's configured permission default.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

const PREFS_DIR = DATA_DIR

/**
 * Read the persisted permission-preset id, or undefined when unset/invalid.
 * @param dir - Preferences directory (injectable for tests).
 * @returns The stored preset id, if present.
 */
export function readPermissionPref(dir: string = PREFS_DIR): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'permission.json'), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const preset = (parsed as Record<string, unknown>).preset
    return typeof preset === 'string' && preset.trim() !== '' ? preset : undefined
  } catch {
    return undefined
  }
}

/**
 * Persist the selected permission-preset id (best effort).
 * @param preset - Host-advertised preset id to persist.
 * @param dir - Preferences directory (injectable for tests).
 * @returns True when the file was written, false on failure.
 */
export function writePermissionPref(preset: string, dir: string = PREFS_DIR): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'permission.json'), JSON.stringify({ preset }, null, 2))
    return true
  } catch {
    return false
  }
}
