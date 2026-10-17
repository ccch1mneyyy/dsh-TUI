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
 * 5. LOCK POLICY: a lock whose holder pid is ALIVE is never reclaimed, however
 *    old the file looks; a lock whose holder is gone is reclaimed immediately.
 *    The first half is what the old mtime-only rule got wrong (a paused holder
 *    could be stolen from and then commit a snapshot derived before the steal);
 *    the second half is what keeps a crash from needing manual cleanup.
 * 6. RESERVATIONS: an in-flight mount survives a publisher beat that cannot see
 *    its agent yet, and ends explicitly — settle (the roster takes over) or
 *    abandon (the session goes back).
 *
 * Plus the degradation rule: a malformed or foreign-shaped document still reads
 * as an empty ledger through the DISPLAY reader, because a corrupt cache must
 * never take down a session screen. Only the deciding reader refuses.
 *
 * Plus the refusal's way out: a ledger that exists but is not a ledger document
 * refuses as `damaged` — one form per branch of the strict read that sets the
 * flag — and the sentence the interactive surfaces show has to name the file to
 * delete and when deleting it is safe, in both languages, and has to FIT the
 * notice it is shown in: the screen caps that notice at three rows and hands it
 * fewer columns than the terminal has, so a longer sentence arrives cut off
 * (group 9). The counter-examples are what keep that flag honest: a MISSING
 * file is a genuine first run, an UNREADABLE one (a directory in its place) is
 * not damage, and a good ledger this process may not write is a permission
 * problem — sending a user to delete a file that may be a peer's only claim
 * would be the wrong repair.
 *
 * Every branch of `readMountLedgerStrict` that sets the flag has a row in group 8,
 * and each row was checked the only way that counts: take that branch's
 * `damaged: true` away, re-run this script, watch that row go red. A row whose
 * branch can be dropped without a red is decoration — re-run the check when
 * extending the table. Coverage stops at the strict read, though: `writeLedger()`
 * forwards the flag as well and carries no row here, because the forward only
 * changes what a caller sees when a peer rewrites the file between the claim's
 * read and its replace — a window no fixture in this file can reach, so the gap
 * is left open on purpose rather than pinned by a check that cannot fail.
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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'

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
  readMountLedgerStrict,
  readSessionOwners,
  releaseMount,
  reserveMount,
} = await import('../src/sessionMounts.ts')

// What the refusal SAYS is part of this contract too (issue #1579): the text
// sink the interactive surfaces share, and the dictionary behind it. Both are
// imported under the redirected HOME above, because the language module reads
// its saved choice out of that data directory at import time.
const { mountFailureText } = await import('../src/sessions/resumeFailure.ts')
const { i18nDict, setLang, t } = await import('../src/i18n.ts')
// The wrap the screen itself applies to that sentence, plus the row cap it
// applies it under (group 9 measures the sentence through these, not a copy).
const { noticeLines, NOTICE_MAX_LINES } = await import('../src/screens/sessionSupervisor/model.js')

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
writeFileSync(LOCK, `${livePid}-liveholder\n`, 'utf8')
utimesSync(LOCK, longAgo, longAgo)
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

// ── 8. Damaged ledger: the refusal has to come with a way out ──────────────
// #1579: an all-zero (or half-written) ledger refuses EVERY mount, and the
// refusal used to stop at "occupancy could not be verified" — a dead end for a
// user who cannot read the file's mind. The strict read can tell which kind of
// "could not read" this is, and the sentence a user sees has to turn that into
// an action: this is the file to delete, and this is when that is safe.
console.log('damaged ledger:')

const REPAIR_KEY = 'resume-mount-ledger-repair'
// What the repair sentence has to get across, as keywords: the thing to delete,
// and the "nothing else is running" precondition. Keyword-level on purpose — the
// dictionary owns the wording, so pinning the exact sentence here would fail a
// harmless reword without judging anything more.
const REPAIR_POINTS = { zh: ['删除', '其他'], en: ['remove', 'no other'] }

/** Whether the repair sentence itself carries both halves of the action. */
function repairSaysWhatToDo(lang) {
  const sentence = i18nDict[REPAIR_KEY]?.[lang]
  return typeof sentence === 'string'
    && REPAIR_POINTS[lang].every(point => sentence.toLowerCase().includes(point))
}

