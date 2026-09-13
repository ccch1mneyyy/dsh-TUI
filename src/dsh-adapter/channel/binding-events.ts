import type { AssistantStreamFrame, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { InputConvergence } from './input-actions.js'
import type { ChannelBinding } from './binding.js'
import type { ChannelOwner } from './owner.js'
import { type createChannelProjection } from './projection.js'
import type { ChannelState } from './types.js'

/**
 * The binding event router is the sole subscriber for a foreground Agent.
 * It captures the binding generation at every listener entry; teardown is
 * incremental and retained callbacks check that captured Agent/session pair
 * before touching state. Transcript presentation remains exclusively owned by
 * ChannelProjection.
 */
export function createBindingEvents(ctx: Context, deps: {
  owner: ChannelOwner
  binding: ChannelBinding
  state: ChannelState
  activity: {
    start(agent: ChannelBinding['agent']): void
    stop(): void
    onAgentStatus(status: ChannelBinding['agent']['status']): unknown
    onSessionEvent(event: unknown): unknown
  }
  inputConvergence: InputConvergence
  selection: ModelSelectionRef
  modelActions: { applyPreferredEffort(): Promise<void>; selection: ModelSelectionRef }
  modeActions: { refreshMode(): void; onSessionEvent(session: unknown, event: unknown): void }
  projector: ReturnType<typeof createChannelProjection>
  subagents: { onSessionEvent(session: unknown, event: unknown): boolean; onStreamFrame?(agent: unknown, frame: AssistantStreamFrame): boolean; onStart(info: { id: string; runId?: string; provider: string; local?: boolean }): void; onEnd(info: { id: string; stopReason: string; lastAssistantMessage?: unknown[] }): void }
  agentView: { schedule(): void }
  messageObserver?: { publish(session: unknown, event: unknown): void }
}) {
  const reconcileRetiredProjection = (status: 'idle' | 'disposed'): void => {
    if (!deps.state.working) return
    ctx.logger.warn(`dsh-tui: agent became ${status} while the channel still projected an open turn; releasing volatile UI gates`)
    deps.inputConvergence.cancelInFlight = false
    deps.state.cancelPending = false
    deps.state.working = false
    deps.state.activeToolCount = 0
    deps.projector.settleStreaming()
    deps.projector.updateSpinnerMode()
  }

  const bind = (): void => {
    try {
      deps.state.agentBindingGeneration = deps.binding.bind()
      deps.inputConvergence.cancelInFlight = false
      deps.inputConvergence.interruptSeq += 1
      deps.activity.start(deps.binding.agent)
      deps.modelActions.selection.current = undefined
      deps.modelActions.selection.assembled = undefined
      if (deps.binding.agent.options?.model === undefined && deps.state.provider !== '' && deps.state.model !== '') {
        deps.modelActions.selection.current = { provider: deps.state.provider, model: deps.state.model }
      }
      void deps.modelActions.applyPreferredEffort()
      deps.modeActions.refreshMode()
      const capture = deps.binding.capture()
      const session = capture.agent.session
      const current = (): boolean => deps.owner.current() && deps.binding.isCurrent(capture)
      const register = <T extends () => void>(dispose: T): T => {
        deps.binding.subscribe(dispose)
        return dispose
      }
      const on = (...args: Parameters<typeof ctx.on>): ReturnType<typeof ctx.on> => register(ctx.on(...args))

      // Keep the upstream assembly/request pairing, but own each listener as
      // soon as it is installed. The upstream combined disposer is too late
      // if request registration throws, and its post-await assembly write is
      // unsafe after a rebind (including A→B→A ABA).
      const disposeAssembly = capture.agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const selected = deps.selection.current
        const assembled = await next()
        if (!current()) return assembled
        deps.selection.assembled = selected
        if (selected === undefined) return assembled
        return {
          ...assembled,
          variables: {
            ...assembled.variables,
            provider: selected.provider,
            model: selected.model,
          },
        }
      })
      register(disposeAssembly)
      const disposeRequest = capture.agent.ctx.on('agent/request', async (_payload, next) => {
        const resolved = await next()
        if (!current()) return resolved
        const selected = deps.selection.assembled
        if (selected === undefined) return resolved
        const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
        return {
          ...withoutInheritedEffort,
          provider: selected.provider,
          model: selected.model,
          ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
        }
      })
      register(disposeRequest)
      on('agent/status', ({ agent: subject, status }) => {
        if (!current() || subject !== capture.agent) return
        deps.state.status = status
        deps.activity.onAgentStatus(status)
        if (status === 'idle') reconcileRetiredProjection('idle')
        deps.state.emit()
      })
      on('agent/disposed', ({ agent: subject }) => {
        if (!current() || subject !== capture.agent) return
        deps.state.status = 'disposed'
        deps.activity.stop()
        reconcileRetiredProjection('disposed')
        deps.state.emit()
      })
      const retirePending = (payload: { agent: unknown; message: { id?: unknown } }): void => {
        if (!current() || payload.agent !== capture.agent) return
        const messageId = payload.message?.id
        if (typeof messageId !== 'string') return
        const before = deps.state.pending.length
        deps.state.pending = deps.state.pending.filter(item => item.id !== messageId)
        if (deps.state.pending.length !== before) deps.state.emit()
      }
      on('agent/inbox/claimed', retirePending)
      on('agent/inbox/discarded', retirePending)
      on('session/event', (subject, event) => {
        if (!current()) return
        const isMainSession = subject === session
        if (!isMainSession && deps.subagents.onSessionEvent(subject, event)) return
        if (!isMainSession) return
        deps.messageObserver?.publish(subject, event)
        deps.activity.onSessionEvent(event)
        deps.modeActions.onSessionEvent(subject, event)
        deps.projector.renderEvent(event)
        if (event.type === 'assistant/chunk') deps.state.emitStream()
        else deps.state.emit()
      })
      // 0.1.5 live streaming: per-token chunks are transient attempt frames
      // on this agent-scoped channel; the durable settlement still arrives
      // through `session/event` above. Pre-0.1.5 hosts never emit it — the
      // subscription simply stays silent there and chunks keep arriving as
      // `assistant/chunk` session events.
      on('agent/assistant-stream', ({ agent: subject, frame }) => {
        if (!current()) return
        if (subject !== capture.agent) {
          deps.subagents.onStreamFrame?.(subject, frame)
          return
        }
        deps.projector.renderStreamFrame(frame)
        if (frame.type === 'chunk') deps.state.emitStream()
        else if (frame.type === 'end') deps.state.emit()
      })
      on('subagent/start' as never, (info: { id: string; runId?: string; provider: string; local?: boolean }) => {
        if (current()) deps.subagents.onStart(info)
      })
      on('subagent/end' as never, (info: { id: string; stopReason: string; lastAssistantMessage?: unknown[] }) => {
        if (current()) deps.subagents.onEnd(info)
      })
    } catch (error) {
      deps.owner.dispose()
      throw error
    }
  }
  return { bind }
}
