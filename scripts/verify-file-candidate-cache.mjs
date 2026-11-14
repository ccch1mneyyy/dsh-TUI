/** #2016: fuzzy candidates refresh on demand after a short completed-scan
 * TTL, without a timer, per-keystroke scans, or changing the scan budgets.
 * Run after compile: node scripts/verify-file-candidate-cache.mjs
 * Uses real temporary files/createLocalFs and a controlled Date.now only
 * for cache expiry. This is an I/O work bound, not a CPU/latency benchmark.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createFileActions } from '../lib/types/dsh-adapter/channel/file-actions.js'
import { createLocalFs } from '../lib/types/dsh-adapter/channel/local-fs.js'

let failed = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++ }
const names = result => result.map(item => item.path)
const deferred = () => { let done; const promise = new Promise(resolve => { done = resolve }); return { promise, resolve: done } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const root = await mkdtemp(join(tmpdir(), 'dsh-file-cache-'))
const originalNow = Date.now
let now = 10_000
Date.now = () => now
const local = createLocalFs()
const makeActions = (cwd, fs, owner = new AbortController()) => createFileActions({
  owner: { current: () => !owner.signal.aborted, signal: owner.signal }, capture: () => cwd(),
  current: capture => capture === cwd(), cwd, fs: () => fs,
})
try {
  const workspace = join(root, 'live')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'src', 'old-target.ts'), 'old\n')
  let reads = 0
  const counted = { ...local, async listDir(target) { reads++; return local.listDir(target) } }
  const actions = makeActions(() => workspace, counted)
  check('initial fuzzy scan sees the original file', names(await actions.listFileCandidates('target')).includes('src/old-target.ts'))
  const firstReads = reads
  for (let i = 0; i < 50; i++) await actions.listFileCandidates('targ', { topK: 10 })
  check('50 keystroke queries inside the TTL reuse one scan', reads === firstReads)
  await writeFile(join(workspace, 'src', 'new-target.ts'), 'new\n')
  await unlink(join(workspace, 'src', 'old-target.ts'))
  const path = names(await actions.listFileCandidates('src/'))
  check('path-shaped query immediately sees new files and drops deleted files', path.includes('src/new-target.ts') && !path.includes('src/old-target.ts'))
  now += 1999
  const beforeExpiry = names(await actions.listFileCandidates('target'))
  check('completed cache is reused before the documented two-second boundary', beforeExpiry.includes('src/old-target.ts') && !beforeExpiry.includes('src/new-target.ts'))
  const beforeRefreshReads = reads
  now += 1
  const afterExpiry = names(await actions.listFileCandidates('target'))
  check('next fuzzy query after two seconds discovers the newly created file', afterExpiry.includes('src/new-target.ts'))
  check('next fuzzy query after two seconds removes the deleted file', !afterExpiry.includes('src/old-target.ts'))
  check('expiry performs exactly one fresh bounded tree scan', reads === beforeRefreshReads + firstReads)
  const pool = names(await actions.listFileCandidates(''))
  check('empty fuzzy query uses the same refreshed pool', pool.includes('src/new-target.ts') && !pool.includes('src/old-target.ts'))
  const stableReads = reads
  now += 1999
  await actions.listFileCandidates('target')
  check('freshly completed rescan is cached for another full TTL', reads === stableReads)
  now -= 5000
  const rolledBack = names(await actions.listFileCandidates('target'))
  check('a backward wall-clock adjustment does not freeze the cache', rolledBack.includes('src/new-target.ts'))
  check('a backward clock triggers just one replacement scan', reads === stableReads + firstReads)

  const empty = join(root, 'empty'); await mkdir(empty)
  const emptyActions = makeActions(() => empty, local)
  check('empty workspace returns an empty pool', (await emptyActions.listFileCandidates('')).length === 0)
  await writeFile(join(empty, 'appeared.ts'), '')
  check('empty observations remain immediately retryable inside the TTL', names(await emptyActions.listFileCandidates('appeared')).includes('appeared.ts'))

  const shared = join(root, 'shared'); await mkdir(shared); await writeFile(join(shared, 'shared-target.ts'), '')
  let sharedReads = 0
  const gate = deferred(), waiter = new AbortController(), owner = new AbortController()
  const sharedFs = { ...local, async listDir(target) { sharedReads++; await gate.promise; return local.listDir(target) } }
  const sharedActions = makeActions(() => shared, sharedFs, owner)
  const cancelled = sharedActions.listFileCandidates('target', { signal: waiter.signal })
  await tick()
  now += 60_000 // A slow scan must not expire while it is still pending.
  const live = Array.from({ length: 25 }, () => sharedActions.listFileCandidates('target'))
  await tick(); waiter.abort(); gate.resolve()
  check('cancelled first waiter receives no candidates', (await cancelled).length === 0)
  check('25 live waiters receive the shared scan', (await Promise.all(live)).every(items => names(items).includes('shared-target.ts')))
  check('even a long pending scan is not duplicated on expiry', sharedReads === 1)
  now += 1999; await sharedActions.listFileCandidates('target')
  check('TTL starts at scan completion rather than scan start', sharedReads === 1)
  now += 1; await sharedActions.listFileCandidates('target')
  check('a slow completed scan eventually expires too', sharedReads === 2)
  owner.abort()
  const disposedReads = sharedReads
  check('disposed owner receives no candidates', (await sharedActions.listFileCandidates('target')).length === 0)
  check('disposed owner never starts another scan', sharedReads === disposedReads)

  const oldRoot = join(root, 'old'), newRoot = join(root, 'new')
  await mkdir(oldRoot); await mkdir(newRoot)
  await writeFile(join(oldRoot, 'old.ts'), ''); await writeFile(join(newRoot, 'new.ts'), '')
  let cwd = oldRoot, newReads = 0
  const oldGate = deferred()
  const switchingFs = { ...local, async listDir(target) {
    if (target.displayPath === oldRoot) await oldGate.promise
    if (target.displayPath === newRoot) newReads++
    return local.listDir(target)
  } }
  const switching = makeActions(() => cwd, switchingFs)
  const oldRequest = switching.listFileCandidates('old'); await tick()
  cwd = newRoot
  check('cwd replacement gets its own current pool', names(await switching.listFileCandidates('new')).includes('new.ts'))
  now += 1900; oldGate.resolve()
  check('late old-cwd result cannot surface in the new cwd', (await oldRequest).length === 0)
  now += 100; await switching.listFileCandidates('new')
  check('late old scan cannot extend the new cwd cache lifetime', newReads === 2)
} finally {
  Date.now = originalNow
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep), 'cleanup stays inside its own temporary parent')
  await rm(root, { recursive: true, force: true })
}
console.log(`verify-file-candidate-cache: ${failed} failure(s)`)
if (failed) process.exitCode = 1
