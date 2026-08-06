import React from 'react'
import { Box, Text } from '../ui.js'
import type { ChatRow } from '../channel.js'
import type { DOMElement } from '../ink/dom.js'
import { Divider } from './design-system/Divider.js'
import { UserPromptMessage } from './messages/UserPromptMessage.js'
import { AssistantTextMessage } from './messages/AssistantTextMessage.js'
import { AssistantThinkingMessage } from './messages/AssistantThinkingMessage.js'
import { AssistantToolUseMessage } from './messages/AssistantToolUseMessage.js'
import { InterruptedByUser } from './InterruptedByUser.js'
import { LogoV2 } from './LogoV2.js'
import { StreamingMarkdown } from './StreamingMarkdown.js'
import { MessageMetadata } from './messages/MessageMetadata.js'
import { stripNarration } from '../utils/narration.js'

/**
 * Transcript rows rendered in the Claude Code visual language: user prompts
 * on a grey bubble with a `❯` pointer, assistant text with a `●` bullet and
 * markdown, thinking folded to `∴ Thinking (ctrl+o to expand)`, tool calls as
 * status-dot cards. `expanded` (Ctrl+O) shows full reasoning + full tool
 * args/results; `expandedRows` (message-selection mode, Enter) expands single
 * rows; `selectedId` highlights the selected row.
 */
/** Render cap for very long sessions (CC's MAX_MESSAGES_WITHOUT_VIRTUALIZATION
 *  equivalent): older rows fold behind a Divider until Ctrl+E expands them. */
const MAX_RENDERED_ROWS = 300

