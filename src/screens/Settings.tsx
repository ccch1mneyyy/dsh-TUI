import React from 'react'
import { Box, Text, useInput, useTerminalSize } from '../ui.js'
import type { WheelEvent } from '../ink/events/wheel-event.js'
import { Divider } from '../components/design-system/Divider.js'
import { HintLine } from '../components/design-system/HintLine.js'
import { isMod, isPlainReturn } from '../utils/modifiers.js'
import { truncateWidth } from '../sessions/format.js'
import { stringWidth } from '../ink/stringWidth.js'
import { POINTER, TICK, MULTIPLICATION_X } from '../cc/figures.js'
import type { Theme } from '../theme.js'
import { getLang, t } from '../i18n.js'
import { SettingsForm } from '../dsh-adapter/settingsEditor.js'
import type { TuiSettingsField, TuiSettingsFieldKind, TuiSettingsGroup, TuiSettingsSection } from '../dsh-adapter/settings-sections.js'
import type { LocalizedDescriptions } from '../commands.js'
import type { Channel } from '../dsh-adapter/channel.js'

/** What the screen is doing with the focused field. */
type SettingsMode = 'list' | 'edit'

interface EditingState {
  ns: string
  field: TuiSettingsField
  draft: string
}

interface ActiveGroup {
  ns: string
  id: string
}

/** One focusable row on either the root page or a group subpage. */
type FocusEntry =
  | { kind: 'field'; ns: string; field: TuiSettingsField }
  | { kind: 'group'; ns: string; group: TuiSettingsGroup }

/** One rendered block with its height, for focus-follow windowing. */
interface RenderEntry {
  key: string
  /** Terminal lines this block occupies (accounted, never assumed). */
  lines: number
  node: React.ReactNode
  /** Position in the focus order when this block is a field. */
  focus?: number
}

/** Pick the provider-owned translation for the active language. */
function pick(text: string, descriptions: LocalizedDescriptions | undefined): string {
  return descriptions?.[getLang()] ?? text
}

/**
 * Pad a glyph to a fixed display width.
 *
 * CJK terminal fonts commonly render symbols like `❯`/`✓` (U+276F/U+2713)
 * a full cell wide where Latin fonts render them narrow — a marker column
 * built on raw characters then shifts every row's content by one cell when
 * the focused glyph swaps in. Padding with `stringWidth` (display columns,
 * not string length) pins the column to `cols` cells on either font, so
 * rows never move when focus changes.
 */
function padTo(glyph: string, cols: number): string {
  const width = stringWidth(glyph)
  return width >= cols ? glyph : glyph + ' '.repeat(cols - width)
}

/**
 * One editable field row. Always exactly one line tall — the value column
 * stays flush right (badges attach to its left), and the field's hint lives
 * in the bottom help bar instead of a second row, so moving the focus never
 * reflows the list. 行高亮背景由外层 CardRow 负责，本组件只管文字与 chip。
 */
function FieldRow({
  label,
  kind,
  value,
  selectLabel,
  focused,
  editing,
  invalid,
  staged,
  onClick,
  onMouseEnter,
}: {
  label: string
  kind: TuiSettingsFieldKind
  value: string
  /** select 字段当前值对应的本地化选项文案（值非空且命中选项时提供）。 */
  selectLabel?: string
  focused: boolean
  editing: boolean
  invalid: boolean
  staged: boolean
  onClick?: () => void
  onMouseEnter?: () => void
}): React.ReactNode {
  const booleanChip = kind === 'boolean' && (value === 'true' || value === 'false')
  return (
    <Box
      flexDirection="row"
      height={1}
      flexShrink={0}
      overflow="hidden"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
    >
      <Text color={focused ? 'suggestion' : undefined}>{focused ? padTo(POINTER, 2) : '  '}</Text>
      <Text bold={focused}>{label}</Text>
      <Box flexGrow={1} />
      {invalid && <Text color="error">{t('settings-field-invalid')} </Text>}
      {staged && !editing && <Text color="suggestion">* </Text>}
      {booleanChip ? (
        <Text color={value === 'true' ? 'success' : 'inactive'}>
          {value === 'true' ? `[${padTo(TICK, 2)}]` : '[  ]'}
        </Text>
      ) : selectLabel !== undefined ? (
        // chip 右缘 = › 字符本身，恒贴右（flex spacer 向左吸收字体宽度差）；
        // 两侧各一个字面空格，任何字体下 chevron 与文案的间隙一致。
        <Text>
          <Text color={focused ? 'suggestion' : 'subtle'}>{'‹ '}</Text>
          <Text color={focused ? 'suggestion' : undefined}>{selectLabel}</Text>
          <Text color={focused ? 'suggestion' : 'subtle'}>{' ›'}</Text>
        </Text>
      ) : (
        <Text color={editing || focused ? 'suggestion' : undefined} dimColor={!focused && !editing && value === ''}>
          {value}
        </Text>
      )}
    </Box>
  )
}

