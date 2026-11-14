/**
 * InfoPanel — 侧栏「信息」面板：把当前会话的运行信息分组、紧凑地列出。
 *
 * 口径与状态栏完全一致：上下文占用（formatContextUsage + contextPressureStep
 * 阈值配色）、缓存命中（formatCacheHitRate）、TPS（speedStep，与 speedColor 同档）、
 * 花费（estimateSessionCostSnapshotCny 同一套门控）、模式名（modeDisplayName）、
 * cwd 展示折叠（formatProject）。本组件不推导任何新口径，只重排布局。
 *
 * 布局走插件同一套图表原语（docs/plugin-ui-kit-design.md 三期）：每组是
 * 一张两列 `Table`——标签列定宽（`inactive` 色，即 dimColor 的同一色）、值列
 * 弹性，按显示格截断加 `…`，长 cwd / 长标题在 28 列也不会把列挤爆；上下文
 * 行下面一条 `Meter`，按与状态栏 ctx 悬停表相同的阈值配色。内容超高时
 * ScrollBox 滚动：滚轮由 ScrollBox 自带（位置路由），↑/↓ 经 usePanelInput
 * （v2.1 键盘契约）。visible=false 时不挂任何定时器 / 高频订阅（本面板本来
 * 就是纯读渲染）。
 */
import React from 'react'
import { Box, Meter, ScrollBox, Table, type ScrollBoxHandle, type TuiTableCell, type TuiTableColumn } from '../../ui.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { t } from '../../i18n.js'
import { formatTokens } from '../../terminal-utils/format.js'
import { formatContextUsage } from '../../tuiDisplayPrefs.js'
import { modeDisplayName, type SessionModeSpec } from '../../sessionModes.js'
import { estimateSessionCostSnapshotCny, isDeepSeekOfficialProvider, isPeakHour } from '../../deepseekPricing.js'
import { formatCacheHitRate, formatCostReport } from '../../screens/StatusLine.js'
import { contextPressureStep, speedStep } from '../../screens/StatusMetrics.js'
import { displayWorkingDirectory, formatProject } from '../../sessions/format.js'
import { homeDir } from '../../utils/paths.js'
import { Divider } from '../design-system/Divider.js'
import { useSidePanelChannel } from './SidePanelRuntimeContext.js'
import { usePanelInput } from './usePanelInput.js'
import type { PanelProps } from './types.js'
import type { Theme } from '../../theme.js'

/** 一行键值：标签 + 值（纯文本，或带主题色的单元格）。 */
type InfoRow = { readonly label: string; readonly value: TuiTableCell }

