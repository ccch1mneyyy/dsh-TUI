import React from 'react'
import type { ProviderModelEditor as ModelEditor } from '../../adapter/ports/channel-settings.js'
import { formatModelReasoning, parseModelCapacity, parseModelReasoning } from '../../adapter/ports/model-capabilities.js'
import { capCells, cleanRenderText, flattenPasteInline } from '../../channel/sanitize.js'
import { t } from '../../i18n.js'
import { useDeclaredCursor } from '../../ink/hooks/use-declared-cursor.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text, useInput, useTerminalSize } from '../../ui.js'
import { readClipboard, type ClipboardRead } from '../../utils/clipboard.js'
import { actionMatches } from '../../utils/keymap.js'
import { isPlainReturnInput } from '../../utils/modifiers.js'
import { Divider } from '../design-system/Divider.js'
import { POINTER } from '../../terminal-utils/figures.js'
import { listWindow } from '../listWindow.js'

type TextField = 'contextWindow' | 'maxTokens' | 'reasoningEfforts'
type Field = TextField | 'input' | 'save'
type InputMode = 'inherit' | 'text' | 'image'
const FIELDS: readonly Field[] = ['contextWindow', 'maxTokens', 'reasoningEfforts', 'input', 'save']
const INPUT_MODES: readonly InputMode[] = ['inherit', 'text', 'image']
const FIELD_MAX_POINTS = 1024

