/**
 * Persisted agent-preset preference (`/preset` picker choice), kept at
 * `~/.dsh-tui/agent-preset.json` (`preset` key) so the choice survives
 * restarts — same pattern as working-activity.json. The file is best-effort:
 * a missing/corrupt file or an id the roster no longer supplies simply falls
 * back to the roster default (`standard`). An explicit `preset` key in
 * cordis.yml wins over this preference (deployment choice over runtime
 * preference, matching activityFrames).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

const PREFS_DIR = DATA_DIR

/** Ids a preset directory may use (dsh-agent-presets' own boundary). */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/** Parse the value exactly as stored. Preset aliases are roster-dependent:
 * legacy rc.2 ships `code`, while the 0.1.2 line ships `ptc`, so this file
 * cannot safely canonicalize either name before the active roster has been queried. */
export function parsePresetPref(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const preset = (parsed as Record<string, unknown>).preset
    return typeof preset === 'string' && PRESET_ID.test(preset) ? preset : undefined
  } catch {
    return undefined
  }
}

/**
 * The persisted preset id, or undefined when unset or invalid.
 * @param dir - Prefs directory (injectable for tests).
 * @returns The persisted preset id, if any.
 */
export function readPresetPref(dir: string = PREFS_DIR): string | undefined {
  try {
    return parsePresetPref(readFileSync(join(dir, 'agent-preset.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Persist the chosen preset id (best effort).
 * @param preset - Preset id to persist.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was written, false on failure.
 */
export function writePresetPref(preset: string, dir: string = PREFS_DIR): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent-preset.json'), JSON.stringify({ preset }, null, 2))
    return true
  } catch {
    return false
  }
}

/** Rewrite a stored alias only after the active roster resolved its concrete
 * id. No-op for an exact match, an absent preference, or rosterless startup. */
export function migratePresetPref(
  requested: string | undefined,
  resolved: string | undefined,
  dir: string = PREFS_DIR,
): boolean {
  return requested === undefined || resolved === undefined || requested === resolved
    ? true
    : writePresetPref(resolved, dir)
}
