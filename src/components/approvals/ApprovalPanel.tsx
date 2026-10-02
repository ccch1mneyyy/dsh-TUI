/**
 * The approval panel — the permission prompt every backend renders through
 * (docs/agent-backend-design.md §4.7). One ask per panel: a
 * permission-colored divider header naming the tool, the gated command, the
 * asker's reason, "Allow this operation?", and a numbered option list.
 *
 * The options come from the request (`approval.options`); a request without
 * them — every DSH ask — offers exactly the DSH protocol's two rows (allow
 * once / reject), whose outcome set is closed with no allow-always or
 * feedback channel. A backend prompt may add an allow-always row (its label
 * says what would be remembered), hide it (`suppressAlwaysAllow`, a forcing
 * ask rule), put the rejection first with no one-key approve
 * (`defaultToNo`), and accept a typed reason with a rejection (`feedback`).
 * Esc and Ctrl+C reject (fail closed; Esc cancels the request).
 *
 * On a prompt that takes a reason, the reason is typed into the rejection
 * row once it has focus (↓ / Tab): there digits are text, so a reason that
 * starts with "2" can never pick allow-always, and allow-always is never a
 * digit shortcut — it takes focus plus Enter. The reason shows as at most
 * two lines (its tail, where the typing happens); the full text is sent.
 * A DSH prompt (two rows, no reason) keeps its digit shortcuts unchanged.
 * Every decision carries the panel key, so a keystroke this panel handles
 * after its prompt was withdrawn cannot answer the next one.
 */

import React from 'react'
import { t } from '../../i18n.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text, useInput, useTerminalSize } from '../../ui.js'
import { isPlainReturnInput } from '../../utils/modifiers.js'
import { Divider } from '../design-system/Divider.js'
import { POINTER } from '../../terminal-utils/figures.js'
import { flattenPasteInline } from '../../channel/sanitize.js'
import {
  panelOutcomeOf,
  visiblePermissionOptions,
  type PermissionPanelDecision,
  type PermissionPanelOutcome,
  type PermissionPanelSnapshot,
} from '../../channel/permissions.js'
import type { PermissionOptionView } from '../../agent/events.js'

export type ApprovalPanelProps = {
  /** The approval to render (a permission store snapshot). */
  readonly approval: PermissionPanelSnapshot
  /** True when the asking agent is NOT the attached session — a background
   *  (agent view) session's ask, answered from the same single panel. */
  readonly background?: boolean
  /**
   * The user's choice: the outcome (`allowed-once` / `rejected` for the DSH
   * two-row prompt, plus `allowed-always`) and the picked option with any
   * typed rejection reason.
   */
  readonly onDecide: (outcome: PermissionPanelOutcome, decision: PermissionPanelDecision) => void
}

/** A feedback reason is a short sentence, not a document. */
const FEEDBACK_MAX_POINTS = 2000

/** Horizontal cells the panel spends outside an option's text: the
 *  padding (2 + 2) and the focus pointer column. */
const ROW_CHROME_CELLS = 5
/** The reason never takes more than this many rows of the option list. */
const FEEDBACK_MAX_LINES = 2

/** The longest tail of `text` that fits in `cells` display cells. */
function tailWithin(text: string, cells: number): string {
  const points = [...text]
  let width = 0
  let start = points.length
  while (start > 0) {
    const next = stringWidth(points[start - 1]!)
    if (width + next > cells) break
    width += next
    start -= 1
  }
  return points.slice(start).join('')
}

/** Hard-wrap `text` into rows of at most `cells` display cells. */
function hardWrap(text: string, cells: number): string[] {
  const rows: string[] = []
  let row = ''
  let width = 0
  for (const point of text) {
    const next = stringWidth(point)
    if (width + next > cells && row !== '') {
      rows.push(row)
      row = ''
      width = 0
    }
    row += point
    width += next
  }
  if (row !== '' || rows.length === 0) rows.push(row)
  return rows
}

