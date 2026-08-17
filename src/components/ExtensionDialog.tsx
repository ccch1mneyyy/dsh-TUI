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
  const { rows: terminalRows } = useTerminalSize()

  useInput((input, key, event) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }
    if (key.upArrow) {
      setFocusIndex(index => (index + dialog.options.length - 1) % dialog.options.length)
      return
    }
    if (key.downArrow) {
      setFocusIndex(index => (index + 1) % dialog.options.length)
      return
    }
    // isPasted lives on the InputEvent, not the key: a bracketed paste that
    // is all line breaks is pasted content, never an Enter press.
    if (isPlainReturnInput(input, { ...key, isPasted: event.isPasted })) {
      const option = dialog.options[focusIndex]
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
  const labels = [
    dialog.confirmLabel || t('ext-dialog-yes'),
    dialog.cancelLabel || t('ext-dialog-no'),
  ]

  useInput((input, key, event) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }
    if (key.upArrow || key.leftArrow) {
      setFocusIndex(index => (index + labels.length - 1) % labels.length)
      return
    }
    if (key.downArrow || key.rightArrow) {
      setFocusIndex(index => (index + 1) % labels.length)
      return
    }
    // isPasted lives on the InputEvent, not the key: a bracketed paste that
    // is all line breaks must not confirm on the default focus.
    if (isPlainReturnInput(input, { ...key, isPasted: event.isPasted })) {
      onDecide(focusIndex === 0)
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
  const [cursor, setCursor] = React.useState(dialog.initial.length)

  useInput((input, key, event) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }
    // isPasted lives on the InputEvent, not the key: a bracketed paste that
    // is all line breaks is inserted as text, not submitted.
    if (isPlainReturnInput(input, { ...key, isPasted: event.isPasted })) {
      onDecide(value)
      return
    }
    // Single-line editing, same key set as the transcript search bar.
    if (key.backspace) {
      if (cursor > 0) {
        setValue(value.slice(0, cursor - 1) + value.slice(cursor))
        setCursor(cursor - 1)
      }
      return
    }
    if (key.delete) {
      if (cursor < value.length) setValue(value.slice(0, cursor) + value.slice(cursor + 1))
      return
    }
    if (key.leftArrow) {
      setCursor(current => Math.max(0, current - 1))
      return
    }
    if (key.rightArrow) {
      setCursor(current => Math.min(value.length, current + 1))
      return
    }
    if (key.home) {
      setCursor(0)
      return
    }
    if (key.end) {
      setCursor(value.length)
      return
    }
    if (input && !key.ctrl && !key.meta && !key.super && !key.tab && !key.escape) {
      // A bracketed paste arrives as one chunk and may carry newlines/control
      // chars — this is a single-line panel, so flatten them to spaces. Every
      // edit path holds the value at INPUT_CELLS cells so the resolved answer
      // keeps the documented bound: typing past the cap is ignored, an
      // oversized paste is truncated (never silently unbounded).
      const chunk = event.isPasted ? flattenInline(input) : input
      const candidate = value.slice(0, cursor) + chunk + value.slice(cursor)
      if (stringWidth(candidate) <= INPUT_CELLS) {
        setValue(candidate)
        setCursor(cursor + chunk.length)
      } else if (event.isPasted) {
        const capped = capCells(candidate, INPUT_CELLS)
        setValue(capped)
        setCursor(Math.min(cursor + chunk.length, capped.length))
      }
    }
  }, { isActive: true })

  const shown = value === '' && dialog.placeholder !== undefined ? dialog.placeholder : value
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
              cursor); at end of line it inverts the trailing space. */}
          <Text dimColor={value === ''}>{shown.slice(0, cursor)}</Text>
          <Text inverse>{shown[cursor] ?? ' '}</Text>
          <Text>{shown.slice(cursor + 1)}</Text>
        </Text>
      </Box>
      <Text dimColor italic>
        <HintLine text={t('hint-ext-dialog-input')} />
      </Text>
    </Pane>
  )
}
