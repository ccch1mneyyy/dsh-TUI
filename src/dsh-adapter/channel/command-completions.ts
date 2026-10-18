import { completeCommands, isCommandCompletionToken, type CommandCompletionNode } from '../../commands.js'
import { getSidePanelPanels, parseSidePanelIds } from '../../tuiDisplayPrefs.js'
import { SESSION_COLOR_NAMES } from '../../terminal-utils/sessionColors.js'
import { getLang, LANGS, t } from '../../i18n.js'
import { PERMISSION_PRESET_AUTO, permissionPresetKeys } from '../../permissionPresetLabels.js'
import { AUTO_THEME_NAME } from '../../theme.js'
import { listThemeCatalog } from '../../themeCatalog.js'
import { PRESET_NAMES } from '../../components/activityFrames.js'
import type { ChannelState } from './types.js'

/**
 * What a `/plugin install | info` spec may name — the same three shapes the
 * README lists, in the same order. A path and a git URL cannot be enumerated,
 * and `info` also takes a spec for a bundle that is not installed yet, so these
 * are shown as example rows rather than discovered candidates.
 */
const PLUGIN_SPEC_EXAMPLES: readonly {
  readonly spec: string
  readonly description: string
  readonly descriptionKey: string
}[] = [
  { spec: '/path/to/repo', description: 'Example: a local directory', descriptionKey: 'sugg-plugin-spec-path-desc' },
  { spec: 'https://github.com/exam/ple.git', description: 'Example: a git URL', descriptionKey: 'sugg-plugin-spec-git-desc' },
  { spec: '@scope/package@1.2.3', description: 'Example: a registry package, @version pins it', descriptionKey: 'sugg-plugin-spec-package-desc' },
]

/**
 * The spec shapes as completion rows for one `/plugin` form. They carry
 * `example` (`CommandCompletionNode`): Tab hands the draft back untouched and
 * Enter submits the draft as typed — the bare subcommand at the empty argument
 * position (its usage line), and the typed spec once there is one. A placeholder
 * spec can therefore neither be written into the draft nor installed by picking
 * its row, and a real spec that only starts like one is not swallowed.
 */
function pluginSpecExamples(): readonly CommandCompletionNode[] {
  return PLUGIN_SPEC_EXAMPLES.map(shape => ({
    name: shape.spec,
    description: shape.description,
    descriptionKey: shape.descriptionKey,
    example: true,
  }))
}