/** Whether a rendered refusal names the ledger AND carries that sentence. */
function namesFileAndRepair(text, lang) {
  const sentence = i18nDict[REPAIR_KEY]?.[lang]
  return typeof sentence === 'string' && text.includes(LEDGER) && text.includes(sentence)
}

check('the zh repair sentence tells the user to delete and when it is safe', repairSaysWhatToDo('zh'))
check('the en repair sentence tells the user to delete and when it is safe', repairSaysWhatToDo('en'))

// Two forms of the same accident: storage that handed back zeroes (the length
// #1579 reported), and a write cut off mid-document.
const DAMAGE_FORMS = [
  { label: 'all-zero bytes', write: () => writeFileSync(LEDGER, Buffer.alloc(468)) },
  { label: 'a truncated document', write: () => writeFileSync(LEDGER, '{"version":1,"owners":[{', 'utf8') },
]

for (const form of DAMAGE_FORMS) {
  rmSync(LEDGER, { force: true })
  form.write()

  const read = readMountLedgerStrict()
  check(`${form.label}: the strict read reports damage, not emptiness`,
    read.ok === false && read.damaged === true)
  check(`${form.label}: and names the file the user has to repair`,
    read.ok === false && read.detail.includes(LEDGER))

  const beforeClaim = readFileSync(LEDGER)
  const claim = claimMount('damaged-sess')
  check(`${form.label}: the claim refuses as unavailable, flagged damaged`,
    claim.ok === false && claim.reason === 'unavailable' && claim.damaged === true)
  check(`${form.label}: and the refused claim leaves the file byte-for-byte as it was`,
    readFileSync(LEDGER).equals(beforeClaim))

  setLang('en')
  check(`${form.label}: the en notice names the file and how to repair it`,
    namesFileAndRepair(mountFailureText(claim), 'en'))
  setLang('zh')
  check(`${form.label}: the zh notice names the file and how to repair it`,
    namesFileAndRepair(mountFailureText(claim), 'zh'))

  const beforePublish = readFileSync(LEDGER)
  check(`${form.label}: publishing still writes nothing`, publishMounts(['ours']) === false)
  check(`${form.label}: and leaves the file byte-for-byte as it was`,
    readFileSync(LEDGER).equals(beforePublish))
  clearOwnMounts()
}

// The two forms above are both PARSE failures — one of the five places that set
// `damaged`; this table is the rest of that map, one row per branch. Only the
// parse failure was pinned before: with this table absent, any of the four could
// be deleted from `readMountLedgerStrict` with every check in this file still
// green, and the user would be back to a refusal with no way out.
//
// The shared half of the contract — the file named, both language notices, the
// bytes surviving the attempt — stays on the two forms above: it is one sentence
// for every form, and repeating it per row would pin the same behaviour six
// times. What differs per branch is the verdict and the reason, so that is what
// a row pins here. The reason is not a restatement of the verdict: a bare `0`
// falling through to the version check would still refuse as damage, and only
// the reason tells a scalar that is not a document from a version that was never
// there (it would read `unknown version undefined`).
const OTHER_DAMAGE_FORMS = [
  { label: 'a bare 0 in place of a document', reason: 'is not a ledger document', document: '0' },
  { label: 'a version this build does not know', reason: 'has unknown version', document: '{"version":9,"owners":[]}' },
  { label: 'a document with no owners array', reason: 'has no owners array', document: '{"version":1}' },
  { label: 'a record whose pid is not a pid', reason: 'has a record whose shape is wrong',
    document: '{"version":1,"owners":[{"pid":"nope","startedAt":1,"sessionIds":[]}]}' },
]

for (const form of OTHER_DAMAGE_FORMS) {
  rmSync(LEDGER, { force: true })
  writeFileSync(LEDGER, form.document, 'utf8')

  const read = readMountLedgerStrict()
  check(`${form.label}: the strict read reports damage, not emptiness`,
    read.ok === false && read.damaged === true)
  check(`${form.label}: and the reason names this form`,
    read.ok === false && read.detail.includes(form.reason))

  const claim = claimMount('damaged-sess')
  check(`${form.label}: the claim refuses as unavailable, flagged damaged`,
    claim.ok === false && claim.reason === 'unavailable' && claim.damaged === true)
  clearOwnMounts()
}

