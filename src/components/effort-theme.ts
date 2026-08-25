import type { Color } from '../ink/styles.js'
import type { Theme } from '../theme.js'
import type { EffortIgnitionPalette } from '../trajectory/effortIgnition.js'

/** Resolve a theme role or raw Ink colour without coercing ANSI/custom values. */
export function effortBand(theme: Theme, color: keyof Theme | Color): string {
  return Object.prototype.hasOwnProperty.call(theme, color)
    ? theme[color as keyof Theme]
    : color
}

/** Map the active concrete Theme palette onto the four effort animations. */
export function effortTheme(theme: Theme, band: string = theme.promptBorder): EffortIgnitionPalette {
  return {
    band,
    high: [theme.promptBorderShimmer, theme.claudeShimmer],
    xhigh: [theme.claudeBlueShimmer_FOR_SYSTEM_SPINNER, theme.permissionShimmer],
    max: [theme.warning, theme.warningShimmer],
    ultra: [
      theme.rainbow_red,
      theme.rainbow_orange,
      theme.rainbow_yellow,
      theme.rainbow_green,
      theme.rainbow_blue,
      theme.rainbow_indigo,
      theme.rainbow_violet,
    ],
  }
}