export function MessageList({
  rows,
  expanded,
  expandedRows,
  selectedId,
  onToggleRow,
  model,
  showAll,
  onToggleAll,
  onLoadOlder,
  thinkingVisible = true,
  registerRowRef,
}: {
  rows: readonly ChatRow[]
  expanded: boolean
  expandedRows: ReadonlySet<number>
  selectedId: number | null
  onToggleRow(rowId: number): void
  model: string
  showAll: boolean
  onToggleAll(): void
  /** Restore folded-away older rows from the session log (CC-style "load
   *  earlier messages" affordance; shown only when rows were folded). */
  onLoadOlder?(): void
  thinkingVisible?: boolean
  /** Transcript search: register each row's DOM element for scroll-to-match. */
  registerRowRef?(rowId: number, el: DOMElement | null): void
}) {
  const hiddenCount = rows.length - MAX_RENDERED_ROWS
  const visibleRows = showAll || hiddenCount <= 0
    ? rows
    : rows.slice(hiddenCount)
  let previousKind: ChatRow['kind'] | undefined
  // CC's expanded rows keep a persistent hover-grey background (VirtualItem:
  // `expanded ? userMessageBackgroundHover : undefined`).
  const rowBackground = (rowId: number) => {
    const isSelected = selectedId === rowId
    if (isSelected) return 'messageActionsBackground'
    if (expandedRows.has(rowId)) return 'userMessageBackgroundHover'
    return undefined
  }

  return (
    <>
      {rows.some(row => row.folded) && (
        <Box marginTop={1} onClick={onLoadOlder}>
          <Divider title={' ↑ 加载更早消息（会话日志完整，/export 导出全文） '} />
        </Box>
      )}
      {!showAll && hiddenCount > 0 && (
        <Box marginTop={1} onClick={onToggleAll}>
          <Divider title={` ctrl+e to show ${hiddenCount} previous messages `} />
        </Box>
      )}
      {visibleRows
        .filter(row => thinkingVisible || row.kind !== 'reasoning')
        .map((row) => {
        // CC addMargin: every rendered block gets a 1-row top margin, so user
        // prompts, thinking, tool calls and assistant text all breathe apart.
        // (CC's MessageRow passes addMargin=true for every message in prompt
        // mode; only the first row has no preceding block.)
          const prev = previousKind
          previousKind = row.kind
          const addMargin = prev !== undefined
          const isSelected = selectedId === row.id
          const isExpanded = expanded || expandedRows.has(row.id)

          switch (row.kind) {
            case 'user':
              return (
                <Box key={row.id} flexDirection="column" ref={el => registerRowRef?.(row.id, el)}>
                  <UserPromptMessage
                    text={row.text}
                    addMargin={addMargin}
                    isSelected={isSelected}
                    isExpanded={expandedRows.has(row.id)}
                    onClick={() =>{  onToggleRow(row.id); }}
                  />
                </Box>
              )
            case 'assistant':
              return row.streaming ? (
                <Box
                  key={row.id}
                  alignItems="flex-start"
                  flexDirection="row"
                  marginTop={addMargin ? 1 : 0}
                  width="100%"
                  backgroundColor={rowBackground(row.id)}
                >
                  <Box minWidth={2}>
                    <Text color="text">●</Text>
                  </Box>
                  <Box flexDirection="column">
                    {/* The ⏵ self-narration line (working-activity narrate
                      contract) is stripped here: the live working line on
                      the status bar already shows it. */}
                    <StreamingMarkdown>{stripNarration(row.text)}</StreamingMarkdown>
                  </Box>
                </Box>
              ) : (
                <Box
                  key={row.id}
                  width="100%"
                  flexDirection="column"
                  backgroundColor={rowBackground(row.id)}
                  ref={el => registerRowRef?.(row.id, el)}
                >
                  {expanded && (
                    <Box
                      flexDirection="row"
                      justifyContent="flex-end"
                      gap={1}
                      marginTop={1}
                    >
                      <MessageMetadata timestamp={row.time} model={model} />
                    </Box>
                  )}
                  <AssistantTextMessage
                    text={stripNarration(row.text)}
                    addMargin={addMargin}
                    isSelected={isSelected}
                    isExpanded={expandedRows.has(row.id)}
                    onClick={() =>{  onToggleRow(row.id); }}
                  />
                </Box>
              )
            case 'reasoning':
              return (
                <Box key={row.id} flexDirection="column" ref={el => registerRowRef?.(row.id, el)}>
                  <AssistantThinkingMessage
                    thinking={row.text}
                    addMargin={addMargin}
                    // Streaming reasoning shows expanded live, then folds
                    // automatically once the turn settles (unless Ctrl+O or a
                    // single-row expansion keeps it open).
                    verbose={isExpanded || row.streaming === true}
                    durationMs={row.durationMs}
                    isSelected={isSelected}
                    onClick={() =>{  onToggleRow(row.id); }}
                  />
                </Box>
              )
            case 'tool':
              return row.tool ? (
                <Box key={row.id} flexDirection="column" ref={el => registerRowRef?.(row.id, el)}>
                  <AssistantToolUseMessage
                    tool={row.tool}
                    addMargin={addMargin}
                    verbose={isExpanded}
                    isSelected={isSelected}
                    isExpanded={expandedRows.has(row.id)}
                  />
                </Box>
              ) : null
            case 'notice':
              return (
                <Box key={row.id} marginTop={1} ref={el => registerRowRef?.(row.id, el)}>
                  <Divider title={` ${row.text} `} />
                </Box>
              )
            case 'interrupt':
              return (
                <Box key={row.id} marginTop={1} ref={el => registerRowRef?.(row.id, el)}>
                  <InterruptedByUser />
                </Box>
              )
            case 'local':
            // `!` mode command echo, like CC's UserBashInputMessage.
              return (
                <Box key={row.id} marginTop={1} backgroundColor={rowBackground(row.id)} ref={el => registerRowRef?.(row.id, el)}>
                  <Text color="bashBorder">! {row.text}</Text>
                </Box>
              )
            case 'local-output':
              return (
                <Box key={row.id} paddingLeft={2} backgroundColor={rowBackground(row.id)} ref={el => registerRowRef?.(row.id, el)}>
                  <Text dimColor>{row.text}</Text>
                </Box>
              )
          }
        })}
    </>
  )
}

/**
 * The header block pinned above the transcript: the DeepSeek pixel whale
 * with the wordmark, tagline, model/effort and cwd (`LogoV2`), plus the
 * welcome line. It scrolls away with the transcript once the conversation
 * fills the viewport (Claude Code shows its ✦ logo in the same slot).
 */
export function LogoHeader({
  model,
  effort,
  cwd,
}: {
  model: string
  effort?: string | undefined
  cwd: string
}): React.ReactNode {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <LogoV2 model={model} effort={effort} cwd={cwd} />
    </Box>
  )
}
