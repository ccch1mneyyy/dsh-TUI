/**
 * Verification for the cross-process session mounting ledger
 * (src/sessionMounts.ts).
 *
 * This ledger is the only thing standing between two TUI terminals and a
 * corrupted shared transcript, so this script pins the three properties whose
 * silent failure would corrupt a log — and nothing else:
 *
 * 1. IDENTITY: our own published session reads as `mine`, so a terminal never
 *    refuses its own parked session; a foreign LIVE pid's session reads as
 *    `occupied`.
 * 2. ABANDONMENT: a record whose pid is gone is ignored on read (the `kill -9`
 *    case) and pruned by the next write, so no reaper is needed.
 * 3. ATOMIC CLAIM: a live foreign holder blocks the claim and leaves the file
 *    untouched, while re-claiming our own session is not a conflict.
 *
 * Plus the degradation rule: a malformed or foreign-shaped document reads as an
 * empty ledger instead of throwing, because a corrupt cache must never take
 * down a session.
 *
 * Ownership is pid-only, so a foreign holder has to be a REAL second process;
 * this script spawns one rather than staging a record with our own pid.
 *
 * Uses a temp HOME so the real ~/.dsh-tui is never touched. The module reads
 * `homedir()` at import time, so HOME/USERPROFILE are set BEFORE the dynamic
 * import.
 *
 * Run: node --import tsx/esm scripts/verify-session-mounts.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'dsh-mounts-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome

const {
  claimMount,
  clearOwnMounts,
  occupancyOf,
  ownMounts,
  pidAlive,
  publishMounts,
  readMountLedger,
  readSessionOwners,
  releaseMount,
} = await import('../src/sessionMounts.ts')

const LEDGER = join(tmpHome, '.dsh-tui', 'session-mounts.json')

let failures = 0
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    console.error(`  FAIL ${name}`)
    failures++
  }
}

/** Write a raw ledger document, bypassing the module, to stage a peer claim. */
function writeRaw(owners, version = 1) {
  mkdirSync(join(tmpHome, '.dsh-tui'), { recursive: true })
  writeFileSync(LEDGER, JSON.stringify({ version, owners }, null, 2), 'utf8')
}

/** The owners currently on disk, parsed directly (no module heuristics). */
function rawOwners() {
  return JSON.parse(readFileSync(LEDGER, 'utf8')).owners
}

/** A peer record with the fields the ledger validates. */
function peer(pid, sessionIds) {
  return { pid, startedAt: Date.now(), sessionIds }
}

/** A pid that is certainly not running: spawn-free, and validated by probe. */
function findDeadPid() {
  for (let candidate = 999_999; candidate > 100_000; candidate -= 137) {
    if (!pidAlive(candidate)) return candidate
  }
  throw new Error('no dead pid candidate found')
}

/** A genuinely separate live process, for the foreign-holder cases. */
const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
const holderPid = holder.pid
// 固定窗:pacing 等子进程真正起来，pid 才是「活着的异进程」
await new Promise(resolve => setTimeout(resolve, 200))
if (!pidAlive(holderPid)) throw new Error('spawned holder is not alive')

// ── 1. Identity: ours reads as mine, a live foreign peer is occupied ────────
console.log('identity:')
publishMounts(['sess-a', 'sess-b'])
check('both ids published', ownMounts().length === 2)
check('our session reads as mine', occupancyOf('sess-a', readSessionOwners()).kind === 'mine')
check('an unknown session reads as free', occupancyOf('nope', readSessionOwners()).kind === 'free')
check('releaseMount drops one id', releaseMount('sess-b') && ownMounts().length === 1)
check('the released id is no longer ours', occupancyOf('sess-b', readSessionOwners()).kind === 'free')

writeRaw([peer(holderPid, ['foreign-sess'])])
const foreign = occupancyOf('foreign-sess', readSessionOwners())
check('a live foreign pid reads as occupied', foreign.kind === 'occupied' && foreign.pid === holderPid)
clearOwnMounts()

// ── 2. Abandonment: a dead pid is ignored and pruned on the next write ──────
console.log('abandonment:')
const deadPid = findDeadPid()
writeRaw([peer(deadPid, ['dead-sess']), peer(holderPid, ['live-sess'])])
const owners = readSessionOwners()
check('the dead owner is ignored', occupancyOf('dead-sess', owners).kind === 'free')
check('the live peer survives the same read', occupancyOf('live-sess', owners).kind === 'occupied')
publishMounts(['ours'])
check('a write prunes the dead owner', !rawOwners().some(owner => owner.pid === deadPid))
check('and keeps the live peer', rawOwners().some(owner => owner.pid === holderPid && owner.sessionIds.includes('live-sess')))
clearOwnMounts()

// ── 3. Atomic claim: a live holder blocks, our own re-claim does not ────────
console.log('claim:')
writeRaw([peer(holderPid, ['contended'])])
const refused = claimMount('contended')
check('a live foreign holder refuses the claim', refused.ok === false && refused.holders.includes(holderPid))
check('the refused claim is not remembered as ours', !ownMounts().includes('contended'))
check('the refused claim wrote nothing', rawOwners().length === 1 && rawOwners()[0].sessionIds.includes('contended'))

writeRaw([])
check('a free session claims ok', claimMount('reclaimable').ok === true)
check('the new claim is in the ledger', rawOwners().some(owner => owner.sessionIds.includes('reclaimable')))
check('claiming our own session twice is not a conflict', claimMount('reclaimable').ok === true)
releaseMount('reclaimable')
clearOwnMounts()

// ── 4. Degradation: a corrupt cache reads as empty, never throws ────────────
console.log('degradation:')
writeFileSync(LEDGER, '{ not json', 'utf8')
check('unparseable reads as empty', readMountLedger().length === 0)
writeRaw([peer(holderPid, ['x'])], 99)
check('a version mismatch reads as empty', readMountLedger().length === 0)
writeRaw([{ pid: 'x', startedAt: 1, sessionIds: [] }])
check('a wrong-typed record is dropped', readMountLedger().length === 0)

holder.kill()
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nsession mount ledger checks passed')
