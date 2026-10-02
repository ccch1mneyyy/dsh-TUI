import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DATA_DIR } from './utils/paths.js'

const HISTORY_DIR = DATA_DIR
const HISTORY_FILE = join(HISTORY_DIR, 'history.jsonl')
const HISTORY_LOCK = `${HISTORY_FILE}.lock`

/** One persisted input-history entry. */
export type HistoryEntry = {
  text: string
  /** Unix ms timestamp. */
  ts: number
  /**
   * Normalized workspace cwd the input was submitted in. Absent on entries
   * written before history became project-scoped; those legacy entries stay
   * visible in every project until that project's own entries push them out
   * of the `HISTORY_LIMIT` window.
   */
  project?: string
}

/**
 * Per-project entry cap. `↑`/`↓` and the Ctrl+R overlay read the same file,
 * so both depths come from this one number.
 */
export const HISTORY_LIMIT = 200
/**
 * Whole-file cap across all projects, so a user hopping between many
 * workspaces cannot grow `history.jsonl` without bound.
 */
const HISTORY_FILE_LIMIT = 2000
const LOCK_RETRY_LIMIT = 500
const LOCK_RETRY_DELAY_MS = 5
const STALE_LOCK_MS = 30_000

async function removeStaleHistoryLock(): Promise<boolean> {
  try {
    const ageMs = Date.now() - (await stat(HISTORY_LOCK)).mtimeMs
    if (ageMs < STALE_LOCK_MS) return false
    await rm(HISTORY_LOCK, { recursive: true, force: true })
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return true
    throw error
  }
}

async function withHistoryLock(write: () => Promise<void>): Promise<void> {
  // 0700: history.jsonl holds the user's raw inputs (incl. pasted secrets),
  // so the directory must not be group/world-readable. Mode applies to the
  // creation only; pre-existing dirs are left as-is (no migration chmod).
  await mkdir(HISTORY_DIR, { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt += 1) {
    try {
      await mkdir(HISTORY_LOCK)
      try {
        await write()
      } finally {
        await rm(HISTORY_LOCK, { recursive: true, force: true })
      }
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      if (await removeStaleHistoryLock()) continue
      await delay(LOCK_RETRY_DELAY_MS + Math.floor(Math.random() * 5))
    }
  }
  throw new Error('history lock busy')
}

/**
 * Project key for a workspace cwd: absolute, forward slashes, no trailing
 * slash, case-folded on Windows (whose filesystem is case-insensitive).
 * @param cwd - Workspace cwd; blank means unscoped.
 * @returns The normalized key, or `undefined` when unscoped.
 */
export function historyProjectKey(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd.trim() === '') return undefined
  const normalized = resolve(cwd).replace(/\\/g, '/').replace(/(.)\/+$/, '$1')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Whether `entry` belongs to the history view of `project` (undefined = all). */
function inProject(entry: HistoryEntry, project: string | undefined): boolean {
  return project === undefined || entry.project === undefined || entry.project === project
}

/**
 * Keep the newest `HISTORY_LIMIT` entries of every project (legacy entries
 * count as one bucket), then the newest `HISTORY_FILE_LIMIT` overall.
 */
function pruneEntries(entries: readonly HistoryEntry[]): HistoryEntry[] {
  const counts = new Map<string, number>()
  const kept: HistoryEntry[] = []
  for (let index = entries.length - 1; index >= 0 && kept.length < HISTORY_FILE_LIMIT; index -= 1) {
    const entry = entries[index]!
    const bucket = entry.project ?? ''
    const count = counts.get(bucket) ?? 0
    if (count >= HISTORY_LIMIT) continue
    counts.set(bucket, count + 1)
    kept.push(entry)
  }
  return kept.reverse()
}

function parseRaw(raw: string): HistoryEntry[] {
  const entries: HistoryEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as Partial<HistoryEntry>
      if (typeof parsed.text === 'string' && parsed.text.length > 0) {
        const entry: HistoryEntry = { text: parsed.text, ts: typeof parsed.ts === 'number' ? parsed.ts : 0 }
        if (typeof parsed.project === 'string' && parsed.project !== '') entry.project = parsed.project
        entries.push(entry)
      }
    } catch {
      // Skip malformed lines; the file is best-effort.
    }
  }
  return entries
}

