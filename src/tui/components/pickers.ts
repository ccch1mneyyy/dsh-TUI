/**
 * pi-tui picker family (plan §1.3, WP-03): the old React/Ink picker dialogs
 * (`src/components/*Picker.tsx`, `Select.tsx`, …) re-expressed as imperative
 * pi-tui Components.
 *
 * One generic `PickerView` carries the shared chrome — pane divider, bold
 * title, optional subtitle, optional search input row, a SelectList body and
 * a footer hint line — and the twelve factories below adapt each old picker
 * to it (or stand alone where the shape is not a list: EffortSlider,
 * TipsPanel, BtwPanel).
 *
 * Contracts honored here:
 * - Data flows IN through the constructor (payloads + callbacks); components
 *   never query `TuiCommands` themselves — the chat screen awaits the
 *   commands, builds the payloads and receives the selection callbacks.
 * - Keyboard handling never compares raw literals: `matchesKey(data, Key.x)`
 *   only, and confirm is plain Enter (`Key.enter` does not match
 *   Option/Ctrl+Enter — see packages/pi-tui/src/keys.ts).
 * - Long-list windowing is SelectList's own (`maxVisible` centered on the
 *   selected index, focus row always on screen, scroll position line) — no
 *   dsh-side window logic (regressions #396 / #picker-windowing). Every
 *   rendered line is truncated to the given width: zero wrapped rows.
 * - Colors come from `getActiveTheme()`; copy stays localized through
 *   `src/i18n.js` (both pure modules, no React/Ink/Channel imports).
 */
import chalk from 'chalk'
import {
  Input,
  Key,
  matchesKey,
  SelectList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type SelectItem,
  type SelectListTheme,
} from '../public.js'
import { getActiveTheme } from '../../theme.js'
import { getLang, t } from '../../i18n.js'
import { TIPS, TIP_GROUP_LABELS, type TipGroup } from '../../tips.js'

// ---------------------------------------------------------------------------
// Theme / styling helpers
// ---------------------------------------------------------------------------

/** Resolve a Theme color value (`rgb(r,g,b)`, `#hex` or `ansi:<name>`) to a chalk styler. */
function themed(color: string): (text: string) => string {
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(color)
  if (rgb) return chalk.rgb(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]))
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color)) return chalk.hex(color)
  const ansi = /^ansi:(\w+)$/.exec(color)
  const name = ansi ? ansi[1]! : color
  const named = (chalk as unknown as Record<string, unknown>)[name]
  return typeof named === 'function' ? (named as (text: string) => string) : (text) => text
}

const dim = (text: string): string => chalk.dim(text)

/** Localized hint line: `**primary**` segments render bold, the rest dim italic (old HintLine). */
function hintLine(text: string): string {
  const parts = text.split('**')
  if (parts.length < 3) return chalk.italic(dim(text))
  return chalk.italic(parts.map((part, index) => (index % 2 === 1 ? chalk.bold(part) : dim(part))).join(''))
}

function selectTheme(): SelectListTheme {
  const theme = getActiveTheme()
  const accent = themed(theme.suggestion)
  return {
    selectedPrefix: accent,
    selectedText: (text) => accent(text),
    description: (text) => dim(text),
    scrollInfo: (text) => dim(text),
    noMatch: (text) => dim(text),
  }
}

/** Pane chrome from the old design-system: blank row + full-width divider in the pane color. */
function divider(width: number): string {
  return themed(getActiveTheme().permission)('─'.repeat(Math.max(width, 1)))
}

/** Left indent every old Pane content row carried (`paddingX={2}`). */
const INDENT = '  '

function indentLines(lines: readonly string[], width: number): string[] {
  const contentWidth = Math.max(width - visibleWidth(INDENT), 1)
  return lines.map((line) => INDENT + truncateToWidth(line, contentWidth, ''))
}

// ---------------------------------------------------------------------------
// Generic PickerView
// ---------------------------------------------------------------------------

