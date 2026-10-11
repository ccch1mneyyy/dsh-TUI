/**
 * The Claude backend's persisted user choices
 * (`~/.dsh-tui/backends/claude/prefs.json`): the `/model`,
 * `/effort` and `/permission` picks a later session starts with. Backend-
 * scoped on purpose —
 * a Claude model id means nothing to the DSH `/model` preference, and the
 * CLI's own settings files are never written (the user's interactive
 * `claude` keeps its own choices).
 *
 * Best-effort like every `~/.dsh-tui` preference: a missing or corrupt file
 * reads as "no choice", a failed write is reported to the caller's debug
 * log and the session carries on.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../shared/atomic-file.js'

/** The permission modes the persisted choice may hold (the SDK's whole
 *  vocabulary). A stored `bypassPermissions` is never started in; the next
 *  start says so and clears it (options.ts, backend.ts). Anything else
 *  reads as no choice. */
export const CLAUDE_PERMISSION_MODES: readonly string[] = ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions']

/** What persists. */
export interface ClaudePrefsData {
  readonly model?: string
  readonly effort?: string
  /** The remembered `/permission` pick a later session starts in. */
  readonly permissionMode?: string
  /** The session a bare `dsh-tui --backend claude --resume` opens (the
   *  launcher reads this field directly; DSH's `resume.txt` never holds a
   *  Claude id). */
  readonly lastSession?: string
  /** This install's last use of each session (epoch ms): the session
   *  browser's MRU note, like DSH's `last-used.json`. */
  readonly lastUsed?: Readonly<Record<string, number>>
  /** The `/color` accent of each session (TUI-side: the CLI keeps none),
   *  with when it was set — the newest {@link COLOR_LIMIT} are kept. */
  readonly colors?: Readonly<Record<string, { readonly color: string; readonly at: number }>>
}

/** A patch: a value sets the field, `null` clears it. */
export interface ClaudePrefsPatch {
  readonly model?: string | null
  readonly effort?: string | null
  readonly permissionMode?: string | null
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
  /** A session's accent ('' = none). */
  color(sessionId: string): string
  /** Set (or with '' clear) a session's accent. */
  setColor(sessionId: string, color: string): void
}

const FILE = 'prefs.json'
/** MRU notes kept (oldest dropped first): the file stays small. */
const LAST_USED_LIMIT = 200
/** Session colours kept (the oldest set first is dropped). */
export const COLOR_LIMIT = 200

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
  const colors: Record<string, { color: string; at: number }> = {}
  const rawColors = record.colors
  if (rawColors !== null && typeof rawColors === 'object' && !Array.isArray(rawColors)) {
    for (const [id, value] of Object.entries(rawColors as Record<string, unknown>)) {
      const entry = value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
      if (typeof entry?.color === 'string' && entry.color !== '' && typeof entry.at === 'number' && Number.isFinite(entry.at)) colors[id] = { color: entry.color, at: entry.at }
    }
  }
  return {
    ...(Object.keys(colors).length === 0 ? {} : { colors }),
    ...(typeof record.model === 'string' && record.model !== '' ? { model: record.model } : {}),
    ...(typeof record.effort === 'string' && record.effort !== '' ? { effort: record.effort } : {}),
    ...(typeof record.permissionMode === 'string' && CLAUDE_PERMISSION_MODES.includes(record.permissionMode) ? { permissionMode: record.permissionMode } : {}),
    ...(typeof record.lastSession === 'string' && record.lastSession !== '' ? { lastSession: record.lastSession } : {}),
    ...(Object.keys(lastUsed).length === 0 ? {} : { lastUsed }),
  }
}

/** Apply a patch (pure). */
function patched(current: ClaudePrefsData, patch: ClaudePrefsPatch): ClaudePrefsData {
  const next: Record<string, unknown> = { ...current }
  for (const key of ['model', 'effort', 'permissionMode', 'lastSession'] as const) {
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

/** Set or clear one session's colour (pure), keeping the newest {@link COLOR_LIMIT}. */
function coloured(current: ClaudePrefsData, sessionId: string, color: string, now: number): ClaudePrefsData {
  const colors: Record<string, { readonly color: string; readonly at: number }> = { ...current.colors }
  delete colors[sessionId]
  if (color !== '') colors[sessionId] = { color, at: now }
  const kept = Object.entries(colors).sort((a, b) => b[1].at - a[1].at).slice(0, COLOR_LIMIT)
  const next: Record<string, unknown> = { ...current, colors: Object.fromEntries(kept) }
  if (kept.length === 0) delete next.colors
  return next as ClaudePrefsData
}

/** Drop one session (pure). */
function forgotten(current: ClaudePrefsData, sessionId: string): ClaudePrefsData {
  const lastUsed = { ...current.lastUsed }
  delete lastUsed[sessionId]
  const colors = { ...current.colors }
  delete colors[sessionId]
  const next: Record<string, unknown> = { ...current, lastUsed, colors }
  if (Object.keys(lastUsed).length === 0) delete next.lastUsed
  if (Object.keys(colors).length === 0) delete next.colors
  if (current.lastSession === sessionId) delete next.lastSession
  return next as ClaudePrefsData
}

/** The file-backed prefs under `<dir>` (the host's `dataDir` for this
 *  backend). The directory is required: a backend never picks a location of
 *  its own under the host's data directory (D2, B-3). */
export function fileClaudePrefs(dir: string, debug: (message: string) => void = () => undefined): ClaudePrefs {
  const path = join(dir, FILE)
  const read = (): ClaudePrefsData => {
    try {
      return parsePrefs(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      return {}
    }
  }
  const save = (next: ClaudePrefsData): void => {
    // Atomic: a plain `writeFileSync` truncates the target first, and
    // another terminal's read-modify-write in that window would start from
    // `{}` and wipe every field it does not know.
    try {
      writeFileAtomic(dir, FILE, `${JSON.stringify(next, null, 2)}\n`)
    } catch (error) {
      debug(`claude: prefs write failed (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return {
    read,
    write: patch => { save(patched(read(), patch)) },
    touch: sessionId => { save(touched(read(), sessionId, Date.now())) },
    forget: sessionId => { save(forgotten(read(), sessionId)) },
    color: sessionId => read().colors?.[sessionId]?.color ?? '',
    setColor: (sessionId, color) => { save(coloured(read(), sessionId, color, Date.now())) },
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
    color: sessionId => data.colors?.[sessionId]?.color ?? '',
    setColor(sessionId, color) { data = coloured(data, sessionId, color, Date.now()) },
  }
}
