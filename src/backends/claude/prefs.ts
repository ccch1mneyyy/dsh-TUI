/**
 * The Claude backend's persisted user choices
 * (`~/.dsh-tui/backends/claude/prefs.json`, design §3.6): the `/model` and
 * `/effort` picks a later session starts with. Backend-scoped on purpose —
 * a Claude model id means nothing to the DSH `/model` preference, and the
 * CLI's own settings files are never written (the user's interactive
 * `claude` keeps its own choices).
 *
 * Best-effort like every `~/.dsh-tui` preference: a missing or corrupt file
 * reads as "no choice", a failed write is reported to the caller's debug
 * log and the session carries on.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../../utils/paths.js'

/** What persists. */
export interface ClaudePrefsData {
  readonly model?: string
  readonly effort?: string
  /** The session a bare `dsh-tui --backend claude --resume` opens (the
   *  launcher reads this field directly; DSH's `resume.txt` never holds a
   *  Claude id). */
  readonly lastSession?: string
  /** This install's last use of each session (epoch ms): the session
   *  browser's MRU note, like DSH's `last-used.json`. */
  readonly lastUsed?: Readonly<Record<string, number>>
}

/** A patch: a value sets the field, `null` clears it. */
export interface ClaudePrefsPatch {
  readonly model?: string | null
  readonly effort?: string | null
  readonly lastSession?: string | null
}

/** Read / patch access (injectable: tests use an in-memory store). */
export interface ClaudePrefs {
  read(): ClaudePrefsData
  /** Patch fields; `null` clears one. */
  write(patch: ClaudePrefsPatch): void
  /** Note that a session was just used (MRU). */
  touch(sessionId: string): void
  /** Forget a deleted session (its MRU note and the launcher marker). */
  forget(sessionId: string): void
}

const FILE = 'prefs.json'
/** MRU notes kept (oldest dropped first): the file stays small. */
const LAST_USED_LIMIT = 200

/** Narrow a parsed document to what persists. */
function parsePrefs(parsed: unknown): ClaudePrefsData {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const record = parsed as Record<string, unknown>
  const lastUsed: Record<string, number> = {}
  const rawUsed = record.lastUsed
  if (rawUsed !== null && typeof rawUsed === 'object' && !Array.isArray(rawUsed)) {
    for (const [id, value] of Object.entries(rawUsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) lastUsed[id] = value
    }
  }
  return {
    ...(typeof record.model === 'string' && record.model !== '' ? { model: record.model } : {}),
    ...(typeof record.effort === 'string' && record.effort !== '' ? { effort: record.effort } : {}),
    ...(typeof record.lastSession === 'string' && record.lastSession !== '' ? { lastSession: record.lastSession } : {}),
    ...(Object.keys(lastUsed).length === 0 ? {} : { lastUsed }),
  }
}

/** Apply a patch (pure). */
function patched(current: ClaudePrefsData, patch: ClaudePrefsPatch): ClaudePrefsData {
  const next: Record<string, unknown> = { ...current }
  for (const key of ['model', 'effort', 'lastSession'] as const) {
    const value = patch[key]
    if (value === undefined) continue
    if (value === null) delete next[key]
    else next[key] = value
  }
  return next as ClaudePrefsData
}

/** Record one use (pure), keeping the newest {@link LAST_USED_LIMIT}. */
function touched(current: ClaudePrefsData, sessionId: string, now: number): ClaudePrefsData {
  const entries = Object.entries({ ...current.lastUsed, [sessionId]: now })
    .sort((a, b) => b[1] - a[1])
    .slice(0, LAST_USED_LIMIT)
  return { ...current, lastUsed: Object.fromEntries(entries) }
}

/** Drop one session (pure). */
function forgotten(current: ClaudePrefsData, sessionId: string): ClaudePrefsData {
  const lastUsed = { ...current.lastUsed }
  delete lastUsed[sessionId]
  const next: Record<string, unknown> = { ...current, lastUsed }
  if (Object.keys(lastUsed).length === 0) delete next.lastUsed
  if (current.lastSession === sessionId) delete next.lastSession
  return next as ClaudePrefsData
}

/** The file-backed prefs under `<dir>` (default `~/.dsh-tui/backends/claude`). */
export function fileClaudePrefs(dir: string = join(DATA_DIR, 'backends', 'claude'), debug: (message: string) => void = () => undefined): ClaudePrefs {
  const path = join(dir, FILE)
  const read = (): ClaudePrefsData => {
    try {
      return parsePrefs(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      return {}
    }
  }
  const save = (next: ClaudePrefsData): void => {
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
    } catch (error) {
      debug(`claude: prefs write failed (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return {
    read,
    write: patch => { save(patched(read(), patch)) },
    touch: sessionId => { save(touched(read(), sessionId, Date.now())) },
    forget: sessionId => { save(forgotten(read(), sessionId)) },
  }
}

/** An in-memory store (tests, embedders without a home directory). */
export function memoryClaudePrefs(initial: ClaudePrefsData = {}): ClaudePrefs & { readonly data: ClaudePrefsData } {
  let data: ClaudePrefsData = { ...initial }
  return {
    get data() { return data },
    read: () => data,
    write(patch) { data = patched(data, patch) },
    touch(sessionId) { data = touched(data, sessionId, Date.now()) },
    forget(sessionId) { data = forgotten(data, sessionId) },
  }
}
