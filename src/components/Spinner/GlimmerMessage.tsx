import React from 'react'
import Text from '../design-system/ThemedText.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { getGraphemeSegmenter } from '../../utils/intl.js'
import { getTheme, type Theme } from '../../theme.js'
import type { SpinnerMode } from './spinnerMode.js'
import { interpolateColor, parseRGB, toRGBColor } from './spinnerUtils.js'
import { useTheme } from '../design-system/ThemeProvider.js'

type Props = {
  message: string
  mode: SpinnerMode
  messageColor: keyof Theme
  glimmerIndex: number
  flashOpacity: number
  shimmerColor: keyof Theme
  stalledIntensity?: number
}

const STALL_COLOR = { r: 198, g: 84, b: 101 }

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value))
}

/** The status message with a grapheme-safe, theme-aware moving highlight. */
export function GlimmerMessage({
  message,
  mode,
  messageColor,
  glimmerIndex,
  flashOpacity,
  shimmerColor,
  stalledIntensity = 0,
}: Props): React.ReactNode {
  const [themeName] = useTheme()
  const theme = getTheme(themeName)

  const segments = React.useMemo(() => {
    let start = 0
    const measured: { segment: string; width: number; start: number }[] = []
    for (const { segment } of getGraphemeSegmenter().segment(message)) {
      const width = stringWidth(segment)
      measured.push({ segment, width, start })
      start += width
    }
    return measured
  }, [message])

  if (!message) return null

  const baseRGB = parseRGB(theme[messageColor])
  const shimmerRGB = parseRGB(theme[shimmerColor])
  const intensity = clamp(stalledIntensity)

  if (intensity > 0) {
    const color = baseRGB
      ? toRGBColor(interpolateColor(baseRGB, STALL_COLOR, intensity))
      : intensity > 0.5
        ? 'error'
        : messageColor
    return (
      <>
        <Text color={color}>{message}</Text>
        <Text color={color}> </Text>
      </>
    )
  }

  if (!baseRGB || !shimmerRGB) {
    return (
      <>
        <Text color={messageColor}>{message}</Text>
        <Text color={messageColor}> </Text>
      </>
    )
  }

  // Tool feedback uses one gentle pulse. Other phases use a four-cell
  // triangular highlight centered on glimmerIndex, so wide graphemes receive
  // one color instead of being split in the middle of a display cell.
  if (mode === 'tool-use') {
    const color = toRGBColor(interpolateColor(baseRGB, shimmerRGB, clamp(flashOpacity)))
    return (
      <>
        <Text color={color}>{message}</Text>
        <Text color={color}> </Text>
      </>
    )
  }

  return (
    <>
      {segments.map(({ segment, width, start }) => {
        const center = start + width / 2
        const distance = Math.abs(center - (glimmerIndex + 2))
        const highlight = clamp(1 - distance / 4)
        const color = toRGBColor(interpolateColor(baseRGB, shimmerRGB, highlight * 0.85))
        return (
          <Text key={`${start}:${segment}`} color={color}>
            {segment}
          </Text>
        )
      })}
      <Text color={messageColor}> </Text>
    </>
  )
}