/** Draft-only capability form nested in /provider's model-selection question. */
export function ProviderModelEditor({ model, editor, onClose, onAbort, readClipboardOverride }: {
  readonly model: string
  readonly editor: ModelEditor
  readonly onClose: () => void
  readonly onAbort: () => void
  readonly readClipboardOverride?: () => Promise<ClipboardRead>
}): React.ReactNode {
  const initial = React.useMemo(() => editor.read(model), [editor, model])
  const initialText = {
    contextWindow: String(initial.values.contextWindow ?? ''),
    maxTokens: String(initial.values.maxTokens ?? ''),
    reasoningEfforts: flattenPasteInline(formatModelReasoning(initial.values.reasoningEfforts)),
  }
  const initialMode: InputMode = initial.values.input === undefined ? 'inherit'
    : initial.values.input.includes('image') ? 'image' : 'text'
  const [values, setValues] = React.useState(initialText)
  const valuesRef = React.useRef(initialText)
  const [cursors, setCursors] = React.useState<Record<TextField, number>>({
    contextWindow: [...initialText.contextWindow].length,
    maxTokens: [...initialText.maxTokens].length,
    reasoningEfforts: [...initialText.reasoningEfforts].length,
  })
  const cursorsRef = React.useRef(cursors)
  const [focus, setFocus] = React.useState(0)
  const focusRef = React.useRef(0)
  const [inputMode, setInputMode] = React.useState(initialMode)
  const inputModeRef = React.useRef(initialMode)
  const [error, setError] = React.useState<string | null>(null)
  const closed = React.useRef(false)
  const mounted = React.useRef(true)
  const pasteBusy = React.useRef(false)
  React.useEffect(() => () => { mounted.current = false }, [])
  const { columns, rows } = useTerminalSize()
  const width = Math.max(1, columns - 6)
  const compact = columns < 64
  const field = FIELDS[focus]
  const textFocused = field !== 'input' && field !== 'save'
    && (field !== 'reasoningEfforts' || editor.reasoningEditable)
  const caretRef = useDeclaredCursor({ line: 0, column: 0, active: textFocused })
  const { start, end } = listWindow([1, 1, 1, 1, 1], focus, Math.max(2, rows - 16))

  const placeFocus = (next: number): void => {
    focusRef.current = next
    setFocus(next)
    setError(null)
  }
  const moveFocus = (delta: number): void => {
    let next = (focusRef.current + delta + FIELDS.length) % FIELDS.length
    if (FIELDS[next] === 'reasoningEfforts' && !editor.reasoningEditable) {
      next = (next + delta + FIELDS.length) % FIELDS.length
    }
    placeFocus(next)
  }
  const edit = (name: TextField, value: string, cursor: number): void => {
    if ([...value].length > FIELD_MAX_POINTS) {
      setError(t('provider-model-field-too-long', { n: FIELD_MAX_POINTS }))
      return
    }
    valuesRef.current = { ...valuesRef.current, [name]: value }
    cursorsRef.current = { ...cursorsRef.current, [name]: cursor }
    setValues(valuesRef.current)
    setCursors(cursorsRef.current)
    setError(null)
  }
  const insert = (name: TextField, raw: string): void => {
    const text = flattenPasteInline(raw)
    const points = [...valuesRef.current[name]]
    const at = cursorsRef.current[name]
    points.splice(at, 0, ...text)
    edit(name, points.join(''), at + [...text].length)
  }
  const cycleInput = (delta: number): void => {
    const next = INPUT_MODES[(INPUT_MODES.indexOf(inputModeRef.current) + delta + INPUT_MODES.length) % INPUT_MODES.length]
    inputModeRef.current = next
    setInputMode(next)
    setError(null)
  }
  const save = (): void => {
    if (closed.current) return
    try {
      editor.save(model, {
        contextWindow: parseModelCapacity(valuesRef.current.contextWindow),
        maxTokens: parseModelCapacity(valuesRef.current.maxTokens),
        reasoningEfforts: valuesRef.current.reasoningEfforts === initialText.reasoningEfforts
          ? initial.values.reasoningEfforts : parseModelReasoning(valuesRef.current.reasoningEfforts),
        input: inputModeRef.current === initialMode ? initial.values.input
          : inputModeRef.current === 'inherit' ? undefined
            : inputModeRef.current === 'image' ? ['text', 'image'] : ['text'],
      })
      closed.current = true
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useInput((input, key, event) => {
    // Own the whole key, including the frame that closes the editor: Enter
    // must not also submit the surrounding model-selection question.
    event.stopImmediatePropagation()
    if (closed.current) return
    if (key.escape || (key.ctrl && input === 'c')) {
      closed.current = true
      if (key.ctrl) onAbort()
      else onClose()
      return
    }
    const current = FIELDS[focusRef.current]
    const isText = current !== 'input' && current !== 'save'
      && (current !== 'reasoningEfforts' || editor.reasoningEditable)
    // Pasted newlines/tabs are data, never save or field navigation.
    if (key.isPasted) {
      if (isText) insert(current as TextField, input)
      return
    }
    if (actionMatches('paste', input, key)) {
      if (!isText || pasteBusy.current) return
      const name = current as TextField
      pasteBusy.current = true
      void (readClipboardOverride ?? readClipboard)().then(content => {
        if (!mounted.current || closed.current || FIELDS[focusRef.current] !== name) return
        if (content?.kind === 'text') insert(name, content.text)
        else setError(t('provider-model-paste-text-only'))
      }).catch(() => {
        if (mounted.current && !closed.current) setError(t('provider-model-paste-text-only'))
      }).finally(() => { pasteBusy.current = false })
      return
    }
    if (isPlainReturnInput(input, key) || (key.ctrl && input === 's')) {
      save()
      return
    }
    if (key.upArrow || (key.tab && key.shift)) {
      moveFocus(-1)
      return
    }
    if (key.downArrow || key.tab) {
      moveFocus(1)
      return
    }
    if (current === 'input') {
      if (key.leftArrow) cycleInput(-1)
      else if (key.rightArrow || input === ' ') cycleInput(1)
      return
    }
    if (!isText) return
    const name = current as TextField
    const points = [...valuesRef.current[name]]
    const at = cursorsRef.current[name]
    if (key.home) {
      edit(name, points.join(''), 0)
      return
    }
    if (key.end) {
      edit(name, points.join(''), points.length)
      return
    }
    if (key.ctrl && input === 'u') {
      edit(name, '', 0)
      return
    }
    if (key.leftArrow) {
      edit(name, points.join(''), Math.max(0, at - 1))
      return
    }
    if (key.rightArrow) {
      edit(name, points.join(''), Math.min(points.length, at + 1))
      return
    }
    if (key.backspace && at > 0) {
      points.splice(at - 1, 1)
      edit(name, points.join(''), at - 1)
    } else if (key.delete) {
      points.splice(at, 1)
      edit(name, points.join(''), at)
    } else if (input && !key.ctrl && !key.meta && !key.super && !key.backspace) insert(name, input)
  }, { prepend: true })

  const labels: Record<Field, string> = {
    contextWindow: t('provider-model-context-window'),
    maxTokens: t('provider-model-max-tokens'),
    reasoningEfforts: t('provider-model-reasoning-efforts'),
    input: t('provider-model-multimodal'),
    save: t('provider-model-save'),
  }
  const compactLabels: Record<Field, string> = {
    contextWindow: 'ctx',
    maxTokens: 'output',
    reasoningEfforts: 'effort',
    input: t('provider-model-multimodal-short'),
    save: t('provider-model-save-short'),
  }
  const inheritedInputLabel = initial.defaults.input === undefined ? t('provider-model-inherit')
    : initial.defaults.input.includes('image') ? t('provider-model-default-image') : t('provider-model-default-text')
  const inputLabel = inputMode === 'inherit' ? inheritedInputLabel
    : inputMode === 'image' ? t('provider-model-input-image') : t('provider-model-input-text')
  const renderValue = (name: TextField, focused: boolean, availableWidth: number): React.ReactNode => {
    const points = [...values[name]]
    const at = cursors[name]
    // Keep the caret in the horizontal viewport without slicing UTF-16 or
    // assuming one code point equals one terminal cell.
    let first = 0
    while (first < at && stringWidth(points.slice(first, at).join('')) >= availableWidth) first += 1
    const prefix = points.slice(first, at).join('')
    const caret = points[at] ?? ' '
    const suffix = capCells(points.slice(at + 1).join(''), Math.max(0, availableWidth - stringWidth(prefix) - stringWidth(caret)))
    const fallback = name === 'reasoningEfforts' ? t('provider-model-inherit')
      : initial.defaults[name] === undefined ? t('provider-model-inherit')
        : t('provider-model-default-capacity', { n: initial.defaults[name]! })
    if (!focused) return <Text dimColor={points.length === 0} wrap="truncate">{points.length === 0 ? fallback : values[name]}</Text>
    return <Text>
      {prefix}<Text ref={caretRef} inverse>{caret}</Text>{suffix}
      {points.length === 0 ? <Text dimColor>{capCells(fallback, Math.max(0, availableWidth - 1))}</Text> : null}
    </Text>
  }

  return <Box flexDirection="column" marginTop={1} paddingX={2} width="100%">
    <Divider color="permission" title={t('provider-model-editor-title')} />
    <Box marginTop={1} marginBottom={1}><Text bold wrap="truncate">{cleanRenderText(model, Math.max(1, columns - 4))}</Text></Box>
    {FIELDS.slice(start, end).map((name, index) => {
      const absolute = start + index
      const focused = absolute === focus
      const isText = name !== 'input' && name !== 'save'
      const valueWidth = Math.max(1, width - (compact ? 10 : 27))
      return <Box
        key={name}
        flexDirection="row"
        height={1}
        flexShrink={0}
        overflow="hidden"
        width="100%"
        onClick={() => {
          if (name === 'reasoningEfforts' && !editor.reasoningEditable) return
          if (name === 'save') save()
          else {
            placeFocus(absolute)
            if (name === 'input') cycleInput(1)
          }
        }}
      >
        <Box width={1} flexShrink={0}>
          <Text
            color={focused ? 'accent' : undefined}
            dimColor={name === 'reasoningEfforts' && !editor.reasoningEditable}
          >{focused ? POINTER : absolute === start && start > 0 ? '↑' : absolute === end - 1 && end < FIELDS.length ? '↓' : ' '}</Text>
        </Box>
        <Box width={compact ? 9 : 26} flexShrink={0}>
          <Text
            bold={focused}
            color={focused ? 'accent' : undefined}
            dimColor={name === 'reasoningEfforts' && !editor.reasoningEditable}
            wrap="truncate"
          >{compact ? compactLabels[name] : labels[name]}</Text>
        </Box>
        <Box width={valueWidth} flexShrink={0} overflow="hidden">
          {name === 'input'
            ? <Text wrap="truncate">{compact ? inputMode === 'inherit' ? initial.defaults.input?.includes('image') ? 'image default' : 'text default' : inputMode : inputLabel}</Text>
            : name === 'save'
              ? <Text color="success" wrap="truncate">{compact ? 'Enter' : t('provider-model-enter-to-save')}</Text>
              : name === 'reasoningEfforts' && !editor.reasoningEditable
                ? <Text dimColor wrap="truncate">{t('provider-model-reasoning-unavailable-short')}</Text>
                : renderValue(name as TextField, focused && textFocused, valueWidth)}
        </Box>
      </Box>
    })}
    <Box marginTop={1}><Text dimColor wrap="truncate">{field === 'reasoningEfforts'
      ? editor.reasoningEditable ? t('provider-model-reasoning-hint') : t('provider-model-reasoning-unavailable')
      : field === 'input' ? t('provider-model-input-hint') : t('provider-model-capacity-hint')}</Text></Box>
    {error !== null ? <Text color="error" wrap="truncate">{error}</Text> : null}
    <Text dimColor wrap="truncate">{t('hint-provider-model-editor')}</Text>
  </Box>
}
