/**
 * Verification for the cross-process session mounting ledger
 * (src/sessionMounts.ts).
 *
 * This ledger is the only thing standing between two TUI terminals and a
 * corrupted shared transcript, so the cases that matter are the ones where the
 * safety property could silently fail rather than the happy path:
 *
 * - publish/read round trip, and `occupancyOf` reporting `mine` for our own
 *   claim (so a terminal never refuses its OWN parked session);
 * - a FOREIGN live claim reports `occupied` with the holder's pid;
 * - a claim whose heartbeat is older than the TTL is abandoned — the pulled
 *   plug / suspended laptop case, where the process may even still exist;
 * - a claim whose pid is gone is abandoned regardless of heartbeat — the
 *   `kill -9` case;
 * - a claim that is BOTH dead and stale is pruned from the file on READ, so the
 *   ledger heals itself with no separate reaper;
 * - one session claimed twice keeps the most recent heartbeat (the protocol
 *   forbids the state; picking deterministically beats picking arbitrarily);
 * - `clearOwnMounts` removes only our record and leaves a peer's intact;
 * - malformed and version-mismatched documents read as empty instead of
 *   throwing, because a corrupt cache must degrade and never take down a
 *   session.
 *
 * Uses a temp HOME so the real ~/.dsh-tui is never touched. The module reads
 * `homedir()` at import time, so HOME/USERPROFILE are set BEFORE the dynamic
 * import.
 *
 * Run: node --import tsx/esm scripts/verify-session-mounts.mjs
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'dsh-mounts-'))
process.env.HOME = tmpHome
process.env.USERPROFILE = tmpHome

const mod = await import('../src/sessionMounts.ts')
const {
  HEARTBEAT_TTL_MS,
  clearOwnMounts,
  occupancyOf,
  ownMounts,
  pidAlive,
  publishMounts,
  readLiveMounts,
  readMountLedger,
  readSessionOwners,
  releaseMount,
} = mod

const LEDGER = join(tmpHome, '.dsh-tui', 'session-mounts.json')

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    console.error(`  FAIL ${name}`)
    failures++
  }
}

/** Write a raw ledger document, bypassing the module, to stage a peer claim. */
function writeRaw(owners, version = 1) {
  mkdirSync(join(tmpHome, '.dsh-tui'), { recursive: true })
  writeFileSync(LEDGER, JSON.stringify({ version, owners }, null, 2), 'utf8')
}

/** A peer record shape with the fields the ledger validates. */
function peer(pid, sessionIds, heartbeatAt) {
  return { pid, heartbeatAt, startedAt: heartbeatAt, sessionIds }
}

/** A pid that is certainly not running: spawn-free, and validated by probe. */
function findDeadPid() {
  for (let candidate = 999_999; candidate > 100_000; candidate -= 137) {
    if (!pidAlive(candidate)) return candidate
  }
  throw new Error('no dead pid candidate found')
}

const NOW = Date.now()

console.log('occupancy of our own claim:')
publishMounts(['sess-a', 'sess-b'])
check('both ids published', ownMounts().length === 2)
{
  const owners = readSessionOwners()
  check('our session reads as mine', occupancyOf('sess-a', owners).kind === 'mine')
  check('an unknown session reads as free', occupancyOf('nope', owners).kind === 'free')
}
check('releaseMount drops one id', releaseMount('sess-b') && ownMounts().length === 1)
check('released id is no longer ours', occupancyOf('sess-b', readSessionOwners()).kind === 'free')

console.log('a foreign live claim:')
{
  // A live pid of another process: the node process running this script is not
  // a peer, so use pid 1 (always present on POSIX; on Windows use the parent).
  const foreignPid = process.platform === 'win32' ? process.ppid : 1
  writeRaw([peer(foreignPid, ['foreign-sess'], NOW)])
  const owners = readSessionOwners(NOW)
  const occupancy = occupancyOf('foreign-sess', owners)
  check('foreign session is occupied', occupancy.kind === 'occupied')
  check('occupancy names the holder pid', occupancy.kind === 'occupied' && occupancy.pid === foreignPid)
}