export interface PickerViewOptions<T> {
  /** Bold title row (pane color family, old `picker-title-*` copy). */
  title: string
  /** Optional dim row under the title (e.g. rewind/thinking subtitles). */
  subtitle?: string
  items: readonly T[]
  /** Map a payload to a list row. `value` is opaque (selection round-trips by index). */
  toItem: (item: T) => { label: string; description?: string }
  /** Marks the active row with a themed ✓ (old ListItem isSelected). */
  isActive?: (item: T) => boolean
  /** Show a search input row; typing refilters the list (case-insensitive substring). */
  searchable?: boolean
  /** Row shown when the (filtered) list is empty. Defaults to a dim dash. */
  emptyText?: string
  /** Footer hint (already localized by the factory). */
  footerHint: string
  /** Rows of the list on screen at once (SelectList window height). Default 8. */
  maxVisible?: number
  onSelect: (item: T) => void
  onClose: () => void
}

const DEFAULT_MAX_VISIBLE = 8

/**
 * Title + (optional) filter input + windowed SelectList + footer hint. The
 * picker owns the keyboard while open: ↑/↓ navigate (SelectList wraps at the
 * ends), plain Enter confirms the focused row, Esc or Ctrl+C closes; every
 * other key goes to the search input when searchable, and is swallowed
 * otherwise so nothing leaks into the prompt input behind the picker.
 */
export class PickerView<T> implements Component {
  private readonly options: PickerViewOptions<T>
  private readonly maxVisible: number
  private readonly input: Input | undefined
  private query = ''
  private visibleItems: readonly T[]
  private list: SelectList

  constructor(options: PickerViewOptions<T>) {
    this.options = options
    this.maxVisible = Math.max(options.maxVisible ?? DEFAULT_MAX_VISIBLE, 1)
    this.visibleItems = options.items
    this.list = this.buildList(this.visibleItems)
    if (options.searchable) {
      this.input = new Input()
    }
  }

  private toSelectItem(item: T, index: number): SelectItem {
    const { label, description } = this.options.toItem(item)
    const active = this.options.isActive?.(item) === true
    const marked = active ? `${label} ${themed(getActiveTheme().remember)('✓')}` : label
    return {
      value: String(index),
      label: marked,
      ...(description === undefined ? {} : { description }),
    }
  }

  private buildList(items: readonly T[]): SelectList {
    const list = new SelectList(items.map((item, index) => this.toSelectItem(item, index)), this.maxVisible, selectTheme())
    list.onSelect = (selected) => {
      const item = this.visibleItems[Number(selected.value)]
      if (item !== undefined) this.options.onSelect(item)
    }
    return list
  }

  /** Case-insensitive substring filter over the row label. (Facade gap: the
   *  fork's fuzzyFilter is not re-exported through src/tui/public.ts yet —
   *  swap this one function when it is.) */
  private refilter(): void {
    const query = this.query.trim().toLowerCase()
    this.visibleItems =
      query === ''
        ? this.options.items
        : this.options.items.filter((item) => this.options.toItem(item).label.toLowerCase().includes(query))
    this.list = this.buildList(this.visibleItems)
  }

  invalidate(): void {
    this.list.invalidate()
    this.input?.invalidate()
  }

  render(width: number): string[] {
    const { title, subtitle, emptyText, footerHint } = this.options
    const contentWidth = Math.max(width - visibleWidth(INDENT), 1)
    const lines: string[] = ['', divider(width)]
    lines.push(...indentLines([chalk.bold(themed(getActiveTheme().remember)(title))], width))
    if (subtitle !== undefined) {
      lines.push(...indentLines([dim(subtitle)], width))
    }
    lines.push('')
    if (this.input !== undefined) {
      lines.push(...indentLines(this.input.render(contentWidth), width))
    }
    if (this.visibleItems.length === 0) {
      lines.push(...indentLines([dim(emptyText ?? '—')], width))
    } else {
      lines.push(...indentLines(this.list.render(contentWidth), width))
    }
    lines.push(...indentLines([hintLine(footerHint)], width))
    return lines
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.options.onClose()
      return
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter)) {
      this.list.handleInput(data)
      return
    }
    if (this.input !== undefined) {
      this.input.handleInput(data)
      const value = this.input.getValue()
      if (value !== this.query) {
        this.query = value
        this.refilter()
      }
    }
    // Non-searchable pickers swallow every other key while open.
  }
}

