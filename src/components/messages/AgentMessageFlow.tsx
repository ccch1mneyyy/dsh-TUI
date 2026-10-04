import React from 'react'
import { Box, Text } from '../../ui.js'
import { t } from '../../i18n.js'
import type { AgentMessageView } from './agentTeam.js'
import {
  agentMessagePartyLabel,
  agentMessageStateColor,
  agentMessageStateText,
  agentMessageViaText,
} from './TranscriptLeaves.js'

function partyLabels(message: AgentMessageView, selfAgentId: string): { from?: string; to?: string } {
  return {
    from: agentMessagePartyLabel(message.from, selfAgentId, message.parentSessionId),
    to: agentMessagePartyLabel(message.to, selfAgentId, message.parentSessionId),
  }
}

/**
 * One row of the Detail Messages page: sender, target, body, transport,
 * state and sourceRef, newest last. Without both endpoints it shows the
 * unknown-relation line and no arrow.
 */
export function AgentMessageFlowRow({ message, selfAgentId }: {
  message: AgentMessageView
  selfAgentId: string
}): React.ReactNode {
  const { from, to } = partyLabels(message, selfAgentId)
  const known = from !== undefined && to !== undefined
  const stateColor = agentMessageStateColor(message.state)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color="accent">⇄</Text>
        {known
          ? <Text bold wrap="truncate-end">{t('agent-message-from-to', { from: from!, to: to! })}</Text>
          : <Text bold italic dimColor>{t('agent-message-unknown-target')}</Text>}
        <Text dimColor>·</Text>
        <Text color={stateColor}>{agentMessageStateText(message.state)}</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text wrap="wrap">{message.text}</Text>
      </Box>
      <Box paddingLeft={2} flexDirection="row" gap={1}>
        <Text dimColor>{agentMessageViaText(message.via)}</Text>
        {message.intentId !== undefined && (
          <>
            <Text dimColor>·</Text>
            <Text dimColor wrap="truncate-end">{message.intentId}</Text>
          </>
        )}
        {message.sourceRef !== undefined && (
          <>
            <Text dimColor>·</Text>
            <Text dimColor wrap="truncate-end">{message.sourceRef}</Text>
          </>
        )}
      </Box>
      {message.state === 'unknown' && (
        <Box paddingLeft={2}>
          <Text dimColor italic>{t('agent-message-no-delivery-fact')}</Text>
        </Box>
      )}
    </Box>
  )
}

/**
 * The newest message as one dim `⇄ from → to · state` line under an agent's
 * dashboard card (no unread count: that is the panel badge's job).
 */
export function AgentMessagesSummary({ messages, selfAgentId }: {
  messages: readonly AgentMessageView[]
  selfAgentId: string
}): React.ReactNode {
  const last = messages[messages.length - 1]
  if (last === undefined) return null
  const { from, to } = partyLabels(last, selfAgentId)
  const known = from !== undefined && to !== undefined
  return (
    <Box flexDirection="row" gap={1} paddingLeft={2}>
      <Text color="accent">⇄</Text>
      {known
        ? <Text dimColor wrap="truncate-end">{t('agent-message-from-to', { from: from!, to: to! })}</Text>
        : <Text dimColor italic wrap="truncate-end">{t('agent-message-unknown-target')}</Text>}
      <Text dimColor>·</Text>
      <Text color={agentMessageStateColor(last.state)}>{agentMessageStateText(last.state)}</Text>
    </Box>
  )
}
