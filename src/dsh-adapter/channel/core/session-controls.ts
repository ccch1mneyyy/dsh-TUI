/**
 * Session-level facts a backend reports through its typed capabilities
 * (docs/agent-backend-design.md §4.9–4.10, §5.3–5.4): its native permission
 * mode, reasoning effort, own slash commands, subscription usage, and the
 * context / MCP reports the synchronous `/context` and `/mcp` read. The
 * shared projector owns the transcript; these are the facts it leaves to the
 * channel. A composition whose extension maintains these facts itself (the
 * DSH specialists) never installs the observer (`ownsSessionFacts`).
 */
import type { LocalCommand } from '../../../adapter/ports/channel-catalog.js'
import type { AgentEvent } from '../../../agent/events.js'
import type { AgentSession } from '../../../agent/session.js'
import { BACKEND_CHANNEL_COMMAND, BACKEND_PERMISSION_COMMAND, LOCAL_COMMANDS } from '../../../commands.js'
import { t } from '../../../i18n.js'
import { logForDebugging } from '../../../utils/debug.js'
import type { ChannelState } from '../types.js'

/** The built-in commands a capability snapshot serves, in catalog order. A
 *  snapshot serving every built-in keeps the catalog itself (identity).
 *  `permission` is not a LOCAL_COMMANDS name: it appears only when the
 *  snapshot appended it for the session's typed `modes` capability (see
 *  channel/capabilities.ts), and then rides as BACKEND_PERMISSION_COMMAND.
 *  `channel` follows the same ride-along for the typed `channels`
 *  capability (BACKEND_CHANNEL_COMMAND). */
export function localCommandsFor(names: readonly string[]): readonly LocalCommand[] {
  if (names.length === LOCAL_COMMANDS.length && LOCAL_COMMANDS.every((command, index) => command.name === names[index])) return LOCAL_COMMANDS
  const served = LOCAL_COMMANDS.filter(command => names.includes(command.name))
  const appended = [
    ...(names.includes('permission') ? [BACKEND_PERMISSION_COMMAND] : []),
    ...(names.includes('channel') ? [BACKEND_CHANNEL_COMMAND] : []),
  ]
  return appended.length === 0 ? served : [...served, ...appended]
}

const debugFailure = (what: string) => (error: unknown): void => {
  logForDebugging(`channel: ${what} failed (${error instanceof Error ? error.message : String(error)})`)
}

