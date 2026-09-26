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
 * Liveness is two witnesses in sequence. The first is `process.kill(pid, 0)`:
 * it catches a clean exit and a `kill -9`. There is no heartbeat timestamp,
 * because a timestamp only stays truthful while a timer keeps refreshing it,
 * and the process that cannot refresh it is exactly the one whose record
 * should expire. The second witness closes the hole the first one cannot —
 * pid REUSE, where the OS hands a dead owner's pid to an unrelated process
 * (a game client, a browser) whose lifetime then keeps the record "alive"
 * forever: a live pid is only believed when its process was created no later
 * than the record it allegedly published ({@link processCreationTime}), since
 * the publisher was alive when it wrote the record and only an impostor can
 * have been created after that moment. Both witnesses err toward refusing a
 * session that is in fact free; the opposite error interleaves two writers
 * into one transcript. This is a same-machine guard only: the host's own
 * session write lock stays the authority that actually separates writers.
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
 * "check, then publish" is not atomic across processes.
 *
 * "I could not read the ledger" is NOT "nobody holds the session". Granting a
 * write handle on a damaged or unreadable ledger is exactly the failure this
 * module exists to prevent, and it is unrecoverable, so the authoritative
 * paths refuse instead of degrading ({@link readMountLedgerStrict},
 * {@link MountFailure}). Only the display surface reads best-effort.
 *
 * The lock is reclaimable only from a holder that is provably gone: its token
 * carries the holder pid, so a lock whose holder is still ALIVE — and whose
 * process could actually have taken the lock — is never stolen from, not even
 * by a peer that finds the file old. That closes the window where a paused
 * holder resumed after its lock had been reclaimed and committed a snapshot
 * derived before the steal. A live pid that was created AFTER the lock was
 * taken is a recycled pid standing in for a dead holder, and its lock is
 * reclaimed like any other crash leftover — no manual deletion of
 * `session-mounts.lock` is ever needed.
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
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

const MOUNTS_FILE = 'session-mounts.json'
const LOCK_FILE = 'session-mounts.lock'

/** Schema version of the persisted document. */
const MOUNTS_VERSION = 1

/**
 * How old a lock with no readable holder pid must be before it counts as a
 * crash leftover. A lock whose token names a pid is judged by THAT witness
 * instead (see {@link acquireLock}); this grace window only covers the sliver
 * between creating the file and writing the token into it.
 */
const STALE_LOCK_MS = 30_000

/**
 * How much wall-clock distance between a live pid's creation and the record it
 * allegedly published still counts as the same process. A genuine publisher
 * was created BEFORE it published, so the margin only has to absorb a backward
 * clock step (an NTP correction) inside that sub-minute window; an impostor's
 * creation time lands minutes, hours or whole boots later.
 */
const RECYCLE_SLACK_MS = 60_000

/**
 * How long a queried creation time stays trusted. The creation time of a
 * process never changes while it lives, so the cache hedges exactly one case:
 * a pid that dies and is RECYCLED inside the window keeps serving the old
 * process's answer. That misreads an impostor as the original — today's
 * behavior, the safe direction — and the refetch after the window heals it.
 */
const CREATION_CACHE_MS = 600_000

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
 * Why a claim did not succeed.
 *
 * The three cases are kept apart because the caller has to answer them
 * differently: `occupied` names a terminal the user can go close, `busy`
 * names a transient collision worth retrying, and `unavailable` means the
 * occupancy question could not be answered at all. Folding them together is
 * how "we did not manage to check" turns into "there was nothing to check".
 */
export type MountFailure =
  | { readonly ok: false; readonly reason: 'occupied'; readonly holders: readonly number[] }
  | { readonly ok: false; readonly reason: 'busy' }
  | { readonly ok: false; readonly reason: 'unavailable'; readonly detail: string }

/**
 * Outcome of {@link claimMount}: either this process now owns the session, or
 * a {@link MountFailure} says why it does not.
 *
 * `fresh` says whether the claim is what PUT the session in this process's
 * published set. Claiming a session this process already holds is legal and
 * common (a parked handle, a re-resume, a claim a publisher beat has already
 * mirrored), and the difference matters on the way out: a caller may only give
 * back what it took. Releasing an inherited claim would hand a session this
 * process is still driving to the next peer that asks.
 */
