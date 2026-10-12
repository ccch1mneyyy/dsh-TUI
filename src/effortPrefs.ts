/**
 * Persisted reasoning-effort preference (`~/.dsh-tui/effort.json`). Set via
 * `/effort` (slider or `/effort <id>`; `/effort status` reports the current
 * level) — note Shift+Tab cycles session modes (default/plan/full), not
 * effort levels. The choice lands here so the next boot starts on it. The
 * file is best-effort; a level the current route's tier list does not offer
 * falls back to the nearest LOWER tier (nearestLowerEffort, never up) with a
 * loud notice — a missing/corrupt file falls back to the provider default.
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
 * before calling), then this persisted `/effort` file — the level the last
 * session actually ran on — then the cordis.yml `effort` value, which is the
 * deployment DEFAULT beneath the user's standing choice, then the
 * adapter/model default (undefined). Mirrors the lang chain for its first
 * two layers (settings user layer > lang.json) and the last-used rule the
 * model route follows.
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
  return settingsDefault ?? persisted ?? configured
}

/** Standard effort-tier order, weakest to strongest (`xhigh` sits between
 * `high` and `max`, matching the ladder the kernels accept — see
 * STANDARD_EFFORT_LADDER). */
const EFFORT_TIER_ORDER = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** The standard reasoning-effort ladder, weakest to strongest. Served as the
 * compatibility offer when a model catalog row declares reasoning support
 * without listing its own tiers (pi-ai 0.87.x zai rows for glm-5.3* ship only
 * `reasoning: true`): the kernel accepts the standard effort ids and is the
 * set-time authority, so the ladder is an honest offer, not a guess. Mirrors
 * the Claude backend's EFFORT_FALLBACK_TIERS (backends/claude/controls.ts). */
export const STANDARD_EFFORT_LADDER: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Resolve a preferred effort tier against a route's available tiers when the
 * exact tier is absent: pick the NEAREST LOWER standard tier that the route
 * offers (max→high, high→low, …). Only-down, never-up — a user who prefers
 * `low` on a route without it must not be pushed to `high`. Unknown tier ids
 * (custom route tiers outside the standard order) never participate: an
 * unknown preference yields undefined, an unknown candidate is skipped.
 * @param preferred - The preferred tier id (exact match short-circuits).
 * @param available - Tier ids the current route offers.
 * @returns The tier id to apply, or undefined to keep the model default.
 */
export function nearestLowerEffort(preferred: string, available: readonly string[]): string | undefined {
  if (preferred === '' || available.length === 0) return undefined
  if (available.includes(preferred)) return preferred
  const preferredRank = EFFORT_TIER_ORDER.indexOf(preferred as (typeof EFFORT_TIER_ORDER)[number])
  if (preferredRank <= 0) return undefined // unknown id, or 'off' has nothing lower
  let result: string | undefined
  let resultRank = -1
  for (const candidate of available) {
    const rank = EFFORT_TIER_ORDER.indexOf(candidate as (typeof EFFORT_TIER_ORDER)[number])
    if (rank < 0 || rank >= preferredRank) continue
    if (rank > resultRank) {
      result = candidate
      resultRank = rank
    }
  }
  return result
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
