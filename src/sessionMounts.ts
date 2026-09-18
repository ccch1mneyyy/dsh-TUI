/**
 * Cross-process session mounting ledger, kept at
 * `~/.dsh-tui/session-mounts.json`.
 *
 * A TUI terminal hosts SEVERAL agent sessions at once (the attached one plus
 * every parked background session), and sessions are durable: another TUI, or
 * `dsh web`, can list the same logs. Nothing in the DSH session store says
 * *who is currently driving a log*, so two TUI processes resuming the same
 * session would interleave writes into one append-only event log and corrupt
 * the transcript. This file is that missing fact: each TUI process publishes
 * the set of sessions it has mounted, and a reader that sees a foreign entry
 * treats the session as OCCUPIED and refuses to mount it.
 *
 * Liveness is one witness, `process.kill(pid, 0)`: it catches a clean exit and
 * a `kill -9`. There is no heartbeat timestamp, because a timestamp only stays
 * truthful while a timer keeps refreshing it, and the process that cannot
 * refresh it is exactly the one whose record should expire. The cost is pid
 * REUSE — a recycled pid keeps a dead owner's record alive — which errs toward
 * refusing a session that is in fact free and costs one restart; the opposite
 * error interleaves two writers into one transcript. This is a same-machine
 * guard only: the host's own session write lock stays the authority that
 * actually separates writers.
 *
 * Reads never write. Pruning a dead owner happens on the write path, because a
 * reader that wrote its snapshot back could erase a peer's record published
 * between its read and its replace — silently dropping a live session from the
 * occupancy table while its process kept writing.
 *
 * Writes take a short cross-process lock, re-read the file under it, and replace
 * it atomically. The lock is token-checked, so a holder whose lock was reclaimed
 * as stale cannot write over — or delete — the new holder's lock. A CLAIM
 * re-derives its conflict under that lock ({@link claimMount}), because
 * "check, then publish" is not atomic across processes. Every operation is
 * best-effort: an unwritable home degrades to "no cross-process protection"
 * rather than taking down the session.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

const MOUNTS_FILE = 'session-mounts.json'
const LOCK_FILE = 'session-mounts.lock'

/** Schema version of the persisted document. */
const MOUNTS_VERSION = 1

/** Reclaim a lock left behind by a crashed writer after this long. */
const STALE_LOCK_MS = 30_000

let temporarySequence = 0

type ErrnoLike = { code?: unknown }

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as ErrnoLike).code === code
}

/** One process's published claim: the sessions it currently has mounted. */
export interface SessionMountOwner {
  /** Operating-system process id of the TUI holding these sessions. */
  readonly pid: number
  /** Epoch ms when this process first published a record (diagnostics). */
  readonly startedAt: number
  /** Session ids this process has mounted, in no significant order. */
  readonly sessionIds: readonly string[]
}

/** Whether a published record was written by THIS process. */
export function ownerIsSelf(owner: SessionMountOwner): boolean {
  return owner.pid === process.pid
}

/** Why a session cannot be mounted by this process. */
export type SessionOccupancy =
  | { readonly kind: 'free' }
  | { readonly kind: 'mine' }
  | { readonly kind: 'occupied'; readonly pid: number }

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

/** Parse one record, or undefined when the shape is wrong. */
function parseOwner(value: unknown): SessionMountOwner | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { pid, startedAt, sessionIds } = value as Record<string, unknown>
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined
  if (!Array.isArray(sessionIds)) return undefined
  return {
    pid,
    startedAt,
    sessionIds: sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0),
  }
}

/**
 * Read the ledger, keeping every record the shape check accepts. A missing,
 * empty, truncated or foreign-shaped document reads as an empty ledger: the
 * next write replaces the file wholesale, so there is nothing to repair and
 * nothing to report.
 */
export function readMountLedger(): readonly SessionMountOwner[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(DATA_DIR, MOUNTS_FILE), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return []
    const document = parsed as Record<string, unknown>
    if (document.version !== MOUNTS_VERSION || !Array.isArray(document.owners)) return []
    return document.owners
      .map(parseOwner)
      .filter((owner): owner is SessionMountOwner => owner !== undefined)
  } catch {
    return []
  }
}

/**
 * Which process has each session mounted, considering only owners whose pid is
 * still alive. A session claimed by several live owners keeps the record that
 * started last: the protocol forbids that state, and picking one
 * deterministically beats reporting whichever the file happened to list first.
 */
