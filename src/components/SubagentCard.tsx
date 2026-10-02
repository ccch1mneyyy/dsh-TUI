import React, { useState } from 'react'
import { Box, Text, useTerminalSize } from '../ui.js'
import type { SubagentState } from '../dsh-adapter/subagents.js'
import { t } from '../i18n.js'
import { isMinimalUiMode } from '../minimalUiMode.js'
import type { ClickEvent } from '../ink/events/click-event.js'

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

export interface SubagentCardProps { subagent: SubagentState; focused?: boolean; onClick?(event: ClickEvent): void }

export function SubagentCard({ subagent, focused, onClick }: SubagentCardProps): React.ReactNode {
  const running = subagent.status === 'running' || subagent.status === 'starting'
  // Only a live run ticks; discovered history (`unknown`) has no end time to
  // count from, so it must not accumulate a fake growing duration.
  const elapsed = running
    ? Date.now() - subagent.startedAt
    : subagent.completedAt !== undefined ? subagent.completedAt - subagent.startedAt : undefined
  const total = subagent.tokens?.total ?? ((subagent.tokens?.input ?? 0) + (subagent.tokens?.output ?? 0) || 0)
  // Mouse affordance: clickable cards tint on hover; the keyboard-focused
  // card keeps its brand-color header (no double highlight).
  const [hovered, setHovered] = useState(false)
  // Live preview: the newest streamed line rides under the header while the
  // subagent runs, then folds away — the dashboard stays one line per settled
  // subagent. Deliberately NOT revived on hover: an extra line would grow
  // the card mid-gesture and reshuffle the whole dashboard list (user
  // feedback: hover must never change layout). The hover tint stays.
  const liveLine = running ? subagent.output[subagent.output.length - 1] : undefined
  const minimalUi = isMinimalUiMode()
  const glyph = running ? (minimalUi ? '·' : '🟡')
    : subagent.status === 'unknown' ? (minimalUi ? '·' : '⚪')
    : subagent.status === 'failed' || subagent.status === 'cancelled' ? (minimalUi ? '×' : '🔴')
    : (minimalUi ? '✓' : '🟢')
  const glyphColor = minimalUi ? undefined
    : running ? 'warning' as const
    : subagent.status === 'unknown' ? 'subtle' as const
    : subagent.status === 'failed' || subagent.status === 'cancelled' ? 'error' as const
    : 'success' as const
  const hoverTint = onClick !== undefined && hovered && !focused
  // 窄宽排版（侧栏 Panel 常态 28~44 列）：meta 按优先级分段降级——
  // 时长永远在，tools / tokens / model 随宽度依次退出；描述拿剩余预算
  // truncate-end，绝不在行中间任意折行（38 列面板上描述被拦腰截断、
  // 统计列挤进第二行的旧渲染就是这么来的）。
  const { columns } = useTerminalSize()
  const metaParts: string[] = []
  if (columns >= 56) metaParts.push(subagent.model ?? subagent.provider ?? 'default')
  if (elapsed !== undefined) metaParts.push(formatDuration(elapsed))
  if (columns >= 44) metaParts.push(`${total || '—'} tok`)
  if (columns >= 34) metaParts.push(`${subagent.toolCalls.length} tools`)
  const meta = metaParts.join(' · ')
  return <Box
    flexDirection="column"
    paddingLeft={1}
    marginBottom={1}
    onClick={onClick}
    onMouseEnter={onClick !== undefined ? () => setHovered(true) : undefined}
    onMouseLeave={onClick !== undefined ? () => setHovered(false) : undefined}
    backgroundColor={hoverTint ? 'userMessageBackgroundHover' : undefined}
  >
    <Box flexDirection="row">
      <Box flexShrink={0} marginRight={1}>
        <Text color={glyphColor}>{glyph}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text bold color={focused ? 'accent' : undefined} wrap="truncate-end">{`${t('subagent-card-prefix')}${subagent.description}`}</Text>
      </Box>
      {subagent.mode === 'continuable' && (
        <Box flexShrink={0} marginLeft={1}>
          <Text color={focused ? 'accent' : 'warning'}>{t('subagent-mode-continuable')}</Text>
        </Box>
      )}
      {subagent.mode === 'one-shot' && (
        <Box flexShrink={0} marginLeft={1}>
          <Text dimColor>{t('subagent-mode-one-shot')}</Text>
        </Box>
      )}
      {meta !== '' && (
        <Box flexShrink={0} marginLeft={1}>
          <Text dimColor wrap="truncate-end">{meta}</Text>
        </Box>
      )}
    </Box>
    {liveLine && <Text dimColor wrap="truncate">{`  │ ${liveLine}`}</Text>}
  </Box>
}
