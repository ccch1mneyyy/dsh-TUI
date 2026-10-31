import React from 'react'
import { Box, Text, useInput, ScrollBox, type ScrollBoxHandle, useTerminalSize } from '../ui.js'
import { SubagentCard, teamStatusGlyph } from './SubagentCard.js'
import type { SubagentState } from '../dsh-adapter/subagents.js'
import type { Theme } from '../theme.js'
import { t } from '../i18n.js'
import { Divider } from './design-system/Divider.js'
import { isPlainReturnInput } from '../utils/modifiers.js'
import { actionMatches } from '../utils/keymap.js'
import { usePanelInput } from './sidePanel/usePanelInput.js'
import type { SidePanelKeyFlags } from './sidePanel/types.js'
import { AgentMessagesSummary } from './messages/AgentMessageFlow.js'
import type { AgentMessageView, AgentIdentity } from './messages/agentTeam.js'
import type { TeamTask, TeamView } from '../adapter/ports/channel-view.js'
import { isTeamTaskBlocked, teamDashboardModel, teamTaskProgress, type TeamMemberRow } from './teamRoster.js'
import { isMinimalUiMode } from '../minimalUiMode.js'

export interface SubagentDashboardProps {
  subagents: readonly SubagentState[]
  /** Optional cross-session agents, kept separate from this session children. */
  readonly peers?: readonly AgentIdentity[]
  /** 整屏/浮层形态的退出通道（Esc / ✕ 按钮）。panel 形态不传：面板不自己
   *  关侧栏——Esc 让给宿主（焦点回聊天，见 usePanelInput 契约）。 */
  onClose?: () => void
  onSelect?: (agentId: string) => void
  /** 打开主屏只读 Agent View：行点击/Enter 仍进 Detail，这是另一个专用
   *  动作（'v' 键或行内 ⤢）。 */
  onOpenView?: (agentId: string) => void
  /** 代理↔代理消息流：每张卡下显示最后一条 from → to 摘要。 */
  messages?: readonly AgentMessageView[]
  /** Agent Teams: present → team mode (members joined with their subagent
   *  rows, a read-only task board, the failure banner). */
  team?: TeamView
  /** The session on screen: inside a teammate the subagent rows are its own
   *  children, so the roster is not joined with them. */
  sessionId?: string
  /** `panel` 挂在侧栏宿主里（去外层 padding、键盘走 usePanelInput 分发器）；
   *  default（缺省）与整屏形态逐字节一致。 */
  variant?: 'default' | 'panel'
  /** panel 形态：宿主报告焦点/可见性；非 active 时保留状态但收不到键。 */
  focused?: boolean
  visible?: boolean
}

/** Accept Ink's Enter flag and the panel dispatcher's normalized alias. */
export function isPanelPlainReturn(input: string, key: SidePanelKeyFlags): boolean {
  return isPlainReturnInput(input, {
    return: key.return_ === true || (key as { return?: boolean }).return === true,
    ctrl: key.ctrl,
    meta: key.meta,
    shift: key.shift,
  })
}

/** 可点击 ✕ 退出按钮：整屏/浮层场景的鼠标退出通道（Esc 等价）。 */
export function ExitButton({ onClick }: { onClick: () => void }): React.ReactNode {
  const [hovered, setHovered] = React.useState(false)
  return (
    <Box
      onClick={onClick}
      onMouseEnter={(): void => setHovered(true)}
      onMouseLeave={(): void => setHovered(false)}
    >
      <Text color={hovered ? 'text' : 'subtle'}>{' ✕'}</Text>
    </Box>
  )
}

/** One focusable dashboard row; a roster-only member has no subagent row
 *  yet, so it has neither a detail nor an Agent View target. */
interface DashboardEntry {
  readonly key: string
  readonly subagent?: SubagentState
  readonly teamRow?: TeamMemberRow
  readonly nested: boolean
}

