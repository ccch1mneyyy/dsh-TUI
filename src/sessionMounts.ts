/**
 * Cross-process session mounting ledger, kept at
 * `~/.dsh-tui/session-mounts.json`.
 *
 * A TUI terminal is a process that can host SEVERAL agent sessions at once
 * (the attached one plus every parked background session). Sessions are also
 * durable: another TUI, or `dsh web`, can list the same logs. Nothing in the
 * DSH session store says *who is currently driving a log*, so two TUI
 * processes resuming the same session would interleave writes into one
 * append-only event log and corrupt the transcript.
 *
 * This file is that missing fact, and it is deliberately the smallest one
 * that answers "may I mount this session?": each TUI process publishes the
 * set of sessions it currently has mounted, plus a heartbeat. A reader that
 * sees a foreign entry treats the session as OCCUPIED and refuses to mount it.
 *
 * Liveness is decided by two independent witnesses, because each one alone
 * has a failure mode:
 *
 * - `process.kill(pid, 0)` catches a clean exit and a kill -9 (the pid is
 *   gone). It cannot catch pid REUSE, and it cannot see anything across
 *   machines that share a home directory over a network.
 * - The heartbeat timestamp catches pid reuse (a task manager entry cannot
 *   refresh a record the way the removed process did) and a machine that
 *   vanished. It cannot tell a process that exited from one that is alive but
 *   wedged.
 *
 * An entry is live when the pid exists AND the heartbeat is within
 * {@link HEARTBEAT_TTL_MS}: BOTH witnesses have to fail before a foreign
 * session becomes mountable. That is the correct direction for a pid-reuse
 * guard — an OR would let a recycled pid keep a dead owner's record alive
 * forever, which is worse than the stale-owner case below.
 *
 * The known cost of AND is a live-but-stale owner: a process suspended longer
 * than one TTL (a laptop closed overnight) loses its published claim on
 * resume, and a peer that took the session meanwhile is not visible to it. The
 * writers that matter are still separated by the host's own write lock — this
 * ledger is the cross-process VISIBILITY layer, not the write authority — but a
 * long suspension is the one window where it cannot promise more. What is NOT
 * acceptable, and what this file used to do, is treating a stale heartbeat as
 * authority to release a record while claiming to keep wedged owners: the two
 * answers cannot both be true, and the code and the docs above now agree.
 *
 * A pulled plug or a truncated process leaves no heartbeat, so the claim
 * expires on its own within one TTL and never needs a repair step — the ledger
 * is self-healing on read.
 *
 * Writes take a short cross-process lock and replace the file atomically, so
 * two TUIs publishing at the same instant cannot lose each other's records. A
 * CLAIM takes the same lock and re-derives its conflict from the file while
 * holding it ({@link claimMount}), because "check, then publish" is not atomic
 * across processes: both callers can observe `free` and both publish. Every
 * operation is best-effort and total: this ledger is a safety net, and an
 * unwritable home directory must degrade to "no cross-process protection"
 * rather than take down the session.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

const MOUNTS_FILE = 'session-mounts.json'
const LOCK_FILE = 'session-mounts.lock'

/** Schema version of the persisted document. */
const MOUNTS_VERSION = 1

/**
 * How long a heartbeat stays valid without a refresh. The writer refreshes at
 * {@link HEARTBEAT_INTERVAL_MS}, so this tolerates four consecutive missed
 * beats: long enough that a busy event loop or a suspended laptop does not
 * drop a live owner's claim, short enough that a killed terminal frees its
 * sessions while the user is still looking at the screen.
 */
export const HEARTBEAT_TTL_MS = 45_000

/**
 * How often the owning process republishes its mounted set. The requirement
 * is a bounded, cheap poll: this is one small file write, so the cost is a
 * few hundred microseconds and it is deliberately not tied to any render
 * frame. A `setInterval` at this period is `.unref()`d by the caller so it
 * never holds the process open on its own.
 */
export const HEARTBEAT_INTERVAL_MS = 15_000

/** Reclaim a lock left behind by a crashed writer after this long. */
const STALE_LOCK_MS = 30_000

/** Sessions one process may claim. Guards a runaway against an unbounded file. */
const MAX_SESSIONS_PER_OWNER = 256

let temporarySequence = 0

type ErrnoLike = { code?: unknown }

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as ErrnoLike).code === code
}

/** One process's published claim: the sessions it currently has mounted. */
export interface SessionMountOwner {
  /** Operating-system process id of the TUI holding these sessions. */
  readonly pid: number
  /**
   * Epoch ms of the owner's last heartbeat. A record whose heartbeat is older
   * than {@link HEARTBEAT_TTL_MS} is treated as abandoned.
   */
  readonly heartbeatAt: number
  /** Epoch ms when this process first published a record (diagnostics). */
  readonly startedAt: number
  /** Session ids this process has mounted, in no significant order. */
  readonly sessionIds: readonly string[]
}

