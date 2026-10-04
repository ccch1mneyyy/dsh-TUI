import React from 'react'
import { Box, Text, useInput, ScrollBox, type ScrollBoxHandle, useTerminalSize } from '../ui.js'
import { SubagentCard } from './SubagentCard.js'
import type { SubagentState } from '../dsh-adapter/subagents.js'
import type { Theme } from '../theme.js'
import { t } from '../i18n.js'
import { Divider } from './design-system/Divider.js'
import { isPlainReturnInput } from '../utils/modifiers.js'
import { usePanelInput } from './sidePanel/usePanelInput.js'
import type { SidePanelKeyFlags } from './sidePanel/types.js'
import { AgentMessagesSummary } from './messages/AgentMessageFlow.js'
import type { AgentMessageView, AgentIdentity } from './messages/agentTeam.js'

export interface SubagentDashboardProps {
  subagents: readonly SubagentState[]
  /** Cross-session peers (the CLI's ListAgents peer/teammate sections).
   *  undefined = no peer roster for this session: a one-line note says so;
   *  a list renders in its own section, apart from the children. No
   *  backend serves one yet: the SDK's listSubagents lists this session's
   *  own children, not peers. */
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
  /** `panel` 挂在侧栏宿主里（去外层 padding、键盘走 usePanelInput 分发器）；
   *  default（缺省）与整屏形态逐字节一致。 */
  variant?: 'default' | 'panel'
  /** panel 形态：宿主报告焦点/可见性；非 active 时保留状态但收不到键。 */
  focused?: boolean
  visible?: boolean
}

/**
 * Panel 分发器的 Enter 判定：ink 的 key 对象里这一位叫 `return`，而 v2.1
 * 的 SidePanelKeyFlags 拼作 `return_`——两个都认，再由共享的 plain-Enter
 * 守卫拦掉带修饰键的 Enter（那是换行，不是确认）。
 */
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

/**
 * SubagentDashboard — overlay panel showing all active/recent subagents.
 * Keyboard: up/down to navigate, Enter to view detail, Esc to close.
 */