/** A group navigation row — opens the group's subpage on Enter/click. */
function GroupRow({
  title,
  focused,
  onClick,
  onMouseEnter,
}: {
  title: string
  focused: boolean
  onClick?: () => void
  onMouseEnter?: () => void
}): React.ReactNode {
  return (
    <Box
      flexDirection="row"
      height={1}
      flexShrink={0}
      overflow="hidden"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
    >
      <Text color={focused ? 'suggestion' : undefined}>{focused ? padTo(POINTER, 2) : '  '}</Text>
      <Text bold={focused}>{title}</Text>
      <Box flexGrow={1} />
      {/* 右缘 = › 本身，恒贴右；宽度差由 flex spacer 向左吸收。 */}
      <Text color={focused ? 'suggestion' : 'subtle'}>{'›'}</Text>
    </Box>
  )
}

/** 区块卡片的边框色（沿用输入框的 panel 边框 token）。 */
const CARD_BORDER: keyof Theme = 'promptBorder'

/**
 * 区块卡片的顶边：`╭─ 标题 (副标题) ────── [徽章] ╮`。
 *
 * 标题用区块主题色加粗、徽章保留各自的语义色（未保存/重启/失败），其余
 * 边框线用卡片边框色。宽度按 stringWidth 精确计算（CJK 标题占 2 格），
 * 极窄终端依次退化：先丢副标题、再丢徽章、最后截断标题。
 */
function CardTop({
  title,
  subtitle,
  badges,
  columns,
  color = CARD_BORDER,
}: {
  title: string
  subtitle?: string
  badges: readonly { text: string; color: keyof Theme }[]
  columns: number
  color?: keyof Theme
}): React.ReactNode {
  const subtitleText = subtitle === undefined ? '' : ` (${subtitle})`
  let showSubtitle = subtitleText !== ''
  let showBadges = badges.length > 0
  let titleText = title
  const badgesWidth = badges.reduce((sum, badge) => sum + stringWidth(`[${badge.text}]`), 0) + Math.max(0, badges.length - 1)
  // 布局：'╭─ ' + 标题 + 副标题 + ' ' + 虚线 + [' ' + 徽章 + ' '] + '╮'
  const used = (titleWidth: number, withSubtitle: boolean, withBadges: boolean): number =>
    5 + titleWidth + (withSubtitle ? stringWidth(subtitleText) : 0) + (withBadges ? 2 + badgesWidth : 0)
  if (used(stringWidth(titleText), showSubtitle, showBadges) + 1 > columns && showSubtitle) showSubtitle = false
  if (used(stringWidth(titleText), showSubtitle, showBadges) + 1 > columns && showBadges) showBadges = false
  if (used(stringWidth(titleText), showSubtitle, showBadges) + 1 > columns) {
    titleText = truncateWidth(titleText, Math.max(4, columns - 6 - (showSubtitle ? stringWidth(subtitleText) : 0) - (showBadges ? 2 + badgesWidth : 0)))
  }
  const dashes = Math.max(0, columns - used(stringWidth(titleText), showSubtitle, showBadges))
  return (
    <Box flexDirection="row" height={1} flexShrink={0} overflow="hidden">
      <Text color={color}>{'╭─ '}</Text>
      <Text bold color="permission">{titleText}</Text>
      {showSubtitle && <Text dimColor>{subtitleText}</Text>}
      <Text color={color}>{` ${'─'.repeat(dashes)}`}</Text>
      {showBadges && (
        <>
          <Text color={color}>{' '}</Text>
          {badges.map((badge, index) => (
            <React.Fragment key={index}>
              {index > 0 && <Text color={color}>{' '}</Text>}
              <Text color={badge.color}>{`[${badge.text}]`}</Text>
            </React.Fragment>
          ))}
          <Text color={color}>{' '}</Text>
        </>
      )}
      <Text color={color}>{'╮'}</Text>
    </Box>
  )
}

