/**
 * Persisted model-route preference (`/model` picker choice), kept at
 * `~/.dsh-tui/model.json` (`provider` + `model` keys) so the choice survives
 * restarts — same pattern as agent-preset.json. The file is best-effort: a
 * missing/corrupt file or an incomplete route simply falls back to the
 * harness default. Explicit `provider`/`model` keys in cordis.yml win over
 * this preference (deployment choice over runtime preference, matching
 * activityFrames and agent-preset) — but only as a COMPLETE pair; the
 * atomic resolution itself lives in modelRoute.ts (issue #67).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

const PREFS_DIR = DATA_DIR

/** One persisted model route: the provider route plus its model id. */
export interface ModelPref {
  provider: string
  model: string
}

/**
 * Parse a persisted `{ provider, model }` value; anything else yields
 * undefined.
 * @param text - Raw file contents.
 * @returns The route when both halves are non-empty strings, else undefined.
 */
export function parseModelPref(text: string): ModelPref | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const { provider, model } = parsed as Record<string, unknown>
    if (typeof provider !== 'string' || provider === '') return undefined
    if (typeof model !== 'string' || model === '') return undefined
    return { provider, model }
  } catch {
    return undefined
  }
}

/**
 * The persisted model route, or undefined when unset or invalid.
 * @param dir - Prefs directory (injectable for tests).
 * @returns The persisted route, if any.
 */
export function readModelPref(dir: string = PREFS_DIR): ModelPref | undefined {
  try {
    return parseModelPref(readFileSync(join(dir, 'model.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Persist the chosen model route (best effort).
 * @param provider - Provider route to persist.
 * @param model - Provider-owned model id to persist.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was written, false on failure.
 */
export function writeModelPref(provider: string, model: string, dir: string = PREFS_DIR): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'model.json'), JSON.stringify({ provider, model }, null, 2))
    return true
  } catch {
    return false
  }
}
