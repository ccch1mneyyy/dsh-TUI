/**
 * The approval panel — Claude Code style permission prompt for the DSH
 * approval seam (`ctx.approval`). One ask per panel: a permission-colored
 * divider header naming the tool, the gated command recovered from the
 * paired tool call (CC verbose full-command semantics), the asker's reason,
 * "Do you want to proceed?", and a numbered Yes/No list.
 *
 * The protocol's outcome set is closed (allowed-once / rejected /
 * cancelled / unavailable) with no allow-always or feedback channel, so
 * the panel deliberately offers exactly two rows; Esc and Ctrl+C reject
 * (fail closed, CC's "Esc to cancel" semantics).
 */

import React from 'react'
import { t } from '../../i18n.js'
import { Box, Text, useInput } from '../../ui.js'
import { isPlainReturnInput } from '../../utils/modifiers.js'
import { Divider } from '../design-system/Divider.js'
import { POINTER } from '../../cc/figures.js'
import type { ApprovalSnapshot } from '../../dsh-adapter/approvals.js'

export type ApprovalPanelProps = {
  /** The approval to render (from the ApprovalStore snapshot). */
  readonly approval: ApprovalSnapshot
  /** True when the asking agent is NOT the attached session — a background
   *  (agent view) session's ask, answered from the same single panel. */
  readonly background?: boolean
  readonly onDecide: (outcome: 'allowed-once' | 'rejected') => void
}

const OUTCOMES = ['allowed-once', 'rejected'] as const

export function ApprovalPanel({ approval, background = false, onDecide }: ApprovalPanelProps): React.ReactNode {
  const [focusIndex, setFocusIndex] = React.useState(0)
  // Hover highlight per decision row (mouse affordance; the click handler
  // below mirrors the keyboard Enter on the focused row).
  const [hoverIndex, setHoverIndex] = React.useState(-1)

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onDecide('rejected')
      return
    }
    if (key.upArrow) {
      setFocusIndex(index => (index + OUTCOMES.length - 1) % OUTCOMES.length)
      return
    }
    if (key.downArrow) {
      setFocusIndex(index => (index + 1) % OUTCOMES.length)
      return
    }
    if (input === '1' || input === '2') {
      onDecide(OUTCOMES[Number(input) - 1]!)
      return
    }
    if (isPlainReturnInput(input, key)) {
      onDecide(OUTCOMES[focusIndex]!)
    }
  }, { isActive: true })

  const optionLabels = [t('approval-yes'), t('approval-no')]

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2} paddingRight={2} width="100%">
      <Divider color="permission" title={t('approval-waiting', { tool: approval.toolName })} />
      <Box flexDirection="column" marginTop={1}>
        {background && (
          <Text color="warning">
            {t('approval-background-agent', { id: approval.agentId.slice(0, 8) })}
          </Text>
        )}
        {approval.external === true && (
          <Text color="warning" wrap="wrap">[external] {t('approval-external-hint')}</Text>
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
        <Text dimColor>{t('approval-proceed')}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {optionLabels.map((label, index) => {
          const focused = index === focusIndex
          const hovered = index === hoverIndex
          return (
            <Box
              key={label}
              flexDirection="row"
              marginTop={focused ? 1 : 0}
              onClick={() => onDecide(OUTCOMES[index]!)}
              onMouseEnter={() => setHoverIndex(index)}
              onMouseLeave={() => setHoverIndex(current => (current === index ? -1 : current))}
              backgroundColor={hovered && !focused ? 'userMessageBackgroundHover' : undefined}
            >
              <Box width={1} flexShrink={0}>
                <Text color={focused ? 'claude' : undefined} bold={focused}>
                  {focused ? POINTER : ' '}
                </Text>
              </Box>
              <Text bold={focused} color={focused ? 'claude' : undefined} wrap="wrap">
                {index + 1}. {label}
              </Text>
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{t('approval-hint')}</Text>
      </Box>
    </Box>
  )
}
