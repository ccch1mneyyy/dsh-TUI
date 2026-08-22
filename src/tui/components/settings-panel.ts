/**
 * The `/settings` panel (pi-style editor replacement), built on the fork's
 * `SettingsList`. The panel mounts in the chat root's editor slot — the
 * conversation stays visible above it — and every change writes immediately:
 * Enter/Space on a boolean/select cycles the value and lands one
 * revision-fenced `settings.mutate` path op (one SETTINGS_CONFLICT retry),
 * text/number/secret fields open a small input submenu, and secrets write
 * through the credentials seam (blank draft = keep current). A failed write
 * notifies and rolls the displayed value back to the stored one; live
 * application (lang/diffLayout/whale/…) rides the existing scope.watch chain
 * in the dsh-tui plugin, not this panel.
 *
 * Plugin-declared sections map onto the flat list: ungrouped fields are top
 * rows, declared groups (the 13 status-bar toggles) become a nested
 * `SettingsList` submenu, and namespaces no plugin declared a section for
 * stay read-only with a JSON preview submenu pointing at settings.yaml. When
 * several sections are registered the label carries the section title as a
 * prefix so search still reaches it.
 *
 * The renderer boundary is `../public.js`: pi-tui supplies the list/input
 * primitives, data arrives only through the `TuiCommands` sink, and the only
 * dsh-side imports are the allowed pure modules (i18n, theme) plus the
 * renderer-independent settings field helpers.
 */
import chalk from 'chalk'
import { getLang, t } from '../../i18n.js'
import { getActiveTheme } from '../../theme.js'
import type { LocalizedDescriptions } from '../../commands.js'
import {
  formatSettingValue,
  getPath,
  parseSettingText,
  writeSettingOps,
  type SettingsHost,
  type SettingsNamespaceView,
  type SettingsPathOp,
} from '../../dsh-adapter/settingsEditor.js'
import type {
  TuiSettingsField,
  TuiSettingsGroup,
  TuiSettingsSection,
} from '../../dsh-adapter/settings-sections.js'
import {
  Input,
  Key,
  matchesKey,
  SettingsList,
  truncateToWidth,
  visibleWidth,
  type Component,
  type SettingItem,
  type SettingsListTheme,
} from '../public.js'
import type { TuiCommands } from '../commands.js'

/** Rows of any one list on screen at once; with the search row, description
 *  and hint chrome the panel stays around 16 lines tall. */
const MAX_VISIBLE = 8

/** Pretty-printed JSON lines a read-only namespace submenu shows at most. */
const READONLY_PREVIEW_LINES = 8

interface FieldBinding {
  readonly ns: string
  readonly field: TuiSettingsField
  /**
   * `cycle` rows write in onChange (boolean/select); `editor` rows write
   * inside their input submenu, so their onChange (fired when the submenu
   * closes with a new display value) must not write again; `readonly` rows
   * never write.
   */
  readonly mode: 'cycle' | 'editor' | 'readonly'
  /** Cycle rows: displayed label → draft text for the field's parse. */
  readonly textByDisplay?: ReadonlyMap<string, string>
}

/** Pick the provider-owned translation for the active language. */
function pick(text: string, descriptions: LocalizedDescriptions | undefined): string {
  return descriptions?.[getLang()] ?? text
}

const RGB_COLOR = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/

/** Apply one Theme color value (`rgb(r,g,b)` / `ansi:name` / `#hex`). */
function paint(text: string, color: string | undefined): string {
  if (!color) return text
  if (color.startsWith('#')) return chalk.hex(color)(text)
  const rgb = RGB_COLOR.exec(color)
  if (rgb !== null) {
    return chalk.rgb(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]))(text)
  }
  if (color.startsWith('ansi:')) {
    const name = color.slice('ansi:'.length)
    const fn = (chalk as unknown as Record<string, unknown>)[name]
    if (typeof fn === 'function') return (fn as (text: string) => string)(text)
  }
  return text
}

/** Localized hint row: `**primary**` segments render bold, the rest dim italic. */
function hintLine(text: string): string {
  const parts = text.split('**')
  if (parts.length < 3) return chalk.dim.italic(text)
  return chalk.dim.italic(
    parts.map((part, index) => (index % 2 === 1 ? chalk.bold(part) : part)).join(''),
  )
}