/** 区块卡片的底边：`╰──────╯`。 */
function CardBottom({ columns, color = CARD_BORDER }: { columns: number; color?: keyof Theme }): React.ReactNode {
  return (
    <Text color={color} wrap="truncate-end">
      {`╰${'─'.repeat(Math.max(0, columns - 2))}╯`}
    </Text>
  )
}

/**
 * 卡片内一行：`│` 左右边框 + 内容区。聚焦行的高亮背景涂在内容区上
 * （padding 也在背景内），边框线本身不吃高亮——高亮条正好嵌在两道
 * 竖线之间。行内容恒 1 行，与窗口化滚动逐行兼容（SuggestionCard 同族）。
 */
function CardRow({
  children,
  highlight,
  color = CARD_BORDER,
}: {
  children: React.ReactNode
  highlight?: boolean
  color?: keyof Theme
}): React.ReactNode {
  return (
    <Box flexDirection="row" height={1} flexShrink={0} overflow="hidden">
      <Text color={color}>│</Text>
      <Box
        flexDirection="column"
        flexGrow={1}
        minWidth={0}
        paddingX={1}
        backgroundColor={highlight === true ? 'selectionBg' : undefined}
      >
        {children}
      </Box>
      <Text color={color}>│</Text>
    </Box>
  )
}

/**
 * The settings screen — `/settings` as a screen of its own (issue #165).
 *
 * The TUI owns only presentation here: plugin-declared sections from the
 * `tuiSettingsSections` seam render as editable forms; every write goes back
 * through the dsh settings service (revision-fenced `mutate` path ops) or the
 * credentials seam (secret fields, blank-until-typed).
 *
 * Edits auto-save: toggling a boolean/select writes on the spot, confirming a
 * text draft writes on Enter, and Esc just leaves — there is no save key and
 * nothing to discard. The SettingsForm still stages drafts under the hood (its
 * snapshot save keeps rapid successive edits serialized; see
 * settingsEditor.ts), so the brief in-flight window and a failed save keep
 * their `*` / badge feedback.
 */
