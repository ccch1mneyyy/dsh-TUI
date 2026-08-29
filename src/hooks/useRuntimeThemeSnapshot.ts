import React from 'react'
import type { TuiThemeHost, TuiThemeRegistration } from '../dsh-adapter/themes.js'

const EMPTY_THEME_SNAPSHOT: readonly TuiThemeRegistration[] = Object.freeze([])
const subscribeNoThemes = (_listener: () => void): (() => void) => () => {}

/**
 * Subscribe to the optional runtime theme host and expose its registration
 * snapshot to React. Shared by ThemeProvider and ThemePicker so both observe
 * the same registrations with the same fallbacks: an absent host, a throwing
 * `subscribe`/`getSnapshot` (structural hosts, teardown races) degrade to an
 * empty snapshot instead of breaking the render path.
 */
export function useRuntimeThemeSnapshot(
  themeHost?: TuiThemeHost,
): readonly TuiThemeRegistration[] {
  const subscribeThemes = React.useCallback(
    (listener: () => void): (() => void) => {
      try {
        return themeHost?.subscribe(listener) ?? subscribeNoThemes(listener)
      } catch {
        return subscribeNoThemes(listener)
      }
    },
    [themeHost],
  )
  const getThemeSnapshot = React.useCallback((): readonly TuiThemeRegistration[] => {
    try {
      return themeHost?.getSnapshot() ?? EMPTY_THEME_SNAPSHOT
    } catch {
      return EMPTY_THEME_SNAPSHOT
    }
  }, [themeHost])
  // Runtime registrations can arrive after the first render (and disappear
  // during plugin teardown); use the host's stable snapshot to repaint without
  // changing the static/headless path.
  return React.useSyncExternalStore(subscribeThemes, getThemeSnapshot, getThemeSnapshot)
}
