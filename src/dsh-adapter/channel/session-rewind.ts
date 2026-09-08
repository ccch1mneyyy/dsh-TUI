import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { t } from '../../i18n.js'
import { liveSessionCreateOptions, liveSessionOffset, sliceLiveSessionSeed, snapshotLiveSessionEvents } from '../compat/index.js'
import { dispatchTuiDecision } from '../extension-events.js'
import { normalizeRewindDoneSummary } from './decisions.js'
import { composePreset, runningPresetOf } from '../presets.js'
import { attachSessionToWorkspace } from '../workspace.js'
import type { createChannelBinding } from './binding.js'
import type { ChannelOwner } from './owner.js'
import type { ChannelState, ChatRow } from './types.js'

type Binding = ReturnType<typeof createChannelBinding>
type RewindState = Pick<ChannelState, 'working' | 'cwd' | 'provider' | 'model'>

async function waitForTurnEnd(
  session: unknown,
  fromSeq: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const last = snapshotLiveSessionEvents(session).at(-1)
    if (last !== undefined && last.type === 'turn/end' && last.seq >= fromSeq) return true
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return false
}

/** Rewind a selected transcript row into a prepared, binding-owned fork. */
export function createRewindToAction(
  ctx: Context,
  state: RewindState,
  deps: {
    owner: Pick<ChannelOwner, 'current'>
    binding: Pick<Binding, 'agent' | 'capture' | 'prepare' | 'isCurrent' | 'abandon'>
    settleCompaction(): Promise<void>
    notify: ChannelState['notify']
    adoptForkedAgent(handle: AgentHandle, capture: ReturnType<Binding['capture']>, seed: readonly SessionEvent[], agentPreset: string | undefined, childId: SessionId): string
    notifySessionSwitched(kind: 'rewind', sessionId: string, previousSessionId: string): void
  },
) {
  return async (row: ChatRow, mode: string | null = null): Promise<string | null> => {
    if (row.seq === undefined) return null
    const adoption = deps.binding.capture()
    const agents = ctx.get('agents') as { create(options: CreateAgentOptions): Promise<AgentHandle> } | undefined
    if (!agents) {
      deps.notify(t('rewind-unavailable'), { color: 'error' })
      return null
    }
    const wasWorking = state.working
    const cancelSeq = liveSessionOffset(deps.binding.agent.session)
    if (wasWorking) deps.binding.agent.cancel({ kind: 'user' })
    if (wasWorking && !await waitForTurnEnd(deps.binding.agent.session, cancelSeq, 30000)) {
      deps.notify(t('rewind-settling'), { color: 'error' })
      return null
    }
    await deps.settleCompaction()
    const childId = SessionId(randomUUID())
    const events = snapshotLiveSessionEvents(deps.binding.agent.session)
    let boundary = row.seq
    for (let i = row.seq; i >= 0; i--) {
      const event = events[i]
      if (event === undefined) break
      if (event.type === 'turn/start') { boundary = event.seq - 1; break }
      if (event.type === 'turn/end') break
    }
    let seed: readonly SessionEvent[]
    try {
      if (boundary < 0) throw new Error('cannot rewind to the very first message')
      // Slice the SOURCE snapshot through an inclusive seq. Never
      // sessions.fork(): that registers a real child whose snapshot includes
      // child-owned session/end-seed, so snapshot.length is not the inherited
      // cut. agents.create owns the new session id.
      seed = sliceLiveSessionSeed(deps.binding.agent.session, boundary)
    } catch (error) {
      deps.notify(t('rewind-fork-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error' })
      return null
    }
    const composed = await composePreset(ctx, runningPresetOf(deps.binding.agent.session))
    let handle: AgentHandle
    try {
      handle = await deps.binding.prepare(adoption, () => agents.create(liveSessionCreateOptions({
        sessionId: childId,
        seed,
        runtimeSession: deps.binding.agent.session,
        inheritedCount: seed.length,
        cwd: state.cwd,
        parentSession: deps.binding.agent.session.id,
        agentPreset: composed.agentPreset,
        agentOptions: { provider: state.provider, model: state.model },
        setup: composed.setup,
      })))
    } catch {
      deps.notify(t('rewind-create-failed'), { color: 'error' })
      return null
    }
    if (!deps.binding.isCurrent(adoption)) { await deps.binding.abandon(handle); return null }
    try {
      await attachSessionToWorkspace(ctx, state.cwd, childId)
    } catch (error) {
      deps.notify(t('rewind-attach-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'warning', timeoutMs: 8000 })
    }
    if (!deps.owner.current()) { await deps.binding.abandon(handle); return null }
    const sourceSessionId = deps.adoptForkedAgent(handle, adoption, seed, composed.agentPreset, childId)
    try {
      void dispatchTuiDecision(ctx, 'tui/rewind-done', {
        text: row.text,
        mode,
        boundarySeq: boundary,
        sourceSessionId,
        childSessionId: String(childId),
        sessionId: String(childId),
        cwd: state.cwd,
      }, normalizeRewindDoneSummary).then(summary => {
        if (typeof summary === 'string') deps.notify(summary, { timeoutMs: 6000 })
      }).catch((error: unknown) => ctx.logger.warn('dsh-tui: tui/rewind-done dispatch failed: %o', error))
    } catch (error) {
      ctx.logger.warn('dsh-tui: tui/rewind-done dispatch failed: %o', error)
    }
    deps.notifySessionSwitched('rewind', String(childId), sourceSessionId)
    return row.text
  }
}
