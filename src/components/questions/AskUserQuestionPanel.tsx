/**
 * The questionnaire panel — Claude Code style ask-user-question UI for the
 * DSH user-interaction seam. One question per panel (progress header, header
 * chip, wrapped question text, optional detail, option list with focus
 * pointer and multi-select checkmarks), styled in the dsh-tui mist-blue
 * design language.
 *
 * The list's last row IS the free-text input (issue #9): no Tab, no mode
 * switch — the view never changes. Typing while focused on a real option
 * appends into that input row (single-select also attaches the option's
 * label, so the answer can carry both `selected` and `custom`); focusing
 * the input row itself and typing gives a pure custom answer.
 */

import React from 'react'
import { t } from '../../i18n.js'
import { Box, Text, useInput, useTerminalSize } from '../../ui.js'
import { useDeclaredCursor } from '../../ink/hooks/use-declared-cursor.js'
import { Divider } from '../design-system/Divider.js'
import { POINTER } from '../../cc/figures.js'
import type { QuestionSelection } from '../../dsh-adapter/questions.js'
import { PlanReviewPanel } from './PlanReviewPanel.js'
import { isPlainReturnInput } from '../../utils/modifiers.js'
import { listWindow } from '../listWindow.js'
import wrapText from '../../ink/wrap-text.js'

const CHECKED = '◉'
const UNCHECKED = '○'
const PENCIL = '✎'

export type AskUserQuestionPanelProps = {
  /** The question to render (from the QuestionStore snapshot). */
  readonly question: {
    readonly question: string
    readonly header?: string
    readonly detail?: string
    readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }>
    readonly multiSelect?: boolean
    /** Hide the trailing free-text input row for pure option questions
     *  (local wizards, e.g. /provider). Ignored when there are no options —
     *  a text-only question would otherwise be unanswerable. */
    readonly hideCustomInput?: boolean
    /** Presentation intent tag (rc.6): 'plan-review' switches to the
     *  decision-card layout; an intent never changes the protocol. */
    readonly intent?: { readonly kind: 'plan-review'; readonly approve: string }
  }
  /** 1-based position within the batch (progress header). */
  readonly position: number
  /** Total questions in the batch (progress header). */
  readonly total: number
  /** Questions answered before the current one. */
  readonly answered: number
  /** Rows physically available above the questionnaire anchor. Chat passes
   *  its measured inline viewport; standalone/fullscreen callers may omit it
   *  and fall back to the terminal height. */
  readonly availableRows?: number
  readonly onAnswer: (selection: QuestionSelection) => void
  /** Esc / Ctrl+C — aborts the whole ask (ASK_ABORTED back to the model). */
  readonly onCancel: () => void
}