console.log('a stale heartbeat is abandoned (pulled plug):')
{
  const foreignPid = process.platform === 'win32' ? process.ppid : 1
  writeRaw([peer(foreignPid, ['stale-sess'], NOW - HEARTBEAT_TTL_MS - 1)])
  check('stale claim is not live', readLiveMounts(NOW).length === 0)
  check('stale session reads as free', occupancyOf('stale-sess', readSessionOwners(NOW)).kind === 'free')
}

console.log('a dead pid is abandoned (kill -9):')
{
  const dead = findDeadPid()
  writeRaw([peer(dead, ['dead-sess'], NOW)])
  check('dead claim is not live', readLiveMounts(NOW).length === 0)
  check('dead session reads as free', occupancyOf('dead-sess', readSessionOwners(NOW)).kind === 'free')
  // The read that discovered it must have healed the file.
  const healed = JSON.parse(readFileSync(LEDGER, 'utf8'))
  check('ledger prunes the dead owner on read', healed.owners.every(o => o.pid !== dead))
}

console.log('a live claim survives a read (no over-eager pruning):')
{
  const foreignPid = process.platform === 'win32' ? process.ppid : 1
  writeRaw([peer(foreignPid, ['keep-sess'], NOW)])
  check('live claim stays live', readLiveMounts(NOW).length === 1)
  check('live claim still in the file', readMountLedger().some(o => o.sessionIds.includes('keep-sess')))
}

console.log('duplicate claims keep the most recent heartbeat:')
{
  const foreignPid = process.platform === 'win32' ? process.ppid : 1
  const otherPid = process.platform === 'win32' ? process.pid : 1
  writeRaw([
    peer(foreignPid, ['dup-sess'], NOW - 5_000),
    peer(otherPid, ['dup-sess'], NOW),
  ])
  const owners = readSessionOwners(NOW)
  check('duplicate resolves to the newest heartbeat', owners.get('dup-sess')?.heartbeatAt === NOW)
}

console.log('clearOwnMounts removes only our record:')
{
  const foreignPid = process.platform === 'win32' ? process.ppid : 1
  publishMounts(['sess-c'])
  writeRaw([
    ...readMountLedger().filter(o => o.pid !== process.pid),
    peer(foreignPid, ['peer-sess'], NOW),
    ...readMountLedger().filter(o => o.pid === process.pid),
  ])
  clearOwnMounts()
  const after = readMountLedger()
  check('our record is gone', after.every(o => o.pid !== process.pid))
  check("the peer's record survives", after.some(o => o.sessionIds.includes('peer-sess')))
}

console.log('malformed documents degrade instead of throwing:')
{
  mkdirSync(join(tmpHome, '.dsh-tui'), { recursive: true })
  writeFileSync(LEDGER, '{ not json', 'utf8')
  check('unparseable file reads as empty', readMountLedger().length === 0)
  writeRaw([], 99)
  check('version mismatch reads as empty', readMountLedger().length === 0)
  writeRaw([{ pid: 'x', heartbeatAt: NOW, startedAt: NOW, sessionIds: [] }])
  check('a wrong-typed record is dropped', readMountLedger().length === 0)
  writeRaw([{ pid: 12, heartbeatAt: 'soon', startedAt: NOW, sessionIds: [] }])
  check('a non-numeric heartbeat is dropped', readMountLedger().length === 0)
}

console.log('missing ledger is not an error:')
{
  const gone = join(tmpHome, '.dsh-tui', 'session-mounts.json')
  if (existsSync(gone)) {
    writeFileSync(gone, '', 'utf8')
  }
  check('empty file reads as empty', readMountLedger().length === 0)
}

console.log(failures === 0 ? '\nAll session-mount checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