export type MountClaim = { readonly ok: true; readonly fresh: boolean } | MountFailure

/**
 * Whether a process id is still alive. `process.kill(pid, 0)` sends no signal
 * and throws `ESRCH` when the process is gone; `EPERM` means it exists but is
 * owned by another user, which still counts as alive here.
 *
 * This is the CHEAP witness and it cannot stand alone: a pid the OS recycled
 * to an unrelated process answers "alive" for a record its original owner left
 * behind. {@link ownerIsLive} adds the identity witness on top of it.
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

/** Per-pid creation times, as last answered by {@link processCreationTime}. */
const creationTimes = new Map<number, { readonly value: number | undefined; readonly expiresAt: number }>()

/**
 * When a process started, as epoch ms — the identity witness behind
 * {@link ownerIsLive}. A pid alone cannot tell the process that published a
 * record from a later process the OS handed the same number to; the creation
 * time can, and it is stable for the pid's whole lifetime.
 *
 * `undefined` means "the platform could not say" — an unsupported platform, a
 * query that failed, or a pid that no longer exists. Callers treat it as "let
 * the cheap pid witness decide", never as "dead": a mistaken prune is the one
 * unrecoverable direction.
 */
export function processCreationTime(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const cached = creationTimes.get(pid)
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value
  const value = queryCreationTime(pid)
  creationTimes.set(pid, { value, expiresAt: Date.now() + CREATION_CACHE_MS })
  return value
}

/** Fill the cache for every pid whose entry is missing or stale. */
function warmCreationTimes(pids: readonly number[]): void {
  const missing: number[] = []
  for (const pid of new Set(pids)) {
    const cached = creationTimes.get(pid)
    if (cached === undefined || cached.expiresAt <= Date.now()) missing.push(pid)
  }
  if (missing.length === 0) return
  if (process.platform === 'win32') {
    // One subprocess for the whole batch: a query costs a process spawn on
    // this platform, and the callers run it on the UI's clock.
    const answers = queryCreationTimesWindows(missing)
    for (const pid of missing) {
      creationTimes.set(pid, { value: answers.get(pid), expiresAt: Date.now() + CREATION_CACHE_MS })
    }
    return
  }
  for (const pid of missing) {
    creationTimes.set(pid, { value: queryCreationTime(pid), expiresAt: Date.now() + CREATION_CACHE_MS })
  }
}

/**
 * Batch-fill the cache for every foreign owner the ledger names, BEFORE a
 * decision path needs the verdicts — a platform query must never run while
 * the cross-process lock is held, where it would stall every peer.
 */
function warmForeignCreationTimes(): void {
  const pids: number[] = []
  for (const owner of readMountLedger()) {
    if (ownerIsSelf(owner) || !pidAlive(owner.pid)) continue
    pids.push(owner.pid)
  }
  if (pids.length > 0) warmCreationTimes(pids)
}

/** Platform dispatch for {@link processCreationTime}. */
function queryCreationTime(pid: number): number | undefined {
  if (process.platform === 'win32') return queryCreationTimesWindows([pid]).get(pid)
  if (process.platform === 'linux') return queryCreationTimeLinux(pid)
  if (process.platform === 'darwin') return queryCreationTimeDarwin(pid)
  return undefined
}

/** Linux clock tick rate, derived once, in ticks per second. */
let linuxClockTicksPerSecond: number | undefined

/**
 * Linux: `/proc/<pid>/stat` records the start time in clock ticks since boot,
 * and the tick rate is whatever the kernel was built with — not exposed to
 * Node, so derive it once from pid 1, which started a few ticks after the
 * counter did: its starttime over `/proc/uptime` seconds is the rate, exact to
 * about one part per million once the machine has been up a minute.
 */
