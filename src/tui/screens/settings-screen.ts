/**
 * The `/settings` screen on the pi-tui component contract (WP-03).
 *
 * Presentation only: plugin-declared sections from the `tuiSettingsSections`
 * seam render as editable forms; every write goes back through `SettingsForm`
 * (staged edits, revision-fenced `settings.mutate` path ops, one
 * SETTINGS_CONFLICT retry, secrets through the credentials seam). All of that
 * machinery stays in `src/dsh-adapter/settingsEditor.ts` — this class only
 * renders forms, routes keys and calls `save()`/`discard()`. Namespaces no
 * plugin declared a section for stay read-only with a YAML hint.
 *
 * Component contract: `render(width)` returns exactly the viewport height in
 * lines (the shell feeds it through `setViewportHeight`, the same convention
 * as the session browser), `handleInput(data)` routes raw terminal keys,
 * `invalidate()` is a no-op (nothing is cached between renders). `reload()`
 * re-reads sections/namespaces — the chat screen drives it when the
 * `subscribeSettingsSections` notification arrives; the subscription itself
 * is owned by the shell/controller, not by this component.
 *
 * The renderer boundary is `../public.js`: pi-tui supplies the component
 * contract, data arrives only through the `TuiCommands` sink, and the only
 * dsh-side imports are the allowed pure modules (i18n, theme) plus the
 * renderer-independent form model.
 */
import chalk from 'chalk'
import { getLang, t } from '../../i18n.js'
import { getActiveTheme } from '../../theme.js'
import {
  SettingsForm,
  type SettingsHost,
  type SettingsNamespaceView,
} from '../../dsh-adapter/settingsEditor.js'
import type {
  TuiSettingsField,
  TuiSettingsGroup,
  TuiSettingsSection,
} from '../../dsh-adapter/settings-sections.js'
import type { LocalizedDescriptions } from '../../commands.js'
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from '../public.js'
import type { TuiCommands } from '../commands.js'

/** What the screen is doing with the focused field. */
type SettingsMode = 'list' | 'edit'

interface EditingState {
  readonly ns: string
  readonly field: TuiSettingsField
  /** pi-tui Input used as the draft engine; the row keeps the compatibility
   *  `draft▌` / masked rendering instead of Input's own line. */
  readonly input: Input
}

interface ActiveGroup {
  readonly ns: string
  readonly id: string
}

/** One focusable row on either the root page or a group subpage. */
type FocusEntry =
  | { kind: 'field'; ns: string; field: TuiSettingsField }
  | { kind: 'group'; ns: string; group: TuiSettingsGroup }

/** One rendered block with its accounted height, for focus-follow windowing. */
interface RenderEntry {
  readonly key: string
  readonly lines: string[]
  /** Position in the focus order when this block is a field/group row. */
  readonly focus?: number
}

/** Pick the provider-owned translation for the active language. */
function pick(text: string, descriptions: LocalizedDescriptions | undefined): string {
  return descriptions?.[getLang()] ?? text
}

/** Compact one-line preview of a read-only namespace's resolved value. */
function valuePreview(value: unknown, budget: number): string {
  let raw: string
  try {
    raw = JSON.stringify(value) ?? 'undefined'
  } catch {
    raw = String(value)
  }
  return truncateToWidth(raw, Math.max(8, budget), '…')
}

const RGB_COLOR = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/

/**
 * Apply one legacy-compatible theme color value
 * (`rgb(r,g,b)` / `ansi:name` / `#hex`) with the local ANSI foreground helper.
 * Kept local so the screen depends only on the allowed pure modules.
 */
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

/** Render a `hint-*` dict string: the `**primary**` segment stays bold. */
function renderHintMarkup(text: string): string {
  const parts = text.split('**')
  if (parts.length < 3) return text
  return parts.map((part, index) => (index % 2 === 1 ? chalk.bold(part) : part)).join('')
}

/**
 * The settings screen. The TUI owns only presentation here; edits are staged,
 * never settled live — typing changes a draft, and only the explicit save
 * writes the durable document (see settingsEditor.ts for why).
 */
export class SettingsScreen implements Component {
  private readonly commands: TuiCommands
  private readonly onClose: () => void

  private host: SettingsHost | undefined
  private namespaces: readonly SettingsNamespaceView[] = []
  private sections: readonly TuiSettingsSection[] = []
  /** One form per section namespace; rebuilt by reload() under the reuse
   *  rule (a dirty form survives a namespace-view swap, keeping its drafts). */
  private forms = new Map<string, SettingsForm>()
  /** Configured status of every secret field's credential ref. */
  private secrets = new Map<string, boolean>()

