import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { markChannelReadDirty } from '../../adapter/channel/read-view.js'
import { SubagentActivityStore, type SubagentState } from '../subagents.js'
import type { ChannelState, ChatRow, SubagentControl, SubagentRow } from './types.js'

/** Current-session subagent store, row projection and frame-batched stream
 * bridge. The owning channel installs transport subscriptions; this module
 * only accepts scoped events and never captures a replaceable agent itself.
 *
 * Discovery comes from three seams so the dashboard can mirror EVERY child
 * the session dispatched (issue #966):
 *  1. `subagent/start`/`subagent/end` bus edges — per-run lifecycle of
 *     one-shot runs and continuable epochs, paired by `runId`;
 *  2. parent-session durable events — `subagent/catalog` (child creation
 *     fact, written for every child) and `tool-workflow/agent-start|end`
 *     (workflow/ralph members, which never emit subagent edges) — received
 *     live AND folded from the log at bind/resume so a restart no longer
 *     blanks the panel;
 *  3. lazy registry back-fill — a child session event or stream frame whose
 *     session link was never established is resolved through the agents
 *     registry on arrival, healing one-shot `lookupChild` misses.
 * Transcript cards are gated to children discovered while LIVE: a resumed
 * session's historical children appear in the dashboard without flooding the
 * replayed transcript with cards that the durable log never contained. */
