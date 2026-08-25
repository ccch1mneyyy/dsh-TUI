/** Centered uppercase label driven by EffortInputBorder's single timeline. */
import React, { useContext } from 'react'
import { Text, useTheme } from '../ui.js'
import type { Color } from '../ink/styles.js'
import { getTheme, type Theme } from '../theme.js'
import {
  blendThemeColor,
  crest,
  ignitionAccents,
  IGNITION_TIMELINE,
  themeGradient,
} from '../trajectory/effortIgnition.js'
import { EffortIgnitionContext } from './EffortIgnitionContext.js'
import { effortTheme } from './effort-theme.js'

const LETTER_GAP = 1
const REVEAL_MS = 430

type BadgeTier = 'high' | 'xhigh' | 'max' | 'ultra'

function tier(effort: string): BadgeTier {
  switch (effort.toLowerCase()) {
    case 'xhigh':
      return 'xhigh'
    case 'max':
      return 'max'
    case 'ultra':
      return 'ultra'
    default:
      return 'high'
  }
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function reveal(progress: number, arrival: number): number {
  return clamp((progress - arrival * 0.65) / 0.35)
}

/** Per-letter ignition weights over 430ms: LTR, twin LTR peaks, inward, then outward. */
export function effortBadgeWeights(effort: string, count: number, progress: number): readonly number[] {
  const kind = tier(effort)
  const phase = clamp(progress)
  if (phase >= 1) return Array.from({ length: Math.max(0, count) }, () => 1)
  return Array.from({ length: Math.max(0, count) }, (_, index) => {
    const point = count <= 1 ? 0.5 : index / (count - 1)
    const distance = Math.abs(point - 0.5) * 2
    if (kind === 'high') return reveal(phase, point)
    if (kind === 'max') return reveal(phase, 1 - distance)
    if (kind === 'ultra') return reveal(phase, distance)
    const front = phase * 1.6 - 0.1
    const first = crest((point - front) / 0.18)
    const second = crest((point - (front - 0.38)) / 0.15)
    const settle = clamp((phase - 0.78) / 0.22)
    return Math.max(first, second, settle)
  })
}

/** Motion metadata for deterministic regression; rendering keeps fixed columns. */
export function effortBadgeGap(effort: string, progress: number): number {
  const phase = clamp(progress)
  switch (tier(effort)) {
    case 'max':
      return 1 - phase
    case 'ultra':
      return phase
    default:
      return 0
  }
}

function intensity(elapsedMs: number): number {
  const brighten = Math.min(1, elapsedMs / IGNITION_TIMELINE.labelBrightenMs)
  if (elapsedMs < IGNITION_TIMELINE.fadeStartMs) return brighten
  const fade = 1 - (elapsedMs - IGNITION_TIMELINE.fadeStartMs)
    / (IGNITION_TIMELINE.fadeEndMs - IGNITION_TIMELINE.fadeStartMs)
  return brighten * Math.max(0, fade)
}

function positions(
  label: string,
  columns: number,
  leadingColumns: number,
): readonly number[] {
  const center = Math.round((columns - 1) / 2) - leadingColumns
  return Array.from({ length: label.length }, (_, index) => {
    const offset = (index - (label.length - 1) / 2) * (1 + LETTER_GAP)
    return offset >= 0 ? Math.round(center + offset) : 2 * center - Math.round(center - offset)
  })
}

function effortBadgeColors(options: {
  label: string
  elapsedMs: number
  alpha: number
  onLight: boolean
  theme: Theme
}): readonly Color[] {
  const palette = effortTheme(options.theme)
  const accents = ignitionAccents(options.label, options.onLight, palette)
  const weights = effortBadgeWeights(options.label, options.label.length, options.elapsedMs / REVEAL_MS)
  return Array.from({ length: options.label.length }, (_, index) => {
    const point = options.label.length <= 1 ? 0 : index / (options.label.length - 1)
    const accent = themeGradient(accents, point) ?? accents[0]!
    return blendThemeColor(palette.band, accent, options.alpha * weights[index]!) as Color
  })
}

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
  const [themeName] = useTheme()
  if (
    frame === null
    || frame.elapsedMs < IGNITION_TIMELINE.labelStartMs
    || frame.elapsedMs >= frame.durationMs
  ) return null

  const elapsedMs = frame.elapsedMs - IGNITION_TIMELINE.labelStartMs
  const alpha = intensity(frame.elapsedMs)
  if (alpha <= 0) return null
  const at = positions(frame.label, columns, leadingColumns)
  const ink = effortBadgeColors({
    label: frame.label,
    elapsedMs,
    alpha,
    onLight,
    theme: getTheme(themeName),
  })

  const runs: React.ReactNode[] = []
  let column = 0
  for (let index = 0; index < frame.label.length; index++) {
    const gap = Math.max(0, at[index]! - column)
    if (gap > 0) runs.push(' '.repeat(gap))
    runs.push(
      <Text key={index} bold color={ink[index]}>
        {frame.label[index]}
      </Text>,
    )
    column = at[index]! + 1
  }
  return <Text wrap="truncate-end">{runs}</Text>
}