export function createSessionControls(deps: {
  state: () => ChannelState
  /** The user-facing backend name the backend's own commands are tagged with. */
  backendLabel(): string
}) {
  /** The backend's own commands, merged after the local ones. */
  let backendCommands: LocalCommand[] = []
  /** `/mcp` is synchronous: it reads the last report (refreshed per turn). */
  let mcpLines: string[] | undefined
  /** The servers of that report (`/mcp reconnect|toggle` completion). */
  let mcpNames: readonly string[] | undefined

  const refreshCommandList = (): void => {
    const state = deps.state()
    // Local names win, served here or not: a typed `/init` is the local
    // command (or its explicit unavailability), never the backend's.
    const local = new Set(LOCAL_COMMANDS.map(command => command.name))
    const served = localCommandsFor(state.backendCapabilities.commands)
    state.commandList = backendCommands.length === 0
      ? served
      : [...served, ...backendCommands.filter(command => !local.has(command.name))]
  }

  const loadBackendCommands = (session: AgentSession, current: () => boolean): void => {
    const commands = session.capabilities.commands
    if (commands === undefined) return
    void commands.list().then(list => {
      if (!current()) return
      backendCommands = list.map(command => ({
        name: command.name,
        description: command.description ?? '',
        tag: deps.backendLabel(),
        skill: true,
        origin: 'backend' as const,
      }))
      refreshCommandList()
      deps.state().emit()
    }).catch(debugFailure('backend commands'))
  }

  /** The native mode as the status line shows it: the base mode unmarked,
   *  any other one labelled by the backend (plan mode in its own colour). */
  const applyMode = (session: AgentSession, modeId: string): void => {
    const state = deps.state()
    const list = session.capabilities.modes?.list() ?? []
    const index = list.findIndex(mode => mode.id === modeId)
    state.mode = { id: `${session.ref.backendId}:${modeId}`, label: list[index]?.label ?? modeId, ...(modeId === 'plan' ? { plan: true } : {}) }
    state.modeIndex = index === 0 ? 0 : Math.max(1, index)
  }

  const applyEffort = (session: AgentSession, effort: string | null | undefined): void => {
    const state = deps.state()
    const levels = session.capabilities.effort?.levels() ?? []
    state.effortLevels = levels.length === 0 ? undefined : levels.map(level => level.id)
    state.reasoningEffort = effort ?? undefined
  }

  const refreshMcp = (session: AgentSession, current: () => boolean): void => {
    const mcp = session.capabilities.mcp
    if (mcp === undefined) return
    void mcp.status().then(servers => {
      if (!current()) return
      mcpNames = servers.map(server => server.name)
      mcpLines = servers.length === 0
        ? [t('claude-mcp-none')]
        : [
            t('claude-mcp-heading', { n: servers.length }),
            ...servers.map(server => t('claude-mcp-row', {
              name: server.name,
              status: server.status,
              tools: server.toolCount === undefined ? '' : t('claude-mcp-tools', { n: server.toolCount }),
            })),
            ...(servers.some(server => server.status === 'needs-auth') ? [t('claude-mcp-needs-auth')] : []),
          ]
    }).catch(debugFailure('mcp status'))
  }

  /** `/context` reads `loadedContext`: the backend's own measurement. */
  const refreshContext = (session: AgentSession, current: () => boolean): void => {
    const context = session.capabilities.context
    if (context === undefined) return
    void context.usage('summary').then(usage => {
      if (!current()) return
      const state = deps.state()
      const tokens = (n: number): string => t('claude-context-tokens', { n: n.toLocaleString() })
      // The summary report may carry no per-section split (the CLI answers
      // it from the last response's usage): the used categories stand in.
      const sections = usage.sections ?? []
      const used = usage.categories.filter(category => category.kind === 'used')
      state.loadedContext = {
        sections: (sections.length > 0 ? sections : used).map(item => ({ name: item.name, text: tokens(item.tokens) })),
        contexts: sections.length > 0 ? used.map(category => ({ name: category.name, text: tokens(category.tokens) })) : [],
        files: (usage.files ?? []).map(file => ({ displayPath: file.path.startsWith(`${state.cwd}/`) ? `./${file.path.slice(state.cwd.length + 1)}` : file.path })),
        skills: (usage.skills ?? []).map(skill => ({ name: skill.name, description: tokens(skill.tokens) })),
        tools: (usage.tools ?? []).map(tool => ({ name: tool.server === undefined ? tool.name : `${tool.server} › ${tool.name}`, description: tokens(tool.tokens) })),
      }
      if (state.contextWindow === undefined && usage.max !== undefined && usage.max > 0) state.contextWindow = usage.max
      state.emit()
    }).catch(debugFailure('context usage'))
  }

  /** A freshly bound session: read what it already knows. */
  const seed = (session: AgentSession, current: () => boolean): void => {
    backendCommands = []
    mcpLines = undefined
    mcpNames = undefined
    const modes = session.capabilities.modes
    if (modes !== undefined) applyMode(session, modes.current())
    if (session.capabilities.effort !== undefined) applyEffort(session, session.capabilities.effort.current())
    // Rebuild even when the backend exposes no commands capability of its
    // own: the capability snapshot may still append /permission for the
    // modes capability, and the first paint must offer it.
    refreshCommandList()
    loadBackendCommands(session, current)
    refreshMcp(session, current)
    refreshContext(session, current)
  }

  /**
   * Channel model truth: when the backend maps the live model id to the
   * model that actually serves the request (relay channels echo the
   * requested id back — backends/claude/modelEnv.ts), the footer shows the
   * mapped name. Data surfaces keep the raw id. Also the refresh path of a
   * channel-profile switch (/channel): the backend's truth read is lazy, so
   * re-running it after the store changed repaints the footer immediately.
   */
  const refreshModelDisplay = (session: AgentSession): void => {
    const state = deps.state()
    const display = session.capabilities.models?.display?.()
    state.modelDisplay = display !== undefined && display !== state.model ? display : undefined
  }

  /** The session-level events of one admitted batch. */
  const observe = (batch: readonly AgentEvent[], session: AgentSession, current: () => boolean): void => {
    let changed = false
    for (const event of batch) {
      switch (event.type) {
        case 'mode.changed':
          applyMode(session, event.modeId)
          changed = true
          break
        case 'effort.changed':
          applyEffort(session, event.effort)
          changed = true
          break
        case 'model.changed':
        case 'session.ready': {
          // Effort levels follow the model.
          if (event.type === 'model.changed' && session.capabilities.effort !== undefined) {
            applyEffort(session, session.capabilities.effort.current())
          }
          refreshModelDisplay(session)
          changed = true
          break
        }
        case 'commands.changed':
          loadBackendCommands(session, current)
          break
        case 'rate-limit':
          deps.state().rateLimit = { windows: event.info.windows }
          changed = true
          break
        case 'turn.end':
          refreshContext(session, current)
          refreshMcp(session, current)
          break
        default:
          break
      }
    }
    if (changed) deps.state().emit()
  }

  /** A session switch: forget the replaced session's commands and reports. */
  const reset = (): void => {
    backendCommands = []
    mcpLines = undefined
    mcpNames = undefined
    refreshCommandList()
  }

  return {
    seed,
    observe,
    reset,
    refreshCommandList,
    /** Re-resolve the channel model display now (the /channel switch path). */
    refreshModelDisplay,
    /** The last MCP report, refreshing it for next time (`/mcp` is synchronous). */
    mcpReport(session: AgentSession, current: () => boolean): string[] | undefined {
      refreshMcp(session, current)
      return mcpLines
    },
    /** The server names of the last report (undefined before one). */
    mcpServers: (): readonly string[] | undefined => mcpNames,
  }
}

export type SessionControls = ReturnType<typeof createSessionControls>
