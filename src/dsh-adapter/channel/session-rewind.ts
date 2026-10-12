import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { AgentSession } from '../../agent/session.js'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { t } from '../../i18n.js'
import { createDshSession, dshHandleOf } from '../backend/session.js'
import { liveSessionCreateOptions, liveSessionOffset, sliceLiveSessionSeed, snapshotLiveSessionEvents } from '../compat/index.js'
import { createFreshAgent, isUnstoredFreshSession } from '../fresh-agent.js'
import { dispatchTuiDecision } from '../extension-events.js'
import { normalizeRewindDoneSummary } from './decisions.js'
import { composePreset, runningPresetOf } from '../presets.js'
import { holdsNoConversation, latestPolicyFacts, replayPolicyFacts } from '../session-seed.js'
import { attachSessionToWorkspace } from '../workspace.js'
import { reserveNewSession } from '../../sessionMounts.js'
import type { DshChannelBinding } from './binding.js'
import type { ChannelOwner } from './owner.js'
import type { ChannelState, ChatRow } from './types.js'

type Binding = DshChannelBinding
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
    adoptForkedAgent(candidate: AgentSession, capture: ReturnType<Binding['capture']>, seed: readonly SessionEvent[], agentPreset: string | undefined, childId: SessionId): string
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
    const source = deps.binding.agent.session
    let seed: readonly SessionEvent[]
    let cut: readonly SessionEvent[]
    const neverUsed = isUnstoredFreshSession(source)
    try {
      if (boundary < 0) throw new Error('cannot rewind to the very first message')
      cut = neverUsed ? snapshotLiveSessionEvents(source) : sliceLiveSessionSeed(source, boundary)
      seed = neverUsed || holdsNoConversation(cut) ? [] : cut
    } catch (error) {
      deps.notify(t('rewind-fork-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error' })
      return null
    }
    // A policy-only cut starts fresh; seeded creation would publish it immediately.
    const cutHoldsNoConversation = seed.length === 0
    const policyFacts = cutHoldsNoConversation ? latestPolicyFacts(cut) : []
    const composed = await composePreset(ctx, runningPresetOf(source))
    // Announce the id before the factory: the rewind creates the child's log
    // here, and the publisher only learns the id from the registry on its next
    // beat.
    const { reservation } = await reserveNewSession(String(childId))
    let candidate: AgentSession
    try {
      const create = (): Promise<AgentHandle> => cutHoldsNoConversation
        ? createFreshAgent(ctx, agents, {
          sessionId: childId,
          meta: { cwd: state.cwd, ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }) },
          agentOptions: { provider: state.provider, model: state.model },
          setup: composed.setup,
        })
        : agents.create(liveSessionCreateOptions({
          sessionId: childId,
          seed,
          runtimeSession: source,
          inheritedCount: seed.length,
          cwd: state.cwd,
          parentSession: source.id,
          agentPreset: composed.agentPreset,
          agentOptions: { provider: state.provider, model: state.model },
          setup: async (agentCtx, agent) => {
            agent.inbox.clear()
            return composed.setup?.(agentCtx, agent)
          },
        }))
      candidate = await deps.binding.prepare(adoption, async () => {
        const handle = await create()
        if (cutHoldsNoConversation) replayPolicyFacts(handle.agent.session, policyFacts)
        return createDshSession(ctx, handle)
      })
    } catch {
      reservation.abandon()
      deps.notify(t('rewind-create-failed'), { color: 'error' })
      return null
    }
    if (!deps.binding.isCurrent(adoption)) { await deps.binding.abandon(candidate); reservation.abandon(); return null }
    try {
      await attachSessionToWorkspace(ctx, state.cwd, childId)
    } catch (error) {
      deps.notify(t('rewind-attach-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'warning', timeoutMs: 8000 })
    }
    if (!deps.owner.current()) { await deps.binding.abandon(candidate); reservation.abandon(); return null }
    // `adoptForkedAgent` is the commit: the child is the session this process
    // now drives, so the reservation hands over to the registry. It THROWS when
    // the adoption transaction revokes the candidate, so it is guarded.
    try {
      const sourceSessionId = deps.adoptForkedAgent(candidate, adoption, snapshotLiveSessionEvents(dshHandleOf(candidate).agent.session), composed.agentPreset, childId)
      reservation.settle()
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
    } catch (error) {
      reservation.abandon()
      throw error
    }
  }
}
