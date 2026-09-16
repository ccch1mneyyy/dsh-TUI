import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { resolveModelRoute, validateModelRoute } from '../../modelRoute.js'
import { readModelPref } from '../../modelPrefs.js'
import { readPresetPref } from '../../presetPrefs.js'
import { forgetAgentViewSession, readAgentViewSessions, touchAgentViewSession, touchSession } from '../../sessionHistory.js'
import { t } from '../../i18n.js'
import {
  AGENT_VIEW_STATUS_ORDER,
  agentViewLivePreview,
  agentViewStatusOf,
  foldAgentViewEvents,
  oneLine,
  sessionTitleFallback,
  type AgentViewFold,
} from '../agent-view.js'
import { snapshotLiveSessionEvents } from '../compat/liveSession.js'
import { composePreset } from '../presets.js'
import { locateSession, previewSession, type SessionSource, type SessionSummary } from '../sessions/index.js'
import { attachSessionToWorkspace } from '../workspace.js'
import { logForDebugging } from '../../utils/debug.js'
import type { createChannelBinding } from './binding.js'
import type { ChannelOwner } from './owner.js'
import type { AgentViewDispatchResult, AgentViewRow, BackgroundResult, ResumeResult } from './types.js'
import type { PreviewEntry } from '../sessions/index.js'

type Binding = ReturnType<typeof createChannelBinding>
type ApprovalStore = {
  pendingAgentIds(): readonly string[]
  pendingAgentDetail(agentId: string): { toolName: string; reason?: string; command?: string } | undefined
  subscribe(listener: () => void): () => void
}

