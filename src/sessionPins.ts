/**
 * Pinned sessions for the `/resume` browser, kept at
 * `~/.dsh-tui/session-pins.json` (a JSON array of session ids) so the pins
 * survive restarts.
 *
 * The pin key is the DSH session id (`SessionSummary.id`, from the session
 * header): stable across log revisions. Missing sessions are tolerated — the
 * browser filters pins against the live listing instead of rewriting them.
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

const PINS_FILE = 'session-pins.json'
const LOCK_FILE = 'session-pins.lock'
const STALE_LOCK_MS = 30_000
let temporarySequence = 0

type ErrnoLike = { code?: unknown }

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as ErrnoLike).code === code
}

/** Parse the persisted array. Missing is empty; malformed data is an error. */
function readPinsStrict(dir: string): Set<string> {
  let raw: string
  try {
    raw = readFileSync(join(dir, PINS_FILE), 'utf8')
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return new Set()
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new TypeError('session-pins.json must contain an array')
  return new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0))
}

/** Atomically replace the preference while preserving private file modes. */
function writePinsAtomic(ids: Iterable<string>, dir: string): boolean {
  const target = join(dir, PINS_FILE)
  const temporary = join(
    dir,
    `${PINS_FILE}.${process.pid}.${Date.now()}.${temporarySequence++}.tmp`,
  )
  try {
    const normalized = [...new Set([...ids].filter(id => id.length > 0))]
    writeFileSync(temporary, JSON.stringify(normalized, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    renameSync(temporary, target)
    return true
  } catch {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The old preference is still intact; nothing else is safe to do.
    }
    return false
  }
}

/**
 * Take a short cross-process lock around read-modify-write. A crashed process
 * can leave the tiny lock file behind, so one stale lock may be reclaimed.
 */
function acquirePinsLock(dir: string): number | null {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    return null
  }
  const lockPath = join(dir, LOCK_FILE)
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
      } catch {}
      try {
        rmSync(lockPath, { force: true })
      } catch {}
      return null
    }
  }
  return null
}

function releasePinsLock(fd: number, dir: string): void {
  try {
    closeSync(fd)
  } catch {
    // Continue to remove the lock name even if close already happened.
  }
  try {
    rmSync(join(dir, LOCK_FILE), { force: true })
  } catch {
    // A stale lock is recoverable on the next mutation.
  }
}

/**
 * The persisted pin set, or empty when unset or unreadable.
 * @param dir - Prefs directory (injectable for tests).
 */
export function readSessionPins(dir: string = DATA_DIR): ReadonlySet<string> {
  try {
    return readPinsStrict(dir)
  } catch {
    return new Set()
  }
}

/**
 * Persist a complete pin set with a private, atomic replacement.
 * @param ids - Every pinned session id, in any order.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was replaced, false when locking/writing failed.
 */
export function writeSessionPins(ids: Iterable<string>, dir: string = DATA_DIR): boolean {
  const lock = acquirePinsLock(dir)
  if (lock === null) return false
  try {
    return writePinsAtomic(ids, dir)
  } finally {
    releasePinsLock(lock, dir)
  }
}

export type SessionPinMutationResult = {
  readonly ok: boolean
  readonly pins: ReadonlySet<string>
}

/**
 * Update one pin under a cross-process lock. The file is re-read only after
 * the lock is held, so two live TUI instances do not overwrite each other's
 * unrelated pin changes. Malformed input is preserved and reported as failure
 * instead of being silently replaced with an empty set.
 */
export function setSessionPinned(
  id: string,
  pinned: boolean,
  dir: string = DATA_DIR,
): SessionPinMutationResult {
  const fallback = readSessionPins(dir)
  const lock = acquirePinsLock(dir)
  if (lock === null) return { ok: false, pins: fallback }
  try {
    let current: Set<string>
    try {
      current = readPinsStrict(dir)
    } catch {
      return { ok: false, pins: fallback }
    }
    if (pinned) current.add(id)
    else current.delete(id)
    return writePinsAtomic(current, dir)
      ? { ok: true, pins: current }
      : { ok: false, pins: fallback }
  } finally {
    releasePinsLock(lock, dir)
  }
}
