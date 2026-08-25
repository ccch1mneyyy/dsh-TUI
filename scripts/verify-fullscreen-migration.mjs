#!/usr/bin/env node
/**
 * Fullscreen factory-default migration regression (compiled lib):
 * the 0.9.x schema + cordis.patch.yml flip false→true ships with a
 * one-time migration that clears a pre-flip explicit `fullscreen: false`
 * from the settings user layer — without it, that stale choice would keep
 * overriding the new default on every boot.
 *
 * Decision table (planFullscreenFactoryMigration):
 * - resolved false + no marker → 'unset' (clear it, boot fullscreen)
 * - resolved true/undefined + no marker → 'mark' (nothing to clear)
 * - marker present → 'done' whatever the resolved value is — a `false`
 *   written AFTER the migration is a deliberate /settings choice and must
 *   stand
 *
 * Persistence (readAppliedMigrations/markMigrationApplied, temp dir):
 * - round-trips, merge never drops sibling keys, corrupt file reads empty
 *
 * Commit semantics (commitFullscreenFactoryMigration):
 * - 'mark'/'done' never invoke the unset op; 'mark' writes the marker
 * - 'unset' writes the marker only AFTER the doc write succeeds — a failed
 *   write stays unmarked so the next boot retries (self-healing), and the
 *   promise never rejects
 *
 * Boot wiring contract mirrored from plugin.ts (asserted by construction
 * on the shadow value): the first apply must receive a value whose
 * `fullscreen` key is ABSENT (destructured out), not false.
 *
 * Run after build: `node scripts/verify-fullscreen-migration.mjs`
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FULLSCREEN_FACTORY_MIGRATION,
  commitFullscreenFactoryMigration,
  markMigrationApplied,
  planFullscreenFactoryMigration,
  readAppliedMigrations,
} from '../lib/types/migrationPrefs.js'

let failed = false
function assert(condition, label) {
  console.log(`${condition ? 'ok' : 'FAIL'} — ${label}`)
  if (!condition) {
    failed = true
  }
}

// ── decision table ──
assert(planFullscreenFactoryMigration(false, {}) === 'unset', 'resolved false without marker plans unset')
assert(planFullscreenFactoryMigration(true, {}) === 'mark', 'resolved true without marker plans mark')
assert(planFullscreenFactoryMigration(undefined, {}) === 'mark', 'unset resolution without marker plans mark')
const marked = { [FULLSCREEN_FACTORY_MIGRATION]: '2026-08-24T00:00:00.000Z' }
assert(planFullscreenFactoryMigration(false, marked) === 'done', 'marker present: post-migration false is a deliberate choice and stands')
assert(planFullscreenFactoryMigration(undefined, marked) === 'done', 'marker present: done regardless of resolution')
assert(planFullscreenFactoryMigration(false, { unrelated: true }) === 'unset', 'only the fullscreen marker id counts as applied')

// ── persistence round-trip (temp dir) ──
const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-migration-'))
try {
  assert(Object.keys(readAppliedMigrations(dir)).length === 0, 'absent migrations.json reads empty')
  writeFileSync(join(dir, 'migrations.json'), '{not json', 'utf8')
  assert(Object.keys(readAppliedMigrations(dir)).length === 0, 'corrupt migrations.json reads empty')
  assert(markMigrationApplied('other-migration', dir) === true, 'mark write succeeds')
  assert(markMigrationApplied(FULLSCREEN_FACTORY_MIGRATION, dir) === true, 'fullscreen marker write succeeds')
  const reread = readAppliedMigrations(dir)
  assert(reread['other-migration'] !== undefined && reread[FULLSCREEN_FACTORY_MIGRATION] !== undefined, 'merge write keeps sibling keys')

  // ── commit semantics (fresh dir so marker state is local) ──
  const dir2 = mkdtempSync(join(tmpdir(), 'dsh-tui-migration-'))
  try {
    let unsetCalls = 0
    const unset = async () => { unsetCalls++ }
    await commitFullscreenFactoryMigration('done', { unset, dir: dir2 })
    assert(unsetCalls === 0 && readAppliedMigrations(dir2)[FULLSCREEN_FACTORY_MIGRATION] === undefined, 'done: no unset op, no marker write')
    await commitFullscreenFactoryMigration('mark', { unset, dir: dir2 })
    assert(unsetCalls === 0 && readAppliedMigrations(dir2)[FULLSCREEN_FACTORY_MIGRATION] !== undefined, 'mark: marker written, unset op untouched')
    const dir3 = mkdtempSync(join(tmpdir(), 'dsh-tui-migration-'))
    try {
      await commitFullscreenFactoryMigration('unset', { unset: async () => { throw new Error('settings write failed') }, dir: dir3 })
      assert(readAppliedMigrations(dir3)[FULLSCREEN_FACTORY_MIGRATION] === undefined, 'unset: failed doc write leaves marker unwritten (next boot retries)')
      assert(unsetCalls === 0, 'plugin-supplied unset op only invoked on the unset plan')
      let succeeded = false
      await commitFullscreenFactoryMigration('unset', { unset: async () => { succeeded = true }, dir: dir3 })
      assert(succeeded, 'unset: doc write invoked')
      assert(readAppliedMigrations(dir3)[FULLSCREEN_FACTORY_MIGRATION] !== undefined, 'unset: marker lands after successful doc write')
    } finally {
      rmSync(dir3, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir2, { recursive: true, force: true })
  }

  // ── boot shadow contract: the key must be ABSENT, not false ──
  const bootSettings = { fullscreen: false, lang: 'zh' }
  const { fullscreen: _shadowed, ...migrated } = bootSettings
  assert(!('fullscreen' in migrated) && migrated.lang === 'zh', 'first apply value omits the stale key entirely (absent, not false)')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failed) {
  console.log('verify-fullscreen-migration: FAILED')
  process.exit(1)
}
console.log('verify-fullscreen-migration: all checks passed')