/** Theme hooks resolved at render time so a theme swap repaints the open panel. */
function listTheme(): SettingsListTheme {
  return {
    label: (text, selected) => (selected ? chalk.bold(text) : text),
    value: (text, selected) => (selected ? paint(text, getActiveTheme().suggestion) : chalk.dim(text)),
    description: (text) => chalk.dim(text),
    cursor: paint('❯ ', getActiveTheme().suggestion),
    hint: (text) => chalk.dim.italic(text),
  }
}

/** The `/settings` panel component; the chat screen mounts it in the editor slot. */
export class SettingsPanel implements Component {
  private readonly commands: TuiCommands
  private readonly onClose: () => void
  private readonly unsubscribeSections: () => void

  private host: SettingsHost | undefined
  private bindings = new Map<string, FieldBinding>()
  /** The SettingsList that currently owns each item id (top list or an open
   *  group submenu) — write-failure rollbacks and secret probes address the
   *  row through it. */
  private itemOwners = new Map<string, SettingsList>()
  private list: SettingsList
  private disposed = false

  constructor(deps: { commands: TuiCommands; onClose: () => void }) {
    this.commands = deps.commands
    this.onClose = deps.onClose
    this.list = this.buildList()
    // A plugin (un)loading mid-session changes the section list; rebuild.
    this.unsubscribeSections = this.commands.settings.subscribeSettingsSections(() => {
      if (!this.disposed) this.list = this.buildList()
    })
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribeSections()
  }

  invalidate(): void {
    this.list.invalidate()
  }

  handleInput(data: string): void {
    // The list owns every key while the panel is open (navigation, cycling,
    // submenus and the search input); nothing leaks into the editor behind it.
    this.list.handleInput(data)
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const theme = getActiveTheme()
    const titleLeft = chalk.bold(t('settings-title'))
    const titleRight = this.host === undefined ? paint(t('settings-unavailable'), theme.warning) : ''
    const pad = Math.max(1, safeWidth - visibleWidth(titleLeft) - visibleWidth(titleRight))
    return [
      '',
      paint('─'.repeat(safeWidth), theme.permission),
      truncateToWidth(titleLeft + ' '.repeat(pad) + titleRight, safeWidth, ''),
      ...this.list.render(safeWidth),
    ]
  }

  // ── Model → items ────────────────────────────────────────────────────────

  private buildList(): SettingsList {
    this.host = this.commands.settings.settingsHost()
    const sections = this.commands.settings.settingsSections()
    const namespaces = this.host?.listNamespaces() ?? []
    this.bindings = new Map()
    this.itemOwners = new Map()

    const items: SettingItem[] = []
    for (const section of sections) {
      const view = namespaces.find(entry => entry.ns === section.ns)
      const prefix = sections.length > 1 ? `${pick(section.title, section.descriptions)} · ` : ''
      for (const field of section.fields) {
        if (field.group === undefined) items.push(this.fieldItem(section.ns, field, view, prefix))
      }
      for (const group of section.groups ?? []) {
        items.push(this.groupItem(section, group, view, prefix))
      }
    }

    // Namespaces no plugin declared a section for stay read-only.
    const declared = new Set(sections.map(section => section.ns))
    for (const view of namespaces) {
      if (!declared.has(view.ns)) items.push(this.readonlyItem(view))
    }

    const list = new SettingsList(
      items,
      MAX_VISIBLE,
      listTheme(),
      (id, display) => this.onItemChange(id, display),
      () => this.onClose(),
      {
        enableSearch: true,
        strings: {
          hint: `  ${t('settings-hint-panel')}`,
          noSettings: `  ${t('settings-empty')}`,
          noMatches: `  ${t('settings-no-matches')}`,
        },
      },
    )
    for (const item of items) this.itemOwners.set(item.id, list)
    this.probeSecrets(list, items)
    return list
  }

