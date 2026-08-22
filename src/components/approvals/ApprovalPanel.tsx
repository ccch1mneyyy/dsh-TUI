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
import { cleanRenderText } from '../../dsh-adapter/sanitize.js'

export type ApprovalPanelProps = {
  /** The approval to render (from the ApprovalStore snapshot). */
  readonly approval: ApprovalSnapshot
  readonly onDecide: (outcome: 'allowed-once' | 'rejected') => void
}

const OUTCOMES = ['allowed-once', 'rejected'] as const

export function ApprovalPanel({ approval, onDecide }: ApprovalPanelProps): React.ReactNode {
  const [focusIndex, setFocusIndex] = React.useState(0)

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

  // Sanitize untrusted fields to prevent ANSI injection.
  const TOOL_NAME_LIMIT = 40
  const COMMAND_LINE_LIMIT = 200
  const REASON_LINE_LIMIT = 500

  const safeToolName = cleanRenderText(approval.toolName, TOOL_NAME_LIMIT)
  const safeCommand = approval.command !== undefined
    ? approval.command.split('\n').map(line => cleanRenderText(line, COMMAND_LINE_LIMIT)).join('\n')
    : undefined
  const safeReason = approval.reason !== undefined
    ? approval.reason.split('\n').map(line => cleanRenderText(line, REASON_LINE_LIMIT)).join('\n')
    : undefined

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2} paddingRight={2} width="100%">
      <Divider color="permission" title={t('approval-waiting', { tool: safeToolName })} padding={4} />
      <Box flexDirection="column" marginTop={1}>
        {safeCommand !== undefined && (
          <Box flexDirection="column" paddingX={2}>
            {safeCommand.split('\n').map((line, index) => {
              const isOld = /^\s*-( |$)/.test(line)
              const isNew = /^\s*\+( |$)/.test(line)
              return (
                <Text
                  key={`cmd-${index}`}
                  dimColor={!isOld && !isNew}
                  color={isOld ? 'diffRemovedWord' : isNew ? 'diffAddedWord' : undefined}
                  wrap="wrap"
                >
                  {line || ' '}
                </Text>
              )
            })}
          </Box>
        )}
        {safeReason !== undefined && (
          <Text dimColor wrap="wrap">
            {safeReason}
          </Text>
        )}
        <Text dimColor>{t('approval-proceed')}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {optionLabels.map((label, index) => {
          const focused = index === focusIndex
          return (
            <Box key={label} flexDirection="row" marginTop={focused ? 1 : 0}>
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
