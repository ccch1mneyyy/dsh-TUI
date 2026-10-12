/**
 * The TUI's own settings document, `~/.dsh-tui/settings.json`: the
 * `/settings` user layer of the `dsh-tui` namespace for every kernel. A boot
 * that finds no document imports the DSH profile patch's `dsh-tui` row (and an
 * older host's `settings.yaml` section) once;
 * the patch is never written.
 * Unlike the other ~/.dsh-tui preferences a failed write throws: the settings
 * screen reports it.
 */
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parse } from 'yaml'
import { DATA_DIR } from './utils/paths.js'
import { dshHomeDir } from './utils/credentials.js'
import { isRecord } from './backends/shared/jsonl.js'

export interface TuiSettingsDocument {
  readonly version: 1
  /** The sparse user layer: only what the user set. */
  readonly values: Readonly<Record<string, unknown>>
  /** The one-time import from the DSH profile patch (absent = never ran). */
  readonly imported?: { readonly from: string; readonly at: number }
}

export const TUI_SETTINGS_FILE = join(DATA_DIR, 'settings.json')

/** The document, or undefined when there is none yet. A broken file reads as
 *  an empty layer (and is not re-imported over). Never throws. */
export function readTuiSettings(file: string = TUI_SETTINGS_FILE): TuiSettingsDocument | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed)) return { version: 1, values: {}, imported: { from: 'unreadable', at: 0 } }
    const imported = isRecord(parsed.imported) && typeof parsed.imported.from === 'string' && typeof parsed.imported.at === 'number'
      ? { from: parsed.imported.from, at: parsed.imported.at }
      : undefined
    return { version: 1, values: isRecord(parsed.values) ? parsed.values : {}, ...(imported === undefined ? {} : { imported }) }
  } catch {
    return { version: 1, values: {}, imported: { from: 'unreadable', at: 0 } }
  }
}

/**
 * Before the first write over a document `readTuiSettings` could not parse,
 * keep its original bytes beside it as `<file>.corrupt-<timestamp>` (mode
 * 0600). Returns the backup path; throws when the bytes cannot be preserved
 * — the caller must then not replace the file.
 */
export function backupUnreadableTuiSettings(file: string = TUI_SETTINGS_FILE): string {
  const backup = join(dirname(file), `${basename(file)}.corrupt-${new Date().toISOString().replaceAll(':', '').replace('.', '-')}`)
  writeFileSync(backup, readFileSync(file), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return backup
}

let temporarySequence = 0

/** Write the document atomically; throws when it cannot be written. */
export function writeTuiSettings(document: TuiSettingsDocument, file: string = TUI_SETTINGS_FILE): void {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.${temporarySequence++}.tmp`)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  } catch (error) {
    try { rmSync(temporary, { force: true }) } catch { /* the old file is intact */ }
    throw error
  }
}

/**
 * Write the document only when there is none yet; false when another process
 * created it first. The complete file appears at once (a hard link of the
 * temporary, which fails on an existing name); a filesystem without hard links
 * falls back to an exclusive create, which never replaces a document either.
 * Throws when it cannot be written.
 */
export function createTuiSettings(document: TuiSettingsDocument, file: string = TUI_SETTINGS_FILE): boolean {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.${temporarySequence++}.tmp`)
  const text = `${JSON.stringify(document, null, 2)}\n`
  const exists = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'EEXIST'
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    try {
      linkSync(temporary, file)
    } catch (error) {
      if (exists(error)) return false
      try {
        writeFileSync(file, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      } catch (fallbackError) {
        if (exists(fallbackError)) return false
        throw fallbackError
      }
    }
    return true
  } finally {
    try { rmSync(temporary, { force: true }) } catch { /* a leftover temporary is harmless */ }
  }
}

/** The DSH profile's own patch layer, where DSH persisted the `/settings` layer. */
export function profilePatchPath(profile: string): string {
  return join(dshHomeDir(), 'profiles', profile, 'cordis.patch.yml')
}

/**
 * The `dsh-tui` row's `config` in a DSH profile patch, restricted to `keys`
 * (the editable fields; deployment fields such as the provider route stay in
 * the profile). Undefined when the file or the row is missing or unreadable.
 * `!!js` expressions are not evaluated: such a field is skipped (a top-level
 * one's source is recorded in `expressions`, when given).
 */
export function readProfileTuiSettings(path: string, keys: readonly string[], expressions?: Map<string, string>): Record<string, unknown> | undefined {
  let rows: unknown
  try {
    rows = parse(readFileSync(path, 'utf8'), {
      // `!!js` is the YAML core-schema prefix form of this tag. Never warn:
      // the TUI may be painting the terminal.
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (source: string) => new Skipped(source) }],
      logLevel: 'silent',
    })
  } catch {
    return undefined
  }
  if (!Array.isArray(rows)) return undefined
  // A later entry with the same id overrides an earlier one: take the last.
  const row: unknown = rows.findLast(entry => isRecord(entry) && entry.id === 'dsh-tui')
  if (!isRecord(row) || !isRecord(row.config)) return undefined
  for (const key of keys) {
    const value = (row.config as Record<string, unknown>)[key]
    if (value instanceof Skipped) expressions?.set(key, value.source)
  }
  return pickKeys(row.config, keys)
}

/**
 * The `ns` section of the `/settings` user layer older DSH hosts kept in
 * `<DSH home>/settings.yaml` (dsh-settings-file), restricted to `keys`. A DSH
 * that has since moved the document into the profile patch leaves it as
 * `settings.yaml.imported`; `pending` tells the two apart (a pending document
 * still overrides the patch, an imported one is already beneath it).
 */
export function readLegacyTuiSettings(ns: string, keys: readonly string[]): { readonly from: string; readonly pending: boolean; readonly values: Record<string, unknown> } | undefined {
  const document = join(dshHomeDir(), 'settings.yaml')
  for (const [from, pending] of [[document, true], [`${document}.imported`, false]] as const) {
    let root: unknown
    try {
      root = parse(readFileSync(from, 'utf8'), { logLevel: 'silent' })
    } catch {
      continue
    }
    // A document without this section (other namespaces only) defers to the next.
    const section = isRecord(root) ? root[ns] : undefined
    if (!isRecord(section)) continue
    return { from, pending, values: pickKeys(section, keys) }
  }
  return undefined
}

/** `over` laid on `under`: nested records merge, anything else replaces. */
export function mergeSettingsLayers(under: Readonly<Record<string, unknown>>, over: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...under }
  for (const [key, value] of Object.entries(over)) {
    const below = merged[key]
    merged[key] = isRecord(below) && isRecord(value) ? mergeSettingsLayers(below, value) : value
  }
  return merged
}

/** `keys` of `config`, with `!!js` expressions dropped at any depth. */
function pickKeys(config: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> {
  const strip = (value: unknown): unknown => {
    if (value instanceof Skipped) return undefined
    if (!isRecord(value)) return value
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      const kept = strip(entry)
      if (kept !== undefined) out[key] = kept
    }
    return out
  }
  const values: Record<string, unknown> = {}
  for (const key of keys) {
    const kept = strip(config[key])
    if (kept !== undefined) values[key] = kept
  }
  return values
}

/** A `!!js` expression left unevaluated. */
class Skipped {
  constructor(readonly source: string) {}
}