// ---------------------------------------------------------------------------
// Payload types (structural; the chat screen maps the channel types onto them)
// ---------------------------------------------------------------------------

export interface ModelPickerModel {
  provider: string
  id: string
  name?: string
  description?: string
}

export interface PresetPickerPreset {
  id: string
  name?: string
  description?: string
  isDefault?: boolean
  /** Non-empty when the preset failed to load; the reason is shown instead of the description. */
  broken?: string
}

export interface ThemePickerEntry {
  name: string
  displayName?: string
  description?: string
  /** Preview colors (Theme color values); each renders as a ██ swatch after the name. */
  colors?: readonly string[]
}

export interface SkillPickerSkill {
  name: string
  description?: string
  source: string
  userInvocable: boolean
}

export interface ActivityPickerPreset {
  name: string
  /** Frame preview or other dim description row. */
  description?: string
}

export interface WorkspacePickerTarget {
  uri: string
  label: string
  badge?: string
  description?: string
  cwd?: string
}

/** A user message row (structural over ChatRow). */
export interface RewindPickerRow {
  id: string
  text: string
}

export interface EffortSliderLevel {
  id: string
  name: string
  description?: string
}

/** One `/permission` picker row (structural; the chat screen maps the
 *  configured session modes onto it). */
export interface PermissionModeOption {
  id: string
  label: string
  description?: string
}

export interface HistorySearchEntry {
  text: string
  ts: number
}

// ---------------------------------------------------------------------------
// List pickers
// ---------------------------------------------------------------------------

/** `/model` — models payload comes from `commands.model.listModels()` at the call site. */
export function createModelPicker(options: {
  models: readonly ModelPickerModel[]
  current: { provider: string; model: string }
  searchable?: boolean
  onSelect: (provider: string, id: string) => void
  onClose: () => void
}): Component {
  return new PickerView<ModelPickerModel>({
    title: t('picker-title-model'),
    items: options.models,
    toItem: (model) => ({
      label: `${model.provider} / ${model.name ?? model.id}`,
      ...(model.description === undefined ? {} : { description: model.description }),
    }),
    isActive: (model) => model.provider === options.current.provider && model.id === options.current.model,
    searchable: options.searchable ?? true,
    footerHint: t('hint-confirm-exit'),
    onSelect: (model) => options.onSelect(model.provider, model.id),
    onClose: options.onClose,
  })
}

/** Agent-preset picker (issue #8); broken presets stay listed with their reason. */
export function createPresetPicker(options: {
  presets: readonly PresetPickerPreset[]
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
}): Component {
  return new PickerView<PresetPickerPreset>({
    title: 'Agent preset',
    items: options.presets,
    toItem: (preset) => ({
      label:
        (preset.name ?? preset.id) +
        (preset.isDefault ? t('preset-default-tag') : '') +
        (preset.broken !== undefined ? t('preset-broken-tag') : ''),
      description: preset.broken ?? preset.description ?? preset.id,
    }),
    isActive: (preset) => preset.id === options.activeId,
    footerHint: t('hint-confirm-exit'),
    onSelect: (preset) => options.onSelect(preset.id),
    onClose: options.onClose,
  })
}

/** `/theme` — entries (incl. swatch colors) are built by the caller from the theme registry. */
export function createThemePicker(options: {
  themes: readonly ThemePickerEntry[]
  activeId: string | undefined
  onSelect: (name: string) => void
  onClose: () => void
}): Component {
  return new PickerView<ThemePickerEntry>({
    title: t('picker-title-theme'),
    items: options.themes,
    toItem: (entry) => ({
      label:
        (entry.displayName ?? entry.name) +
        (entry.colors !== undefined && entry.colors.length > 0
          ? `  ${entry.colors.map((color) => themed(color)('██')).join('')}`
          : ''),
      ...(entry.description === undefined ? {} : { description: entry.description }),
    }),
    isActive: (entry) => entry.name === options.activeId,
    footerHint: t('hint-confirm-exit'),
    maxVisible: 6,
    onSelect: (entry) => options.onSelect(entry.name),
    onClose: options.onClose,
  })
}

