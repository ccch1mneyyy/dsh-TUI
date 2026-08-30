import React from 'react'
import { Box, Text, useAnimationFrame, useTerminalSize } from '../../ui.js'
import type { SubagentRow } from '../../dsh-adapter/channel.js'
import type { Theme } from '../../theme.js'
import { t } from '../../i18n.js'
import { resolvePreset } from '../activityFrames.js'
import { toolNameColor } from '../messages/AssistantToolUseMessage.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { isMinimalMode } from '../../minimalMode.js'
import type { ClickEvent } from '../../ink/events/click-event.js'

/** The waterfall window is a Kimi Code style constant-height region. */
const WATERFALL_ROWS = 3
/** Card left padding + the `│ ` gutter prefix. */
const WATERFALL_GUTTER = 4

function duration(ms = 0): string {
  const seconds = Math.floor(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

function tokens(row: SubagentRow): string {
  const total = row.tokens?.total ?? ((row.tokens?.input ?? 0) + (row.tokens?.output ?? 0) || 0)
  if (total <= 0) return '- tok'
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k tok` : `${total} tok`
}

function status(row: SubagentRow): { glyph: string; label: string; color: keyof Theme | undefined } {
  const minimal = isMinimalMode()
  if (row.status === 'completed') return { glyph: '✓', label: t('subagent-status-completed'), color: minimal ? undefined : 'success' }
  if (row.status === 'failed') return { glyph: '✕', label: t('subagent-status-failed'), color: minimal ? undefined : 'error' }
  if (row.status === 'cancelled') return { glyph: '✕', label: t('subagent-status-cancelled'), color: minimal ? undefined : 'error' }
  return { glyph: minimal ? '·' : '⟡', label: t('subagent-status-running'), color: minimal ? undefined : 'warning' }
}

function formatToolArgs(rawArgs?: string): string | undefined {
  if (!rawArgs) return undefined
  try {
    const parsed = JSON.parse(rawArgs)
    if (typeof parsed === 'object' && parsed !== null) {
      if (typeof parsed.description === 'string' && parsed.description.trim()) {
        return parsed.description.trim()
      }
      if (typeof parsed.command === 'string' && parsed.command.trim()) {
        return parsed.command.trim()
      }
      if (typeof parsed.file_path === 'string') return parsed.file_path
      if (typeof parsed.filePath === 'string') return parsed.filePath
      if (typeof parsed.path === 'string') return parsed.path
      if (typeof parsed.pattern === 'string') return parsed.pattern
      if (typeof parsed.query === 'string') return parsed.query
      if (typeof parsed.name === 'string') return parsed.name
    }
  } catch {
    // Non-JSON string
  }
  return rawArgs.replace(/\s+/g, ' ').trim()
}

/** Hard single-line clip by display width — a wrapped waterfall row would
 * break the constant-height window. */
function clipLine(text: string, maxWidth: number): string {
  if (maxWidth <= 1) return ''
  let width = 0
  let index = 0
  while (index < text.length) {
    const next = text.codePointAt(index)!
    const char = String.fromCodePoint(next)
    const charWidth = stringWidth(char)
    if (width + charWidth > maxWidth - 1) break
    width += charWidth
    index += char.length
  }
  return index < text.length ? `${text.slice(0, index)}…` : text
}

/**
 * Modern, clean activity card for subagent delegation.
 */
export function SubagentMessage({ subagent, addMargin, activityFrames, onClick }: {
  subagent: SubagentRow
  addMargin: boolean
  activityFrames?: string
  isExpanded: boolean
  onClick?(event: ClickEvent): void
}): React.ReactNode {
  const settled = subagent.status === 'completed' || subagent.status === 'failed' || subagent.status === 'cancelled'
  const [viewportRef, time] = useAnimationFrame(settled ? null : 120)
  const { columns } = useTerminalSize()
  const info = status(subagent)
  const [hovered, setHovered] = React.useState(false)
  const clickable = onClick !== undefined
  const elapsed = subagent.completedAt ? subagent.durationMs : Date.now() - subagent.startedAt
  const lastRunning = [...subagent.toolCalls].reverse().find(tool => tool.status === 'running')
  const previousDone = lastRunning
    ? subagent.toolCalls[subagent.toolCalls.indexOf(lastRunning) - 1]
    : subagent.toolCalls[subagent.toolCalls.length - 1]
  const preset = React.useMemo(() => resolvePreset(activityFrames), [activityFrames])
  const activity = settled ? [] : subagent.outputLines.slice(-WATERFALL_ROWS)
  const runningGlyph = preset.frames[Math.floor(time / preset.intervalMs) % preset.frames.length] ?? '⟡'
  const termWidth = columns ?? 80
  const rowWidth = Math.max(20, termWidth - WATERFALL_GUTTER - 2)

  const metaRight = [
    subagent.model ?? subagent.provider ?? 'default',
    subagent.effort ? subagent.effort : null,
    duration(elapsed),
    tokens(subagent),
    `${subagent.toolCalls.length} tools`,
    info.label,
  ].filter(Boolean).join(' · ')

  const prefixText = `⑂ ${t('subagent-card-prefix')}`
  const availableDescWidth = Math.max(15, rowWidth - stringWidth(prefixText) - stringWidth(metaRight) - 8)
  const clippedDesc = clipLine(subagent.description, availableDescWidth)

  const activeTool = lastRunning ?? previousDone
  const activeToolFormatted = activeTool ? formatToolArgs(activeTool.argsPreview) : undefined

  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      marginBottom={settled ? 0 : 1}
      paddingLeft={1}
      paddingRight={1}
      ref={viewportRef}
      onClick={onClick}
      onMouseEnter={clickable ? () => setHovered(true) : undefined}
      onMouseLeave={clickable ? () => setHovered(false) : undefined}
    >
      <Box flexDirection="row" width="100%" gap={1}>
        <Text color={hovered && clickable ? 'claude' : info.color}>
          {settled ? info.glyph : runningGlyph}
        </Text>
        <Text bold color={hovered && clickable ? 'claude' : 'claude'}>
          {prefixText}
        </Text>
        <Text bold color={hovered && clickable ? 'claude' : 'text'} wrap="truncate">
          {clippedDesc}
        </Text>
        <Text dimColor wrap="truncate">
          {` · ${metaRight}`}
        </Text>
      </Box>

      {!settled && activeTool !== undefined && (
        <Box flexDirection="row" paddingLeft={2} gap={1}>
          <Text dimColor>│</Text>
          {lastRunning !== undefined ? (
            <Text color="warning">▶</Text>
          ) : (
            <Text color="success">✓</Text>
          )}
          <Text color={toolNameColor(activeTool.name)} bold>
            {activeTool.name}
          </Text>
          {activeToolFormatted && (
            <Text dimColor wrap="truncate">
              {clipLine(activeToolFormatted, Math.max(10, rowWidth - activeTool.name.length - 8))}
            </Text>
          )}
        </Box>
      )}

      {!settled && Array.from({ length: WATERFALL_ROWS }, (_, index) => {
        const line = activity[index]
        if (!line) return null
        return (
          <Box key={`${subagent.agentId}-wf-${index}`} flexDirection="row" paddingLeft={2} gap={1}>
            <Text dimColor>│</Text>
            <Text dimColor wrap="truncate">
              {clipLine(line, rowWidth - 4)}
            </Text>
          </Box>
        )
      })}

      {settled && subagent.status === 'failed' && subagent.error && (
        <Box flexDirection="row" paddingLeft={2} gap={1}>
          <Text color="error">└</Text>
          <Text color="error" wrap="truncate">
            {clipLine(subagent.error, rowWidth - 4)}
          </Text>
        </Box>
      )}
    </Box>
  )
}