function loadRaw(): HistoryEntry[] {
  if (!existsSync(HISTORY_FILE)) return []
  try {
    return parseRaw(readFileSync(HISTORY_FILE, 'utf8'))
  } catch {
    return []
  }
}

async function loadRawAsync(): Promise<HistoryEntry[]> {
  try {
    return parseRaw(await readFile(HISTORY_FILE, 'utf8'))
  } catch {
    return []
  }
}

async function persistEntry(trimmed: string, project: string | undefined): Promise<void> {
  try {
    await withHistoryLock(async () => {
      const entries = await loadRawAsync()
      // Skip consecutive duplicates within the project's view (repeated
      // submits of the same command only advance the existing entry's
      // timestamp); another project's interleaved entry does not break it,
      // and a legacy entry the view still shows counts as the previous one.
      const last = entries.findLast(entry =>
        entry.project === project || (project !== undefined && entry.project === undefined))
      if (last && last.text === trimmed) {
        last.ts = Date.now()
      } else {
        const entry: HistoryEntry = { text: trimmed, ts: Date.now() }
        if (project !== undefined) entry.project = project
        entries.push(entry)
      }
      const sliced = pruneEntries(entries)
      // Atomic replace: a direct async overwrite exposes truncated bytes to
      // the synchronous loadHistory() mid-write (review finding). Same-dir
      // temp file + rename is atomic on POSIX and Windows alike; the temp
      // keeps mode 0600 — entries carry the full user input text.
      const tmpFile = `${HISTORY_FILE}.${process.pid}.tmp`
      try {
        await writeFile(
          tmpFile,
          sliced.map(e => JSON.stringify(e)).join('\n') + '\n',
          { encoding: 'utf8', mode: 0o600 },
        )
        await rename(tmpFile, HISTORY_FILE)
      } finally {
        // A failed rename would otherwise leave the user's raw input behind in
        // the temp file, which appendHistory's best-effort catch swallows.
        await rm(tmpFile, { force: true })
      }
    })
  } catch {
    // Best-effort persistence; history still works for the session.
  }
}

/**
 * Serializes local appends. The file lock only orders writers across
 * processes; without this chain two rapid submits can reach it in either
 * order and loadHistory() would show them reversed.
 */
let appendChain: Promise<void> = Promise.resolve()

/**
 * Append an input to the persisted history, deduping the project's
 * immediately previous entry and capping each project at `HISTORY_LIMIT`.
 * @param text - Input to persist; blank inputs are ignored.
 * @param cwd - Workspace cwd the input belongs to; omitted = unscoped.
 * @returns Resolves once this entry is persisted; callers on the input path
 * intentionally discard it because persistence is best-effort.
 */
export function appendHistory(text: string, cwd?: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) return Promise.resolve()
  const project = historyProjectKey(cwd)
  const queued = appendChain.then(() => persistEntry(trimmed, project))
  // persistEntry never rejects, but keep the chain alive regardless so one
  // failure cannot stall every later append.
  appendChain = queued.catch(() => {})
  return queued
}

/**
 * Read one project's persisted history view in chronological order: its own
 * entries plus legacy unscoped ones, capped at `HISTORY_LIMIT`.
 */
function loadProject(cwd: string | undefined): HistoryEntry[] {
  const project = historyProjectKey(cwd)
  return loadRaw().filter(entry => inProject(entry, project)).slice(-HISTORY_LIMIT)
}

/**
 * Read the persisted history, newest first.
 * @param cwd - Workspace cwd to scope to; omitted = every project.
 * @returns The persisted entries in reverse-chronological order.
 */
export function loadHistory(cwd?: string): HistoryEntry[] {
  return loadProject(cwd).reverse()
}

/**
 * Read the persisted history in the order the composer walks it: oldest
 * first, so `↑` reaches the newest entry first (the list tail) exactly as it
 * does for the entries this process pushed itself.
 * @param cwd - Workspace cwd to scope to; omitted = every project.
 * @returns The persisted entries in chronological order.
 */
export function loadHistoryOldestFirst(cwd?: string): HistoryEntry[] {
  return loadProject(cwd)
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