/** `/skills` — only user-invocable skills can be picked (they fill `/name ` upstream). */
export function createSkillsPicker(options: {
  skills: readonly SkillPickerSkill[]
  searchable?: boolean
  onSelect: (name: string) => void
  onClose: () => void
}): Component {
  return new PickerView<SkillPickerSkill>({
    title: t('picker-title-skills'),
    items: options.skills,
    toItem: (skill) => ({
      label: skill.userInvocable ? `/${skill.name}` : skill.name,
      description: `${skillSourceLabel(skill.source)}${skill.description ? ` · ${skill.description}` : ''}`,
    }),
    searchable: options.searchable ?? true,
    emptyText: t('skills-empty'),
    footerHint: t('hint-fill-exit'),
    onSelect: (skill) => {
      if (skill.userInvocable) options.onSelect(skill.name)
    },
    onClose: options.onClose,
  })
}

function skillSourceLabel(source: string): string {
  switch (source) {
    case 'bundled':
      return t('skills-source-bundled')
    case 'user-dsh':
    case 'user-agents':
      return t('skills-source-user')
    case 'project-dsh':
    case 'project-agents':
      return t('skills-source-project')
    case 'runtime':
      return t('skills-source-runtime')
    case 'custom':
      return t('skills-source-custom')
    default:
      return source
  }
}

/** `/activity` working-indicator preset picker. */
export function createActivityPicker(options: {
  presets: readonly ActivityPickerPreset[]
  activeName: string | undefined
  onSelect: (name: string) => void
  onClose: () => void
}): Component {
  return new PickerView<ActivityPickerPreset>({
    title: t('picker-title-activity'),
    items: options.presets,
    toItem: (preset) => ({
      label: preset.name,
      ...(preset.description === undefined ? {} : { description: preset.description }),
    }),
    isActive: (preset) => preset.name === options.activeName,
    footerHint: t('hint-confirm-exit'),
    onSelect: (preset) => options.onSelect(preset.name),
    onClose: options.onClose,
  })
}

/** `/workspace` target picker. */
export function createWorkspacePicker(options: {
  workspaces: readonly WorkspacePickerTarget[]
  cwd: string
  searchable?: boolean
  onSelect: (target: WorkspacePickerTarget) => void
  onClose: () => void
}): Component {
  return new PickerView<WorkspacePickerTarget>({
    title: t('workspace-picker-title'),
    items: options.workspaces,
    toItem: (target) => ({
      label: target.badge !== undefined ? `${target.badge} · ${target.label}` : target.label,
      description: target.description ?? target.uri,
    }),
    isActive: (target) => target.cwd !== undefined && target.cwd === options.cwd,
    searchable: options.searchable ?? true,
    footerHint: t('workspace-picker-hint'),
    maxVisible: 8,
    onSelect: options.onSelect,
    onClose: options.onClose,
  })
}

/** Double-Esc rewind picker: user messages newest-first; the confirm/mode
 *  step (commands.session.promptRewind) stays with the chat screen. */
export function createRewindPicker(options: {
  rows: readonly RewindPickerRow[]
  onSelect: (row: RewindPickerRow) => void
  onClose: () => void
}): Component {
  return new PickerView<RewindPickerRow>({
    title: t('rewind-title'),
    subtitle: t('rewind-subtitle'),
    items: options.rows,
    toItem: (row) => ({ label: previewRow(row.text) }),
    emptyText: t('rewind-empty'),
    footerHint: t('hint-select-exit'),
    onSelect: options.onSelect,
    onClose: options.onClose,
  })
}

