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
import { Box, Text, useInput } from '../../ui.js'
import { Divider } from '../design-system/Divider.js'
import { POINTER } from '../../cc/figures.js'
import type { QuestionSelection } from '../../questions.js'

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
  }
  /** 1-based position within the batch (progress header). */
  readonly position: number
  /** Total questions in the batch (progress header). */
  readonly total: number
  /** Questions answered before the current one. */
  readonly answered: number
  readonly onAnswer: (selection: QuestionSelection) => void
  /** Esc / Ctrl+C — aborts the whole ask (ASK_ABORTED back to the model). */
  readonly onCancel: () => void
}

export function AskUserQuestionPanel({
  question,
  position,
  total,
  answered,
  onAnswer,
  onCancel,
}: AskUserQuestionPanelProps): React.ReactNode {
  const options = question.options ?? []
  const multiSelect = question.multiSelect === true
  /** Rows: the real options plus the inline input row at the tail. */
  const rowCount = options.length + 1
  const [focusIndex, setFocusIndex] = React.useState(0)
  const [checked, setChecked] = React.useState<ReadonlySet<number>>(() => new Set())
  const [customText, setCustomText] = React.useState('')
  const [customCursor, setCustomCursor] = React.useState(0)
  /** Single-select label captured by typing on a focused option — submitted
   *  together with the custom text when the input row itself is Entered. */
  const [attached, setAttached] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const inputFocused = focusIndex === options.length

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
      if (key.return) {
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
      if (!key.ctrl && !key.meta && input) {
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
    if (key.tab) {
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
    if (key.return) {
      submitOptions()
      return
    }
    if (key.backspace) {
      // Edit the input row without leaving the option list.
      if (customText !== '') backspaceText()
      return
    }
    // Typing on an option appends into the input row; single-select also
    // attaches this option's label so Enter carries label + text (#9).
    if (!key.ctrl && !key.meta && input) {
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
          <Text dimColor>{t('question-direct-input')}</Text>
        ) : (
          <>
            <Text wrap="wrap">{customText.slice(0, customCursor)}</Text>
            {inputFocused
              ? <Text inverse>{cursorChar}</Text>
              : <Text color="suggestion">▏</Text>}
            <Text wrap="wrap">{customText.slice(inputFocused ? customCursor + 1 : customCursor)}</Text>
          </>
        )}
      </Box>
    </Box>
  )

  const renderOptions = (): React.ReactNode => (
    <Box flexDirection="column" marginTop={1}>
      {options.map((option, index) => {
        const focused = index === focusIndex
        const selected = multiSelect ? checked.has(index) : focused
        return (
          <Box key={option.label} flexDirection="row" marginTop={focused ? 1 : 0}>
            <Box width={1} flexShrink={0}>
              <Text color={focused ? 'claude' : undefined} bold={focused}>
                {focused ? POINTER : ' '}
              </Text>
            </Box>
            <Box width={1} flexShrink={0}>
              <Text color={focused ? 'claude' : undefined} bold={selected}>
                {selected ? (multiSelect ? CHECKED : '●') : UNCHECKED}
              </Text>
            </Box>
            <Box flexDirection="column" marginLeft={1}>
              <Text bold={focused || selected} color={focused ? 'claude' : undefined} wrap="wrap">
                {option.label}
              </Text>
              {option.description !== undefined && (
                <Text dimColor wrap="wrap">
                  {option.description}
                </Text>
              )}
            </Box>
          </Box>
        )
      })}
      {renderInputRow()}
    </Box>
  )

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
        t('question-hint-attach'),
        t('question-hint-enter'),
        t('question-hint-esc'),
        ...(multiSelect && checked.size > 0 ? [t('question-hint-selected', { n: checked.size })] : []),
      ]

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