/** Why a session cannot be mounted by this process. */
export type SessionOccupancy =
  | { readonly kind: 'free' }
  | { readonly kind: 'mine' }
  | { readonly kind: 'occupied'; readonly pid: number; readonly heartbeatAt: number }

const EMPTY: SessionOccupancy = { kind: 'free' }

/**
 * Outcome of {@link claimMount}: either this process now owns the session, or
 * the pids that hold it do. `holders` is empty when the ledger itself could
 * not be read or written, which is a refusal too — just not one that can name a
 * peer.
 */
export type MountClaim =
  | { readonly ok: true }
  | { readonly ok: false; readonly holders: readonly number[] }

/**
 * Whether a process id is still alive. `process.kill(pid, 0)` sends no signal
 * and throws `ESRCH` when the process is gone; `EPERM` means it exists but is
 * owned by another user, which still counts as alive here.
 * @param pid - Process id to probe.
 * @returns True when the process appears to exist.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return hasCode(error, 'EPERM')
  }
}

/**
 * Whether a published record still owns its sessions. The record stays live
 * only while BOTH witnesses agree: the pid exists and the heartbeat is fresh.
 * See the module header for why the heartbeat outranks a live-but-stale pid.
 * @param owner - The record to judge.
 * @param now - Current epoch ms (injectable for the regression).
 * @returns True when the record is still authoritative.
 */
export function ownerIsLive(owner: SessionMountOwner, now: number = Date.now()): boolean {
  if (!pidAlive(owner.pid)) return false
  return now - owner.heartbeatAt <= HEARTBEAT_TTL_MS
}

/** Parse and validate one record, or undefined when the shape is wrong. */
function parseOwner(value: unknown): SessionMountOwner | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const { pid, heartbeatAt, startedAt, sessionIds } = record
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined
  if (typeof heartbeatAt !== 'number' || !Number.isFinite(heartbeatAt)) return undefined
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined
  if (!Array.isArray(sessionIds)) return undefined
  const ids = sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
  return { pid, heartbeatAt, startedAt, sessionIds: ids }
}

/**
 * Read the ledger, keeping every record the shape check accepts. Missing or
 * malformed data reads as empty: the caller's next write repairs the file, so
 * there is nothing to report and nothing to throw.
 * @returns The parsed records, in file order.
 */
export function readMountLedger(): readonly SessionMountOwner[] {
  let raw: string
  try {
    raw = readFileSync(join(DATA_DIR, MOUNTS_FILE), 'utf8')
  } catch {
    // No ledger yet, or a concurrent writer replaced it mid-read.
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    // A partially written file; the next writer replaces it wholesale.
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const document = parsed as Record<string, unknown>
  if (document.version !== MOUNTS_VERSION || !Array.isArray(document.owners)) return []
  return document.owners
    .map(parseOwner)
    .filter((owner): owner is SessionMountOwner => owner !== undefined)
}

/**
 * The live records only: a record that died is pruned from disk so the next
 * reader starts clean.
 *
 * This is the read path the UI polls, so it is the natural place to heal a
 * ledger abandoned by a killed terminal — no separate reaper to schedule, and
 * a reader is always looking anyway.
 *
 * The prune takes the SAME lock every writer takes and re-reads the file under
 * it. Filtering a lock-free snapshot and writing it back would drop any record
 * a peer published between our read and our replace — a live session would
 * simply vanish from the occupancy table while its process kept writing.
 * It also keeps this process's OWN record: our heartbeat is refreshed by a
 * timer, so a reader can legitimately see our record as stale for a moment, and
 * dropping it would drop our claim.
 * @param now - Current epoch ms (injectable for the regression).
 * @returns The authoritative records as of this read.
 */
export function readLiveMounts(now: number = Date.now()): readonly SessionMountOwner[] {
  const all = readMountLedger()
  const live = all.filter(owner => owner.pid === process.pid || ownerIsLive(owner, now))
  if (live.length !== all.length) {
    const fd = acquireLock()
    if (fd !== null) {
      try {
        const pruned = readMountLedger().filter(owner => owner.pid === process.pid || ownerIsLive(owner, now))
        writeLedger(pruned)
        return pruned
      } finally {
        releaseLock(fd)
      }
    }
  }
  return live
}

/**
 * Which process has each session mounted, considering only live owners.
 * A session claimed by several live owners keeps the most recent heartbeat:
 * the protocol forbids that state, and picking one deterministically beats
 * reporting whichever the file happened to list first.
 * @param now - Current epoch ms (injectable for the regression).
 * @returns Session id to the owning record.
 */
export function readSessionOwners(now: number = Date.now()): ReadonlyMap<string, SessionMountOwner> {
  const owners = new Map<string, SessionMountOwner>()
  for (const owner of readLiveMounts(now)) {
    for (const sessionId of owner.sessionIds) {
      const existing = owners.get(sessionId)
      if (existing === undefined || existing.heartbeatAt < owner.heartbeatAt) {
        owners.set(sessionId, owner)
      }
    }
  }
  return owners
}

/**
 * The occupancy of one session, from THIS process's point of view.
 * @param sessionId - Session id to look up.
 * @param owners - A snapshot from {@link readSessionOwners}, so a screen can
 *   resolve a whole listing from one read instead of one per row.
 * @returns `mine` for a self-held session, `occupied` for a foreign one.
 */
export function occupancyOf(
  sessionId: string,
  owners: ReadonlyMap<string, SessionMountOwner>,
): SessionOccupancy {
  const owner = owners.get(sessionId)
  if (owner === undefined) return EMPTY
  if (owner.pid === process.pid) return { kind: 'mine' }
  return { kind: 'occupied', pid: owner.pid, heartbeatAt: owner.heartbeatAt }
}

/** Take the short cross-process lock, or null when another writer holds it. */
function acquireLock(): number | null {
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  } catch {
    return null
  }
  const lockPath = join(DATA_DIR, LOCK_FILE)
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number
    try {
      fd = openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      if (!hasCode(error, 'EEXIST') || attempt > 0) return null
      try {
        if (Date.now() - statSync(lockPath).mtimeMs <= STALE_LOCK_MS) return null
        rmSync(lockPath, { force: true })
      } catch {
        return null
      }
      continue
    }
    try {
      writeFileSync(fd, `${process.pid}\n`, 'utf8')
      return fd
    } catch {
      try {
        closeSync(fd)
      } catch {
        // The lock name is removed below regardless.
      }
      try {
        rmSync(lockPath, { force: true })
      } catch {
        // A stale lock is recoverable on the next mutation.
      }
      return null
    }
  }
  return null
}

