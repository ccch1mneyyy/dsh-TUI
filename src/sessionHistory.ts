/**
 * Launcher contract for `dsh-cc --resume`: the TUI writes the chosen session
 * id to `~/.dsh-cc/resume.txt`, and the launcher feeds it back as
 * `DSH_CC_RESUME_SESSION`. Session *records* live in DSH's own persistence
 * backend (dsh-session-persistence-jsonl) — `/resume` lists those via
 * `sessionPersistence.list()`, this file only carries the id across
 * processes. It also keeps a small `last-used.json` of session-id → epoch-ms
 * touches so `/resume` can sort most-recently-used first (DSH session
 * headers carry only `createdAt`).
 */
import { homedir } from 'node:os'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One persisted session as the `/resume` picker lists it. */
export interface SessionRecord {
  id: string
  title: string
  cwd: string
  createdAt: number
  updatedAt: number
}

const DIR = join(homedir(), '.dsh-cc')
const RESUME_FILE = join(DIR, 'resume.txt')
const LAST_USED_FILE = join(DIR, 'last-used.json')

function ensureDir(): void {
  mkdirSync(DIR, { recursive: true })
}

/**
 * Store the session to resume and report the launcher invocation.
 * @param sessionId - Session id for `dsh-cc --resume` on the next launch.
 */
export function writeResumeTarget(sessionId: string): void {
  ensureDir()
  writeFileSync(RESUME_FILE, sessionId)
}

/** Forget the resume marker (`/new` starts a fresh conversation). */
export function clearResumeTarget(): void {
  try {
    writeFileSync(RESUME_FILE, '')
  } catch {
    // Best effort — the marker is a launcher nicety.
  }
}

/**
 * The session id requested by `dsh-cc --resume`, if any.
 * @returns The stored session id, or undefined when none is set.
 */
export function readResumeTarget(): string | undefined {
  try {
    const value = readFileSync(RESUME_FILE, 'utf8').trim()
    return value || undefined
  } catch {
    return undefined
  }
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
