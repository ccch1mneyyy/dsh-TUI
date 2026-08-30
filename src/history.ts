import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

const HISTORY_DIR = DATA_DIR
const HISTORY_FILE = join(HISTORY_DIR, 'history.jsonl')
const HISTORY_LOCK = `${HISTORY_FILE}.lock`

/** One persisted input-history entry. */
export type HistoryEntry = {
  text: string
  /** Unix ms timestamp. */
  ts: number
}

const HISTORY_LIMIT = 200
const LOCK_RETRY_LIMIT = 500
const LOCK_RETRY_DELAY_MS = 5
const STALE_LOCK_MS = 30_000

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function removeStaleHistoryLock(): boolean {
  try {
    const ageMs = Date.now() - statSync(HISTORY_LOCK).mtimeMs
    if (ageMs < STALE_LOCK_MS) return false
    rmSync(HISTORY_LOCK, { recursive: true, force: true })
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return true
    throw error
  }
}

function withHistoryLock(write: () => void): void {
  // 0700: history.jsonl holds the user's raw inputs (incl. pasted secrets),
  // so the directory must not be group/world-readable. Mode applies to the
  // creation only; pre-existing dirs are left as-is (no migration chmod).
  mkdirSync(HISTORY_DIR, { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt += 1) {
    try {
      mkdirSync(HISTORY_LOCK)
      try {
        write()
      } finally {
        rmSync(HISTORY_LOCK, { recursive: true, force: true })
      }
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      if (removeStaleHistoryLock()) continue
      sleepSync(LOCK_RETRY_DELAY_MS + Math.floor(Math.random() * 5))
    }
  }
  throw new Error('history lock busy')
}

function loadRaw(): HistoryEntry[] {
  if (!existsSync(HISTORY_FILE)) return []
  const entries: HistoryEntry[] = []
  try {
    for (const line of readFileSync(HISTORY_FILE, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as Partial<HistoryEntry>
        if (typeof parsed.text === 'string' && parsed.text.length > 0) {
          entries.push({ text: parsed.text, ts: typeof parsed.ts === 'number' ? parsed.ts : 0 })
        }
      } catch {
        // Skip malformed lines; the file is best-effort.
      }
    }
  } catch {
    return []
  }
  return entries
}

/**
 * Append an input to the persisted history, deduping the immediately
 * previous entry and capping the file at 200 entries.
 * @param text - Input to persist; blank inputs are ignored.
 */
export function appendHistory(text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  try {
    withHistoryLock(() => {
      const entries = loadRaw()
      // Skip consecutive duplicates (CC behavior: repeated submits of the same
      // command only advance the existing entry's timestamp).
      const last = entries[entries.length - 1]
      if (last && last.text === trimmed) {
        last.ts = Date.now()
      } else {
        entries.push({ text: trimmed, ts: Date.now() })
      }
      const sliced = entries.slice(-HISTORY_LIMIT)
      writeFileSync(
        HISTORY_FILE,
        sliced.map(e => JSON.stringify(e)).join('\n') + '\n',
        // 0600 on creation: entries carry the full user input text
        { encoding: 'utf8', mode: 0o600 },
      )
    })
  } catch {
    // Best-effort persistence; history still works for the session.
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
 * Stable id for a history entry (keeps React keys distinct across identical texts).
 * @param entry - The history entry to hash.
 * @param index - Position in the currently rendered result list.
 * @returns A 12-char hex id derived from the entry text, timestamp, and index.
 */
export function historyEntryId(entry: HistoryEntry, index = 0): string {
  return createHash('sha1').update(`${entry.text}\0${entry.ts}\0${index}`).digest('hex').slice(0, 12)
}