  /** One editable field row: cycle (boolean/select) or input-submenu. */
  private fieldItem(
    ns: string,
    field: TuiSettingsField,
    view: SettingsNamespaceView | undefined,
    labelPrefix: string,
  ): SettingItem {
    const id = `field:${ns}:${field.path.join('.')}`
    const label = labelPrefix + pick(field.label, field.descriptions)
    const hint = field.hint !== undefined ? pick(field.hint, field.hintDescriptions) : undefined
    const badges: string[] = []
    if (view === undefined) badges.push(`[${t('settings-section-unavailable')}]`)
    else if (view.applies === 'restart') badges.push(`[${t('settings-badge-restart')}]`)
    const description = [...badges, ...(hint !== undefined ? [hint] : [])].join(' ') || undefined

    // A section whose namespace the composition doesn't serve renders inert.
    if (view === undefined || this.host === undefined) {
      this.bindings.set(id, { ns, field, mode: 'readonly' })
      return { id, label, description, currentValue: '' }
    }

    if (field.secret === undefined && (field.kind === 'boolean' || field.kind === 'select')) {
      const rawText = formatSettingValue(field, getPath(view.value, field.path))
      const display = this.displayFor(field, rawText)
      const values = field.kind === 'boolean'
        ? [t('settings-value-on'), t('settings-value-off')]
        : (field.options ?? []).map(option => pick(option.label, option.descriptions))
      const textByDisplay = field.kind === 'boolean'
        ? new Map([[t('settings-value-on'), 'true'], [t('settings-value-off'), 'false']])
        : new Map((field.options ?? []).map(option => [pick(option.label, option.descriptions), option.value]))
      this.bindings.set(id, { ns, field, mode: 'cycle', textByDisplay })
      return { id, label, description, currentValue: display, values }
    }

    // text/number/secret edit through an input submenu.
    this.bindings.set(id, { ns, field, mode: 'editor' })
    const display = field.secret !== undefined
      ? t('settings-secret-unset') // probed async, then updated in place
      : this.displayFor(field, formatSettingValue(field, getPath(view.value, field.path)))
    return {
      id,
      label,
      description,
      currentValue: display,
      submenu: (_current, done) => this.openFieldEditor(ns, field, view, done),
    }
  }

  /** A declared group row; Enter opens the group's fields as a nested list. */
  private groupItem(
    section: TuiSettingsSection,
    group: TuiSettingsGroup,
    view: SettingsNamespaceView | undefined,
    labelPrefix: string,
  ): SettingItem {
    return {
      id: `group:${section.ns}:${group.id}`,
      label: labelPrefix + pick(group.title, group.descriptions),
      description: view?.applies === 'restart' ? `[${t('settings-badge-restart')}]` : undefined,
      currentValue: t('settings-configure'),
      submenu: (_current, done) => {
        // Re-read the namespace at open time so a value written earlier in
        // this panel session shows correctly when the group reopens.
        const fresh = this.host?.listNamespaces().find(entry => entry.ns === section.ns) ?? view
        return this.buildGroupList(section, group, fresh, done)
      },
    }
  }

  private buildGroupList(
    section: TuiSettingsSection,
    group: TuiSettingsGroup,
    view: SettingsNamespaceView | undefined,
    done: () => void,
  ): Component {
    const items = section.fields
      .filter(field => field.group === group.id)
      .map(field => this.fieldItem(section.ns, field, view, ''))
    const list = new SettingsList(
      items,
      Math.max(1, Math.min(items.length, MAX_VISIBLE)),
      listTheme(),
      (id, display) => this.onItemChange(id, display),
      () => done(),
      { strings: { hint: `  ${t('settings-hint-back')}`, noSettings: `  ${t('settings-group-empty')}` } },
    )
    for (const item of items) this.itemOwners.set(item.id, list)
    this.probeSecrets(list, items)
    return list
  }

  /** Read-only row for a namespace with no declared section: JSON preview. */
  private readonlyItem(view: SettingsNamespaceView): SettingItem {
    return {
      id: `readonly:${view.ns}`,
      label: view.ns,
      description: [
        ...(view.applies === 'restart' ? [`[${t('settings-badge-restart')}]`] : []),
        t('settings-readonly-hint', { path: '~/.dsh/settings.yaml' }),
      ].join(' '),
      currentValue: '',
      submenu: (_current, done) => new SettingsReadonlyView(view, () => done()),
    }
  }

  // ── Immediate writes ───────────────────────────────────────────────────────

