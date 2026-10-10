import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { randomUUID } from 'node:crypto'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentSession } from '../../agent/session.js'
import { t } from '../../i18n.js'
import { WORKING_GATE_NOTICES } from '../../commands.js'
import { writeModelPref } from '../../modelPrefs.js'
import { touchSession } from '../../sessionHistory.js'
import { createDshSession, dshHandleOf } from '../backend/session.js'
import { liveSessionCreateOptions, sliceLiveSessionSeed, snapshotLiveSessionEvents } from '../compat/index.js'
import { createFreshAgent, isUnstoredFreshSession } from '../fresh-agent.js'
import { composePreset, runningPresetOf } from '../presets.js'
import { holdsNoConversation, latestPolicyFacts, replayPolicyFacts } from '../unspoken-sessions.js'
import { reserveNewSession } from '../../sessionMounts.js'
import { attachSessionToWorkspace } from '../workspace.js'
import type { DshChannelBinding } from './binding.js'
import type { ChannelOwner } from './owner.js'
import { resetSessionProjection } from './session-reset.js'
import { childRecordsLineage } from './session-lineage.js'
import type { ChannelState } from './types.js'

type Binding = DshChannelBinding
type SwitchState = Parameters<typeof resetSessionProjection>[0] & Pick<ChannelState,
  'cwd' | 'working' | 'status' | 'agentId' | 'sessionId' | 'agentPreset' | 'provider' | 'model' | 'contextWindow' | 'effortLevels' | 'reasoningEffort' | 'emit'>

