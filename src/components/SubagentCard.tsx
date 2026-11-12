import React, { useState } from 'react'
import { Box, Text, useTerminalSize, useAnimationFrame } from '../ui.js'
import type { SubagentState } from '../dsh-adapter/subagents.js'
import { t } from '../i18n.js'
import { jobOutputRows } from './Chat/JobCard.js'
import { isMinimalUiMode } from '../minimalUiMode.js'
import type { ClickEvent } from '../ink/events/click-event.js'
import type { TeamMemberStatus } from './teamRoster.js'

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

export interface SubagentCardProps {
  subagent: SubagentState
  focused?: boolean
  onClick?(event: ClickEvent): void
  variant?: 'default' | 'panel'
  /** Agent Teams: the row is this teammate — its name replaces the
   *  description and its member state replaces the run status. */
  teamMember?: { readonly name: string; readonly status: TeamMemberStatus }
}

/** Status glyph and color of a team member (`·`-style in minimal UI). */
export function teamStatusGlyph(status: TeamMemberStatus, minimalUi: boolean): { readonly glyph: string; readonly color?: 'warning' | 'subtle' | 'error' | 'accent' } {
  switch (status) {
    case 'running': return minimalUi ? { glyph: '·' } : { glyph: '🟡', color: 'warning' }
    case 'idle': return minimalUi ? { glyph: '○' } : { glyph: '🔵', color: 'accent' }
    case 'active': return minimalUi ? { glyph: '◇' } : { glyph: '🟣', color: 'accent' }
    case 'provisioning': return minimalUi ? { glyph: '…' } : { glyph: '⚪', color: 'subtle' }
    case 'failed': return minimalUi ? { glyph: '×' } : { glyph: '🔴', color: 'error' }
  }
}

export function SubagentCard({ subagent, focused, onClick, variant = 'default', teamMember }: SubagentCardProps): React.ReactNode {
  const panelMode = variant === 'panel'
  const running = teamMember !== undefined
    ? teamMember.status === 'running'
    : subagent.status === 'running' || subagent.status === 'starting'
  const [clockRef] = useAnimationFrame(running ? 1000 : null)
  // Unknown rows have no completion time, so they do not get a fabricated duration.
  const elapsed = running
    ? Date.now() - subagent.startedAt
    : subagent.completedAt !== undefined ? subagent.completedAt - subagent.startedAt : undefined
  // Prefer backend-reported totals; fall back to the locally observed records.
  const toolsCount = subagent.reportedToolUses ?? subagent.toolCalls.length
  const shownDuration = subagent.reportedDurationMs ?? elapsed
  const total = subagent.tokens?.total ?? ((subagent.tokens?.input ?? 0) + (subagent.tokens?.output ?? 0) || 0)
  // Mouse affordance: clickable cards tint on hover; the keyboard-focused
  // card keeps its brand-color header (no double highlight).
  const [hovered, setHovered] = useState(false)
  const liveLine = running ? subagent.output[subagent.output.length - 1] : undefined
  const minimalUi = isMinimalUiMode()
  const teamGlyph = teamMember === undefined ? undefined : teamStatusGlyph(teamMember.status, minimalUi)
  const glyph = teamGlyph !== undefined ? teamGlyph.glyph
    : running ? (minimalUi ? '·' : '🟡')
    : subagent.status === 'unknown' ? (minimalUi ? '·' : '⚪')
    : subagent.status === 'failed' || subagent.status === 'cancelled' ? (minimalUi ? '×' : '🔴')
    : (minimalUi ? '✓' : '🟢')
  const glyphColor = teamGlyph !== undefined ? teamGlyph.color
    : minimalUi ? undefined
    : running ? 'warning' as const
    : subagent.status === 'unknown' ? 'subtle' as const
    : subagent.status === 'failed' || subagent.status === 'cancelled' ? 'error' as const
    : 'success' as const
  const hoverTint = onClick !== undefined && hovered && !focused
  // Keep the description on one row; narrower panels progressively drop metadata.
  const { columns } = useTerminalSize()
  const previewRows = panelMode && running
    ? jobOutputRows(subagent.output.map(text => ({ text })), Math.max(1, columns - 5), 2)
    : []
  const metaParts: string[] = []
  if (columns >= 56) metaParts.push(subagent.model ?? subagent.provider ?? 'default')
  if (shownDuration !== undefined) metaParts.push(formatDuration(shownDuration))
  if (columns >= 44) metaParts.push(`${total || '—'} tok`)
  if (columns >= 34 && (!panelMode || toolsCount > 0)) metaParts.push(`${toolsCount} tools`)
  const meta = metaParts.join(' · ')
  const panelMeta = [
    subagent.model ?? subagent.provider,
    subagent.effort,
    shownDuration === undefined ? undefined : formatDuration(shownDuration),
  ].filter(part => part !== undefined && part !== '').join(' · ')
  return <Box
    ref={clockRef}
    flexDirection="column"
    paddingLeft={1}
    marginBottom={panelMode ? 0 : 1}
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
        <Text bold color={focused ? 'accent' : undefined} wrap="truncate-end">{teamMember !== undefined ? teamMember.name : panelMode ? subagent.description : `${t('subagent-card-prefix')}${subagent.description}`}</Text>
      </Box>
      {teamMember === undefined && subagent.name !== undefined && subagent.name !== '' && (
        <Box flexShrink={1} overflow="hidden" marginLeft={1}>
          <Text dimColor wrap="truncate-end">{subagent.name}</Text>
        </Box>
      )}
      {teamMember !== undefined && (
        <Box flexShrink={0} marginLeft={1}>
          <Text color={focused ? 'accent' : teamGlyph?.color} dimColor={teamMember.status === 'provisioning'}>{t(`team-status-${teamMember.status}`)}</Text>
        </Box>
      )}
      {teamMember === undefined && subagent.mode === 'continuable' && (
        <Box flexShrink={0} marginLeft={1}>
          <Text color={focused ? 'accent' : 'warning'}>{t('subagent-mode-continuable')}</Text>
        </Box>
      )}
      {teamMember === undefined && subagent.mode === 'one-shot' && (
        <Box flexShrink={0} marginLeft={1}>
          <Text dimColor>{t('subagent-mode-one-shot')}</Text>
        </Box>
      )}
      {!panelMode && meta !== '' && (
        <Box flexShrink={0} marginLeft={1}>
          <Text dimColor wrap="truncate-end">{meta}</Text>
        </Box>
      )}
    </Box>
    {panelMode && panelMeta !== '' && <Box paddingLeft={3}><Text dimColor wrap="wrap">{panelMeta}</Text></Box>}
    {panelMode
      ? previewRows.map(row => <Text key={row.key} dimColor wrap="truncate">{`  ${row.text}`}</Text>)
      : liveLine !== undefined && <Text dimColor wrap="truncate">{`  │ ${liveLine}`}</Text>}
  </Box>
}
