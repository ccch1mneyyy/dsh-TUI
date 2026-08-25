/**
 * Permanent prompt border and the single owner of effort-ignition timing.
 * Named supported tiers animate only on an actual prop transition; cold mounts
 * and repeated values stay idle, while leaving a supported tier cancels now.
 */
import React, { useContext, useEffect, useReducer, useState } from 'react'
import { Box, Text, useTheme } from '../ui.js'
import { ClockContext } from '../ink/components/ClockContext.js'
import type { Color } from '../ink/styles.js'
import { stringWidth } from '../ink/stringWidth.js'
import { getTheme, type Theme } from '../theme.js'
import {
  effortIgnitionStyle,
  IGNITION_TIMELINE,
  ignitionLineColors,
  type EffortIgnitionStyle,
} from '../trajectory/effortIgnition.js'
import { EffortIgnitionContext, type EffortIgnitionFrame } from './EffortIgnitionContext.js'
import { effortBand, effortTheme } from './effort-theme.js'

type Overlay = { label: string; style: EffortIgnitionStyle; startedAtMs: number }

/** A static chip on the top border row (the session label, CC-style). */
export interface InputBorderLabel {
  text: string
  color: keyof Theme | Color
  ink: keyof Theme | Color
}

function BorderRow({
  left,
  right,
  runs,
  idleColor,
  label,
}: {
  left: string
  right: string
  runs: ReadonlyArray<{ glyph: string; color: keyof Theme | Color }>
  idleColor: keyof Theme | Color
  label?: InputBorderLabel
}): React.ReactNode {
  const labelWidth = label === undefined ? 0 : stringWidth(` ${label.text} `)
  const labelGap = label === undefined ? 0 : 2
  let budget = Math.max(0, runs.reduce((sum, run) => sum + run.glyph.length, 0) - labelWidth - labelGap)
  const clipped: Array<{ glyph: string; color: keyof Theme | Color }> = []
  for (const run of runs) {
    if (budget <= 0) break
    const take = Math.min(run.glyph.length, budget)
    if (take > 0) clipped.push({ glyph: run.glyph.slice(0, take), color: run.color })
    budget -= take
  }
  return (
    <Box width="100%" height={1} flexShrink={0} overflow="hidden">
      <Text wrap="truncate-end">
        <Text color={idleColor}>{left}</Text>
        {clipped.map((run, i) => (
          <Text key={i} color={run.color}>
            {run.glyph}
          </Text>
        ))}
        {label !== undefined && (
          <Text backgroundColor={label.color} color={label.ink}>{` ${label.text} `}</Text>
        )}
        {label !== undefined && <Text color={idleColor}>{'─'.repeat(labelGap)}</Text>}
        <Text color={idleColor}>{right}</Text>
      </Text>
    </Box>
  )
}

export function EffortInputBorder({
  effort,
  levels,
  columns,
  onLight,
  idleColor,
  topRightLabel,
  children,
}: {
  effort: string | undefined
  levels: readonly string[] | undefined
  columns: number
  onLight: boolean
  idleColor: keyof Theme | Color
  topRightLabel?: InputBorderLabel
  children: React.ReactNode
}): React.ReactNode {
  const clock = useContext(ClockContext)
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const palette = effortTheme(theme, effortBand(theme, idleColor))
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [previous, setPrevious] = useState(effort)
  const [, render] = useReducer((tick: number) => tick + 1, 0)

  if (effort !== previous) {
    setPrevious(effort)
    const style = effortIgnitionStyle(effort)
    const offered = effort !== undefined && levels?.includes(effort) === true
    if (clock !== null && offered && style !== undefined) {
      setOverlay({ label: effort.toUpperCase(), style, startedAtMs: clock.now() })
    } else if (overlay !== null) {
      setOverlay(null)
    }
  }

  const elapsedMs = overlay === null ? Infinity : Math.max(0, (clock?.now() ?? Date.now()) - overlay.startedAtMs)
  const active = overlay !== null && elapsedMs < IGNITION_TIMELINE.fadeEndMs
  useEffect(() => {
    if (!active || clock === null) return
    return clock.subscribe(() => render(), true)
  }, [active, clock])
  useEffect(() => {
    if (overlay !== null && elapsedMs >= IGNITION_TIMELINE.fadeEndMs) setOverlay(null)
  }, [overlay, elapsedMs])

  const midWidth = Math.max(0, columns - 2)
  const sweepColors =
    active && midWidth > 0
      ? ignitionLineColors({ elapsedMs, width: midWidth, onLight, style: overlay.style, effort: overlay.label, palette })
      : []
  const runs: Array<{ glyph: string; color: keyof Theme | Color }> = []
  for (let index = 0; index < midWidth; index++) {
    const color = sweepColors[index] as keyof Theme | Color | undefined ?? idleColor
    const last = runs[runs.length - 1]
    if (last !== undefined && last.color === color) last.glyph += '─'
    else runs.push({ glyph: '─', color })
  }
  const frame: EffortIgnitionFrame | null = active
    ? {
        label: overlay.label,
        style: overlay.style,
        elapsedMs,
        durationMs: IGNITION_TIMELINE.labelDurationMs,
      }
    : null

  return (
    <EffortIgnitionContext.Provider value={frame}>
      <Box
        flexDirection="column"
        alignItems="flex-start"
        justifyContent="flex-start"
        width="100%"
        flexShrink={0}
      >
        <BorderRow left="╭" right="╮" runs={runs} idleColor={idleColor} label={topRightLabel} />
        <Box flexShrink={0}>{children}</Box>
        <BorderRow left="╰" right="╯" runs={runs} idleColor={idleColor} />
      </Box>
    </EffortIgnitionContext.Provider>
  )
}