/** A teammate the host has not announced as a subagent yet. */
function TeamRosterOnlyRow({ row, focused, panelMode, self }: { row: TeamMemberRow; focused: boolean; panelMode: boolean; self: boolean }): React.ReactNode {
  const { glyph, color } = teamStatusGlyph(row.status, isMinimalUiMode())
  return (
    <Box flexDirection="row" paddingLeft={1} marginBottom={panelMode ? 0 : 1}>
      <Box flexShrink={0} marginRight={1}><Text color={color}>{glyph}</Text></Box>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        <Text wrap="truncate-end">
          <Text bold color={focused ? 'accent' : undefined}>{row.member.name}</Text>
          {self && <Text dimColor>{' · ' + t('team-self-mark')}</Text>}
        </Text>
      </Box>
      <Box flexShrink={0} marginLeft={1}>
        <Text color={focused ? 'accent' : color} dimColor={row.status === 'provisioning'}>{t(`team-status-${row.status}`)}</Text>
      </Box>
    </Box>
  )
}

const TASK_GLYPH: Record<TeamTask['status'], { readonly glyph: string; readonly color: 'subtle' | 'accent' | 'success' }> = {
  pending: { glyph: '○', color: 'subtle' },
  in_progress: { glyph: '◐', color: 'accent' },
  completed: { glyph: '●', color: 'success' },
}

/** The team's shared task board, read-only; narrow widths drop the owner. */
function TeamTaskBoard({ tasks }: { tasks: readonly TeamTask[] }): React.ReactNode {
  const { columns } = useTerminalSize()
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor wrap="truncate-end">{t('team-tasks-title', teamTaskProgress(tasks))}</Text>
      {tasks.length === 0 && <Text dimColor>{'  ' + t('team-tasks-empty')}</Text>}
      {tasks.map(task => (
        <Box key={task.id} flexDirection="row" paddingLeft={1}>
          <Box flexShrink={0} marginRight={1}><Text color={TASK_GLYPH[task.status].color}>{TASK_GLYPH[task.status].glyph}</Text></Box>
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            <Text dimColor={task.status === 'completed'} wrap="truncate-end">{task.subject}</Text>
          </Box>
          {columns >= 40 && task.ownerName !== undefined && (
            <Box flexShrink={0} marginLeft={1}><Text dimColor>{'@' + task.ownerName}</Text></Box>
          )}
          {isTeamTaskBlocked(task) && (
            <Box flexShrink={0} marginLeft={1}><Text color="warning">{t('team-task-blocked')}</Text></Box>
          )}
          {task.writeScopeWarnings.length > 0 && (
            <Box flexShrink={0} marginLeft={1}><Text color="warning">{'⚠' + task.writeScopeWarnings.length}</Text></Box>
          )}
        </Box>
      ))}
    </Box>
  )
}

/**
 * SubagentDashboard — overlay panel showing all active/recent subagents.
 * Keyboard: up/down to navigate, Enter to view detail, Esc to close.
 */
