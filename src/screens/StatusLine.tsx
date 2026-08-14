import React from 'react'
import { Box, Text, useTerminalSize, useTheme } from '../ui.js'
import { formatTokens } from '../cc/format.js'
import { Byline } from '../components/design-system/Byline.js'
import { KeyboardShortcutHint } from '../components/design-system/KeyboardShortcutHint.js'
import { ActivityLine, contextPressurePct } from '../components/ActivityLine.js'
import type { Channel } from '../channel.js'
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
}: {
  channel: Channel
  selectionActive?: boolean
  helpOpen?: boolean
}) {
  const { columns } = useTerminalSize()
  const [themeName] = useTheme()

  const usage = channel.lastUsage
  const contextParts: React.ReactNode[] = []
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
        <Text dimColor>cache </Text>
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
      {basename(channel.cwd)}
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
    <Box paddingX={2}>
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
        </Box>
      </Box>
    </Box>
  )
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}
