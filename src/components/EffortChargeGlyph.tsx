/** Prompt prefix accent driven by EffortInputBorder's single timeline. */
import React, { useContext } from 'react'
import { Text, useTheme } from '../ui.js'
import type { Color } from '../ink/styles.js'
import {
  blendThemeColor,
  CHARGE_MS,
  chargeProgress,
  effortIgnitionStyle,
  ignitionAccents,
} from '../trajectory/effortIgnition.js'
import { getTheme } from '../theme.js'
import { EffortIgnitionContext } from './EffortIgnitionContext.js'
import { effortTheme } from './effort-theme.js'

export function EffortChargeGlyph({
  effort,
  levels,
  working,
}: {
  effort: string | undefined
  levels: readonly string[] | undefined
  working: boolean
}): React.ReactNode {
  const frame = useContext(EffortIgnitionContext)
  const [themeName] = useTheme()
  const active = effort !== undefined && levels?.includes(effort) === true && effortIgnitionStyle(effort) !== undefined
  if (!active) return <Text dimColor={working}>❯ </Text>

  const theme = getTheme(themeName)
  const palette = effortTheme(theme)
  const accent = ignitionAccents(effort, false, palette).at(-1) ?? theme.promptBorderShimmer
  const charging = frame !== null && frame.elapsedMs < CHARGE_MS
  const progress = charging ? chargeProgress(frame.elapsedMs) : 1
  const color = blendThemeColor(palette.band, accent, 0.45 + progress * 0.55) as Color
  return (
    <Text bold color={color} dimColor={working}>
      ❯{' '}
    </Text>
  )
}
