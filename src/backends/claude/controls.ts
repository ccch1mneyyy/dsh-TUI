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
 * The user's model / effort / permission-mode choice persists in `~/.dsh-tui`
 * under a backend-scoped key (never in Claude's settings files).
 */
import type { AccountInfo, McpServerStatus, ModelInfo, Query, SDKControlGetContextUsageResponse, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { AccountView, ChannelProfileView, ContextUsageView, EffortOption, McpServerView, ModelOption, ModelRef, ModelSwitchOutcome, ModeOption, SessionCapabilities } from '../../agent/capabilities.js'
import type { AgentEvent, CommandInfo } from '../../agent/events.js'
import { t } from '../../i18n.js'
import { createHash } from 'node:crypto'
import { channelTokenRef, type ClaudeChannelTokens } from './channelTokens.js'
import { importFromSettingsEnv, importTokenFromSettingsEnv, hasChannelConnection, type ClaudeChannelProfile, type ClaudeChannels } from './channels.js'
import type { ClaudePrefs } from './prefs.js'

/** The fixed roster, in order, for the /permission picker: `bypassPermissions`
 *  is always listed — the SDK gate keeps it available at runtime (options.ts),
 *  so the user's explicit choice is honoured instead of being vetoed by the
 *  TUI — and `auto` only where the model's classifier supports it. `dontAsk`
 *  is never offered unless the session already runs in it. */
const ROSTER: readonly string[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

/** The Shift+Tab cycle surface, in order: the pre-bypass roster, verbatim.
 *  `bypassPermissions` is deliberately NOT here: Shift+Tab is a reflexive
 *  key (the user taps it repeatedly to move through modes), and one stray
 *  press landing in "all confirmations off" is unacceptable — bypass is
 *  entered only through the /permission picker's explicit, explained row.
 *  Declared as `modes.cycle()` so the narrowing lives in the capability
 *  layer, not as a mode name hardcoded in the UI. */
const CYCLE_ROSTER: readonly string[] = ['default', 'acceptEdits', 'plan']

/** The CLI's standard reasoning-effort tiers, weakest to strongest — the
 * compatibility fallback `levels()` serves for a model row that declares no
 * list of its own (relay custom rows; the CLI accepts any effortLevel flag
 * via applyFlagSettings, so the standard ladder is an honest offer). */
const EFFORT_FALLBACK_TIERS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

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
  /** The channel-profile store (channels.json); the session wires the file
   *  store by default and tests an in-memory one. */
  readonly channels: ClaudeChannels
  /** The channel-token credential seam (~/.dsh/.credentials.yaml, the
   *  /provider precedent); the session wires the file store by default.
   *  Token material moves between this seam and the spawn pipeline only. */
  readonly tokens?: ClaudeChannelTokens
  /** The env the CLI child applies (settings `env` + live env), read lazily
   *  by the settings import. Absent = nothing to import from. */
  settingsEnv?(): Record<string, string | undefined>
  debug(message: string): void
  /** The channel's model truth (settings `env` + live env), read lazily on
   *  the first model-list call: a relay's cosmetic tier name must not hide
   *  the model that actually serves the request (see modelEnv.ts). */
  modelTruth?(): { actualFor(requestedId: string): string | undefined }
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

/** The connection fingerprint of one profile: a sha256 over the endpoint,
 *  the STORED token (when the seam holds one) and the channel-private env —
 *  equal fingerprints are the same connection, so the UI can decide
 *  restart-vs-refresh without ever seeing the token. */
const connectionFingerprint = (profile: ClaudeChannelProfile, tokens: ClaudeChannelTokens | undefined): string => {
  const token = profile.tokenRef !== undefined && tokens !== undefined ? tokens.read(profile.tokenRef) ?? '' : ''
  const env = Object.entries(profile.env ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => key + '=' + value).join(';')
  return createHash('sha256').update([profile.baseUrl ?? '', token, env].join('\u0000')).digest('hex').slice(0, 16)
}

/** One stored profile as the capability's readonly view (file order kept). */
const profileView = (profile: ClaudeChannelProfile, tokens: ClaudeChannelTokens | undefined): ChannelProfileView => ({
  id: profile.id,
  name: profile.name,
  models: Object.entries(profile.models ?? {}).map(([from, to]) => ({ from, to })),
  tiers: Object.entries(profile.tiers ?? {}).map(([tier, to]) => ({ tier, to })),
  ...(!hasChannelConnection(profile) ? {} : {
    connection: {
      ...(profile.baseUrl === undefined ? {} : { baseUrl: profile.baseUrl }),
      hasToken: profile.tokenRef !== undefined && (tokens?.declared(profile.tokenRef) ?? false),
      envKeys: Object.keys(profile.env ?? {}),
      fingerprint: connectionFingerprint(profile, tokens),
    },
  }),
})

/** Build the capabilities (catalogs seeded from the handshake by `seed`). */
export function createClaudeControls(deps: ClaudeControlsDeps) {
  let models: readonly ModelInfo[] = []
  let commands: readonly SlashCommand[] = []
  /** The TUI's own effort choice (the CLI reports none back in `init`). */
  let effort: string | undefined = deps.prefs.read().effort
  /** Terminal-only commands the CLI lists separately (never offered here). */
  let terminalOnly: ReadonlySet<string> = new Set()

  const currentRow = (): ModelInfo | undefined => rowOf(models, deps.currentModel())

  /** Converge the remembered effort with a model's DECLARED effort
   *  capabilities: the choice is cleared ONLY on an explicit refusal —
   *  `supportsEffort === false`, or a DECLARED level list that does not
   *  contain the tier. A row that declares neither (the real offline
   *  catalog's Haiku rows, a relay channel's custom model rows, an old CLI
   *  claiming support without tiers) keeps the choice: the CLI accepts any
   *  effortLevel flag (applyFlagSettings — the user's own settings.json
   *  ships a global one), and levels() serves the CLI-standard tiers for
   *  exactly that shape. A remembered tier outside even the fallback ladder
   *  is kept verbatim — the CLI is the authority on what it will run, and
   *  the TUI neither rewrites the user's pref nor offers it in the picker
   *  (the slider marks no tier as current). Returns the events the caller
   *  must emit. (R2-4: EVERY authoritative confirmation of the model runs
   *  this — a manual switch, the open/resume seed, a later `system/init`
   *  or `message_start` frame — so the readout never claims a tier the
   *  serving model refuses.) */
  const convergeEffort = (row: ModelInfo | undefined): readonly AgentEvent[] => {
    if (row === undefined || effort === undefined) return []
    const levels = row.supportedEffortLevels as readonly string[] | undefined
    if (row.supportsEffort === false || (levels !== undefined && levels.length > 0 && !levels.includes(effort))) {
      effort = undefined
      deps.prefs.write({ effort: null })
      return [{ type: 'effort.changed', effort: null }]
    }
    return []
  }
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
    const ids = [...ROSTER]
    if (row?.supportsAutoMode === true) ids.push('auto')
    // The live mode stays listed (and cyclable away from) even when the
    // roster would not offer it — a session started in `dontAsk`, say.
    const current = deps.currentMode()
    if (current !== '' && !ids.includes(current)) ids.push(current)
    return ids.map(id => ({ id, label: modeLabel(id), description: modeDescription(id) }))
  }

  /** The cycle: the same assembly as `modeList`, over `CYCLE_ROSTER` — the
   *  live mode still trails the cycle as the away-out when the roster would
   *  not offer it, so a session in a non-roster mode can always cycle out. */
  const modeCycle = (): readonly ModeOption[] => {
    const row = currentRow()
    const ids = [...CYCLE_ROSTER]
    if (row?.supportsAutoMode === true) ids.push('auto')
    const current = deps.currentMode()
    if (current !== '' && !ids.includes(current)) ids.push(current)
    return ids.map(id => ({ id, label: modeLabel(id), description: modeDescription(id) }))
  }

  /** R3-6 followup: whether any OTHER profile row still references `ref`.
   *  Shared refs are legal data — a hand edit or migration can point a
   *  second channel at another channel's DERIVED key — so erasing a
   *  credential on one row's account must first prove no sibling still
   *  reads it. */
  const refSharedElsewhere = (ref: string, exceptId: string): boolean =>
    deps.channels.read().channels.some(channel => channel.id !== exceptId && channel.tokenRef === ref)

  const capabilities = {
    models: {
      async list(): Promise<readonly ModelOption[]> {
        const truth = deps.modelTruth?.()
        return (await refreshModels()).map(model => {
          // Channel truth (modelEnv.ts): when the configuration says this
          // row's id routes to a different model, the LABEL becomes the
          // actual model and the cosmetic name moves into the description.
          // No mapping (a real Claude setup, or one resolving to the same
          // model) renders exactly as before.
          const actual = truth?.actualFor(model.value)
            ?? truth?.actualFor(model.resolvedModel ?? '')
          if (actual === undefined) {
            return { id: model.value, label: model.displayName, description: model.description }
          }
          const description = [model.displayName, model.description]
            .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
            .join(' — ')
          return { id: model.value, label: actual, description: description === '' ? undefined : description }
        })
      },
      current: (): ModelRef => ({ model: deps.currentModel() }),
      display: (): string | undefined => {
        const current = deps.currentModel()
        return current === '' ? undefined : deps.modelTruth?.().actualFor(current)
      },
      async set(ref: ModelRef): Promise<ModelSwitchOutcome> {
        const row = rowOf(models, ref.model) ?? rowOf(await refreshModels(), ref.model)
        if (row === undefined) return { kind: 'refused', reason: t('claude-model-unknown', { model: ref.model }) }
        // In place (no fork): the CLI applies it from the next request on.
        await deps.query().setModel(row.value)
        deps.prefs.write({ model: row.value })
        deps.emit(deps.noteModel(row.resolvedModel ?? row.value))
        // An effort the new model refuses is cleared (the CLI would run its
        // default anyway; the readout must not claim otherwise) — the
        // explicit-refusal rule lives on convergeEffort (R2-4).
        deps.emit(convergeEffort(row))
        return { kind: 'switched' }
      },
    },
    effort: {
      get levelsFallback(): true | undefined {
        const row = currentRow()
        if (row === undefined) return undefined
        const declared = row.supportedEffortLevels as readonly string[] | undefined
        if (row.supportsEffort === false || (declared !== undefined && declared.length > 0)) return undefined
        return true
      },
      levels(): readonly EffortOption[] {
        const row = currentRow()
        // An unknown model (no catalog row at all — the cold start before the
        // handshake seeds one) offers nothing: nothing is guessed for a model
        // the catalog does not know (the lifecycle contract).
        if (row === undefined) return []
        if (row.supportsEffort === false) return []
        // A KNOWN row that declares no list of its own (relay custom rows,
        // the offline Haiku shape, old CLIs) falls back to the CLI's standard
        // tiers — the CLI accepts any effortLevel flag, so the standard
        // ladder is the honest compatibility offer, marked above for the
        // picker to say so.
        const declared = row.supportedEffortLevels as readonly string[] | undefined
        const tiers = declared !== undefined && declared.length > 0 ? declared : EFFORT_FALLBACK_TIERS
        return tiers.map(level => ({ id: level, label: effortLabel(level) }))
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
      cycle: modeCycle,
      current: (): string => deps.currentMode(),
      async set(id: string): Promise<void> {
        // No TUI-side vetting: the query was pre-warmed for `bypassPermissions`
        // (options.ts) and the CLI is the authority on what it accepts. A
        // refusal comes back as a rejection and is reported by the channel's
        // guarded setMode, never swallowed here.
        await deps.query().setPermissionMode(id as never)
        // The pick is remembered (prefs.ts): the next session starts where
        // this one ended — the same best-effort write model / effort ride.
        deps.prefs.write({ permissionMode: id })
        deps.emit(deps.noteMode(id))
      },
    },
    channels: {
      list: (): readonly ChannelProfileView[] => deps.channels.read().channels.map(profile => profileView(profile, deps.tokens)),
      activeId: (): string | undefined => deps.channels.read().active,
      setActive: (id: string): void => { deps.channels.setActive(id) },
      importFromSettings: (): ChannelProfileView | undefined => {
        const env = deps.settingsEnv?.() ?? {}
        const draft = importFromSettingsEnv(env)
        if (draft === undefined) return undefined
        // A re-import refreshes the same-id channel in place, keeping the
        // user's hand-written exact models (channels.ts's contract).
        const existing = deps.channels.read().channels.find(channel => channel.id === draft.id)
        const imported = existing === undefined ? draft : importFromSettingsEnv(env, existing) ?? draft
        // Phase 3: the settings env's auth token, when present, moves into
        // the credential store — the profile keeps only the ref, so
        // channels.json never carries a literal token. The import is a COPY
        // (settings keeps its value); it rotates the row's EXISTING ref when
        // the channel already holds one (R3-6), else the derived ref.
        const token = importTokenFromSettingsEnv(env)
        const ref = existing?.tokenRef ?? channelTokenRef(imported.id)
        const profile: ClaudeChannelProfile = token !== undefined && deps.tokens !== undefined
          ? { ...imported, tokenRef: ref }
          : imported
        if (token !== undefined && deps.tokens !== undefined) deps.tokens.write(ref, token)
        deps.channels.save(profile)
        return profileView(profile, deps.tokens)
      },
      save: input => {
        const current = deps.channels.read().channels.find(channel => channel.id === input.id)
        // The token, when the wizard collected one, lives in the credential
        // store; '' removes it (and the profile's ref with it). A rotation
        // (R3-6) reuses the row's EXISTING ref — a hand-written or migrated
        // tokenRef keeps pointing at its credential instead of being left
        // behind in the store while the row moves to the derived ref; only
        // a row without one adopts the derived ref.
        let storedTokenRef = current?.tokenRef
        if (input.token !== undefined && deps.tokens !== undefined) {
          if (input.token === '') {
            // Clearing THIS row detaches the ref from it, but the credential
            // dies only with its last referent: another row sharing the ref
            // (shared DERIVED keys included) must not dangle (R3-6 followup).
            if (storedTokenRef !== undefined) {
              if (refSharedElsewhere(storedTokenRef, input.id)) {
                deps.debug(`claude: channel ${input.id} cleared its token; the shared ref ${storedTokenRef} stays in the store (another channel still references it)`)
              } else {
                deps.tokens.erase(storedTokenRef)
              }
            }
            storedTokenRef = undefined
          } else {
            const target = storedTokenRef ?? channelTokenRef(input.id)
            deps.tokens.write(target, input.token)
            storedTokenRef = target
          }
        }
        const profile: ClaudeChannelProfile = {
          id: input.id,
          name: input.name,
          ...(input.baseUrl === undefined ? { ...(current?.baseUrl === undefined ? {} : { baseUrl: current.baseUrl }) } : input.baseUrl === '' ? {} : { baseUrl: input.baseUrl }),
          ...(storedTokenRef === undefined ? {} : { tokenRef: storedTokenRef }),
          ...(input.env === undefined ? { ...(current?.env === undefined ? {} : { env: current.env }) } : Object.keys(input.env).length === 0 ? {} : { env: input.env }),
          ...(input.models === undefined ? { ...(current?.models === undefined ? {} : { models: current.models }) } : input.models),
          ...(input.tiers === undefined ? { ...(current?.tiers === undefined ? {} : { tiers: current.tiers }) } : input.tiers),
        }
        deps.channels.save(profile)
        return profileView(profile, deps.tokens)
      },
      remove: id => {
        const current = deps.channels.read().channels.find(channel => channel.id === id)
        if (current === undefined) return false
        // R3-6: a credential is erased only when no OTHER row still
        // references its ref — shared DERIVED keys included (a hand edit
        // can point a second channel at CHANNEL_<A>_TOKEN; removing A must
        // not dangle B) — AND the ref is this channel's own derived one (a
        // hand-written ref may be host-owned: "referenced" is not
        // "exclusively deletable"). Everything kept is reported to the
        // debug log; the ref name is not secret, it lives in channels.json.
        if (current.tokenRef !== undefined) {
          if (refSharedElsewhere(current.tokenRef, id)) {
            deps.debug(`claude: channel ${id} removed; its tokenRef ${current.tokenRef} stays in the store (another channel still references it)`)
          } else if (current.tokenRef === channelTokenRef(id)) {
            deps.tokens?.erase(current.tokenRef)
          } else {
            deps.debug(`claude: channel ${id} removed; its non-derived tokenRef ${current.tokenRef} stays in the store (possibly host-owned - erase by hand if truly orphaned)`)
          }
        }
        deps.channels.remove(id)
        return true
      },
      peekSettingsImport: () => {
        const env = deps.settingsEnv?.() ?? {}
        const draft = importFromSettingsEnv(env)
        if (draft === undefined) return undefined
        return {
          ...(draft.baseUrl === undefined ? {} : { baseUrl: draft.baseUrl }),
          tiers: draft.tiers ?? {},
        }
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
    /** R2-4: the session confirmed the model from an authoritative source
     *  other than a manual switch — the open/resume seed, a `system/init`
     *  frame, a `message_start` drift. The effort readout converges with
     *  the model's DECLARED capabilities through the same explicit-refusal
     *  rule; a model the seeded catalog has no row for is missing
     *  metadata and keeps the choice. */
    noteConfirmedModel(model: string): void {
      if (model === '') return
      const events = convergeEffort(rowOf(models, model))
      if (events.length > 0) deps.emit(events)
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

/** The one-line explanation of a backend-native permission mode (the
 *  picker's second row: what the mode actually does — never a repeat of the
 *  label). Unknown ids have none. */
export function modeDescription(id: string): string | undefined {
  switch (id) {
    case 'default': return t('claude-mode-desc-default')
    case 'acceptEdits': return t('claude-mode-desc-acceptEdits')
    case 'plan': return t('claude-mode-desc-plan')
    case 'auto': return t('claude-mode-desc-auto')
    case 'dontAsk': return t('claude-mode-desc-dontAsk')
    case 'bypassPermissions': return t('claude-mode-desc-bypassPermissions')
    default: return undefined
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
