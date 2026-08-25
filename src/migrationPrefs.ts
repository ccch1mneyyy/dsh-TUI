/**
 * One-time local migrations (`~/.dsh-tui/migrations.json`), keyed by stable
 * migration id → ISO timestamp. Named keys (not a bare flag) so later
 * migrations can append entries without a format change. Best-effort like
 * every prefs file: a missing/corrupt file reads as "nothing applied yet",
 * and a failed write simply leaves the migration to retry on a later boot.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

const PREFS_DIR = DATA_DIR
const MIGRATIONS_FILE = 'migrations.json'

/**
 * The fullscreen factory-default flip (schema + `cordis.patch.yml`, 0.9.x):
 * a `fullscreen: false` pinned in the settings user layer BEFORE the flip
 * keeps overriding the new default on every boot. The first boot past this
 * migration clears that stale explicit choice once — see
 * {@link planFullscreenFactoryMigration} for the decision table.
 */
export const FULLSCREEN_FACTORY_MIGRATION = 'fullscreen-factory-default'

/**
 * Read the applied-migration map.
 * @param dir - Prefs directory (injectable for tests).
 * @returns Parsed migration map; empty on any read/parse failure.
 */
export function readAppliedMigrations(dir: string = PREFS_DIR): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, MIGRATIONS_FILE), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Record a migration as applied (merge write — other keys are never dropped).
 * @param id - Migration id.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was written, false on failure.
 */
export function markMigrationApplied(id: string, dir: string = PREFS_DIR): boolean {
  try {
    const current = readAppliedMigrations(dir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, MIGRATIONS_FILE), JSON.stringify({ ...current, [id]: new Date().toISOString() }, null, 2))
    return true
  } catch {
    return false
  }
}

/** What this boot should do about the fullscreen factory-default flip. */
export type FullscreenFactoryPlan = 'unset' | 'mark' | 'done'

/**
 * Decide the migration step from the settings scope's RESOLVED fullscreen
 * value. The dsh-tui namespace declares no schema default and no `base`
 * layer for `fullscreen`, so a resolved `false` can only come from the user
 * layer — the pre-flip explicit choice this migration exists to clear:
 *  - `done`  — marker present: never touch the user layer again, so a
 *     `false` written AFTER the migration (a deliberate /settings choice)
 *     always stands;
 *  - `unset` — stale pre-flip explicit `false`: the caller clears it via a
 *     settings `unset` op and boots fullscreen regardless — the doc write
 *     is async and must not race the synchronous boot decision, so the
 *     caller shadows the stale value out of its first settings apply;
 *  - `mark`  — nothing to clear (unset or already `true`): record the
 *     marker now so a `false` set later is never mistaken for a stale one.
 */
export function planFullscreenFactoryMigration(
  resolvedFullscreen: unknown,
  migrations: Readonly<Record<string, unknown>>,
): FullscreenFactoryPlan {
  if (migrations[FULLSCREEN_FACTORY_MIGRATION] !== undefined) return 'done'
  return resolvedFullscreen === false ? 'unset' : 'mark'
}

/**
 * Persist the plan's side effects. For `unset` the marker lands only after
 * the doc write succeeds — a failed write stays unmarked and the next boot
 * retries (that boot already ran fullscreen off the shadowed value).
 * Never rejects.
 * @param plan - Decision from {@link planFullscreenFactoryMigration}.
 * @param options - `unset` thunk issuing the settings write; `dir` injects
 *   the prefs directory for tests.
 */
export async function commitFullscreenFactoryMigration(
  plan: FullscreenFactoryPlan,
  options: { unset: () => Promise<void>; dir?: string },
): Promise<void> {
  if (plan === 'done') return
  if (plan === 'mark') {
    markMigrationApplied(FULLSCREEN_FACTORY_MIGRATION, options.dir)
    return
  }
  try {
    await options.unset()
    markMigrationApplied(FULLSCREEN_FACTORY_MIGRATION, options.dir)
  } catch {
    // Unmarked on purpose: retried next boot.
  }
}
