import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

const HISTORY_DIR = DATA_DIR
const HISTORY_FILE = join(HISTORY_DIR, 'history.jsonl')
const HISTORY_LOCK = join(HISTORY_DIR, 'history.jsonl.lock')
const HISTORY_LOCK_OWNER = join(HISTORY_LOCK, 'owner')

/** One persisted input-history entry. */
export type HistoryEntry = {
  text: string
  /** Unix ms timestamp. */
  ts: number
}

const HISTORY_LIMIT = 200
const HISTORY_LOCK_WAIT_MS = 5_000
const HISTORY_LOCK_STALE_MS = 30_000
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(ms: number): void {
  Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, ms)
}

function ownerProcessIsAlive(): boolean | undefined {
  try {
    const owner = JSON.parse(readFileSync(HISTORY_LOCK_OWNER, 'utf8')) as { pid?: unknown }
    if (typeof owner.pid !== 'number' || !Number.isInteger(owner.pid)) return undefined
    try {
      process.kill(owner.pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  } catch {
    return undefined
  }
}

function staleHistoryLock(): boolean {
  try {
    const alive = ownerProcessIsAlive()
    if (alive !== undefined) return !alive
    return Date.now() - statSync(HISTORY_LOCK).mtimeMs > HISTORY_LOCK_STALE_MS
  } catch {
    return false
  }
}

function acquireHistoryLock(): (() => void) | undefined {
  mkdirSync(HISTORY_DIR, { recursive: true })
  const deadline = Date.now() + HISTORY_LOCK_WAIT_MS
  for (;;) {
    try {
      mkdirSync(HISTORY_LOCK)
      try {
        writeFileSync(HISTORY_LOCK_OWNER, JSON.stringify({ pid: process.pid }), 'utf8')
      } catch {
        rmSync(HISTORY_LOCK, { recursive: true, force: true })
        return undefined
      }
      return () => {
        try {
          rmSync(HISTORY_LOCK, { recursive: true, force: true })
        } catch {
          // Best effort; a later writer can recover a stale lock.
        }
      }
    } catch {
      if (staleHistoryLock()) {
        try {
          rmSync(HISTORY_LOCK, { recursive: true, force: true })
        } catch {
          // Another writer may have released or replaced the lock.
        }
        continue
      }
      if (Date.now() >= deadline) return undefined
      sleepSync(10)
    }
  }
}

function loadRaw(): HistoryEntry[] {
  if (!existsSync(HISTORY_FILE)) return []
  const entries: HistoryEntry[] = []
  const readAt = Date.now()
  try {
    for (const line of readFileSync(HISTORY_FILE, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as Partial<HistoryEntry>
        if (typeof parsed.text === 'string' && parsed.text.length > 0) {
          const ts = typeof parsed.ts === 'number' && Number.isFinite(parsed.ts) && parsed.ts >= 0
            ? parsed.ts
            : readAt
          const last = entries[entries.length - 1]
          if (last?.text === parsed.text) {
            // Fold adjacent repeats while reading to retain the previous
            // "latest repeat wins" behavior, including legacy snapshots.
            last.ts = ts
          } else {
            entries.push({ text: parsed.text, ts })
          }
        }
      } catch {
        // Skip malformed lines; the file is best-effort.
      }
    }
  } catch {
    return []
  }
  return entries.slice(-HISTORY_LIMIT)
}

/**
 * Persist one input under a cross-process lock. The snapshot is written to a
 * temporary file and atomically renamed so readers see either the old or new
 * complete JSONL file; the physical file remains capped at 200 entries.
 * @param text - Input to persist; blank inputs are ignored.
 */
export function appendHistory(text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  let release: (() => void) | undefined
  try {
    release = acquireHistoryLock()
  } catch {
    return
  }
  if (!release) return
  try {
    const entries = loadRaw()
    const last = entries[entries.length - 1]
    if (last?.text === trimmed) {
      last.ts = Date.now()
    } else {
      entries.push({ text: trimmed, ts: Date.now() })
    }
    const snapshot = entries.slice(-HISTORY_LIMIT)
    const temporaryFile = join(HISTORY_DIR, `.history-${process.pid}-${randomUUID()}.tmp`)
    try {
      writeFileSync(
        temporaryFile,
        snapshot.map(entry => JSON.stringify(entry)).join('\n') + '\n',
        'utf8',
      )
      renameSync(temporaryFile, HISTORY_FILE)
    } finally {
      try {
        rmSync(temporaryFile, { force: true })
      } catch {
        // Best effort cleanup; the next write uses a unique temporary path.
      }
    }
  } catch {
    // Best-effort persistence; history still works for the session.
  } finally {
    release()
  }
}

/**
 * Read the persisted history, newest first.
 * @returns The persisted entries in reverse-chronological order.
 */
export function loadHistory(): HistoryEntry[] {
  return loadRaw().reverse()
}

/**
 * Stable text-derived id prefix for a history entry. Callers rendering a
 * list must add a positional or record-specific suffix because repeated text
 * is valid persisted history.
 * @param entry - The history entry to hash.
 * @returns A 12-char hex id derived from the entry text.
 */
export function historyEntryId(entry: HistoryEntry): string {
  return createHash('sha1').update(entry.text).digest('hex').slice(0, 12)
}
