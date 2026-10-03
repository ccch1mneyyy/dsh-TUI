/**
 * InfoPanel — 侧栏「信息」面板：把当前会话的运行信息分组、紧凑地列出。
 *
 * 口径与状态栏完全一致：上下文占用（formatContextUsage + contextPressureStep
 * 阈值配色）、缓存命中（formatCacheHitRate）、TPS（tpsStats / speedColor）、
 * 花费（estimateSessionCostSnapshotCny 同一套门控）、模式名（modeDisplayName）、
 * cwd 展示折叠（formatProject）。本组件不推导任何新口径，只重排布局。
 *
 * 布局：键值两列，标签列定宽截断、值列悬挂缩进并 truncate——长 cwd /
 * 长标题在 28 列也不会把列挤爆。内容超高时 ScrollBox 滚动：滚轮由
 * ScrollBox 自带（位置路由），↑/↓ 经 usePanelInput（v2.1 键盘契约）。
 * visible=false 时不挂任何定时器 / 高频订阅（本面板本来就是纯读渲染）。
 */
import React from 'react'
import { Box, Text, ScrollBox, type ScrollBoxHandle } from '../../ui.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { t } from '../../i18n.js'
import { formatTokens } from '../../terminal-utils/format.js'
import { formatContextUsage } from '../../tuiDisplayPrefs.js'
import { modeDisplayName, type SessionModeSpec } from '../../sessionModes.js'
import { estimateSessionCostSnapshotCny, isDeepSeekOfficialProvider, isPeakHour } from '../../deepseekPricing.js'
import { formatCacheHitRate, formatCostReport } from '../../screens/StatusLine.js'
import { contextPressureStep, speedColor } from '../../screens/StatusMetrics.js'
import { formatProject } from '../../sessions/format.js'
import { homeDir } from '../../utils/paths.js'
import { Divider } from '../design-system/Divider.js'
import { useSidePanelChannel } from './SidePanelRuntimeContext.js'
import { usePanelInput } from './usePanelInput.js'
import type { PanelProps } from './types.js'
import type { Theme } from '../../theme.js'

/** 与状态栏同一口径的上下文已用量：最近一次请求的 input+cacheRead+cacheWrite。 */
function contextUsedOf(channel: ReturnType<typeof useSidePanelChannel>): number | undefined {
  const usage = channel.lastUsage
  if (usage === undefined) return undefined
  return usage.input + usage.cacheRead + usage.cacheWrite
}

/** 权限行取值：durable preset 身份优先，否则 sandbox·approval 原子拼合。 */
function approvalOf(mode: SessionModeSpec): string | undefined {
  if (mode.permission !== undefined) return mode.permission
  if (mode.sandbox === undefined && mode.approval === undefined) return undefined
  return [mode.sandbox, mode.approval].filter(Boolean).join('·')
}

/** 非默认模式的显式标记（与状态栏 modeNeedsExplicitMarker 同判）。 */
function modeNeedsExplicitMarker(mode: SessionModeSpec): boolean {
  return mode.plan === true
    || mode.sandbox === 'danger-full-access'
    || mode.approval === 'never'
}

