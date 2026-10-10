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
import { holdsNoConversation, latestPolicyFacts, replayPolicyFacts } from '../unspoken-sessions.js'
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
    // The cut is what the child inherits, so the cut is what the verdict asks
    // about — never the session it was cut from. A rewind boundary can land
    // before every real event: the first message's boundary is the seq before
    // its turn/start, and that turn opens behind the initialization
    // `session/created` wrote (seq 0-2), so the prefix on offer holds the
    // initialization alone while the source is a whole conversation. A seed
    // would copy that prefix, and the host stores every seed at publication
    // (agent-loop `appendUnstoredSuffix`), so the child's log would exist
    // before its first real event — the permission-only shell the fresh-session
    // deferral keeps out of JSONL. Asking the source would say "this one holds
    // a conversation" and seed the shell anyway. There is no history to cut, so
    // such a cut yields an unseeded child instead; the evidence is read from
    // the slice already in hand (in memory, never a second read of the log),
    // and the never-used verdict answers first, so a deferred session is not
    // even sliced.
    let seed: readonly SessionEvent[]
    // The cut: what the child would inherit — the boundary prefix here. It is
    // read even when the verdict below empties the seed, because the cut is
    // also where the session's POLICY FACTS live.
    let cut: readonly SessionEvent[]
    const neverUsed = isUnstoredFreshSession(source)
    try {
      if (boundary < 0) throw new Error('cannot rewind to the very first message')
      // A never-used source holds its initialization alone, so its own snapshot
      // IS the cut; a used one is sliced from the SOURCE snapshot through an
      // inclusive seq. Never sessions.fork(): that registers a real child whose
      // snapshot includes child-owned session/end-seed, so snapshot.length is
      // not the inherited cut. agents.create owns the new session id.
      cut = neverUsed ? snapshotLiveSessionEvents(source) : sliceLiveSessionSeed(source, boundary)
      // The never-used shortcut answers first; the cut criterion behind it has
      // one source: unspoken-sessions.ts.
      seed = neverUsed || holdsNoConversation(cut) ? [] : cut
    } catch (error) {
      deps.notify(t('rewind-fork-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error' })
      return null
    }
    const cutHoldsNoConversation = seed.length === 0
    // An unseeded child copies nothing, so the cut's policy facts are all it
    // still inherits: without them it falls back to the deployment defaults,
    // which may be WIDER than the session it came from (CR-1).
    const policyFacts = cutHoldsNoConversation ? latestPolicyFacts(cut) : []
    const composed = await composePreset(ctx, runningPresetOf(source))
    // Announce the id before the factory: the rewind creates the child's log
    // here, and the publisher only learns the id from the registry on its next
    // beat.
    const { reservation } = await reserveNewSession(String(childId))
    let candidate: AgentSession
    try {
      const create = (): Promise<AgentHandle> => cutHoldsNoConversation
        // No seed and no parent: a cut that holds no conversation has no
        // history to inherit and nothing for lineage to describe, so the child
        // is an ordinary fresh session and stands as its own root
        // (session-lineage.ts).
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
            // The cut keeps pre-turn inbox insertions but drops their claims.
            // Newer hosts replay those inherited splices, so cancel the restored
            // queue durably in the CHILD before publication or preset setup.
            // Clearing only state.pending would hide, not revoke, the old work.
            agent.inbox.clear()
            return composed.setup?.(agentCtx, agent)
          },
        }))
      candidate = await deps.binding.prepare(adoption, async () => {
        const handle = await create()
        // AFTER the factory returns, never inside its `setup`: an append there
        // would leave `seq !== 0` and the deferral would return in silence
        // (KNOWN-ISSUES B-14 ①). Before the first real event, so the replay can
        // never overtake work the person actually did in the child.
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
