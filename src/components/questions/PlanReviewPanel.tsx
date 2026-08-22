/**
 * The plan-review panel — Claude Code style exit-plan-mode decision card
 * for the DSH user-interaction seam. plan-mode's `exit_plan_mode` tool asks
 * through `ctx.userQuestions` with `intent: { kind: 'plan-review',
 * approve }`: the plan markdown arrives in `detail`, the approve/decline
 * choices in `options` (labels verbatim — the protocol answers with the
 * asker's own labels).
 *
 * Protocol-exact answer mapping (dsh-plan-mode):
 * - Approve: `{ selected: [intent.approve] }` — custom MUST be absent, or
 *   plan-mode treats it as keep-planning-with-feedback.
 * - Keep planning / feedback: `{ selected: [declineLabel], custom? }` where
 *   declineLabel is the first option that is not the approve label.
 * - Esc / Ctrl+C: the store rejects with ASK_CANCELLED, which plan-mode
 *   reads as "the user dismissed the review to speak instead".
 */

import React from 'react'
import { t } from '../../i18n.js'
import { Box, ScrollBox, Text, useInput, type ScrollBoxHandle } from '../../ui.js'
import { useDeclaredCursor } from '../../ink/hooks/use-declared-cursor.js'
import { Divider } from '../design-system/Divider.js'
import { Markdown } from '../Markdown.js'
import { POINTER } from '../../cc/figures.js'
import type { QuestionSelection } from '../../dsh-adapter/questions.js'
import { isPlainReturnInput } from '../../utils/modifiers.js'
import { listWindow } from '../listWindow.js'

const PENCIL = '✎'

export type PlanReviewPanelProps = {
  /** The plan-review question (intent.kind === 'plan-review'). */
  readonly question: {
    readonly question: string
    readonly header?: string
    readonly detail?: string
    readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }>
    readonly intent?: { readonly kind: 'plan-review'; readonly approve: string }
  }
  /** Physical rows available to the question overlay. When omitted, retain
   *  the historical intrinsic-height standalone layout. */
  readonly availableRows?: number
  readonly onAnswer: (selection: QuestionSelection) => void
  /** Esc / Ctrl+C — dismissed to speak instead (ASK_CANCELLED). */
  readonly onCancel: () => void
}