export function AskUserQuestionPanel({
  question,
  position,
  total,
  answered,
  availableRows,
  onAnswer,
  onCancel,
}: AskUserQuestionPanelProps): React.ReactNode {
  // Plan-mode's exit_plan_mode ask carries a presentation intent: render
  // the CC-style decision card instead of the generic questionnaire. The
  // branch precedes every hook so hook order stays stable per remount key.
  if (question.intent?.kind === 'plan-review') {
    return (
      <PlanReviewPanel
        question={question}
        availableRows={availableRows}
        onAnswer={onAnswer}
        onCancel={onCancel}
      />
    )
  }
  const options = question.options ?? []
  const multiSelect = question.multiSelect === true
  const hideCustomInput = question.hideCustomInput === true && options.length > 0
  const { rows: terminalRows, columns: terminalColumns } = useTerminalSize()
  /** Rows: the real options plus the inline input row at the tail. */
  const rowCount = options.length + (hideCustomInput ? 0 : 1)
  const [focusIndex, setFocusIndex] = React.useState(0)
  const [checked, setChecked] = React.useState<ReadonlySet<number>>(() => new Set())
  const [customText, setCustomText] = React.useState('')
  const [customCursor, setCustomCursor] = React.useState(0)
  /** Single-select label captured by typing on a focused option — submitted
   *  together with the custom text when the input row itself is Entered. */
  const [attached, setAttached] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const inputFocused = !hideCustomInput && focusIndex === options.length
  const hintParts = inputFocused
    ? [
        t('question-hint-type'),
        t('question-hint-enter'),
        ...(options.length > 0 ? [t('question-hint-back')] : []),
        t('question-hint-esc'),
        ...(multiSelect && checked.size > 0 ? [t('question-hint-selected', { n: checked.size })] : []),
      ]
    : [
        t('question-hint-select'),
        ...(multiSelect ? [t('question-hint-multi')] : []),
        ...(hideCustomInput ? [] : [t('question-hint-attach')]),
        t('question-hint-enter'),
        t('question-hint-esc'),
        ...(multiSelect && checked.size > 0 ? [t('question-hint-selected', { n: checked.size })] : []),
      ]
  // Account for every wrapped panel row before assigning the remainder to the
  // option window. Windowed labels/descriptions are intentionally fixed at one
  // line each so listWindow's budget stays exact.
  const contentWidth = Math.max(1, terminalColumns - 4)
  const wrappedRows = (text: string, width = contentWidth): number =>
    wrapText(text, width, 'wrap').split('\n').length
  const questionRows = wrappedRows(question.question)
  const headerRows = question.header === undefined ? 0 : wrappedRows(`◈ ${question.header}`)
  const detailRows = question.detail === undefined
    ? 0
    : 1 + question.detail.split('\n').reduce((rows, line) => rows + wrappedRows(line), 0)
  const hintRows = wrappedRows(hintParts.join(' · '))
  const errorRows = error === null ? 0 : 1 + wrappedRows(error)
  // Non-option rows visible in the panel: outer top margin, divider,
  // question-block margin, options-block margin and hint margin (five), plus
  // the wrapped content itself. Keeping this accounting structural avoids the
  // old magic `12` reserve that hid providers even when a tall viewport had
  // enough physical rows for the complete catalog.
  const fixedRows = 5
    + questionRows
    + headerRows
    + detailRows
    + hintRows
    + errorRows
  // The physical terminal can be taller than the visible inline frame. Chat
  // therefore passes the rows measured above the status anchor; direct panel
  // tests and fullscreen callers use terminalRows. Window only when the
  // content's *wrapped* height exceeds that real budget—never an arbitrary
  // catalog cap, otherwise a tall terminal hides providers despite having
  // room for them.
  const panelRows = Math.max(1, Math.floor(availableRows ?? terminalRows))
  const roomBeforeInput = Math.max(1, panelRows - fixedRows)
  const showCustomInputRow = !hideCustomInput && (inputFocused || roomBeforeInput >= 2)
  const reservedRows = fixedRows + (showCustomInputRow ? 1 : 0)
  const optionBudget = Math.max(1, panelRows - reservedRows)
  const optionContentWidth = Math.max(1, terminalColumns - 7)
  const naturalOptionHeights = options.map(option =>
    wrappedRows(option.label, optionContentWidth)
      + (option.description === undefined ? 0 : wrappedRows(option.description, optionContentWidth)))
  const naturalOptionRows = naturalOptionHeights.reduce((sum, height) => sum + height, 0)
  const windowedOptions = naturalOptionRows > optionBudget
  // At the smallest heights one description would consume the entire list
  // budget and clip the focused label. Prefer the actionable label there.
  const showWindowedDescriptions = optionBudget >= 2
  const optionHeights = windowedOptions
    ? options.map(option => option.description !== undefined && showWindowedDescriptions ? 2 : 1)
    : naturalOptionHeights
  const optionFocus = Math.min(focusIndex, Math.max(options.length - 1, 0))
  const optionWindow = windowedOptions
    ? listWindow(optionHeights, optionFocus, optionBudget)
    : { start: 0, end: options.length }

  // Park the native terminal cursor on the custom-answer caret: terminal
  // emulators render IME preedit (pinyin) at the physical cursor, so without
  // this declaration CJK composition appears at the screen's bottom row
  // instead of inline at the input (same mechanism as PromptInput's value
  // box). Active whenever the input row is visible — typing on an option row
  // also lands in this input, so the IME anchor must follow even when the
  // row itself is not focused. The ref rides on the caret Text itself (all
  // three visual variants): its nodeCache rect IS the caret cell, so (0, 0)
  // stays exact under CJK widths and line wrapping without any
  // layout-affecting wrapper Box.
  const caretRef = useDeclaredCursor({ line: 0, column: 0, active: !hideCustomInput })

  const moveFocus = (delta: 1 | -1): void => {
    if (rowCount <= 1) return
    setFocusIndex(index => (index + delta + rowCount) % rowCount)
    setError(null)
  }

  /** Append at the text tail (option-row typing has no visible cursor). */
  const appendText = (text: string): void => {
    setCustomText(previous => previous + text)
    setCustomCursor(previous => previous + text.length)
    setError(null)
  }

  /** Drop the character before the cursor; empty text drops the attach. */
  const backspaceText = (): void => {
    if (customCursor <= 0) return
    setCustomText(previous => {
      const next = previous.slice(0, customCursor - 1) + previous.slice(customCursor)
      if (next === '') setAttached(null)
      return next
    })
    setCustomCursor(cursor => cursor - 1)
  }

  const checkedLabels = (): string[] =>
    [...checked].sort((a, b) => a - b).map(index => options[index]?.label)
      .filter((label): label is string => label !== undefined)

  /** Enter on a real option: the option(s) plus whatever the input row holds. */
  const submitOptions = (): void => {
    const text = customText.trim()
    if (multiSelect) {
      const selected = checkedLabels()
      if (selected.length === 0 && text === '') {
        setError(t('question-select-or-answer'))
        return
      }
      onAnswer({ selected, ...(text !== '' ? { custom: text } : {}) })
      return
    }
    const label = options[focusIndex]?.label
    if (label === undefined) {
      setError(t('question-select-or-answer'))
      return
    }
    onAnswer({ selected: [label], ...(text !== '' ? { custom: text } : {}) })
  }

  /** Enter on the input row itself: the text, plus the attached label (or
   *  the checked labels for multi-select) when there is one. */
  const submitInput = (): void => {
    const text = customText.trim()
    if (multiSelect) {
      const selected = checkedLabels()
      if (selected.length === 0 && text === '') {
        setError(t('question-answer-or-check'))
        return
      }
      onAnswer({ selected, ...(text !== '' ? { custom: text } : {}) })
      return
    }
    if (text === '') {
      setError(t('question-type-answer-first'))
      return
    }
    onAnswer({ selected: attached !== null ? [attached] : [], custom: text })
  }

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }

    if (inputFocused) {
      if (key.upArrow) {
        moveFocus(-1)
        return
      }
      if (key.downArrow) {
        moveFocus(1)
        return
      }
      if (isPlainReturnInput(input, key)) {
        submitInput()
        return
      }
      if (key.backspace) {
        backspaceText()
        return
      }
      if (key.delete) {
        if (customCursor < customText.length) {
          setCustomText(text => {
            const next = text.slice(0, customCursor) + text.slice(customCursor + 1)
            if (next === '') setAttached(null)
            return next
          })
        }
        return
      }
      if (key.leftArrow) {
        setCustomCursor(cursor => Math.max(0, cursor - 1))
        return
      }
      if (key.rightArrow) {
        setCustomCursor(cursor => Math.min(customText.length, cursor + 1))
        return
      }
      if (key.home) {
        setCustomCursor(0)
        return
      }
      if (key.end) {
        setCustomCursor(customText.length)
        return
      }
      if (!key.ctrl && !key.meta && !key.super && input) {
        setCustomText(text => text.slice(0, customCursor) + input + text.slice(customCursor))
        setCustomCursor(cursor => cursor + input.length)
        setError(null)
      }
      return
    }

    // A real option row.
    if (key.upArrow) {
      moveFocus(-1)
      return
    }
    if (key.downArrow) {
      moveFocus(1)
      return
    }
    if (key.tab && !hideCustomInput) {
      setFocusIndex(options.length)
      setError(null)
      return
    }
    if (input === ' ' && multiSelect) {
      setChecked(previous => {
        const next = new Set(previous)
        if (next.has(focusIndex)) next.delete(focusIndex)
        else next.add(focusIndex)
        return next
      })
      return
    }
    if (isPlainReturnInput(input, key)) {
      submitOptions()
      return
    }
    if (key.backspace) {
      // Edit the input row without leaving the option list.
      if (!hideCustomInput && customText !== '') backspaceText()
      return
    }
    // Typing on an option appends into the input row; single-select also
    // attaches this option's label so Enter carries label + text (#9).
    if (!hideCustomInput && !key.ctrl && !key.meta && !key.super && input) {
      appendText(input)
      if (!multiSelect) setAttached(options[focusIndex]?.label ?? null)
    }
  }, { isActive: true })

  const remaining = total - answered
  const headerTitle = ` ${t('question-header-progress', { position, total, remaining: remaining > 1 ? t('question-remaining-more', { n: remaining }) : '' })} `

  const cursorChar = customCursor < customText.length ? customText[customCursor] : ' '
  const renderInputRow = (): React.ReactNode => (
    <Box flexDirection="row" marginTop={inputFocused ? 1 : 0}>
      <Box width={1} flexShrink={0}>
        <Text color={inputFocused ? 'claude' : undefined} bold={inputFocused}>
          {inputFocused ? POINTER : ' '}
        </Text>
      </Box>
      <Box width={1} flexShrink={0}>
        <Text color={inputFocused ? 'claude' : 'suggestion'}>{PENCIL}</Text>
      </Box>
      <Box flexDirection="row" marginLeft={1}>
        <Text bold={inputFocused} color={inputFocused ? 'claude' : 'suggestion'}>
          {t('question-custom-tab')}
        </Text>
        {attached !== null && (
          <Text color="suggestion">{t('question-attached-label', { label: attached })}</Text>
        )}
        <Text dimColor>：</Text>
        {customText === '' && !inputFocused ? (
          <Text ref={caretRef} dimColor>{t('question-direct-input')}</Text>
        ) : (
          <>
            <Text wrap="wrap">{customText.slice(0, customCursor)}</Text>
            {inputFocused
              ? <Text ref={caretRef} inverse>{cursorChar}</Text>
              : <Text ref={caretRef} color="suggestion">▏</Text>}
            <Text wrap="wrap">{customText.slice(inputFocused ? customCursor + 1 : customCursor)}</Text>
          </>
        )}
      </Box>
    </Box>
  )

  const renderOptions = (): React.ReactNode => (
    <Box flexDirection="column" marginTop={1}>
      {options.slice(optionWindow.start, optionWindow.end).map((option, index) => {
        const absoluteIndex = optionWindow.start + index
        const focused = absoluteIndex === focusIndex
        const selected = multiSelect ? checked.has(absoluteIndex) : focused
        const pointer = focused
          ? POINTER
          : absoluteIndex === optionWindow.start && optionWindow.start > 0
            ? '↑'
            : absoluteIndex === optionWindow.end - 1 && optionWindow.end < options.length
              ? '↓'
              : ' '
        const label = windowedOptions ? option.label.replace(/\s+/gu, ' ').trim() : option.label
        const description = windowedOptions
          ? option.description?.replace(/\s+/gu, ' ').trim()
          : option.description
        return (
          <Box
            key={`${absoluteIndex}:${option.label}`}
            flexDirection="row"
            marginTop={!windowedOptions && focused ? 1 : 0}
          >
            <Box width={1} flexShrink={0}>
              <Text color={focused ? 'claude' : undefined} bold={focused}>
                {pointer}
              </Text>
            </Box>
            <Box width={1} flexShrink={0}>
              <Text color={focused ? 'claude' : undefined} bold={selected}>
                {selected ? (multiSelect ? CHECKED : '●') : UNCHECKED}
              </Text>
            </Box>
            <Box flexDirection="column" marginLeft={1}>
              <Text
                bold={focused || selected}
                color={focused ? 'claude' : undefined}
                wrap={windowedOptions ? 'truncate' : 'wrap'}
              >
                {label}
              </Text>
              {description !== undefined && (!windowedOptions || showWindowedDescriptions) && (
                <Text dimColor wrap={windowedOptions ? 'truncate' : 'wrap'}>
                  {description}
                </Text>
              )}
            </Box>
          </Box>
        )
      })}
      {showCustomInputRow ? renderInputRow() : null}
    </Box>
  )

  // With only one to three rows above the status chrome, the full decorated
  // panel cannot fit. Keep the focused action and submit/cancel controls on
  // screen instead of allowing margins, detail text, or descriptions to clip
  // the only answer the user can act on.
  if (panelRows <= 3) {
    const focusedOption = options[optionFocus]
    const focusedSelected = focusedOption !== undefined
      && (multiSelect ? checked.has(optionFocus) : focusIndex === optionFocus)
    const compactLabel = inputFocused
      ? `${t('question-custom-tab')}: ${customText}`
      : `${focusedSelected ? (multiSelect ? CHECKED : '●') : UNCHECKED} ${focusedOption?.label ?? question.question}`
    return (
      <Box flexDirection="column" paddingLeft={2} paddingRight={2} width="100%">
        {panelRows >= 3 && <Text bold wrap="truncate">{question.question}</Text>}
        <Text color="claude" bold wrap="truncate">›{compactLabel}</Text>
        {panelRows >= 2 && (
          <Text dimColor wrap="truncate">
            {t('question-hint-enter')} · {t('question-hint-esc')}
          </Text>
        )}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2} paddingRight={2} width="100%">
      <Divider color="permission" title={headerTitle} padding={4} />
      <Box flexDirection="column" marginTop={1}>
        {question.header !== undefined && (
          <Text color="suggestion" bold>
            ◈ {question.header}
          </Text>
        )}
        <Text bold wrap="wrap">
          {question.question}
        </Text>
        {question.detail !== undefined && (
          <Box flexDirection="column" marginTop={1}>
            {question.detail.split('\n').map((line, index) => (
              <Text key={index} dimColor italic wrap="wrap">
                {line}
              </Text>
            ))}
          </Box>
        )}
      </Box>
      {renderOptions()}
      {error !== null && (
        <Box marginTop={1}>
          <Text color="error">{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>{hintParts.join(' · ')}</Text>
      </Box>
    </Box>
  )
}
