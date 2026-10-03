/**
 * The Claude session's control capabilities (docs/agent-backend-design.md
 * §4.9–§4.10, §5.3–§5.4): model, effort, permission mode, compaction, the
 * CLI's own slash commands, MCP status, context usage and the account — each
 * a thin typed wrapper over the live `Query`'s control requests.
 *
 * Every write is confirmed the way the CLI reports it (the next
 * `message_start.model`, `system/status.permissionMode`, `compact_boundary`):
 * the wrappers emit the change as soon as the control request succeeds and
 * the translator's own tracking keeps later frames from repeating it.
 * The user's model / effort choice persists in `~/.dsh-tui` under a
 * backend-scoped key (never in Claude's settings files).
 */
import type { AccountInfo, McpServerStatus, ModelInfo, Query, SDKControlGetContextUsageResponse, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { AccountView, ContextUsageView, EffortOption, McpServerView, ModelOption, ModelRef, ModelSwitchOutcome, ModeOption, SessionCapabilities } from '../../agent/capabilities.js'
import type { AgentEvent, CommandInfo } from '../../agent/events.js'
import { t } from '../../i18n.js'
import type { ClaudePrefs } from './prefs.js'

/** Modes the Shift+Tab cycle offers, in order (`auto` only where supported;
 *  `bypassPermissions` and `dontAsk` never). */
const CYCLE: readonly string[] = ['default', 'acceptEdits', 'plan']

/** What the controls read from and write to the live session. */
export interface ClaudeControlsDeps {
  /** The live query (it changes when the session reconnects). */
  query(): Pick<Query, 'setModel' | 'setPermissionMode' | 'applyFlagSettings' | 'supportedModels' | 'supportedCommands' | 'mcpServerStatus' | 'reconnectMcpServer' | 'toggleMcpServer' | 'getContextUsage' | 'accountInfo'>
  /** Deliver events (model/mode/effort changes). */
  emit(events: readonly AgentEvent[]): void
  /** Push one user input (the `/compact` command text). */
  submitText(text: string): Promise<void>
  /** The model the session runs (translator's view). */
  currentModel(): string
  /** The backend-native permission mode (translator's view). */
  currentMode(): string
  /** Record a confirmed model / mode in the translator (dedupes later frames). */
  noteModel(model: string): readonly AgentEvent[]
  noteMode(mode: string): readonly AgentEvent[]
  readonly prefs: ClaudePrefs
  debug(message: string): void
}

/** The model catalog row a model id or alias selects. */
function rowOf(models: readonly ModelInfo[], id: string): ModelInfo | undefined {
  return models.find(model => model.value === id)
    ?? models.find(model => model.resolvedModel === id)
    ?? models.find(model => id.startsWith('claude-') && model.resolvedModel !== undefined && id.startsWith(model.resolvedModel))
}

/** Context usage → the neutral view (no free/buffer pseudo-categories as "used"). */
export function contextUsageView(usage: SDKControlGetContextUsageResponse): ContextUsageView {
  return {
    used: usage.totalTokens,
    max: usage.maxTokens,
    categories: usage.categories.map(category => ({ name: category.name, tokens: category.tokens, kind: category.kind })),
    sections: (usage.systemPromptSections ?? []).map(section => ({ name: section.name, tokens: section.tokens })),
    files: usage.memoryFiles.map(file => ({ path: file.path, tokens: file.tokens })),
    skills: (usage.skills?.skillFrontmatter ?? []).map(skill => ({ name: skill.name, tokens: skill.tokens })),
    tools: [
      ...(usage.systemTools ?? []).map(tool => ({ name: tool.name, tokens: tool.tokens })),
      ...usage.mcpTools.map(tool => ({ name: tool.name, tokens: tool.tokens, server: tool.serverName })),
    ],
  }
}

/** Account info → the neutral view (the email is never surfaced). */
export function accountView(info: AccountInfo, apiKeySource: string | undefined): AccountView {
  return {
    ...(info.organization === undefined ? {} : { organization: info.organization }),
    ...(info.subscriptionType === undefined ? {} : { subscription: info.subscriptionType }),
    ...(info.apiProvider === undefined ? {} : { provider: info.apiProvider }),
    ...(info.tokenSource === undefined ? {} : { tokenSource: info.tokenSource }),
    ...((info.apiKeySource ?? apiKeySource) === undefined ? {} : { apiKeySource: info.apiKeySource ?? apiKeySource }),
  }
}

/** Build the capabilities (catalogs seeded from the handshake by `seed`). */
export function createClaudeControls(deps: ClaudeControlsDeps) {
  let models: readonly ModelInfo[] = []
  let commands: readonly SlashCommand[] = []
  /** The TUI's own effort choice (the CLI reports none back in `init`). */
  let effort: string | undefined = deps.prefs.read().effort
  /** Terminal-only commands the CLI lists separately (never offered here). */
  let terminalOnly: ReadonlySet<string> = new Set()

  const currentRow = (): ModelInfo | undefined => rowOf(models, deps.currentModel())
  const refreshModels = async (): Promise<readonly ModelInfo[]> => {
    try {
      models = await deps.query().supportedModels()
    } catch (error) {
      deps.debug(`claude: supportedModels failed (${error instanceof Error ? error.message : String(error)})`)
    }
    return models
  }

  const modeList = (): readonly ModeOption[] => {
    const row = currentRow()
    const ids = row?.supportsAutoMode === true ? [...CYCLE, 'auto'] : [...CYCLE]
    // The live mode stays listed (and cyclable away from) even when the
    // cycle would not offer it — a session started in `dontAsk`, say.
    const current = deps.currentMode()
    if (current !== '' && !ids.includes(current)) ids.push(current)
    return ids.map(id => ({ id, label: modeLabel(id) }))
  }

  const capabilities = {
    models: {
      async list(): Promise<readonly ModelOption[]> {
        return (await refreshModels()).map(model => ({ id: model.value, label: model.displayName, description: model.description }))
      },
      current: (): ModelRef => ({ model: deps.currentModel() }),
      async set(ref: ModelRef): Promise<ModelSwitchOutcome> {
        const row = rowOf(models, ref.model) ?? rowOf(await refreshModels(), ref.model)
        if (row === undefined) return { kind: 'refused', reason: t('claude-model-unknown', { model: ref.model }) }
        // In place (no fork): the CLI applies it from the next request on.
        await deps.query().setModel(row.value)
        deps.prefs.write({ model: row.value })
        deps.emit(deps.noteModel(row.resolvedModel ?? row.value))
        // An effort the new model cannot run is cleared (the CLI would run
        // its default anyway; the readout must not claim otherwise). The
        // effort is kept only when the row still advertises it: the real
        // offline catalog serves Haiku rows with neither `supportsEffort`
        // nor a level list, and an old CLI may claim support without
        // listing levels — either way the picker offers nothing, so the
        // readout and the persisted pref must claim nothing either (no
        // hardcoded tiers; the pref can be set again on a model that
        // advertises levels).
        const levels = row.supportedEffortLevels as readonly string[] | undefined
        if (effort !== undefined && (row.supportsEffort === false || levels === undefined || levels.length === 0 || !levels.includes(effort))) {
          effort = undefined
          deps.prefs.write({ effort: null })
          deps.emit([{ type: 'effort.changed', effort: null }])
        }
        return { kind: 'switched' }
      },
    },
    effort: {
      levels(): readonly EffortOption[] {
        const row = currentRow()
        if (row !== undefined && row.supportsEffort === false) return []
        return (row?.supportedEffortLevels ?? []).map(level => ({ id: level, label: effortLabel(level) }))
      },
      current: (): string | undefined => effort,
      async set(id: string | null): Promise<void> {
        // `null` resets to the model's default level (applyFlagSettings
        // contract); a level is session-scoped in the flag layer.
        await deps.query().applyFlagSettings({ effortLevel: id as never })
        effort = id ?? undefined
        deps.prefs.write({ effort: id })
        deps.emit([{ type: 'effort.changed', effort: id }])
      },
    },
    modes: {
      list: modeList,
      current: (): string => deps.currentMode(),
      async set(id: string): Promise<void> {
        if (id === 'bypassPermissions') throw new Error(t('claude-mode-bypass-refused'))
        await deps.query().setPermissionMode(id as never)
        deps.emit(deps.noteMode(id))
      },
    },
    compact: {
      // The CLI's own `/compact` (design §4.11): the translator turns its
      // `compacting` status and `compact_boundary` into the compaction rows.
      run: (): Promise<void> => deps.submitText('/compact'),
    },
    commands: {
      async list(): Promise<readonly CommandInfo[]> {
        try {
          commands = await deps.query().supportedCommands()
        } catch (error) {
          deps.debug(`claude: supportedCommands failed (${error instanceof Error ? error.message : String(error)})`)
        }
        return commandInfos()
      },
    },
    mcp: {
      async status(): Promise<readonly McpServerView[]> {
        const servers: McpServerStatus[] = await deps.query().mcpServerStatus()
        return servers.map(server => ({ name: server.name, status: server.status, ...(server.tools === undefined ? {} : { toolCount: server.tools.length }) }))
      },
      reconnect: (name: string): Promise<void> => deps.query().reconnectMcpServer(name),
      toggle: (name: string, enabled: boolean): Promise<void> => deps.query().toggleMcpServer(name, enabled),
    },
    context: {
      async usage(detail: 'summary' | 'full'): Promise<ContextUsageView> {
        return contextUsageView(await deps.query().getContextUsage({ detail }))
      },
    },
  } satisfies Partial<SessionCapabilities>

  /** The CLI's commands as the slash menu lists them. */
  const commandInfos = (): readonly CommandInfo[] => commands
    .filter(command => !terminalOnly.has(command.name))
    .map(command => ({
      name: command.name,
      ...(command.description === '' ? {} : { description: command.description }),
      ...(command.argumentHint === '' ? {} : { argumentHint: command.argumentHint }),
    }))

  return {
    capabilities,
    commandInfos,
    /** The handshake's catalogs (`initializationResult().models/commands`),
     *  read without a round trip; malformed entries are skipped. */
    seed(init: Readonly<Record<string, unknown>> | undefined): void {
      const list = (value: unknown): readonly Readonly<Record<string, unknown>>[] => Array.isArray(value)
        ? value.filter((item): item is Readonly<Record<string, unknown>> => typeof item === 'object' && item !== null)
        : []
      models = list(init?.models).filter(row => typeof row.value === 'string' && typeof row.displayName === 'string') as unknown as ModelInfo[]
      commands = list(init?.commands).filter(row => typeof row.name === 'string') as unknown as SlashCommand[]
    },
    /** `system/init.terminal_slash_commands` (terminal-only, never offered). */
    setTerminalOnly(names: readonly string[]): void {
      terminalOnly = new Set(names)
    },
    /** The CLI said its commands changed: refresh and report the list. */
    async refreshCommands(): Promise<readonly CommandInfo[]> {
      return capabilities.commands.list()
    },
  }
}

/** The localized label of a backend-native permission mode. */
export function modeLabel(id: string): string {
  switch (id) {
    case 'default': return t('claude-mode-default')
    case 'acceptEdits': return t('claude-mode-acceptEdits')
    case 'plan': return t('claude-mode-plan')
    case 'auto': return t('claude-mode-auto')
    case 'dontAsk': return t('claude-mode-dontAsk')
    case 'bypassPermissions': return t('claude-mode-bypassPermissions')
    default: return id
  }
}

/** The localized label of an effort level. */
export function effortLabel(id: string): string {
  switch (id) {
    case 'low': return t('claude-effort-low')
    case 'medium': return t('claude-effort-medium')
    case 'high': return t('claude-effort-high')
    case 'xhigh': return t('claude-effort-xhigh')
    case 'max': return t('claude-effort-max')
    default: return id
  }
}
