import type { Agent, AssistantStreamFrame, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import type { AgentEvent, AgentEventOf } from '../../agent/events.js'
import type { ChannelProjection } from '../../channel/projection.js'
import type { InputConvergence } from './input-actions.js'
import type { ChannelBinding } from './binding.js'
import type { ChannelOwner } from './owner.js'
import type { ChannelState } from './types.js'

/**
 * Foreground transcript listeners capture a binding generation: the bound
 * `AgentSession`'s event batches feed the shared projector, and the DSH
 * specialists read the raw main-session events through `native.dsh`. Child
 * (subagent) event listeners instead span the Channel owner, keeping parked
 * reducers current across rebinds. Both paths own registrations incrementally
 * and fence retained callbacks; only the projector presents the foreground
 * transcript.
 */
export function createBindingEvents(ctx: Context, deps: {
  owner: ChannelOwner
  binding: ChannelBinding
  state: ChannelState
  /** Read the activity projection's current value for a freshly bound session.
   *  A projection value only arrives when it changes, so a resumed or
   *  reattached session needs this read to show its line before the next event.
   *  The line's semantics live in the working-activity plugin: this app folds
   *  nothing itself and forwards no events. */
  seedActivity?(session: unknown): void
  inputConvergence: InputConvergence
  selection: ModelSelectionRef
  modelActions: { applyPreferredEffort(): Promise<void>; selection: ModelSelectionRef }
  modeActions: { refreshMode(): void; onSessionEvent(session: unknown, event: unknown): void }
  projector: ChannelProjection
  subagents: {
    onSessionEvent(session: unknown, event: unknown): boolean
    onStreamFrame?(agent: unknown, frame: AssistantStreamFrame): boolean
    onStart(info: { id: string; runId?: string; provider: string; local?: boolean }, parent: object | null): void
    onEnd(info: { id: string; runId?: string; stopReason: string; lastAssistantMessage?: unknown[] }, parent: object | null): void
    forget?(agent: Agent): void
  }
  agentView: { schedule(): void }
  messageObserver?: { publish(session: unknown, event: unknown): void }
  /** Drop a pre-step attachment registered by this channel for one message id
   *  (input-delivery's `retireAttachment`); see the discard hook below.
   *  Optional for direct/embed constructors that never emit inbox discards;
   *  channel.ts always wires it. */
  retireAttachment?(messageId: string): void
}) {
  let subagentsInstalled = false
  const installSubagents = (): void => {
    if (subagentsInstalled) return
    subagentsInstalled = true
    // Child reducers span foreground bindings. One owner subscription keeps
    // parked stores current; only the active reducer publishes view changes.
    deps.owner.own(ctx.on('session/event', (session, event) => {
      if (deps.owner.current()) deps.subagents.onSessionEvent(session, event)
    }))
    deps.owner.own(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (deps.owner.current()) deps.subagents.onStreamFrame?.(agent, frame)
    }))
    // Cordis binds the dispatch receiver as `this`. The upstream carrier
    // names the direct delegating parent, even for external children absent
    // from agents.get(); its ancestor-inclusive filter cannot identify it.
    deps.owner.own(ctx.on('subagent/start' as never, (function (this: unknown, info: Parameters<typeof deps.subagents.onStart>[0]) {
      if (deps.owner.current()) deps.subagents.onStart(info, carrierKeyOf(this) ?? null)
    }) as never))
    deps.owner.own(ctx.on('subagent/end' as never, (function (this: unknown, info: Parameters<typeof deps.subagents.onEnd>[0]) {
      if (deps.owner.current()) deps.subagents.onEnd(info, carrierKeyOf(this) ?? null)
    }) as never))
    deps.owner.own(ctx.on('agent/disposed', ({ agent }) => {
      if (deps.owner.current()) deps.subagents.forget?.(agent)
    }))
  }
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

  /** `agent/status` / `agent/disposed` as the session reports them. */
  const applyStatus = (status: 'idle' | 'running' | 'requires-action' | 'disposed'): void => {
    if (status === 'disposed') {
      deps.state.status = 'disposed'
      reconcileRetiredProjection('disposed')
      deps.state.emit()
      return
    }
    // A DSH agent is only ever idle or running; a parked prompt is mid-turn.
    deps.state.status = status === 'idle' ? 'idle' : 'running'
    if (status === 'idle') reconcileRetiredProjection('idle')
    deps.state.emit()
  }
  /**
   * The backend queue lost inputs. Both a claim and a discard retire the
   * pending preview, but ONLY a discard retires an attached-context entry: a
   * claim fires while the loop claims the batch, BEFORE the resident
   * `agent/pre-step` listener can append the attachment — retiring there would
   * delete the context before it is ever injected.
   */
  const applyPending = (event: AgentEventOf<'pending.changed'>): void => {
    for (const messageId of event.discarded ?? []) deps.retireAttachment?.(messageId)
    for (const messageId of [...event.claimed ?? [], ...event.discarded ?? []]) {
      const before = deps.state.pending.length
      deps.state.pending = deps.state.pending.filter(item => item.id !== messageId)
      if (deps.state.pending.length !== before) deps.state.emit()
    }
  }

  const bind = (): void => {
    try {
      deps.state.agentBindingGeneration = deps.binding.bind()
      // DSH specialists attach only to a DSH session (design §3.5).
      if (deps.binding.session.capabilities.native.dsh !== undefined) installSubagents()
      deps.inputConvergence.cancelInFlight = false
      deps.inputConvergence.interruptSeq += 1
      deps.seedActivity?.(deps.binding.agent.session)
      deps.modelActions.selection.current = undefined
      deps.modelActions.selection.assembled = undefined
      if (deps.binding.agent.options?.model === undefined && deps.state.provider !== '' && deps.state.model !== '') {
        deps.modelActions.selection.current = { provider: deps.state.provider, model: deps.state.model }
      }
      void deps.modelActions.applyPreferredEffort()
      deps.modeActions.refreshMode()
      const capture = deps.binding.capture()
      const session = capture.session
      const native = session.capabilities.native.dsh
      const current = (): boolean => deps.owner.current() && deps.binding.isCurrent(capture)
      const register = <T extends () => void>(dispose: T): T => {
        deps.binding.subscribe(dispose)
        return dispose
      }

      if (native !== undefined) {
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
        // Raw durable events for the DSH specialists. Registered before the
        // session subscription, so each event reaches them before the
        // projector folds it (the pre-split listener order).
        register(native.subscribeRaw(event => {
          if (!current()) return
          deps.messageObserver?.publish(native.agent.session, event)
          deps.modeActions.onSessionEvent(native.agent.session, event)
        }))
      }
      register(session.subscribe((batch, meta) => {
        // The generation fence covers the WHOLE batch, whatever it carries: a
        // callback retained past a rebind (an in-flight dispatch, a compaction
        // summary stream that outlived the binding it started under) must
        // never write the replacement session's transcript.
        if (!current()) return
        let admitted: AgentEvent[] | undefined
        let progressOnly = batch.length > 0
        for (const [index, event] of batch.entries()) {
          switch (event.type) {
            case 'session.status':
              applyStatus(event.status)
              break
            case 'pending.changed':
              applyPending(event)
              break
            case 'compaction.progress':
              // Summary output only advances a compaction row that is open; a
              // stale stream after the row closed finds nothing to advance.
              if (deps.state.compaction === undefined) {
                admitted ??= batch.slice(0, index)
                continue
              }
              break
            default:
              break
          }
          if (event.type !== 'compaction.progress') progressOnly = false
          admitted?.push(event)
        }
        const events = admitted ?? batch
        if (progressOnly) {
          // Pure summary progress: frame-coalesced like the stream it counts.
          if (events.length === 0) return
          deps.projector.apply(events, meta)
          deps.state.emitStream()
          return
        }
        // The one writer of the foreground transcript.
        deps.projector.apply(events, meta)
        if (meta.wake === 'frame') deps.state.emitStream()
        else if (meta.wake !== 'none') deps.state.emit()
      }))
    } catch (error) {
      deps.owner.dispose()
      throw error
    }
  }
  return { bind }
}