  private mode: SettingsMode = 'list'
  private editing: EditingState | null = null
  private activeGroup: ActiveGroup | null = null
  private focusIndex = 0
  /** First line of the windowed entry list (focus-follow scrolling). */
  private windowStart = 0
  private notice: { text: string; tone: 'error' | 'success' } | undefined
  private viewportRows = 24
  /** Stale-guard for the async credential probes. */
  private probeToken = 0
  /** Async save/probe completions must not touch state after disposal. */
  private disposed = false

  constructor(deps: { commands: TuiCommands; onClose: () => void }) {
    this.commands = deps.commands
    this.onClose = deps.onClose
    this.reload()
  }

  /** Terminal rows the shell grants this screen; render() pads to exactly it. */
  setViewportHeight(rows: number): void {
    this.viewportRows = Math.max(1, Math.floor(rows))
  }

  /**
   * Re-read sections + namespaces through the command sink and rebuild the
   * forms. Driven by the chat screen on every `subscribeSettingsSections`
   * notification; also safe to call after any out-of-band settings change.
   */
  reload(): void {
    this.host = this.commands.settings.settingsHost()
    this.sections = this.commands.settings.settingsSections()
    this.namespaces = this.host?.listNamespaces() ?? []

    // A fresh namespace view replaces the form only while it holds no edits —
    // replacing a dirty form would discard the drafts the user is still typing.
    const next = new Map<string, SettingsForm>()
    if (this.host !== undefined) {
      for (const section of this.sections) {
        const view = this.namespaces.find(entry => entry.ns === section.ns)
        const kept = this.forms.get(section.ns)
        const reuse = kept !== undefined && (kept.namespace === view || kept.shell().dirty)
        next.set(section.ns, reuse ? kept : new SettingsForm(this.host, view, section.fields))
      }
    }
    this.forms = next

    // A section/group can disappear when a plugin unloads mid-session.
    if (this.activeGroup !== null && this.activeGroupSpec() === undefined) {
      this.activeGroup = null
      this.focusIndex = 0
      this.windowStart = 0
    }
    this.focusIndex = Math.min(this.focusIndex, Math.max(0, this.focusable().length - 1))
    this.probeSecrets()
  }

  /** Stop async completions (save, credential probes) from touching state. */
  dispose(): void {
    this.disposed = true
  }

  invalidate(): void {
    // No render cache; the editing Input holds nothing to invalidate either.
    this.editing?.input.invalidate()
  }

