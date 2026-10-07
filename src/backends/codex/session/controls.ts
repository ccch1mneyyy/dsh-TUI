/** Thin wrappers over Codex's control requests; choices persist only in TUI prefs. */
import type { AccountView, EffortOption, McpServerView, ModelOption, ModeOption, SessionCapabilities } from '../../../agent/capabilities.js'
import type { AgentEvent } from '../../../agent/events.js'
import { t } from '../../../i18n.js'
import { CODEX_MODE_PARAMS, isCodexModeId } from '../modes.js'
import { arr, errorText, num, rec, str, type Rec } from '../narrow.js'
import type { CodexPrefs } from '../prefs.js'
import { CLIENT, NOTIFY } from '../protocol/index.js'
import { rpcCode, RPC_ERROR } from '../rpc/client.js'
import type { CodexHub } from '../rpc/hub.js'
import type { ItemContext } from '../translate/items.js'
import type { SettingsSnapshot } from '../translate/live.js'
import { CODEX_INIT_PROMPT } from './prompts.js'

interface ControlsDeps {
  readonly hub: CodexHub
  readonly prefs: CodexPrefs
  readonly ctx: ItemContext
  readonly settings: SettingsSnapshot
  readonly cwd: string
  threadId(): string
  busy(): boolean
  emit(events: readonly AgentEvent[]): void
  submitText(text: string): Promise<void>
  account?(): Promise<AccountView>
  mappedModels?(): readonly ModelOption[]
  actualModel?(id: string): string
  debug(message: string): void
}

const catalogs = new WeakMap<CodexHub, { rows?: Promise<readonly Rec[]> }>()

