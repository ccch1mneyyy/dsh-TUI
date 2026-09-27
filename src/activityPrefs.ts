/**
 * Persisted working-activity indicator preference, mirroring the pi
 * working-activity extension's `~/.pi/agent/working-activity.json`
 * (`frames` key). dsh-tui keeps its own copy at
 * `~/.dsh-tui/working-activity.json` so the `/activity` choice survives
 * restarts. The file is best-effort: a missing or corrupt file (or an
 * unknown preset left behind by an older version) just falls back to the
 * default preset.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPresetName, normalizeActivityPreset } from './components/activityFrames.js'
import { featureOn, FEATURE_FLAGS, parseWorkingActivityConfig, type WorkingActivityConfig } from 'dsh-working-activity/config'
import type { Config as MountedActivityConfig } from 'dsh-working-activity'
import { DATA_DIR } from './utils/paths.js'

const PREFS_DIR = DATA_DIR

/**
 * Parse a persisted `{ frames }` value; anything else yields undefined.
 * @param text - Raw file contents.
 * @returns The preset name when valid, else undefined.
 */
export function parseActivityFrames(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const frames = (parsed as Record<string, unknown>).frames
    return typeof frames === 'string' && isPresetName(frames) ? normalizeActivityPreset(frames) : undefined
  } catch {
    return undefined
  }
}

/**
 * The persisted indicator preset name, or undefined when unset or invalid.
 * @param dir - Prefs directory (injectable for tests).
 * @returns The persisted preset name, if any.
 */
export function readActivityFrames(dir: string = PREFS_DIR): string | undefined {
  try {
    return parseActivityFrames(readFileSync(join(dir, 'working-activity.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Read the full pi-style working-activity config (frames / mode / features /
 * customPhrases / customActions / narrate / thresholds) from the same JSON
 * file the `/activity` command writes, parsed by the wa package. Best-effort:
 * a missing or corrupt file yields undefined (callers use their defaults).
 * @param dir - Prefs directory (injectable for tests).
 * @returns The parsed config, or undefined when unreadable.
 */
export function readActivityConfig(dir: string = PREFS_DIR): WorkingActivityConfig | undefined {
  try {
    return parseWorkingActivityConfig(readFileSync(join(dir, 'working-activity.json'), 'utf8')).config
  } catch {
    return undefined
  }
}

/**
 * Fold the parsed user file into the mounted working-activity plugin config.
 *
 * The line's semantics moved into the plugin, but the file this app's own UI
 * writes (`/activity`, the settings panel) is still where a user's feature
 * switches live — without this fold they were parsed and silently dropped.
 * Precedence keeps the old contract: an explicit row value wins over the
 * file, the file fills everything the row leaves at its schema default. The
 * flags come through `featureOn`, so the file's `mode: minimal` turns them
 * off exactly as it did when the deleted channel sidecar built its tracker.
 * (The sidecar also hardcoded `detailLimit: 40`, which is the plugin's own
 * schema default — nothing to fold.)
 *
 * The plugin schema materializes its defaults before `apply` sees the config,
 * so "equal to the default" is the honest reading of "the row did not set
 * this key"; a row value explicitly set to the default is indistinguishable
 * from an unset one and the file wins there. None of these keys are set by
 * the shipped rows.
 * @param config - Schema-resolved row config for the mounted plugin.
 * @param file - Parsed user preferences (undefined when unreadable/absent).
 * @returns the config to mount the plugin with.
 */
export function mergeActivityPreferences(
  config: MountedActivityConfig,
  file: WorkingActivityConfig | undefined,
): MountedActivityConfig {
  if (file === undefined) return config
  // Every flag the PLUGIN honours (its own FEATURE_FLAGS list), not a local
  // copy: when the plugin grows or trims switches, the file folds through
  // without this seam growing a stale mirror. `phrases` rides the top-level
  // switch below instead.
  const fileFeatures = Object.fromEntries(
    FEATURE_FLAGS.filter(name => name !== 'phrases').map(name => [name, featureOn(file, name)]),
  )
  return {
    ...config,
    // `phrases: false` in the row is the one spelling that cannot mean
    // "unset" (the default is true), so it is the only one that overrides.
    phrases: config.phrases === false ? false : featureOn(file, 'phrases'),
    // Per flag: a row entry wins (see the schema-default note above).
    features: { ...fileFeatures, ...config.features },
    customPhrases: config.customPhrases !== undefined && config.customPhrases.length > 0
      ? config.customPhrases
      : [...(file.customPhrases ?? [])],
    customActions: config.customActions !== undefined && Object.keys(config.customActions).length > 0
      ? config.customActions
      : Object.fromEntries(Object.entries(file.customActions ?? {}).map(([name, phrases]) => [name, [...phrases]])),
    showTokPerSec: config.showTokPerSec === true ? true : file.showTokPerSec ?? false,
    workRemindAt: config.workRemindAt !== undefined && config.workRemindAt !== 0
      ? config.workRemindAt
      : file.workRemindAt ?? 0,
  }
}

/**
 * Persist the chosen indicator preset (best effort).
 * @param name - Preset name to persist.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was written, false on failure.
 */
export function writeActivityFrames(name: string, dir: string = PREFS_DIR): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'working-activity.json'), JSON.stringify({ frames: normalizeActivityPreset(name) }, null, 2))
    return true
  } catch {
    return false
  }
}
