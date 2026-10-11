/**
 * The TUI's own settings document, `~/.dsh-tui/settings.json`: the
 * `/settings` user layer of the `dsh-tui` namespace for every kernel. A boot
 * that finds no document imports the DSH profile patch's `dsh-tui` row once;
 * the patch is never written.
 * Unlike the other ~/.dsh-tui preferences a failed write throws: the settings
 * screen reports it.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parse } from 'yaml'
import { DATA_DIR } from './utils/paths.js'
import { dshHomeDir } from './utils/credentials.js'
import { isRecord } from './utils/jsonl.js'

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

/** The DSH profile's own patch layer, where DSH persisted the `/settings` layer. */
export function profilePatchPath(profile: string): string {
  return join(dshHomeDir(), 'profiles', profile, 'cordis.patch.yml')
}

/**
 * The `dsh-tui` row's `config` in a DSH profile patch, restricted to `keys`
 * (the editable fields; deployment fields such as the provider route stay in
 * the profile). Undefined when the file or the row is missing or unreadable.
 * `!!js` expressions are not evaluated: such a field is skipped.
 */
export function readProfileTuiSettings(path: string, keys: readonly string[]): Record<string, unknown> | undefined {
  let rows: unknown
  try {
    rows = parse(readFileSync(path, 'utf8'), {
      // `!!js` is the YAML core-schema prefix form of this tag. Never warn:
      // the TUI may be painting the terminal.
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: () => SKIPPED }],
      logLevel: 'silent',
    })
  } catch {
    return undefined
  }
  if (!Array.isArray(rows)) return undefined
  const row: unknown = rows.find(entry => isRecord(entry) && entry.id === 'dsh-tui')
  if (!isRecord(row) || !isRecord(row.config)) return undefined
  const config = row.config
  const strip = (value: unknown): unknown => {
    if (value === SKIPPED) return undefined
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

const SKIPPED = Symbol('skipped !!js expression')
