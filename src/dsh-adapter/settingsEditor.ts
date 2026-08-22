/**
 * Host contract and pure field helpers behind the `/settings` panel — the
 * pi-style bottom-panel settings list that replaced the old staged form
 * screen. Every change writes immediately: the panel translates the edited
 * display text into a `mutate` path op ({@link parseSettingText}) and issues
 * one durable, revision-fenced write ({@link writeSettingOps}); secrets ride
 * the credentials seam (`SettingsHost.writeCredential`), never the settings
 * document. The old staged `SettingsForm` went away with the full-screen
 * settings page — there is exactly one edit in flight, the one on screen, so
 * there is nothing to stage.
 *
 * A field shows its effective value — the user layer over the composition
 * layer over the schema default — rendered through {@link formatSettingValue}
 * (or the field's own `format`).
 *
 * The kernel side (storage, schema validation, layering, revision fencing)
 * stays with the dsh settings / credentials services; this module only
 * translates between display text and `mutate` path ops.
 */

import type { TuiSettingsField, TuiSettingsFieldWrite } from './settings-sections.js'

/** One settings namespace as the panel reads it (secrets redacted). */
export interface SettingsNamespaceView {
  readonly ns: string
  /** Monotonic revision of the raw user section; fences writes. */
  readonly revision: number
  /** 'live' applies immediately; 'restart' needs a relaunch. */
  readonly applies: 'live' | 'restart'
  /** Current resolved value (all layers composed). */
  readonly value: unknown
  /** Raw user layer; a path present here is a user override. */
  readonly user: unknown
}

/**
 * Runtime capabilities the settings panel needs, implemented by the channel
 * over the dsh `settings` / `credentials` seams. `undefined` from
 * `channel.settingsHost()` means the composition lacks them (bare cordis.yml
 * start) and the panel shows namespaces read-only.
 */
export interface SettingsHost {
  /** Every registered namespace, secrets redacted, in registration order. */
  listNamespaces(): readonly SettingsNamespaceView[]
  /** Write path ops against a namespace, fenced by its current revision. */
  write(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>
  /** Whether any layer supplies a credential under `ref`. */
  credentialConfigured(ref: string): Promise<boolean>
  /** Persist a credential; rejects when env-shadowed or the store is read-only. */
  writeCredential(ref: string, value: string): Promise<void>
}

export type SettingsPathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

/** Read a nested value by path (array indexes as strings). */
export function getPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (Array.isArray(current)) {
      current = current[Number(key)]
      continue
    }
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * Render a stored value as display text. Defaults to the kind's conversion
 * (strings verbatim, numbers via `String`, booleans/selects by value); the
 * field's own `format` wins when declared.
 */
export function formatSettingValue(field: TuiSettingsField, value: unknown): string {
  if (field.format) return field.format(value)
  if (value === undefined || value === null) return ''
  switch (field.kind) {
    case 'number':
      return typeof value === 'number' ? String(value) : ''
    case 'boolean':
      return value === true ? 'true' : 'false'
    default:
      return typeof value === 'string' ? value : String(value)
  }
}

/**
 * The write a display text translates to, or `undefined` when the text is
 * not a value this field accepts. Defaults to the kind's conversion (an
 * empty text/number draft clears the field, letting it re-inherit the
 * composition layer); the field's own `parse` wins when declared.
 */
export function parseSettingText(field: TuiSettingsField, text: string): TuiSettingsFieldWrite | undefined {
  if (field.parse) return field.parse(text)
  const trimmed = text.trim()
  switch (field.kind) {
    case 'number': {
      if (trimmed === '') return { kind: 'clear' }
      const value = Number(trimmed)
      return Number.isFinite(value) ? { kind: 'set', value } : undefined
    }
    case 'boolean':
      return { kind: 'set', value: trimmed === 'true' }
    case 'select':
      return field.options?.some(option => option.value === trimmed)
        ? { kind: 'set', value: trimmed }
        : undefined
    default:
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: text }
  }
}

/**
 * One revision-fenced write with a single retry on a stale-revision conflict
 * (a concurrent write landed between the panel's seed and this write);
 * anything else propagates to the caller.
 */
export async function writeSettingOps(
  host: SettingsHost,
  ns: string,
  ops: readonly SettingsPathOp[],
  expectedRevision: number | undefined,
): Promise<void> {
  try {
    await host.write(ns, ops, expectedRevision)
  } catch (error) {
    if ((error as { code?: unknown })?.code !== 'SETTINGS_CONFLICT') throw error
    const fresh = host.listNamespaces().find(entry => entry.ns === ns)
    await host.write(ns, ops, fresh?.revision)
  }
}