export function PlanReviewPanel({
  question,
  availableRows,
  onAnswer,
  onCancel,
}: PlanReviewPanelProps): React.ReactNode {
  const options = question.options ?? []
  const approveLabel = question.intent?.approve ?? options[0]?.label
  const declineLabel = options.find(option => option.label !== approveLabel)?.label
  /** Rows: the asker's options plus the feedback input row at the tail. */
  const rowCount = options.length + 1
  const [focusIndex, setFocusIndex] = React.useState(0)
  const [feedback, setFeedback] = React.useState('')
  const [cursor, setCursor] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)
  const detailScrollRef = React.useRef<ScrollBoxHandle | null>(null)

  const inputFocused = focusIndex === options.length

  // Park the native terminal cursor on the feedback caret so IME preedit
  // (pinyin) renders inline at the input instead of the screen's bottom row
  // (same mechanism as AskUserQuestionPanel / PromptInput). Always active —
  // typing on an option row also lands in the feedback buffer. The ref rides
  // on the caret Text itself (all visual variants): its nodeCache rect IS
  // the caret cell, so (0, 0) stays exact under wrapping without a
  // layout-affecting wrapper Box.
  const caretRef = useDeclaredCursor({ line: 0, column: 0, active: true })

  const moveFocus = (delta: 1 | -1): void => {
    setFocusIndex(index => (index + delta + rowCount) % rowCount)
    setError(null)
  }

  /** Typing anywhere appends to the feedback buffer and focuses the input
   *  row — plan review has no "attach" semantics: approve must be clean. */
  const appendFeedback = (text: string): void => {
    setFeedback(previous => previous + text)
    setCursor(previous => previous + text.length)
    setFocusIndex(options.length)
    setError(null)
  }

  const backspaceFeedback = (): void => {
    if (cursor <= 0) return
    setFeedback(previous => previous.slice(0, cursor - 1) + previous.slice(cursor))
    setCursor(previous => previous - 1)
  }

  /** The decline answer: the other option's label when the asker named one,
   *  else an empty selection (plan-mode reads any non-approve as decline). */
  const declineSelected = (): string[] => declineLabel !== undefined ? [declineLabel] : []

  /** Enter on an option row. Approve with feedback in the buffer is an
   *  error — the protocol would silently read it as keep-planning. */
  const submitOption = (index: number): void => {
    const label = options[index]?.label
    if (label === undefined) return
    const text = feedback.trim()
    if (label === approveLabel && text !== '') {
      setError(t('plan-review-approve-needs-empty'))
      return
    }
    if (label === approveLabel) {
      onAnswer({ selected: [label] })
      return
    }
    onAnswer({ selected: [label], ...(text !== '' ? { custom: text } : {}) })
  }

  /** Enter on the feedback row: text routes to keep-planning-with-feedback;
   *  empty is a plain keep-planning. */
  const submitFeedback = (): void => {
    const text = feedback.trim()
    onAnswer({ selected: declineSelected(), ...(text !== '' ? { custom: text } : {}) })
  }

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel()
      return
    }

    // Keep decision navigation on the arrow keys; PageUp/PageDown browse a
    // long plan body without moving or submitting the current decision.
    if (key.pageUp || key.pageDown) {
      const page = Math.max(1, detailScrollRef.current?.getViewportHeight() ?? 1)
      detailScrollRef.current?.scrollBy(key.pageUp ? -page : page)
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
        submitFeedback()
        return
      }
      if (key.backspace) {
        backspaceFeedback()
        return
      }
      if (key.delete) {
        if (cursor < feedback.length) {
          setFeedback(text => text.slice(0, cursor) + text.slice(cursor + 1))
        }
        return
      }
      if (key.leftArrow) {
        setCursor(value => Math.max(0, value - 1))
        return
      }
      if (key.rightArrow) {
        setCursor(value => Math.min(feedback.length, value + 1))
        return
      }
      if (key.home) {
        setCursor(0)
        return
      }
      if (key.end) {
        setCursor(feedback.length)
        return
      }
      if (!key.ctrl && !key.meta && input) {
        setFeedback(text => text.slice(0, cursor) + input + text.slice(cursor))
        setCursor(value => value + input.length)
        setError(null)
      }
      return
    }

    // An option row.
    if (key.upArrow) {
      moveFocus(-1)
      return
    }
    if (key.downArrow) {
      moveFocus(1)
      return
    }
    if (isPlainReturnInput(input, key)) {
      submitOption(focusIndex)
      return
    }
    if (key.backspace) {
      if (feedback !== '') backspaceFeedback()
      return
    }
    if (!key.ctrl && !key.meta && input) {
      // Number quick-pick submits the option outright — but only with an
      // empty buffer; with feedback pending, digits are feedback chars.
      const digit = /^[1-9]$/.test(input) ? Number(input) : 0
      if (feedback === '' && digit >= 1 && digit <= options.length) {
        submitOption(digit - 1)
        return
      }
      appendFeedback(input)
    }
  }, { isActive: true })

  const cursorChar = cursor < feedback.length ? feedback[cursor] : ' '

  // Inside Chat the panel is an absolute overlay and therefore has a hard
  // physical row budget. Pin decisions, feedback and controls below a
  // scrollable plan viewport; window unusually large decision lists around
  // the current focus. Standalone renders keep the original rich layout.
  if (availableRows !== undefined) {
    const panelRows = Math.max(1, Math.floor(availableRows))
    const errorRows = error === null ? 0 : 1
    // One scroll viewport + feedback + hint (+ optional error). Header,
    // question and Markdown all live in the viewport so none is discarded;
    // PageUp/PageDown reaches every wrapped row.
    const fixedRows = 3 + errorRows
    const optionBudget = Math.max(1, panelRows - fixedRows)
    const optionFocus = Math.min(focusIndex, Math.max(options.length - 1, 0))
    const optionWindow = listWindow(options.map(() => 1), optionFocus, optionBudget)
    const visibleOptions = options.slice(optionWindow.start, optionWindow.end)
    const detailViewportRows = Math.max(1, panelRows - fixedRows - visibleOptions.length + 1)

    return (
      <Box flexDirection="column" paddingLeft={2} paddingRight={2} width="100%">
        <ScrollBox
          ref={detailScrollRef}
          height={detailViewportRows}
          flexDirection="column"
          flexShrink={0}
        >
          {question.header !== undefined && (
            <Text color="suggestion" bold wrap="wrap">◈ {question.header}</Text>
          )}
          <Text bold wrap="wrap">{question.question}</Text>
          {question.detail !== undefined && (
            <Markdown>{question.detail}</Markdown>
          )}
        </ScrollBox>
        {visibleOptions.map((option, index) => {
          const absoluteIndex = optionWindow.start + index
          const focused = absoluteIndex === focusIndex
          const isApprove = option.label === approveLabel
          const marker = absoluteIndex === optionWindow.start && optionWindow.start > 0
            ? '↑'
            : absoluteIndex === optionWindow.end - 1 && optionWindow.end < options.length
              ? '↓'
              : focused ? POINTER : ' '
          return (
            <Box key={`${absoluteIndex}:${option.label}`} flexDirection="row">
              <Box width={1} flexShrink={0}>
                <Text color={focused ? 'claude' : undefined} bold={focused}>{marker}</Text>
              </Box>
              <Text
                bold={focused}
                color={focused || isApprove ? 'claude' : undefined}
                wrap="truncate"
              >
                {absoluteIndex + 1}. {option.label}
                {option.description !== undefined && <Text dimColor> — {option.description}</Text>}
              </Text>
            </Box>
          )
        })}
        <Box flexDirection="row" height={1} overflow="hidden">
          <Text color={inputFocused ? 'claude' : undefined} bold={inputFocused}>
            {inputFocused ? POINTER : ' '}
          </Text>
          <Text color={inputFocused ? 'claude' : 'suggestion'}>{PENCIL} </Text>
          {feedback === '' && !inputFocused ? (
            <Text ref={caretRef} dimColor wrap="truncate">{t('plan-review-feedback-placeholder')}</Text>
          ) : (
            <>
              <Text wrap="truncate">{feedback.slice(0, cursor)}</Text>
              {inputFocused
                ? <Text ref={caretRef} inverse>{cursorChar}</Text>
                : <Text ref={caretRef} color="suggestion">▏</Text>}
              <Text wrap="truncate">{feedback.slice(inputFocused ? cursor + 1 : cursor)}</Text>
            </>
          )}
        </Box>
        {error !== null && <Text color="error" wrap="truncate">{error}</Text>}
        <Text dimColor wrap="truncate">{t('plan-review-hint')}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2} paddingRight={2} width="100%">
      <Divider
        color="permission"
        title={` ${question.header ?? t('plan-review-fallback-header')} `}
        padding={4}
      />
      <Box flexDirection="column" marginTop={1}>
        <Text bold wrap="wrap">
          {question.question}
        </Text>
        {question.detail !== undefined && (
          <Box flexDirection="column" marginTop={1}>
            <Markdown>{question.detail}</Markdown>
          </Box>
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => {
          const focused = index === focusIndex
          const isApprove = option.label === approveLabel
          return (
            <Box key={option.label} flexDirection="row" marginTop={focused ? 1 : 0}>
              <Box width={1} flexShrink={0}>
                <Text color={focused ? 'claude' : undefined} bold={focused}>
                  {focused ? POINTER : ' '}
                </Text>
              </Box>
              <Box flexDirection="column" marginLeft={1}>
                <Text
                  bold={focused}
                  color={focused || isApprove ? 'claude' : undefined}
                  wrap="wrap"
                >
                  {index + 1}. {option.label}
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
            {feedback === '' && !inputFocused ? (
              <Text ref={caretRef} dimColor>{t('plan-review-feedback-placeholder')}</Text>
            ) : (
              <>
                <Text wrap="wrap">{feedback.slice(0, cursor)}</Text>
                {inputFocused
                  ? <Text ref={caretRef} inverse>{cursorChar}</Text>
                  : <Text ref={caretRef} color="suggestion">▏</Text>}
                <Text wrap="wrap">{feedback.slice(inputFocused ? cursor + 1 : cursor)}</Text>
              </>
            )}
          </Box>
        </Box>
      </Box>
      {error !== null && (
        <Box marginTop={1}>
          <Text color="error">{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>{t('plan-review-hint')}</Text>
      </Box>
    </Box>
  )
}