// The counter-examples are what keep the flag honest. Without them it drifts
// into "anything that stopped a read", and the sentence starts sending users to
// delete files that are either absent or perfectly good.
rmSync(LEDGER, { force: true })
const absent = readMountLedgerStrict()
check('a MISSING ledger is a first run, not damage', absent.ok === true && absent.owners.length === 0)
const firstRun = claimMount('first-run-sess')
check('so the first-run claim still goes through', firstRun.ok === true)
check('and neither verdict is flagged as damage', absent.damaged !== true && firstRun.damaged !== true)
clearOwnMounts()

// A good ledger this process may not WRITE is not damage either: the bytes read
// back, so there is no document to repair and "delete this file" — which is what
// the damage advice says — would not fix a permission problem. `resumeFailure.ts`
// names exactly these causes when it decides who gets that advice ("the other
// causes (permissions, a lock, a failed replace) would make wrong"), so this row
// is what keeps the flag on the right side of that line.
//
// Denying the write takes two moves, because the platforms deny it differently:
// Windows refuses to replace a read-only FILE, while POSIX replaces that happily
// and instead refuses to create anything (the lock, the temp file) in a
// directory that lost its write bit. Neither move denies anything to ROOT: the
// bits are advisory for uid 0, `claimMount` would simply succeed, and both checks
// below would then fail over the environment rather than the behaviour. So where
// the deny is not real they are skipped instead — loudly, so a root run reads as
// "not covered here" and never as "this contract holds here".
const modeBitsDenyWrites = process.getuid?.() !== 0 // no getuid at all (Windows) = not root
const LEDGER_DIR = join(tmpHome, '.dsh-tui')
rmSync(LEDGER, { force: true })
rmSync(LOCK, { force: true }) // a leftover lock would refuse as `busy` before the denial is reached
writeRaw([])
if (modeBitsDenyWrites) {
  chmodSync(LEDGER, 0o444)
  chmodSync(LEDGER_DIR, 0o555)
  const protectedRead = readMountLedgerStrict()
  check('a write-protected ledger still reads as a good ledger', protectedRead.ok === true)
  const blockedByPermissions = claimMount('read-only-sess')
  check('so its refusal is a permission problem, never damage',
    blockedByPermissions.ok === false && blockedByPermissions.reason === 'unavailable'
    && blockedByPermissions.damaged !== true)
  // The deny is lifted again — 0o700 because that is the mode the module creates
  // its data directory with — since every block below writes into it.
  chmodSync(LEDGER, 0o644)
  chmodSync(LEDGER_DIR, 0o700)
  clearOwnMounts()
} else {
  console.log('  skip: running as root — mode bits do not deny writes')
}

// A directory in the ledger's place is the read failure the flag must NOT
// swallow: there is no document to repair, and the path may be somebody's data.
// This pair is what gives the flag its discriminating power.
rmSync(LEDGER, { force: true })
mkdirSync(LEDGER, { recursive: true })
const unreadable = readMountLedgerStrict()
check('a directory where the ledger belongs reads as unavailable', unreadable.ok === false)
check('but "cannot read it" is NOT reported as damage', unreadable.damaged !== true)
const blockedByDirectory = claimMount('unreadable-sess')
check('so that claim refuses without calling itself damaged',
  blockedByDirectory.ok === false && blockedByDirectory.reason === 'unavailable'
  && blockedByDirectory.damaged !== true)
setLang('en')
const unreadableEn = mountFailureText(blockedByDirectory)
setLang('zh')
const unreadableZh = mountFailureText(blockedByDirectory)
check('and neither language sends the user off to delete anything',
  !namesFileAndRepair(unreadableEn, 'en') && !namesFileAndRepair(unreadableZh, 'zh'))

