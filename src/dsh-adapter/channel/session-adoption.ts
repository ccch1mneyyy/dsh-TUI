import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ChannelState } from './types.js'
import type { createChannelBinding } from './binding.js'
import { resetSessionProjection } from './session-reset.js'

type Binding = ReturnType<typeof createChannelBinding>
type AdoptionState = Pick<
  ChannelState,
  | 'status'
  | 'agentId'
  | 'agentPreset'
  | 'working'
  | 'emit'
>

/**
 * Binding-transaction tails shared by session actions. Construction is inert:
 * callers install the returned operations only after their ChannelState exists.
 */
export function createSessionAdoption(
  state: AdoptionState & Parameters<typeof resetSessionProjection>[0],
  deps: {
    binding: Pick<Binding, 'adopt'>
    rowIds: { value: number }
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
    touchSession(sessionId: SessionId): void
  },
) {
  /**
   * Commit a prepared rewind/fork candidate through the sole binding writer.
   * The transaction resets only after ownership is committed; setup remains
   * synchronous so subscriptions cannot observe a half-reset projection.
   */
  const adoptForkedAgent = (
    handle: AgentHandle,
    capture: ReturnType<Binding['capture']>,
    seed: readonly SessionEvent[],
    agentPreset: string | undefined,
    childId: SessionId,
  ): string => deps.binding.adopt(handle, capture, (previous, disposePrevious) => {
    const sourceSessionId = String(previous.agent.session.id)
    resetSessionProjection(state, deps.rowIds, deps.resetProjector, deps.resetSubagents, deps.resetJobs)
    state.status = handle.agent.status
    state.agentId = handle.agent.id
    state.agentPreset = agentPreset
    deps.replay(seed)
    deps.settleReplay()
    state.working = handle.agent.status === 'running'
    // Reset the input FIFO and pending-decision indicators BEFORE the first
    // emit: a submit from a session-changed subscriber must not chain onto the
    // replaced session's parked promise (main's bind → clear → refresh order).
    deps.clearStagedImages()
    deps.bindAgent()
    deps.refreshCommands()
    void deps.refreshLoadedContext()
    void deps.refreshSkillCommands()
    deps.touchSession(childId)
    state.emit()
    disposePrevious('dispose')
    return sourceSessionId
  })

  return { adoptForkedAgent }
}
