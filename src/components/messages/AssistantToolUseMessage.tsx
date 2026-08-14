import React from 'react'
import { Box, Text } from '../../ui.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { useAnimationFrame } from '../../ink/hooks/use-animation-frame.js'
import type { ToolRow } from '../../channel.js'
import { ToolUseLoader } from '../ToolUseLoader.js'
import { useTerminalSize } from '../../ink/hooks/use-terminal-size.js'
import { renderTruncatedContent } from '../../cc/terminal.js'
import { formatDuration } from '../../cc/format.js'

type Props = {
  tool: ToolRow
  /** Adds the top margin between messages (CC: addMargin). */
  addMargin: boolean
  /** Ctrl+O verbose: show full args/result instead of previews. */
  verbose: boolean
  /** Message-selection mode highlight. */
  isSelected?: boolean
  /** Row expanded on its own (persistent hover-grey background, CC). */
  isExpanded?: boolean
}

/** Tool display names: DSH emits lowercase tool ids (`bash`); Claude Code
 *  shows capitalized names (`Bash`). Map the common ones, fall back to the
 *  id with its first letter uppercased. */
function displayName(name: string): string {
  const KNOWN: Record<string, string> = {
    bash: 'Bash',
    powershell: 'PowerShell',
    read: 'Read',
    glob: 'Glob',
    grep: 'Grep',
    write: 'Write',
    edit: 'Edit',
    todo_write: 'TodoWrite',
    subagent: 'Task',
    web_search: 'WebSearch',
  }
  const mapped = KNOWN[name]
  if (mapped) return mapped
  if (name.length === 0) return name
  return name[0]!.toUpperCase() + name.slice(1)
}

/**
 * Tool-call card: `● Bash("args")` header with a blinking status dot, then a
 * `Running…`/result/error line (ported from the leak's
 * `AssistantToolUseMessage.tsx` + the BashTool UI, collapsed into one card
 * because cc-tui's channel settles tool/result into a single row).
 */
export function AssistantToolUseMessage({
  tool,
  addMargin,
  verbose,
  isSelected = false,
  isExpanded = false,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const isRunning = tool.status === 'running'
  const isError = tool.status === 'error'
  const displayArgs = verbose ? tool.argsFull ?? tool.argsText : tool.argsText
  const result = tool.resultFull ?? tool.resultText
  const name = displayName(tool.name)
  const minWidth = stringWidth(name) + 2

  // Live elapsed clock while the call runs (CC's bash elapsed timer): the
  // 1s tick re-renders the card; elapsed derives from wall-clock refs.
  const [viewportRef] = useAnimationFrame(isRunning ? 1000 : null)
  const elapsedMs = isRunning
    ? tool.startedAt !== undefined
      ? Date.now() - tool.startedAt
      : undefined
    : tool.durationMs
  const elapsedText = elapsedMs !== undefined ? ` · ${formatDuration(elapsedMs)}` : ''

  return (
    <Box
      ref={viewportRef}
      flexDirection="row"
      justifyContent="space-between"
      marginTop={addMargin ? 1 : 0}
      width="100%"
      backgroundColor={
        isSelected
          ? 'messageActionsBackground'
          : isExpanded
            ? 'userMessageBackgroundHover'
            : undefined
      }
    >
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="nowrap" minWidth={minWidth}>
          <ToolUseLoader
            shouldAnimate={isRunning}
            isUnresolved={isRunning}
            isError={isError}
          />
          <Box flexShrink={0}>
            <Text bold wrap="truncate-end">
              {name}
            </Text>
          </Box>
          {displayArgs && (
            <Box flexWrap="nowrap">
              <Text>({displayArgs})</Text>
            </Box>
          )}
          {!isRunning && (
            <Box flexWrap="nowrap">
              <Text dimColor>{elapsedText}</Text>
            </Box>
          )}
        </Box>
        {isRunning && (
          <Box>
            <Text dimColor>
              Running… ({formatDuration(Math.max(0, Date.now() - (tool.startedAt ?? Date.now())))})
            </Text>
          </Box>
        )}
        {!isRunning && tool.status === 'ok' && result && (
          <Box>
            <Text dimColor>
              {verbose
                ? result
                : renderTruncatedContent(result, columns)}
            </Text>
          </Box>
        )}
        {isError && tool.errorText && (
          <Box>
            <Text color="error">{tool.errorText}</Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}
