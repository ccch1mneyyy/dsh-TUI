/** Centered uppercase label driven by EffortInputBorder's single timeline. */
import React, { useContext } from 'react'
import { Text } from '../ui.js'
import { rgbString } from '../trajectory/motion.js'
import type { RGBColor } from './Spinner/spinnerUtils.js'
import { effortIgnitionHue, IGNITION_TIMELINE } from '../trajectory/effortIgnition.js'
import { EffortIgnitionContext } from './EffortIgnitionContext.js'

const GAP_START = 10
const GAP_END = 1
const CONVERGE_MS = 500

export function EffortTierBadge({
  effort: _effort,
  levels: _levels,
  onLight,
  columns,
  leadingColumns,
}: {
  effort: string | undefined
  levels: readonly string[] | undefined
  onLight: boolean
  columns: number
  leadingColumns: number
}): React.ReactNode {
  const frame = useContext(EffortIgnitionContext)
  if (
    frame === null ||
    frame.elapsedMs < IGNITION_TIMELINE.labelStartMs ||
    frame.elapsedMs >= frame.durationMs
  ) return null

  const elapsedMs = frame.elapsedMs - IGNITION_TIMELINE.labelStartMs
  const brighten = Math.min(1, elapsedMs / IGNITION_TIMELINE.labelBrightenMs)
  const fade =
    frame.elapsedMs < IGNITION_TIMELINE.fadeStartMs
      ? 1
      : Math.max(
          0,
          1 -
            (frame.elapsedMs - IGNITION_TIMELINE.fadeStartMs) /
              (IGNITION_TIMELINE.fadeEndMs - IGNITION_TIMELINE.fadeStartMs),
        )
  const alpha = brighten * fade
  if (alpha <= 0) return null
  const band: RGBColor = onLight ? { r: 240, g: 240, b: 242 } : { r: 27, g: 30, b: 40 }
  const hue = effortIgnitionHue(frame.label, onLight)
  const whiten = (value: number): number => Math.round(value + (255 - value) * 0.35)
  const bright: RGBColor = { r: whiten(hue.r), g: whiten(hue.g), b: whiten(hue.b) }
  const mix = (from: number, to: number): number => Math.round(from + (to - from) * alpha)
  const color = rgbString({
    r: mix(band.r, bright.r),
    g: mix(band.g, bright.g),
    b: mix(band.b, bright.b),
  })

  const progress = Math.min(1, Math.max(0, elapsedMs / CONVERGE_MS))
  const eased = 1 - progress
  const easedWithFloor = 0.9 * eased + 0.1 * (1 - progress * progress)
  const gap = GAP_END + (GAP_START - GAP_END) * easedWithFloor
  const count = frame.label.length
  const center = Math.round((columns - 1) / 2) - leadingColumns
  let spaced = ''
  let column = 0
  for (let index = 0; index < count; index++) {
    const offset = (index - (count - 1) / 2) * (1 + gap)
    const at = offset >= 0 ? Math.round(center + offset) : 2 * center - Math.round(center - offset)
    spaced += ' '.repeat(Math.max(0, at - column)) + frame.label[index]!
    column = at + 1
  }
  return (
    <Text bold color={color} wrap="truncate-end">
      {spaced}
    </Text>
  )
}
