import React from 'react'
import { Box, Text, useInput, useTerminalSize } from '../ui.js'
import { Divider } from '../components/design-system/Divider.js'
import { HintLine } from '../components/design-system/HintLine.js'
import { isMod, isPlainReturn } from '../utils/modifiers.js'
import { truncateWidth } from '../sessions/format.js'
import { getLang, t } from '../i18n.js'
import { SettingsForm } from '../dsh-adapter/settingsEditor.js'
import type { TuiSettingsField, TuiSettingsSection } from '../dsh-adapter/settings-sections.js'
import type { LocalizedDescriptions } from '../commands.js'
import type { Channel } from '../dsh-adapter/channel.js'

/** What the screen is doing with the focused field. */
type SettingsMode = 'list' | 'edit'

interface EditingState {
  ns: string
  field: TuiSettingsField
  draft: string
}

/** One flat, focusable row: a field inside a registered section. */
interface FocusEntry {
  ns: string
  field: TuiSettingsField
}

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

/** Compact one-line preview of a read-only namespace's resolved value. */
function valuePreview(value: unknown, budget: number): string {
  let raw: string
  try {
    raw = JSON.stringify(value) ?? 'undefined'
  } catch {
    raw = String(value)
  }
  return truncateWidth(raw, Math.max(8, budget))
}

