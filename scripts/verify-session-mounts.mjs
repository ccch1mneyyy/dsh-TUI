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
 * 4. AUTHORITATIVE READ: a damaged ledger is `unavailable`, not "empty", and a
 *    claim against one writes nothing at all. "Could not check" must never be
 *    reported as "nobody holds it" — that is the one mistake this ledger exists
 *    to prevent, and it is unrecoverable.
 * 5. LOCK POLICY: a lock whose holder is ALIVE — and whose process could have
 *    taken the lock — is never reclaimed, however old the file looks; a lock
 *    whose holder is gone is reclaimed immediately, and so is one whose token
 *    names a live pid created AFTER the lock was taken (a recycled pid).
 *    The first half is what the old mtime-only rule got wrong (a paused holder
 *    could be stolen from and then commit a snapshot derived before the steal);
 *    the second half is what keeps a crash from needing manual cleanup.
 * 6. RESERVATIONS: an in-flight mount survives a publisher beat that cannot see
 *    its agent yet, and ends explicitly — settle (the roster takes over) or
 *    abandon (the session goes back).
 * 7. PID REUSE: the issue #988 bug. A dead publisher's record names a pid the
 *    OS later handed to an unrelated live process (the reporter's Steam), and
 *    the pid-only witness swore the record was alive forever. The identity
 *    witness — a live pid created AFTER the record it allegedly published is an
 *    impostor — makes such a record free, claimable and pruned, without ever
 *    letting a process created before its record be treated as an impostor.
 *    The same witness reclaims a lock whose token names a recycled pid.
 *
 * Plus the degradation rule: a malformed or foreign-shaped document still reads
 * as an empty ledger through the DISPLAY reader, because a corrupt cache must
 * never take down a session screen. Only the deciding reader refuses.
 *
 * Ownership is pid plus creation-time identity, so the foreign holder is a
 * REAL second process that PUBLISHES through this same module in the same fake
 * HOME — a staged JSON record written by this process would not prove the
 * cross-process guarantee, and would pass even if publishing never worked.
 * Section 8 stages the impostor cases raw: a crash leftover is exactly a record
 * this process did not write.
 *
 * Uses a temp HOME so the real ~/.dsh-tui is never touched. The module reads
 * `homedir()` at import time, so HOME/USERPROFILE are set BEFORE the dynamic
 * import, and the spawned peer inherits them.
 *
 * Run: node --import tsx/esm scripts/verify-session-mounts.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
  processCreationTime,
  publishMounts,
  readMountLedger,
  readMountLedgerStrict,
  readSessionOwners,
  releaseMount,
  reserveMount,
} = await import('../src/sessionMounts.ts')

const LEDGER = join(tmpHome, '.dsh-tui', 'session-mounts.json')
const LOCK = join(tmpHome, '.dsh-tui', 'session-mounts.lock')

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

