import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { randomUUID } from 'node:crypto'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { t } from '../../i18n.js'
import { writeModelPref } from '../../modelPrefs.js'
import { touchSession } from '../../sessionHistory.js'
import { liveSessionCreateOptions, sliceLiveSessionSeed } from '../compat/index.js'
import { composePreset, runningPresetOf } from '../presets.js'
import { attachSessionToWorkspace } from '../workspace.js'
import type { createChannelBinding } from './binding.js'
import type { ChannelOwner } from './owner.js'
import { resetSessionProjection } from './session-reset.js'
import type { ChannelState } from './types.js'

type Binding = ReturnType<typeof createChannelBinding>
type SwitchState = Parameters<typeof resetSessionProjection>[0] & Pick<ChannelState,
  'cwd' | 'working' | 'status' | 'agentId' | 'agentPreset' | 'provider' | 'model' | 'contextWindow' | 'effortLevels' | 'reasoningEffort' | 'emit'>

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
    onModelSwitch(model: string): void
    notify: ChannelState['notify']
  },
) {
  return async (provider: string, model: string): Promise<boolean> => {
    const adoption = deps.binding.capture()
    if (state.working) { deps.notify(t('model-switch-while-working'), { color: 'warning' }); return false }
    const agents = ctx.get('agents') as { create(options: CreateAgentOptions): Promise<AgentHandle> } | undefined
    if (agents === undefined) { deps.notify(t('model-switch-unavailable'), { color: 'error' }); return false }
    let seed: readonly SessionEvent[]
    try {
      // A compaction checkpoint may not settle after the model fork snapshot.
      await deps.settleCompaction()
      // No boundary = the whole source log (continue the conversation). Slice
      // the SOURCE snapshot: sessions.fork() registers a real child, and its
      // snapshot length is not the inherited cut.
      seed = sliceLiveSessionSeed(deps.binding.agent.session)
    } catch (error) { deps.notify(t('model-switch-fork-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error' }); return false }
    const childId = SessionId(randomUUID())
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
        agentOptions: { provider, model },
        setup: composed.setup,
      })))
    } catch (error) { deps.notify(t('model-switch-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 }); return false }
    try { await attachSessionToWorkspace(ctx, state.cwd, childId) }
    catch (error) { deps.notify(t('model-switch-attach-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'warning', timeoutMs: 8000 }) }
    if (!deps.binding.isCurrent(adoption) || !deps.owner.current()) { await deps.binding.abandon(handle); return false }
    return deps.binding.adopt(handle, adoption, (_previous, disposePrevious) => {
      resetSessionProjection(state, deps.rowIds, deps.resetProjector, deps.resetSubagents, deps.resetJobs)
      state.status = handle.agent.status
      state.agentId = handle.agent.id
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
      deps.onModelSwitch(model)
      deps.refreshCommands()
      void deps.refreshLoadedContext()
      void deps.refreshSkillCommands()
      touchSession(childId)
      state.emit()
      disposePrevious('dispose')
      if (!writeModelPref(provider, model)) deps.notify(t('model-pref-write-failed'), { color: 'warning' })
      return true
    })
  }
}
