import React from 'react'
import { Box, Text, useTerminalSize, useTheme } from '../ui.js'
import { formatTokens } from '../cc/format.js'
import { t } from '../i18n.js'
import { Byline } from '../components/design-system/Byline.js'
import { KeyboardShortcutHint } from '../components/design-system/KeyboardShortcutHint.js'
import { ActivityLine, contextPressurePct } from '../components/ActivityLine.js'
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
 * gauge/sparkline; right group: git · cwd · title, right-aligned), and the
 * mode/hint line last. The right side of the footer shows the latest
 * transient notification (errors in red, warnings in amber — CC style).
 */
export function StatusLine({
  channel,
  selectionActive = false,
  helpOpen = false,
  wake,
}: {
  channel: Channel
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

  const usage = channel.lastUsage
  const contextParts: React.ReactNode[] = []
  // Smart is an enhancement over the selected preset, so keep its state
  // visible without encoding it in the model-facing prompt.
  if (channel.smart) {
    contextParts.push(
      <Text key="enhancement" color="suggestion" bold>
        Smart
      </Text>,
    )
  }
  // Session-mode marker (Shift+Tab cycle): hidden on the unmarked base
  // mode (index 0); sage while a plan-declaring mode is in force.
  if (channel.modeIndex > 0) {
    contextParts.push(
      <Text
        key="mode"
        color={channel.mode.plan === true ? 'planMode' : 'warning'}
      >
        {modeDisplayName(channel.mode)}
      </Text>,
    )
  }
  if (channel.reasoningEffort !== undefined) {
    contextParts.push(
      <Text key="effort" color="inactiveShimmer">
        {channel.reasoningEffort}
      </Text>,
    )
  }
  if (usage !== undefined && usage.cacheRead > 0) {
    // Cache hit rate of the context fed to the model (read / total), one
    // decimal — the absolute read count lives in the context bar's system
    // segment, the rate is the glanceable health signal.
    const total = usage.input + usage.cacheRead + usage.cacheWrite
    const rate = total > 0 ? (usage.cacheRead / total) * 100 : 0
    contextParts.push(
      <Text key="cache">
        <Text dimColor>{t('status-cache-label')}</Text>
        <Text color="inactiveShimmer">{rate.toFixed(1)}%</Text>
      </Text>,
    )
  }
  // TPS readout sits right after the model so a crowded footer truncates
  // the trailing fields (tokens/think/cache), never the speedometer. One
  // number only: the live value (gauge while streaming, sparkline of past
  // turns once samples exist) — no μ/p95 clutter.
  const tpsParts: React.ReactNode[] = []
  if (channel.tps !== undefined) {
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

  // Left group: every field sits at soft white (inactiveShimmer) instead of
  // the previous uniform dim grey — readable against dark terminals.
  const leftParts = [
    <Text key="model" color="inactiveShimmer">
      {channel.model}
    </Text>,
    ...tpsParts,
    ...contextParts,
    <Text key="tokens" color="inactiveShimmer">
      {formatTokens(channel.tokens.input)}→{formatTokens(channel.tokens.output)}
    </Text>,
  ]

  // Right group: git branch in muted steel blue, cwd a soft white, the
  // session title dimmest (it truncates first anyway).
  const rightParts = [
    ...(channel.gitBranch
      ? [
          <Text key="git" color="professionalBlue">
            {channel.gitBranch}
          </Text>,
        ]
      : []),
    <Text key="cwd" color="inactiveShimmer">
      {basename(channel.displayCwd)}
    </Text>,
    ...(channel.sessionTitle
      ? [
          <Text key="title" dimColor>
            {channel.sessionTitle}
          </Text>,
        ]
      : []),
  ]

  // Row 3: the mode hint — and, while idle, the working-activity turn
  // summary (the live working line itself moves to the spinner slot above
  // the input while a turn runs, so the two never duplicate).
  const hint = selectionActive
    ? 'esc to return to input'
    : channel.working
      ? 'esc to interrupt'
      : !helpOpen
        ? '? for shortcuts'
        : ''
  const activity = channel.workingActivity
  const showActivity =
    !channel.working &&
    activity !== undefined &&
    activity.line !== '' &&
    activity.phase !== 'idle'

  const barWidth = columns - 4
  let bar: string | null = null
  // Theme-aware free segment: the light palette's near-white fill (#E8E8E8)
  // reads as a glaring white band on dark terminals — swap it for a deep
  // blue-gray there while keeping the light palette as-is (dark-ansi carries
  // `ansi:` color names, so map by theme name rather than palette tokens).
  const barColors =
    themeName === 'light'
      ? undefined
      : { freeFill: '#2E3440', freeText: '#8D95A6' }
  if (channel.contextBarEnabled && barWidth >= 14 && channel.contextWindow !== undefined) {
    bar = renderContextBar(
      channel.contextSegments,
      usage !== undefined ? usage.input + usage.cacheRead + usage.cacheWrite : 0,
      channel.contextWindow,
      barWidth,
      barColors,
    )
  }

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
    <Box paddingX={2} width={columns} flexShrink={0}>
      <Box flexDirection="column" width="100%">
        {/* Row 1: segmented context bar, its own line, first (pi-nano-context
            placement — the bar sits directly under the transcript). */}
        {bar ? <Text>{bar}</Text> : null}
        {/* Row 2: status fields — left group, tps, right group spread apart.
            The right group (git/cwd/title) shrinks twice as fast as the left
            so a long session title truncates before the metrics do. */}
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Text wrap="truncate">
            <Byline>{leftParts}</Byline>
          </Text>
          <Box justifyContent="flex-end" flexShrink={2}>
            <Text wrap="truncate">
              <Byline>{rightParts}</Byline>
            </Text>
          </Box>
        </Box>
        {/* Row 3: idle turn summary (ActivityLine) + mode hint on the right. */}
        <Box
          height={1}
          overflow="hidden"
          flexDirection="row"
          justifyContent="space-between"
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
          {wake !== undefined ? (
            <MiniWake band={wake.band} hint={wake.hint} tick={wake.tick} />
          ) : null}
        </Box>
      </Box>
    </Box>
  )
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}