/** Owns detached background handles and the agent-view projection. */
export function createAgentViewProjection(
  ctx: Context,
  deps: {
    owner: Pick<ChannelOwner, 'current' | 'assertActive' | 'own'>
    binding: Pick<Binding, 'agent' | 'capture' | 'isCurrent' | 'prepare' | 'abandon'>
    cwd(): string
    configuredPreset?: string
    configuredProvider?: string
    configuredModel?: string
    provider: string
    model: string
    notify(text: string, options?: { color?: 'error' | 'warning'; timeoutMs?: number }): unknown
    listPersisted(): Promise<readonly SessionSummary[]>
    createDetached(create: () => Promise<AgentHandle>): Promise<{ handle: AgentHandle; transfer(): void; release(): Promise<void> }>
    sessionSwitchVetoed(kind: 'agent-view', targetSessionId?: string): Promise<boolean>
    adoptLive(target: Agent): Promise<ResumeResult>
    resumeInto(sessionId: string, kind: 'agent-view', keepCurrent: boolean): Promise<ResumeResult>
    /** The foreground binding transaction for `/bg`; the caller owns only
     * resetting/binding the foreground projection, never the parked handle. */
    backgroundCurrent?(): Promise<BackgroundResult>
    backgroundHandles?: Map<string, AgentHandle>
  },
) {
  const backgroundHandles = deps.backgroundHandles ?? new Map<string, AgentHandle>()
  let approvalStore: ApprovalStore | undefined
  const listeners = new Set<() => void>()
  let rowsCache: readonly AgentViewRow[] | undefined
  let refreshTimer: NodeJS.Timeout | undefined
  let persistedRows: readonly SessionSummary[] = []
  const folds = new Map<string, { events: readonly SessionEvent[]; fold: AgentViewFold }>()
  let disposed = false

  const notify = (): void => {
    if (disposed) return
    rowsCache = undefined
    for (const listener of listeners) listener()
  }
  const schedule = (): void => {
    if (disposed || refreshTimer !== undefined) return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      notify()
    }, 300)
  }
  const refreshPersisted = (): void => {
    void deps.listPersisted().then(rows => {
      if (disposed || !deps.owner.current()) return
      persistedRows = rows
      notify()
    }).catch(() => undefined)
  }
  const foldOf = (agent: Agent): AgentViewFold => {
    const events = snapshotLiveSessionEvents(agent.session)
    const cached = folds.get(String(agent.id))
    const base: AgentViewFold = {
      hasTurns: false, firstPrompt: '', summary: '', summaryKind: 'none', title: '',
      updatedAt: agent.session.header.createdAt, lastTurnFailed: false,
    }
    if (cached === undefined) {
      const fold = foldAgentViewEvents(events, 0, base)
      folds.set(String(agent.id), { events, fold })
      return fold
    }
    if (cached.events === events) return cached.fold
    const fold = foldAgentViewEvents(events, cached.events.length, cached.fold)
    folds.set(String(agent.id), { events, fold })
    return fold
  }
  const agents = (): { list?(): readonly Agent[]; get(id: SessionId): Agent | undefined; create(options: CreateAgentOptions): Promise<AgentHandle> } | undefined =>
    ctx.get('agents') as ReturnType<typeof agents>

  let started = false
  let disposeStatus: (() => void) | undefined
  let disposeCreated: (() => void) | undefined
  let disposeDisposed: (() => void) | undefined
  const start = (): void => {
    if (started || disposed) return
    started = true
    // These process-wide roster observations still belong to this channel
    // owner. Revoke them so a retained Context cannot wake a dead projection.
    disposeStatus = ctx.on('agent/status', () => schedule())
    disposeCreated = ctx.on('agent/created', () => notify())
    disposeDisposed = ctx.on('agent/disposed', ({ agent }: { agent: { id?: unknown } }) => {
      folds.delete(String(agent.id ?? ''))
      backgroundHandles.delete(String(agent.id ?? ''))
      notify()
    })
    refreshPersisted()
  }

  const rows = (): readonly AgentViewRow[] => {
    if (rowsCache !== undefined) return rowsCache
    const pending = new Set(approvalStore?.pendingAgentIds() ?? [])
    const live: AgentViewRow[] = []
    for (const agent of agents()?.list?.() ?? []) {
      if (agent.session.header.origin === 'subagent') continue
      const fold = foldOf(agent)
      const id = String(agent.id)
      const current = id === String(deps.binding.agent.session.id)
      if (!fold.hasTurns && !current) continue
      const ask = pending.has(id) ? approvalStore?.pendingAgentDetail(id) : undefined
      live.push({
        id,
        title: fold.title.length > 0 ? fold.title : sessionTitleFallback(fold, agent.session.header.cwd),
        cwd: agent.session.header.cwd ?? deps.cwd(),
        summary: ask !== undefined ? oneLine(ask.reason ?? ask.command ?? ask.toolName ?? '') : fold.summaryKind === 'prompt' ? '' : fold.summary,
        status: agentViewStatusOf(agent.status, fold, ask !== undefined),
        live: true,
        current,
        createdAt: agent.session.header.createdAt,
        updatedAt: fold.updatedAt,
      })
    }
    const liveIds = new Set(live.map(row => row.id))
    const ledger = readAgentViewSessions()
    const stopped: AgentViewRow[] = persistedRows.filter(summary =>
      !liveIds.has(summary.id) && summary.kind.kind !== 'subagent' && ledger[summary.id] !== undefined && summary.hasPrompt,
    ).map(summary => ({
      id: summary.id, title: summary.title.text, cwd: summary.cwd,
      summary: summary.label === undefined ? '' : oneLine(summary.label), status: 'stopped', live: false, current: false,
      createdAt: summary.createdAt, updatedAt: summary.updatedAt,
    }))
    const rank = (row: AgentViewRow) => {
      const index = AGENT_VIEW_STATUS_ORDER.indexOf(row.status)
      return index < 0 ? AGENT_VIEW_STATUS_ORDER.length : index
    }
    rowsCache = [...live, ...stopped].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    return rowsCache
  }

  const dispatch = async (prompt: string): Promise<AgentViewDispatchResult> => {
    const text = prompt.trim()
    if (text === '') return { ok: false, reason: 'failed', error: t('agentview-empty-prompt') }
    const service = agents()
    if (!service) {
      deps.notify(t('agentview-dispatch-unavailable'), { color: 'error' })
      return { ok: false, reason: 'unavailable' }
    }
    const sessionId = SessionId(randomUUID())
    let detached: Awaited<ReturnType<typeof deps.createDetached>>
    try {
      deps.owner.assertActive()
      const composed = await composePreset(ctx, deps.configuredPreset ?? readPresetPref())
      const resolved = resolveModelRoute({ provider: deps.configuredProvider, model: deps.configuredModel }, readModelPref(), { provider: deps.provider, model: deps.model })
      const llm = ctx.get('llm') as { listModels(provider: string): Promise<readonly { id: string }[]> } | undefined
      const { route } = await validateModelRoute(llm, resolved, { provider: deps.provider, model: deps.model })
      deps.owner.assertActive()
      detached = await deps.createDetached(() => service.create({
        sessionId,
        meta: { cwd: deps.cwd(), ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }) },
        agentOptions: route,
        ...(composed.setup === undefined ? {} : { setup: composed.setup }),
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.notify(t('agentview-dispatch-failed', { err: message }), { color: 'error', timeoutMs: 8000 })
      return { ok: false, reason: 'failed', error: message }
    }
    if (!deps.owner.current()) { await detached.release(); return { ok: false, reason: 'failed', error: 'Channel lifetime ended' } }
    try { await attachSessionToWorkspace(ctx, deps.cwd(), sessionId) } catch { /* optional ledger */ }
    if (!deps.owner.current()) { await detached.release(); return { ok: false, reason: 'failed', error: 'Channel lifetime ended' } }
    detached.transfer()
    backgroundHandles.set(String(sessionId), detached.handle)
    touchAgentViewSession(String(sessionId))
    touchSession(sessionId)
    // transfer intentionally moves disposal to the background ledger; check
    // once more before delivery so revocation cannot create a late turn.
    if (!deps.owner.current()) {
      backgroundHandles.delete(String(sessionId))
      await detached.handle.dispose().catch(() => undefined)
      return { ok: false, reason: 'failed', error: 'Channel lifetime ended' }
    }
    try {
      detached.handle.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.notify(t('agentview-dispatch-failed', { err: message }), { color: 'error', timeoutMs: 8000 })
      return { ok: false, reason: 'failed', error: message }
    }
    notify()
    return { ok: true, sessionId: String(sessionId) }
  }

  const stop = async (sessionId: string): Promise<boolean> => {
    if (sessionId === String(deps.binding.agent.session.id)) return false
    const handle = backgroundHandles.get(sessionId)
    if (handle === undefined) return false
    backgroundHandles.delete(sessionId)
    try {
      handle.agent.cancel({ kind: 'user' })
      await handle.dispose()
    } catch (error) {
      logForDebugging(`agent view: stop of "${sessionId}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    folds.delete(sessionId)
    refreshPersisted()
    notify()
    return true
  }
  const attach = async (sessionId: string): Promise<ResumeResult> => {
    if (sessionId === String(deps.binding.agent.session.id)) return { ok: true }
    // Capture the exact live target before the async host decision. If the
    // registry replaces it while parked, never silently adopt that arbitrary
    // replacement; a later user action can make a fresh, explicit choice.
    const live = agents()?.get(SessionId(sessionId))
    if (await deps.sessionSwitchVetoed('agent-view', sessionId)) return { ok: false, reason: 'cancelled' }
    if (live !== undefined && agents()?.get(SessionId(sessionId)) !== live) return { ok: false, reason: 'cancelled' }
    return live === undefined ? deps.resumeInto(sessionId, 'agent-view', true) : deps.adoptLive(live)
  }
  const peek = async (sessionId: string): Promise<PreviewEntry[]> => {
    const live = agents()?.get(SessionId(sessionId))
    if (live !== undefined) return agentViewLivePreview(snapshotLiveSessionEvents(live.session), 8)
    const persistence = ctx.get('sessionPersistence') as SessionSource | undefined
    if (!persistence) return []
    const path = await locateSession(persistence, sessionId)
    return path === undefined ? [] : previewSession(path, 8)
  }
  const reply = async (sessionId: string, text: string): Promise<boolean> => {
    const trimmed = text.trim()
    if (trimmed === '') {
      deps.notify(t('agentview-reply-empty'), { color: 'warning' })
      return false
    }
    const live = agents()?.get(SessionId(sessionId))
    if (live === undefined) {
      deps.notify(t('agentview-reply-stopped'), { color: 'warning' })
      return false
    }
    if (!deps.owner.current()) return false
    live.followup(createUserMessage({ content: [{ type: 'text', text: trimmed }], source: { kind: 'user' } }))
    notify()
    return true
  }
  const bindApprovalStore = (store: ApprovalStore): void => {
    approvalStore = store
    const unsubscribe = store.subscribe(notify)
    deps.owner.own(unsubscribe)
    notify()
  }
  const dispose = (): void => {
    disposed = true
    const failures: unknown[] = []
    for (const cleanup of [disposeStatus, disposeCreated, disposeDisposed]) {
      try { cleanup?.() } catch (error) { failures.push(error) }
    }
    disposeStatus = undefined
    disposeCreated = undefined
    disposeDisposed = undefined
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    refreshTimer = undefined
    listeners.clear()
    for (const handle of backgroundHandles.values()) {
      // Handle disposal is asynchronous by contract; initiate every release
      // even if a subscription disposer above fails.
      void handle.dispose().catch(() => undefined)
    }
    backgroundHandles.clear()
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'dsh-tui: agent-view cleanup failed')
  }
  deps.owner.own(dispose)
  return {
    start, backgroundHandles, notify, schedule, refreshPersisted, bindApprovalStore, rows,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener) },
    dispatch, stop, attach, peek, reply,
    backgroundCurrent: () => deps.backgroundCurrent?.() ?? Promise.resolve({ ok: false }),
    setPersisted(rows: readonly SessionSummary[]) { persistedRows = rows; notify() },
    // Forgetting persisted metadata must not discard an in-process handle:
    // stop and owner teardown continue to own the live background session.
    forget(sessionId: string) { folds.delete(sessionId); forgetAgentViewSession(sessionId); notify() },
  }
}