  /** Cycle-row change (boolean/select): translate the label and write now. */
  private onItemChange(id: string, display: string): void {
    const binding = this.bindings.get(id)
    if (binding === undefined || binding.mode !== 'cycle') return
    const { ns, field, textByDisplay } = binding
    const text = textByDisplay?.get(display)
    const write = text === undefined ? undefined : parseSettingText(field, text)
    const host = this.host
    if (write === undefined || host === undefined) {
      this.rollbackDisplay(id)
      return
    }
    const view = host.listNamespaces().find(entry => entry.ns === ns)
    if (view === undefined) {
      this.rollbackDisplay(id)
      return
    }
    const ops: SettingsPathOp[] = [write.kind === 'clear'
      ? { op: 'unset', path: field.path }
      : { op: 'set', path: field.path, value: write.value }]
    void writeSettingOps(host, ns, ops, view.revision).catch(() => {
      if (this.disposed) return
      this.commands.info.notify(t('settings-save-failed', { ns }), { color: 'error' })
      this.rollbackDisplay(id)
    })
  }

  /** The input submenu for text/number/secret fields. */
  private openFieldEditor(
    ns: string,
    field: TuiSettingsField,
    view: SettingsNamespaceView,
    done: (display?: string) => void,
  ): Component {
    const secret = field.secret
    return new SettingsInputEditor({
      label: pick(field.label, field.descriptions),
      hint: field.hint !== undefined ? pick(field.hint, field.hintDescriptions) : undefined,
      // A credential literal never seeds the draft: blank until typed.
      initial: secret !== undefined ? '' : formatSettingValue(field, getPath(view.value, field.path)),
      masked: secret !== undefined,
      placeholder: field.placeholder,
      apply: async (text) => {
        const host = this.host
        if (host === undefined) return { ok: false as const, error: t('settings-save-failed', { ns }) }
        if (secret !== undefined) {
          try {
            await host.writeCredential(secret.ref, text)
          } catch {
            return { ok: false as const, error: t('settings-save-failed', { ns }) }
          }
          return { ok: true as const, display: t('settings-secret-set') }
        }
        const write = parseSettingText(field, text)
        if (write === undefined) return { ok: false as const, error: t('settings-field-invalid') }
        const fresh = host.listNamespaces().find(entry => entry.ns === ns)
        if (fresh === undefined) return { ok: false as const, error: t('settings-save-failed', { ns }) }
        const ops: SettingsPathOp[] = [write.kind === 'clear'
          ? { op: 'unset', path: field.path }
          : { op: 'set', path: field.path, value: write.value }]
        try {
          await writeSettingOps(host, ns, ops, fresh.revision)
        } catch {
          return { ok: false as const, error: t('settings-save-failed', { ns }) }
        }
        const display = write.kind === 'clear'
          ? t('settings-field-empty')
          : this.displayFor(field, formatSettingValue(field, write.value))
        return { ok: true as const, display }
      },
      done,
    })
  }

  /** Restore a row's displayed value from the stored document after a failed write. */
  private rollbackDisplay(id: string): void {
    const binding = this.bindings.get(id)
    if (binding === undefined) return
    const view = this.host?.listNamespaces().find(entry => entry.ns === binding.ns)
    const rawText = formatSettingValue(binding.field, view === undefined ? undefined : getPath(view.value, binding.field.path))
    this.itemOwners.get(id)?.updateValue(id, this.displayFor(binding.field, rawText))
  }

  /** Display text for a stored value: option labels for selects, on/off for booleans. */
  private displayFor(field: TuiSettingsField, rawText: string): string {
    if (field.kind === 'boolean') {
      if (rawText === 'true') return t('settings-value-on')
      if (rawText === 'false') return t('settings-value-off')
    }
    if (field.kind === 'select') {
      const matched = field.options?.find(option => option.value === rawText)
      if (matched !== undefined) return pick(matched.label, matched.descriptions)
    }
    return rawText === '' ? t('settings-field-empty') : rawText
  }