/** A peer record with the fields the ledger validates; a crash leftover's `startedAt` is staged explicitly. */
function peer(pid, sessionIds, startedAt = Date.now()) {
  return { pid, startedAt, sessionIds }
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
check('the live peer holder refuses the claim',
  refused.ok === false && refused.reason === 'occupied' && refused.holders.includes(holderPid))
check('the refused claim is not remembered as ours', !ownMounts().includes('child-held'))
check('the refused claim wrote nothing of ours', !readMountLedger().some(
  owner => owner.pid === process.pid && owner.sessionIds.includes('child-held'),
))
check('and the peer record is untouched', readSessionOwners().get('child-held')?.pid === holderPid)

const first = claimMount('reclaimable')
const second = claimMount('reclaimable')
check('a free session claims ok', first.ok === true && first.fresh === true)
// "fresh" is what lets a reservation give back exactly what it took: claiming
// a session this process already holds must not report itself as the owner of
// the entry, or an abandoned attempt would release a live mount.
check('claiming our own session twice is not a conflict', second.ok === true && second.fresh === false)
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

// ── 5. Authoritative read: "could not check" is not "free" ─────────────────
// The display reader above stays tolerant on purpose. The DECIDING reader must
// not: granting a write handle on a ledger it could not read is the corruption
// this module exists to prevent, and the failure is not repairable afterwards.
console.log('authoritative read:')
writeFileSync(LEDGER, '{ not json', 'utf8')
check('a corrupt ledger is unavailable, not empty', readMountLedgerStrict().ok === false)
const afterCorrupt = claimMount('after-corrupt')
check('a claim against a corrupt ledger is refused', afterCorrupt.ok === false && afterCorrupt.reason === 'unavailable')
check('and says why', typeof afterCorrupt.detail === 'string' && afterCorrupt.detail.length > 0)
check('the corrupt file is left byte-for-byte as it was', readFileSync(LEDGER, 'utf8') === '{ not json')
writeRaw([{ pid: 'x', startedAt: 1, sessionIds: [] }])
check('a wrong-typed record is unavailable too', readMountLedgerStrict().ok === false)
const afterBadRecord = claimMount('after-bad-record')
check('so a claim is refused there as well', afterBadRecord.ok === false && afterBadRecord.reason === 'unavailable')
check('and that file is not overwritten either', readMountLedgerStrict().ok === false)

rmSync(LEDGER, { force: true })
const missing = readMountLedgerStrict()
check('a MISSING ledger is an empty ledger', missing.ok === true && missing.owners.length === 0)
check('so a first-run claim proceeds', claimMount('after-missing').ok === true)
releaseMount('after-missing')
clearOwnMounts()

// ── 6. Lock policy: only a holder that is gone may be reclaimed ────────────
// The stale-lock rule used to be mtime-only, so a peer could take a lock away
// from a holder that was merely paused; when that holder resumed it could then
// commit a snapshot derived before the steal. Judging by the holder PID closes
// that window without giving up crash recovery.
console.log('lock policy:')
const longAgo = new Date(Date.now() - 10 * 60_000)
rmSync(LEDGER, { force: true })
// A pid that is genuinely alive and is NOT ours: `pidAlive` short-circuits on
// `pid === process.pid`, so using our own would never exercise the
// `process.kill` witness this rule is built on. (The peer above is dead by now.)
const liveKeeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' })
const livePid = liveKeeper.pid
if (!await until(() => pidAlive(livePid))) throw new Error('the live keeper never started')
const liveKeeperCreated = processCreationTime(livePid)
if (typeof liveKeeperCreated !== 'number') throw new Error('the live keeper creation time could not be read on this platform')
// The lock's mtime is staged AFTER its holder's creation — a real lock is
// always written by a holder that was already running — because an mtime
// earlier than the holder's birth now reads as a recycled pid (section 8).
// Dating it past the recycle slack also pins the other half of the rule: age
// alone never reclaims a lock whose holder identity is intact.
const oldButConsistent = new Date(liveKeeperCreated + 61_000)
writeFileSync(LOCK, `${livePid}-liveholder\n`, 'utf8')
utimesSync(LOCK, oldButConsistent, oldButConsistent)
const blockedByLive = claimMount('locked-sess')
check('a lock whose holder is ALIVE is never reclaimed', blockedByLive.ok === false && blockedByLive.reason === 'busy')
check('and the live holder still owns its lock file', existsSync(LOCK))
rmSync(LOCK, { force: true })
liveKeeper.kill()
if (!await until(() => !pidAlive(livePid))) throw new Error('the live keeper did not exit')

// A lock whose token cannot be read is the create-then-write window: a FRESH
// one is a peer mid-acquisition and must be left alone, an old one is a crash.
writeFileSync(LOCK, '', 'utf8')
check('a fresh lock with no readable holder is left alone', claimMount('locked-sess').ok === false)
writeFileSync(LOCK, '', 'utf8')
utimesSync(LOCK, longAgo, longAgo)
check('an OLD unreadable lock is reclaimed as a crash leftover', claimMount('locked-sess').ok === true)
releaseMount('locked-sess')

writeFileSync(LOCK, `${deadPid}-crashed\n`, 'utf8')
utimesSync(LOCK, longAgo, longAgo)
check('a lock whose holder is DEAD is reclaimed at once', claimMount('locked-sess').ok === true)
check('and the lock file is released afterwards', !existsSync(LOCK))
releaseMount('locked-sess')
clearOwnMounts()

// ── 7. Reservations survive a publisher beat, and end explicitly ───────────
// A claim is committed before the agent exists in the registry. If the beat
// rebuilt the published set from the roster alone it would erase that claim,
// and a peer asking in the meantime would be told the session is free.
console.log('reservation:')
rmSync(LEDGER, { force: true })
const reserved = await reserveMount('reserved-sess')
check('a free session reserves ok', reserved.ok === true)
publishMounts([])
check('a beat that cannot see the agent keeps the reservation', readMountLedger().some(
  owner => owner.pid === process.pid && owner.sessionIds.includes('reserved-sess'),
))
check('and the session still reads as ours', occupancyOf('reserved-sess', readSessionOwners()).kind === 'mine')
reserved.reservation.settle()
publishMounts([])
check('settle ends the pin, so the next beat drops it', !readMountLedger().some(
  owner => owner.sessionIds.includes('reserved-sess'),
))

const abandoned = await reserveMount('abandoned-sess')
check('a second reservation is ok', abandoned.ok === true)
abandoned.reservation.abandon()
check('abandon gives the session straight back',
  occupancyOf('abandoned-sess', readSessionOwners()).kind === 'free'
  && !ownMounts().includes('abandoned-sess')
  && readMountLedgerStrict().ok === true)
abandoned.reservation.abandon()
check('and abandon is idempotent',
  occupancyOf('abandoned-sess', readSessionOwners()).kind === 'free' && ownMounts().length === 0)

// A reservation only gives back what it TOOK. Two attempts can overlap on one
// session (two fast `/resume`s, or a re-resume of a parked handle); when the
// first commits and the second is vetoed, the abandoned reservation must not
// release the mount the committed one is still driving — that would hand a log
// this process is writing to the next peer that asks.
const committedAttempt = await reserveMount('shared-sess')
const vetoedAttempt = await reserveMount('shared-sess')
check('two attempts on one session both reserve', committedAttempt.ok === true && vetoedAttempt.ok === true)
committedAttempt.reservation.settle()
vetoedAttempt.reservation.abandon()
check('an abandoned reservation does NOT release a committed mount',
  occupancyOf('shared-sess', readSessionOwners()).kind === 'mine' && ownMounts().includes('shared-sess'))
check('and the ledger still records us as its holder', readMountLedger().some(
  owner => owner.pid === process.pid && owner.sessionIds.includes('shared-sess'),
))
releaseMount('shared-sess')
clearOwnMounts()

// ── 8. Pid reuse: a recycled pid is not a holder (issue #988) ──────────────
// The cost the pid-only witness accepted: a dead owner's record names a pid
// the OS later hands to an unrelated live process — the reporter's Steam — and
// the session reads as "held by Steam" until Steam exits. The identity witness
// closes it from the cheap side: the publisher was alive when it wrote
// `startedAt`, so a live pid created AFTER that moment is an impostor and its
// record reads as dead — free to display, claimable, pruned by the claim's
// write. The other direction stays sealed: a live process created BEFORE its
// record could be the real publisher and must keep blocking, so nothing here
// can ever hand a mounted session to a second writer.
console.log('pid reuse:')
const squatter = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' })
const squatterPid = squatter.pid
if (!await until(() => pidAlive(squatterPid))) throw new Error('the squatter never started')
const squatterCreated = processCreationTime(squatterPid)
if (typeof squatterCreated !== 'number') throw new Error('the squatter creation time could not be read on this platform')
check('a live process reports its creation time', squatterCreated <= Date.now())
check('our own creation time is reported too', typeof processCreationTime(process.pid) === 'number')
check('a dead pid reports no creation time', processCreationTime(deadPid) === undefined)

// A crash leftover from a publisher that died long before the squatter was
// even created: the only way that pid is alive now is that it was recycled.
rmSync(LEDGER, { force: true })
writeRaw([peer(squatterPid, ['recycled-sess'], squatterCreated - 3_600_000)])
check('a record older than its live pid is not shown as occupied',
  occupancyOf('recycled-sess', readSessionOwners()).kind === 'free')
const recycledClaim = claimMount('recycled-sess')
check('a session whose only holder is a recycled pid is claimable', recycledClaim.ok === true)
check('and the recycled record was pruned by the claim write',
  !readMountLedger().some(owner => owner.pid === squatterPid))
releaseMount('recycled-sess')

// The safe direction: a live pid created AFTER the record began but BEFORE it
// was published could be the genuine publisher, and must keep blocking.
rmSync(LEDGER, { force: true })
writeRaw([peer(squatterPid, ['genuine-sess'], squatterCreated + 60_000)])
check('a record newer than its live pid still reads as occupied',
  occupancyOf('genuine-sess', readSessionOwners()).kind === 'occupied')
const genuineRefusal = claimMount('genuine-sess')
check('and still refuses the claim', genuineRefusal.ok === false && genuineRefusal.reason === 'occupied')
rmSync(LEDGER, { force: true })

// Just inside the slack window a record still counts as its pid's own: the
// margin exists so a backward clock step cannot prune a live peer.
writeRaw([peer(squatterPid, ['slack-sess'], squatterCreated - 30_000)])
check('a record inside the slack window errs toward occupied',
  occupancyOf('slack-sess', readSessionOwners()).kind === 'occupied')
clearOwnMounts()

// The lock gets the same witness: a token naming a live pid created after the
// lock was taken is a recycled holder, and the lock reclaims like a crash
// leftover instead of demanding the manual lock deletion the pid-only rule
// accepted.
writeFileSync(LOCK, `${squatterPid}-recycled\n`, 'utf8')
utimesSync(LOCK, longAgo, longAgo)
const reclaimedRecycled = claimMount('locked-recycled')
check('a lock whose holder pid was recycled is reclaimed', reclaimedRecycled.ok === true)
releaseMount('locked-recycled')
squatter.kill()
if (!await until(() => !pidAlive(squatterPid))) throw new Error('the squatter did not exit')

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nsession mount ledger checks passed')