/**
 * The rejection row with its reason, as at most two hard-wrapped rows: when
 * the reason does not fit, its tail (the typing position) is shown after an
 * ellipsis.
 */
export function feedbackRowLines(prefix: string, label: string, reason: string, columns: number): string[] {
  const cells = Math.max(8, columns - ROW_CHROME_CELLS)
  const head = `${prefix}${t('approval-feedback-row', { label, reason: '' })}`
  const budget = FEEDBACK_MAX_LINES * cells - stringWidth(head)
  const shown = stringWidth(reason) <= budget ? reason : `…${tailWithin(reason, Math.max(0, budget - 1))}`
  return hardWrap(`${prefix}${t('approval-feedback-row', { label, reason: shown })}`, cells).slice(0, FEEDBACK_MAX_LINES)
}

/** The localized label of an option without backend wording. */
function optionLabel(option: PermissionOptionView): string {
  if (option.label !== undefined && option.label !== '') return option.label
  return option.kind === 'allow-once' ? t('approval-yes') : option.kind === 'allow-always' ? t('approval-always') : t('approval-no')
}

export function ApprovalPanel({ approval, background = false, onDecide }: ApprovalPanelProps): React.ReactNode {
  const options = visiblePermissionOptions(approval)
  const { columns } = useTerminalSize()
  // `defaultToNo` opens on the rejection (sorted first); otherwise on the
  // first option, as the DSH panel always has. The ref is the synchronous
  // source of truth: one stdin chunk can carry a focus move and the typing
  // after it inside a single React batch.
  const [focusIndex, setFocusIndexState] = React.useState(0)
  const focusRef = React.useRef(0)
  const setFocusIndex = (next: number | ((index: number) => number)): void => {
    focusRef.current = typeof next === 'function' ? next(focusRef.current) : next
    setFocusIndexState(focusRef.current)
  }
  // Hover highlight per decision row (mouse affordance; the click handler
  // below mirrors the keyboard Enter on the focused row).
  const [hoverIndex, setHoverIndex] = React.useState(-1)
  const acceptsFeedback = approval.feedback === true
  const [feedback, setFeedback] = React.useState('')
  // One stdin chunk can carry several key events inside a single React
  // batch: the ref is the synchronous source of truth for the handlers.
  const feedbackRef = React.useRef('')
  const applyFeedback = (next: string): void => {
    feedbackRef.current = next
    setFeedback(next)
  }
  const rejectIndex = options.findIndex(option => option.kind === 'reject')

  const decide = (index: number, withFeedback: boolean): void => {
    const option = options[index]
    if (option === undefined) return
    const text = withFeedback && option.kind === 'reject' ? feedbackRef.current.trim() : ''
    onDecide(panelOutcomeOf(option.kind), {
      optionId: option.id,
      kind: option.kind,
      key: approval.key,
      ...(text === '' ? {} : { feedback: text }),
    })
  }
  /** Esc / Ctrl+C: the plain rejection (a typed reason is not sent). */
  const reject = (): void => {
    if (rejectIndex >= 0) decide(rejectIndex, false)
    else onDecide('rejected', { optionId: 'reject', kind: 'reject', key: approval.key })
  }
  /** The reason field is the focused rejection row of a prompt that takes one. */
  const reasonFocused = (): boolean => acceptsFeedback && rejectIndex >= 0 && focusRef.current === rejectIndex
  const appendFeedback = (text: string): void => {
    const points = [...feedbackRef.current, ...text]
    applyFeedback(points.slice(0, FEEDBACK_MAX_POINTS).join(''))
  }

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      reject()
      return
    }
    if (key.upArrow || (acceptsFeedback && key.tab && key.shift)) {
      setFocusIndex(index => (index + options.length - 1) % options.length)
      return
    }
    if (key.downArrow || (acceptsFeedback && key.tab)) {
      setFocusIndex(index => (index + 1) % options.length)
      return
    }
    if (isPlainReturnInput(input, key)) {
      decide(focusRef.current, true)
      return
    }
    if (reasonFocused()) {
      // The reason field: everything printable is text, digits included.
      if (key.isPasted === true) {
        const text = flattenPasteInline(input)
        if (text.trim() !== '') appendFeedback(text)
        return
      }
      if (key.backspace) {
        applyFeedback([...feedbackRef.current].slice(0, -1).join(''))
        return
      }
      if (!key.ctrl && !key.meta && input !== '' && !/[\u0000-\u001f\u007f]/u.test(input)) appendFeedback(input)
      return
    }
    // Digits pick an option. With `defaultToNo` no single key approves (only
    // a rejection may be picked); on a prompt that takes a reason the
    // persistent allow-always is never a single key either.
    if (/^[1-9]$/u.test(input)) {
      const index = Number(input) - 1
      const option = options[index]
      if (option === undefined) return
      if (approval.defaultToNo === true && option.kind !== 'reject') return
      if (acceptsFeedback && option.kind === 'allow-always') return
      decide(index, false)
    }
  }, { isActive: true })

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2} paddingRight={2} width="100%">
      <Divider color="permission" title={t('approval-waiting', { tool: approval.toolName })} />
      <Box flexDirection="column" marginTop={1}>
        {background && (
          <Text color="warning">
            {t('approval-background-agent', { id: approval.agentId.slice(0, 8) })}
          </Text>
        )}
        {approval.subagentId !== undefined && (
          <Text color="warning">{t('approval-subagent', { id: approval.subagentId.slice(0, 8) })}</Text>
        )}
        {approval.external === true && (
          <Text color="warning" wrap="wrap">[external] {t('approval-external-hint')}</Text>
        )}
        {approval.title !== undefined && (
          <Text wrap="wrap">{approval.title}</Text>
        )}
        {approval.command !== undefined && (
          <Box flexDirection="column" paddingX={2}>
            <Text dimColor wrap="wrap">
              {approval.command}
            </Text>
          </Box>
        )}
        {approval.reason !== undefined && (
          <Text dimColor wrap="wrap">
            {approval.reason}
          </Text>
        )}
        {approval.blockedPath !== undefined && (
          <Text color="warning" wrap="wrap">{t('approval-blocked-path', { path: approval.blockedPath })}</Text>
        )}
        <Text dimColor>{t('approval-proceed')}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => {
          const focused = index === focusIndex
          const hovered = index === hoverIndex
          const label = optionLabel(option)
          const reasonLines = acceptsFeedback && option.kind === 'reject' && feedback !== ''
            ? feedbackRowLines(`${index + 1}. `, label, feedback, columns)
            : undefined
          return (
            <Box
              key={option.id}
              flexDirection="row"
              marginTop={focused ? 1 : 0}
              onClick={() => decide(index, true)}
              onMouseEnter={() => setHoverIndex(index)}
              onMouseLeave={() => setHoverIndex(current => (current === index ? -1 : current))}
              backgroundColor={hovered && !focused ? 'userMessageBackgroundHover' : undefined}
            >
              <Box width={1} flexShrink={0}>
                <Text color={focused ? 'accent' : undefined} bold={focused}>
                  {focused ? POINTER : ' '}
                </Text>
              </Box>
              {reasonLines === undefined ? (
                <Text bold={focused} color={focused ? 'accent' : undefined} wrap="wrap">
                  {index + 1}. {label}
                </Text>
              ) : (
                <Box flexDirection="column">
                  {reasonLines.map((line, row) => (
                    <Text key={row} bold={focused} color={focused ? 'accent' : undefined} wrap="truncate-end">
                      {line}
                    </Text>
                  ))}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{acceptsFeedback ? t('approval-hint-feedback') : t('approval-hint')}</Text>
      </Box>
    </Box>
  )
}
