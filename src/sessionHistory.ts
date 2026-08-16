/**
 * Launcher contract for `dsh-tui --resume`: the TUI writes the chosen session
 * id to `~/.dsh-tui/resume.txt`, and the launcher feeds it back as
 * `DSH_TUI_RESUME_SESSION`. Session *records* live in DSH's own persistence
 * backend (dsh-session-persistence-jsonl) — `/resume` lists those via
 * `sessionPersistence.list()`, this file only carries the id across
 * processes. It also keeps a small `last-used.json` of session-id → epoch-ms
 * touches so `/resume` can sort most-recently-used first (DSH session
 * headers carry only `createdAt`).
 *
 * Rename transition (issue #120): the global bin and the profile's TUI
 * package may run different versions, so `resume.txt` is DUAL-WRITTEN to the
 * legacy `~/.dsh-cc/resume.txt` as well (old launchers read only that path)
 * and reads fall back to it. TODO: drop the legacy path once pre-rename
 * launchers have aged out.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, LEGACY_DATA_DIR } from './utils/paths.js'

const DIR = DATA_DIR
const RESUME_FILE = join(DIR, 'resume.txt')
const LEGACY_RESUME_FILE = join(LEGACY_DATA_DIR, 'resume.txt')
const LAST_USED_FILE = join(DIR, 'last-used.json')

function ensureDir(): void {
  mkdirSync(DIR, { recursive: true })
}

/**
 * Store the session to resume and report the launcher invocation.
 * Dual-writes the legacy path for pre-rename launchers (see header).
 * @param sessionId - Session id for `dsh-tui --resume` on the next launch.
 */
export function writeResumeTarget(sessionId: string): void {
  ensureDir()
  writeFileSync(RESUME_FILE, sessionId)
  try {
    mkdirSync(LEGACY_DATA_DIR, { recursive: true })
    writeFileSync(LEGACY_RESUME_FILE, sessionId)
  } catch {
    // Best effort — the legacy mirror only serves old launchers.
  }
}

/** Forget the resume marker (`/new` starts a fresh conversation). */
export function clearResumeTarget(): void {
  for (const file of [RESUME_FILE, LEGACY_RESUME_FILE]) {
    try {
      writeFileSync(file, '')
    } catch {
      // Best effort — the marker is a launcher nicety.
    }
  }
}

/**
 * The session id requested by `dsh-tui --resume`, if any. The new path
 * wins; the legacy path is the fallback for pre-rename launchers.
 * @returns The stored session id, or undefined when none is set.
 */
export function readResumeTarget(): string | undefined {
  for (const file of [RESUME_FILE, LEGACY_RESUME_FILE]) {
    try {
      const value = readFileSync(file, 'utf8').trim()
      if (value) return value
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

/**
 * Session-id → last-used epoch ms map for MRU ordering.
 * @returns The parsed map; best effort, an unreadable file yields {}.
 */
export function readLastUsed(): Readonly<Record<string, number>> {
  try {
    const parsed = JSON.parse(readFileSync(LAST_USED_FILE, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const record = parsed as Record<string, unknown>
    const result: Record<string, number> = {}
    for (const [id, value] of Object.entries(record)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        result[id] = value
      }
    }
    return result
  } catch {
    return {}
  }
}

/**
 * Record that a session was just used (resumed or written to) so `/resume`
 * can sort most-recently-used first. Best effort — never throws.
 * @param sessionId - Session id to touch.
 */
export function touchSession(sessionId: string): void {
  try {
    ensureDir()
    const lastUsed = { ...readLastUsed(), [sessionId]: Date.now() }
    writeFileSync(LAST_USED_FILE, JSON.stringify(lastUsed))
  } catch {
    // Best effort — MRU ordering is a nicety.
  }
}

/**
 * Drop a session's last-used entry (`/resume` picker delete) so the MRU map
 * never accumulates ids whose logs are gone. Best effort — never throws.
 * @param sessionId - Session id to forget.
 */
export function forgetSession(sessionId: string): void {
  try {
    const lastUsed: Record<string, number> = { ...readLastUsed() }
    if (!(sessionId in lastUsed)) return
    delete lastUsed[sessionId]
    ensureDir()
    writeFileSync(LAST_USED_FILE, JSON.stringify(lastUsed))
  } catch {
    // Best effort — a stale entry only skews sort order.
  }
}