function linuxClockTicks(): number | undefined {
  if (linuxClockTicksPerSecond !== undefined) return linuxClockTicksPerSecond
  try {
    const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0])
    const stat = readFileSync('/proc/1/stat', 'utf8')
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19])
    if (Number.isFinite(uptime) && uptime >= 60 && Number.isFinite(ticks) && ticks > 0) {
      linuxClockTicksPerSecond = Math.round(ticks / uptime)
    }
  } catch {
    return undefined
  }
  return linuxClockTicksPerSecond
}

/**
 * Linux: two file reads, no subprocess — field 22 of `/proc/<pid>/stat` (start
 * time in ticks since boot) plus the boot epoch from `/proc/stat`.
 */
function queryCreationTimeLinux(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // Field 2 (comm) may contain spaces and parentheses, so everything after
    // the LAST ')' is fixed-position: fields[0] is state (field 3), which
    // puts starttime (field 22) at index 19.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ticks = Number(fields[19])
    const boot = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))
    const ticksPerSecond = linuxClockTicks()
    if (!Number.isFinite(ticks) || boot === null || ticksPerSecond === undefined) return undefined
    return Number(boot[1]) * 1000 + (ticks * 1000) / ticksPerSecond
  } catch {
    return undefined
  }
}

/**
 * Windows has no /proc and Node exposes no peer creation time, so the witness
 * costs one subprocess for the whole batch. `wmic` answers in ~150ms and ships
 * on the Windows builds this TUI targets; builds that have removed it fall
 * back to PowerShell, which is slower but always there.
 */
function queryCreationTimesWindows(pids: readonly number[]): ReadonlyMap<number, number> {
  const answers = queryCreationTimesWmic(pids)
  if (answers !== undefined) return answers
  // Neither tool answered: an empty map, so every pid reads as "unknown" and
  // the verdict falls back to the cheap pid witness.
  return queryCreationTimesPowerShell(pids) ?? new Map()
}

/**
 * One `wmic` call for every pid, `/value` output so the parse survives locale
 * and column-order changes: blocks of `CreationDate=<dmtf>` / `ProcessId=<pid>`
 * lines, and a pid that does not exist is simply absent. Absence is not an
 * error — a process that exited between the pid check and this query just has
 * no answer.
 */
function queryCreationTimesWmic(pids: readonly number[]): Map<number, number> | undefined {
  const where = pids.map(pid => `ProcessId=${pid}`).join(' or ')
  const attempt = spawnSync(
    'wmic',
    ['process', 'where', `(${where})`, 'get', 'ProcessId,CreationDate', '/value'],
    { encoding: 'utf8', timeout: 10_000, windowsHide: true },
  )
  if (attempt.error !== undefined || typeof attempt.stdout !== 'string') return undefined
  const answers = new Map<number, number>()
  let creation: number | undefined
  let pid: number | undefined
  for (const line of attempt.stdout.split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator < 0) continue
    const key = line.slice(0, separator)
    const value = line.slice(separator + 1).trim()
    if (key === 'CreationDate') creation = parseDmtfDateTime(value)
    else if (key === 'ProcessId') pid = Number(value)
    if (creation !== undefined && pid !== undefined && Number.isInteger(pid) && pid > 0) {
      answers.set(pid, creation)
      creation = undefined
      pid = undefined
    }
  }
  return answers
}

/**
 * The PowerShell fallback, same shape: one call, one line per found process as
 * `<pid>,<UTC ISO>`. The exit status is ignored on purpose — silenced
 * not-found pids still set it.
 */
function queryCreationTimesPowerShell(pids: readonly number[]): Map<number, number> | undefined {
  const script =
    `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ` +
    `ForEach-Object { $_.Id.ToString() + ',' + $_.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }`
  const attempt = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 20_000, windowsHide: true },
  )
  if (attempt.error !== undefined || typeof attempt.stdout !== 'string') return undefined
  const answers = new Map<number, number>()
  for (const line of attempt.stdout.split(/\r?\n/)) {
    const match = /^(\d+),(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.exec(line.trim())
    if (match === null) continue
    const epoch = Date.parse(match[2])
    if (Number.isFinite(epoch)) answers.set(Number(match[1]), epoch)
  }
  return answers
}