/** Owns slash completion composition and cache warming; it has no lifecycle effects. */
export function createCommandCompletions(deps: {
  state: () => ChannelState
  themeHost: Parameters<typeof listThemeCatalog>[0]
  commandTrees?: { children(path: readonly string[]): readonly CommandCompletionNode[] }
  workspaceCommands(): readonly { name: string; aliases?: readonly string[]; description?: string }[]
  /** The bound backend's MCP server names when it controls them
   *  (`/mcp reconnect|toggle`); undefined = `/mcp` takes no arguments. */
  mcpServers?(): readonly string[] | undefined
  /** `/plugin info <name>`: the profile's added bundles, warm-and-read. */
  plugin?: {
    warmPluginNames(): void
    pluginNames(): readonly CommandCompletionNode[]
  }
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
      if ('plugin'.startsWith(head)) deps.plugin?.warmPluginNames()
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
        if (snapshot.options.length > 0) {
          return snapshot.options.filter(option => isCommandCompletionToken(option.value)).map((option) => {
            const keys = permissionPresetKeys(option)
            return {
              name: option.value, description: option.description ?? option.name,
              ...(keys === undefined ? {} : { descriptionKey: keys.description }),
              ...(snapshot.current?.kind === 'preset' && snapshot.current.value === option.value
                ? { tag: 'current' }
                : option.value === PERMISSION_PRESET_AUTO ? { tag: t('permission-preset-exp-tag') } : {}),
            }
          })
        }
        // No preset roster (a non-DSH backend): the typed `modes` capability
        // is the roster. DSH sessions declare no such capability, so this
        // arm answers an empty list there and the roster above stands.
        const modes = state.backendModes()?.snapshot()
        if (modes === undefined) return []
        const currentId = modes.modes[modes.currentIndex]?.id
        return modes.modes.filter(mode => isCommandCompletionToken(mode.id)).map(mode => ({
          name: mode.id, description: mode.name,
          ...(mode.id === currentId ? { tag: 'current' } : {}),
        }))
      }
      if (path[0] === 'mcp' && state.backendMcp() !== undefined) {
        const servers = (deps.mcpServers?.() ?? []).filter(isCommandCompletionToken)
        if (path.length === 1) return [
          { name: 'reconnect', description: 'Reconnect an MCP server', descriptionKey: 'sugg-mcp-reconnect-desc' },
          { name: 'toggle', description: 'Turn an MCP server on or off', descriptionKey: 'sugg-mcp-toggle-desc' },
        ]
        if (path.length === 2 && (path[1] === 'reconnect' || path[1] === 'toggle')) return servers.map(name => ({ name, description: 'MCP server', descriptionKey: 'sugg-mcp-server-desc' }))
        if (path.length === 3 && path[1] === 'toggle' && servers.includes(path[2]!)) return [
          { name: 'on', description: 'Enable the server', descriptionKey: 'sugg-mcp-on-desc' },
          { name: 'off', description: 'Disable the server', descriptionKey: 'sugg-mcp-off-desc' },
        ]
        return []
      }
      if (path.length === 1 && path[0] === 'panel') return [
        { name: 'toggle', description: 'Toggle the sidebar', descriptionKey: 'sugg-panel-toggle-desc' },
        { name: 'focus', description: 'Focus the side panel', descriptionKey: 'sugg-panel-focus-desc' },
        { name: 'zoom', description: 'Zoom the active panel', descriptionKey: 'sugg-panel-zoom-desc' },
        ...parseSidePanelIds(getSidePanelPanels()).map(id => ({ name: id, description: `Open the ${id} panel`, descriptionKey: 'sugg-panel-id-desc' as const })),
      ]
      if (path.length === 1 && path[0] === 'plan') return [
        { name: 'on', description: 'Enter plan mode: read-only, plan before acting', descriptionKey: 'plan-mode-on-desc' },
        { name: 'off', description: 'Exit plan mode, back to normal execution', descriptionKey: 'plan-mode-off-desc' },
      ]
      // `/plugin`'s own forms. The subcommand list is static — it is what the
      // command accepts — while `info`'s argument is whatever the profile
      // actually holds (an absent service answers an empty list, never a throw).
      if (path.length === 1 && path[0] === 'plugin') return [
        { name: 'list', description: 'List the plugins this profile added', descriptionKey: 'sugg-plugin-list-desc' },
        { name: 'info', description: 'Describe an installed plugin or an install spec', descriptionKey: 'sugg-plugin-info-desc' },
        { name: 'install', description: 'Install a plugin bundle into this profile', descriptionKey: 'sugg-plugin-install-desc' },
        { name: 'remove', description: 'Uninstall a plugin bundle from this profile', descriptionKey: 'sugg-plugin-remove-desc' },
        { name: 'disable', description: 'Switch a plugin bundle or row off', descriptionKey: 'sugg-plugin-disable-desc' },
        { name: 'enable', description: 'Switch a plugin bundle or row back on', descriptionKey: 'sugg-plugin-enable-desc' },
        { name: 'registries', description: 'Show where installations ask', descriptionKey: 'sugg-plugin-registries-desc' },
        { name: 'check', description: 'Validate a plugin manifest without installing it', descriptionKey: 'sugg-plugin-check-desc' },
      ]
      // `/plugin install <spec>` takes a spec nothing local can enumerate, so
      // its argument position shows the shapes it accepts (`pluginSpecExamples`).
      if (path.length === 2 && path[0] === 'plugin' && path[1] === 'install') return pluginSpecExamples()
      // The three lifecycle forms take the same installed list as `info`: what
      // they act on is what the profile holds, and an absent service answers an
      // empty list rather than a throw.
      if (path.length === 2 && path[0] === 'plugin'
        && (path[1] === 'remove' || path[1] === 'enable' || path[1] === 'disable')) {
        deps.plugin?.warmPluginNames()
        return deps.plugin?.pluginNames() ?? []
      }
      // `info` reads an installed bundle OR a spec about to be installed, so it
      // offers both: what the profile holds first, then the spec shapes.
      if (path.length === 2 && path[0] === 'plugin' && path[1] === 'info') {
        deps.plugin?.warmPluginNames()
        return [...(deps.plugin?.pluginNames() ?? []), ...pluginSpecExamples()]
      }
      return commandTrees?.children(path) ?? []
    })
  }
}
