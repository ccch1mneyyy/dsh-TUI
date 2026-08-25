/** Prompt prefix accent driven by EffortInputBorder's single timeline. */
import React, { useContext } from 'react'
import { Text, useTheme } from '../ui.js'
import { accentRamp, CHARGE_MS, chargeProgress, effortIgnitionStyle } from '../trajectory/effortIgnition.js'
import { rgbString } from '../trajectory/motion.js'
import { interpolateColor } from './Spinner/spinnerUtils.js'
import { isLightThemeActive } from '../theme.js'
import { EffortIgnitionContext } from './EffortIgnitionContext.js'

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

  const ramp = accentRamp(isLightThemeActive(themeName), effort)
  const charging = frame !== null && frame.elapsedMs < CHARGE_MS
  const color = charging
    ? rgbString(interpolateColor(ramp.dim, ramp.full, chargeProgress(frame.elapsedMs)))
    : rgbString(ramp.full)
  return (
    <Text bold color={color} dimColor={working}>
      ❯{' '}
    </Text>
  )
}