export function createSubagentProjection(
  getState: () => Pick<ChannelState, 'rows' | 'subagents' | 'emit' | 'emitStream'>,
  deps: {
    rowIds: { value: number }
    agent(): Agent
    subagents(): { interrupt?(target: string, reason: unknown): void } | undefined
    /** Optional child metadata lookup; failures must not suppress spawning. */
    lookupChild(id: string): { status?: string; session?: unknown; options?: { provider?: string; model?: string } } | undefined
  },
) {
  const store = new SubagentActivityStore()
  const rowsByAgentId = new Map<string, ChatRow>()
  const pendingTaskDescriptions: string[] = []
  /** Workflow member identity: `tool-workflow/agent-end` carries no childId,
   * so member starts remember `runId:seq` → agentId for their settlement. */
  const workflowMembers = new Map<string, string>()
  /** Children that earned a transcript card (live discovery only). */
  const cardedIds = new Set<string>()
  let streamDirty = false

  const syncRows = (snapshot: readonly SubagentState[] = store.snapshot()): void => {
    const state = getState()
    for (const sub of snapshot) {
      if (!cardedIds.has(sub.agentId)) continue
      let row = rowsByAgentId.get(sub.agentId)
      if (!row) {
        row = { id: deps.rowIds.value++, kind: 'subagent', text: sub.description, subagent: undefined }
        rowsByAgentId.set(sub.agentId, row)
        state.rows.push(row)
      }
      const view: SubagentRow = {
        agentId: sub.agentId, runId: sub.runId, description: sub.description,
        provider: sub.provider, model: sub.model || 'default', effort: sub.effort,
        status: sub.status, startedAt: sub.startedAt, completedAt: sub.completedAt,
        durationMs: sub.completedAt ? sub.completedAt - sub.startedAt : Date.now() - sub.startedAt,
        outputLines: sub.output.slice(-3), toolCalls: sub.toolCalls, tokens: sub.tokens,
        summary: sub.summary, stopReason: sub.stopReason, error: sub.error,
      }
      row.subagent = view
      row.text = sub.description
      markChannelReadDirty(row)
      markChannelReadDirty(state.rows)
    }
  }
  const syncNow = (): void => {
    streamDirty = false
    const snapshot = store.snapshot()
    getState().subagents = snapshot
    syncRows(snapshot)
  }
  const flush = (): boolean => {
    if (!streamDirty) return false
    syncNow()
    return true
  }
  const onSessionEvent = (session: unknown, event: { type?: string }): boolean => {
    let id = store.getSubagentIdBySession(session)
    if (id === undefined) id = backfillSessionLink(session)
    if (id === undefined) return false
    store.onSessionEvent(id, event)
    if (event.type === 'assistant/chunk') {
      streamDirty = true
      getState().emitStream()
    } else {
      syncNow()
      getState().emit()
    }
    return true
  }
  // 0.1.5 live stream frames for child agents: the payload carries the Agent
  // (not its session), so resolve the subagent through its bound session.
  const onStreamFrame = (agent: unknown, frame: AssistantStreamFrame): boolean => {
    const session = (agent as { session?: unknown } | null | undefined)?.session
    let id = session !== undefined && session !== null ? store.getSubagentIdBySession(session) : undefined
    if (id === undefined && session !== undefined && session !== null) id = backfillSessionLink(session)
    if (id === undefined) return false
    store.onStreamFrame(id, frame)
    if (frame.type === 'chunk') {
      streamDirty = true
      getState().emitStream()
    } else {
      syncNow()
      getState().emit()
    }
    return true
  }
  /** Heal a missing session→agent link through the agents registry. The
   * start-time lookup is one-shot; a miss (service not yet mounted, child not
   * yet registered) previously left the child's events permanently
   * unattributed — its row then never left `running`. Only rows the store
   * already tracks are linked: the registry also holds peer top-level
   * sessions (a parked `/bg` agent streams on the same bus) that must never
   * become dashboard rows. */
  const backfillSessionLink = (session: unknown): string | undefined => {
    const sessionId = (session as { id?: unknown } | null | undefined)?.id
    if (typeof sessionId !== 'string' || !store.has(sessionId)) return undefined
    let child: ReturnType<typeof deps.lookupChild> | undefined
    try { child = deps.lookupChild(sessionId) } catch { return undefined }
    if (!child || child.session !== session) return undefined
    // Registry presence is not liveness: a continuable child stays
    // registered while idle. Only a running child upgrades a discovered row
    // and earns a transcript card; the session link itself is established
    // regardless so attribution heals the moment it starts streaming.
    const running = child.status === 'running'
    if (running && store.get(sessionId)?.status === 'unknown') store.patch(sessionId, { status: 'running' })
    store.linkSession(sessionId, session)
    if (running) cardedIds.add(sessionId)
    return sessionId
  }
  /** Register a discovered child and, when the agents registry currently
   * holds it RUNNING (idle continuable children stay registered without
   * being live), bind its session so streaming state flows. */
  const discover = (childId: string, info: { label?: string; childCreatedAt?: number; provider?: string; runId?: string }): void => {
    let child: ReturnType<typeof deps.lookupChild> | undefined
    try { child = deps.lookupChild(childId) } catch { child = undefined }
    const running = child?.status === 'running'
    store.onDiscovered(childId, {
      label: info.label,
      childCreatedAt: info.childCreatedAt,
      live: running,
      provider: info.provider ?? child?.options?.provider,
      model: child?.options?.model,
    })
    if (info.runId !== undefined) store.patch(childId, { runId: info.runId })
    if (child?.session) store.linkSession(childId, child.session)
    if (running) cardedIds.add(childId)
  }
  /** Durable session events stamp their own wall time; a fold from the log
   * must not date a historical child at resume time. */
  const eventTime = (event: unknown): number | undefined => {
    const time = (event as { time?: unknown } | null | undefined)?.time
    return typeof time === 'number' ? time : undefined
  }
  /** Parent-session durable discovery events, live or folded from the log. */
  const onParentEvent = (event: unknown, historical = false): void => {
    if (!event || typeof event !== 'object') return
    const ev = event as { type?: string; data?: { childId?: unknown; childCreatedAt?: unknown; label?: unknown; runId?: unknown; seq?: unknown; outcome?: unknown } }
    const data = ev.data ?? {}
    const childId = typeof data.childId === 'string' ? data.childId : undefined
    if (ev.type === 'subagent/catalog') {
      if (childId === undefined) return
      discover(childId, {
        label: typeof data.label === 'string' ? data.label : undefined,
        childCreatedAt: typeof data.childCreatedAt === 'number' ? data.childCreatedAt : eventTime(event),
      })
    } else if (ev.type === 'tool-workflow/agent-start') {
      if (childId === undefined || typeof data.runId !== 'string' || typeof data.seq !== 'number') return
      const memberKey = `${data.runId}:${data.seq}`
      workflowMembers.set(memberKey, childId)
      discover(childId, {
        label: typeof data.label === 'string' ? data.label : undefined,
        childCreatedAt: eventTime(event),
        provider: 'workflow',
        runId: memberKey,
      })
    } else if (ev.type === 'tool-workflow/agent-end') {
      if (typeof data.runId !== 'string' || typeof data.seq !== 'number') return
      const agentId = workflowMembers.get(`${data.runId}:${data.seq}`)
      if (agentId === undefined) return
      // The durable end event stamps the historical wall time; folding it
      // must close the member at that time, not at fold/resume time.
      const endedAt = eventTime(event)
      if (data.outcome === 'failed') store.onFailed(agentId, 'failed', endedAt)
      else if (data.outcome === 'cancelled') store.onCancelled(agentId, 'cancelled', undefined, endedAt)
      else store.onCompleted(agentId, undefined, undefined, endedAt)
    } else {
      return
    }
    if (!historical) {
      syncNow()
      getState().emit()
    }
  }
  /** Seed the dashboard from the durable parent log at bind/resume: catalog
   * children and workflow members survive a restart. Historical children the
   * registry no longer holds stay card-less (dashboard-only, `unknown`). */
  const bootstrapFromLog = (events: readonly unknown[]): void => {
    if (!Array.isArray(events)) return
    try {
      for (const event of events) onParentEvent(event, true)
    } catch { /* bootstrap is best-effort discovery; live events remain authoritative */ }
    syncNow()
  }
  const onStart = (info: { id: string; runId?: string; provider: string; local?: boolean }): void => {
    if (!info?.id) return
    // The fact that the host spawned a child is authoritative even when its
    // optional discovery seam is absent, unloading, or throws.
    store.onSpawned(info.id, info.provider || 'subagent', info.provider, {
      runId: info.runId ?? info.id,
      local: info.local,
      startedAt: Date.now(),
      description: pendingTaskDescriptions.shift(),
    })
    cardedIds.add(info.id)
    try {
      const child = deps.lookupChild(info.id)
      if (child?.session) {
        store.linkSession(info.id, child.session)
        const model = child.options?.model ?? child.options?.provider
        if (model) store.patch(info.id, { model, provider: child.options?.provider ?? info.provider })
      }
    } catch { /* child enrichment is optional; the spawn remains visible */ }
    syncNow()
    getState().emit()
  }
  const onEnd = (info: { id: string; runId?: string; stopReason: string; lastAssistantMessage?: unknown[] }): void => {
    if (!info?.id) return
    // Host ordering guarantee: a continuable epoch's `subagent/end` may be
    // published AFTER the next epoch's `subagent/start` already arrived (the
    // parent delivery runs before the ownership release). An end that names a
    // runId this row no longer holds belongs to that earlier epoch — the new
    // run must keep running.
    if (info.runId !== undefined) {
      const current = store.get(info.id)
      if (current?.runId !== undefined && current.runId !== info.runId) return
    }
    const output = Array.isArray(info.lastAssistantMessage)
      ? info.lastAssistantMessage.map(block => typeof block === 'object' && block !== null && 'text' in block ? String((block as { text?: unknown }).text ?? '') : '').filter(Boolean).join('\n')
      : ''
    store.flushOutput(info.id)
    if (info.stopReason === 'completed') store.onCompleted(info.id, output, info.stopReason)
    else if (info.stopReason === 'cancelled' || info.stopReason === 'aborted') store.onCancelled(info.id, info.stopReason, output)
    else store.onFailed(info.id, info.stopReason || 'Unknown error')
    syncNow()
    getState().emit()
  }
  const control: SubagentControl = {
    interrupt(agentId) {
      const child = store.get(agentId)
      const target = child?.sessionId ?? agentId
      const runtime = deps.subagents()
      if (!runtime?.interrupt || !target) return false
      try {
        runtime.interrupt(target, { kind: 'ancestor', agent: deps.agent() })
        store.onCancelled(agentId, 'interrupted')
        syncNow()
        getState().emit()
        return true
      } catch { return false }
    },
  }
  const dropRows = (): void => { streamDirty = false; rowsByAgentId.clear() }
  const reset = (): void => { dropRows(); cardedIds.clear(); workflowMembers.clear(); pendingTaskDescriptions.length = 0; store.reset(); getState().subagents = [] }
  return { store, control, pendingTaskDescriptions, onSessionEvent, onStreamFrame, onParentEvent, bootstrapFromLog, onStart, onEnd, syncNow, flush, dropRows, reset }
}
