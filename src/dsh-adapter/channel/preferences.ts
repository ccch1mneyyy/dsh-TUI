import { setMinimalMode } from '../../minimalMode.js'
import { normalizePageMargin, normalizeScrollGutter, normalizeStatusBar, normalizeToolBackground, type StatusBarConfig } from '../../tuiDisplayPrefs.js'
import type { ChannelState } from '../channel/types.js'

export function createPreferences(getState: () => Pick<ChannelState, 'diffLayout' | 'thinkingFold' | 'toolBackground' | 'scrollGutter' | 'pageMargin' | 'foldTerminalCommand' | 'promptSessionLabel' | 'expandEditor' | 'smoothStreaming' | 'statusBar' | 'whale' | 'whaleIdle' | 'minimal' | 'emit'>): Pick<ChannelState, 'setDiffLayout' | 'setThinkingFold' | 'setToolBackground' | 'setScrollGutter' | 'setPageMargin' | 'setFoldTerminalCommand' | 'setPromptSessionLabel' | 'setExpandEditor' | 'setSmoothStreaming' | 'setStatusBar' | 'setWhale' | 'setWhaleIdle' | 'setMinimal'> {
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

    setMinimal(enabled) {
      const state = getState()
      setMinimalMode(enabled)
      if (enabled === state.minimal) return
      state.minimal = enabled
      state.emit()
    }
  }
}
