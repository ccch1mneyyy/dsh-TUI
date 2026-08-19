/**
 * The managed plugin dialog (`ctx.tuiDialogs`) — one panel rendering the
 * store's current snapshot in the chat chrome (the slot approval/question
 * panels occupy). Three kinds share one component:
 *
 * - `select`  — focus list (↑/↓, windowed), Enter settles the option id
 * - `confirm` — two rows (confirm/cancel), Enter settles the boolean
 * - `input`   — single-line text edit, Enter settles the text
 *
 * Esc (and Ctrl+C) always cancels — the plugin's promise resolves with the
 * cancelled value. The panel owns the keyboard through its own useInput,
 * the same contract as ApprovalPanel/AskUserQuestionPanel: Chat's global
 * handler early-returns while a snapshot is pending.
 *
 * Two input-pipeline rules shape every handler below:
 *
 * - BATCHED KEYS: a terminal delivers one stdin chunk as several key events
 *   inside a single React batch (Down+Enter arrives together), so state
 *   queued by the first event is NOT visible to the second. Every piece of
 *   editing state the handlers act on (focus, value, cursor) therefore
 *   lives in a ref mutated SYNCHRONOUSLY per event; the useState mirror
 *   only exists to re-render.
 * - CODE POINTS: cursor movement and deletion step over whole code points
 *   (`[...s]` iteration, same contract as the transcript search box), so an
 *   emoji can never be split into a lone surrogate.
 *
 * All text arrives pre-sanitized from TuiDialogRuntime (control chars
 * stripped, cell-width capped); the panel still renders everything through
 * ListItem's single-line truncation.
 */

import React from 'react'
import { t } from '../i18n.js'
import { Box, Text, useInput, useTerminalSize } from '../ui.js'
import { stringWidth } from '../ink/stringWidth.js'
import { isPlainReturnInput } from '../utils/modifiers.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { HintLine } from './design-system/HintLine.js'
import { listWindow } from './listWindow.js'
import { INPUT_CELLS, type TuiDialogAnswer, type TuiDialogSnapshot } from '../dsh-adapter/dialogs.js'
import { capCells, flattenInline } from '../dsh-adapter/sanitize.js'

export type ExtensionDialogProps = {
  /** The pending dialog (TuiDialogStore snapshot; `key` remounts per dialog). */
  readonly dialog: TuiDialogSnapshot
  readonly onDecide: (value: TuiDialogAnswer) => void
  readonly onCancel: () => void
}

export function ExtensionDialog({ dialog, onDecide, onCancel }: ExtensionDialogProps): React.ReactNode {
  switch (dialog.kind) {
    case 'select':
      return <SelectDialog dialog={dialog} onDecide={onDecide} onCancel={onCancel} />
    case 'confirm':
      return <ConfirmDialog dialog={dialog} onDecide={onDecide} onCancel={onCancel} />
    case 'input':
      return <InputDialog dialog={dialog} onDecide={onDecide} onCancel={onCancel} />
  }
}

function SelectDialog({
  dialog,
  onDecide,
  onCancel,
}: {
  dialog: Extract<TuiDialogSnapshot, { kind: 'select' }>
  onDecide: (value: TuiDialogAnswer) => void
  onCancel: () => void
}): React.ReactNode {
  const [focusIndex, setFocusIndex] = React.useState(0)
  // Synchronous source of truth for the handlers (see the module header):
  // Down+Enter in one stdin chunk must move AND read the new focus.
  const focusRef = React.useRef(0)
  const moveFocus = (delta: number): void => {
    const next = (focusRef.current + delta + dialog.options.length) % dialog.options.length
    focusRef.current = next
    setFocusIndex(next)
  }
  const { rows: terminalRows } = useTerminalSize()

  useInput((input, key, event) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }
    if (key.upArrow) {
      moveFocus(-1)
      return
    }
    if (key.downArrow) {
      moveFocus(1)
      return
    }
    // isPasted lives on the InputEvent, not the key: a bracketed paste that
    // is all line breaks is pasted content, never an Enter press.
    if (isPlainReturnInput(input, { ...key, isPasted: event.isPasted })) {
      const option = dialog.options[focusRef.current]
      if (option !== undefined) onDecide(option.id)
    }
  }, { isActive: true })

  // Row budget mirrors the rewind picker: a described option costs 2 rows,
  // a bare one 1; frame rows: Pane 2 + title 2 + footer 1 + slack.
  const { start, end } = listWindow(
    dialog.options.map(option => (option.description === undefined ? 1 : 2)),
    focusIndex,
    Math.max(terminalRows - 10, 2),
  )
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {dialog.title}
          </Text>
        </Box>
        {dialog.options.slice(start, end).map((option, index) => {
          const absoluteIndex = start + index
          return (
            <ListItem
              key={option.id}
              isFocused={absoluteIndex === focusIndex}
              description={option.description}
              showScrollUp={absoluteIndex === start && start > 0}
              showScrollDown={absoluteIndex === end - 1 && end < dialog.options.length}
            >
              {option.label}
            </ListItem>
          )
        })}
      </Box>
      <Text dimColor italic>
        <HintLine text={t('hint-select-exit')} />
      </Text>
    </Pane>
  )
}