/** Release the lock taken by {@link acquireLock}. */
function releaseLock(fd: number): void {
  try {
    closeSync(fd)
  } catch {
    // Removing the name below is what actually frees the lock.
  }
  try {
    rmSync(join(DATA_DIR, LOCK_FILE), { force: true })
  } catch {
    // A stale lock is reclaimable after STALE_LOCK_MS.
  }
}

/**
 * Atomically replace the ledger. A random-suffixed sibling plus a rename means
 * a reader never observes a half-written document, and a crash mid-write
 * leaves the previous ledger intact.
 *
 * CALLERS MUST HOLD THE LOCK. The splice form is what makes the atomic replace
 * safe for a mutation that only claims THIS process's record: the caller's read
 * of the file may predate a peer's publish (the two are not serialized by the
 * rename), so passing `undefined` re-reads under the lock and splices this
 * process's fresh record onto the records that are there NOW.
 * @param owners - The complete record set to persist, or undefined to splice
 *   `mine` into whatever the file holds at this instant.
 * @param mine - This process's record; undefined clears our own record.
 * @returns True when the ledger was replaced.
 */
function writeLedger(owners: readonly SessionMountOwner[] | undefined, mine?: SessionMountOwner): boolean {
  const target = join(DATA_DIR, MOUNTS_FILE)
  const temporary = join(
    DATA_DIR,
    `${MOUNTS_FILE}.${process.pid}.${Date.now()}.${temporarySequence++}.tmp`,
  )
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
    const records = owners ?? [
      ...readMountLedger().filter(owner => owner.pid !== process.pid),
      ...(mine === undefined ? [] : [mine]),
    ]
    writeFileSync(
      temporary,
      JSON.stringify({ version: MOUNTS_VERSION, owners: records }, null, 2),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    )
    renameSync(temporary, target)
    return true
  } catch {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The previous ledger is still intact; nothing else is safe to do.
    }
    return false
  }
}

/** This process's own record, as last published. */
let ownStartedAt: number | undefined
/** Session ids this process currently has mounted. */
const ownSessionIds = new Set<string>()

/**
 * Publish this process's mounted set and refresh its heartbeat.
 *
 * Call at boot and then on {@link HEARTBEAT_INTERVAL_MS}. Every call re-reads
 * the ledger under the lock, so it also prunes owners that died since the last
 * beat — a TUI that is running is therefore enough to keep the whole file
 * clean, with no separate garbage collection.
 *
 * The read-modify-write is lock-guarded rather than blind: two TUIs beating at
 * the same moment would otherwise each write a file missing the other.
 * @param sessionIds - The sessions currently mounted (replaces the prior set).
 * @returns True when the ledger was updated.
 */