/** One-line preview of a message (newlines flattened, capped), old RewindPicker rule. */
function previewRow(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`
}

/** Ctrl+R history search: filter input row + matches newest-first with relative ages. */
export function createHistorySearch(options: {
  entries: readonly HistorySearchEntry[]
  onSelect: (text: string) => void
  onClose: () => void
}): Component {
  return new PickerView<HistorySearchEntry>({
    title: t('history-search-title'),
    items: options.entries,
    toItem: (entry) => ({ label: entry.text.replace(/\s+/g, ' ').trim(), description: formatRelativeAge(entry.ts) }),
    searchable: true,
    emptyText: t('history-search-empty'),
    footerHint: t('hint-history-search'),
    onSelect: (entry) => options.onSelect(entry.text),
    onClose: options.onClose,
  })
}

/** Relative age like CC's formatRelativeTimeAgo ("now" / "5m ago" / …), localized. */
function formatRelativeAge(ts: number): string {
  const elapsed = Date.now() - ts
  if (elapsed < 60_000) return t('time-now')
  if (elapsed < 3_600_000) return t('time-minutes-ago', { n: Math.floor(elapsed / 60_000) })
  if (elapsed < 86_400_000) return t('time-hours-ago', { n: Math.floor(elapsed / 3_600_000) })
  return t('time-days-ago', { n: Math.floor(elapsed / 86_400_000) })
}

/** `/thinking` display dialog: Shown/Hidden select; Enter applies and closes. */
export function createThinkingToggle(options: {
  visible: boolean
  onToggle: (visible: boolean) => void
  onClose: () => void
}): Component {
  const choices = [
    { value: true, label: t('thinking-enabled'), description: t('thinking-enabled-desc') },
    { value: false, label: t('thinking-disabled'), description: t('thinking-disabled-desc') },
  ]
  return new PickerView<(typeof choices)[number]>({
    title: t('thinking-title'),
    subtitle: t('thinking-subtitle'),
    items: choices,
    toItem: (choice) => ({ label: choice.label, description: choice.description }),
    isActive: (choice) => choice.value === options.visible,
    footerHint: t('hint-confirm-exit'),
    maxVisible: 2,
    onSelect: (choice) => {
      options.onToggle(choice.value)
      options.onClose()
    },
    onClose: options.onClose,
  })
}

/** `/permission` — session permission-mode picker over the configured
 *  Shift+Tab modes (Kimi-style choice list; the current mode carries ✓). */
export function createPermissionPicker(options: {
  modes: readonly PermissionModeOption[]
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
}): Component {
  return new PickerView<PermissionModeOption>({
    title: t('picker-title-permission'),
    items: options.modes,
    toItem: (mode) => ({
      label: mode.label,
      ...(mode.description === undefined ? {} : { description: mode.description }),
    }),
    isActive: (mode) => mode.id === options.activeId,
    footerHint: t('hint-confirm-exit'),
    onSelect: (mode) => options.onSelect(mode.id),
    onClose: options.onClose,
  })
}

// ---------------------------------------------------------------------------
// EffortSlider (segmented row, not a list)
// ---------------------------------------------------------------------------

/**
 * Reasoning-effort picker (`/effort`): one row of segments, the focused one
 * wrapped in `[ ]` (the Kimi-style segmented control). ←/→ step the focus —
 * clamped at the ends — without applying; plain Enter commits the focused
 * level through `onSelect` (which also closes), Esc/Ctrl+C cancels. The
 * currently applied level carries `✓`; the focused level's description
 * renders below the row.
 */
export function createEffortSlider(options: {
  levels: readonly EffortSliderLevel[]
  current: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
}): Component {
  return new EffortSliderView(options)
}

class EffortSliderView implements Component {
  private readonly options: {
    levels: readonly EffortSliderLevel[]
    current: string | undefined
    onSelect: (id: string) => void
    onClose: () => void
  }
  private focusIndex: number

  constructor(options: {
    levels: readonly EffortSliderLevel[]
    current: string | undefined
    onSelect: (id: string) => void
    onClose: () => void
  }) {
    this.options = options
    const currentIndex = options.levels.findIndex((level) => level.id === options.current)
    this.focusIndex = currentIndex >= 0 ? currentIndex : 0
  }

  invalidate(): void {
    // No cached state.
  }

  render(width: number): string[] {
    const theme = getActiveTheme()
    const { levels, current } = this.options
    const row = levels
      .map((level, index) => {
        const name = level.id === current ? `${level.name}${themed(theme.remember)('✓')}` : level.name
        return index === this.focusIndex ? chalk.bold(themed(theme.remember)(`[ ${name} ]`)) : `  ${name}  `
      })
      .join('  ')
    const focused = levels[this.focusIndex]
    const lines: string[] = ['', divider(width)]
    lines.push(...indentLines([chalk.bold(themed(theme.remember)(t('picker-title-effort')))], width))
    lines.push('')
    lines.push(...indentLines([row], width))
    if (focused?.description !== undefined) {
      lines.push(...indentLines([dim(focused.description)], width))
    }
    lines.push(...indentLines([hintLine(t('hint-effort-picker'))], width))
    return lines
  }

  handleInput(data: string): void {
    const { levels, onSelect, onClose } = this.options
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      onClose()
      return
    }
    if (matchesKey(data, Key.enter)) {
      const focused = levels[this.focusIndex]
      if (focused !== undefined) onSelect(focused.id)
      return
    }
    if (matchesKey(data, Key.left)) {
      this.focusIndex = Math.max(0, this.focusIndex - 1)
      return
    }
    if (matchesKey(data, Key.right)) {
      this.focusIndex = Math.min(levels.length - 1, this.focusIndex + 1)
    }
    // The picker owns the keyboard while open: swallow everything else.
  }
}

// ---------------------------------------------------------------------------
// TipsPanel (static content)
// ---------------------------------------------------------------------------

const TIP_GROUP_ORDER: readonly TipGroup[] = ['keys', 'commands', 'workflow', 'display', 'pitfalls']

/**
 * `/tips` usage-tips panel: grouped one-line tips, same copy as the old
 * React panel. Owns the keyboard while open — Esc/Enter/Space closes,
 * ↑/↓ scrolls, everything else is swallowed.
 */
export function createTipsPanel(options: { onClose: () => void; maxHeight?: number }): Component {
  return new TipsPanelView(options)
}

class TipsPanelView implements Component {
  private readonly options: { onClose: () => void; maxHeight?: number }
  private readonly body: readonly string[]
  private scrollOffset = 0

  constructor(options: { onClose: () => void; maxHeight?: number }) {
    this.options = options
    const lang = getLang()
    const lines: string[] = []
    for (const group of TIP_GROUP_ORDER) {
      lines.push(chalk.bold(themed(getActiveTheme().claude)(TIP_GROUP_LABELS[group][lang])))
      for (const tip of TIPS.filter((entry) => entry.group === group)) {
        lines.push(dim(`  · ${tip[lang]}`))
      }
      lines.push('')
    }
    this.body = lines
  }

  invalidate(): void {
    // Static content; nothing cached per width.
  }

  render(width: number): string[] {
    const maxHeight = this.options.maxHeight ?? this.body.length
    const visible = this.body.slice(this.scrollOffset, this.scrollOffset + maxHeight)
    const lines: string[] = [
      truncateToWidth(
        `${chalk.bold(themed(getActiveTheme().warning)('/tips'))} ${dim(t('tips-title'))}`,
        width,
        '',
      ),
      '',
    ]
    lines.push(...indentLines(visible, width))
    lines.push(truncateToWidth(dim(t('tips-hint')), width, ''))
    return lines
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      this.options.onClose()
      return
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const maxHeight = this.options.maxHeight ?? this.body.length
      const maxOffset = Math.max(this.body.length - maxHeight, 0)
      const next = this.scrollOffset + (matchesKey(data, Key.up) ? -3 : 3)
      this.scrollOffset = Math.min(Math.max(next, 0), maxOffset)
    }
    // Every other key is swallowed while the panel is open.
  }
}

// ---------------------------------------------------------------------------
// BtwPanel (/btw side question)
// ---------------------------------------------------------------------------

/** Live handle the chat screen feeds while the side question streams. */
export interface BtwPanel extends Component {
  setQuestion: (question: string) => void
  /** Replace the whole answer (also used to clear on a new question). */
  setAnswer: (text: string) => void
  /** Append a streamed delta. */
  appendAnswer: (delta: string) => void
  setError: (error: string | undefined) => void
  setStreaming: (streaming: boolean) => void
}

/**
 * /btw side-question panel: header with the question, the streaming answer
 * body (error / answer / answering placeholder), an input row for the
 * question itself, and the hint line. All data is pushed in through the
 * handle by the chat screen (which owns `commands.info.sideQuestion`); Enter
 * on a non-empty input submits through `onText`, Enter on an empty input and
 * Esc close. Plain text instead of the old Markdown body (details kept
 * simple); `onCopy` is optional — pass it to keep the old `c` copy key.
 */
export function createBtwPanel(options: {
  question: string
  draft?: string
  maxHeight?: number
  onText: (text: string) => void
  onCopy?: () => void
  onClose: () => void
}): BtwPanel {
  return new BtwPanelView(options)
}

class BtwPanelView implements BtwPanel {
  private readonly options: {
    question: string
    draft?: string
    maxHeight?: number
    onText: (text: string) => void
    onCopy?: () => void
    onClose: () => void
  }
  private readonly input: Input
  private question: string
  private answer = ''
  private error: string | undefined
  private streaming = false
  private scrollOffset = 0

  constructor(options: {
    question: string
    draft?: string
    maxHeight?: number
    onText: (text: string) => void
    onCopy?: () => void
    onClose: () => void
  }) {
    this.options = options
    this.question = options.question
    this.input = new Input()
    if (options.draft !== undefined) this.input.setValue(options.draft)
  }

  setQuestion(question: string): void {
    this.question = question
  }

  setAnswer(text: string): void {
    this.answer = text
    this.scrollOffset = 0
  }

  appendAnswer(delta: string): void {
    this.answer += delta
  }

  setError(error: string | undefined): void {
    this.error = error
  }

  setStreaming(streaming: boolean): void {
    this.streaming = streaming
  }

  invalidate(): void {
    this.input.invalidate()
  }

  private bodyLines(width: number): string[] {
    if (this.error !== undefined) {
      return wrapTextWithAnsi(this.error, width).map((line) => themed(getActiveTheme().error)(line))
    }
    if (this.answer !== '') {
      return wrapTextWithAnsi(this.answer, width)
    }
    return [dim(t('btw-answering'))]
  }

  render(width: number): string[] {
    const contentWidth = Math.max(width - visibleWidth(INDENT), 1)
    const body = this.bodyLines(contentWidth)
    const maxHeight = this.options.maxHeight ?? body.length
    const maxOffset = Math.max(body.length - maxHeight, 0)
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset)
    const settled = this.answer !== '' || this.error !== undefined
    const lines: string[] = [
      `${chalk.bold(themed(getActiveTheme().warning)('/btw'))} ${dim(truncateToWidth(this.question, contentWidth - 6, ''))}`,
      '',
    ]
    lines.push(...indentLines(body.slice(this.scrollOffset, this.scrollOffset + maxHeight), width))
    lines.push(...indentLines(this.input.render(contentWidth), width))
    lines.push(truncateToWidth(dim(settled || !this.streaming ? t('btw-hint-done') : t('btw-hint-loading')), width, ''))
    return lines
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.options.onClose()
      return
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.scrollOffset = Math.max(this.scrollOffset + (matchesKey(data, Key.up) ? -3 : 3), 0)
      return
    }
    if (matchesKey(data, Key.enter)) {
      const value = this.input.getValue().trim()
      if (value === '') {
        this.options.onClose()
      } else {
        this.input.setValue('')
        this.options.onText(value)
      }
      return
    }
    if (matchesKey(data, 'c') && this.options.onCopy !== undefined) {
      this.options.onCopy()
      return
    }
    this.input.handleInput(data)
  }
}