function ConfirmDialog({
  dialog,
  onDecide,
  onCancel,
}: {
  dialog: Extract<TuiDialogSnapshot, { kind: 'confirm' }>
  onDecide: (value: TuiDialogAnswer) => void
  onCancel: () => void
}): React.ReactNode {
  const [focusIndex, setFocusIndex] = React.useState(0)
  // Synchronous source of truth for the handlers (see the module header):
  // Right+Enter in one stdin chunk must settle the NEW row, not the old.
  const focusRef = React.useRef(0)
  const labels = [
    dialog.confirmLabel || t('ext-dialog-yes'),
    dialog.cancelLabel || t('ext-dialog-no'),
  ]
  const moveFocus = (delta: number): void => {
    const next = (focusRef.current + delta + labels.length) % labels.length
    focusRef.current = next
    setFocusIndex(next)
  }

  useInput((input, key, event) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }
    if (key.upArrow || key.leftArrow) {
      moveFocus(-1)
      return
    }
    if (key.downArrow || key.rightArrow) {
      moveFocus(1)
      return
    }
    // isPasted lives on the InputEvent, not the key: a bracketed paste that
    // is all line breaks must not confirm on the default focus.
    if (isPlainReturnInput(input, { ...key, isPasted: event.isPasted })) {
      onDecide(focusRef.current === 0)
    }
  }, { isActive: true })

  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {dialog.title}
          </Text>
          {dialog.message !== undefined && <Text dimColor>{dialog.message}</Text>}
        </Box>
        {labels.map((label, index) => (
          <ListItem key={label} isFocused={index === focusIndex}>
            {label}
          </ListItem>
        ))}
      </Box>
      <Text dimColor italic>
        <HintLine text={t('hint-select-exit')} />
      </Text>
    </Pane>
  )
}

function InputDialog({
  dialog,
  onDecide,
  onCancel,
}: {
  dialog: Extract<TuiDialogSnapshot, { kind: 'input' }>
  onDecide: (value: TuiDialogAnswer) => void
  onCancel: () => void
}): React.ReactNode {
  const [value, setValue] = React.useState(dialog.initial)
  const [cursor, setCursor] = React.useState<number>(() => [...dialog.initial].length)
  // Synchronous source of truth for the handlers (see the module header):
  // two Backspaces in one stdin chunk must BOTH delete, each seeing the
  // other's result. The cursor counts CODE POINTS, not UTF-16 units — an
  // emoji is one step and can never be split into a lone surrogate.
  const valueRef = React.useRef(dialog.initial)
  const cursorRef = React.useRef([...dialog.initial].length)
  const applyEdit = (nextValue: string, nextCursor: number): void => {
    valueRef.current = nextValue
    cursorRef.current = nextCursor
    setValue(nextValue)
    setCursor(nextCursor)
  }

  useInput((input, key, event) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }
    // isPasted lives on the InputEvent, not the key: a bracketed paste that
    // is all line breaks is inserted as text, not submitted.
    if (isPlainReturnInput(input, { ...key, isPasted: event.isPasted })) {
      onDecide(valueRef.current)
      return
    }
    const points = [...valueRef.current]
    const at = cursorRef.current
    // Single-line editing, same key set as the transcript search bar.
    if (key.backspace) {
      if (at > 0) {
        points.splice(at - 1, 1)
        applyEdit(points.join(''), at - 1)
      }
      return
    }
    if (key.delete) {
      if (at < points.length) {
        points.splice(at, 1)
        applyEdit(points.join(''), at)
      }
      return
    }
    if (key.leftArrow) {
      if (at > 0) applyEdit(valueRef.current, at - 1)
      return
    }
    if (key.rightArrow) {
      if (at < points.length) applyEdit(valueRef.current, at + 1)
      return
    }
    if (key.home) {
      applyEdit(valueRef.current, 0)
      return
    }
    if (key.end) {
      applyEdit(valueRef.current, points.length)
      return
    }
    if (input && !key.ctrl && !key.meta && !key.super && !key.tab && !key.escape) {
      // A bracketed paste arrives as one chunk and may carry newlines/control
      // chars — this is a single-line panel, so flatten them to spaces. Every
      // edit path holds the value at INPUT_CELLS cells so the resolved answer
      // keeps the documented bound: typing past the cap is ignored, an
      // oversized paste is truncated (never silently unbounded).
      const chunk = event.isPasted ? flattenInline(input) : input
      const chunkPoints = [...chunk].length
      const candidate = points.slice(0, at).join('') + chunk + points.slice(at).join('')
      if (stringWidth(candidate) <= INPUT_CELLS) {
        applyEdit(candidate, at + chunkPoints)
      } else if (event.isPasted) {
        const capped = capCells(candidate, INPUT_CELLS)
        applyEdit(capped, Math.min(at + chunkPoints, [...capped].length))
      }
    }
  }, { isActive: true })

  const shown = value === '' && dialog.placeholder !== undefined ? dialog.placeholder : value
  const shownPoints = [...shown]
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {dialog.title}
          </Text>
        </Box>
        <Text>
          {/* The caret is the inverted cell under the cursor (CC's block
              cursor); at end of line it inverts the trailing space. Splits
              are code-point safe — the caret never lands inside a surrogate
              pair. */}
          <Text dimColor={value === ''}>{shownPoints.slice(0, cursor).join('')}</Text>
          <Text inverse>{shownPoints[cursor] ?? ' '}</Text>
          <Text>{shownPoints.slice(cursor + 1).join('')}</Text>
        </Text>
      </Box>
      <Text dimColor italic>
        <HintLine text={t('hint-ext-dialog-input')} />
      </Text>
    </Pane>
  )
}