/**
 * WMI's DMTF datetime (`20260925175443.522797+480`): local wall clock with an
 * explicit UTC offset captured by the kernel, so the instant is exact across
 * DST and zone changes — the offset that shipped WITH the string is the one
 * to subtract.
 */
function parseDmtfDateTime(value: string): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?([+-])(\d{3})$/.exec(value)
  if (match === null) return undefined
  const [, year, month, day, hour, minute, second, fraction, sign, offset] = match
  const milliseconds = fraction === undefined ? 0 : Number(`${fraction}00`.slice(0, 3))
  const offsetMinutes = Number(offset) * (sign === '-' ? -1 : 1)
  const epoch =
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), milliseconds) -
    offsetMinutes * 60_000
  return Number.isFinite(epoch) ? epoch : undefined
}

/**
 * macOS: `ps -o lstart=` prints the creation time in wall clock (C locale,
 * e.g. `Wed Sep 24 17:54:43 2026`). Second resolution is what the slack is for.
 */
function queryCreationTimeDarwin(pid: number): number | undefined {
  const attempt = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5_000 })
  if (attempt.error !== undefined || typeof attempt.stdout !== 'string') return undefined
  const match = /^([A-Za-z]{3}) ([A-Za-z]{3})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(attempt.stdout.trim())
  if (match === null) return undefined
  const month = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }[
    match[2]
  ]
  if (month === undefined) return undefined
  return new Date(
    Number(match[7]), month, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]),
  ).getTime()
}

/**
 * Whether a published record still names the process that wrote it.
 *
 * The pid witness is necessary but not sufficient: a live pid created AFTER
 * the moment it allegedly published (`startedAt`) is an impostor the OS gave
 * a dead owner's number to, and its record counts as dead. A live pid created
 * before `startedAt` — within the slack, so a clock step cannot prune a live
 * peer — is the publisher; an unreadable creation time falls back to the
 * cheap witness's answer, which errs toward "occupied".
 */
function ownerIsLive(owner: SessionMountOwner): boolean {
  if (ownerIsSelf(owner)) return true
  if (!pidAlive(owner.pid)) return false
  const created = processCreationTime(owner.pid)
  if (created === undefined) return true
  return created <= owner.startedAt + RECYCLE_SLACK_MS
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
 * Read the ledger for DISPLAY, keeping every record the shape check accepts.
 * A missing, empty, truncated or foreign-shaped document reads as an empty
 * ledger, because a screen that cannot read the occupancy table should still
 * paint the sessions it does know about.
 *
 * Never use this to decide whether a session may be mounted: "the read failed"
 * and "nobody holds it" are the same answer here. Authoritative callers use
 * {@link readMountLedgerStrict}.
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
 * Outcome of the authoritative read. `unavailable` carries a sentence naming
 * what was wrong, so a refusal can say "cannot verify occupancy" instead of
 * inventing a holder.
 */
export type MountLedgerRead =
  | { readonly ok: true; readonly owners: readonly SessionMountOwner[] }
  | { readonly ok: false; readonly detail: string }

/**
 * Read the ledger for DECIDING, where "I could not read it" must not pass for
 * "it is empty".
 *
 * Only a missing file is an empty ledger — that is the genuine first run.
 * Everything else (unreadable, malformed JSON, unknown version, a record whose
 * shape does not parse) is `unavailable`, and the caller must refuse. Skipping
 * a bad record and writing the ledger anyway is not an option either: the
 * record that failed to parse may be another writer's only claim, so the safe
 * move is to leave the file exactly as it is and ask the user to repair it.
 */
export function readMountLedgerStrict(): MountLedgerRead {
  const path = join(DATA_DIR, MOUNTS_FILE)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { ok: true, owners: [] }
    return { ok: false, detail: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, detail: `${path} is not valid JSON` }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, detail: `${path} is not a ledger document` }
  }
  const document = parsed as Record<string, unknown>
  if (document.version !== MOUNTS_VERSION) {
    return { ok: false, detail: `${path} has unknown version ${JSON.stringify(document.version)}` }
  }
  if (!Array.isArray(document.owners)) {
    return { ok: false, detail: `${path} has no owners array` }
  }
  const owners: SessionMountOwner[] = []
  for (const record of document.owners) {
    const owner = parseOwner(record)
    if (owner === undefined) return { ok: false, detail: `${path} has a record whose shape is wrong` }
    owners.push(owner)
  }
  return { ok: true, owners }
}

