import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import type { AgentSession } from '../../agent/session.js'
import { t } from '../../i18n.js'
import { createDshSession, dshHandleOf } from '../backend/session.js'
import { appendInterruptedTurnEnd, liveSessionCreateOptions, liveSessionOffset, snapshotLiveSessionEvents } from '../compat/index.js'
import { readPersistedSession, type SessionReader } from '../compat/persistence.js'
import { closeLiveForkTurn } from '../compat/liveSession.js'
import { createFreshAgent, isUnstoredFreshSession } from '../fresh-agent.js'
import { composePreset, resolvePersistedPreset, runningPresetOf } from '../presets.js'
import { holdsNoConversation, latestPolicyFacts, replayPolicyFacts } from '../unspoken-sessions.js'
import { attachSessionToWorkspace } from '../workspace.js'
import { reserveNewSession } from '../../sessionMounts.js'
import { forkTarget, rewindTarget, turnUserText } from '../sessionTree.js'
import type { DshChannelBinding } from './binding.js'
import type { ChannelOwner } from './owner.js'
import type { ChannelState } from './types.js'

type Binding = DshChannelBinding
type TreeRewindState = Pick<ChannelState, 'working' | 'cwd' | 'provider' | 'model'>

async function waitForTurnEnd(session: unknown, fromSeq: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const last = snapshotLiveSessionEvents(session).at(-1)
    if (last !== undefined && last.type === 'turn/end' && last.seq >= fromSeq) return true
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return false
}

