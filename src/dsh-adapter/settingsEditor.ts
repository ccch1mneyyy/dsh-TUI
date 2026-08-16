/**
 * React-free form model behind the `/settings` screen (issue #165), mirroring
 * the web front door's card-form.ts semantics: a section stages what the user
 * types and writes it only on save — every settings write is a durable,
 * revision-fenced `settings.mutate`, so a control that committed as it
 * settled turned one edit into a write the user never asked for and could
 * not preview; staged text makes what is on screen exactly what a save would
 * store.
 *
 * A field shows its effective value — the user layer over the composition
 * layer over the schema default — and whether the user layer carries it. That
 * presence, not a value comparison, is what marks a field overridden: an
 * override equal to the composition default is still an override.
 *
 * The kernel side (storage, schema validation, layering, revision fencing)
 * stays with the dsh settings / credentials services; this module only
 * translates between drafts and `mutate` path ops.
 */

import type { TuiSettingsField, TuiSettingsFieldWrite } from './settings-sections.js'

/** One settings namespace as the screen reads it (secrets redacted). */
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
 * Runtime capabilities the settings screen needs, implemented by the channel
 * over the dsh `settings` / `credentials` seams. `undefined` from
 * `channel.settingsHost()` means the composition lacks them (bare cordis.yml
 * start) and the screen shows namespaces read-only.
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

/** One field as the screen renders it. */
export interface SettingsFieldState {
  /** Draft text the control renders. */
  text: string
  /** Whether saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** Whether the draft is not a value this field accepts, blocking the save. */
  invalid: boolean
}

/** Form state every settings section shares. */
export interface SettingsSectionShell {
  /** False while the settings service serves no such namespace. */
  available: boolean
  /** Whether the form holds edits that a save would write. */
  dirty: boolean
  /** Whether any staged draft is invalid, which blocks the save. */
  invalid: boolean
  /** Whether a save is in flight. */
  saving: boolean
  /** Whether the last save failed; cleared by the next edit or save. */
  failed: boolean
}

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
 * Whether a value explicitly carries the path — its presence marks a user
 * override, independent of the value stored there.
 */
export function hasPath(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) return value !== undefined
  const parent = getPath(value, path.slice(0, -1))
  const key = path[path.length - 1] as string
  if (Array.isArray(parent)) return Number(key) < parent.length
  if (typeof parent !== 'object' || parent === null) return false
  return key in parent
}

