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
import { Box, Text, useInput, ScrollBox, useTerminalSize, type ScrollBoxHandle } from '../../ui.js'
import { useDeclaredCursor } from '../../ink/hooks/use-declared-cursor.js'
import { Divider } from '../design-system/Divider.js'
import { Markdown } from '../Markdown.js'
import { POINTER } from '../../cc/figures.js'
import type { QuestionSelection } from '../../dsh-adapter/questions.js'
import { isPlainReturnInput } from '../../utils/modifiers.js'

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
  readonly onAnswer: (selection: QuestionSelection) => void
  /** Esc / Ctrl+C — dismissed to speak instead (ASK_CANCELLED). */
  readonly onCancel: () => void
}

export function PlanReviewPanel({
  question,
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
  const { rows: terminalRows } = useTerminalSize()
  // Chat chrome (status line) + panel scaffolding (divider, question,
  // spacings, hint) consume twelve rows before the plan body — same
  // constant as AskUserQuestionPanel. Option/feedback/error rows are
  // charged on top so a long markdown detail cannot push them off-screen.
  // A definite `height` (not just maxHeight) is required: otherwise the
  // ScrollBox grows with the markdown and scrollBy is a no-op.
  const optionRows = options.reduce(
    (sum, option) => sum + (option.description === undefined ? 1 : 2),
    0,
  ) + 1 /* extra gap on the focused option */ + 1 /* feedback row */
  const reservedRows = 12 + optionRows + (error === null ? 0 : 2)
  // Floor at zero, not four: on a short terminal the decision rows fill the
  // budget and no plan-body rows remain. Forcing four here would re-inflate
  // the panel past the viewport and push the controls off-screen again — the
  // exact regression this panel exists to prevent. When nothing remains, the
  // body viewport is omitted entirely (a zero-height ScrollBox is neither
  // readable nor a useful wheel target).
  const detailMax = Math.max(0, terminalRows - reservedRows)
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

  useInput((input, key, event) => {
    // Steal the wheel while this panel is mounted so Chat's fallback cannot
    // scroll the transcript. Position-first already hits the ScrollBox when
    // the pointer is over it; this covers the option/hint rows and any
    // dispatchWheelAt miss. Up/Down stay on the decision rows.
    if (key.wheelUp || key.wheelDown) {
      detailScrollRef.current?.scrollBy(key.wheelUp ? -3 : 3)
      event.stopImmediatePropagation()
      return
    }
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
  /** Mouse: click a decision row = focus it + submit (same as Enter). */
  const [hoverIndex, setHoverIndex] = React.useState(-1)
  const clickOption = (index: number): void => {
    setFocusIndex(index)
    submitOption(index)
  }
  /** Mouse: click the feedback row to focus it. */
  const focusFeedbackRow = (): void => {
    setFocusIndex(options.length)
    setError(null)
  }

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2} paddingRight={2} width="100%">
      <Divider
        color="permission"
        title={` ${question.header ?? t('plan-review-fallback-header')} `}
      />
      <Box flexDirection="column" marginTop={1}>
        <Text bold wrap="wrap">
          {question.question}
        </Text>
        {question.detail !== undefined && detailMax > 0 && (
          <Box flexDirection="column" marginTop={1} height={detailMax} flexShrink={0}>
            <ScrollBox ref={detailScrollRef} flexDirection="column" flexGrow={1} height={detailMax}>
              <Markdown>{question.detail}</Markdown>
            </ScrollBox>
          </Box>
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => {
          const focused = index === focusIndex
          const isApprove = option.label === approveLabel
          return (
            <Box
              key={option.label}
              flexDirection="row"
              marginTop={focused ? 1 : 0}
              onClick={() => clickOption(index)}
              onMouseEnter={() => setHoverIndex(index)}
              onMouseLeave={() => setHoverIndex(current => (current === index ? -1 : current))}
              backgroundColor={hoverIndex === index && !focused ? 'userMessageBackgroundHover' : undefined}
            >
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
        <Box
          flexDirection="row"
          marginTop={inputFocused ? 1 : 0}
          onClick={focusFeedbackRow}
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