/** Rewind or fork a selected tree node; loading foreign family logs stays in this persistence adapter seam. */
export function createTreeRewindAction(
  ctx: Context,
  state: TreeRewindState,
  deps: {
    owner: Pick<ChannelOwner, 'current'>
    binding: Pick<Binding, 'agent' | 'capture' | 'isCurrent' | 'prepare' | 'abandon'>
    settleCompaction(): Promise<void>
    notify: ChannelState['notify']
    adoptForkedAgent(candidate: AgentSession, capture: ReturnType<Binding['capture']>, seed: readonly SessionEvent[], agentPreset: string | undefined, childId: SessionId): string
    notifySessionSwitched(kind: 'rewind' | 'fork', sessionId: string, previousSessionId: string): void
  },
) {
  return async (sessionId: string, seq: number, mode: 'rewind' | 'fork' = 'rewind'): Promise<string | null> => {
    const adoption = deps.binding.capture()
    const agents = ctx.get('agents') as { create(options: CreateAgentOptions): Promise<AgentHandle> } | undefined
    if (!agents) {
      deps.notify(t('rewind-unavailable'), { color: 'error' })
      return null
    }
    await deps.settleCompaction()
    const entrySession = deps.binding.agent.session
    const currentId = String(entrySession.id)
    const childId = SessionId(randomUUID())
    let sourceEvents: readonly SessionEvent[]
    let sourceCwd = state.cwd
    let forkFromLive = true
    if (sessionId === currentId) {
      sourceEvents = snapshotLiveSessionEvents(entrySession)
    } else {
      forkFromLive = false
      const persistence = ctx.get('sessionPersistence') as SessionReader | undefined
      if (!persistence || (typeof persistence.open !== 'function' && typeof persistence.load !== 'function')) {
        deps.notify(t('rewind-no-persistence'), { color: 'error' })
        return null
      }
      try {
        const loaded = await readPersistedSession(persistence, SessionId(sessionId))
        sourceEvents = loaded.events
        sourceCwd = loaded.meta.cwd ?? state.cwd
      } catch (error) {
        deps.notify(t('rewind-load-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error' })
        return null
      }
    }
    const target = mode === 'fork' ? forkTarget(sourceEvents, seq) : rewindTarget(sourceEvents, seq)
    if (target.boundary < 0) {
      deps.notify(t('rewind-first-message'), { color: 'error' })
      return null
    }
    if (forkFromLive && !sourceEvents.some(event => event.seq > target.boundary && (
      event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'tool/result'
    ))) {
      deps.notify(t('rewind-noop'), { color: 'warning' })
      return null
    }
    const restoredText = mode === 'fork' ? '' : turnUserText(sourceEvents, seq)
    const sourcePreset = forkFromLive
      ? runningPresetOf(entrySession)
      : ((await resolvePersistedPreset(ctx, SessionId(sessionId))) ?? runningPresetOf(entrySession))
    const composed = await composePreset(ctx, sourcePreset)
    if (!deps.owner.current() || deps.binding.agent.session !== entrySession) {
      deps.notify(t('rewind-session-changed'), { color: 'error' })
      return null
    }
    const wasWorking = state.working
    const cancelSeq = liveSessionOffset(deps.binding.agent.session)
    if (wasWorking) deps.binding.agent.cancel({ kind: 'user' })
    if (wasWorking && !await waitForTurnEnd(deps.binding.agent.session, cancelSeq, 30000)) {
      deps.notify(t('rewind-settling'), { color: 'error' })
      return null
    }
    // The cut is what the child inherits, so the cut is what the verdict asks
    // about — never the session it was cut from. A tree rewind can stop before
    // every real event: the first message's boundary is the seq before its
    // turn/start, and that turn opens behind the initialization
    // `session/created` wrote (seq 0-2), so the prefix on offer holds the
    // initialization alone while the source is a whole conversation. A seed
    // would copy that prefix, and the host stores every seed at publication
    // (agent-loop `appendUnstoredSuffix`), so the child's log would exist
    // before its first real event — the permission-only shell the fresh-session
    // deferral keeps out of JSONL. The evidence is the slice the seed IS, in
    // memory, never a second read of the log. The never-used verdict answers
    // first, and it only speaks for the LIVE source (the deferral is this
    // process's own bookkeeping, and a persisted foreign source is not in it),
    // so a foreign source is judged by its cut alone.
    // The cut: the prefix the child would inherit — the whole source log for a
    // live entry session, a boundary prefix for a tree node. It is read for
    // both halves of the verdict below: which conversation it holds, and which
    // POLICY FACTS it carries (the unseeded branch copies neither, and a child
    // that loses the second falls back to the deployment defaults, which may be
    // WIDER than the session it came from, CR-1).
    const cut = sourceEvents.filter(event => event.seq <= target.boundary)
    // The never-used shortcut answers first, and only for the LIVE source (the
    // deferral is this process's own bookkeeping, and a persisted foreign
    // source is not in it); the cut criterion behind it has one source:
    // unspoken-sessions.ts.
    const neverUsed = forkFromLive && isUnstoredFreshSession(entrySession)
    const seed = neverUsed || holdsNoConversation(cut) ? [] : cut
    const cutHoldsNoConversation = seed.length === 0
    const policyFacts = cutHoldsNoConversation ? latestPolicyFacts(cut) : []
    const inheritedCount = seed.length
    const closeAfterCreate = target.closeTurn !== undefined && entrySession.header?.version >= 3
    if (target.closeTurn !== undefined && !closeAfterCreate) {
      appendInterruptedTurnEnd(seed, target.closeTurn)
    }
    // Announce the id before the factory: the child's log is created here, and
    // the publisher only learns the id from the registry on its next beat.
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
          meta: { cwd: sourceCwd, ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }) },
          agentOptions: { provider: state.provider, model: state.model },
          setup: composed.setup,
        })
        : agents.create(liveSessionCreateOptions({
          sessionId: childId,
          seed,
          runtimeSession: entrySession,
          inheritedCount,
          cwd: sourceCwd,
          parentSession: SessionId(sessionId),
          agentPreset: composed.agentPreset,
          agentOptions: { provider: state.provider, model: state.model },
          setup: closeAfterCreate || mode === 'rewind' ? async (agentCtx, agent) => {
            // V3 requires seed.length === inheritedEventCount. The constructor
            // inserts the inherited marker, then these closers belong to the
            // child and persist before publication, without falsifying the cut.
            if (closeAfterCreate) closeLiveForkTurn(agent.session, target.closeTurn!)
            // Re-editing starts with no historical pending work. Cancel through
            // the child's Inbox so a later resume cannot resurrect the queue.
            // A plain fork deliberately keeps its separate semantics.
            if (mode === 'rewind') agent.inbox.clear()
            return composed.setup?.(agentCtx, agent)
          } : composed.setup,
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
      await attachSessionToWorkspace(ctx, sourceCwd, childId)
    } catch (error) {
      deps.notify(t('rewind-attach-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'warning', timeoutMs: 8000 })
    }
    if (!deps.owner.current() || deps.binding.agent.session !== entrySession) {
      await deps.binding.abandon(candidate)
      reservation.abandon()
      deps.notify(t('rewind-session-changed'), { color: 'error' })
      return null
    }
    const replay = closeAfterCreate || mode === 'rewind' ? snapshotLiveSessionEvents(dshHandleOf(candidate).agent.session) : seed
    // `adoptForkedAgent` is the commit, and it THROWS when the adoption
    // transaction revokes the candidate.
    try {
      const sourceSessionId = deps.adoptForkedAgent(candidate, adoption, replay, composed.agentPreset, childId)
      reservation.settle()
      deps.notifySessionSwitched(mode === 'fork' ? 'fork' : 'rewind', String(childId), sourceSessionId)
      return restoredText
    } catch (error) {
      reservation.abandon()
      throw error
    }
  }
}
