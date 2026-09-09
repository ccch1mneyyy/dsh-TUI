import figures from 'figures'
import React, { useMemo, useRef } from 'react'
import { useAnimationFrame } from '../../ink/hooks/use-animation-frame.js'
import Box from '../../ink/components/Box.js'
import Text from '../design-system/ThemedText.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { formatDuration, formatNumber } from '../../terminal-utils/format.js'
import { getTheme, type Theme } from '../../theme.js'
import { Byline } from '../design-system/Byline.js'
import { GlimmerMessage } from './GlimmerMessage.js'
import { SpinnerGlyph } from './SpinnerGlyph.js'
import type { SpinnerMode } from './spinnerMode.js'
import { useStalledAnimation } from './useStalledAnimation.js'
import { interpolateColor, parseRGB, toRGBColor } from './spinnerUtils.js'
import { useTheme } from '../design-system/ThemeProvider.js'

const SEP_WIDTH = stringWidth(' · ')
const THINKING_BARE_WIDTH = stringWidth('thinking')
const SHOW_TOKENS_AFTER_MS = 30_000
const THINKING_DELAY_MS = 2800
const THINKING_PULSE_MS = 1800
const TOKEN_RESPONSE_MS = 220

function trianglePulse(time: number, period: number): number {
  if (period <= 0) return 0
  const phase = ((time % period) + period) % period / period
  return phase < 0.5 ? phase * 2 : 2 - phase * 2
}

function easeToward(current: number, target: number, elapsedMs: number, responseMs: number): number {
  if (elapsedMs <= 0) return current
  const amount = 1 - Math.exp(-elapsedMs / responseMs)
  return current + (target - current) * amount
}

export type SpinnerAnimationRowProps = {
  mode: SpinnerMode
  reducedMotion: boolean
  hasActiveTools: boolean
  /** Raw response length (chars) — feeds the animated token counter. */
  responseLengthRef: React.RefObject<number>
  /** Most recent request's real upload tokens (input + cache read/write);
   *  0 until the first usage event lands. */
  uploadTokensRef: React.RefObject<number>
  /** Stable within a turn. */
  message: string
  messageColor: keyof Theme
  shimmerColor: keyof Theme
  loadingStartTimeRef: React.RefObject<number>
  totalPausedMsRef: React.RefObject<number>
  pauseStartTimeRef: React.RefObject<number | null>
  spinnerSuffix?: string | null
  verbose: boolean
  columns: number
  /** 'thinking' while reasoning streams; number = duration (ms) after it ends. */
  thinkingStatus: 'thinking' | number | null
}

/**
 * The 50ms-animated portion of the working spinner. It owns
 * `useAnimationFrame(50)` and all values derived from the
 * animation clock (frame, glimmer, token counter animation, elapsed time,
 * stalled intensity, thinking shimmer).
 */