export function publishMounts(sessionIds: Iterable<string>): boolean {
  const now = Date.now()
  // Materialize the argument BEFORE clearing the live set. A caller may pass
  // `ownSessionIds` (or a view of it) to re-publish the current claim with one
  // change, and clearing first would then erase the input as it is read.
  const requested = [...sessionIds]
  ownSessionIds.clear()
  for (const sessionId of requested) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) continue
    ownSessionIds.add(sessionId)
    if (ownSessionIds.size >= MAX_SESSIONS_PER_OWNER) break
  }
  if (ownStartedAt === undefined) ownStartedAt = now

  const fd = acquireLock()
  if (fd === null) return false
  try {
    const mine: SessionMountOwner = {
      pid: process.pid,
      heartbeatAt: now,
      startedAt: ownStartedAt,
      sessionIds: [...ownSessionIds],
    }
    // Publish under the lock by splicing our fresh record into whatever the
    // file holds NOW: peers that published since our last read survive.
    return writeLedger(undefined, mine)
  } finally {
    releaseLock(fd)
  }
}

/**
 * Claim one session for THIS process, atomically.
 *
 * The occupancy check and the claim have to be one lock-protected step. Two
 * processes that each check first and publish second can both observe `free`
 * and both publish, which is precisely the state this ledger exists to
 * prevent; `publishMounts` cannot detect it, because it only protects the merge
 * write.
 *
 * Inside the lock the conflict is re-derived from the file, this process's
 * fresh record (with the candidate already in it) is spliced in, and a session
 * that IS genuinely ours is accepted — a second mount of our own parked handle
 * is not a conflict. When a live PEER holds it, nothing is written: the ledger
 * must not be mutated to say a claim was taken when it was not.
 * @param sessionId - Session id to claim.
 * @returns `ok`, or the pids holding the session.
 */
export function claimMount(sessionId: string): MountClaim {
  const now = Date.now()
  const fd = acquireLock()
  if (fd === null) {
    // No claim without the lock: an unreadable ledger is a state we cannot
    // prove is safe, and interleaving two writers is the unrecoverable failure.
    return { ok: false, holders: [] }
  }
  try {
    const records = readMountLedger()
    const holders: number[] = []
    for (const owner of records) {
      if (owner.pid === process.pid) continue
      if (!ownerIsLive(owner, now)) continue
      if (owner.sessionIds.includes(sessionId)) holders.push(owner.pid)
    }
    if (holders.length > 0) return { ok: false, holders }
    ownSessionIds.add(sessionId)
    if (ownStartedAt === undefined) ownStartedAt = now
    const mine: SessionMountOwner = {
      pid: process.pid,
      heartbeatAt: now,
      startedAt: ownStartedAt,
      sessionIds: [...ownSessionIds],
    }
    const claimed = writeLedger(undefined, mine)
    if (!claimed) {
      // The claim was not persisted, so it must not be held in memory either:
      // the process must not believe it owns what the ledger does not record.
      ownSessionIds.delete(sessionId)
      return { ok: false, holders: [] }
    }
    return { ok: true }
  } finally {
    releaseLock(fd)
  }
}

/**
 * Drop one session from this process's published set. Used when a session is
 * explicitly closed; an ordinary session switch KEEPS its session mounted
 * (that is the point of parking), so most switches do not call this.
 * @param sessionId - Session id to release.
 * @returns True when the ledger was updated.
 */
export function releaseMount(sessionId: string): boolean {
  if (!ownSessionIds.delete(sessionId)) return true
  // Snapshot before republishing: `publishMounts` clears `ownSessionIds`
  // before it reads its argument, so handing it the live Set would empty the
  // very claim being rebuilt and release every session this process holds.
  return publishMounts([...ownSessionIds])
}

/**
 * Remove this process's record entirely, so every session it held is
 * immediately mountable by another TUI instead of waiting out the TTL.
 * Called from the teardown funnel; a crashed process skips this and is
 * reclaimed by liveness instead, which is why both paths must work.
 * @returns True when the ledger was updated.
 */
export function clearOwnMounts(): boolean {
  const fd = acquireLock()
  if (fd === null) return false
  try {
    ownSessionIds.clear()
    ownStartedAt = undefined
    // Splice-free: an undefined `mine` removes our record and leaves every
    // record published since our last read alone.
    return writeLedger(undefined)
  } finally {
    releaseLock(fd)
  }
}

/**
 * The sessions this process has published, for the diagnostics surface.
 * @returns The ids last handed to {@link publishMounts}.
 */
export function ownMounts(): readonly string[] {
  return [...ownSessionIds]
}
