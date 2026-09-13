import { useRef } from 'react'

const QUIET_PERIOD_MS = 3000
const COLOR_RAMP_MS = 2000
const SMOOTHING_MS = 180

export type StallState = {
  isStalled: boolean
  intensity: number
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Derive the target stall state from elapsed output time and tool activity. */
export function getStallState(timeSinceOutput: number, hasActiveTools = false): StallState {
  if (hasActiveTools) return { isStalled: false, intensity: 0 }
  const quietFor = Math.max(0, timeSinceOutput)
  const isStalled = quietFor > QUIET_PERIOD_MS
  const intensity = isStalled
    ? clamp((quietFor - QUIET_PERIOD_MS) / COLOR_RAMP_MS)
    : 0
  return { isStalled, intensity }
}

/**
 * Track output silence from the parent's animation clock. The target color
 * changes linearly over the ramp, while the displayed value eases toward it
 * with a time-based response that remains stable if a frame is delayed.
 */
export function useStalledAnimation(
  time: number,
  currentResponseLength: number,
  hasActiveTools = false,
  reducedMotion = false,
): {
  isStalled: boolean
  stalledIntensity: number
} {
  const lastOutputTime = useRef(time)
  const lastResponseLength = useRef(currentResponseLength)
  const mountedAt = useRef(time)
  const displayedIntensity = useRef(0)
  const previousTime = useRef(time)

  if (currentResponseLength > lastResponseLength.current) {
    lastResponseLength.current = currentResponseLength
    lastOutputTime.current = time
  }

  const timeSinceOutput = currentResponseLength > 0
    ? time - lastOutputTime.current
    : time - mountedAt.current
  const state = getStallState(timeSinceOutput, hasActiveTools)
  const delta = Math.max(0, time - previousTime.current)
  previousTime.current = time

  if (reducedMotion || delta === 0) {
    displayedIntensity.current = state.intensity
  } else {
    const response = 1 - Math.exp(-delta / SMOOTHING_MS)
    displayedIntensity.current +=
      (state.intensity - displayedIntensity.current) * response
  }

  return {
    isStalled: state.isStalled,
    stalledIntensity: displayedIntensity.current,
  }
}
