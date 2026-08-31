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
import type { QuestionDraft, QuestionSelection } from '../../dsh-adapter/questions.js'
import { PlanReviewPanel } from './PlanReviewPanel.js'
import { isPlainReturnInput } from '../../utils/modifiers.js'
import { listWindow } from '../listWindow.js'

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
    /** Pre-checked option labels (multi-select) / default-focused option
     *  (single-select) shown on first display, before any saved draft — e.g.
     *  the models already enabled on a provider being edited. */
    readonly defaultSelected?: readonly string[]
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
  /** Previously saved answer or draft, restored when returning to this item. */
  readonly initialDraft?: QuestionDraft
  readonly onAnswer: (selection: QuestionSelection) => void
  /** Esc on the first question / Ctrl+C — aborts the whole ask. */
  readonly onCancel: () => void
  /** Esc on later questions — navigates to the previous question. */
  readonly onBack?: (draft: QuestionDraft) => void
}

export function AskUserQuestionPanel({
  question,
  position,
  total,
  answered,
  initialDraft,
  onAnswer,
  onCancel,
  onBack,
}: AskUserQuestionPanelProps): React.ReactNode {
  // Plan-mode's exit_plan_mode ask carries a presentation intent: render
  // the CC-style decision card instead of the generic questionnaire. The
  // branch precedes every hook so hook order stays stable per remount key.
  if (question.intent?.kind === 'plan-review') {
    return <PlanReviewPanel question={question} onAnswer={onAnswer} onCancel={onCancel} />
  }
  const options = question.options ?? []
  const multiSelect = question.multiSelect === true
  const hideCustomInput = question.hideCustomInput === true && options.length > 0
  const { rows: terminalRows } = useTerminalSize()
  /** Rows: the real options plus the inline input row at the tail. */
  const rowCount = options.length + (hideCustomInput ? 0 : 1)
  // A saved draft wins over the wizard's default selection (returning to a
  // question must restore exactly what the user last had, including an
  // explicit empty answer); the defaults only apply on first display.
  const initialSelected = initialDraft !== undefined
    ? initialDraft.selected
    : question.defaultSelected ?? []
  const initialCustom = initialDraft?.custom ?? ''
  const selectedIndices = options
    .map((option, index) => initialSelected.includes(option.label) ? index : -1)
    .filter(index => index >= 0)
  const initialFocus = initialCustom !== '' && selectedIndices.length === 0 && !hideCustomInput
    ? options.length
    : selectedIndices[0] ?? 0
  const [focusIndex, setFocusIndex] = React.useState(initialFocus)
  const [checked, setChecked] = React.useState<ReadonlySet<number>>(
    () => new Set(multiSelect ? selectedIndices : []),
  )
  const [customText, setCustomText] = React.useState(initialCustom)
  const [customCursor, setCustomCursor] = React.useState(initialCustom.length)
  /** Single-select label captured by typing on a focused option — submitted
   *  together with the custom text when the input row itself is Entered. */
  const [attached, setAttached] = React.useState<string | null>(
    () => initialCustom !== '' && !multiSelect ? (initialSelected[0] ?? null) : null,
  )
  const [error, setError] = React.useState<string | null>(null)

  const inputFocused = !hideCustomInput && focusIndex === options.length
  // Chat chrome + panel scaffolding consume twelve rows before the option
  // list: status line, outer/divider/question/list/hint spacing and content.
  // Optional header/detail/input/error rows are charged explicitly. Long
  // lists then use fixed one/two-line rows so listWindow's budget is exact;
  // short questionnaires retain their existing wrapped presentation.
  const detailRows = question.detail === undefined ? 0 : question.detail.split('\n').length + 1
  const reservedRows = 12
    + (question.header === undefined ? 0 : 1)
    + detailRows
    + (hideCustomInput ? 0 : 1)
    + (error === null ? 0 : 2)
  const optionBudget = Math.max(terminalRows - reservedRows, 2)
  const optionHeights = options.map(option => option.description === undefined ? 1 : 2)
  const windowedOptions = optionHeights.reduce((sum, height) => sum + height, 0) > optionBudget
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

  /** Capture the visible answer state before navigating away. */
  const currentDraft = (): QuestionDraft => {
    const selected = multiSelect
      ? checkedLabels()
      : inputFocused
        ? (attached === null ? [] : [attached])
        : (() => {
            const label = options[focusIndex]?.label
            return label === undefined ? [] : [label]
          })()
    return {
      selected,
      ...(customText !== '' ? { custom: customText } : {}),
    }
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onCancel()
      return
    }
    if (key.escape) {
      if (onBack !== undefined) onBack(currentDraft())
      else onCancel()
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
  /** Mouse: click the input row to focus it (same as Tab). */
  const focusInputRow = (): void => {
    if (hideCustomInput) return
    setFocusIndex(options.length)
    setError(null)
  }
  /**
   * Mouse: click an option row. Multi-select toggles the checkmark (same as
   * Space); single-select answers immediately with that option plus any
   * typed text (same as focusing the row and pressing Enter) — one click =
   * one answer, matching ApprovalPanel's click semantics.
   */
  const clickOption = (index: number): void => {
    if (multiSelect) {
      setChecked(previous => {
        const next = new Set(previous)
        if (next.has(index)) next.delete(index)
        else next.add(index)
        return next
      })
      return
    }
    const label = options[index]?.label
    if (label === undefined) return
    const text = customText.trim()
    onAnswer({ selected: [label], ...(text !== '' ? { custom: text } : {}) })
  }
  const [hoverIndex, setHoverIndex] = React.useState(-1)
  const renderInputRow = (): React.ReactNode => (
    <Box
      flexDirection="row"
      marginTop={inputFocused ? 1 : 0}
      onClick={focusInputRow}
      onMouseEnter={() => setHoverIndex(options.length)}
      onMouseLeave={() => setHoverIndex(current => (current === options.length ? -1 : current))}
      backgroundColor={hoverIndex === options.length && !inputFocused ? 'userMessageBackgroundHover' : undefined}
    >
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
            onClick={() => clickOption(absoluteIndex)}
            onMouseEnter={() => setHoverIndex(absoluteIndex)}
            onMouseLeave={() => setHoverIndex(current => (current === absoluteIndex ? -1 : current))}
            backgroundColor={hoverIndex === absoluteIndex && !focused ? 'userMessageBackgroundHover' : undefined}
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
              {description !== undefined && (
                <Text dimColor wrap={windowedOptions ? 'truncate' : 'wrap'}>
                  {description}
                </Text>
              )}
            </Box>
          </Box>
        )
      })}
      {hideCustomInput ? null : renderInputRow()}
    </Box>
  )

  const hintParts = inputFocused
    ? [
        t('question-hint-type'),
        t('question-hint-enter'),
        ...(options.length > 0 ? [t('question-hint-back')] : []),
        onBack === undefined ? t('question-hint-esc') : t('question-hint-previous'),
        ...(onBack === undefined ? [] : [t('question-hint-cancel')]),
        ...(multiSelect && checked.size > 0 ? [t('question-hint-selected', { n: checked.size })] : []),
      ]
    : [
        t('question-hint-select'),
        ...(multiSelect ? [t('question-hint-multi')] : []),
        ...(hideCustomInput ? [] : [t('question-hint-attach')]),
        t('question-hint-enter'),
        onBack === undefined ? t('question-hint-esc') : t('question-hint-previous'),
        ...(onBack === undefined ? [] : [t('question-hint-cancel')]),
        ...(multiSelect && checked.size > 0 ? [t('question-hint-selected', { n: checked.size })] : []),
      ]

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2} paddingRight={2} width="100%">
      <Divider color="permission" title={headerTitle} />
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
