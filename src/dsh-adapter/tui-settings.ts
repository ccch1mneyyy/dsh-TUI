/**
 * The `dsh-tui` settings namespace served from the TUI's own document
 * (../tuiSettingsFile.ts) instead of the DSH profile, so every kernel reads and writes one user layer. Same shape as
 * the settings service the plugin and channel already consume; every other
 * namespace goes to `delegate` (the host's settings service, when mounted).
 */
import type Schema from '@deepseek-ai/schemastery'
import { logForDebugging } from '../utils/debug.js'
import { isRecord } from '../backends/shared/jsonl.js'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { backupUnreadableTuiSettings, createTuiSettings, mergeSettingsLayers, profilePatchPath, readLegacyTuiSettings, readProfileTuiSettings, readTuiSettings, TUI_SETTINGS_FILE, writeTuiSettings, type TuiSettingsDocument } from '../tuiSettingsFile.js'
import type { SettingsNamespaceWarning } from '../adapter/ports/channel-settings.js'

type PathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

interface Descriptor {
  readonly ns: string
  readonly revision: number
  readonly applies: 'live' | 'restart'
  readonly value?: unknown
  readonly user?: unknown
  /** A fault in the settings document itself, when there is one. */
  readonly warning?: SettingsNamespaceWarning
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
 * row and an older host's `settings.yaml` section (once per source; only the
 * first of concurrent imports is written). A pending `settings.yaml` is the
 * user layer above the row, as on those hosts; one DSH already moved into the
 * patch (`.imported`) sits beneath it, since the patch may be newer. A later
 * boot under a profile whose patch the document was not imported from lays
 * that row beneath the user layer (explicit values always win) and records
 * the new source — the first profile no longer pins the document forever.
 */
function loadTuiSettings(input: {
  readonly file?: string
  readonly ns: string
  readonly profile: string
  readonly keys: readonly string[]
}): TuiSettingsDocument {
  const file = input.file ?? TUI_SETTINGS_FILE
  const existing = readTuiSettings(file)
  if (existing !== undefined) {
    const patch = profilePatchPath(input.profile)
    // 'none' names no source; anything else is a list of imported paths.
    const sources = existing.imported?.from === undefined || existing.imported.from === 'none' ? [] : existing.imported.from.split(', ')
    // An unreadable document keeps this boot's copy; one already carrying
    // this profile's patch (or none at all, `imported`-less) is adopted as is.
    if (existing.imported === undefined || existing.imported.from === 'unreadable' || sources.includes(patch)) return existing
    const row = readProfileTuiSettings(patch, input.keys)
    if (row === undefined) return existing
    const reimported = (document: TuiSettingsDocument): TuiSettingsDocument => ({
      version: 1,
      values: mergeSettingsLayers(row, document.values),
      imported: { from: `${document.imported?.from}, ${patch}`, at: Date.now() },
    })
    try {
      // Re-read as late as possible: another process may have written since
      // the first read, and its keys must survive the merge. Not under the
      // writer lock — like the first import, the merge only ever adds keys.
      const fresh = readTuiSettings(file) ?? existing
      if (fresh.imported === undefined || fresh.imported.from === 'unreadable' || (fresh.imported.from !== 'none' && fresh.imported.from.split(', ').includes(patch))) return fresh
      const next = reimported(fresh)
      writeTuiSettings(next, file)
      return next
    } catch (error) {
      // Still usable for this boot; the next one retries the re-import.
      logForDebugging(`dsh-tui: settings re-import for "${input.profile}" could not be saved (${error instanceof Error ? error.message : String(error)})`)
      return reimported(existing)
    }
  }
  const patch = profilePatchPath(input.profile)
  const row = readProfileTuiSettings(patch, input.keys)
  const legacy = readLegacyTuiSettings(input.ns, input.keys)
  const values = legacy === undefined
    ? row ?? {}
    : legacy.pending ? mergeSettingsLayers(row ?? {}, legacy.values) : mergeSettingsLayers(legacy.values, row ?? {})
  const sources = [...(row === undefined ? [] : [patch]), ...(legacy === undefined ? [] : [legacy.from])]
  const document: TuiSettingsDocument = { version: 1, values, imported: { from: sources.length === 0 ? 'none' : sources.join(', '), at: Date.now() } }
  try {
    // Two first launches race here: the later one adopts the document the
    // earlier one created rather than replacing it.
    if (!createTuiSettings(document, file)) return readTuiSettings(file) ?? document
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
  let document = loadTuiSettings({ file, ns: input.ns, profile: input.profile, keys: input.keys })
  /** A fault in the document, shown through `describe` so callers (the
   * settings screen's badges) can see it without a debug flag. */
  let warning: SettingsNamespaceWarning | undefined = document.imported?.from === 'unreadable' ? { id: 'unreadable' } : undefined
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
  const describeOwn = (): Descriptor => ({ ...own, revision, value: resolved(), user: document.values, ...(warning === undefined ? {} : { warning }) })
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
      // The lock spans the re-read and the replace, so concurrent writers of
      // different keys both land (its `<file>.lock` sibling needs the directory).
      mkdirSync(dirname(file), { recursive: true })
      await withFileLock(file, async () => {
        const latest = readTuiSettings(file)
        if (latest !== undefined && latest.imported?.from !== 'unreadable') {
          document = latest
        } else if (latest?.imported?.from === 'unreadable') {
          // The first write over a document this boot could not parse must
          // never destroy the original bytes: keep them beside the file (a
          // failed backup aborts the write — the settings screen reports it).
          const backup = backupUnreadableTuiSettings(file)
          warning = { id: 'recovered', backup }
          logForDebugging(`dsh-tui: settings.json was unreadable; the original bytes were kept at ${backup}`)
        }
        const values = ops.reduce<Record<string, unknown>>((layer, op) => applySettingsOp(layer, op), { ...document.values })
        // The unreadable marker describes the file as read, not as rewritten.
        const { imported, ...rest } = document
        const next: TuiSettingsDocument = { ...rest, values, ...(imported === undefined || imported.from === 'unreadable' ? {} : { imported }) }
        writeTuiSettings(next, file)
        document = next
      })
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