/** Policy objects used by turn/start and thread/settings/update. */
export function sandboxPolicy(mode: string, cwd: string): Rec {
  switch (mode) {
    case 'read-only': return { type: 'readOnly', networkAccess: false }
    case 'danger-full-access': return { type: 'dangerFullAccess' }
    default: return { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
  }
}

function permissionOptions(): ModeOption[] {
  return [
    { id: 'read-only', label: t('codex-mode-read-only'), description: t('codex-mode-read-only-desc') },
    { id: 'auto', label: t('codex-mode-auto'), description: t('codex-mode-auto-desc') },
    { id: 'full-access', label: t('codex-mode-full-access'), description: t('codex-mode-full-access-desc') },
  ]
}
const planOption = (): ModeOption => ({ id: 'plan', label: t('codex-mode-plan'), description: t('codex-mode-plan-desc') })

export function createCodexControls(deps: ControlsDeps) {
  const { hub, settings, ctx, prefs } = deps
  let rows: readonly Rec[] = []
  let planSupported = true
  let settingsSupported = true
  let pending: Record<string, unknown> = {}
  let appliedCollaboration = settings.collaborationMode
  let context = { used: 0, max: undefined as number | undefined }
  let requestedTitle: string | undefined
  let catalog = catalogs.get(hub)
  if (catalog === undefined) { catalog = {}; catalogs.set(hub, catalog) }

  const models = async (): Promise<readonly ModelOption[]> => {
    catalog!.rows ??= (async () => {
      const collected: Rec[] = []
      let cursor: string | undefined
      do {
        const answer = rec(await hub.call(CLIENT.modelList, { includeHidden: false, limit: 100, ...(cursor === undefined ? {} : { cursor }) }))
        collected.push(...arr(answer?.data).flatMap(raw => rec(raw) === undefined ? [] : [rec(raw)!]))
        cursor = str(answer?.nextCursor) ?? undefined
      } while (cursor !== undefined && cursor !== '')
      return collected
    })().catch(error => { catalog!.rows = undefined; throw error })
    rows = await catalog!.rows
    const options: ModelOption[] = rows.filter(row => row.hidden !== true).flatMap(row => {
      const id = str(row.model) ?? str(row.id)
      return id === undefined ? [] : [{ id, label: str(row.displayName) ?? id, ...(str(row.description) === undefined ? {} : { description: str(row.description) }) }]
    })
    for (const mapped of deps.mappedModels?.() ?? []) if (!options.some(option => option.id === mapped.id)) options.push(mapped)
    return options
  }
  const currentRow = (): Rec | undefined => rows.find(row => row.model === settings.model || row.id === settings.model)
  const collaboration = (mode: 'plan' | 'default', model = settings.model, effort = settings.effort): Rec => ({ mode, settings: { model, reasoning_effort: effort, developer_instructions: null } })

  /** An accepted update is sticky server-side, not an override for every turn. */
  const acknowledge = (applied: Rec): void => {
    appliedCollaboration = rec(applied.collaborationMode) ?? appliedCollaboration
    for (const [key, value] of Object.entries(applied)) {
      if (JSON.stringify(pending[key]) === JSON.stringify(value)) delete pending[key]
    }
  }
  let sentOverrides: Rec | undefined
  const update = async (change: Rec): Promise<void> => {
    // A deferred mode has higher wire precedence than model/effort. Keep its
    // embedded settings in sync without touching its developer instructions.
    const mode = rec(pending.collaborationMode)
    if (mode !== undefined && change.collaborationMode === undefined && (change.model !== undefined || change.effort !== undefined)) {
      change = { ...change, collaborationMode: { ...mode, settings: { ...rec(mode.settings),
        ...(change.model === undefined ? {} : { model: change.model }),
        ...(change.effort === undefined ? {} : { reasoning_effort: change.effort }),
      } } }
    }
    const before = pending
    pending = { ...pending, ...change }
    if (deps.busy() || !settingsSupported) return
    try {
      await hub.call(CLIENT.threadSettingsUpdate, { threadId: deps.threadId(), ...change })
      acknowledge(change)
    } catch (error) {
      const code = rpcCode(error)
      if ((code !== RPC_ERROR.methodNotFound && code !== RPC_ERROR.invalidParams) || (code === RPC_ERROR.invalidParams && change.collaborationMode !== undefined)) {
        for (const [key, value] of Object.entries(change)) {
          if (JSON.stringify(pending[key]) !== JSON.stringify(value)) continue
          if (before[key] === undefined) delete pending[key]
          else pending[key] = before[key]
        }
        if (code === RPC_ERROR.invalidParams && change.collaborationMode !== undefined) {
          planSupported = false
          delete pending.collaborationMode
          throw new Error(t('codex-capability-unavailable', { feature: t('codex-mode-plan') }))
        }
        throw error
      }
      settingsSupported = false
      deps.emit([{ type: 'notice', level: 'warning', key: 'codex-settings-deferred', text: t('codex-settings-deferred') }])
    }
  }

  const effortLevels = (): EffortOption[] => arr(currentRow()?.supportedReasoningEfforts).flatMap(raw => {
    const id = str(rec(raw)?.reasoningEffort)
    if (id === undefined) return []
    const labels: Record<string, string> = { none: t('codex-effort-none'), minimal: t('codex-effort-minimal'), low: t('codex-effort-low'), medium: t('codex-effort-medium'), high: t('codex-effort-high'), xhigh: t('codex-effort-xhigh'), ultra: t('codex-effort-ultra') }
    return [{ id, label: labels[id] ?? id }]
  })

  const capabilities: Pick<SessionCapabilities, 'models' | 'effort' | 'modes' | 'compact' | 'context' | 'account' | 'mcp' | 'rename' | 'init'> = {
    models: {
      list: models,
      current: () => ({ model: settings.model }),
      display: () => deps.actualModel?.(settings.model),
      async set(ref) {
        await models()
        const model = deps.actualModel?.(ref.model) ?? ref.model
        const nextRow = rows.find(row => row.model === model || row.id === model)
        const available = arr(nextRow?.supportedReasoningEfforts).map(raw => str(rec(raw)?.reasoningEffort))
        const effort = settings.effort !== null && available.length > 0 && !available.includes(settings.effort) ? str(nextRow?.defaultReasoningEffort) ?? null : settings.effort
        await update({ model, ...(effort === settings.effort ? {} : { effort }) })
        const effortChanged = effort !== settings.effort
        settings.model = model
        settings.effort = effort
        ctx.model = model
        prefs.write({ model: ref.model, ...(effortChanged ? { effort } : {}) })
        deps.emit([{ type: 'model.changed', model, source: 'user' }, { type: 'effort.changed', effort }])
        return { kind: 'switched' }
      },
    },
    effort: {
      levels: effortLevels,
      current: () => settings.effort ?? undefined,
      async set(id) {
        if (rows.length === 0) await models()
        if (id !== null && !effortLevels().some(option => option.id === id)) throw new Error(t('effort-invalid', { id, ids: effortLevels().map(option => option.id).join(', ') }))
        const applied = id ?? str(currentRow()?.defaultReasoningEffort) ?? null
        await update({ effort: applied })
        settings.effort = applied
        prefs.write({ effort: id })
        deps.emit([{ type: 'effort.changed', effort: applied }])
      },
    },
    modes: {
      list: () => [...permissionOptions(), ...(planSupported ? [planOption()] : [])],
      cycle: () => {
        const base = permissionOptions().find(option => option.id === settings.permissionMode) ?? { id: settings.permissionMode ?? 'custom', label: settings.permissionMode ?? 'custom' }
        return planSupported ? [base, planOption()] : [base]
      },
      current: () => settings.modeId,
      async set(id) {
        if (id !== 'plan' && !isCodexModeId(id) && id !== settings.permissionMode) throw new Error(t('codex-mode-invalid', { mode: id }))
        if (id === 'plan' && !planSupported) throw new Error(t('codex-capability-unavailable', { feature: t('codex-mode-plan') }))
        const plan = id === 'plan'
        const switching = plan !== (settings.modeId === 'plan')
        const change: Record<string, unknown> = planSupported && switching ? { collaborationMode: collaboration(plan ? 'plan' : 'default') } : {}
        if (!plan && isCodexModeId(id)) {
          const params = CODEX_MODE_PARAMS[id]
          change.approvalPolicy = params.approvalPolicy
          change.sandboxPolicy = sandboxPolicy(params.sandbox, deps.cwd)
        }
        await update(change)
        if (!plan && isCodexModeId(id)) {
          settings.permissionMode = id
          settings.approvalPolicy = change.approvalPolicy
          settings.sandboxPolicy = change.sandboxPolicy
          prefs.write({ mode: id })
        }
        settings.collaborationMode = rec(change.collaborationMode) ?? settings.collaborationMode
        settings.modeId = plan ? 'plan' : settings.permissionMode ?? id
        prefs.write({ plan })
        deps.emit([{ type: 'mode.changed', modeId: settings.modeId }])
      },
    },
    compact: {
      async run() {
        if (deps.busy()) throw new Error(t('codex-command-idle'))
        ctx.compactRequested = true
        try { await hub.call(CLIENT.threadCompactStart, { threadId: deps.threadId() }) }
        catch (error) { ctx.compactRequested = false; throw error }
      },
    },
    context: { usage: async () => ({ ...context, categories: [] }) },
    account: {
      async info() {
        if (deps.account !== undefined) return deps.account()
        const response = rec(await hub.call(CLIENT.accountRead, { refreshToken: false }))
        const account = rec(response?.account)
        return { provider: str(account?.type) === 'apiKey' ? 'openai' : str(account?.provider) ?? 'openai', ...(str(account?.planType) === undefined ? {} : { subscription: str(account?.planType) }) }
      },
    },
    mcp: {
      async status(): Promise<readonly McpServerView[]> {
        const servers: McpServerView[] = []
        let cursor: string | undefined
        do {
          const answer = rec(await hub.call(CLIENT.mcpServerStatusList, { threadId: deps.threadId(), detail: 'toolsAndAuthOnly', limit: 100, ...(cursor === undefined ? {} : { cursor }) }))
          for (const raw of arr(answer?.data)) {
            const server = rec(raw)
            const name = str(server?.name)
            if (name !== undefined) servers.push({ name, status: str(server?.runtimeStatus) ?? str(server?.authStatus) ?? 'unknown', toolCount: Object.keys(rec(server?.tools) ?? {}).length })
          }
          cursor = str(answer?.nextCursor)
        } while (cursor !== undefined && cursor !== '')
        return servers
      },
      reconnect: async () => { await hub.call(CLIENT.mcpServerReload, {}); await capabilities.mcp!.status() },
    },
    rename: {
      async rename(title) {
        requestedTitle = title
        try { await hub.call(CLIENT.threadNameSet, { threadId: deps.threadId(), name: title }) }
        catch (error) { requestedTitle = undefined; throw error }
      },
    },
    init: { run: () => deps.submitText(CODEX_INIT_PROMPT) },
  }

  return {
    capabilities,
    async initialize(): Promise<void> {
      await Promise.all([
        models().catch(error => deps.debug(`codex: model catalog unavailable (${errorText(error)})`)),
        hub.call(CLIENT.collaborationModeList, {}).catch(error => {
          if (rpcCode(error) === RPC_ERROR.methodNotFound || rpcCode(error) === RPC_ERROR.invalidParams) planSupported = false
          else deps.debug(`codex: collaboration modes unavailable (${errorText(error)})`)
        }),
      ])
    },
    /** Knobs not yet applied by a turn (or an idle settings update). */
    turnOverrides(): Rec { sentOverrides = { ...pending }; return sentOverrides },
    /** A refused turn did not apply its settings. Drop only unsupported Plan. */
    turnFailed(error: unknown, overrides: Rec): void {
      sentOverrides = undefined
      if (rpcCode(error) !== RPC_ERROR.invalidParams || rec(overrides.collaborationMode) === undefined) return
      const warn = planSupported
      planSupported = false
      delete pending.collaborationMode
      settings.collaborationMode = appliedCollaboration
      const modeId = appliedCollaboration?.mode === 'plan' ? 'plan' : settings.permissionMode ?? 'custom'
      if (settings.modeId !== modeId) { settings.modeId = modeId; deps.emit([{ type: 'mode.changed', modeId }]) }
      prefs.write({ plan: modeId === 'plan' })
      if (warn) deps.emit([{ type: 'notice', level: 'warning', key: 'codex-plan-unavailable', text: t('codex-capability-unavailable', { feature: t('codex-mode-plan') }) }])
    },
    note(method: string, params: Rec): boolean {
      if (method === NOTIFY.modelVerification || method === NOTIFY.accountUpdated) { catalog!.rows = undefined }
      if (method === NOTIFY.threadSettingsUpdated) acknowledge(rec(params.threadSettings) ?? {})
      if (method === NOTIFY.turnStarted && sentOverrides !== undefined) { acknowledge(sentOverrides); sentOverrides = undefined }
      if (method === NOTIFY.threadTokenUsageUpdated) {
        const usage = rec(params.tokenUsage)
        const used = num(rec(usage?.last)?.totalTokens)
        if (used !== undefined) context.used = used
        context.max = num(usage?.modelContextWindow) ?? context.max
      }
      if (method === NOTIFY.threadNameUpdated) {
        const title = str(params.threadName)
        if (title !== undefined) deps.emit([{ type: 'session.title', title, source: title === requestedTitle ? 'user' : 'auto' }])
        requestedTitle = undefined
        return true
      }
      return false
    },
    get planSupported() { return planSupported },
  }
}
