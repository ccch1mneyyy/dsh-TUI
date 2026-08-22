import React from 'react'
import { Box, Text, useTerminalSize, useTheme } from '../ui.js'
import { formatTokens } from '../cc/format.js'
import { t } from '../i18n.js'
import { formatContextUsage, DEFAULT_STATUS_BAR, normalizeStatusBar, type StatusBarConfig } from '../tuiDisplayPrefs.js'
import { Byline } from '../components/design-system/Byline.js'
import { ActivityLine, contextPressurePct } from '../components/ActivityLine.js'
import { GoalStatusChip } from '../components/GoalTodoPanel.js'
import type { Channel } from '../dsh-adapter/channel.js'
import { modeDisplayName } from '../sessionModes.js'
import { MiniWake } from '../components/trajectory/MiniWake.js'
import type { WaveBand } from '../dsh-adapter/types.js'
import {
  renderContextBar,
  renderTpsGauge,
  renderTpsSparkline,
  speedColor,
} from './StatusMetrics.js'

/**
 * The footer under the prompt input, in Claude Code's PromptInputFooter
 * layout: the segmented context progress bar on its own first line, the
 * status line below (left group: model · tokens · think level · cache · tps
 * gauge/sparkline; right group: git · cwd · title · short session id,
 * right-aligned), and the
 * mode/hint line last. The right side of the footer shows the latest
 * transient notification (errors in red, warnings in amber — CC style).
 */