export function InfoPanel({ width, height, focused, visible }: PanelProps): React.ReactNode {
  const channel = useSidePanelChannel()
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null)

  // 面板业务键：↑/↓ 滚动（内容超高才有意义）；Esc 等一律让出给宿主回退。
  const panelKeyHandler = (input: string, key: { upArrow?: boolean; downArrow?: boolean; escape?: boolean; ctrl?: boolean }) => {
    if (key.escape === true || (key.ctrl === true && input === 'c')) return false
    if (key.upArrow === true) {
      scrollRef.current?.scrollBy(-1)
      return true
    }
    if (key.downArrow === true) {
      scrollRef.current?.scrollBy(1)
      return true
    }
    return false
  }
  usePanelInput(panelKeyHandler, { active: focused && visible })

  const usage = channel.lastUsage
  const used = contextUsedOf(channel)
  const displayCwd = channel.displayCwd === channel.cwd
    ? formatProject(channel.displayCwd, homeDir())
    : channel.displayCwd

  // --- 值构造（全部复用状态栏口径） -------------------------------------
  const none = t('info-value-none')
  const modeName = modeDisplayName(channel.mode)
  const approval = approvalOf(channel.mode)
  const contextText = formatContextUsage(used, channel.contextWindow, true)
  const contextPct = used !== undefined && channel.contextWindow !== undefined && channel.contextWindow > 0
    ? (used / channel.contextWindow) * 100
    : undefined
  const contextStep = contextPct !== undefined ? contextPressureStep(contextPct) : undefined
  const cacheText = formatCacheHitRate(usage) ?? none
  // 花费：与状态栏同门控——后端自报的会话花费（Claude `total_cost_usd`）
  // 优先；否则官方 DeepSeek 路由 + 有计价金额或未计价 token。
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- partial embedder channels omit the report
  const costReport = channel.costReport
  const estimate = costReport === undefined && isDeepSeekOfficialProvider(channel.provider)
    ? estimateSessionCostSnapshotCny({
        provider: channel.provider,
        main: channel.mainCost ?? {},
        subagents: channel.subagentCost ?? [],
        fallbackTokens: channel.tokens,
        fallbackModel: channel.model,
      })
    : undefined
  const costText = costReport !== undefined
    ? formatCostReport(costReport)
    : estimate !== undefined && (estimate.total > 0 || estimate.unpricedTokens > 0)
    ? estimate.total > 0
      ? '¥' + estimate.total.toFixed(2) + ' ' + t(isPeakHour() ? 'cost-now-peak' : 'cost-now-idle')
      : t('cost-unpriced', { tokens: formatTokens(estimate.unpricedTokens) })
    : none
  const tpsText = channel.tps !== undefined
    ? speedColor(channel.tps, String(Math.round(channel.tps))) + ' tps'
    : none
  const jobs = channel.backgroundJobs
  const jobsLive = (jobs ?? []).filter(job => job.status === 'running' || job.status === 'stopping').length
  const jobsText = jobs !== undefined ? jobsLive + '/' + jobs.length : none
  const subagents = channel.subagents
  const subagentsText = subagents !== undefined ? String(subagents.length) : none

  // 标签列取「本语言最长标签」与「内容宽一半」的较小者：28 列时标签
    // 先让路（截断），值列保住至少一半——点名字段的前缀必须仍可读。
    const contentWidth = Math.max(10, width - 2)
    const labelWidth = Math.min(
      Math.max(...[
        t('info-row-title'), t('info-row-session-id'), t('info-row-agent-id'), t('info-row-cwd'),
        t('info-row-branch'), t('info-row-model'), t('info-row-effort'), t('info-row-mode'),
        t('info-row-approval'), t('info-row-context'), t('info-row-window'), t('info-row-tokens'),
        t('info-row-cache'), t('info-row-cost'), t('info-row-tps'), t('info-row-status'),
        t('info-row-activity'), t('info-row-jobs'), t('info-row-subagents'),
      ].map(s => stringWidth(s))),
      Math.max(6, Math.floor(contentWidth / 2)),
    )

  function Row({ label, value, valueColor }: {
    label: string
    value: React.ReactNode
    valueColor?: keyof Theme
  }): React.ReactNode {
    return (
      <Box flexDirection="row" gap={1} width="100%">
        {/* 标签列定宽截断：窄面板先保值列——标签截断好认，值截断不认。 */}
        <Box width={labelWidth} flexShrink={0}>
          <Text dimColor wrap="truncate-end">{label}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text color={valueColor} wrap="truncate-end">{value}</Text>
        </Box>
      </Box>
    )
  }

  function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactNode {
    return (
      <Box flexDirection="column" marginTop={1} width="100%">
        <Divider title={title} />
        <Box flexDirection="column" marginTop={0} width="100%">
          {children}
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1} width={width} flexShrink={0}>
      <ScrollBox ref={scrollRef} flexDirection="column" maxHeight={Math.max(3, height)} flexGrow={1}>
        <Section title={t('info-section-session')}>
          <Row label={t('info-row-title')} value={channel.sessionTitle !== '' ? channel.sessionTitle : none} />
          <Row label={t('info-row-session-id')} value={channel.sessionId !== '' ? '#' + channel.sessionId.slice(0, 8) : none} />
          <Row label={t('info-row-agent-id')} value={channel.agentId !== '' ? '#' + channel.agentId.slice(0, 8) : none} />
          <Row label={t('info-row-cwd')} value={displayCwd !== '' ? displayCwd : none} />
          <Row label={t('info-row-branch')} value={channel.gitBranch !== undefined && channel.gitBranch !== '' ? channel.gitBranch : none} />
        </Section>
        <Section title={t('info-section-model')}>
          <Row label={t('info-row-model')} value={channel.model !== '' ? channel.model : none} />
          <Row label={t('info-row-effort')} value={channel.reasoningEffort !== undefined && channel.reasoningEffort !== '' ? channel.reasoningEffort : none} />
          <Row
            label={t('info-row-mode')}
            value={modeName}
            valueColor={channel.mode.plan === true ? 'planMode' : modeNeedsExplicitMarker(channel.mode) ? 'warning' : undefined}
          />
          <Row
            label={t('info-row-approval')}
            value={approval !== undefined && approval !== '' ? approval : none}
            valueColor={modeNeedsExplicitMarker(channel.mode) ? 'warning' : undefined}
          />
        </Section>
        <Section title={t('info-section-context')}>
          <Row label={t('info-row-context')} value={contextText ?? none} valueColor={contextStep} />
          <Row label={t('info-row-window')} value={channel.contextWindow !== undefined ? formatTokens(channel.contextWindow) : none} />
          <Row
            label={t('info-row-tokens')}
            value={formatTokens(channel.tokens.input) + '→' + formatTokens(channel.tokens.output)}
          />
          <Row label={t('info-row-cache')} value={cacheText} />
          <Row label={t('info-row-cost')} value={costText} />
          <Row label={t('info-row-tps')} value={tpsText} />
        </Section>
        <Section title={t('info-section-runtime')}>
          <Row label={t('info-row-status')} value={String(channel.status)} />
          <Row
            label={t('info-row-activity')}
            value={channel.working ? channel.spinnerMode : none}
            valueColor={channel.working ? 'success' : undefined}
          />
          <Row label={t('info-row-jobs')} value={jobsText} />
          <Row label={t('info-row-subagents')} value={subagentsText} />
        </Section>
      </ScrollBox>
    </Box>
  )
}