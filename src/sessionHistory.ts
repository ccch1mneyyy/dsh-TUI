/**
 * Launcher contract for `dsh-cc --resume`: the TUI writes the chosen session
 * id to `~/.dsh-cc/resume.txt`, and the launcher feeds it back as
 * `DSH_CC_RESUME_SESSION`. Session *records* live in DSH's own persistence
 * backend (dsh-session-persistence-jsonl) — `/resume` lists those via
 * `sessionPersistence.list()`, this file only carries the id across
 * processes.
 */
import { homedir } from 'node:os'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SessionRecord {
  id: string
  title: string
  cwd: string
  createdAt: number
  updatedAt: number
}

const DIR = join(homedir(), '.dsh-cc')
const RESUME_FILE = join(DIR, 'resume.txt')

function ensureDir(): void {
  mkdirSync(DIR, { recursive: true })
}

/** Store the session to resume and report the launcher invocation. */
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

/** The session id requested by `dsh-cc --resume`, if any. */
export function readResumeTarget(): string | undefined {
  try {
    const value = readFileSync(RESUME_FILE, 'utf8').trim()
    return value || undefined
  } catch {
    return undefined
  }
}
