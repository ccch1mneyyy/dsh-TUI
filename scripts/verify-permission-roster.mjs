/**
 * Permission-domain unit checks for the Shift+Tab session-mode machinery
 * (pure module, no harness env): stable roster order, cycle-entry filtering,
 * table-driven canonical resolution and modes-config validation.
 *
 * Run after pnpm build: node scripts/verify-permission-roster.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-tui-permission-roster-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
process.on('exit', () => rmSync(isolatedHome, { recursive: true, force: true }))

const {
  canonicalPresetFor,
  permissionCycleEntry,
  resolveSessionModes,
  stablePermissionRosterOrder,
} = await import('../lib/types/sessionModes.js')

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// ---- stable roster order --------------------------------------------------
{
  check('keeps the first official order', stablePermissionRosterOrder([], ['auto', 'safe']).join(',') === 'auto,safe')
  check('ignores later reshuffles', stablePermissionRosterOrder(['auto', 'safe'], ['safe', 'auto', 'new']).join(',') === 'auto,safe,new')
  check('treats a re-add as new', stablePermissionRosterOrder(['auto', 'safe', 'new'], ['new', 'auto']).join(',') === 'auto,new')
  check('deduplicates malformed input', stablePermissionRosterOrder(['auto', 'auto'], ['safe', 'safe']).join(',') === 'safe')
}

// ---- cycle-entry filtering ------------------------------------------------
{
  const opt = (value, name = value) => ({ value, name })
  const configured = new Set(['auto'])
  const acc = (o) => permissionCycleEntry(o, configured)
  check('accepts third-party identities', acc(opt('safe')).accepted === true)
  check('excludes the custom sentinel', acc(opt('custom')).accepted === false)
  check('excludes the status sentinel', acc(opt('status')).accepted === false)
  check('excludes canonical stock presets', acc(opt('read-only')).accepted === false && acc(opt('danger-full-access')).accepted === false)
  check('excludes duplicate configured identities', acc(opt('auto')).accepted === false)
}

// ---- table-driven canonical resolution ------------------------------------
{
  check('stock bundle resolves to the stock name without a table', canonicalPresetFor('workspace-write', 'ask') === 'workspace-write')
  check('read-only+ask stock bundle resolves', canonicalPresetFor('read-only', 'ask') === 'read-only')
  check('danger+never stock bundle resolves', canonicalPresetFor('danger-full-access', 'never') === 'danger-full-access')
  check('unknown bundle without a table stays undefined', canonicalPresetFor('read-only', 'never') === undefined)
  const stockTable = [
    { value: 'read-only', sandbox: 'read-only', approval: 'ask' },
    { value: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' },
    { value: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' },
  ]
  check('stock table resolves each canonical bundle', canonicalPresetFor('workspace-write', 'ask', stockTable) === 'workspace-write')
  // A renamed deployment keeps canonicalization table-driven.
  const renamed = [
    { value: 'ro', sandbox: 'read-only', approval: 'ask' },
    { value: 'ws', sandbox: 'workspace-write', approval: 'ask' },
    { value: 'full', sandbox: 'danger-full-access', approval: 'never' },
  ]
  check('renamed table resolves to the first matching entry', canonicalPresetFor('workspace-write', 'ask', renamed) === 'ws')
  check('renamed table resolves plan bundle', canonicalPresetFor('read-only', 'ask', renamed) === 'ro')
  // First-match wins for shared bundles (deployment declaration order).
  const shared = [
    { value: 'auto', sandbox: 'workspace-write', approval: 'ask' },
    { value: 'ws', sandbox: 'workspace-write', approval: 'ask' },
  ]
  check('shared-bundle table honors declaration order', canonicalPresetFor('workspace-write', 'ask', shared) === 'auto')
  check('table without a matching bundle stays undefined', canonicalPresetFor('read-only', 'never', renamed) === undefined)
}

// ---- modes config validation ----------------------------------------------
{
  const plain = resolveSessionModes([{ id: 'a', sandbox: 'workspace-write' }, { id: 'empty' }])
  check('atom-less entries are dropped and reported', plain.modes.length === 1 && plain.dropped.join(',') === 'empty')
  const permission = resolveSessionModes([{ id: 'p', permission: 'auto' }, { id: 'plan', plan: true, permission: 'auto' }])
  check('permission atom is a usable mode', permission.modes.length === 2 && permission.dropped.length === 0)
  const conflict = resolveSessionModes([{ id: 'bad', permission: 'auto', sandbox: 'workspace-write' }])
  check(
    'permission+sandbox conflicts are excluded (roster falls back to defaults, no drop report)',
    conflict.modes.length === 3 && conflict.modes[0].id === 'default' && conflict.dropped.length === 0,
  )
  const empty = resolveSessionModes(undefined)
  check('undefined config falls back to the default cycle', empty.modes.length === 3 && empty.modes[0].id === 'default')
}

if (failed > 0) {
  console.error(`permission-roster verification failed: ${failed}`)
  process.exitCode = 1
} else {
  console.log('permission-roster verification passed')
}
