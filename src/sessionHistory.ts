/**
 * Launcher contract for `dsh-tui --resume`: the TUI writes the chosen session
 * id to `~/.dsh-tui/resume.txt`, and the launcher feeds it back as
 * `DSH_TUI_RESUME_SESSION`. Session *records* live in DSH's own persistence
 * backend (dsh-session-persistence-jsonl) — `/resume` lists those via
 * `sessionPersistence.list()`, this file only carries the id across
 * processes. It also keeps a small `last-used.json` of session-id → epoch-ms
 * touches so `/resume` can sort most-recently-used first (DSH session
 * headers carry only `createdAt`).
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './utils/paths.js'

const DIR = DATA_DIR
const RESUME_FILE = join(DIR, 'resume.txt')
const LAST_USED_FILE = join(DIR, 'last-used.json')
let lastUsedStamp: string | undefined
let lastUsedCache: Readonly<Record<string, number>> | undefined

function lastUsedFileStamp(): string | undefined {
  try {
    const stats = statSync(LAST_USED_FILE)
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`
  } catch {
    return undefined
  }
}
/**
 * The agent view's OWN ledger: session-id → epoch-ms of the moments this TUI
 * dispatched, backgrounded, or attached to a session FROM the agent view.
 * Unlike last-used.json (every /resume touch), this is the "background
 * session" record used by the session overview — ordinary history never lands
 * here, so the view lists only sessions it actually manages.
 */
const AGENT_VIEW_SESSIONS_FILE = join(DIR, 'agent-view-sessions.json')

function ensureDir(): void {
  mkdirSync(DIR, { recursive: true })
}

/**
 * Store the session to resume and report the launcher invocation.
 * @param sessionId - Session id for `dsh-tui --resume` on the next launch.
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
 * The session id requested by `dsh-tui --resume`, if any.
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
 * The session id requested through `--resume`/`-c`/`--continue` in app args,
 * mirroring the standalone bin's interception (issue #120/#53). The
 * `dsh --profile tui` boot path forwards these args to the booted app
 * verbatim and never parses them into DSH_TUI_RESUME_SESSION, so the
 * in-profile plugin reads them itself. A bare flag with no id defers to the
 * exit-time marker, exactly like the bin. An app-level `--` ends option parsing.
 * @param argv - the app arguments from cmdlineArgs, after the host's own options.
 * @returns The requested session id, or undefined when none was given.
 */
export function resumeTargetFromArgv(
  argv: readonly string[],
  /** What a bare flag resumes: DSH's exit-time marker by default; another
   *  backend passes its own (a Claude id never lives in `resume.txt`). */
  readFallback: () => string | undefined = readResumeTarget,
): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') break
    if (a === '--resume' || a === '-c' || a === '--continue' || a.startsWith('--resume=')) {
      let sessionId = ''
      if (a.startsWith('--resume=')) {
        sessionId = a.slice('--resume='.length).trim()
      } else if (a === '--resume' && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) {
        sessionId = argv[++i].trim()
      }
      if (!sessionId) sessionId = readFallback() ?? ''
      if (sessionId) return sessionId
    }
  }
  return undefined
}

/**
 * Session-id → last-used epoch ms map for MRU ordering.
 * @returns The parsed map; best effort, an unreadable file yields {}.
 */
/**
 * Drop the resume flags {@link resumeTargetFromArgv} recognizes (same
 * grammar, one source — the two must never drift).
 *
 * A kernel switch respawns the process onto the OTHER backend: this
 * kernel's session id means nothing there, and an inherited `--resume
 * <id>` in argv would send the replacement looking for a session that
 * belongs to the kernel it just left (DSH's `resume.txt` marker is
 * already deleted by restartTui for the same reason). `--` still ends
 * option parsing.
 * @param argv - App arguments, exactly as passed to the replacement.
 * @returns A copy without those flags (and without the id they consumed).
 */
export function stripResumeArgs(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') {
      out.push(...argv.slice(i))
      break
    }
    if (a === '--resume' || a === '-c' || a === '--continue' || a.startsWith('--resume=')) {
      // A bare flag eats the id behind it (same rule as the parser above).
      if (a === '--resume' && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('-')) i++
      continue
    }
    out.push(a)
  }
  return out
}

export function readLastUsed(): Readonly<Record<string, number>> {
  const stamp = lastUsedFileStamp()
  if (lastUsedCache !== undefined && lastUsedStamp === stamp) return lastUsedCache
  try {
    const parsed = JSON.parse(readFileSync(LAST_USED_FILE, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      lastUsedCache = {}
      lastUsedStamp = stamp
      return lastUsedCache
    }
    const record = parsed as Record<string, unknown>
    const result: Record<string, number> = {}
    for (const [id, value] of Object.entries(record)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        result[id] = value
      }
    }
    lastUsedCache = result
    lastUsedStamp = stamp
    return result
  } catch {
    lastUsedCache = {}
    lastUsedStamp = stamp
    return lastUsedCache
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
    lastUsedCache = lastUsed
    lastUsedStamp = lastUsedFileStamp()
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
    lastUsedCache = lastUsed
    lastUsedStamp = lastUsedFileStamp()
  } catch {
    // Best effort — a stale entry only skews sort order.
  }
}

/**
 * The agent-view ledger (see {@link AGENT_VIEW_SESSIONS_FILE}): session-id →
 * epoch-ms. Best effort — an unreadable file yields {}.
 * @returns The parsed map.
 */
export function readAgentViewSessions(): Readonly<Record<string, number>> {
  try {
    const parsed = JSON.parse(readFileSync(AGENT_VIEW_SESSIONS_FILE, 'utf8')) as unknown
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
 * Record a session as agent-view-managed (dispatched, backgrounded, or
 * attached from the view). Best effort — never throws.
 * @param sessionId - Session id to record.
 */
export function touchAgentViewSession(sessionId: string): void {
  try {
    ensureDir()
    const sessions = { ...readAgentViewSessions(), [sessionId]: Date.now() }
    writeFileSync(AGENT_VIEW_SESSIONS_FILE, JSON.stringify(sessions))
  } catch {
    // Best effort — the ledger is a display filter, not state.
  }
}

/**
 * Drop a session from the agent-view ledger (its log was deleted). Best
 * effort — never throws.
 * @param sessionId - Session id to forget.
 */
export function forgetAgentViewSession(sessionId: string): void {
  try {
    const sessions: Record<string, number> = { ...readAgentViewSessions() }
    if (!(sessionId in sessions)) return
    delete sessions[sessionId]
    ensureDir()
    writeFileSync(AGENT_VIEW_SESSIONS_FILE, JSON.stringify(sessions))
  } catch {
    // Best effort — a stale entry only lists one extra stopped row.
  }
}
