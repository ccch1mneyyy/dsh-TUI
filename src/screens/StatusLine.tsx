import React from 'react'
import { Box, Text, useTerminalSize, useAnimationFrame } from '../ui.js'
import { formatTokens } from '../cc/format.js'
import { Byline } from '../components/design-system/Byline.js'
import { KeyboardShortcutHint } from '../components/design-system/KeyboardShortcutHint.js'
import { resolvePreset } from '../components/activityFrames.js'
import { BRAND, FLASH, ICE, sweep } from '../components/shimmer.js'
import { getTheme } from '../theme.js'
import { useTheme } from '../components/design-system/ThemeProvider.js'
import { parseRGB } from '../components/Spinner/spinnerUtils.js'
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
  // messages once samples exist) — no μ/p95 clutter.
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

  // Row 3: the mode hint — and, while dsh-working-activity publishes, the
  // live working line (thinking copy / running tool / turn summary) on the
  // left with the hint staying visible on the right. Phase colors: done
  // summaries land in success green, running tools in brand blue, waiting/
  // thinking in ice blue.
  const hint = selectionActive
    ? 'esc to return to input'
    : channel.working
      ? 'esc to interrupt'
      : !helpOpen
        ? '? for shortcuts'
        : ''
  const activity = channel.workingActivity
  const activityLine =
    activity !== undefined && activity.line !== '' && activity.phase !== 'idle'
      ? activity.line
      : undefined
  const activityColor =
    activity?.phase === 'done'
      ? 'success'
      : activity?.phase === 'tool'
        ? 'claude'
        : 'claudeBlue_FOR_SYSTEM_SPINNER'

  // Animated working line (pi working-activity style): the indicator preset
  // ticks on its own cadence and the line text carries a white shimmer
  // sweep. Both share the same animation clock, driven by the ref below.
  const [animationRef, time] = useAnimationFrame(200)
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const preset = React.useMemo(
    () => resolvePreset(channel.activityFrames),
    [channel.activityFrames],
  )
  const frameIndex = Math.floor(time / preset.intervalMs) % preset.frames.length
  const frame = preset.frames[frameIndex] ?? '·'
  const baseRGB =
    activity?.phase === 'tool'
      ? (parseRGB(theme.claude) ?? BRAND)
      : (parseRGB(theme.claudeBlue_FOR_SYSTEM_SPINNER) ?? ICE)
  const phase = activity?.phase

  // Context pressure prefix (pi working-activity style): ⚠ 上下文N% · in
  // amber ≥80%, red ≥95% — only while the working line is visible.
  const occupied =
    usage !== undefined ? usage.input + usage.cacheRead + usage.cacheWrite : 0
  const contextPct =
    activityLine !== undefined &&
    channel.contextWindow !== undefined &&
    channel.contextWindow > 0
      ? Math.round((occupied / channel.contextWindow) * 100)
      : undefined
  const warnDanger = contextPct !== undefined && contextPct >= 95
  const warnVisible = contextPct !== undefined && contextPct >= 80

  const barWidth = columns - 4
  let bar: string | null = null
  if (barWidth >= 14 && channel.contextWindow !== undefined) {
    bar = renderContextBar(
      channel.contextSegments,
      occupied,
      channel.contextWindow,
      barWidth,
    )
  }

  return (
    <Box paddingX={2} ref={animationRef}>
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
        {/* Row 3: animated working-activity line (indicator + shimmer text +
            context warning) with the mode hint staying visible on the right. */}
        <Box
          height={1}
          overflow="hidden"
          flexDirection="row"
          justifyContent="space-between"
          gap={2}
        >
          {activityLine !== undefined ? (
            <Text wrap="truncate">
              {phase !== 'done' && (
                <Text color={activityColor}>{frame} </Text>
              )}
              {warnVisible && contextPct !== undefined && (
                <Text color={warnDanger ? 'error' : 'warning'}>
                  ⚠ 上下文{contextPct}% ·{' '}
                </Text>
              )}
              {phase === 'done' ? (
                <Text color={activityColor}>{activityLine}</Text>
              ) : (
                <Text>{sweep(activityLine, time, baseRGB, FLASH)}</Text>
              )}
            </Text>
          ) : hint ? (
            <Text color="inactiveShimmer">{hint}</Text>
          ) : null}
          {activityLine !== undefined && hint ? (
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
