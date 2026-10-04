import { setMinimalUiMode } from '../../minimalUiMode.js'
import { normalizeSplashFont, type SplashFontSetting } from '../../components/splashFonts.js'
import { normalizeJobGroupFold, normalizePageMargin, normalizeScrollGutter, normalizeStatusBar, normalizeToolBackground, type JobGroupFoldMode, type StatusBarConfig } from '../../tuiDisplayPrefs.js'
import type { ChannelState } from '../channel/types.js'

/** The single minimal-UI write path: module store + channel field + one
 *  revision. `setMinimalUi` and its deprecated `setMinimal` alias share it. */
function applyMinimalUi(getState: () => Pick<ChannelState, 'minimalUi' | 'emit'>, enabled: boolean): void {
  const state = getState()
  setMinimalUiMode(enabled)
  if (enabled === state.minimalUi) return
  state.minimalUi = enabled
  state.emit()
}

export function createPreferences(getState: () => Pick<ChannelState, 'diffLayout' | 'thinkingFold' | 'jobGroupFold' | 'toolBackground' | 'scrollGutter' | 'pageMargin' | 'foldTerminalCommand' | 'turnUsageRow' | 'promptSessionLabel' | 'expandEditor' | 'smoothStreaming' | 'statusBar' | 'whale' | 'whaleIdle' | 'whaleGirl' | 'splashFont' | 'minimalUi' | 'emit'>): Pick<ChannelState, 'setDiffLayout' | 'setThinkingFold' | 'setJobGroupFold' | 'setToolBackground' | 'setScrollGutter' | 'setPageMargin' | 'setFoldTerminalCommand' | 'setTurnUsageRow' | 'setPromptSessionLabel' | 'setExpandEditor' | 'setSmoothStreaming' | 'setStatusBar' | 'setWhale' | 'setWhaleIdle' | 'setWhaleGirl' | 'setSplashFont' | 'setMinimalUi' | 'setMinimal'> {
  return {

    setDiffLayout(layout) {
      const state = getState()
      if (layout === state.diffLayout) return
      state.diffLayout = layout
      state.emit()
    },

    setThinkingFold(mode) {
      const state = getState()
      if (mode === state.thinkingFold) return
      state.thinkingFold = mode
      state.emit()
    },

    setJobGroupFold(mode) {
      const state = getState()
      const normalized = normalizeJobGroupFold(mode)
      if (normalized === state.jobGroupFold) return
      state.jobGroupFold = normalized
      state.emit()
    },

    setToolBackground(background) {
      const state = getState()
      const normalized = normalizeToolBackground(background)
      if (normalized === state.toolBackground) return
      state.toolBackground = normalized
      state.emit()
    },

    setScrollGutter(mode) {
      const state = getState()
      const normalized = normalizeScrollGutter(mode)
      if (normalized === state.scrollGutter) return
      state.scrollGutter = normalized
      state.emit()
    },

    setPageMargin(setting) {
      const state = getState()
      const normalized = normalizePageMargin(setting)
      if (normalized === state.pageMargin) return
      state.pageMargin = normalized
      state.emit()
    },

    setFoldTerminalCommand(enabled) {
      const state = getState()
      if (enabled === state.foldTerminalCommand) return
      state.foldTerminalCommand = enabled
      state.emit()
    },

    setTurnUsageRow(enabled) {
      const state = getState()
      if (enabled === state.turnUsageRow) return
      state.turnUsageRow = enabled
      state.emit()
    },

    setPromptSessionLabel(enabled) {
      const state = getState()
      if (enabled === state.promptSessionLabel) return
      state.promptSessionLabel = enabled
      state.emit()
    },

    setExpandEditor(enabled) {
      const state = getState()
      if (enabled === state.expandEditor) return
      state.expandEditor = enabled
      state.emit()
    },

    setSmoothStreaming(enabled) {
      const state = getState()
      if (enabled === state.smoothStreaming) return
      state.smoothStreaming = enabled
      state.emit()
    },

    setStatusBar(config) {
      const state = getState()
      const next = normalizeStatusBar({ ...state.statusBar, ...config })
      const changed = Object.keys(next).some(key =>
        next[key as keyof StatusBarConfig] !== state.statusBar[key as keyof StatusBarConfig],
      )
      if (!changed) return
      state.statusBar = next
      state.emit()
    },

    setWhale(visible) {
      const state = getState()
      if (visible === state.whale) return
      state.whale = visible
      state.emit()
    },

    setWhaleIdle(enabled) {
      const state = getState()
      if (enabled === state.whaleIdle) return
      state.whaleIdle = enabled
      state.emit()
    },

    setSplashFont(setting) {
      const state = getState()
      const normalized = normalizeSplashFont(setting)
      if (normalized === state.splashFont) return
      state.splashFont = normalized
      state.emit()
    },

    setWhaleGirl(enabled) {
      const state = getState()
      if (enabled === state.whaleGirl) return
      state.whaleGirl = enabled
      state.emit()
    },

    setMinimalUi(enabled) {
      applyMinimalUi(getState, enabled)
    },

    /** @deprecated Pre-rename alias of setMinimalUi (kept for plugin scenes
     *  and older embedders that call `channel.setMinimal()`). */
    setMinimal(enabled) {
      applyMinimalUi(getState, enabled)
    }
  }
}
