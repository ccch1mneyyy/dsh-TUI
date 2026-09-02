/**
 * Grants-file watcher regression: the fallback GrantStore must notify on
 * file changes (event-driven, not a 50ms poll), stop polling once the last
 * subscriber unsubscribes, and fall back to a slow bounded poll when
 * fs.watch cannot watch the file (e.g. it does not exist yet).
 *
 *   A. Live file: a write notifies subscribers promptly; an unchanged file
 *      notifies nothing; unsubscribe stops the watcher (later writes do
 *      not notify).
 *   B. Missing file: fs.watch fails → slow fallback poll still picks up a
 *      subsequently created file.
 *
 * Run via `node --import tsx/esm scripts/verify-grants-watch.mjs`.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sleep } from './lib/term-test.mjs'
const { readGrantStore, EXTENSION_GRANTS_FILE } = await import('../src/dsh-adapter/grants.js')

let failed = 0
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// ── A. Live file: event-driven notify + cleanup ───────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-grants-watch-'))
  const file = join(dir, EXTENSION_GRANTS_FILE)
  writeFileSync(file, JSON.stringify({ grants: { live: [] } }))
  const store = readGrantStore(dir)
  let notified = 0
  const stop = store.onChange?.(() => { notified += 1 })
  check('A0: onChange seam exists', typeof stop === 'function')
  await sleep(300) // settle: any initial watcher chatter must not notify
  const baseline = notified
  // A write that does not change the content must not notify (signature
  // dedupe), and the watcher must be quiet while the file is static.
  writeFileSync(file, JSON.stringify({ grants: { live: [] } }))
  await sleep(300)
  check('A1: unchanged file content notifies nothing', notified === baseline, `notified=${notified}`)
  // A real change notifies promptly (fs.watch + 50ms debounce ≪ 250ms).
  writeFileSync(file, JSON.stringify({
    grants: { live: [{ name: 'session.input.intercept', scope: 'tui/input' }] },
  }))
  await sleep(250)
  check('A2: a change notifies within a bounded delay', notified === baseline + 1, `notified=${notified}`)
  // Revocation semantics stay live: allows() reads the file fresh.
  check('A3: allows() reads the fresh file',
    store.allows({ componentId: 'live' }, 'session.input.intercept', 'tui/input') === true)
  // Unsubscribe stops the watcher: later writes must not notify.
  stop?.()
  notified = 0
  writeFileSync(file, JSON.stringify({ grants: { live: [] } }))
  await sleep(300)
  check('A4: unsubscribe stops the watcher', notified === 0, `notified=${notified}`)
  rmSync(dir, { recursive: true, force: true })
}

// ── B. Missing PARENT DIRECTORY: the slow fallback poll is what runs ──────
// The watcher targets the PARENT DIRECTORY (atomic-replace safety), so a
// missing file alone does NOT force the fallback — fs.watch(dirname) still
// succeeds and the scenario would silently test the directory watcher
// instead. Subscribe while the parent directory ITSELF does not exist:
// fs.watch must fail (ENOENT) and arm the 2s fallback poll.
{
  const dir = join(tmpdir(), `dsh-grants-watch-missing-${process.pid}-${Date.now()}`)
  const file = join(dir, EXTENSION_GRANTS_FILE)
  const store = readGrantStore(dir)
  let notified = 0
  const stop = store.onChange?.(() => { notified += 1 })
  check('B0: onChange seam exists on a missing directory', typeof stop === 'function')
  await sleep(300)
  // fs.watch on a nonexistent directory errors → the 2s fallback poll arms.
  // Create the directory + file: the poll must pick it up (allow up to ~2.8s
  // for the first poll tick).
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify({ grants: { late: ['commands.invoke'] } }))
  await sleep(2800)
  check('B1: fallback poll picks up a created file', notified >= 1, `notified=${notified}`)
  // Cleanup: the fallback poll must stop with the last subscriber.
  notified = 0
  stop?.()
  writeFileSync(file, JSON.stringify({ grants: { late: [] } }))
  await sleep(2500)
  check('B2: fallback poll stops after unsubscribe', notified === 0, `notified=${notified}`)
  rmSync(dir, { recursive: true, force: true })
}

// ── C. Atomic replace (temp file + rename) must still notify ─────────────
// The common editor/writer pattern swaps the inode; a watcher pinned to the
// old FILE would go silent. The directory watcher must see the rename.
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-grants-watch-'))
  const file = join(dir, EXTENSION_GRANTS_FILE)
  writeFileSync(file, JSON.stringify({ grants: { atomic: [] } }))
  const store = readGrantStore(dir)
  let notified = 0
  const stop = store.onChange?.(() => { notified += 1 })
  await sleep(300)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify({ grants: { atomic: [{ name: 'commands.invoke', scope: 'root.command' }] } }))
  renameSync(tmp, file)
  await sleep(250)
  check('C1: atomic replace notifies subscribers',
    notified >= 1, `notified=${notified}`)
  check('C2: allows() sees the replaced file',
    store.allows({ componentId: 'atomic' }, 'commands.invoke', 'root.command') === true)
  // delete/recreate: the directory watcher must also survive removal.
  rmSync(file)
  await sleep(250)
  const afterDelete = notified
  writeFileSync(file, JSON.stringify({ grants: { atomic: [] } }))
  await sleep(250)
  check('C3: delete/recreate notifies again', notified > afterDelete, `notified=${notified}`)
  stop?.()
  rmSync(dir, { recursive: true, force: true })
}

console.log(failed === 0 ? 'verify-grants-watch: all checks passed' : `${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