/**
 * The settings screen — `/settings` as a screen of its own (issue #165).
 *
 * The TUI owns only presentation here: plugin-declared sections from the
 * `tuiSettingsSections` seam render as editable forms; every write goes back
 * through the dsh settings service (revision-fenced `mutate` path ops) or the
 * credentials seam (secret fields, blank-until-typed). Namespaces no plugin
 * declared a section for stay read-only with a YAML hint — the same fallback
 * the web front door gives namespaces without a card.
 *
 * Edits are staged, never settled live: typing changes a draft, and only the
 * explicit save writes the durable document (see settingsEditor.ts for why).
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

  /** Focusable rows in display order: every field of every section. */
  const focusable: FocusEntry[] = sections.flatMap(section =>
    section.fields.map(field => ({ ns: section.ns, field })),
  )
  const effFocus = Math.min(focusIndex, Math.max(0, focusable.length - 1))
  const focused = focusable.length === 0 ? undefined : focusable[effFocus]
  const focusedForm = focused === undefined ? undefined : forms.get(focused.ns)

  const commitSave = (ns: string): void => {
    const form = forms.get(ns)
    if (form === undefined || form.saving || !form.shell().dirty) return
    void form.save().then(ok => {
      if (!mountedRef.current) return
      if (ok) {
        setNotice({ text: t('settings-saved', { ns }), tone: 'success' })
        refresh()
        setSecretProbe(count => count + 1)
      } else {
        setNotice({ text: t('settings-save-failed', { ns }), tone: 'error' })
      }
    })
  }

  /** Stage the next choice for a boolean/select field (Enter cycles). */
  const cycleField = (ns: string, field: TuiSettingsField): void => {
    const form = forms.get(ns)
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
    setNotice(undefined)
    bump()
  }

  useInput((input, key) => {
    if (mode === 'edit' && editing !== null) {
      if (isPlainReturn(key)) {
        const form = forms.get(editing.ns)
        form?.edit(editing.field, editing.draft)
        bump()
        setMode('list')
        setEditing(null)
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
    } else if (isPlainReturn(key) && focused !== undefined) {
      // A save in flight owns the section's drafts; starting an edit mid-write
      // is exactly the lost-draft race the staged model exists to prevent.
      if (focusedForm === undefined || !focusedForm.available || focusedForm.saving) return
      if (focused.field.kind === 'boolean' || focused.field.kind === 'select') {
        cycleField(focused.ns, focused.field)
      } else {
        setEditing({ ns: focused.ns, field: focused.field, draft: focusedForm.field(focused.field).text })
        setMode('edit')
      }
    } else if (input === 's' && focused !== undefined) {
      commitSave(focused.ns)
    } else if (input === 'd' && focused !== undefined) {
      if (focusedForm?.saving) return
      focusedForm?.discard()
      setNotice(undefined)
      bump()
    } else if (key.escape) {
      // Esc backs out one layer at a time: staged drafts first — ANY dirty
      // section, not just the focused one, so leaving never silently drops
      // an edit made two sections ago — the screen second. A save in flight
      // cannot be undone from here; let it settle instead of discarding
      // around it.
      const dirty = [...forms.values()].filter(form => form.shell().dirty)
      if (dirty.length > 0) {
        if (dirty.some(form => form.saving)) return
        for (const form of dirty) form.discard()
        setNotice({ text: t('settings-discarded'), tone: 'success' })
        bump()
      } else {
        onClose()
      }
    }
  })

  const renderField = (section: TuiSettingsSection, field: TuiSettingsField): React.ReactNode => {
    const ns = section.ns
    const form = forms.get(ns)
    const state = form?.field(field) ?? { text: '', overridden: false, invalid: false }
    const isFocused = focused !== undefined && focused.ns === ns && focused.field === field
    const isEditing = isFocused && mode === 'edit' && editing !== null
    const label = pick(field.label, field.descriptions)
    const hint = field.hint !== undefined ? pick(field.hint, field.hintDescriptions) : undefined

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

    return (
      <Box>
        <Text color={isFocused ? 'suggestion' : undefined}>{isFocused ? '❯ ' : '  '}</Text>
        <Text bold={isFocused}>{label}</Text>
        <Box flexGrow={1} />
        {state.invalid && <Text color="error">{t('settings-field-invalid')} </Text>}
        {state.overridden && <Text dimColor>[{t('settings-badge-override')}] </Text>}
        {form?.isStaged(field) === true && !isEditing && <Text color="suggestion">* </Text>}
        <Text color={isEditing || isFocused ? 'suggestion' : undefined} dimColor={!isFocused && !isEditing && state.text === ''}>
          {value}
        </Text>
        {hint !== undefined && isFocused && (
          <Text dimColor>{'\n    '}{hint}</Text>
        )}
      </Box>
    )
  }

  // ── Layout: a flat entry list with accounted line heights, windowed so the
  // focused field is always on screen no matter how long the list gets. ────
  const entries: RenderEntry[] = []
  let focusCursor = 0
  sections.forEach((section, sectionIndex) => {
    const form = forms.get(section.ns)
    const view = form?.namespace
    const shell = form?.shell()
    entries.push({
      key: `section:${section.ns}`,
      lines: sectionIndex === 0 ? 1 : 2,
      node: (
        <Box flexDirection="column">
          {sectionIndex > 0 && <Text> </Text>}
          <Box>
            <Text bold color="permission">{pick(section.title, section.descriptions)}</Text>
            <Text dimColor> ({section.ns})</Text>
            {view?.applies === 'restart' && <Text color="warning"> [{t('settings-badge-restart')}]</Text>}
            {view === undefined && <Text color="warning"> [{t('settings-section-unavailable')}]</Text>}
            {shell?.dirty === true && <Text color="suggestion"> [{t('settings-badge-dirty')}]</Text>}
            {shell?.saving === true && <Text dimColor> [{t('settings-badge-saving')}]</Text>}
            {shell?.failed === true && <Text color="error"> [{t('settings-badge-failed')}]</Text>}
          </Box>
        </Box>
      ),
    })
    for (const field of section.fields) {
      const isFocused = focused !== undefined && focused.ns === section.ns && focused.field === field
      const hasHint = field.hint !== undefined && isFocused
      const index = focusCursor
      focusCursor += 1
      entries.push({
        key: `field:${section.ns}:${field.path.join('.')}`,
        lines: hasHint ? 2 : 1,
        focus: index,
        node: renderField(section, field),
      })
    }
  })

  const registeredNs = new Set(sections.map(section => section.ns))
  const readonlyNamespaces = namespaces.filter(entry => !registeredNs.has(entry.ns))
  if (readonlyNamespaces.length > 0) {
    entries.push({
      key: 'readonly:heading',
      lines: 2,
      node: (
        <Box flexDirection="column">
          <Text> </Text>
          <Text bold dimColor>{t('settings-readonly-heading')}</Text>
        </Box>
      ),
    })
    for (const entry of readonlyNamespaces) {
      entries.push({
        key: `readonly:${entry.ns}`,
        lines: 1,
        node: (
          <Box>
            <Text>{'  '}{entry.ns}</Text>
            {entry.applies === 'restart' && <Text color="warning"> [{t('settings-badge-restart')}]</Text>}
            <Text dimColor>{'  '}{valuePreview(entry.value, 60)}</Text>
          </Box>
        ),
      })
    }
    entries.push({
      key: 'readonly:hint',
      lines: 1,
      node: <Text dimColor>{'  '}{t('settings-readonly-hint', { path: '~/.dsh/settings.yaml' })}</Text>,
    })
  }
  if (sections.length === 0 && readonlyNamespaces.length === 0) {
    entries.push({
      key: 'empty',
      lines: 1,
      node: <Text dimColor>{t('settings-empty')}</Text>,
    })
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
  // Chrome: title row, top rule, bottom rule, hint row, plus the notice.
  const viewport = Math.max(1, rows - 4 - (notice === undefined ? 0 : 1))
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

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box>
        <Text bold>{t('settings-title')}</Text>
        <Box flexGrow={1} />
        {host === undefined && <Text color="warning">{t('settings-unavailable')}</Text>}
      </Box>
      <Divider />
      {visible.map(entry => (
        <React.Fragment key={entry.key}>{entry.node}</React.Fragment>
      ))}
      <Box flexGrow={1} />
      {notice !== undefined && (
        <Text color={notice.tone === 'error' ? 'error' : 'success'}>{notice.text}</Text>
      )}
      <Divider />
      <Text dimColor italic>
        <HintLine text={mode === 'edit' ? t('settings-hint-edit') : t('settings-hint-list')} />
      </Text>
    </Box>
  )
}
