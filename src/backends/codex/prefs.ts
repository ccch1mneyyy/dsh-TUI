/**
 * The Codex backend's persisted user choices
 * (`~/.dsh-tui/backends/codex/prefs.json`, docs/codex-backend-design.md
 * §5.18, D6): the model / effort / mode picks a later session starts with,
 * the session a bare `--backend codex --resume` opens, and this install's
 * last use of each thread. dsh-tui never writes Codex's own
 * `config.toml`; these apply per thread through `thread/start` /
 * `turn/start`.
 *
 * Best-effort like every `~/.dsh-tui` preference: a missing or corrupt file
 * reads as "no choice", a failed write goes to the debug log.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../../utils/paths.js'
import { writeFileAtomic } from '../shared/atomic-file.js'
import { CODEX_MODE_PARAMS, DEFAULT_CODEX_MODE, isCodexModeId, type CodexModeId } from './modes.js'
import { rec, type Rec } from './narrow.js'

export interface CodexPrefsData {
  readonly model?: string
  readonly effort?: string
  readonly mode?: CodexModeId
  /** Collaboration mode is independent of the permission preset. */
  readonly plan?: boolean
  /** The thread a bare `dsh-tui --backend codex --resume` opens (the
   *  launcher reads this field directly). */
  readonly lastSession?: string
  /** This install's last use of each thread (epoch ms; the newest kept). */
  readonly lastUsed?: Readonly<Record<string, number>>
  readonly colors?: Readonly<Record<string, string>>
}

/** A patch: a value sets the field, `null` clears it. */
export interface CodexPrefsPatch {
  readonly model?: string | null
  readonly effort?: string | null
  readonly mode?: CodexModeId | null
  readonly plan?: boolean | null
  readonly lastSession?: string | null
  readonly colors?: Readonly<Record<string, string>>
}

export interface CodexPrefs {
  read(): CodexPrefsData
  write(patch: CodexPrefsPatch): void
  touch(threadId: string): void
  forget(threadId: string): void
}

const FILE = 'prefs.json'
const LAST_USED_LIMIT = 200

function parse(parsed: unknown): CodexPrefsData {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const record = parsed as Record<string, unknown>
  const lastUsed: Record<string, number> = {}
  const colors = Object.fromEntries(Object.entries(rec(record.colors) ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string').slice(-LAST_USED_LIMIT))
  if (record.lastUsed !== null && typeof record.lastUsed === 'object' && !Array.isArray(record.lastUsed)) {
    for (const [id, value] of Object.entries(record.lastUsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) lastUsed[id] = value
    }
  }
  return {
    ...(typeof record.model === 'string' && record.model !== '' ? { model: record.model } : {}),
    ...(typeof record.effort === 'string' && record.effort !== '' ? { effort: record.effort } : {}),
    ...(isCodexModeId(record.mode) ? { mode: record.mode } : {}),
    ...(typeof record.plan === 'boolean' ? { plan: record.plan } : {}),
    ...(typeof record.lastSession === 'string' && record.lastSession !== '' ? { lastSession: record.lastSession } : {}),
    ...(Object.keys(lastUsed).length === 0 ? {} : { lastUsed }),
    ...(Object.keys(colors).length === 0 ? {} : { colors }),
  }
}

function patched(current: CodexPrefsData, patch: CodexPrefsPatch): CodexPrefsData {
  const next: Record<string, unknown> = { ...current }
  for (const key of ['model', 'effort', 'mode', 'plan', 'lastSession'] as const) {
    const value = patch[key]
    if (value === undefined) continue
    if (value === null) delete next[key]
    else next[key] = value
  }
  if (patch.colors !== undefined) next.colors = Object.fromEntries(Object.entries(patch.colors).slice(-LAST_USED_LIMIT))
  return next as CodexPrefsData
}

function touched(current: CodexPrefsData, threadId: string, now: number): CodexPrefsData {
  const entries = Object.entries({ ...current.lastUsed, [threadId]: now }).sort((a, b) => b[1] - a[1]).slice(0, LAST_USED_LIMIT)
  return { ...current, lastUsed: Object.fromEntries(entries) }
}

function forgotten(current: CodexPrefsData, threadId: string): CodexPrefsData {
  const lastUsed = { ...current.lastUsed }
  delete lastUsed[threadId]
  const next: Record<string, unknown> = { ...current, lastUsed }
  if (Object.keys(lastUsed).length === 0) delete next.lastUsed
  if (current.lastSession === threadId) delete next.lastSession
  return next as CodexPrefsData
}

/** Per-field start overrides: explicit prefs > config/read > defaults.
 * An unreadable config is not evidence that a user has no configuration. */
export function resolveCodexStartOptions(prefs: CodexPrefsData, config?: Rec): Rec {
  const mode = prefs.mode === undefined ? undefined : CODEX_MODE_PARAMS[prefs.mode]
  const defaults = CODEX_MODE_PARAMS[DEFAULT_CODEX_MODE]
  return {
    ...(mode !== undefined ? { approvalPolicy: mode.approvalPolicy } : config !== undefined && config.approval_policy == null ? { approvalPolicy: defaults.approvalPolicy } : {}),
    ...(mode !== undefined ? { sandbox: mode.sandbox } : config !== undefined && config.sandbox_mode == null ? { sandbox: defaults.sandbox } : {}),
    ...(prefs.model === undefined ? {} : { model: prefs.model }),
    ...(prefs.effort === undefined ? {} : { config: { model_reasoning_effort: prefs.effort } }),
  }
}

/** Unwrap config/read without accepting a malformed answer as defaults. */
export function codexConfigOf(answer: unknown): Rec | undefined {
  return rec(rec(answer)?.config)
}

/** The file-backed prefs under `<dir>` (default `~/.dsh-tui/backends/codex`). */
export function fileCodexPrefs(dir: string = join(DATA_DIR, 'backends', 'codex'), debug: (message: string) => void = () => undefined): CodexPrefs {
  const path = join(dir, FILE)
  const read = (): CodexPrefsData => {
    try {
      return parse(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      return {}
    }
  }
  const save = (next: CodexPrefsData): void => {
    try {
      writeFileAtomic(dir, FILE, `${JSON.stringify(next, null, 2)}\n`)
    } catch (error) {
      debug(`codex: prefs write failed (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return {
    read,
    write: patch => { save(patched(read(), patch)) },
    touch: threadId => { save(touched(read(), threadId, Date.now())) },
    forget: threadId => { save(forgotten(read(), threadId)) },
  }
}

/** An in-memory store (tests). */
export function memoryCodexPrefs(initial: CodexPrefsData = {}): CodexPrefs & { readonly data: CodexPrefsData } {
  let data: CodexPrefsData = { ...initial }
  return {
    get data() { return data },
    read: () => data,
    write(patch) { data = patched(data, patch) },
    touch(threadId) { data = touched(data, threadId, Date.now()) },
    forget(threadId) { data = forgotten(data, threadId) },
  }
}
