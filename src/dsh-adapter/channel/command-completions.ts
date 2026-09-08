import { completeCommands, isCommandCompletionToken, type CommandCompletionNode } from '../../commands.js'
import { SESSION_COLOR_NAMES } from '../../terminal-utils/sessionColors.js'
import { getLang, LANGS } from '../../i18n.js'
import { AUTO_THEME_NAME } from '../../theme.js'
import { listThemeCatalog } from '../../themeCatalog.js'
import { PRESET_NAMES } from '../../components/activityFrames.js'
import type { ChannelState } from './types.js'

/** Owns slash completion composition and cache warming; it has no lifecycle effects. */
export function createCommandCompletions(deps: {
  state: () => ChannelState
  themeHost: Parameters<typeof listThemeCatalog>[0]
  commandTrees?: { children(path: readonly string[]): readonly CommandCompletionNode[] }
  workspaceCommands(): readonly { name: string; aliases?: readonly string[]; description?: string }[]
  model: {
    warmModelNodes(): void
    modelNodes(): readonly CommandCompletionNode[]
    warmPresetOptions(): void
    presetOptions(): readonly { id: string; description?: string; name?: string; isDefault?: boolean }[]
    warmEffortLevels(): void
  }
}) {
  const { themeHost, commandTrees, workspaceCommands, model } = deps
  return (input: string) => {
    const state = deps.state()
    const head = input.slice(1).split(/[\t ]/)[0]?.toLowerCase() ?? ''
    if (head !== '') {
      if ('model'.startsWith(head)) model.warmModelNodes()
      if ('preset'.startsWith(head)) model.warmPresetOptions()
      if ('effort'.startsWith(head)) model.warmEffortLevels()
    }
    return completeCommands(input, state.commandList, path => {
      if (path.length === 1 && path[0] === 'model') {
        model.warmModelNodes()
        return model.modelNodes()
      }
      if (path.length === 1 && path[0] === 'lang') return [
        { name: 'status', description: 'Show the current UI language', descriptionKey: 'sugg-status-desc' },
        ...LANGS.map(lang => ({ name: lang, description: `Switch the UI language to ${lang}`, descriptionKey: lang === 'zh' ? 'sugg-lang-zh-desc' : 'sugg-lang-en-desc', ...(getLang() === lang ? { tag: 'current' } : {}) })),
      ]
      if (path.length === 1 && path[0] === 'theme') return [
        { name: 'status', description: 'Show the current theme', descriptionKey: 'sugg-status-desc' },
        { name: AUTO_THEME_NAME, description: 'Follow the terminal background', descriptionKey: 'sugg-theme-auto-desc' },
        ...listThemeCatalog(themeHost).filter(entry => entry.name !== AUTO_THEME_NAME).map(entry => {
          const base = entry.base ?? 'dark'
          if (entry.source === 'builtin') return { name: entry.name, description: `Built-in theme ${entry.name}`, descriptionKey: 'sugg-theme-builtin-desc' }
          if (entry.source === 'runtime') return { name: entry.name, description: `Plugin theme (${base} base)`, descriptionKey: 'sugg-theme-plugin-desc' }
          return { name: entry.name, description: `User theme (${base} base)`, descriptionKey: 'sugg-theme-user-desc' }
        }),
      ]
      if (path.length === 1 && path[0] === 'color') return [
        { name: 'status', description: 'Show the current session color', descriptionKey: 'sugg-status-desc' },
        { name: 'reset', description: 'Clear the session color', descriptionKey: 'sugg-color-reset-desc' },
        ...SESSION_COLOR_NAMES.map(name => ({ name, description: 'Session accent color', descriptionKey: 'sugg-color-name-desc', ...(state.sessionColor === name ? { tag: 'current' } : {}) })),
      ]
      if (path.length === 1 && path[0] === 'effort') {
        model.warmEffortLevels()
        return [{ name: 'status', description: 'Show the current reasoning effort', descriptionKey: 'sugg-status-desc' }, ...(state.effortLevels ?? []).map(id => ({ name: id, description: 'Reasoning effort level', descriptionKey: 'sugg-effort-level-desc', ...(state.reasoningEffort === id ? { tag: 'current' } : {}) }))]
      }
      if (path.length === 1 && path[0] === 'preset') {
        model.warmPresetOptions()
        return [{ name: 'status', description: 'Show the current agent preset', descriptionKey: 'sugg-status-desc' }, ...model.presetOptions().map(preset => ({ name: preset.id, description: preset.description ?? preset.name ?? preset.id, ...(preset.id === state.agentPreset ? { tag: 'current' } : preset.isDefault ? { tag: 'default' } : {}) }))]
      }
      if (path.length === 1 && path[0] === 'activity') return [
        { name: 'status', description: 'Show the current activity preset', descriptionKey: 'sugg-status-desc' },
        { name: 'frames', description: 'List or switch frame presets', descriptionKey: 'sugg-activity-frames-desc' },
      ]
      if (path.length === 2 && path[0] === 'activity' && path[1] === 'frames') return PRESET_NAMES.map(name => ({ name, description: 'Animation frame preset', descriptionKey: 'sugg-activity-frame-desc', ...(state.activityFrames === name ? { tag: 'current' } : {}) }))
      if (path.length === 1 && path[0] === 'workspace') {
        const builtins: CommandCompletionNode[] = [
          { name: 'resume', description: 'Switch to another workspace', descriptionKey: 'cmd-desc-workspace-resume' },
          { name: 'rename', description: 'Rename the current workspace', descriptionKey: 'cmd-desc-workspace-rename' },
          { name: 'open', description: 'Open a path or workspace URI', descriptionKey: 'cmd-desc-workspace-open' },
        ]
        const reserved = new Set(builtins.map(command => command.name))
        return [...builtins, ...workspaceCommands().filter(command => !reserved.has(command.name.toLowerCase())).map(command => ({
          name: command.name,
          ...(command.aliases === undefined ? {} : { aliases: command.aliases }),
          description: command.description ?? '',
        }))]
      }
      if (path.length === 1 && path[0] === 'permission') {
        const snapshot = state.permissionPresets()
        return snapshot.options.filter(option => isCommandCompletionToken(option.value)).map(option => ({
          name: option.value, description: option.description ?? option.name,
          ...(option.value === 'read-only' ? { descriptionKey: 'permission-preset-readonly-desc' } : option.value === 'workspace-write' ? { descriptionKey: 'permission-preset-workspace-write-desc' } : option.value === 'danger-full-access' ? { descriptionKey: 'permission-preset-full-access-desc' } : {}),
          ...(snapshot.current?.kind === 'preset' && snapshot.current.value === option.value ? { tag: 'current' } : {}),
        }))
      }
      if (path.length === 1 && path[0] === 'plan') return [
        { name: 'on', description: 'Enter plan mode: read-only, plan before acting', descriptionKey: 'plan-mode-on-desc' },
        { name: 'off', description: 'Exit plan mode, back to normal execution', descriptionKey: 'plan-mode-off-desc' },
      ]
      return commandTrees?.children(path) ?? []
    })
  }
}
