import React, { useState } from 'react'
import { Box, Text } from '../ui.js'
import type { SubagentState } from '../dsh-adapter/subagents.js'
import { t } from '../i18n.js'
import { isMinimalMode } from '../minimalMode.js'
import type { ClickEvent } from '../ink/events/click-event.js'

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

export interface SubagentCardProps { subagent: SubagentState; focused?: boolean; onClick?(event: ClickEvent): void }

export function SubagentCard({ subagent, focused, onClick }: SubagentCardProps): React.ReactNode {
  const running = subagent.status === 'running' || subagent.status === 'starting'
  const elapsed = subagent.completedAt ? subagent.completedAt - subagent.startedAt : Date.now() - subagent.startedAt
  const total = subagent.tokens?.total ?? ((subagent.tokens?.input ?? 0) + (subagent.tokens?.output ?? 0) || 0)
  // Live preview: the newest streamed line rides under the header while the
  // subagent runs, then folds away — the dashboard stays one line per settled
  // subagent.
  const liveLine = running ? subagent.output[subagent.output.length - 1] : undefined
  const minimal = isMinimalMode()
  const glyph = running ? (minimal ? '·' : '🟡')
    : subagent.status === 'failed' || subagent.status === 'cancelled' ? (minimal ? '×' : '🔴')
    : (minimal ? '✓' : '🟢')
  const glyphColor = minimal ? undefined
    : running ? 'warning' as const
    : subagent.status === 'failed' || subagent.status === 'cancelled' ? 'error' as const
    : 'success' as const
  // Mouse affordance: clickable cards tint on hover; the keyboard-focused
  // card keeps its brand-color header (no double highlight).
  const [hovered, setHovered] = useState(false)
  const hoverTint = onClick !== undefined && hovered && !focused
  return <Box
    flexDirection="column"
    paddingLeft={1}
    marginBottom={1}
    onClick={onClick}
    onMouseEnter={onClick !== undefined ? () => setHovered(true) : undefined}
    onMouseLeave={onClick !== undefined ? () => setHovered(false) : undefined}
    backgroundColor={hoverTint ? 'userMessageBackgroundHover' : undefined}
  >
    <Box flexDirection="row" gap={1}>
      <Text color={glyphColor}>{glyph}</Text>
      <Text bold color={focused ? 'claude' : undefined}>{`${t('subagent-card-prefix')}${subagent.description}`}</Text>
      <Text>
        <Text dimColor>{' · '}</Text>
        <Text>{subagent.model ?? subagent.provider ?? 'default'}</Text>
        <Text dimColor>{` · ${formatDuration(elapsed)} · ${total || '—'} tok · ${subagent.toolCalls.length} tools`}</Text>
      </Text>
    </Box>
    {liveLine && <Text dimColor wrap="truncate">{`  │ ${liveLine}`}</Text>}
  </Box>
}
