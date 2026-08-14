import React from 'react'
import Text from '../../ink/components/Text.js'
import type { Color, Styles } from '../../ink/styles.js'
import { getTheme, type Theme } from '../../theme.js'
import { useTheme } from './ThemeProvider.js'

/**
 * Colors uncolored ThemedText in the subtree. Precedence: explicit `color` >
 * this > dimColor (ported from the leak's design-system, where message rows
 * set it to `text` on hover).
 */
export const TextHoverColorContext = React.createContext<
  keyof Theme | undefined
>(undefined)

/** Resolves a color value that may be a theme key to a raw Color. */
function resolveColor(
  color: keyof Theme | Color | undefined,
  theme: Theme,
): Color | undefined {
  if (!color) return undefined
  // Check if it's a raw color (starts with rgb(, #, ansi256(, or ansi:)
  if (
    color.startsWith('rgb(') ||
    color.startsWith('#') ||
    color.startsWith('ansi256(') ||
    color.startsWith('ansi:')
  ) {
    return color as Color
  }
  // It's a theme key - resolve it
  return theme[color as keyof Theme] as Color
}

export type Props = {
  /**
   * Change text color. Accepts a theme key or raw color value.
   */
  readonly color?: keyof Theme | Color

  /**
   * Same as `color`, but for background. Must be a theme key.
   */
  readonly backgroundColor?: keyof Theme

  /**
   * Dim the color using the theme's inactive color.
   * This is compatible with bold (unlike ANSI dim).
   */
  readonly dimColor?: boolean

  /**
   * Make the text bold.
   */
  readonly bold?: boolean

  /**
   * Make the text italic.
   */
  readonly italic?: boolean

  /**
   * Make the text underlined.
   */
  readonly underline?: boolean

  /**
   * Make the text crossed with a line.
   */
  readonly strikethrough?: boolean

  /**
   * Inverse background and foreground colors.
   */
  readonly inverse?: boolean

  /**
   * This property tells Ink to wrap or truncate text if its width is larger than container.
   */
  readonly wrap?: Styles['textWrap']

  readonly children?: React.ReactNode
}

/**
 * Theme-aware Text component that resolves theme color keys to raw colors
 * (ported from the leak's design-system). This is what lets every ported CC
 * component use `color="subtle"`-style theme keys unchanged.
 */
export default function ThemedText({
  color,
  backgroundColor,
  dimColor = false,
  bold = false,
  italic = false,
  underline = false,
  strikethrough = false,
  inverse = false,
  wrap = 'wrap',
  children,
}: Props): React.ReactNode {
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const hoverColor = React.useContext(TextHoverColorContext)

  // Resolve theme keys to raw colors
  const resolvedColor =
    !color && hoverColor
      ? (theme[hoverColor] as Color)
      : dimColor
        ? (theme.inactive as Color)
        : resolveColor(color, theme)
  const resolvedBackgroundColor = backgroundColor
    ? (theme[backgroundColor] as Color)
    : undefined

  return (
    <Text
      color={resolvedColor}
      backgroundColor={resolvedBackgroundColor}
      bold={bold}
      italic={italic}
      underline={underline}
      strikethrough={strikethrough}
      inverse={inverse}
      wrap={wrap}
    >
      {children}
    </Text>
  )
}
