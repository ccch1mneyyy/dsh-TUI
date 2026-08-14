import React from 'react'
import Text from '../../ink/components/Text.js'
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

const ERROR_RED = { r: 171, g: 43, b: 63 }

/**
 * The shimmering verb message next to the spinner glyph, ported from the
 * leak's `Spinner/GlimmerMessage.tsx`.
 */
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

  // Precompute grapheme segmentation + widths once per message instead of
  // per animation frame (the original component re-renders at ~20fps).
  const { segments } = React.useMemo(() => {
    const segs: { segment: string; width: number }[] = []
    for (const { segment } of getGraphemeSegmenter().segment(message)) {
      segs.push({ segment, width: stringWidth(segment) })
    }
    return { segments: segs }
  }, [message])

  if (!message) return null

  // When stalled, show text that smoothly transitions to red
  if (stalledIntensity > 0) {
    const baseColorStr = theme[messageColor]
    const baseRGB = baseColorStr ? parseRGB(baseColorStr) : null

    if (baseRGB) {
      const interpolated = interpolateColor(baseRGB, ERROR_RED, stalledIntensity)
      const color = toRGBColor(interpolated)
      return (
        <>
          <Text color={color}>{message}</Text>
          <Text color={color}> </Text>
        </>
      )
    }

    // Fallback for ANSI themes: use messageColor until fully stalled, then error
    const color = stalledIntensity > 0.5 ? 'error' : messageColor
    return (
      <>
        <Text color={color}>{message}</Text>
        <Text color={color}> </Text>
      </>
    )
  }

  // tool-use mode: all chars flash with the same opacity, so render as a
  // single <Text> instead of N individual FlashingChar components.
  if (mode === 'tool-use') {
    const baseColorStr = theme[messageColor]
    const shimmerColorStr = theme[shimmerColor]
    const baseRGB = baseColorStr ? parseRGB(baseColorStr) : null
    const shimmerRGB = shimmerColorStr ? parseRGB(shimmerColorStr) : null

    if (baseRGB && shimmerRGB) {
      const interpolated = interpolateColor(baseRGB, shimmerRGB, flashOpacity)
      const color = toRGBColor(interpolated)
      return (
        <>
          <Text color={color}>{message}</Text>
          <Text color={color}> </Text>
        </>
      )
    }
    // Fallback for ANSI themes: render without flash animation
    return (
      <>
        <Text color={messageColor}>{message}</Text>
        <Text color={messageColor}> </Text>
      </>
    )
  }

  // Shimmer: a highlight sweeps across the message text
  const baseColorStr = theme[messageColor]
  const shimmerColorStr = theme[shimmerColor]
  const baseRGB = baseColorStr ? parseRGB(baseColorStr) : null
  const shimmerRGB = shimmerColorStr ? parseRGB(shimmerColorStr) : null

  if (!baseRGB || !shimmerRGB) {
    // Fallback for ANSI themes: render without shimmer animation
    return (
      <>
        <Text color={messageColor}>{message}</Text>
        <Text color={messageColor}> </Text>
      </>
    )
  }

  return (
    <>
      {segments.map(({ segment, width }, index) => {
        let charStart = 0
        for (let i = 0; i < index; i++) charStart += segments[i]!.width

        // Character is highlighted if it falls within the glimmer window
        const isHighlighted =
          glimmerIndex >= 0 &&
          charStart >= glimmerIndex &&
          charStart + width <= glimmerIndex + 4

        const color = isHighlighted
          ? toRGBColor(interpolateColor(baseRGB, shimmerRGB, flashOpacity))
          : messageColor

        return (
          <Text key={index} color={color}>
            {segment}
          </Text>
        )
      })}
      <Text color={messageColor}> </Text>
    </>
  )
}