  /** Refresh every secret row's configured flag on the list that owns it. */
  private probeSecrets(list: SettingsList, items: readonly SettingItem[]): void {
    const host = this.host
    if (host === undefined) return
    for (const item of items) {
      const binding = this.bindings.get(item.id)
      if (binding?.field.secret === undefined) continue
      const ref = binding.field.secret.ref
      void host.credentialConfigured(ref).then(configured => {
        if (this.disposed) return
        list.updateValue(item.id, configured ? t('settings-secret-set') : t('settings-secret-unset'))
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Submenu components
// ---------------------------------------------------------------------------

interface SettingsInputEditorOptions {
  readonly label: string
  readonly hint?: string
  readonly initial: string
  readonly masked: boolean
  readonly placeholder?: string
  /** Persist the draft; resolves to the new display value or the error to show. */
  readonly apply: (text: string) => Promise<{ ok: true; display: string } | { ok: false; error: string }>
  readonly done: (display?: string) => void
}

/**
 * One-field input editor (text/number, or masked secret): the label and hint
 * on top, the draft row, an inline error line when the last apply failed, and
 * the key hint. Enter saves; a blank secret draft writes nothing. Esc backs
 * out without writing.
 */
class SettingsInputEditor implements Component {
  private readonly options: SettingsInputEditorOptions
  private readonly input = new Input()
  private error: string | undefined
  private pending = false

  constructor(options: SettingsInputEditorOptions) {
    this.options = options
    if (options.initial !== '') {
      this.input.setValue(options.initial)
      // pi-tui Input seeds its cursor at 0; editing appends, so park the
      // cursor at the draft end (End key, through the public API).
      this.input.handleInput('\x1b[F')
    }
    this.input.onSubmit = (value) => {
      void this.submit(value)
    }
    this.input.onEscape = () => this.options.done()
  }

  private async submit(value: string): Promise<void> {
    if (this.pending) return
    // Blank secret drafts write nothing: the configured credential stays.
    if (this.options.masked && value === '') {
      this.options.done()
      return
    }
    this.pending = true
    this.error = undefined
    const result = await this.options.apply(value)
    this.pending = false
    if (result.ok) this.options.done(result.display)
    else this.error = result.error
  }

  invalidate(): void {
    this.input.invalidate()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const contentWidth = Math.max(1, safeWidth - 2)
    const lines: string[] = [truncateToWidth(`  ${chalk.bold(this.options.label)}`, safeWidth, '')]
    if (this.options.hint !== undefined) {
      lines.push(truncateToWidth(chalk.dim(`  ${this.options.hint}`), safeWidth, ''))
    }
    lines.push('')
    if (this.options.masked) {
      lines.push(truncateToWidth(`  ${'•'.repeat(this.input.getValue().length)}▌`, safeWidth, ''))
    } else if (this.input.getValue() === '' && this.options.placeholder !== undefined) {
      lines.push(truncateToWidth(chalk.dim(`  ${this.options.placeholder}`), safeWidth, ''))
    } else {
      lines.push(...this.input.render(contentWidth).map(line => `  ${line}`))
    }
    if (this.error !== undefined) {
      lines.push(truncateToWidth(paint(`  ${this.error}`, getActiveTheme().error), safeWidth, ''))
    }
    lines.push('')
    lines.push(truncateToWidth(
      hintLine(`  ${t(this.options.masked ? 'settings-secret-hint' : 'settings-hint-edit')}`),
      safeWidth,
      '',
    ))
    return lines
  }

  handleInput(data: string): void {
    // A save in flight owns the draft; ignore keys until it settles.
    if (this.pending) return
    this.input.handleInput(data)
  }
}

/**
 * Read-only namespace submenu: the resolved value as capped pretty JSON plus
 * the hand-edit hint. Enter/Esc backs out; every other key is swallowed.
 */
class SettingsReadonlyView implements Component {
  private readonly view: SettingsNamespaceView
  private readonly done: () => void

  constructor(view: SettingsNamespaceView, done: () => void) {
    this.view = view
    this.done = done
  }

  invalidate(): void {
    // Static between opens; nothing cached per width.
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const lines: string[] = [truncateToWidth(`  ${chalk.bold(this.view.ns)}`, safeWidth, ''), '']
    let preview: string[]
    try {
      preview = JSON.stringify(this.view.value, null, 2).split('\n')
    } catch {
      preview = [String(this.view.value)]
    }
    const capped = preview.slice(0, READONLY_PREVIEW_LINES)
    if (preview.length > capped.length) capped.push('…')
    for (const line of capped) lines.push(truncateToWidth(chalk.dim(`  ${line}`), safeWidth, ''))
    lines.push('')
    lines.push(truncateToWidth(chalk.dim(`  ${t('settings-readonly-hint', { path: '~/.dsh/settings.yaml' })}`), safeWidth, ''))
    lines.push(truncateToWidth(chalk.dim.italic(`  ${t('settings-hint-readonly')}`), safeWidth, ''))
    return lines
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) this.done()
  }
}
