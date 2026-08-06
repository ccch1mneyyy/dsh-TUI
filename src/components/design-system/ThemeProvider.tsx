import React, { createContext, useContext, useEffect, useState } from 'react'
import { setActiveThemeName, type ThemeName } from '../../theme.js'
import useStdin from '../../ink/hooks/use-stdin.js'
import { oscColor } from '../../ink/terminal-querier.js'
import { parseOscColor } from '../../ink/termio/osc.js'
import { logForDebugging } from '../../utils/debug.js'

/**
 * Theme provider with terminal-background auto-detection. With no explicit
 * `theme` prop (and no CC_TUI_THEME=light|dark override), it queries the
 * terminal's background color (OSC 11) before first paint and picks the
 * Gentle Mist Blue `light` palette on light backgrounds, `dark` otherwise.
 * Children render only after detection settles, so the first frame already
 * carries the final palette — no dark→light flash. Detection never blocks
 * boot: a terminal that ignores OSC 11 (or a 400ms stall) falls back to
 * `dark`. The resolved name is mirrored via setActiveThemeName() for
 * non-React rendering (markdown inline code).
 */
const ThemeContext = createContext<ThemeName>('dark')

/** CC_TUI_THEME=light|dark|dark-ansi skips terminal detection (tests, debugging). */
function envThemeOverride(): ThemeName | undefined {
  const v = process.env.CC_TUI_THEME
  return v === 'light' || v === 'dark' || v === 'dark-ansi' ? v : undefined
}

/** Detection round-trip is normally ~10ms locally; this only bounds pathological stalls. */
const DETECT_TIMEOUT_MS = 400

/**
 * sRGB luma (Rec. 601). The threshold biases dark: a light palette on a
 * dark terminal is far less readable than the reverse, and the dark
 * palette is the pre-detection status quo.
 */
function isLightBackground(r: number, g: number, b: number): boolean {
  return 0.299 * r + 0.587 * g + 0.114 * b > 140
}

export function ThemeProvider({
  children,
  theme,
}: {
  children: React.ReactNode
  theme?: ThemeName
}): React.ReactNode {
  const forced = theme ?? envThemeOverride()
  const [detected, setDetected] = useState<ThemeName | null>(forced ?? null)
  const { internal_querier, setRawMode, isRawModeSupported } = useStdin()

  useEffect(() => {
    if (forced !== undefined) return
    const querier = internal_querier
    // Stdin responses only flow while raw mode holds the readable listener;
    // without a querier (or raw-mode support) detection is impossible.
    if (querier === null || !isRawModeSupported) {
      logForDebugging('theme: detection unavailable (no querier/raw mode), using dark')
      setDetected('dark')
      return
    }
    let settled = false
    const finish = (name: ThemeName, why: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      setRawMode(false)
      logForDebugging(`theme: ${name} (${why})`)
      setDetected(name)
    }
    const timer = setTimeout(() => finish('dark', 'detection timeout'), DETECT_TIMEOUT_MS)
    setRawMode(true)
    void Promise.all([querier.send(oscColor(11)), querier.flush()]).then(([r]) => {
      const color = r ? parseOscColor(r.data) : null
      if (color === null || color.type !== 'rgb') {
        finish('dark', 'no OSC 11 reply')
      } else {
        finish(
          isLightBackground(color.r, color.g, color.b) ? 'light' : 'dark',
          `OSC 11 bg rgb(${color.r},${color.g},${color.b})`,
        )
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const active = forced ?? detected
  useEffect(() => {
    if (active !== null) setActiveThemeName(active)
  }, [active])

  if (active === null) return null
  return <ThemeContext.Provider value={active}>{children}</ThemeContext.Provider>
}

/** Resolves the active `ThemeName`. Returns `[themeName]` to match the leak's shape. */
export function useTheme(): [ThemeName] {
  return [useContext(ThemeContext)]
}