export function readSessionOwners(): ReadonlyMap<string, SessionMountOwner> {
  const owners = new Map<string, SessionMountOwner>()
  for (const owner of readMountLedger()) {
    if (!pidAlive(owner.pid)) continue
    for (const sessionId of owner.sessionIds) {
      const existing = owners.get(sessionId)
      if (existing === undefined || existing.startedAt < owner.startedAt) owners.set(sessionId, owner)
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
  if (ownerIsSelf(owner)) return { kind: 'mine' }
  return { kind: 'occupied', pid: owner.pid }
}

/**
 * A held lock: the file descriptor, the path, and the unique token written into
 * the lock file.
 *
 * The token is what makes a reclaimed lock safe. A writer that pauses longer
 * than {@link STALE_LOCK_MS} has its lock removed by a peer, and if it then
 * wrote or released blindly it would clobber the peer's work — including
 * deleting the PEER's lock on the way out. So every holder re-reads the file it
 * is about to replace and abandons the mutation when the token is not its own.
 */
interface HeldLock {
  readonly fd: number
  readonly path: string
  readonly token: string
}

/** Take the short cross-process lock, or null when another writer holds it. */
function acquireLock(): HeldLock | null {
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
    const token = `${process.pid}-${randomBytes(6).toString('hex')}`
    try {
      // `writeSync` on the descriptor (not `writeFileSync`) so the token lands
      // in the file this fd owns, and flush before anyone can read it.
      writeSync(fd, `${token}\n`)
      return { fd, path: lockPath, token }
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

/**
 * Whether this holder's lock is still the one on disk. False means the lock was
 * reclaimed as stale (or replaced), so the holder must NOT write and must NOT
 * delete the file — it belongs to somebody else now.
 */
function lockIsHeld(lock: HeldLock): boolean {
  try {
    const fd = openSync(lock.path, 'r')
    try {
      const buffer = Buffer.alloc(256)
      const read = readSync(fd, buffer, 0, buffer.length, 0)
      return buffer.subarray(0, read).toString('utf8').trim() === lock.token
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

/** Release the lock taken by {@link acquireLock}, if it is still ours. */
function releaseLock(lock: HeldLock): void {
  try {
    closeSync(lock.fd)
  } catch {
    // Removing the name below is what actually frees the lock.
  }
  if (!lockIsHeld(lock)) return
  try {
    rmSync(lock.path, { force: true })
  } catch {
    // A stale lock is reclaimable after STALE_LOCK_MS.
  }
}

/**
 * Atomically replace the ledger with the live foreign records plus `mine`.
 *
 * A random-suffixed sibling plus a rename means a reader never observes a
 * half-written document, and a crash mid-write leaves the previous ledger
 * intact. CALLERS MUST HOLD THE LOCK: the replacement is rebuilt from a read
 * taken while holding it, so a peer that published since the caller's last read
 * survives, and dead owners are dropped here — the write path is the only place
 * that prunes.
 * @param mine - This process's record; undefined clears our own record.
 * @returns True when the ledger was replaced.
 */function writeLedger(mine: SessionMountOwner | undefined): boolean {
  const target = join(DATA_DIR, MOUNTS_FILE)
  const temporary = `${target}.${process.pid}.${temporarySequence++}.tmp`
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
    const records = readMountLedger().filter(owner => !ownerIsSelf(owner) && pidAlive(owner.pid))
    if (mine !== undefined) records.push(mine)
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

/** This process's record, or undefined before the first publish. */
function ownRecord(): SessionMountOwner {
  return { pid: process.pid, startedAt: ownStartedAt ?? Date.now(), sessionIds: [...ownSessionIds] }
}

/**
 * Publish this process's mounted set. Call at boot, whenever the set changes,
 * and just before teardown, so a peer always reads a current answer without a
 * timer keeping it fresh.
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
    if (typeof sessionId === 'string' && sessionId.length > 0) ownSessionIds.add(sessionId)
  }
  if (ownStartedAt === undefined) ownStartedAt = now
  const lock = acquireLock()
  if (lock === null) return false
  try {
    // A lock reclaimed as stale belongs to somebody else now: this process's
    // snapshot is older than theirs, so it must not be committed over it.
    if (!lockIsHeld(lock)) return false
    return writeLedger(ownRecord())
  } finally {
    releaseLock(lock)
  }
}

/**
 * Claim one session for THIS process, atomically.
 *
 * The occupancy check and the claim have to be one lock-protected step: two
 * processes that each check first and publish second can both observe `free`
 * and both publish, which is exactly the state this ledger exists to prevent.
 * Inside the lock the conflict is re-derived from the file, and a session that
 * is genuinely ours is accepted — a second mount of our own parked handle is
 * not a conflict. When a live PEER holds it, nothing is written.
 * @param sessionId - Session id to claim.
 * @returns `ok`, or the pids holding the session.
 */
export function claimMount(sessionId: string): MountClaim {
  const lock = acquireLock()
  if (lock === null) {
    // No claim without the lock: an unreadable ledger is a state we cannot
    // prove is safe, and interleaving two writers is the unrecoverable failure.
    return { ok: false, holders: [] }
  }
  try {
    // Lost the lock (reclaimed as stale): the file on disk is no longer the one
    // this claim was derived from, so refuse rather than write a stale merge.
    if (!lockIsHeld(lock)) return { ok: false, holders: [] }
    const holders: number[] = []
    for (const owner of readMountLedger()) {
      if (ownerIsSelf(owner) || !pidAlive(owner.pid)) continue
      if (owner.sessionIds.includes(sessionId)) holders.push(owner.pid)
    }
    if (holders.length > 0) return { ok: false, holders }
    ownSessionIds.add(sessionId)
    if (ownStartedAt === undefined) ownStartedAt = Date.now()
    if (!writeLedger(ownRecord())) {
      // The claim was not persisted, so it must not be held in memory either:
      // the process must not believe it owns what the ledger does not record.
      ownSessionIds.delete(sessionId)
      return { ok: false, holders: [] }
    }
    return { ok: true }
  } finally {
    releaseLock(lock)
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
  // Snapshot before republishing: `publishMounts` clears `ownSessionIds` before
  // it reads its argument, so handing it the live Set would empty the very
  // claim being rebuilt and release every session this process holds.
  return publishMounts([...ownSessionIds])
}

/**
 * Remove this process's record entirely, so every session it held is
 * immediately mountable by another TUI. Called from the teardown funnel; a
 * crashed process skips this and its record is pruned by the next write
 * instead, which is why both paths must work.
 * @returns True when the ledger was updated.
 */
export function clearOwnMounts(): boolean {
  const lock = acquireLock()
  if (lock === null) return false
  try {
    if (!lockIsHeld(lock)) return false
    ownSessionIds.clear()
    ownStartedAt = undefined
    return writeLedger(undefined)
  } finally {
    releaseLock(lock)
  }
}

/**
 * The sessions this process has published, for the diagnostics surface.
 * @returns The ids last handed to {@link publishMounts}.
 */
export function ownMounts(): readonly string[] {
  return [...ownSessionIds]
}
