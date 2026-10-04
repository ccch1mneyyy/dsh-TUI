import React from 'react'
import { Box, Text } from '../../ui.js'
import { t } from '../../i18n.js'
import type { Theme } from '../../theme.js'
import type { ClickEvent } from '../../ink/events/click-event.js'
import type { ToolRow } from '../../dsh-adapter/channel.js'
import type { ToolBackground } from '../../tuiDisplayPrefs.js'
import type { TranscriptImage } from '../../dsh-adapter/transcript-images.js'
import { AssistantTextMessage } from './AssistantTextMessage.js'
import { AssistantThinkingMessage } from './AssistantThinkingMessage.js'
import { AssistantToolUseMessage } from './AssistantToolUseMessage.js'
import { TranscriptImages } from './TranscriptImages.js'
import type { AgentMessageState, AgentMessageVia, AgentMessageView } from './agentTeam.js'

// ── agent↔agent message flow leaves (design agent-team-full §5.4) ─────────

/** Delivery-state badge color: only what the channel reported — green is
 *  reserved for an explicit `delivered` fact, dim for `unknown`/`expired`. */
export function agentMessageStateColor(state: AgentMessageState): keyof Theme {
  if (state === 'delivered') return 'success'
  if (state === 'refused') return 'error'
  if (state === 'issued' || state === 'queued' || state === 'held') return 'warning'
  return 'subtle'
}

/** The localized state word (issued/queued/delivered/held/refused/expired/
 *  unknown) — one vocabulary across composer status lines and flow rows. */
export function agentMessageStateText(state: AgentMessageState): string {
  return t(`agent-message-delivery-${state}`)
}

/** One endpoint's short label: `user`/`parent`/`child` for the relations the
 *  view itself proves (own id, parentSessionId), the stable short id for any
 *  other agent. Absent ids stay unnamed — the caller decides whether that is
 *  an unknown-relation row (no arrow). */
export function agentMessagePartyLabel(id: string | undefined, selfAgentId: string, parentSessionId?: string): string | undefined {
  if (id === undefined) return undefined
  if (id === 'user') return t('agent-message-source-user')
  if (id === selfAgentId) return t('agent-message-source-child')
  if (parentSessionId !== undefined && id === parentSessionId) return t('agent-message-source-parent')
  return id.length > 8 ? id.slice(0, 8) : id
}

/** The transport word under the §5 via vocabulary. */
export function agentMessageViaText(via: AgentMessageVia): string {
  return t(`agent-message-via-${via}`)
}

/**
 * One agent↔agent message as a transcript leaf (design §5.4): `⇄ from → to ·
 * state` header plus an indented preview, sharing the page window with
 * thinking/text/tool leaves — never a copy of an ordinary message row. A
 * view without both endpoints renders the unknown-relation diagnostic and
 * NO arrow (from→to is a fact, not a guess).
 */