export function SubagentDashboard({
  subagents,
  team,
  sessionId,
  peers,
  onClose,
  onSelect,
  onOpenView,
  messages,
  variant = 'default',
  focused = true,
  visible = true,
}: SubagentDashboardProps): React.ReactNode {
  const panelMode = variant === 'panel'
  // Focus follows the row's key: team mode reorders the rows, and the roster can shrink.
  const [focus, setFocus] = React.useState<{ readonly index: number; readonly key?: string }>({ index: 0 })
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const { rows, columns } = useTerminalSize()

  // Keep top-level children first when the roster includes nested agents.
  const isNestedSpawn = (row: SubagentState): boolean =>
    row.parentAgentId !== undefined || (row.depth ?? 1) >= 2
  const nestedRows = subagents.filter(isNestedSpawn)
  const flatRows = subagents.filter(row => !isNestedSpawn(row))
  const ordered = nestedRows.length === 0 ? subagents : [...flatRows, ...nestedRows]
  const model = team === undefined ? undefined : teamDashboardModel(team, subagents, sessionId)
  const others = new Set(model?.others)
  const nested = nestedRows.length
  const rowEntry = (subagent: SubagentState): DashboardEntry =>
    ({ key: subagent.agentId, subagent, nested: nested > 0 && isNestedSpawn(subagent) })
  const entries: readonly DashboardEntry[] = model === undefined
    ? ordered.map(rowEntry)
    : [
      ...model.teammates.map(row => ({ key: row.member.id, teamRow: row, nested: false, ...row.subagent === undefined ? {} : { subagent: row.subagent } })),
      ...ordered.filter(row => others.has(row)).map(rowEntry),
    ]
  const othersStart = model === undefined ? -1 : model.teammates.length
  const focusOf = (state: { readonly index: number; readonly key?: string }): number => {
    const found = state.key === undefined ? -1 : entries.findIndex(entry => entry.key === state.key)
    return found >= 0 ? found : Math.min(state.index, Math.max(0, entries.length - 1))
  }
  const focusIndex = focusOf(focus)
  const moveFocus = (delta: number): void => {
    setFocus((prev) => {
      const index = Math.max(0, Math.min(entries.length - 1, focusOf(prev) + delta))
      const key = entries[index]?.key
      return key === undefined ? { index } : { index, key }
    })
  }

  useInput((input, key, event) => {
    if (panelMode) return
    if (key.escape || (key.ctrl && input === 'c')) {
      event.stopImmediatePropagation()
      onClose?.()
      return
    }
    
    if (key.upArrow) {
      event.stopImmediatePropagation()
      moveFocus(-1)
      scrollRef.current?.scrollBy(-3)
      return
    }
    
    if (key.downArrow) {
      event.stopImmediatePropagation()
      moveFocus(1)
      scrollRef.current?.scrollBy(3)
      return
    }

    if (isPlainReturnInput(input, key) && onSelect) {
      event.stopImmediatePropagation()
      const selected = entries[focusIndex]?.subagent
      if (selected) onSelect(selected.agentId)
      return
    }

    // v = 主屏查看（Enter 仍是详情）。
    if (input.toLowerCase() === 'v' && onOpenView) {
      event.stopImmediatePropagation()
      const selected = entries[focusIndex]?.subagent
      if (selected) onOpenView(selected.agentId)
      return
    }
    
    // Consume all input while dashboard is open
    event.stopImmediatePropagation()
  }, { isActive: !panelMode })

  // Panel keys handle roster navigation; unhandled keys remain available to the host.
  const panelKeyHandler = (input: string, key: SidePanelKeyFlags): boolean => {
    if (key.escape === true || (key.ctrl === true && input === 'c')) return false
    // 分栏在渲染时 keymap 的 `paste` 组合（可重映射，macOS 上是 Cmd+V）先
    // 投递给活动面板：粘贴组合本身（含重映射到方向键等命名键）不触发表面动作。
    if (actionMatches('paste', input, key, true)) return false
    // 带修饰的字母同样不触发字母快捷键（Cmd+V 不能命中下面的 v）。方向键/Enter
    // 保持面板自己的语义（Cmd+↑/↓ 移焦点、Cmd+Enter 选中；isPanelPlainReturn
    // 不转发 super），不能被粘贴守卫一并吃掉。
    if ((key.ctrl === true || key.meta === true || key.super === true) && /^[a-z]$/u.test(input.toLowerCase())) return false

    if (key.upArrow === true) {
      moveFocus(-1)
      scrollRef.current?.scrollBy(-3)
      return true
    }

    if (key.downArrow === true) {
      moveFocus(1)
      scrollRef.current?.scrollBy(3)
      return true
    }

    if (isPanelPlainReturn(input, key)) {
      const selected = entries[focusIndex]?.subagent
      if (selected !== undefined) onSelect?.(selected.agentId)
      return true
    }

    if (input.toLowerCase() === 'v' && onOpenView !== undefined) {
      const selected = entries[focusIndex]?.subagent
      if (selected !== undefined) onOpenView(selected.agentId)
      return true
    }

    return false
  }
  usePanelInput(panelKeyHandler, { active: panelMode && focused && visible })

  const running = subagents.filter(s => s.status === 'running').length
  const completed = subagents.filter(s => s.status === 'completed').length
  const failed = subagents.filter(s => s.status === 'failed').length
  const memberCount = (status: TeamMemberRow['status']): number =>
    model?.teammates.filter(row => row.status === status).length ?? 0
  const teamSep = panelMode ? ' · ' : '   '

  // Full-screen keeps its inset; the panel uses one cell on each side.
  const outer = panelMode
    ? { paddingLeft: 1, paddingRight: 1, paddingTop: 0 }
    : { paddingX: 2, paddingY: 1 }

  return (
    <Box flexDirection="column" {...outer}>
      {!panelMode && <Divider color="accent" title={t(team === undefined ? 'subagent-dashboard-title' : 'team-dashboard-title')} />}

      <Box flexDirection="row" gap={3} marginTop={panelMode ? 0 : 1} marginBottom={panelMode ? 0 : 1}>
        {team !== undefined ? (
          // One line that truncates: a narrow panel drops the tail, not the layout.
          <Box flexShrink={1} overflow="hidden">
            <Text wrap="truncate-end">
              <Text color="accent">{memberCount('running')}</Text>
              <Text dimColor>{' ' + t('team-status-running') + teamSep}</Text>
              <Text color="accent">{memberCount('idle')}</Text>
              <Text dimColor>{' ' + t('team-status-idle') + teamSep}</Text>
              {memberCount('provisioning') > 0 && (
                <>
                  <Text dimColor>{memberCount('provisioning')}</Text>
                  <Text dimColor>{' ' + t('team-status-provisioning') + teamSep}</Text>
                </>
              )}
              {memberCount('active') > 0 && (
                <>
                  <Text color="accent">{memberCount('active')}</Text>
                  <Text dimColor>{' ' + t('team-status-active') + teamSep}</Text>
                </>
              )}
              {memberCount('failed') > 0 && (
                <>
                  <Text color="error">{memberCount('failed')}</Text>
                  <Text dimColor>{' ' + t('team-status-failed') + teamSep}</Text>
                </>
              )}
              <Text dimColor>{t('team-tasks-count', teamTaskProgress(team.tasks))}</Text>
            </Text>
          </Box>
        ) : (<>
        <Text>
          <Text color="accent">{running}</Text>
          <Text dimColor> {t('subagent-count-running')}</Text>
        </Text>
        <Text>
          <Text color="success">{completed}</Text>
          <Text dimColor> {t('subagent-count-completed')}</Text>
        </Text>
        {failed > 0 && (
          <Text>
            <Text color="error">{failed}</Text>
            <Text dimColor> {t('subagent-count-failed')}</Text>
          </Text>
        )}
        {nested > 0 && (
          <Text>
            <Text color="accent">{nested}</Text>
            <Text dimColor> {t('subagent-count-nested')}</Text>
          </Text>
        )}
        </>)}
        <Box flexGrow={1} />
        {/* 可点击退出（Esc 的鼠标等价），hover 提亮。侧栏形态没有退出目标：
            ✕ 关不掉右栏（那是宿主的事），渲染出来就是死控件。 */}
        {!panelMode && onClose !== undefined && <ExitButton onClick={onClose} />}
      </Box>

      {team?.failure !== undefined && (
        <Text color="error" wrap="wrap">{'⚠ ' + t('team-failure', { failure: team.failure })}</Text>
      )}

      <Box flexDirection="column" maxHeight={panelMode ? Math.max(6, rows - 4) : Math.max(10, rows - 10)} marginTop={panelMode ? 0 : 1}>
        <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>
          {model !== undefined && (
            <>
              <Text dimColor>{t('team-members-title')}</Text>
              <Text dimColor wrap="truncate-end">{'  ◆ ' + t(model.viewedFromLead ? 'team-lead-row' : 'team-lead-row-peer')}</Text>
            </>
          )}
          {model === undefined && subagents.length === 0 ? (
            <Box flexDirection="column" alignItems="center" marginTop={Math.max(2, Math.floor((rows - 16) / 3))}>
              <Text dimColor>{'○'}</Text>
              <Text dimColor>{t('subagent-none')}</Text>
              <Box marginTop={1}><Text dimColor>{t('subagent-empty-hint')}</Text></Box>
            </Box>
          ) : (
            entries.map(({ key, subagent, teamRow, nested: nestedMark }, index) => (
              <Box key={key} flexDirection="column">
                {index === othersStart && <Text dimColor>{t('team-others-title')}</Text>}
                {nestedMark && (
                  <Text dimColor>{'  ↳ ' + t('subagent-nested-mark')}</Text>
                )}
                {subagent === undefined ? (
                  teamRow !== undefined && <TeamRosterOnlyRow row={teamRow} focused={index === focusIndex} panelMode={panelMode} self={teamRow.member.id === sessionId} />
                ) : (
                  <SubagentCard
                    subagent={subagent}
                    variant={panelMode ? 'panel' : 'default'}
                    focused={index === focusIndex}
                    onClick={onSelect !== undefined
                      // Click = view detail, same as Enter on the focused card.
                      ? () => onSelect(subagent.agentId)
                      : undefined}
                    {...teamRow === undefined ? {} : { teamMember: { name: teamRow.member.name, status: teamRow.status } }}
                  />
                )}
                {teamRow?.status === 'failed' && teamRow.member.error !== undefined && (
                  <Text color="error" wrap="truncate-end">{'  │ ' + teamRow.member.error}</Text>
                )}
                {/* The member stays idle (a message wakes it), but its last turn failed:
                    show it, or the agents badge would point at nothing red. */}
                {teamRow?.status === 'idle' && subagent?.status === 'failed' && (
                  <Text color="error" wrap="truncate-end">{'  │ ' + t('team-last-run-failed', { error: subagent.error ?? '' }).trimEnd()}</Text>
                )}
                {subagent !== undefined && messages !== undefined && messages.length > 0 && (
                  <AgentMessagesSummary
                    messages={messages.filter(message => message.from === subagent.agentId || message.to === subagent.agentId)}
                    selfAgentId={subagent.agentId}
                  />
                )}
                {subagent !== undefined && onOpenView !== undefined && (!panelMode || index === focusIndex) && (
                  <Box paddingLeft={1} onClick={() => onOpenView(subagent.agentId)}>
                    <Text color="subtle">{`⤢ ${t('agent-view-open-action')}`}</Text>
                  </Box>
                )}
                {!panelMode && index < entries.length - 1 && index + 1 !== othersStart && (
                  <Text dimColor>{'─'.repeat(Math.max(20, Math.min(72, columns - 6)))}</Text>
                )}
              </Box>
            ))
          )}
          {team !== undefined && <TeamTaskBoard tasks={team.tasks} />}
        </ScrollBox>
      </Box>

      {/* Other-session agents are separate from this session children. */}
      {peers !== undefined && (!panelMode || peers.length > 0) && (
        <Box flexDirection="column">
          {panelMode ? (
            <Text dimColor wrap="truncate-end">{t('agents-peers-title') + ' · ' + peers.length}</Text>
          ) : (
            <>
              <Text dimColor>{t('agents-peers-title')}</Text>
              {peers.length === 0 ? (
                <Text dimColor>{'  ' + t('agents-peers-empty')}</Text>
              ) : (
                <Box flexDirection="column">
                  {peers.map(peer => (
                    <Text key={peer.agentId} dimColor wrap="truncate-end">
                      {'  · ' + (peer.name ?? peer.label ?? peer.agentId.slice(0, 8)) + ' · ' + peer.agentId.slice(0, 8)}
                    </Text>
                  ))}
                  <Text dimColor wrap="truncate-end">{'  ' + t('agents-peers-note')}</Text>
                </Box>
              )}
            </>
          )}
        </Box>
      )}

      {!panelMode && (
        <>
          <Divider color="subtle" title="" />
          <Box>
            <Text dimColor>
              {onSelect ? t('subagent-dashboard-hint-detail') : t('subagent-dashboard-hint-basic')}
            </Text>
          </Box>
        </>
      )}
    </Box>
  )
}