/**
 * Which process has each session mounted, considering only owners that are
 * still the processes which published them — the pid is alive AND was created
 * no later than its own record ({@link ownerIsLive}). A session claimed by
 * several live owners keeps the record that started last: the protocol forbids
 * that state, and picking one deterministically beats reporting whichever the
 * file happened to list first.
 */
export function readSessionOwners(): ReadonlyMap<string, SessionMountOwner> {
  const ledger = readMountLedger()
  // Warm the identity cache while nothing is decided yet, so the platform
  // query never lands inside a caller's lock or render tick.
  warmCreationTimes(
    ledger.filter(owner => !ownerIsSelf(owner) && pidAlive(owner.pid)).map(owner => owner.pid),
  )
  const owners = new Map<string, SessionMountOwner>()
  for (const owner of ledger) {
    if (!ownerIsLive(owner)) continue
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
 * The token is `<pid>-<nonce>`, and that is what makes a reclaimed lock safe on
 * two counts. The pid half means a peer only ever reclaims a lock whose holder
 * is GONE, so a live writer that happens to be paused is never robbed of its
 * turn; the nonce half means that if a lock does change hands, the old holder
 * re-reads the file before every mutation and abandons it when the token is no
 * longer its own — including declining to delete the PEER's lock on the way out.
 */
interface HeldLock {
  readonly fd: number
  readonly path: string
  readonly token: string
}

/** Outcome of {@link acquireLock}: a held lock, or why it was not taken. */
type LockAttempt =
  | { readonly ok: true; readonly lock: HeldLock }
  | { readonly ok: false; readonly reason: 'busy' }
  | { readonly ok: false; readonly reason: 'unavailable'; readonly detail: string }

/** The pid recorded at the head of a lock token, or undefined when unreadable. */
function readLockHolderPid(lockPath: string): number | undefined {
  let fd: number
  try {
    fd = openSync(lockPath, 'r')
  } catch {
    return undefined
  }
  try {
    const buffer = Buffer.alloc(64)
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    const token = buffer.subarray(0, read).toString('utf8').trim()
    const separator = token.indexOf('-')
    const pid = Number(separator < 0 ? token : token.slice(0, separator))
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  } finally {
    try {
      closeSync(fd)
    } catch {
      // Losing the descriptor is not a reason to report a different verdict.
    }
  }
}

/**
 * Whether an existing lock may be removed, and the peer that left it is not
 * coming back.
 *
 * A readable holder pid is the primary verdict: dead holder, reclaim. A live
 * holder is left alone — unless its process was created AFTER the lock was
 * taken, which no genuine holder can have been (a holder acquires the lock
 * while running), so a live pid created that late is a recycled number
 * standing in for a dead holder and the lock reclaims like any crash leftover.
 * Only a lock whose token could not be read (the window between `open` and
 * `write`, or a crash inside it) falls back to age.
 */
function lockIsReclaimable(lockPath: string): boolean {
  const holderPid = readLockHolderPid(lockPath)
  if (holderPid !== undefined) {
    if (!pidAlive(holderPid)) return true
    const created = processCreationTime(holderPid)
    if (created === undefined) return false
    let takenAt: number
    try {
      takenAt = statSync(lockPath).mtimeMs
    } catch {
      return false
    }
    return created > takenAt + RECYCLE_SLACK_MS
  }
  try {
    return Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS
  } catch {
    return false
  }
}

/** Take the short cross-process lock, or report why another writer kept it. */
function acquireLock(): LockAttempt {
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  } catch (error) {
    return {
      ok: false,
      reason: 'unavailable',
      detail: `cannot create ${DATA_DIR}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const lockPath = join(DATA_DIR, LOCK_FILE)
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number
    try {
      fd = openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) {
        return {
          ok: false,
          reason: 'unavailable',
          detail: `cannot create ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      if (attempt > 0) return { ok: false, reason: 'busy' }
      try {
        if (!lockIsReclaimable(lockPath)) return { ok: false, reason: 'busy' }
        rmSync(lockPath, { force: true })
      } catch {
        // Racing a peer that just released (or re-took) the lock is ordinary.
        return { ok: false, reason: 'busy' }
      }
      continue
    }
    const token = `${process.pid}-${randomBytes(6).toString('hex')}`
    try {
      // `writeSync` on the descriptor (not `writeFileSync`) so the token lands
      // in the file this fd owns, and flush before anyone can read it.
      writeSync(fd, `${token}\n`)
      return { ok: true, lock: { fd, path: lockPath, token } }
    } catch (error) {
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
      return {
        ok: false,
        reason: 'unavailable',
        detail: `cannot write ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  return { ok: false, reason: 'busy' }
}

/**
 * Whether this holder's lock is still the one on disk. False means the lock was
 * reclaimed (or replaced), so the holder must NOT write and must NOT delete the
 * file — it belongs to somebody else now.
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
    // A stale lock is reclaimable on the next mutation.
  }
}

/**
 * Atomically replace the ledger with the live foreign records plus `mine`.
 *
 * A random-suffixed sibling plus a rename means a reader never observes a
 * half-written document, and a crash mid-write leaves the previous ledger
 * intact. CALLERS MUST HOLD THE LOCK: the replacement is rebuilt from a read
 * taken while holding it, so a peer that published since the caller's last read
 * survives, and dead or recycled-pid owners are dropped here — the write path
 * is the only place that prunes.
 *
 * The read is the STRICT one. Rebuilding from a best-effort read would let a
 * damaged ledger be "repaired" into whatever this process happened to parse,
 * silently dropping the claims that failed to parse — including a peer's only
 * declaration. A ledger that cannot be read is left exactly as it is.
 * @param mine - This process's record; undefined clears our own record.
 * @returns Whether the ledger was replaced, and why not when it was not.
 */
function writeLedger(mine: SessionMountOwner | undefined): { ok: true } | MountFailure {
  const target = join(DATA_DIR, MOUNTS_FILE)
  // The timestamp is part of the name, not decoration: a crash can leave a
  // temp file behind, and a reused pid would then collide with `<pid>.<seq>`
  // and fail the `wx` create.
  const temporary = `${target}.${process.pid}.${Date.now()}.${temporarySequence++}.tmp`
  const existing = readMountLedgerStrict()
  if (!existing.ok) return { ok: false, reason: 'unavailable', detail: existing.detail }
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
    const records = existing.owners.filter(owner => !ownerIsSelf(owner) && ownerIsLive(owner))
    if (mine !== undefined) records.push(mine)
    writeFileSync(
      temporary,
      JSON.stringify({ version: MOUNTS_VERSION, owners: records }, null, 2),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    )
    renameSync(temporary, target)
    return { ok: true }
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The previous ledger is still intact; nothing else is safe to do.
    }
    return {
      ok: false,
      reason: 'unavailable',
      detail: `cannot replace ${target}: ${error instanceof Error ? error.message : String(error)}`,
    }
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
 * Sessions with an in-flight mount operation, keyed to the operations holding
 * them. A claim is committed to the ledger BEFORE the agent it stands for
 * exists in the registry (a resume reads preset, route and workspace first),
 * so for that window the claim has no roster entry backing it — and a publisher
 * beat that rebuilt the published set from the roster alone would erase it,
 * handing the session to whatever peer asks next.
 */
const mountOperations = new Map<string, Set<symbol>>()

/**
 * Pin `sessionId` for the duration of one mount operation, so a concurrent
 * {@link publishMounts} beat cannot drop its claim, and so the session counts
 * as held until the caller has finished closing whatever it opened.
 *
 * The token identifies THIS operation only: it keeps a stale operation's
 * cleanup from deleting a newer operation's pin. It is not a cross-process
 * fencing token and does not replace the ledger. Every caller gets one through
 * {@link reserveMount} or {@link reserveNewSession}.
 * @param sessionId - Session the operation is about to mount.
 * @returns An idempotent release for the pin.
 */
function holdMountOperation(sessionId: string): () => void {
  const token = Symbol('session-mount-operation')
  let tokens = mountOperations.get(sessionId)
  if (tokens === undefined) {
    tokens = new Set()
    mountOperations.set(sessionId, tokens)
  }
  tokens.add(token)
  let released = false
  return () => {
    if (released) return
    released = true
    const current = mountOperations.get(sessionId)
    if (current === undefined) return
    current.delete(token)
    if (current.size === 0) mountOperations.delete(sessionId)
  }
}

/**
 * Publish this process's mounted set. Call at boot, whenever the set changes,
 * and just before teardown, so a peer always reads a current answer without a
 * timer keeping it fresh.
 *
 * The argument is the set the caller can OBSERVE (the live agent roster). Any
 * session with an in-flight operation is added on top, because a claim is
 * published before its agent exists: without that union a beat landing inside
 * a resume would delete the reservation this process just committed.
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
  for (const sessionId of mountOperations.keys()) ownSessionIds.add(sessionId)
  if (ownStartedAt === undefined) ownStartedAt = now
  // The write below prunes foreign records with the identity witness; resolve
  // it before the lock so peers never wait on a platform query.
  warmForeignCreationTimes()
  const attempt = acquireLock()
  if (!attempt.ok) return false
  const lock = attempt.lock
  try {
    // A lock reclaimed by a peer belongs to somebody else now: this process's
    // snapshot is older than theirs, so it must not be committed over it.
    if (!lockIsHeld(lock)) return false
    return writeLedger(ownRecord()).ok
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
 *
 * A refusal that cannot name a peer is reported as `busy` (the lock was taken)
 * or `unavailable` (the ledger could not be read or replaced) — never as an
 * empty holder list, because callers have to be able to tell "somebody else
 * has it" from "we could not find out".
 * @param sessionId - Session id to claim.
 * @returns `ok`, or why the session is not ours.
 */
export function claimMount(sessionId: string): MountClaim {
  // Resolve the identity witnesses BEFORE the lock: a platform query inside
  // the lock would stall every peer for its duration.
  warmForeignCreationTimes()
  const attempt = acquireLock()
  if (!attempt.ok) {
    return attempt.reason === 'busy'
      ? { ok: false, reason: 'busy' }
      : { ok: false, reason: 'unavailable', detail: attempt.detail }
  }
  const lock = attempt.lock
  try {
    // Lost the lock (reclaimed by a peer): the file on disk is no longer the one
    // this claim was derived from, so refuse rather than write a stale merge.
    if (!lockIsHeld(lock)) return { ok: false, reason: 'busy' }
    const read = readMountLedgerStrict()
    if (!read.ok) return { ok: false, reason: 'unavailable', detail: read.detail }
    const holders: number[] = []
    for (const owner of read.owners) {
      if (ownerIsSelf(owner) || !ownerIsLive(owner)) continue
      if (owner.sessionIds.includes(sessionId)) holders.push(owner.pid)
    }
    if (holders.length > 0) return { ok: false, reason: 'occupied', holders }
    // Whether THIS claim is what publishes the session: a session already in
    // our set may have been put there by a parked handle or a publisher beat,
    // and a caller that later gives its reservation back must not take it away.
    const fresh = !ownSessionIds.has(sessionId)
    ownSessionIds.add(sessionId)
    if (ownStartedAt === undefined) ownStartedAt = Date.now()
    const written = writeLedger(ownRecord())
    if (!written.ok) {
      // The claim was not persisted, so it must not be held in memory either:
      // the process must not believe it owns what the ledger does not record.
      ownSessionIds.delete(sessionId)
      return written
    }
    return { ok: true, fresh }
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
  warmForeignCreationTimes()
  const attempt = acquireLock()
  if (!attempt.ok) return false
  const lock = attempt.lock
  try {
    if (!lockIsHeld(lock)) return false
    ownSessionIds.clear()
    mountOperations.clear()
    ownStartedAt = undefined
    return writeLedger(undefined).ok
  } finally {
    releaseLock(lock)
  }
}

/**
 * {@link reserveMount} for a session id this process just minted, where a
 * refusal is a loss of ANNOUNCEMENT rather than a conflict.
 *
 * A brand-new id cannot be held by anybody, so a create must not be blocked by
 * a ledger it cannot write — but it still has to be announced before the
 * factory runs, because from the moment the factory returns this process owns
 * the only write handle and the publisher will not name the session until its
 * next beat. A refusal therefore yields a no-op reservation and the caller
 * carries on; `failure` reports what happened so the caller can say so.
 * @param sessionId - Freshly minted session id.
 * @returns A reservation (never a refusal) plus the failure, if any.
 */
export async function reserveNewSession(
  sessionId: string,
): Promise<{ readonly reservation: MountReservation; readonly failure?: MountFailure }> {
  const reserved = await reserveMount(sessionId)
  if (reserved.ok) return { reservation: reserved.reservation }
  return { reservation: { settle: () => {}, abandon: () => {} }, failure: reserved }
}

/**
 * The sessions this process has published, for the diagnostics surface.
 * @returns The ids last handed to {@link publishMounts}.
 */
export function ownMounts(): readonly string[] {
  return [...ownSessionIds]
}

/**
 * Backoff schedule for a lock a peer is holding right now. The lock only spans
 * one read-and-replace of a small file, so a few hundred milliseconds covers
 * every ordinary collision; this is an interaction budget, not a correctness
 * condition — the claim itself is what decides, every time it is retried.
 */
const CLAIM_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const

/**
 * {@link claimMount} with a bounded retry for `busy`.
 *
 * `busy` means a peer held the ledger lock for the instant we wanted it, which
 * says nothing about occupancy and is worth waiting out. `occupied` and
 * `unavailable` are answers, not collisions, and are returned immediately.
 * @param sessionId - Session id to claim.
 * @returns The final claim, `busy` only when the whole budget was spent.
 */
export async function claimMountWithRetry(sessionId: string): Promise<MountClaim> {
  let claim = claimMount(sessionId)
  for (const delay of CLAIM_RETRY_DELAYS_MS) {
    if (claim.ok || claim.reason !== 'busy') return claim
    await new Promise(resolve => setTimeout(resolve, delay))
    claim = claimMount(sessionId)
  }
  return claim
}

/**
 * What a caller holds after {@link reserveMount} succeeds.
 *
 * A reservation ends one of two ways, and they are not the same act. `settle`
 * hands the session over to the agent registry — the mount happened, and from
 * then on the publisher derives the set from the roster. `abandon` gives it
 * back — the mount never happened, so nothing may be left claiming it. Both
 * are idempotent, so a `finally` can call either without tracking which.
 */
export interface MountReservation {
  readonly settle: () => void
  readonly abandon: () => void
}

/** Outcome of {@link reserveMount}: the reservation, or why there is none. */
export type MountReservationResult =
  | { readonly ok: true; readonly reservation: MountReservation }
  | MountFailure

/**
 * Claim `sessionId` and pin it for the WHOLE mount attempt, not just the claim
 * call.
 *
 * Everything that opens a writer goes through here, so that the rules live in
 * one place: the claim is atomic (nothing is opened on a refusal), the pin
 * survives a publisher beat while the agent does not exist yet, and the
 * reservation ends explicitly — `settle` on a commit, `abandon` on every path
 * that does not commit.
 * @param sessionId - Session about to be mounted.
 * @returns The reservation, or the {@link MountFailure} to report back.
 */
export async function reserveMount(sessionId: string): Promise<MountReservationResult> {
  const claim = await claimMountWithRetry(sessionId)
  if (!claim.ok) return claim
  const releaseOperation = holdMountOperation(sessionId)
  let settled = false
  return {
    ok: true,
    reservation: {
      settle: () => {
        if (settled) return
        settled = true
        releaseOperation()
      },
      abandon: () => {
        if (settled) return
        settled = true
        releaseOperation()
        // Only give back what this reservation took. A claim that inherited the
        // session (already ours) must not release it: this process was driving
        // that log before the attempt and still is.
        if (claim.fresh) releaseMount(sessionId)
      },
    },
  }
}
