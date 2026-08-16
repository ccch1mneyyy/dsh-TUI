/**
 * Persisted easter-egg toggle (`/easter-egg on|off`), kept at
 * `~/.dsh-tui/easter-egg.json` (`easterEgg` key) so the choice survives
 * restarts — same pattern as agent-preset.json. The file is best-effort:
 * a missing/corrupt file falls back to `false` (off). An explicit
 * `easterEgg` key in cordis.yml wins over this preference (deployment
 * choice over runtime preference, matching activityFrames/preset).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

const PREFS_DIR = DATA_DIR

/**
 * Parse a persisted `{ easterEgg }` value; anything else yields undefined.
 * @param text - Raw file contents.
 * @returns The toggle state when valid, else undefined.
 */
export function parseEasterEggPref(text: string): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const value = (parsed as Record<string, unknown>).easterEgg
    return typeof value === 'boolean' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * The persisted toggle, or undefined when unset or invalid.
 * @param dir - Prefs directory (injectable for tests).
 * @returns Whether the easter egg is on, if persisted.
 */
export function readEasterEggPref(dir: string = PREFS_DIR): boolean | undefined {
  try {
    return parseEasterEggPref(readFileSync(join(dir, 'easter-egg.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Persist the toggle (best effort).
 * @param enabled - Whether the easter egg is on.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was written, false on failure.
 */
export function writeEasterEggPref(enabled: boolean, dir: string = PREFS_DIR): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'easter-egg.json'), JSON.stringify({ easterEgg: enabled }, null, 2))
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the effective toggle: an explicit cordis.yml value wins over the
 * persisted `/easter-egg` choice, which wins over the default (off).
 * @param configured - cordis.yml `easterEgg` value, undefined when unset.
 * @param dir - Prefs directory (injectable for tests).
 * @returns Whether the easter egg should play.
 */
export function resolveEasterEgg(configured: boolean | undefined, dir: string = PREFS_DIR): boolean {
  return configured ?? readEasterEggPref(dir) ?? false
}

/**
 * Trigger predicate for the celebration: the egg plays when a `liangshen`
 * preset switch actually landed and the toggle is on. Pure so the chat
 * screen stays thin and headless tests can pin the rule.
 * @param presetId - The preset id the switch targeted.
 * @param switched - Whether the switch succeeded (channel.switchPreset result).
 * @param enabled - The effective toggle value.
 * @returns Whether the egg should play.
 */
export function shouldPlayEasterEgg(presetId: string, switched: boolean, enabled: boolean): boolean {
  return switched && enabled && presetId === 'liangshen'
}