/** Model-route adoption transaction. It settles compaction before its fork snapshot and owns the post-commit reset. */
export function createModelSwitchAction(
  ctx: Context,
  state: SwitchState,
  deps: {
    owner: Pick<ChannelOwner, 'current'>
    binding: Pick<Binding, 'agent' | 'capture' | 'prepare' | 'isCurrent' | 'abandon' | 'adopt'>
    rowIds: { value: number }
    settleCompaction(): Promise<void>
    resetProjector(): void
    resetSubagents(): void
    resetJobs(): void
    replay(events: readonly SessionEvent[]): void
    settleReplay(): void
    bindAgent(): void
    refreshCommands(): void
    refreshLoadedContext(): Promise<void>
    refreshSkillCommands(): Promise<void>
    clearStagedImages(): void
    dropModelCompletion(): void
    notify: ChannelState['notify']
  },
) {
  return async (provider: string, model: string): Promise<boolean> => {
    const adoption = deps.binding.capture()
    if (state.working) { deps.notify(t(WORKING_GATE_NOTICES.model), { color: 'warning' }); return false }
    const agents = ctx.get('agents') as { create(options: CreateAgentOptions): Promise<AgentHandle> } | undefined
    if (agents === undefined) { deps.notify(t('model-switch-unavailable'), { color: 'error' }); return false }
    const source = deps.binding.agent.session
    // The cut is what the child inherits, so the cut is what the verdict asks
    // about — never the session it was cut from. A `/model` cut is the whole
    // source log, but the same verdict serves the actions whose cut can stop
    // short of the conversation (`/rewind`, `/tree`): judging the source there
    // would say "this one holds a conversation" while the prefix on offer holds
    // the initialization alone. A seed would copy that prefix, and the host
    // stores every seed at publication (agent-loop `appendUnstoredSuffix`), so
    // the replacement's log would exist before its first real event — the
    // permission-only shell the fresh-session deferral keeps out of JSONL. The
    // evidence is read from the slice already in hand (in memory, never a
    // second read of the log), so a shell left behind by an earlier process
    // counts exactly like a local one; the fresh verdict answers first, so a
    // deferred session is not even sliced. The replacement therefore starts
    // unseeded, as an ordinary fresh session, under that same deferral.
    let seed: readonly SessionEvent[]
    // The cut: what the child would inherit — here the whole settled source
    // log. It is read even when the verdict below empties the seed, because the
    // cut is also where the session's POLICY FACTS live.
    let cut: readonly SessionEvent[]
    const neverUsed = isUnstoredFreshSession(source)
    try {
      // A compaction checkpoint may not settle after the model fork snapshot —
      // and the cut must be read from the settled log, never from before it.
      await deps.settleCompaction()
      // A never-used source holds its initialization alone, so its own snapshot
      // IS the cut; a used one is sliced from the SOURCE snapshot —
      // sessions.fork() registers a real child, and its snapshot length is not
      // the inherited cut.
      cut = neverUsed ? snapshotLiveSessionEvents(source) : sliceLiveSessionSeed(source)
      // The never-used shortcut answers first; the cut criterion behind it has
      // one source: unspoken-sessions.ts.
      seed = neverUsed || holdsNoConversation(cut) ? [] : cut
    } catch (error) { deps.notify(t('model-switch-fork-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error' }); return false }
    const cutHoldsNoConversation = seed.length === 0
    // An unseeded child copies nothing, so the cut's policy facts are all it
    // still inherits: without them it falls back to the deployment defaults,
    // which may be WIDER than the session it came from (CR-1).
    const policyFacts = cutHoldsNoConversation ? latestPolicyFacts(cut) : []
    const childId = SessionId(randomUUID())
    // Announce the id before the factory: from the moment `agents.create`
    // returns this process holds the only write handle on a log the publisher
    // will not name until its next beat.
    const { reservation } = await reserveNewSession(String(childId))
    const composed = await composePreset(ctx, runningPresetOf(source))
    let candidate: AgentSession
    try {
      const create = (): Promise<AgentHandle> => cutHoldsNoConversation
        // No seed and no parent either: a cut that holds no conversation has
        // nothing for lineage to describe, and the child stands as its own root
        // (session-lineage.ts).
        ? createFreshAgent(ctx, agents, {
          sessionId: childId,
          meta: { cwd: state.cwd, ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }) },
          agentOptions: { provider, model },
          setup: composed.setup,
        })
        : agents.create(liveSessionCreateOptions({
          sessionId: childId,
          seed,
          runtimeSession: source,
          inheritedCount: seed.length,
          cwd: state.cwd,
          // A session nobody has typed into has no conversation to relate, and
          // lineage would cost its first real prompt the generated title — the
          // child stands as its own root instead (session-lineage.ts).
          parentSession: childRecordsLineage(seed) ? source.id : undefined,
          agentPreset: composed.agentPreset,
          agentOptions: { provider, model },
          setup: composed.setup,
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
    } catch (error) { reservation.abandon(); deps.notify(t('model-switch-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 }); return false }
    try { await attachSessionToWorkspace(ctx, state.cwd, childId) }
    catch (error) { deps.notify(t('model-switch-attach-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'warning', timeoutMs: 8000 }) }
    if (!deps.binding.isCurrent(adoption) || !deps.owner.current()) { await deps.binding.abandon(candidate); reservation.abandon(); return false }
    const handle = dshHandleOf(candidate)
    let committed = false
    try {
      const result = deps.binding.adopt<boolean>(candidate, adoption, (_previous, disposePrevious) => {
        resetSessionProjection(state, deps.rowIds, deps.resetProjector, deps.resetSubagents, deps.resetJobs)
        state.status = handle.agent.status
        state.agentId = handle.agent.id
        state.sessionId = handle.agent.session.id
        state.agentPreset = composed.agentPreset
        state.provider = provider
        state.model = model
        state.contextWindow = undefined
        state.effortLevels = undefined
        state.reasoningEffort = undefined
        deps.dropModelCompletion()
        deps.replay(seed)
        deps.settleReplay()
        state.working = handle.agent.status === 'running'
        // Reset the input FIFO and pending-decision indicators BEFORE the first
        // emit: a submit from a session-changed subscriber must not chain onto
        // the replaced session's parked promise (main's bind → clear → refresh
        // order).
        deps.clearStagedImages()
        deps.bindAgent()
        deps.refreshCommands()
        void deps.refreshLoadedContext()
        void deps.refreshSkillCommands()
        touchSession(childId)
        state.emit()
        disposePrevious('dispose')
        if (!writeModelPref(provider, model)) deps.notify(t('model-pref-write-failed'), { color: 'warning' })
        return true
      })
      committed = true
      return result
    } finally {
      if (committed) reservation.settle()
      else reservation.abandon()
    }
  }
}