/** 一组：分隔线标题 + 两列表。 */
function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactNode {
  return (
    <Box flexDirection="column" marginTop={1} width="100%">
      <Divider title={title} />
      {children}
    </Box>
  )
}

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
  const currentCwd = displayWorkingDirectory(channel)
  const displayCwd = channel.displayCwd === channel.cwd
    ? formatProject(currentCwd, homeDir())
    : currentCwd

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
  // 花费：与状态栏同一规则——后端自报的会话花费（Claude `total_cost_usd`）
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
  // TPS 值整格按状态栏同一档位着色（主题键，浅色主题跟随），不再把暗色
  // 主题的 hex 写进字符串。
  const tpsCell: TuiTableCell = channel.tps !== undefined
    ? { text: Math.round(channel.tps) + ' tps', color: speedStep(channel.tps) }
    : none
  const jobs = channel.backgroundJobs
  const jobsLive = (jobs ?? []).filter(job => job.status === 'running' || job.status === 'stopping').length
  const jobsText = jobs !== undefined ? jobsLive + '/' + jobs.length : none
  const subagents = channel.subagents
  const subagentsText = subagents !== undefined ? String(subagents.length) : none

  // 标签列取「本语言最长标签」与「内容宽一半」的较小者：28 列时标签
  // 先让路（截断），值列保住至少一半——点名字段的前缀必须仍可读。
  const tableWidth = Math.max(0, width - 2)
  const labelWidth = Math.min(
    Math.max(...[
      t('info-row-title'), t('info-row-session-id'), t('info-row-agent-id'), t('info-row-cwd'),
      t('info-row-branch'), t('info-row-model'), t('info-row-effort'), t('info-row-mode'),
      t('info-row-approval'), t('info-row-context'), t('info-row-window'), t('info-row-tokens'),
      t('info-row-cache'), t('info-row-cost'), t('info-row-tps'), t('info-row-status'),
      t('info-row-activity'), t('info-row-jobs'), t('info-row-subagents'),
    ].map(s => stringWidth(s))),
    Math.max(6, Math.floor(Math.max(10, tableWidth) / 2)),
  )
  // 一张两列表的值列宽（Table 的列间距是 1 格）；上下文 Meter 与它对齐。
  const valueWidth = Math.max(0, tableWidth - labelWidth - 1)
  const columns: readonly TuiTableColumn[] = [
    { key: 'label', width: labelWidth, color: 'inactive' },
    { key: 'value', grow: 1 },
  ]
  const table = (rows: readonly InfoRow[]): React.ReactNode => (
    <Table columns={columns} rows={rows} width={tableWidth} header={false} />
  )
  const text = (value: string, color: keyof Theme | undefined): TuiTableCell =>
    color === undefined ? value : { text: value, color }
  const explicitMode = modeNeedsExplicitMarker(channel.mode)

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1} width={width} flexShrink={0}>
      <ScrollBox ref={scrollRef} flexDirection="column" maxHeight={Math.max(3, height)} flexGrow={1}>
        <Section title={t('info-section-session')}>
          {table([
            { label: t('info-row-title'), value: channel.sessionTitle !== '' ? channel.sessionTitle : none },
            { label: t('info-row-session-id'), value: channel.sessionId !== '' ? '#' + channel.sessionId.slice(0, 8) : none },
            { label: t('info-row-agent-id'), value: channel.agentId !== '' ? '#' + channel.agentId.slice(0, 8) : none },
            { label: t('info-row-cwd'), value: displayCwd !== '' ? displayCwd : none },
            { label: t('info-row-branch'), value: channel.gitBranch !== undefined && channel.gitBranch !== '' ? channel.gitBranch : none },
          ])}
        </Section>
        <Section title={t('info-section-model')}>
          {table([
            { label: t('info-row-model'), value: channel.model !== '' ? channel.model : none },
            { label: t('info-row-effort'), value: channel.reasoningEffort !== undefined && channel.reasoningEffort !== '' ? channel.reasoningEffort : none },
            { label: t('info-row-mode'), value: text(modeName, channel.mode.plan === true ? 'planMode' : explicitMode ? 'warning' : undefined) },
            { label: t('info-row-approval'), value: text(approval !== undefined && approval !== '' ? approval : none, explicitMode ? 'warning' : undefined) },
          ])}
        </Section>
        <Section title={t('info-section-context')}>
          {table([{ label: t('info-row-context'), value: text(contextText ?? none, contextStep) }])}
          {contextPct !== undefined && valueWidth > 0
            ? (
              // 占用条挂在上下文读数下、与值列对齐；阈值配色同状态栏 ctx 悬停表
              // （绿 < 80%、琥珀 ≥ 80%、红 ≥ 95%）。
              <Box flexDirection="row" width={tableWidth} flexShrink={0}>
                <Box width={labelWidth + 1} flexShrink={0} />
                <Meter ratio={contextPct / 100} width={valueWidth} fillColor={contextStep ?? 'success'} emptyColor="subtle" />
              </Box>
            )
            : null}
          {table([
            { label: t('info-row-window'), value: channel.contextWindow !== undefined ? formatTokens(channel.contextWindow) : none },
            { label: t('info-row-tokens'), value: formatTokens(channel.tokens.input) + '→' + formatTokens(channel.tokens.output) },
            { label: t('info-row-cache'), value: cacheText },
            { label: t('info-row-cost'), value: costText },
            { label: t('info-row-tps'), value: tpsCell },
          ])}
        </Section>
        <Section title={t('info-section-runtime')}>
          {table([
            { label: t('info-row-status'), value: String(channel.status) },
            { label: t('info-row-activity'), value: text(channel.working ? channel.spinnerMode : none, channel.working ? 'success' : undefined) },
            { label: t('info-row-jobs'), value: jobsText },
            { label: t('info-row-subagents'), value: subagentsText },
          ])}
        </Section>
      </ScrollBox>
    </Box>
  )
}