export function StatusLine({
  channel,
  fullscreen = false,
  selectionActive = false,
  helpOpen = false,
  wake,
}: {
  channel: Channel
  /** Live display mode: always shown at the left of the model/context row. */
  fullscreen?: boolean
  selectionActive?: boolean
  helpOpen?: boolean
  /**
   * The session projected onto the status line's few columns, plus the
   * animation tick and the self-retiring key hint.
   *
   * A strip that shows the session's shape keeps earning its space in a way a
   * static label cannot, and it carries the failure signal in position rather
   * than as a count in the corner. Absent in headless embeds, where nothing
   * folds the event log.
   */
  wake?: { band: WaveBand; hint?: string; tick: number }
}) {
  const { columns } = useTerminalSize()
  const [themeName] = useTheme()

  const statusBar: StatusBarConfig = channel.minimal
    // Minimal mode overrides every field switch: model + cwd only, so the
    // footer can never grow decorations regardless of saved preferences.
    ? { ...DEFAULT_STATUS_BAR, compact: true, model: true, cwd: true }
    : normalizeStatusBar(channel.statusBar)
  const usage = channel.lastUsage
  const contextUsed = usage === undefined
    ? undefined
    : usage.input + usage.cacheRead + usage.cacheWrite
  const contextParts: React.ReactNode[] = []

  if (statusBar.thinking && channel.reasoningEffort !== undefined) {
    contextParts.push(
      <Text key="effort" color="inactiveShimmer">
        {channel.reasoningEffort}
      </Text>,
    )
  }
  if (statusBar.mode && channel.modeIndex > 0) {
    contextParts.push(
      <Text
        key="mode"
        color={channel.mode.plan === true ? 'planMode' : 'warning'}
      >
        {modeDisplayName(channel.mode)}
      </Text>,
    )
  }
  const formattedContext = statusBar.contextUsage
    ? formatContextUsage(contextUsed, channel.contextWindow, statusBar.compact)
    : undefined
  const contextUsagePart = formattedContext === undefined
    ? undefined
    : (
        <Text key="context" color="inactiveShimmer">
          <Text dimColor>ctx </Text>{formattedContext}
        </Text>
      )
  if (statusBar.cache) {
    const cacheRate = formatCacheHitRate(usage)
    if (cacheRate !== undefined) {
      contextParts.push(
        <Text key="cache" color="inactiveShimmer">
          <Text dimColor>{t('status-cache-label')}</Text>{cacheRate}
        </Text>,
      )
    }
  }

  const tpsParts: React.ReactNode[] = []
  if (statusBar.tps && channel.tps !== undefined) {
    if (channel.working && channel.tpsSamples.length === 0) {
      tpsParts.push(
        <Text key="tps">
          {renderTpsGauge(channel.tps, channel.tps)}{' '}
          <Text dimColor>{Math.round(channel.tps)} tps</Text>
        </Text>,
      )
    } else if (channel.tpsSamples.length > 0) {
      const peak = Math.max(...channel.tpsSamples.map(sample => sample.tps), channel.tps)
      tpsParts.push(
        <Text key="tps">
          {channel.working
            ? renderTpsGauge(channel.tps, peak)
            : renderTpsSparkline(channel.tpsSamples)}{' '}
          {speedColor(channel.tps, `${Math.round(channel.tps)}`)} tps
        </Text>,
      )
    } else {
      tpsParts.push(
        <Text key="tps" dimColor>
          {Math.round(channel.tps)} t/s
        </Text>,
      )
    }
  }

  const leftParts = [
    <Text key="display" color="inactiveShimmer">
      {fullscreen ? t('tui-mode-fullscreen') : t('tui-mode-inline')}
    </Text>,
    ...(statusBar.model
      ? [<Text key="model" color="inactiveShimmer">{channel.model}</Text>]
      : []),
    ...tpsParts,
    ...contextParts,
    ...(statusBar.tokens
      ? [
          <Text key="tokens" color="inactiveShimmer">
            {formatTokens(channel.tokens.input)}→{formatTokens(channel.tokens.output)}
          </Text>,
        ]
      : []),
  ]

  const rightParts = [
    // Goal chip first: session-level state outranks repo/location details.
    ...(statusBar.goal && channel.goal !== undefined
      ? [
          <GoalStatusChip
            key="goal"
            goal={channel.goal}
            minimal={channel.minimal}
          />,
        ]
      : []),
    ...(statusBar.gitBranch && channel.gitBranch
      ? [
          <Text key="git" color="professionalBlue">
            {channel.gitBranch}
          </Text>,
        ]
      : []),
    ...(statusBar.cwd
      ? [
          <Text key="cwd" color="inactiveShimmer">
            {statusBar.compact ? basename(channel.displayCwd) : channel.displayCwd}
          </Text>,
        ]
      : []),
    ...(statusBar.sessionTitle && channel.sessionTitle
      ? [
          <Text key="title" dimColor>
            {channel.sessionTitle}
          </Text>,
        ]
      : []),
    // Short id last: a provenance tag trails the content it identifies, and
    // the 8-char form is what the session log filename starts with, so a
    // truncated rendering still names the right log for --resume.
    ...(statusBar.sessionId && channel.agentId
      ? [
          <Text key="sessionId" dimColor>
            {`#${channel.agentId.slice(0, 8)}`}
          </Text>,
        ]
      : []),
  ]

  const hint = selectionActive
    ? t('statusline-hint-select')
    : channel.working
      ? t('statusline-hint-working')
      : statusBar.shortcutHint && !helpOpen
        ? t('statusline-hint-shortcuts')
        : ''
  const activity = channel.workingActivity
  const showActivity =
    statusBar.activity &&
    !channel.working &&
    activity !== undefined &&
    activity.line !== '' &&
    activity.phase !== 'idle'
  const showTrajectory = statusBar.trajectory && wake !== undefined

  const barWidth = columns - 4
  let bar: string | null = null
  const barColors =
    themeName === 'light'
      ? undefined
      : { freeFill: '#2E3440', freeText: '#8D95A6' }
  if (
    statusBar.contextBar &&
    channel.contextBarEnabled &&
    barWidth >= 14 &&
    usage !== undefined &&
    channel.contextWindow !== undefined
  ) {
    bar = renderContextBar(
      channel.contextSegments,
      contextUsed ?? 0,
      channel.contextWindow,
      barWidth,
      barColors,
    )
  }

  const compactLeftParts = [...leftParts, ...rightParts]
  const fullLeftParts = contextUsagePart === undefined
    ? leftParts
    : [...leftParts, contextUsagePart]
  const hasStatusFields = compactLeftParts.length > 0 || contextUsagePart !== undefined
  const showSupplementalRow = hint !== '' || showActivity || showTrajectory

  return (
    // Width is pinned to the terminal rather than inherited: `width="100%"`
    // resolves against the *parent's* width, and the bottom chrome this sits
    // in is sized by cross-axis stretch, not by a definite value. Where that
    // resolution comes back indefinite the column falls to content width — the
    // context bar (a string sized from `columns`) still spans the terminal
    // while the two flex rows under it stop short, truncating the session
    // title mid-word and leaving the right-aligned wake stranded mid-line.
    // Taking the width from the same source the bar already uses makes the
    // three rows agree by construction. verify-trace-scene part D walks a
    // ladder of widths and asserts the wake reaches the right margin at each.
    <Box paddingX={1} width={columns} flexShrink={0}>
      <Box flexDirection="column" width="100%">
        {/* Row 1: segmented context bar, its own line, first (pi-nano-context
            placement — the bar sits directly under the transcript). */}
        {bar ? <Text>{bar}</Text> : null}
        {/* Row 2: optional status fields — every field is independently gated. */}
        {hasStatusFields ? statusBar.compact ? (
          <Box flexDirection="row" justifyContent="space-between" gap={2}>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate">
                <Byline>{compactLeftParts}</Byline>
              </Text>
            </Box>
            {contextUsagePart ? (
              <Box flexShrink={0}>
                <Text wrap="truncate">
                  <Byline>{[contextUsagePart]}</Byline>
                </Text>
              </Box>
            ) : null}
          </Box>
        ) : (
          <Box flexDirection="row" justifyContent="space-between" gap={2}>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate">
                <Byline>{fullLeftParts}</Byline>
              </Text>
            </Box>
            <Box justifyContent="flex-end" flexShrink={2}>
              <Text wrap="truncate">
                <Byline>{rightParts}</Byline>
              </Text>
            </Box>
          </Box>
        ) : null}
        {/* Row 3: one stable hint/activity area plus an optional wake. */}
        {showSupplementalRow ? <Box
          height={1}
          overflow="hidden"
          flexDirection="row"
          justifyContent="space-between"
          gap={2}
        >
          <Box
            flexDirection="row"
            flexGrow={1}
            justifyContent={showActivity && hint ? 'space-between' : 'flex-start'}
            gap={2}
          >
            {showActivity && activity !== undefined ? (
              <ActivityLine
                activity={activity}
                activityFrames={channel.activityFrames}
                warnPct={contextPressurePct(usage, channel.contextWindow)}
                warnDanger={
                  (contextPressurePct(usage, channel.contextWindow) ?? 0) >= 95
                }
              />
            ) : hint ? (
              <Text color="inactiveShimmer">{hint}</Text>
            ) : null}
            {showActivity && hint ? (
              <Text color="inactiveShimmer" wrap="truncate">
                {hint}
              </Text>
            ) : null}
          </Box>
          {showTrajectory && wake !== undefined ? (
            <MiniWake band={wake.band} hint={wake.hint} tick={wake.tick} />
          ) : null}
        </Box> : null}
      </Box>
    </Box>
  )
}

type UsageSnapshot = {
  input: number
  cacheRead: number
  cacheWrite: number
}

/** Return the prompt-cache hit rate, or nothing when usage is unavailable. */
export function formatCacheHitRate(usage: UsageSnapshot | undefined): string | undefined {
  if (usage === undefined) return undefined
  const total = usage.input + usage.cacheRead + usage.cacheWrite
  if (!Number.isFinite(total) || total <= 0) return undefined
  return `${((usage.cacheRead / total) * 100).toFixed(1)}%`
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}