// The CLI keeps its own English sentence (the two surfaces are worded separately
// on purpose), so the only thing worth pinning there is the ACTION — loosely, so
// that a reworded sentence passes and a dropped piece of advice does not. The
// branch's adjacent string literals are joined the way
// the runtime would, so the match survives a reflow; a moved anchor reads as an
// empty branch and fails loudly instead of passing on some other sentence.
//
// The window is the resume claim block: it opens at the `reserveMount` call and
// closes at the `ctx.agents.resume` call that block guards, so both boundaries are
// API calls rather than local bindings or comments — renaming a variable (or
// compressing a comment) can no longer blank the window while the advice it
// guards is still there.
const pluginSource = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
const refusalStart = pluginSource.indexOf('await reserveMount(')
const refusalEnd = pluginSource.indexOf('await ctx.agents.resume(', refusalStart)
const resumeRefusal = refusalStart < 0 || refusalEnd < 0
  ? ''
  : pluginSource.slice(refusalStart, refusalEnd)
    .replace(/['"`]\s*\+\s*['"`]/g, ' ')
    .replace(/\s+/g, ' ')
check('the --resume refusal still says to remove the file with nothing else running',
  /(remove|delete)\b.{0,120}?\bno other\b.{0,40}?\brunning\b/i.test(resumeRefusal))

// Leave the path free of the directory: every other group starts from
// `rmSync(LEDGER, { force: true })`, which throws on one.
rmSync(LEDGER, { recursive: true, force: true })

// ── 9. Visibility: the refusal has to fit its notice, not just exist ───────
// Advice a user never sees is the dead end #1579 was. The supervisor caps a
// notice at NOTICE_MAX_LINES rows, and on a 120-column terminal it wraps that
// notice at 80 columns: the rail takes 36+1 of the 120, and the notice gives up
// 3 more — both are the supervisor's own width split. So the refusal arrives
// whole only if the wording wraps into three rows of 80. The cap and the wrap
// are the screen's own function; measuring with a copy of the rule here would
// pin the copy instead of the screen.
console.log('visibility:')

// A real install keeps the ledger at `~/.dsh-tui/session-mounts.json`; this
// fixture's HOME is a temp path many columns longer, which no install has. The
// wording is sized for the installed length, so the readings below REBASE the
// real sentence onto one — the same `mountFailureText()` output off the same
// damaged ledger, with nothing but the path swapped for the one a user's notice
// carries. Spelled off the temp path's own root instead of a literal `C:\`, so
// the reading means the same thing where HOME is POSIX.
const INSTALLED_LEDGER = join(parse(tmpHome).root, 'Users', 'someone', '.dsh-tui', 'session-mounts.json')

// The path is free of the directory above, so a plain write stages the damage.
writeFileSync(LEDGER, Buffer.alloc(468))
const visibleClaim = claimMount('visible-sess')
if (!mountFailureText(visibleClaim).includes(LEDGER)) {
  throw new Error('the damaged refusal no longer names the ledger — the visibility fixture has to be rebuilt')
}

/**
 * The rows the supervisor paints for that refusal in `lang`, at notice width
 * `width` — composed the way the screen composes its notices.
 */
function refusalRows(lang, width) {
  setLang(lang)
  const reason = mountFailureText(visibleClaim).split(LEDGER).join(INSTALLED_LEDGER)
  return noticeLines(t('supervisor-open-failed', { name: 'victim session', reason }), width)
}

/** Whether `noticeLines` dropped anything: it fills the cap and marks the cut with `…`. */
const cutOff = rows => rows.length === NOTICE_MAX_LINES && rows[NOTICE_MAX_LINES - 1].endsWith('…')

// 80 columns is what a 120-column terminal leaves the notice — the terminal the
// wording is written for — so the refusal has to arrive whole there.
for (const lang of ['zh', 'en']) {
  check(`the ${lang} refusal fits the notice cap on a 120-column terminal`, !cutOff(refusalRows(lang, 80)))
}

// 66 columns is what a 100-column terminal leaves. The reassurance may fall off
// a screen that narrow; the action and its precondition may not. Group 8 keeps
// both words in the DICTIONARY, which is not the same thing as keeping them on
// the screen: the wording this replaced had both and showed only `remove`.
for (const lang of ['zh', 'en']) {
  const painted = refusalRows(lang, 66).join(' ').toLowerCase()
  check(`a 100-column terminal still shows the repair action and its precondition (${lang})`,
    REPAIR_POINTS[lang].every(point => painted.includes(point)))
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nsession mount ledger checks passed')