  // ── Input ────────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.mode === 'edit' && this.editing !== null) {
      // Submit/cancel land through the Input's onSubmit/onEscape callbacks.
      this.editing.input.handleInput(data)
      return
    }

    const focusable = this.focusable()
    const effFocus = Math.min(this.focusIndex, Math.max(0, focusable.length - 1))
    const focused = focusable.length === 0 ? undefined : focusable[effFocus]

    if (matchesKey(data, Key.up)) {
      this.focusIndex = Math.max(0, effFocus - 1)
    } else if (matchesKey(data, Key.down)) {
      this.focusIndex = Math.min(Math.max(0, focusable.length - 1), effFocus + 1)
    } else if (matchesKey(data, Key.enter) && focused !== undefined) {
      this.activate(focused)
    } else if (matchesKey(data, 's') && focused !== undefined) {
      this.commitSave(focused.ns)
    } else if (matchesKey(data, 'd') && focused !== undefined) {
      const form = this.forms.get(focused.ns)
      if (form?.saving) return
      form?.discard()
      this.notice = undefined
    } else if (matchesKey(data, Key.escape)) {
      this.escape()
    }
  }

  /** Enter on the focused row: open a group, cycle a boolean/select, or edit. */
  private activate(focused: FocusEntry): void {
    if (focused.kind === 'group') {
      this.activeGroup = { ns: focused.ns, id: focused.group.id }
      this.focusIndex = 0
      this.windowStart = 0
      return
    }
    const form = this.forms.get(focused.ns)
    // A save in flight owns the section's drafts; starting an edit mid-write
    // is exactly the lost-draft race the staged model exists to prevent.
    if (form === undefined || !form.available || form.saving) return
    if (focused.field.kind === 'boolean' || focused.field.kind === 'select') {
      this.cycleField(focused.ns, focused.field)
      return
    }
    const input = new Input()
    input.setValue(form.field(focused.field).text)
    // pi-tui Input seeds its cursor at 0; settings drafts append, so park the
    // cursor at the draft end (End key, through the public API).
    input.handleInput('\x1b[F')
    input.onSubmit = (value) => {
      // Re-fetch at submit time: a reload may have swapped the form mid-edit.
      this.forms.get(focused.ns)?.edit(focused.field, value)
      this.mode = 'list'
      this.editing = null
    }
    input.onEscape = () => {
      this.mode = 'list'
      this.editing = null
    }
    this.editing = { ns: focused.ns, field: focused.field, input }
    this.mode = 'edit'
  }

  /** Stage the next choice for a boolean/select field (Enter cycles). */
  private cycleField(ns: string, field: TuiSettingsField): void {
    const form = this.forms.get(ns)
    if (form === undefined || !form.available || form.saving) return
    const current = form.field(field).text
    if (field.kind === 'boolean') {
      form.edit(field, current === 'true' ? 'false' : 'true')
    } else {
      const options = field.options ?? []
      if (options.length === 0) return
      const index = options.findIndex(option => option.value === current)
      form.edit(field, options[(index + 1) % options.length]?.value ?? options[0]?.value ?? '')
    }
    this.notice = undefined
  }

  private commitSave(ns: string): void {
    const form = this.forms.get(ns)
    if (form === undefined || form.saving || !form.shell().dirty) return
    void form.save().then(ok => {
      if (this.disposed) return
      if (ok) {
        this.notice = { text: t('settings-saved', { ns }), tone: 'success' }
        // Re-seed the forms from fresh namespace views and re-probe secrets —
        // the save may have configured one.
        this.reload()
      } else {
        this.notice = { text: t('settings-save-failed', { ns }), tone: 'error' }
      }
    })
  }

  /**
   * Layered Escape: group subpage pops to the root first; at the root, staged
   * drafts — ANY dirty section, not just the focused one — are discarded
   * before the screen itself closes. A save in flight cannot be undone from
   * here; let it settle instead of discarding around it.
   */
  private escape(): void {
    if (this.activeGroupSpec() !== undefined) {
      // Group navigation never settles drafts; the root page owns discard/exit.
      this.activeGroup = null
      this.focusIndex = 0
      this.windowStart = 0
      return
    }
    const dirty = [...this.forms.values()].filter(form => form.shell().dirty)
    if (dirty.length > 0) {
      if (dirty.some(form => form.saving)) return
      for (const form of dirty) form.discard()
      this.notice = { text: t('settings-discarded'), tone: 'success' }
    } else {
      this.onClose()
    }
  }

  // ── Model helpers ──────────────────────────────────────────────────────────

  /** The focused group subpage's spec, undefined when navigating the root. */
  private activeGroupSpec(): { section: TuiSettingsSection; group: TuiSettingsGroup } | undefined {
    if (this.activeGroup === null) return undefined
    const section = this.sections.find(entry => entry.ns === this.activeGroup?.ns)
    const group = section?.groups?.find(entry => entry.id === this.activeGroup?.id)
    return section === undefined || group === undefined ? undefined : { section, group }
  }

  /** Focusable rows in display order for the current page. */
  private focusable(): FocusEntry[] {
    const active = this.activeGroupSpec()
    if (active !== undefined) {
      return active.section.fields
        .filter(field => field.group === active.group.id)
        .map(field => ({ kind: 'field', ns: active.section.ns, field }))
    }
    return this.sections.flatMap(section => [
      ...section.fields
        .filter(field => field.group === undefined)
        .map(field => ({ kind: 'field' as const, ns: section.ns, field })),
      ...(section.groups ?? []).map(group => ({ kind: 'group' as const, ns: section.ns, group })),
    ])
  }

  /** Resolve each secret field's configured flag once per reload/save. */
  private probeSecrets(): void {
    const host = this.host
    if (host === undefined) return
    const token = ++this.probeToken
    const pending = this.sections.flatMap(section =>
      section.fields
        .filter((field): field is TuiSettingsField & { secret: { ref: string } } => field.secret !== undefined)
        .map(async field =>
          [`${section.ns}:${field.path.join('.')}`, await host.credentialConfigured(field.secret.ref)] as const,
        ),
    )
    void Promise.all(pending).then(entries => {
      if (!this.disposed && token === this.probeToken) this.secrets = new Map(entries)
    })
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  render(width: number): string[] {
    const theme = getActiveTheme()
    const divider = chalk.dim('─'.repeat(Math.max(0, width)))

    const active = this.activeGroupSpec()
    const title = active !== undefined
      ? `${t('settings-title')} › ${pick(active.section.title, active.section.descriptions)} › ${pick(active.group.title, active.group.descriptions)}`
      : t('settings-title')
    const titleLeft = chalk.bold(title)
    const titleRight = this.host === undefined ? paint(t('settings-unavailable'), theme.warning) : ''
    const titlePad = Math.max(1, width - visibleWidth(titleLeft) - visibleWidth(titleRight))
    const titleLine = truncateToWidth(titleLeft + ' '.repeat(titlePad) + titleRight, width, '')

    const entries = this.buildEntries(width, active)

    // Focus-follow window: keep the focused entry fully inside the viewport.
    const viewport = Math.max(1, this.viewportRows - 4 - (this.notice === undefined ? 0 : 1))
    const focusable = this.focusable()
    const effFocus = Math.min(this.focusIndex, Math.max(0, focusable.length - 1))
    let totalLines = 0
    let focusedOffset = 0
    let focusedLines = 1
    for (const entry of entries) {
      if (entry.focus === effFocus) {
        focusedOffset = totalLines
        focusedLines = entry.lines.length
      }
      totalLines += entry.lines.length
    }
    if (focusedOffset < this.windowStart) {
      this.windowStart = focusedOffset
    } else if (focusedOffset + focusedLines > this.windowStart + viewport) {
      this.windowStart = focusedOffset + focusedLines - viewport
    }
    let entryOffset = 0
    const visible = entries.filter(entry => {
      const start = entryOffset
      entryOffset += entry.lines.length
      return start >= this.windowStart && start + entry.lines.length <= this.windowStart + viewport
    })

    const hint = this.mode === 'edit'
      ? t('settings-hint-edit')
      : active === undefined ? t('settings-hint-list') : t('settings-hint-group')
    const hintLine = chalk.dim.italic(renderHintMarkup(hint))

    const body: string[] = [titleLine, divider]
    for (const entry of visible) body.push(...entry.lines)
    const tail: string[] = []
    if (this.notice !== undefined) {
      tail.push(paint(this.notice.text, this.notice.tone === 'error' ? theme.error : theme.success))
    }
    tail.push(divider, hintLine)
    const fill = this.viewportRows - body.length - tail.length
    for (let i = 0; i < fill; i++) body.push('')
    return [...body, ...tail].slice(0, this.viewportRows)
  }

  /** The current page as accounted, pre-rendered blocks (root or group). */
  private buildEntries(width: number, active: { section: TuiSettingsSection; group: TuiSettingsGroup } | undefined): RenderEntry[] {
    const entries: RenderEntry[] = []
    const focusable = this.focusable()
    const effFocus = Math.min(this.focusIndex, Math.max(0, focusable.length - 1))
    const focused = focusable.length === 0 ? undefined : focusable[effFocus]
    const theme = getActiveTheme()
    let focusCursor = 0
    const addField = (section: TuiSettingsSection, field: TuiSettingsField): void => {
      const isFocused = focused?.kind === 'field' && focused.ns === section.ns && focused.field === field
      const index = focusCursor
      focusCursor += 1
      entries.push({
        key: `field:${section.ns}:${field.path.join('.')}`,
        lines: this.fieldLines(section, field, isFocused, width),
        focus: index,
      })
    }

    if (active !== undefined) {
      const groupFields = active.section.fields.filter(field => field.group === active.group.id)
      for (const field of groupFields) addField(active.section, field)
      if (groupFields.length === 0) {
        entries.push({ key: 'group:empty', lines: [chalk.dim(t('settings-group-empty'))] })
      }
      return entries
    }

    this.sections.forEach((section, sectionIndex) => {
      const form = this.forms.get(section.ns)
      const view = form?.namespace
      const shell = form?.shell()
      const headerLines: string[] = []
      if (sectionIndex > 0) headerLines.push('')
      let header = paint(chalk.bold(pick(section.title, section.descriptions)), theme.permission)
      header += chalk.dim(` (${section.ns})`)
      if (view?.applies === 'restart') header += paint(` [${t('settings-badge-restart')}]`, theme.warning)
      if (view === undefined) header += paint(` [${t('settings-section-unavailable')}]`, theme.warning)
      if (shell?.dirty === true) header += paint(` [${t('settings-badge-dirty')}]`, theme.suggestion)
      if (shell?.saving === true) header += chalk.dim(` [${t('settings-badge-saving')}]`)
      if (shell?.failed === true) header += paint(` [${t('settings-badge-failed')}]`, theme.error)
      headerLines.push(truncateToWidth(header, width, ''))
      entries.push({ key: `section:${section.ns}`, lines: headerLines })

      for (const field of section.fields) {
        if (field.group === undefined) addField(section, field)
      }
      for (const group of section.groups ?? []) {
        const isFocused = focused?.kind === 'group' && focused.ns === section.ns && focused.group === group
        const index = focusCursor
        focusCursor += 1
        const prefix = isFocused ? paint('❯ ', theme.suggestion) : '  '
        const label = isFocused ? chalk.bold(pick(group.title, group.descriptions)) : pick(group.title, group.descriptions)
        const arrow = isFocused ? paint('›', theme.suggestion) : '›'
        const pad = Math.max(1, width - visibleWidth(prefix + label) - visibleWidth(arrow))
        entries.push({
          key: `group:${section.ns}:${group.id}`,
          lines: [truncateToWidth(prefix + label + ' '.repeat(pad) + arrow, width, '')],
          focus: index,
        })
      }
    })

    const registeredNs = new Set(this.sections.map(section => section.ns))
    const readonlyNamespaces = this.namespaces.filter(entry => !registeredNs.has(entry.ns))
    if (readonlyNamespaces.length > 0) {
      entries.push({
        key: 'readonly:heading',
        lines: ['', chalk.dim(chalk.bold(t('settings-readonly-heading')))],
      })
      for (const entry of readonlyNamespaces) {
        let line = `  ${entry.ns}`
        if (entry.applies === 'restart') line += paint(` [${t('settings-badge-restart')}]`, theme.warning)
        line += chalk.dim(`  ${valuePreview(entry.value, 60)}`)
        entries.push({ key: `readonly:${entry.ns}`, lines: [truncateToWidth(line, width, '')] })
      }
      entries.push({
        key: 'readonly:hint',
        lines: [truncateToWidth(chalk.dim(`  ${t('settings-readonly-hint', { path: '~/.dsh/settings.yaml' })}`), width, '')],
      })
    }
    if (this.sections.length === 0 && readonlyNamespaces.length === 0) {
      entries.push({ key: 'empty', lines: [chalk.dim(t('settings-empty'))] })
    }
    return entries
  }

  /** One field row, plus its hint line when focused, in the settings layout. */
  private fieldLines(section: TuiSettingsSection, field: TuiSettingsField, isFocused: boolean, width: number): string[] {
    const theme = getActiveTheme()
    const ns = section.ns
    const form = this.forms.get(ns)
    const state = form?.field(field) ?? { text: '', overridden: false, invalid: false }
    const isEditing = isFocused && this.mode === 'edit' && this.editing !== null
    const label = pick(field.label, field.descriptions)
    const hint = field.hint !== undefined ? pick(field.hint, field.hintDescriptions) : undefined
    const draft = isEditing ? this.editing?.input.getValue() ?? '' : ''

    let value: string
    if (field.secret !== undefined) {
      const configured = this.secrets.get(`${ns}:${field.path.join('.')}`) === true
      if (isEditing) {
        value = '•'.repeat(draft.length) + '▌'
      } else if (state.text !== '') {
        value = `${'•'.repeat(state.text.length)} ${t('settings-secret-staged')}`
      } else {
        value = configured ? t('settings-secret-set') : t('settings-secret-unset')
      }
    } else if (isEditing) {
      value = `${draft}▌`
    } else if (state.text === '') {
      value = t('settings-field-empty')
    } else {
      value = state.text
    }

    const badgeInvalid = state.invalid ? `${t('settings-field-invalid')} ` : ''
    const badgeOverride = state.overridden ? `[${t('settings-badge-override')}] ` : ''
    const badgeStaged = form?.isStaged(field) === true && !isEditing ? '* ' : ''
    const leftPlain = `${isFocused ? '❯ ' : '  '}${label}`
    const valueBudget = Math.max(8, width - visibleWidth(leftPlain) - visibleWidth(badgeInvalid + badgeOverride + badgeStaged) - 2)
    const fitted = truncateToWidth(value, valueBudget, '…')

    const left = (isFocused ? paint('❯ ', theme.suggestion) : '  ') + (isFocused ? chalk.bold(label) : label)
    let right = ''
    if (badgeInvalid !== '') right += paint(badgeInvalid, theme.error)
    if (badgeOverride !== '') right += chalk.dim(badgeOverride)
    if (badgeStaged !== '') right += paint(badgeStaged, theme.suggestion)
    right += isEditing || isFocused
      ? paint(fitted, theme.suggestion)
      : state.text === ''
        ? chalk.dim(fitted)
        : fitted
    const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right))
    const lines = [truncateToWidth(left + ' '.repeat(pad) + right, width, '')]
    if (hint !== undefined && isFocused) {
      lines.push(truncateToWidth(chalk.dim(`    ${hint}`), width, ''))
    }
    return lines
  }
}