export function SpinnerAnimationRow({
  mode,
  reducedMotion,
  hasActiveTools,
  responseLengthRef,
  uploadTokensRef,
  message,
  messageColor,
  shimmerColor,
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  spinnerSuffix,
  verbose,
  columns,
  thinkingStatus,
}: SpinnerAnimationRowProps): React.ReactNode {
  const [viewportRef, time] = useAnimationFrame(reducedMotion ? null : 50)

  // === Elapsed time (wall-clock, derived from refs each frame) ===
  const now = Date.now()
  const elapsedTimeMs =
    pauseStartTimeRef.current !== null
      ? pauseStartTimeRef.current -
        loadingStartTimeRef.current -
        totalPausedMsRef.current
      : now - loadingStartTimeRef.current - totalPausedMsRef.current

  // === Animation derivations from `time` ===
  const currentResponseLength = responseLengthRef.current

  const { isStalled, stalledIntensity } = useStalledAnimation(
    time,
    currentResponseLength,
    hasActiveTools,
    reducedMotion,
  )
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const frame = reducedMotion ? 0 : Math.floor(time / 140)
  const glimmerPeriod = mode === 'requesting' ? 1600 : 2200
  const glimmerMessageWidth = useMemo(() => stringWidth(message), [message])
  const glimmerTravel = glimmerMessageWidth + 8
  const glimmerProgress = trianglePulse(time, glimmerPeriod)
  const leftToRight = mode === 'requesting'
  const glimmerIndex = reducedMotion
    ? -100
    : isStalled
      ? -100
      : leftToRight
        ? glimmerProgress * glimmerTravel - 4
        : (1 - glimmerProgress) * glimmerTravel - 4
  const flashOpacity =
    reducedMotion
      ? 0
      : mode === 'tool-use'
        ? trianglePulse(time, 720)
        : 0

  // === Token counter animation (smooth increment, driven by 50ms clock) ===
  const tokenCounterRef = useRef({ value: currentResponseLength, time })
  const tokenElapsed = Math.max(0, time - tokenCounterRef.current.time)
  tokenCounterRef.current.time = time
  tokenCounterRef.current.value = reducedMotion
    ? currentResponseLength
    : easeToward(
        tokenCounterRef.current.value,
        currentResponseLength,
        tokenElapsed,
        TOKEN_RESPONSE_MS,
      )
  const displayedResponseLength = Math.round(tokenCounterRef.current.value)
  const leaderTokens = Math.round(displayedResponseLength / 4)
  const timerText = formatDuration(elapsedTimeMs)
  const timerWidth = stringWidth(timerText)

  const tokenCount = formatNumber(leaderTokens)
  const uploadTokens = uploadTokensRef.current
  // Real upload tokens (last request's input + cache) ride beside the
  // animated download estimate; both labeled once to keep the row short.
  const tokensLabel = uploadTokens > 0
    ? `↑ ${formatNumber(uploadTokens)} · ↓ ${tokenCount} tokens`
    : `↓ ${tokenCount} tokens`
  const tokensWidth = stringWidth(tokensLabel)

  // === Thinking text (may shrink to fit) ===
  let thinkingText =
    thinkingStatus === 'thinking'
      ? 'thinking'
      : typeof thinkingStatus === 'number'
        ? `thought for ${Math.max(1, Math.round(thinkingStatus / 1000))}s`
        : null
  let thinkingWidthValue = thinkingText ? stringWidth(thinkingText) : 0

  // === Progressive width gating ===
  const messageWidth = glimmerMessageWidth + 2
  const sep = SEP_WIDTH
  const wantsThinking = thinkingStatus !== null
  const wantsTimerAndTokens =
    verbose || elapsedTimeMs > SHOW_TOKENS_AFTER_MS
  const availableSpace = columns - messageWidth - 5
  let showThinking = wantsThinking && availableSpace > thinkingWidthValue
  if (!showThinking && wantsThinking && thinkingStatus === 'thinking') {
    if (availableSpace > THINKING_BARE_WIDTH) {
      thinkingText = 'thinking'
      thinkingWidthValue = THINKING_BARE_WIDTH
      showThinking = true
    }
  }
  const usedAfterThinking = showThinking ? thinkingWidthValue + sep : 0
  const showTimer =
    wantsTimerAndTokens && availableSpace > usedAfterThinking + timerWidth
  const usedAfterTimer = usedAfterThinking + (showTimer ? timerWidth + sep : 0)
  const showTokens =
    wantsTimerAndTokens &&
    (leaderTokens > 0 || uploadTokens > 0) &&
    availableSpace > usedAfterTimer + tokensWidth
  const thinkingOnly =
    showThinking &&
    thinkingStatus === 'thinking' &&
    !spinnerSuffix &&
    !showTimer &&
    !showTokens

  // === Thinking shimmer color ===
  const thinkingOpacity =
    time < THINKING_DELAY_MS
      ? 0
      : trianglePulse(time - THINKING_DELAY_MS, THINKING_PULSE_MS)
  const thinkingBase = parseRGB(theme[messageColor])
  const thinkingHighlight = parseRGB(theme[shimmerColor])
  const thinkingShimmerColor =
    thinkingBase && thinkingHighlight
      ? toRGBColor(interpolateColor(thinkingBase, thinkingHighlight, thinkingOpacity))
      : shimmerColor

  // === Build status parts ===
  const parts = [
    ...(spinnerSuffix
      ? [
          <Text dimColor key="suffix">
            {spinnerSuffix}
          </Text>,
        ]
      : []),
    ...(showTimer
      ? [
          <Text dimColor key="elapsedTime">
            {timerText}
          </Text>,
        ]
      : []),
    ...(showTokens
      ? [
          <Box flexDirection="row" key="tokens">
            <SpinnerModeGlyph mode={mode} />
            <Text dimColor>{tokensLabel}</Text>
          </Box>,
        ]
      : []),
    ...(showThinking && thinkingText
      ? [
          thinkingStatus === 'thinking' && !reducedMotion ? (
            <Text key="thinking" color={thinkingShimmerColor}>
              {thinkingOnly ? `(${thinkingText})` : thinkingText}
            </Text>
          ) : (
            <Text dimColor key="thinking">
              {thinkingText}
            </Text>
          ),
        ]
      : []),
  ]

  const status =
    parts.length > 0 ? (
      thinkingOnly ? (
        <Byline>{parts}</Byline>
      ) : (
        <>
          <Text dimColor>(</Text>
          <Byline>{parts}</Byline>
          <Text dimColor>)</Text>
        </>
      )
    ) : null

  return (
    <Box
      ref={viewportRef}
      flexDirection="row"
      flexWrap="wrap"
      marginTop={1}
      width="100%"
    >
      <SpinnerGlyph
        frame={frame}
        messageColor={messageColor}
        stalledIntensity={stalledIntensity}
        reducedMotion={reducedMotion}
        time={time}
      />
      <GlimmerMessage
        message={message}
        mode={mode}
        messageColor={messageColor}
        glimmerIndex={glimmerIndex}
        flashOpacity={flashOpacity}
        shimmerColor={shimmerColor}
        stalledIntensity={stalledIntensity}
      />
      {status}
    </Box>
  )
}

function SpinnerModeGlyph({ mode }: { mode: SpinnerMode }): React.ReactNode {
  switch (mode) {
    case 'tool-input':
    case 'tool-use':
    case 'responding':
    case 'thinking':
      return (
        <Box width={2}>
          <Text dimColor>{figures.arrowDown}</Text>
        </Box>
      )
    case 'requesting':
      return (
        <Box width={2}>
          <Text dimColor>{figures.arrowUp}</Text>
        </Box>
      )
  }
}