export function AgentMessageLeafRow({ message, selfAgentId, marginTopOnTurn }: {
  message: AgentMessageView
  /** This child's agent id — resolves `child` in the party labels. */
  selfAgentId: string
  marginTopOnTurn: boolean
}): React.ReactNode {
  const from = agentMessagePartyLabel(message.from, selfAgentId, message.parentSessionId)
  const to = agentMessagePartyLabel(message.to, selfAgentId, message.parentSessionId)
  const known = from !== undefined && to !== undefined
  const stateColor = agentMessageStateColor(message.state)
  return (
    <Box flexDirection="column" marginTop={marginTopOnTurn ? 1 : 0} paddingLeft={2}>
      <Box flexDirection="row" gap={1}>
        <Text color="accent">⇄</Text>
        {known ? (
          <Text dimColor wrap="truncate-end">{t('agent-message-from-to', { from, to })}</Text>
        ) : (
          <Text dimColor italic wrap="truncate-end">{t('agent-message-unknown-target')}</Text>
        )}
        <Text dimColor>·</Text>
        <Box flexShrink={0}><Text color={stateColor}>{agentMessageStateText(message.state)}</Text></Box>
        <Text dimColor>·</Text>
        <Text dimColor wrap="truncate-end">{agentMessageViaText(message.via)}</Text>
      </Box>
      <Box paddingLeft={2}>
        <Text dimColor wrap="wrap">{message.text}</Text>
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
 * Neutral transcript leaf rows (agent-team panels design §2): the main
 * MessageList and the subagent Agent-Transcript page render thinking / tool /
 * text rows through the SAME thin adapters over the leaf components, so a
 * child transcript reads exactly like the main one. The leaves stay
 * presentation-only — fold state, reveal cursors and row anchoring stay with
 * their owners, which pass them in as props.
 */

/** A settled/live thinking row (`⚓ Thinking` preview or expanded body). */
export function ThinkingLeafRow({
  thinking,
  textFull,
  marginTopOnTurn,
  streaming = false,
  preview = false,
  verbose,
  durationMs,
  reasoningTokens,
  isSelected = false,
  onClick,
}: {
  thinking: string
  /** The full un-revealed text the live preview ticker follows. */
  textFull?: string
  marginTopOnTurn: boolean
  streaming?: boolean
  preview?: boolean
  verbose: boolean
  durationMs?: number
  /** Thinking reported only as a count (no body) — the one-line header. */
  reasoningTokens?: number
  isSelected?: boolean
  onClick?(event: ClickEvent): void
}): React.ReactNode {
  return (
    <AssistantThinkingMessage
      thinking={thinking}
      textFull={textFull}
      marginTopOnTurn={marginTopOnTurn}
      streaming={streaming}
      preview={preview}
      verbose={verbose}
      durationMs={durationMs}
      reasoningTokens={reasoningTokens}
      isSelected={isSelected}
      onClick={onClick}
    />
  )
}

/** A tool-call card (args / result / error / diff), optionally with images. */
export function ToolLeafRow({
  tool,
  marginTopOnTurn,
  verbose,
  isSelected = false,
  isExpanded = false,
  footnote,
  diffLayout,
  toolBackground,
  smoothReveal,
  fresh,
  revealVersion,
  foldTerminalCommand,
  onClick,
  onOpenFile,
  images,
  onPreviewImage,
  suppressImageGraphics,
  sourceFolded,
}: {
  tool: ToolRow
  marginTopOnTurn: boolean
  verbose: boolean
  isSelected?: boolean
  isExpanded?: boolean
  footnote?: string
  diffLayout?: 'auto' | 'split' | 'unified'
  toolBackground?: ToolBackground
  smoothReveal?: boolean
  fresh?: boolean
  revealVersion?: number
  foldTerminalCommand?: boolean
  onClick?(event: ClickEvent): void
  onOpenFile?: (path: string) => void
  images?: readonly TranscriptImage[]
  onPreviewImage?(image: TranscriptImage): void
  suppressImageGraphics?: boolean
  /** The transcript window folded this row's source (previews only). */
  sourceFolded?: boolean
}): React.ReactNode {
  return (
    <>
      <AssistantToolUseMessage
        tool={tool}
        marginTopOnTurn={marginTopOnTurn}
        verbose={verbose}
        isSelected={isSelected}
        isExpanded={isExpanded}
        footnote={footnote}
        diffLayout={diffLayout}
        toolBackground={toolBackground}
        smoothReveal={smoothReveal}
        fresh={fresh}
        revealVersion={revealVersion}
        foldTerminalCommand={foldTerminalCommand}
        onClick={onClick}
        onOpenFile={onOpenFile}
        sourceFolded={sourceFolded}
      />
      {images !== undefined && <TranscriptImages images={images} indent={4} onPreview={onPreviewImage} suppressGraphics={suppressImageGraphics} />}
    </>
  )
}

/** An assistant text row (`●` bullet + markdown body). */
export function AssistantTextLeafRow({
  text,
  marginTopOnTurn,
  isSelected = false,
  isExpanded = false,
}: {
  text: string
  marginTopOnTurn: boolean
  isSelected?: boolean
  isExpanded?: boolean
}): React.ReactNode {
  return (
    <AssistantTextMessage
      text={text}
      marginTopOnTurn={marginTopOnTurn}
      isSelected={isSelected}
      isExpanded={isExpanded}
    />
  )
}
