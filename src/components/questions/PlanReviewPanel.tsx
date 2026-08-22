/**
 * The plan-review panel — Claude Code style exit-plan-mode decision card
 * for the DSH user-interaction seam. plan-mode's `exit_plan_mode` tool asks
 * through `ctx.userQuestions` with `intent: { kind: 'plan-review',
 * approve }`: the plan markdown arrives in `detail`, the approve/decline
 * choices in `options`. The decline row is RELABELED as Exit planning for
 * display only when the caller opts in (`exitPlanning` — Chat does this for
 * Liangshen sessions with `/planPrompt` on). Everywhere else the decline
 * row keeps the asker's own label, description, and keep-planning answer,
 * so standard `/plan` sessions are byte-for-byte the pre-Exit panel.
 *
 * Answer mapping (dsh-plan-mode + the TUI's opt-in Exit planning row):
 * - Approve: `{ selected: [intent.approve] }` — custom MUST be absent, or
 *   plan-mode treats it as keep-planning-with-feedback.
 * - Exit planning (exitPlanning only): the displayed replacement for the
 *   asker's first non-approve option. It never answers the ask;
 *   `onExitPlanning` leaves plan mode through dsh-plan-mode's controller
 *   (replacing any queued `/plan on` pending intent, not just appending
 *   `plan/mode` off), rejects the question with PLAN_REVIEW_EXITED, and
 *   aborts the calling agent's turn so the unapproved plan cannot run.
 * - Keep planning / feedback: the decline option (or the feedback row)
 *   sends `{ selected: [declineLabel], custom? }` where declineLabel is the
 *   asker's first option that is not the approve label.
 * - Esc / Ctrl+C: the store rejects with ASK_CANCELLED, which plan-mode
 *   reads as "the user dismissed the review to speak instead".
 */

import React from 'react'
import { t } from '../../i18n.js'
import { Box, Text, useInput } from '../../ui.js'
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
  /** Second decision row: exit plan mode + /planPrompt without approving. */
  readonly onExitPlanning: () => void
  /** Opt-in Exit planning row (Liangshen preset + `/planPrompt` on). When
   *  false (the default), the asker's decline option keeps its own label,
   *  description, and keep-planning answer. */
  readonly exitPlanning?: boolean
}

export function PlanReviewPanel({
  question,
  onAnswer,
  onCancel,
  onExitPlanning,
  exitPlanning,
}: PlanReviewPanelProps): React.ReactNode {
  const options = question.options ?? []
  const approveLabel = question.intent?.approve ?? options[0]?.label
  const exitPlanningEnabled = exitPlanning === true
  /** The asker's keep-planning option is the protocol label for feedback-row
   *  answers, and becomes the Exit planning row only when opted in. */
  const declineLabel = options.find(option => option.label !== approveLabel)?.label
  const exitIndex = exitPlanningEnabled
    ? options.findIndex(option => option.label !== approveLabel)
    : -1
  /** Rows: the asker's options plus the feedback input row at the tail. */
  const rowCount = options.length + 1
  const [focusIndex, setFocusIndex] = React.useState(0)
  const [feedback, setFeedback] = React.useState('')
  const [cursor, setCursor] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)

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
   *  row — plan review has no "attach" semantics: decisions must be clean. */
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

  /** The decline answer for the feedback row: the asker's other-option label
   *  when it named one, else an empty selection (plan-mode reads any
   *  non-approve as decline). */
  const declineSelected = (): string[] => declineLabel !== undefined ? [declineLabel] : []

  /** Enter on an option row. Approve (always) and Exit planning (when
   *  enabled) with feedback in the buffer are errors — clean decisions. */
  const submitOption = (index: number): void => {
    const label = options[index]?.label
    if (label === undefined) return
    const text = feedback.trim()
    if (exitPlanningEnabled && index === exitIndex) {
      if (text !== '') {
        setError(t('plan-review-exit-needs-empty'))
        return
      }
      onExitPlanning()
      return
    }
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
          const isExit = exitPlanningEnabled && index === exitIndex
          const label = isExit ? t('plan-review-exit-label') : option.label
          const description = isExit ? t('plan-review-exit-description') : option.description
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
                  {index + 1}. {label}
                </Text>
                {description !== undefined && (
                  <Text dimColor wrap="wrap">
                    {description}
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
        <Text dimColor>{t(exitPlanningEnabled ? 'plan-review-exit-hint' : 'plan-review-hint')}</Text>
      </Box>
    </Box>
  )
}
