import React, { useEffect, useRef, useState } from 'react'
import { useTerminalSize } from '../ink/hooks/use-terminal-size.js'
import { Box } from '../ui.js'
import type { SpinnerMode } from './Spinner/spinnerMode.js'
import { SpinnerAnimationRow } from './Spinner/SpinnerAnimationRow.js'
import { tOr } from '../i18n.js'
import { sample } from 'lodash-es'

/**
 * Which verbs fit which spinner phase: the working line's copy follows the
 * turn's stage (waiting → thinking → tools → responding) instead of one
 * random word for the whole turn — a phase change re-picks from its pool.
 * Words are the existing SPINNER_VERBS (i18n coverage), just bucketed.
 */
const VERBS_BY_MODE: Record<SpinnerMode, readonly string[]> = {
  requesting: ['Connecting', 'Preparing', 'Considering'],
  thinking: ['Thinking', 'Reasoning', 'Considering', 'Planning'],
  responding: ['Working', 'Responding', 'Building', 'Summarizing', 'Resolving', 'Testing'],
  'tool-use': ['Analyzing', 'Reading', 'Searching', 'Reviewing', 'Checking', 'Exploring'],
  'tool-input': ['Working', 'Responding'],
}

/**
 * The working spinner block shown between the transcript and the prompt
 * input while a turn is in flight. The channel feeds the mode, token count,
 * and thinking status while this component owns the compact presentation.
 *
 * A random verb is picked per phase (per mode change), so the copy tracks
 * what the turn is actually doing.
 */
export function WorkingSpinner({
  mode,
  hasActiveTools,
  responseLengthRef,
  uploadTokensRef,
  loadingStartTimeRef,
  totalPausedMsRef,
  pauseStartTimeRef,
  thinkingStatus,
  suffix,
}: {
  mode: SpinnerMode
  hasActiveTools: boolean
  responseLengthRef: React.RefObject<number>
  /** Most recent request's real upload tokens; 0 until the first usage event. */
  uploadTokensRef: React.RefObject<number>
  loadingStartTimeRef: React.RefObject<number>
  totalPausedMsRef: React.RefObject<number>
  pauseStartTimeRef: React.RefObject<number | null>
  thinkingStatus: 'thinking' | number | null
  /** Extra leading field (e.g. the auto-compaction badge) shown before the
   *  timer/token counters; omitted for an ordinary turn. */
  suffix?: string
}): React.ReactNode {
  const { columns } = useTerminalSize()

  // Pick a random verb from the current phase's pool; a phase change
  // re-picks (the copy mirrors the turn's stage).
  const [randomVerb, setRandomVerb] = useState(() => sample(VERBS_BY_MODE[mode]) ?? 'Working')
  useEffect(() => {
    setRandomVerb(sample(VERBS_BY_MODE[mode]) ?? 'Working')
  }, [mode])
  const message = `${tOr(`spinner-verb-${randomVerb.toLowerCase()}`, randomVerb)}…`

  return (
    <Box flexDirection="column" width="100%" alignItems="flex-start">
      <SpinnerAnimationRow
        mode={mode}
        reducedMotion={false}
        hasActiveTools={hasActiveTools}
        responseLengthRef={responseLengthRef}
        uploadTokensRef={uploadTokensRef}
        message={message}
        messageColor="accent"
        shimmerColor="accentShimmer"
        loadingStartTimeRef={loadingStartTimeRef}
        totalPausedMsRef={totalPausedMsRef}
        pauseStartTimeRef={pauseStartTimeRef}
        spinnerSuffix={suffix === undefined ? null : suffix}
        verbose
        columns={columns}
        thinkingStatus={thinkingStatus}
      />
    </Box>
  )
}

/**
 * Tracks thinking status: 'thinking' while the model is streaming reasoning,
 * then the duration in ms for a minimum 2s display (avoids UI jank).
 */
export function useThinkingStatus(
  isThinking: boolean,
): 'thinking' | number | null {
  const [thinkingStatus, setThinkingStatus] = useState<
    'thinking' | number | null
  >(null)
  const thinkingStartRef = useRef<number | null>(null)

  useEffect(() => {
    let showDurationTimer: ReturnType<typeof setTimeout> | null = null
    let clearStatusTimer: ReturnType<typeof setTimeout> | null = null

    if (isThinking) {
      // Started thinking
      if (thinkingStartRef.current === null) {
        thinkingStartRef.current = Date.now()
        setThinkingStatus('thinking')
      }
    } else if (thinkingStartRef.current !== null) {
      // Stopped thinking - calculate duration and ensure 2s minimum display
      const duration = Date.now() - thinkingStartRef.current
      const elapsed = Date.now() - thinkingStartRef.current
      const remainingThinkingTime = Math.max(0, 2000 - elapsed)

      thinkingStartRef.current = null

      // Show "thinking..." for remaining time if < 2s elapsed, then show duration
      const showDuration = (): void => {
        setThinkingStatus(duration)
        // Clear after 2s
        clearStatusTimer = setTimeout(() => setThinkingStatus(null), 2000)
      }

      if (remainingThinkingTime > 0) {
        showDurationTimer = setTimeout(showDuration, remainingThinkingTime)
      } else {
        showDuration()
      }
    }

    return () => {
      if (showDurationTimer) clearTimeout(showDurationTimer)
      if (clearStatusTimer) clearTimeout(clearStatusTimer)
    }
  }, [isThinking])

  return thinkingStatus
}
