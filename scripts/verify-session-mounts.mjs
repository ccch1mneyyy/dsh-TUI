/**
 * Verification for the cross-process session mounting ledger
 * (src/sessionMounts.ts).
 *
 * This ledger is the only thing standing between two TUI terminals and a
 * corrupted shared transcript, so this script pins the properties whose silent
 * failure would corrupt a log — and nothing else:
 *
 * 1. IDENTITY: our own published session reads as `mine`, so a terminal never
 *    refuses its own parked session; a session held by a LIVE PEER PROCESS
 *    reads as `occupied`.
 * 2. ATOMIC CLAIM: a live peer holder blocks `claimMount` and the refusal
 *    writes nothing; re-claiming our own session is not a conflict.
 * 3. ABANDONMENT: once the peer is gone the session is claimable again, and a
 *    record whose pid is gone is pruned by the next write.
 *
 * Plus the degradation rule: a malformed or foreign-shaped document reads as an
 * empty ledger instead of throwing, because a corrupt cache must never take
 * down a session.
 *
 * Ownership is pid-only, so the foreign holder is a REAL second process that
 * PUBLISHES through this same module in the same fake HOME — a staged JSON
 * record written by this process would not prove the cross-process guarantee,
 * and would pass even if publishing never worked.
 *
 * Uses a temp HOME so the real ~/.dsh-tui is never touched. The module reads
 * `homedir()` at import time, so HOME/USERPROFILE are set BEFORE the dynamic
 * import, and the spawned peer inherits them.
 *
 * Run: node --import tsx/esm scripts/verify-session-mounts.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

/** A peer record with the fields the ledger validates. */
function peer(pid, sessionIds) {
  return { pid, startedAt: Date.now(), sessionIds }
}

/** Poll a condition with a bound instead of a fixed wait. */
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 50)) // 固定窗:pacing 等对端进程落账
  }
  return predicate()
}

/** A pid that is certainly not running: spawn-free, and validated by probe. */
function findDeadPid() {
  for (let candidate = 999_999; candidate > 100_000; candidate -= 137) {
    if (!pidAlive(candidate)) return candidate
  }
  throw new Error('no dead pid candidate found')
}

/**
 * The peer: a real second process that publishes a claim through this module
 * under the same HOME, then stays alive. `child-held` is not written by this
 * process anywhere, so seeing it — and being refused by it — can only come from
 * the peer's own publication.
 */
const MODULE_URL = new URL('../src/sessionMounts.ts', import.meta.url).href
const peerSource = `const m = await import(${JSON.stringify(MODULE_URL)}); m.publishMounts(['child-held']); setInterval(() => {}, 60_000)`
const holder = spawn(process.execPath, ['--import', 'tsx/esm', '-e', peerSource], { stdio: 'ignore' })
const holderPid = holder.pid
const peerPublished = await until(() => readSessionOwners().has('child-held'))
if (!peerPublished) throw new Error('the peer process never published its claim')

// ── 1. Identity: ours reads as mine, a live peer process is occupied ────────
console.log('identity:')
publishMounts(['sess-a', 'sess-b'])
check('both ids published', ownMounts().length === 2)
check('our session reads as mine', occupancyOf('sess-a', readSessionOwners()).kind === 'mine')
check('an unknown session reads as free', occupancyOf('nope', readSessionOwners()).kind === 'free')
check('releaseMount drops one id', releaseMount('sess-b') && ownMounts().length === 1)
check('the released id is no longer ours', occupancyOf('sess-b', readSessionOwners()).kind === 'free')

const foreign = occupancyOf('child-held', readSessionOwners())
check('a live PEER PROCESS reads as occupied', foreign.kind === 'occupied' && foreign.pid === holderPid)
clearOwnMounts()

// ── 2. Atomic claim: the live peer blocks, our own re-claim does not ────────
console.log('claim:')
const refused = claimMount('child-held')
check('the live peer holder refuses the claim', refused.ok === false && refused.holders.includes(holderPid))
check('the refused claim is not remembered as ours', !ownMounts().includes('child-held'))
check('the refused claim wrote nothing of ours', !readMountLedger().some(
  owner => owner.pid === process.pid && owner.sessionIds.includes('child-held'),
))
check('and the peer record is untouched', readSessionOwners().get('child-held')?.pid === holderPid)

check('a free session claims ok', claimMount('reclaimable').ok === true)
check('claiming our own session twice is not a conflict', claimMount('reclaimable').ok === true)
releaseMount('reclaimable')
clearOwnMounts()

// ── 3. Abandonment: a peer that exits frees its sessions ───────────────────
console.log('abandonment:')
// Our own write must not drop a LIVE peer record: "prune while publishing" is
// the read-modify-write that would lose a peer's update.
publishMounts(['ours'])
check('our own record is written', readMountLedger().some(
  owner => owner.pid === process.pid && owner.sessionIds.includes('ours'),
))
check('the live peer record survives our write', readMountLedger().some(
  owner => owner.pid === holderPid && owner.sessionIds.includes('child-held'),
))
clearOwnMounts()
check('clearOwnMounts leaves the live peer alone', readMountLedger().some(owner => owner.pid === holderPid))

holder.kill()
const peerGone = await until(() => !pidAlive(holderPid))
check('the peer process is gone', peerGone)
check('a session the peer held is claimable again', claimMount('child-held').ok === true)
check('and we now hold it', ownMounts().includes('child-held'))
releaseMount('child-held')
clearOwnMounts()

// A record whose pid is gone is pruned by the next write, which is what makes a
// `kill -9` recoverable without a reaper.
const deadPid = findDeadPid()
writeRaw([peer(deadPid, ['dead-sess'])])
publishMounts(['ours'])
check('the dead record is pruned by the write', !readMountLedger().some(owner => owner.pid === deadPid))
check('and our own record landed in the same write', readMountLedger().some(owner => owner.pid === process.pid))
clearOwnMounts()

// ── 4. Degradation: a corrupt cache reads as empty, never throws ────────────
console.log('degradation:')
writeFileSync(LEDGER, '{ not json', 'utf8')
check('unparseable reads as empty', readMountLedger().length === 0)
writeRaw([peer(deadPid, ['x'])], 99)
check('a version mismatch reads as empty', readMountLedger().length === 0)
writeRaw([{ pid: 'x', startedAt: 1, sessionIds: [] }])
check('a wrong-typed record is dropped', readMountLedger().length === 0)

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nsession mount ledger checks passed')
