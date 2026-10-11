/**
 * The `dsh-tui` settings namespace served from the TUI's own document
 * (../tuiSettingsFile.ts) instead of the DSH profile, so every kernel reads and writes one user layer. Same shape as
 * the settings service the plugin and channel already consume; every other
 * namespace goes to `delegate` (the host's settings service, when mounted).
 */
import type Schema from '@deepseek-ai/schemastery'
import { logForDebugging } from '../utils/debug.js'
import { isRecord } from '../utils/jsonl.js'
import { profilePatchPath, readProfileTuiSettings, readTuiSettings, TUI_SETTINGS_FILE, writeTuiSettings, type TuiSettingsDocument } from '../tuiSettingsFile.js'

type PathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

interface Descriptor {
  readonly ns: string
  readonly revision: number
  readonly applies: 'live' | 'restart'
  readonly value?: unknown
  readonly user?: unknown
}

/** The settings service as the plugin and the channel consume it. */
export interface TuiSettingsService {
  register<T>(ns: string, schema: Schema<T>): { get(): T; watch(callback: (next: T) => void): () => void }
  describe(options?: { redactSecrets?: boolean }): readonly Descriptor[]
  mutate(ns: string, ops: readonly PathOp[], expectedRevision?: number): Promise<void>
  get(ns: string): unknown
}

/** What the composite forwards other namespaces to (structural). */
export interface DelegateSettings {
  describe(options?: { redactSecrets?: boolean }): readonly Descriptor[]
  mutate(ns: string, ops: readonly PathOp[], expectedRevision?: number): Promise<void>
  get?(ns: string): unknown
}

/** A stale-revision write, in the error shape the settings screen retries on. */
class SettingsConflictError extends Error {
  readonly code = 'SETTINGS_CONFLICT'
}

/** Apply one path op to a detached sparse layer; empty parents are pruned. */
function applySettingsOp(layer: Readonly<Record<string, unknown>>, op: PathOp): Record<string, unknown> {
  const [head, ...rest] = op.path
  if (head === undefined) {
    return op.op === 'set' && isRecord(op.value) ? { ...op.value } : {}
  }
  const next: Record<string, unknown> = { ...layer }
  if (rest.length === 0) {
    if (op.op === 'set') next[head] = op.value
    else delete next[head]
    return next
  }
  const child = isRecord(layer[head]) ? layer[head] : {}
  const updated = applySettingsOp(child, op.op === 'set' ? { op: 'set', path: rest, value: op.value } : { op: 'unset', path: rest })
  if (Object.keys(updated).length === 0) delete next[head]
  else next[head] = updated
  return next
}

/**
 * The first boot without a document imports the profile patch's `dsh-tui`
 * row (once; a document with any `imported` mark is never re-imported).
 */
function loadTuiSettings(input: {
  readonly file?: string
  readonly profile: string
  readonly keys: readonly string[]
}): TuiSettingsDocument {
  const file = input.file ?? TUI_SETTINGS_FILE
  const existing = readTuiSettings(file)
  if (existing !== undefined) return existing
  const from = profilePatchPath(input.profile)
  const values = readProfileTuiSettings(from, input.keys)
  const document: TuiSettingsDocument = { version: 1, values: values ?? {}, imported: { from: values === undefined ? 'none' : from, at: Date.now() } }
  try {
    writeTuiSettings(document, file)
  } catch (error) {
    // Still usable for this boot; the next one retries the import.
    logForDebugging(`dsh-tui: settings import could not be saved (${error instanceof Error ? error.message : String(error)})`)
  }
  return document
}

export function createTuiSettingsService(input: {
  /** The namespace this service owns (the plugin's settings namespace). */
  readonly ns: string
  readonly file?: string
  readonly profile: string
  /** The editable Config keys (what the import may take from the profile). */
  readonly keys: readonly string[]
  /** Read per call: the host's own settings service may register late. */
  readonly delegate?: () => DelegateSettings | undefined
}): TuiSettingsService {
  const file = input.file ?? TUI_SETTINGS_FILE
  let document = loadTuiSettings({ file, profile: input.profile, keys: input.keys })
  let revision = 0
  let schema: Schema<unknown> | undefined
  const watchers = new Set<(next: unknown) => void>()
  /** The resolved value: the user layer through the registered schema's
   *  defaults (an invalid layer resolves to the defaults alone). */
  const resolved = (): unknown => {
    if (schema === undefined) return document.values
    try {
      return schema(document.values)
    } catch (error) {
      logForDebugging(`dsh-tui: settings.json does not validate (${error instanceof Error ? error.message : String(error)}); using defaults`)
      try { return schema({}) } catch { return {} }
    }
  }
  const own: Descriptor = { ns: input.ns, revision: 0, applies: 'live' }
  const describeOwn = (): Descriptor => ({ ...own, revision, value: resolved(), user: document.values })
  return {
    register<T>(ns: string, registered: Schema<T>) {
      if (ns !== input.ns) throw new Error(`dsh-tui: settings namespace "${ns}" is not served here`)
      schema = registered as Schema<unknown>
      return {
        get: () => resolved() as T,
        watch(callback: (next: T) => void) {
          const watcher = (next: unknown): void => { callback(next as T) }
          watchers.add(watcher)
          return () => { watchers.delete(watcher) }
        },
      }
    },
    describe(options) {
      const others = input.delegate?.()?.describe(options).filter(row => row.ns !== input.ns) ?? []
      return [describeOwn(), ...others]
    },
    async mutate(ns, ops, expectedRevision) {
      if (ns !== input.ns) {
        const delegate = input.delegate?.()
        if (delegate === undefined) throw new Error(`dsh-tui: no settings namespace "${ns}"`)
        return delegate.mutate(ns, ops, expectedRevision)
      }
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        throw new SettingsConflictError(`dsh-tui: settings changed (revision ${revision}, expected ${expectedRevision})`)
      }
      // Apply onto the file as it is now: another dsh-tui process may have
      // written since boot (an unreadable file keeps this process's copy).
      const latest = readTuiSettings(file)
      if (latest !== undefined && latest.imported?.from !== 'unreadable') document = latest
      const values = ops.reduce<Record<string, unknown>>((layer, op) => applySettingsOp(layer, op), { ...document.values })
      // The unreadable marker describes the file as read, not as rewritten.
      const { imported, ...rest } = document
      const next: TuiSettingsDocument = { ...rest, values, ...(imported === undefined || imported.from === 'unreadable' ? {} : { imported }) }
      writeTuiSettings(next, file)
      document = next
      revision += 1
      const value = resolved()
      for (const watcher of [...watchers]) {
        try { watcher(value) } catch (error) {
          logForDebugging(`dsh-tui: settings watcher failed (${error instanceof Error ? error.message : String(error)})`)
        }
      }
    },
    get(ns) {
      if (ns === input.ns) return resolved()
      const delegate = input.delegate?.()
      return delegate?.get?.(ns) ?? delegate?.describe().find(row => row.ns === ns)?.value
    },
  }
}