export function Settings({
  channel,
  onClose,
}: {
  channel: Channel
  onClose: () => void
}): React.ReactNode {
  // Explicit terminal size (not flexGrow) — the same rule SessionBrowser's
  // root follows inside the alternate screen's fixed-height box.
  const { columns, rows } = useTerminalSize()
  // channel caches the host — a fresh object per call would re-fire the
  // host-keyed effects below on every render (an endless render loop).
  const host = channel.settingsHost()
  const [namespaces, setNamespaces] = React.useState(() => host?.listNamespaces() ?? [])
  const [sections, setSections] = React.useState(() => channel.settingsSections())
  const [mode, setMode] = React.useState<SettingsMode>('list')
  const [editing, setEditing] = React.useState<EditingState | null>(null)
  const [activeGroup, setActiveGroup] = React.useState<ActiveGroup | null>(null)
  const [focusIndex, setFocusIndex] = React.useState(0)
  const [notice, setNotice] = React.useState<{ text: string; tone: 'error' | 'success' } | undefined>(undefined)
  /** Configured status of every secret field's credential ref. */
  const [secrets, setSecrets] = React.useState<ReadonlyMap<string, boolean>>(new Map())
  /** First line of the windowed entry list (focus-follow scrolling). */
  const [windowStart, setWindowStart] = React.useState(0)
  /** Repaint after a form mutation — staged drafts live in the (React-free)
   *  SettingsForm, so editing one changes no React state by itself. */
  const [, bump] = React.useReducer((count: number) => count + 1, 0)
  /** Async save completions must not touch state after the screen closes. */
  const mountedRef = React.useRef(true)
  React.useEffect(() => () => {
    mountedRef.current = false
  }, [])

  React.useEffect(() => channel.subscribeSettingsSections(() => {
    setSections(channel.settingsSections())
  }), [channel])

  // One form per section namespace. A fresh namespace view replaces the form
  // only while it holds no edits — replacing a dirty form would discard the
  // drafts the user is still typing.
  const formsRef = React.useRef(new Map<string, SettingsForm>())
  const forms = new Map<string, SettingsForm>()
  if (host !== undefined) {
    for (const section of sections) {
      const view = namespaces.find(entry => entry.ns === section.ns)
      const kept = formsRef.current.get(section.ns)
      const reuse = kept !== undefined && (kept.namespace === view || kept.shell().dirty)
      const form = reuse ? kept : new SettingsForm(host, view, section.fields)
      forms.set(section.ns, form)
    }
  }
  formsRef.current = forms

  const refresh = (): void => {
    setNamespaces(host?.listNamespaces() ?? [])
  }

  // Secret fields report only configured/unconfigured; resolve each ref once
  // per section-list change (and after every save, which may have set one).
  const [secretProbe, setSecretProbe] = React.useState(0)
  React.useEffect(() => {
    if (host === undefined) return
    let stale = false
    const pending = sections.flatMap(section =>
      section.fields
        .filter((field): field is TuiSettingsField & { secret: { ref: string } } => field.secret !== undefined)
        .map(async field => [`${section.ns}:${field.path.join('.')}`, await host.credentialConfigured(field.secret.ref)] as const),
    )
    void Promise.all(pending).then(entries => {
      if (!stale && mountedRef.current) setSecrets(new Map(entries))
    })
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, sections, secretProbe])

  const activeSection = activeGroup === null ? undefined : sections.find(section => section.ns === activeGroup.ns)
  const activeGroupSpec = activeSection?.groups?.find(group => group.id === activeGroup?.id)
  React.useEffect(() => {
    if (activeGroup !== null && activeGroupSpec === undefined) {
      setActiveGroup(null)
      setFocusIndex(0)
      setWindowStart(0)
    }
  }, [activeGroup, activeGroupSpec])

  /** Focusable rows in display order for the current page. */
  const focusable: FocusEntry[] = activeSection !== undefined && activeGroupSpec !== undefined
    ? activeSection.fields
      .filter(field => field.group === activeGroupSpec.id)
      .map(field => ({ kind: 'field', ns: activeSection.ns, field }))
    : sections.flatMap(section => [
      ...section.fields
        .filter(field => field.group === undefined)
        .map(field => ({ kind: 'field' as const, ns: section.ns, field })),
      ...(section.groups ?? []).map(group => ({ kind: 'group' as const, ns: section.ns, group })),
    ])
  const effFocus = Math.min(focusIndex, Math.max(0, focusable.length - 1))
  const focused = focusable.length === 0 ? undefined : focusable[effFocus]

  /**
   * Save a section's staged edits right now (auto-save: every confirmed edit
   * writes immediately — no manual save key, Esc just leaves). A save already
   * in flight chains: the pending marker re-runs the save once it settles, and
   * the editor's snapshot semantics keep drafts staged mid-flight alive, so
   * rapid toggles serialize instead of racing the revision fence.
   */
  const pendingSaveRef = React.useRef(new Set<string>())
  const saveSoon = (ns: string): void => {
    const form = formsRef.current.get(ns)
    if (form === undefined || !form.available || form.shell().invalid || !form.shell().dirty) return
    if (form.saving) {
      pendingSaveRef.current.add(ns)
      return
    }
    void form.save().then(ok => {
      if (!mountedRef.current) return
      if (ok) {
        setNotice({ text: t('settings-saved', { ns }), tone: 'success' })
        refresh()
        setSecretProbe(count => count + 1)
      } else {
        // A guarded rejection (e.g. a reserved credential ref) carries its
        // own explanation; only unexplained failures fall back to the
        // generic message.
        const failureMessage = form.shell().failureMessage
        setNotice({ text: failureMessage ?? t('settings-save-failed', { ns }), tone: 'error' })
      }
      if (pendingSaveRef.current.delete(ns)) {
        const next = formsRef.current.get(ns)
        if (next !== undefined && next.shell().dirty) saveSoon(ns)
      }
    })
  }

  /**
   * Cycle a boolean/select field (or any options-bearing field) and save
   * the change immediately. ←/→ and Enter/click all route here; arrow
   * direction selects the step, Enter/click keep the historical forward
   * step (wrap-around). A value outside the options (a custom text spec
   * such as the page-margin `3x1`) sits before the first option for →
   * and after the last for ←, so either arrow re-enters the preset cycle
   * from the natural end.
   */
  const cycleField = (ns: string, field: TuiSettingsField, direction: 1 | -1 = 1): void => {
    const form = forms.get(ns)
    if (form === undefined || !form.available) return
    const current = form.field(field).text
    if (field.kind === 'boolean') {
      form.edit(field, current === 'true' ? 'false' : 'true')
    } else {
      const options = field.options ?? []
      if (options.length === 0) return
      const index = options.findIndex(option => option.value === current)
      const size = options.length
      const next = options[(((index + direction) % size) + size) % size]
      form.edit(field, next?.value ?? options[0]?.value ?? '')
    }
    bump()
    saveSoon(ns)
  }

  /**
   * Activate one focusable entry — the keyboard Enter path, shared with the
   * mouse click. Groups open their subpage; boolean/select fields cycle their
   * value; text/secret fields enter the edit mode.
   */
  const activateEntry = (entry: FocusEntry): void => {
    if (entry.kind === 'group') {
      setActiveGroup({ ns: entry.ns, id: entry.group.id })
      setFocusIndex(0)
      setWindowStart(0)
      return
    }
    const form = forms.get(entry.ns)
    if (form === undefined || !form.available) return
    if (entry.field.kind === 'boolean' || entry.field.kind === 'select') {
      cycleField(entry.ns, entry.field)
    } else {
      setEditing({ ns: entry.ns, field: entry.field, draft: form.field(entry.field).text })
      setMode('edit')
    }
  }

  /** Mouse wheel moves the focus (the window is focus-follow, so moving the
   *  focus IS scrolling); the edit mode keeps the keyboard as sole owner. */
  const handleWheel = (event: WheelEvent): void => {
    if (mode === 'edit') return
    const direction = event.deltaY >= 0 ? 1 : -1
    setFocusIndex(previous =>
      Math.min(Math.max(0, focusable.length - 1), Math.max(0, previous + direction)),
    )
  }

  useInput((input, key) => {
    if (mode === 'edit' && editing !== null) {
      if (isPlainReturn(key)) {
        // Confirm the draft: an invalid value keeps the editor open with the
        // error badge and a toast; a valid one saves immediately (auto-save).
        const form = forms.get(editing.ns)
        if (form !== undefined) {
          form.edit(editing.field, editing.draft)
          if (form.field(editing.field).invalid) {
            setNotice({ text: t('settings-field-invalid'), tone: 'error' })
            bump()
            return
          }
          bump()
          setMode('list')
          setEditing(null)
          saveSoon(editing.ns)
        }
      } else if (key.escape) {
        setMode('list')
        setEditing(null)
      } else if (key.backspace || key.delete) {
        setEditing(state => state === null ? null : { ...state, draft: state.draft.slice(0, -1) })
      } else if (!isMod(key) && !key.meta && !key.super && input && !key.return) {
        // Only real characters reach the draft (see SessionBrowser's query).
        const typed = input.replace(/\p{Cc}/gu, '')
        if (typed.length > 0) {
          setEditing(state => state === null ? null : { ...state, draft: state.draft + typed })
        }
      }
      return
    }

    if (key.upArrow) {
      setFocusIndex(Math.max(0, effFocus - 1))
    } else if (key.downArrow) {
      setFocusIndex(Math.min(Math.max(0, focusable.length - 1), effFocus + 1))
    } else if (key.leftArrow || key.rightArrow) {
      // ←/→ cycle an options-bearing field (select rows and hybrid
      // text-with-options rows such as the page margin presets). Rows
      // without options ignore the arrows; boolean rows keep Enter as
      // their only toggle.
      if (focused !== undefined && focused.kind === 'field') {
        const field = focused.field
        if ((field.options?.length ?? 0) > 0) {
          cycleField(focused.ns, field, key.rightArrow === true ? 1 : -1)
        }
      }
    } else if (isPlainReturn(key) && focused !== undefined) {
      activateEntry(focused)
    } else if (key.escape) {
      if (activeGroupSpec !== undefined) {
        // Group navigation only unwinds the page; edits save as they land.
        setActiveGroup(null)
        setFocusIndex(0)
        setWindowStart(0)
        return
      }
      // Auto-save means there is nothing left to discard: Esc leaves. A save
      // still in flight was already dispatched — it settles on its own.
      onClose()
    }
  })

  const renderField = (section: TuiSettingsSection, field: TuiSettingsField, focus: number): React.ReactNode => {
    const ns = section.ns
    const form = forms.get(ns)
    const state = form?.field(field) ?? { text: '', overridden: false, invalid: false }
    const isFocused = focused?.kind === 'field' && focused.ns === ns && focused.field === field
    const isEditing = isFocused && mode === 'edit' && editing !== null
    const label = pick(field.label, field.descriptions)
    // 鼠标：编辑态整屏不响应（草稿由键盘独占，防误触抢焦点）；列表态
    // 悬停即移动焦点（lazygit 语义——焦点就是选中），点击 = 焦点 + 该行
    // 的 Enter 动作（boolean/select 循环值，文本/secret 进编辑态）。
    const rowEvents =
      mode === 'edit'
        ? undefined
        : {
            onClick: (): void => {
              setFocusIndex(focus)
              activateEntry({ kind: 'field', ns: section.ns, field })
            },
            onMouseEnter: (): void => {
              setFocusIndex(focus)
            },
          }

    let value: string
    if (field.secret !== undefined) {
      const configured = secrets.get(`${ns}:${field.path.join('.')}`) === true
      if (isEditing) {
        value = '•'.repeat(editing?.draft.length ?? 0) + '▌'
      } else if (state.text !== '') {
        value = `${'•'.repeat(state.text.length)} ${t('settings-secret-staged')}`
      } else {
        value = configured ? t('settings-secret-set') : t('settings-secret-unset')
      }
    } else if (isEditing) {
      value = `${editing?.draft ?? ''}▌`
    } else if (state.text === '') {
      value = t('settings-field-empty')
    } else {
      value = state.text
    }

    // Options-bearing values render as chips: use the option's localized
    // label ('zh' → '常规') instead of the stored raw value; a value that
    // matches no option (a custom text spec such as `3x1`) falls back to
    // the raw text. Only when not editing and the value is non-empty.
    const selectLabel =
      ((field.kind === 'select' || (field.options?.length ?? 0) > 0) && !isEditing && state.text !== '')
        ? (() => {
            const option = field.options?.find(entry => entry.value === state.text)
            return option === undefined ? state.text : pick(option.label, option.descriptions)
          })()
        : undefined

    return (
      <FieldRow
        label={label}
        kind={field.kind}
        value={value}
        selectLabel={selectLabel}
        focused={isFocused}
        editing={isEditing}
        invalid={state.invalid}
        staged={form?.isStaged(field) === true}
        onClick={rowEvents?.onClick}
        onMouseEnter={rowEvents?.onMouseEnter}
      />
    )
  }

  // ── Layout: a flat entry list with accounted line heights, windowed so the
  // focused row is always on screen no matter how long the current page gets.
  // Each section renders as a bordered card (╭─ title ─╮ / │ rows │ / ╰──╯);
  // borders are their own entries so windowing can cut a long card anywhere. ─
  const entries: RenderEntry[] = []
  let focusCursor = 0

  /** Badges for a section's form, rendered on the card's top border. */
  const sectionBadges = (section: TuiSettingsSection): { text: string; color: keyof Theme }[] => {
    const form = forms.get(section.ns)
    const view = form?.namespace
    const shell = form?.shell()
    const badges: { text: string; color: keyof Theme }[] = []
    if (view === undefined) badges.push({ text: t('settings-section-unavailable'), color: 'warning' })
    if (view?.applies === 'restart') badges.push({ text: t('settings-badge-restart'), color: 'warning' })
    if (shell?.dirty === true) badges.push({ text: t('settings-badge-dirty'), color: 'suggestion' })
    if (shell?.saving === true) badges.push({ text: t('settings-badge-saving'), color: 'inactive' })
    if (shell?.failed === true) badges.push({ text: t('settings-badge-failed'), color: 'error' })
    return badges
  }

  const addField = (section: TuiSettingsSection, field: TuiSettingsField): void => {
    const index = focusCursor
    focusCursor += 1
    const isFocused = focused?.kind === 'field' && focused.ns === section.ns && focused.field === field
    // Field rows are always exactly one line: the hint lives in the bottom
    // help bar, so focusing a field never reflows the list below it.
    entries.push({
      key: `field:${section.ns}:${field.path.join('.')}`,
      lines: 1,
      focus: index,
      node: <CardRow highlight={isFocused}>{renderField(section, field, index)}</CardRow>,
    })
  }

  if (activeSection !== undefined && activeGroupSpec !== undefined) {
    const groupFields = activeSection.fields.filter(field => field.group === activeGroupSpec.id)
    entries.push({
      key: 'card:group:top',
      lines: 1,
      node: (
        <CardTop
          title={pick(activeGroupSpec.title, activeGroupSpec.descriptions)}
          subtitle={pick(activeSection.title, activeSection.descriptions)}
          badges={sectionBadges(activeSection)}
          columns={columns}
        />
      ),
    })
    for (const field of groupFields) addField(activeSection, field)
    if (groupFields.length === 0) {
      entries.push({ key: 'group:empty', lines: 1, node: <CardRow><Text dimColor>{t('settings-group-empty')}</Text></CardRow> })
    }
    entries.push({ key: 'card:group:bottom', lines: 1, node: <CardBottom columns={columns} /> })
  } else {
    sections.forEach((section, sectionIndex) => {
      if (sectionIndex > 0) entries.push({ key: `gap:${section.ns}`, lines: 1, node: <Text> </Text> })
      entries.push({
        key: `card:${section.ns}:top`,
        lines: 1,
        node: (
          <CardTop
            title={pick(section.title, section.descriptions)}
            subtitle={section.ns}
            badges={sectionBadges(section)}
            columns={columns}
          />
        ),
      })
      for (const field of section.fields) {
        if (field.group === undefined) addField(section, field)
      }
      for (const group of section.groups ?? []) {
        const isFocused = focused?.kind === 'group' && focused.ns === section.ns && focused.group === group
        const index = focusCursor
        focusCursor += 1
        const groupRowEvents =
          mode === 'edit'
            ? undefined
            : {
                onClick: (): void => {
                  setFocusIndex(index)
                  activateEntry({ kind: 'group', ns: section.ns, group })
                },
                onMouseEnter: (): void => {
                  setFocusIndex(index)
                },
              }
        entries.push({
          key: `group:${section.ns}:${group.id}`,
          lines: 1,
          focus: index,
          node: (
            <CardRow highlight={isFocused}>
              <GroupRow
                title={pick(group.title, group.descriptions)}
                focused={isFocused}
                onClick={groupRowEvents?.onClick}
                onMouseEnter={groupRowEvents?.onMouseEnter}
              />
            </CardRow>
          ),
        })
      }
      entries.push({ key: `card:${section.ns}:bottom`, lines: 1, node: <CardBottom columns={columns} /> })
    })

    // Namespaces without a plugin-declared section are deliberately NOT
    // listed (they used to get a read-only YAML hint; user feedback: noise).
    if (sections.length === 0) {
      entries.push({
        key: 'empty',
        lines: 1,
        node: <Text dimColor>{t('settings-empty')}</Text>,
      })
    }
  }

  // Focus-follow window: keep the focused entry fully inside the viewport.
  let totalLines = 0
  let focusedOffset = 0
  let focusedLines = 1
  for (const entry of entries) {
    if (entry.focus === effFocus) {
      focusedOffset = totalLines
      focusedLines = entry.lines
    }
    totalLines += entry.lines
  }
  // Chrome: title row, footer rule, notice slot, help row. The notice slot is
  // permanent (blank while quiet) so a save/discard toast never shifts the
  // list above it.
  const viewport = Math.max(1, rows - 4)
  React.useEffect(() => {
    setWindowStart(start => {
      if (focusedOffset < start) return focusedOffset
      if (focusedOffset + focusedLines > start + viewport) return focusedOffset + focusedLines - viewport
      return start
    })
  }, [focusedOffset, focusedLines, viewport])

  let entryOffset = 0
  const visible = entries.filter(entry => {
    const start = entryOffset
    entryOffset += entry.lines
    return start >= windowStart && start + entry.lines <= windowStart + viewport
  })

  const inGroup = activeSection !== undefined && activeGroupSpec !== undefined
  const navigationHint = inGroup ? t('settings-hint-group') : t('settings-hint-list')
  // The bottom help bar: the focused field's hint on the left (truncated
  // first), the navigation keys pinned to the right — a truncated hint still
  // reads, a truncated shortcut hint hides the keys nobody can guess.
  const focusedHint = focused?.kind === 'field' && focused.field.hint !== undefined
    ? pick(focused.field.hint, focused.field.hintDescriptions)
    : undefined
  // A field whose user layer carries a value (settings.yaml) is "customized"
  // — worth knowing, too noisy to badge every row with. It rides the help
  // bar instead: focus the field and the suffix appears next to its hint.
  const focusedCustomized = focused?.kind === 'field'
    ? forms.get(focused.ns)?.field(focused.field).overridden === true
    : false
  const keysLine = mode === 'edit' ? t('settings-hint-edit') : navigationHint
  const keysWidth = stringWidth(keysLine.replace(/\*\*/gu, ''))
  const hintBudget = Math.max(0, columns - keysWidth - 2)
  // The customized suffix is the whole point of this line — reserve its
  // width first and truncate the hint instead, so it never becomes '已自…'.
  const customText = focusedCustomized ? t('settings-field-customized') : undefined
  const customWidth = customText !== undefined ? stringWidth(customText) + 3 : 0 // ' · '
  let hintText = ''
  if (focusedHint !== undefined && hintBudget >= 12) {
    hintText = truncateWidth(focusedHint, Math.max(0, hintBudget - customWidth))
    if (customText !== undefined) hintText += ` · ${customText}`
  } else if (customText !== undefined && hintBudget >= 12) {
    hintText = truncateWidth(customText, hintBudget)
  }
  // Header stats: where the focus sits in the current page's focusable list.
  // (Auto-save means there is no unsaved-draft count to surface here.)

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box>
        <Text bold>{t('settings-title')}</Text>
        {inGroup && (
          <>
            <Text dimColor>{' › '}{pick(activeSection.title, activeSection.descriptions)}</Text>
            <Text dimColor>{' › '}</Text>
            <Text bold>{pick(activeGroupSpec.title, activeGroupSpec.descriptions)}</Text>
          </>
        )}
        <Box flexGrow={1} />
        {host === undefined && <Text color="warning">{`${t('settings-unavailable')} `}</Text>}
        {focusable.length > 0 && <Text dimColor>{`${effFocus + 1}/${focusable.length}`}</Text>}
      </Box>
      {/* Literal ink-box host for the wheel — every Box flavor is a compiled
          component whose prop list drops onWheel (SuggestionCard precedent).
          Rolling the wheel walks the focus, and the focus-follow window
          scrolls with it — the focus IS the viewport here. */}
      <ink-box
        style={{ flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden' }}
        onWheel={handleWheel}
      >
        {visible.map(entry => (
          <React.Fragment key={entry.key}>{entry.node}</React.Fragment>
        ))}
      </ink-box>
      <Box flexGrow={1} />
      {/* Page-level rule: full-bleed to the terminal edges (text above and
          below keeps the page margin — the divider is structural chrome). */}
      <Divider bleed />
      <Text color={notice?.tone === 'error' ? 'error' : 'success'}>
        {notice === undefined ? ' ' : `${notice.tone === 'error' ? MULTIPLICATION_X : TICK} ${notice.text}`}
      </Text>
      <Box>
        <Text dimColor italic>{hintText}</Text>
        <Box flexGrow={1} />
        <Text dimColor italic>
          <HintLine text={keysLine} />
        </Text>
      </Box>
    </Box>
  )
}
