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
 */

import React from 'react'
import { t } from '../../i18n.js'
import { Box, Text, useInput } from '../../ui.js'
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

/** The localized label of an option without backend wording. */
function optionLabel(option: PermissionOptionView): string {
  if (option.label !== undefined && option.label !== '') return option.label
  return option.kind === 'allow-once' ? t('approval-yes') : option.kind === 'allow-always' ? t('approval-always') : t('approval-no')
}

export function ApprovalPanel({ approval, background = false, onDecide }: ApprovalPanelProps): React.ReactNode {
  const options = visiblePermissionOptions(approval)
  // `defaultToNo` opens on the rejection (sorted first); otherwise on the
  // first option, as the DSH panel always has.
  const [focusIndex, setFocusIndex] = React.useState(0)
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
      ...(text === '' ? {} : { feedback: text }),
    })
  }
  /** Esc / Ctrl+C: the plain rejection (a typed reason is not sent). */
  const reject = (): void => {
    if (rejectIndex >= 0) decide(rejectIndex, false)
    else onDecide('rejected', { optionId: 'reject', kind: 'reject' })
  }
  /** Typing goes to the rejection reason and focuses the rejection row. */
  const appendFeedback = (text: string): void => {
    const points = [...feedbackRef.current, ...text]
    applyFeedback(points.slice(0, FEEDBACK_MAX_POINTS).join(''))
    if (rejectIndex >= 0) setFocusIndex(rejectIndex)
  }

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      reject()
      return
    }
    if (key.upArrow) {
      setFocusIndex(index => (index + options.length - 1) % options.length)
      return
    }
    if (key.downArrow) {
      setFocusIndex(index => (index + 1) % options.length)
      return
    }
    if (isPlainReturnInput(input, key)) {
      decide(focusIndex, true)
      return
    }
    if (acceptsFeedback && key.isPasted === true) {
      const text = flattenPasteInline(input)
      if (text.trim() !== '') appendFeedback(text)
      return
    }
    if (acceptsFeedback && key.backspace) {
      applyFeedback([...feedbackRef.current].slice(0, -1).join(''))
      return
    }
    // Digits pick an option while no reason is being typed. With
    // `defaultToNo` no single key approves: only a rejection may be picked.
    if (/^[1-9]$/u.test(input) && feedbackRef.current === '') {
      const index = Number(input) - 1
      const option = options[index]
      if (option !== undefined && (approval.defaultToNo !== true || option.kind === 'reject')) decide(index, false)
      return
    }
    if (acceptsFeedback && !key.ctrl && !key.meta && input !== '' && !/[\u0000-\u001f\u007f]/u.test(input)) {
      appendFeedback(input)
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
          const text = acceptsFeedback && option.kind === 'reject' && feedback !== ''
            ? t('approval-feedback-row', { label, reason: feedback })
            : label
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
              <Text bold={focused} color={focused ? 'accent' : undefined} wrap="wrap">
                {index + 1}. {text}
              </Text>
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