export function SubagentDashboard({
  subagents,
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
  const [focusIndex, setFocusIndex] = React.useState(0)
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)
  const { rows, columns } = useTerminalSize()

  // ── roster partition: only a known nesting moves a row (a parent agent
  // id or depth >= 2) below the main-loop children with a ↳ mark. Rows
  // with neither stay in place, unmarked. Without any nesting the roster
  // keeps its flat layout. ──────────────────────────────────────────────
  const isNestedSpawn = (row: SubagentState): boolean =>
    row.parentAgentId !== undefined || (row.depth ?? 1) >= 2
  const nestedRows = subagents.filter(isNestedSpawn)
  const flatRows = subagents.filter(row => !isNestedSpawn(row))
  const ordered = nestedRows.length === 0 ? subagents : [...flatRows, ...nestedRows]

  useInput((input, key, event) => {
    if (panelMode) return
    if (key.escape || (key.ctrl && input === 'c')) {
      event.stopImmediatePropagation()
      onClose?.()
      return
    }
    
    if (key.upArrow) {
      event.stopImmediatePropagation()
      setFocusIndex(i => Math.max(0, i - 1))
      scrollRef.current?.scrollBy(-3)
      return
    }
    
    if (key.downArrow) {
      event.stopImmediatePropagation()
      setFocusIndex(i => Math.min(ordered.length - 1, i + 1))
      scrollRef.current?.scrollBy(3)
      return
    }

    if (isPlainReturnInput(input, key) && onSelect) {
      event.stopImmediatePropagation()
      const selected = ordered[focusIndex]
      if (selected) onSelect(selected.agentId)
      return
    }

    // v = 主屏查看（Enter 仍是详情）。
    if (input.toLowerCase() === 'v' && onOpenView) {
      event.stopImmediatePropagation()
      const selected = ordered[focusIndex]
      if (selected) onOpenView(selected.agentId)
      return
    }
    
    // Consume all input while dashboard is open
    event.stopImmediatePropagation()
  }, { isActive: !panelMode })

  // Panel form（v2.1 键盘契约）：业务键先吃，其余让给宿主。Esc/Ctrl+C 返回
  // false —— 收焦点回聊天是宿主的事（Dashboard 是这一栏的根，没有上一层可
  // 回），[/]、数字、z、+/- 同样保持可用。
  const panelKeyHandler = (input: string, key: SidePanelKeyFlags): boolean => {
    if (key.escape === true || (key.ctrl === true && input === 'c')) return false

    if (key.upArrow === true) {
      setFocusIndex(i => Math.max(0, i - 1))
      scrollRef.current?.scrollBy(-3)
      return true
    }

    if (key.downArrow === true) {
      setFocusIndex(i => Math.min(ordered.length - 1, i + 1))
      scrollRef.current?.scrollBy(3)
      return true
    }

    if (isPanelPlainReturn(input, key)) {
      const selected = ordered[focusIndex]
      if (selected !== undefined) onSelect?.(selected.agentId)
      return true
    }

    if (input.toLowerCase() === 'v' && onOpenView !== undefined) {
      const selected = ordered[focusIndex]
      if (selected !== undefined) onOpenView(selected.agentId)
      return true
    }

    return false
  }
  usePanelInput(panelKeyHandler, { active: panelMode && focused && visible })

  const running = subagents.filter(s => s.status === 'running').length
  const completed = subagents.filter(s => s.status === 'completed').length
  const failed = subagents.filter(s => s.status === 'failed').length
  const nested = nestedRows.length

  // 外层留白：整屏形态保持原样；侧栏形态只留左右各 1 格（PanelBar 与宿主
  // 提示行已经承担其余 chrome）。卡片之间的分隔线按 `columns` 算，而
  // PanelHost 把 TerminalSizeContext 收窄成面板宽度，所以那条公式自动跟随。
  const outer = panelMode
    ? { paddingLeft: 1, paddingRight: 1, paddingTop: 0 }
    : { paddingX: 2, paddingY: 1 }

  return (
    <Box flexDirection="column" {...outer}>
      <Divider
        color="accent"
        title={t('subagent-dashboard-title')}
      />

      <Box flexDirection="row" gap={3} marginTop={1} marginBottom={1}>
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
        <Box flexGrow={1} />
        {/* 可点击退出（Esc 的鼠标等价），hover 提亮。侧栏形态没有退出目标：
            ✕ 关不掉右栏（那是宿主的事），渲染出来就是死控件。 */}
        {!panelMode && onClose !== undefined && <ExitButton onClick={onClose} />}
      </Box>

      {/* 行数预算：整屏形态沿用原公式（rows 是整屏高度）；侧栏形态的 rows
          已经是宿主高度（列高 - 4 行 chrome），再用整屏预算会把底部提示行
          挤出可视区，所以单独收一档。 */}
      <Box flexDirection="column" maxHeight={panelMode ? Math.max(6, rows - 8) : Math.max(10, rows - 10)} marginTop={1}>
        <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1}>
          {subagents.length === 0 ? (
            <Box flexDirection="column" alignItems="center" marginTop={Math.max(2, Math.floor((rows - 16) / 3))}>
              <Text dimColor>{'○'}</Text>
              <Text dimColor>{t('subagent-none')}</Text>
              <Box marginTop={1}><Text dimColor>{t('subagent-empty-hint')}</Text></Box>
            </Box>
          ) : (
            ordered.map((subagent, index) => (
              <Box key={subagent.agentId} flexDirection="column">
                {nested > 0 && isNestedSpawn(subagent) && (
                  <Text dimColor>{'  ↳ ' + t('subagent-nested-mark')}</Text>
                )}
                <SubagentCard
                  subagent={subagent}
                  focused={index === focusIndex}
                  onClick={onSelect !== undefined
                    // Click = view detail, same as Enter on the focused card.
                    ? () => onSelect(subagent.agentId)
                    : undefined}
                />
                {messages !== undefined && messages.length > 0 && (
                  <AgentMessagesSummary
                    messages={messages.filter(message => message.from === subagent.agentId || message.to === subagent.agentId)}
                    selfAgentId={subagent.agentId}
                  />
                )}
                {onOpenView !== undefined && (
                  <Box paddingLeft={1} onClick={() => onOpenView(subagent.agentId)}>
                    <Text color="subtle">{`⤢ ${t('agent-view-open-action')}`}</Text>
                  </Box>
                )}
                {index < ordered.length - 1 && (
                  <Text dimColor>{'─'.repeat(Math.max(20, Math.min(72, columns - 6)))}</Text>
                )}
              </Box>
            ))
          )}
        </ScrollBox>
      </Box>

      {/* Peer roster, kept apart from the children above. No backend serves
       * one yet, so the note says so. Peers would get no send action
       * either: the composer reaches only this session's children. The
       * side panel collapses this to one truncated line. */}
      <Box flexDirection="column">
        {panelMode ? (
          <Text dimColor wrap="truncate-end">
            {peers === undefined
              ? t('agents-peers-unsupported-panel')
              : t('agents-peers-title') + ' · ' + peers.length}
          </Text>
        ) : (
          <>
            <Text dimColor>{t('agents-peers-title')}</Text>
            {peers === undefined ? (
              <Text dimColor wrap="truncate-end">{'  ' + t('agents-peers-unsupported')}</Text>
            ) : peers.length === 0 ? (
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

      <Divider color="subtle" title="" />
      <Box marginTop={0}>
        <Text dimColor>
          {onSelect
            ? t(panelMode ? 'subagent-dashboard-hint-panel' : 'subagent-dashboard-hint-detail')
            : t('subagent-dashboard-hint-basic')}
        </Text>
      </Box>
    </Box>
  )
}
