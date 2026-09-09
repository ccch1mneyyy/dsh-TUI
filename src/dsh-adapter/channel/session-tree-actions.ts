import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { t } from '../../i18n.js'
import { appendInterruptedTurnEnd, ensureLegacySessionEventTypes, liveSessionCreateOptions, liveSessionOffset, snapshotLiveSessionEvents } from '../compat/index.js'
import { composePreset, resolvePersistedPreset, runningPresetOf } from '../presets.js'
import { attachSessionToWorkspace } from '../workspace.js'
import { forkTarget, rewindTarget, turnUserText } from '../sessionTree.js'
import type { createChannelBinding } from './binding.js'
import type { ChannelOwner } from './owner.js'
import type { ChannelState } from './types.js'

type Binding = ReturnType<typeof createChannelBinding>
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
    adoptForkedAgent(handle: AgentHandle, capture: ReturnType<Binding['capture']>, seed: readonly SessionEvent[], agentPreset: string | undefined, childId: SessionId): string
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
      const persistence = ctx.get('sessionPersistence') as { load(id: SessionId): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }> } | undefined
      if (!persistence || typeof persistence.load !== 'function') {
        deps.notify(t('rewind-no-persistence'), { color: 'error' })
        return null
      }
      try {
        ensureLegacySessionEventTypes()
        const loaded = await persistence.load(SessionId(sessionId))
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
    const seed = sourceEvents.filter(event => event.seq <= target.boundary)
    const inheritedCount = seed.length
    if (target.closeTurn !== undefined) {
      appendInterruptedTurnEnd(seed, target.closeTurn)
    }
    let handle: AgentHandle
    try {
      handle = await deps.binding.prepare(adoption, () => agents.create(liveSessionCreateOptions({
        sessionId: childId,
        seed,
        runtimeSession: entrySession,
        inheritedCount,
        cwd: sourceCwd,
        parentSession: SessionId(sessionId),
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
      await attachSessionToWorkspace(ctx, sourceCwd, childId)
    } catch (error) {
      deps.notify(t('rewind-attach-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'warning', timeoutMs: 8000 })
    }
    if (!deps.owner.current() || deps.binding.agent.session !== entrySession) {
      await deps.binding.abandon(handle)
      deps.notify(t('rewind-session-changed'), { color: 'error' })
      return null
    }
    const sourceSessionId = deps.adoptForkedAgent(handle, adoption, seed, composed.agentPreset, childId)
    deps.notifySessionSwitched(mode === 'fork' ? 'fork' : 'rewind', String(childId), sourceSessionId)
    return restoredText
  }
}
