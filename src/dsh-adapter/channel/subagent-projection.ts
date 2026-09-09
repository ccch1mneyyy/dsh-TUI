import type { Agent } from '@deepseek-ai/dsh-agent'
import { markChannelReadDirty } from '../../adapter/channel/read-view.js'
import { SubagentActivityStore, type SubagentState } from '../subagents.js'
import type { ChannelState, ChatRow, SubagentControl, SubagentRow } from './types.js'

/** Current-session subagent store, row projection and frame-batched stream
 * bridge. The owning channel installs transport subscriptions; this module
 * only accepts scoped events and never captures a replaceable agent itself. */
export function createSubagentProjection(
  getState: () => Pick<ChannelState, 'rows' | 'subagents' | 'emit' | 'emitStream'>,
  deps: {
    rowIds: { value: number }
    agent(): Agent
    subagents(): { interrupt?(target: string, reason: unknown): void } | undefined
    /** Optional child metadata lookup; failures must not suppress spawning. */
    lookupChild(id: string): { session?: unknown; options?: { provider?: string; model?: string } } | undefined
  },
) {
  const store = new SubagentActivityStore()
  const rowsByAgentId = new Map<string, ChatRow>()
  const pendingTaskDescriptions: string[] = []
  let streamDirty = false

  const syncRows = (snapshot: readonly SubagentState[] = store.snapshot()): void => {
    const state = getState()
    for (const sub of snapshot) {
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
    const id = store.getSubagentIdBySession(session)
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
  const onStart = (info: { id: string; runId?: string; provider: string; local?: boolean }): void => {
    if (!info?.id) return
    // The fact that the host spawned a child is authoritative even when its
    // optional discovery seam is absent, unloading, or throws.
    store.onSpawned(info.id, info.provider || 'subagent', info.provider, {
      runId: info.runId ?? info.id,
      local: info.local,
      description: pendingTaskDescriptions.shift() ?? `${info.provider || 'subagent'} task`,
    })
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
  const onEnd = (info: { id: string; stopReason: string; lastAssistantMessage?: unknown[] }): void => {
    if (!info?.id) return
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
  const reset = (): void => { dropRows(); pendingTaskDescriptions.length = 0; store.reset(); getState().subagents = [] }
  return { store, control, pendingTaskDescriptions, onSessionEvent, onStart, onEnd, syncNow, flush, dropRows, reset }
}
