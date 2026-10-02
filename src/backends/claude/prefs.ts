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
}

/** Read / patch access (injectable: tests use an in-memory store). */
export interface ClaudePrefs {
  read(): ClaudePrefsData
  /** Patch fields; `null` clears one. */
  write(patch: { readonly model?: string | null; readonly effort?: string | null }): void
}

const FILE = 'prefs.json'

/** The file-backed prefs under `<dir>` (default `~/.dsh-tui/backends/claude`). */
export function fileClaudePrefs(dir: string = join(DATA_DIR, 'backends', 'claude'), debug: (message: string) => void = () => undefined): ClaudePrefs {
  const path = join(dir, FILE)
  const read = (): ClaudePrefsData => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const record = parsed as Record<string, unknown>
      return {
        ...(typeof record.model === 'string' && record.model !== '' ? { model: record.model } : {}),
        ...(typeof record.effort === 'string' && record.effort !== '' ? { effort: record.effort } : {}),
      }
    } catch {
      return {}
    }
  }
  return {
    read,
    write(patch) {
      const next: Record<string, string> = { ...read() }
      for (const key of ['model', 'effort'] as const) {
        const value = patch[key]
        if (value === undefined) continue
        if (value === null) delete next[key]
        else next[key] = value
      }
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
      } catch (error) {
        debug(`claude: prefs write failed (${error instanceof Error ? error.message : String(error)})`)
      }
    },
  }
}

/** An in-memory store (tests, embedders without a home directory). */
export function memoryClaudePrefs(initial: ClaudePrefsData = {}): ClaudePrefs & { readonly data: ClaudePrefsData } {
  let data: ClaudePrefsData = { ...initial }
  return {
    get data() { return data },
    read: () => data,
    write(patch) {
      const next: Record<string, string> = { ...data }
      for (const key of ['model', 'effort'] as const) {
        const value = patch[key]
        if (value === undefined) continue
        if (value === null) delete next[key]
        else next[key] = value
      }
      data = next
    },
  }
}