/** Default draft text for a kind; the empty string when the section carries none. */
function defaultFormat(field: TuiSettingsField, value: unknown): string {
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

/** Default write for a kind: an empty text/number draft stages a clear. */
function defaultParse(field: TuiSettingsField, text: string): TuiSettingsFieldWrite | undefined {
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

/** Key addressing one field inside a form: its path joined. */
function fieldKey(field: TuiSettingsField): string {
  return field.path.join('.')
}

interface StagedEdit {
  /** Draft text the control renders. */
  text: string
  /** True when this edit clears the field whatever text it shows. */
  clear: boolean
}

/**
 * The staged form over one settings namespace's declared fields. The screen
 * re-seeds it from a fresh namespace view after every save and whenever the
 * underlying document changes.
 */
export class SettingsForm {
  private readonly edits = new Map<string, StagedEdit>()
  saving = false
  failed = false

  constructor(
    private readonly host: SettingsHost,
    private readonly view: SettingsNamespaceView | undefined,
    private readonly fields: readonly TuiSettingsField[],
  ) {}

  get available(): boolean {
    return this.view !== undefined
  }

  /** The namespace view the form was seeded from (undefined = not served). */
  get namespace(): SettingsNamespaceView | undefined {
    return this.view
  }

  field(field: TuiSettingsField): SettingsFieldState {
    const key = fieldKey(field)
    const staged = this.edits.get(key)
    if (field.secret !== undefined) {
      // A credential literal never seeds a draft: blank until typed, and a
      // blank draft writes nothing.
      return { text: staged?.text ?? '', overridden: false, invalid: false }
    }
    if (staged !== undefined) {
      const write = defaultParse(field, staged.text)
      return {
        text: staged.text,
        overridden: write?.kind === 'set',
        invalid: write === undefined,
      }
    }
    return {
      text: defaultFormat(field, this.view ? getPath(this.view.value, field.path) : undefined),
      overridden: this.view !== undefined && hasPath(this.view.user, field.path),
      invalid: false,
    }
  }

  shell(): SettingsSectionShell {
    let invalid = false
    for (const field of this.fields) {
      if (this.field(field).invalid) invalid = true
    }
    return {
      available: this.available,
      dirty: this.edits.size > 0,
      invalid,
      saving: this.saving,
      failed: this.failed,
    }
  }

  /** Whether the field holds a staged (unsaved) edit. */
  isStaged(field: TuiSettingsField): boolean {
    return this.edits.has(fieldKey(field))
  }

  /** Stage draft text for one field. */
  edit(field: TuiSettingsField, text: string): void {
    this.edits.set(fieldKey(field), { text, clear: false })
    this.failed = false
  }

  /** Stage a clear, so saving lets the field re-inherit the composition layer. */
  resetField(field: TuiSettingsField): void {
    this.edits.set(fieldKey(field), { text: '', clear: true })
    this.failed = false
  }

  /** Drop every staged edit. */
  discard(): void {
    this.edits.clear()
    this.failed = false
  }

  /** Whether any staged draft is invalid, which blocks the save. */
  get invalid(): boolean {
    return this.shell().invalid
  }

  /**
   * Write every staged edit. Settings fields land as one revision-fenced
   * `mutate` (one retry on a stale-revision conflict); credential fields
   * write through the credentials seam. Resolves to whether every write
   * landed — the caller re-seeds from a fresh namespace view afterwards.
   *
   * Only the edits THIS save snapshotted are cleared on success, and only
   * when they are still the same edit: a draft typed while the write was in
   * flight is a newer object and survives — it was never written, so it must
   * not be silently dropped.
   */
  async save(): Promise<boolean> {
    if (this.view === undefined || this.invalid || this.saving) return false
    const ns = this.view.ns
    const snapshot = new Map(this.edits)
    const ops: SettingsPathOp[] = []
    const secrets: { ref: string; text: string }[] = []
    for (const field of this.fields) {
      const staged = snapshot.get(fieldKey(field))
      if (staged === undefined) continue
      if (field.secret !== undefined) {
        // Blank drafts write nothing; typed drafts replace the credential.
        if (staged.text !== '') secrets.push({ ref: field.secret.ref, text: staged.text })
        continue
      }
      const write = staged.clear ? ({ kind: 'clear' } as const) : defaultParse(field, staged.text)
      if (write === undefined) return false
      ops.push(write.kind === 'clear'
        ? { op: 'unset', path: field.path }
        : { op: 'set', path: field.path, value: write.value })
    }
    this.saving = true
    try {
      if (ops.length > 0) {
        try {
          await this.host.write(ns, ops, this.view.revision)
        } catch (error) {
          // One retry on a stale-revision conflict (a concurrent write landed
          // between seed and save); anything else propagates.
          if ((error as { code?: unknown })?.code !== 'SETTINGS_CONFLICT') throw error
          const fresh = this.host.listNamespaces().find(entry => entry.ns === ns)
          await this.host.write(ns, ops, fresh?.revision)
        }
      }
      for (const secret of secrets) {
        await this.host.writeCredential(secret.ref, secret.text)
      }
      for (const [key, edit] of snapshot) {
        if (this.edits.get(key) === edit) this.edits.delete(key)
      }
      this.failed = false
      return true
    } catch {
      this.failed = true
      return false
    } finally {
      this.saving = false
    }
  }

  /** Whether any layer supplies the credential a secret field addresses. */
  credentialConfigured(field: TuiSettingsField): Promise<boolean> {
    return field.secret === undefined ? Promise.resolve(false) : this.host.credentialConfigured(field.secret.ref)
  }
}
