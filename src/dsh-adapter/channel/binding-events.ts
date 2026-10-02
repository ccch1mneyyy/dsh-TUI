import type { Agent, AssistantStreamFrame, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import { t } from '../../i18n.js'
import { runningPresetOf } from '../presets.js'
import { agentCapabilityEvidence, resolveAgentCapabilities } from './capabilities.js'
import type { InputConvergence } from './input-actions.js'
import type { ChannelBinding } from './binding.js'
import type { ChannelOwner } from './owner.js'
import { type createChannelProjection } from './projection.js'
import { isTokenDelta, tokenDeltaChars } from './usage.js'
import type { ChannelState } from './types.js'

/**
 * Foreground transcript listeners capture a binding generation. Child event
 * listeners instead span the Channel owner, keeping parked reducers current
 * across rebinds. Both paths own registrations incrementally and fence retained
 * callbacks; only ChannelProjection presents the foreground transcript.
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
  /** Read the context-occupancy projection's current value for a freshly bound
   *  session, for the same reason (and with the same plumbing) as
   *  `seedActivity`: the value only arrives when it changes, so a resumed
   *  session needs one baseline read to show its occupancy before the next
   *  request reports usage. */
  seedContextOccupancy?(session: unknown): void
  inputConvergence: InputConvergence
  selection: ModelSelectionRef
  modelActions: { applyPreferredEffort(): Promise<void>; selection: ModelSelectionRef }
  modeActions: { refreshMode(): void; onSessionEvent(session: unknown, event: unknown): void }
  projector: ReturnType<typeof createChannelProjection>
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
  /**
   * Preset of the last binding we announced a capability gap for. The gap is a
   * property of the agent's PRESET, so it is reported once per entry into a
   * preset that lacks it (a rebind to the SAME preset — /rewind —
   * stays quiet; switching away and back reports again). Facts come from
   * `channel/capabilities.ts`, never from a preset-id list: a user preset that
   * adds compaction/pruning back gets no warning at all.
   *
   * A session recording NO preset (rosterless bare `cordis.yml`, or an embed
   * that composes its own leaf) stays silent: nothing there attributes the
   * missing services to a preset choice, and the command-list annotation plus
   * the use-time refusal already say it when it matters. Only the id, not its
   * contents, is read here.
   */
  let announcedPreset: string | undefined
  let announced = false
  const announceCapabilityGap = (): void => {
    const agent = deps.binding.agent
    const presetId = runningPresetOf(agent.session)
    if (presetId === undefined) return
    if (announced && presetId === announcedPreset) return
    announced = true
    announcedPreset = presetId
    const capabilities = resolveAgentCapabilities(agentCapabilityEvidence(ctx, agent))
    if (capabilities.compaction && capabilities.pruner) return
    const key = capabilities.compaction
      ? 'capability-gap-pruner'
      : capabilities.pruner
        ? 'capability-gap-compaction'
        : 'capability-gap-compaction-pruner'
    deps.state.notify(t(key), { color: 'warning', timeoutMs: 12000 })
  }
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

  const bind = (): void => {
    try {
      deps.state.agentBindingGeneration = deps.binding.bind()
      installSubagents()
      deps.inputConvergence.cancelInFlight = false
      deps.inputConvergence.interruptSeq += 1
      deps.seedActivity?.(deps.binding.agent.session)
      deps.seedContextOccupancy?.(deps.binding.agent.session)
      deps.modelActions.selection.current = undefined
      deps.modelActions.selection.assembled = undefined
      if (deps.binding.agent.options?.model === undefined && deps.state.provider !== '' && deps.state.model !== '') {
        deps.modelActions.selection.current = { provider: deps.state.provider, model: deps.state.model }
      }
      void deps.modelActions.applyPreferredEffort()
      deps.modeActions.refreshMode()
      // Entering/resuming a session whose preset serves neither automatic
      // compaction nor tool-result pruning changes what the user can expect
      // from a long session; say it once, here, before the turn starts.
      announceCapabilityGap()
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
      // Match upstream installModelSelection's admission-time notice while
      // retaining this binding's incremental ownership and post-await fences.
      register(capture.agent.ctx.on('agent/pre-step', async ({ agent, messages, signal, step }, next) => {
        const decision = await next()
        if (!current() || decision.kind === 'reject' || signal.aborted) return decision
        if (decision.messages.length === 0 && (step === 1 || messages.length > 0)) return decision
        const selected = deps.selection.assembled
        const previous = agent.session.requestHeader()?.config
        if (selected === undefined || previous === undefined ||
            (selected.provider === previous.provider && selected.model === previous.model)) return decision
        const from = selected.provider === previous.provider ? previous.model : `${previous.provider}/${previous.model}`
        const to = selected.provider === previous.provider ? selected.model : `${selected.provider}/${selected.model}`
        return { ...decision, messages: [...decision.messages, createUserMessage({
          content: [{ type: 'text', text: `[model changed: assistant turns above this point were generated by ${from}; the session continues with ${to}]` }],
          source: { kind: 'model-selection', form: 'notice', summary: boundContextSummary(`${from} → ${to}`) },
        })] }
      }, { prepend: true }))
      on('agent/status', ({ agent: subject, status }) => {
        if (!current() || subject !== capture.agent) return
        deps.state.status = status
        if (status === 'idle') reconcileRetiredProjection('idle')
        deps.state.emit()
      })
      on('agent/disposed', ({ agent: subject }) => {
        if (!current() || subject !== capture.agent) return
        deps.state.status = 'disposed'
        reconcileRetiredProjection('disposed')
        deps.state.emit()
      })
      /**
       * The inbox removed one message. Both events retire the pending
       * preview, but ONLY a discard retires an attached-context entry:
       * `agent/inbox/claimed` fires while the loop claims the batch, BEFORE
       * the resident `agent/pre-step` listener can append the attachment —
       * retiring there would delete the context before it is ever injected
       * (dsh-agent-loop: `inbox.claim()` → claimed event → `agent/pre-step`).
       */
      const retirePending = (payload: { agent: unknown; message: { id?: unknown } }, alsoRetireAttachment = false): void => {
        if (!current() || payload.agent !== capture.agent) return
        const messageId = payload.message?.id
        if (typeof messageId !== 'string') return
        if (alsoRetireAttachment) deps.retireAttachment?.(messageId)
        const before = deps.state.pending.length
        deps.state.pending = deps.state.pending.filter(item => item.id !== messageId)
        if (deps.state.pending.length !== before) deps.state.emit()
      }
      on('agent/inbox/claimed', retirePending)
      on('agent/inbox/discarded', payload => retirePending(payload, true))
      on('session/event', (subject, event) => {
        if (!current()) return
        const isMainSession = subject === session
        if (!isMainSession) return
        deps.messageObserver?.publish(subject, event)
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
        if (subject !== capture.agent) return
        deps.projector.renderStreamFrame(frame)
        if (frame.type === 'chunk') deps.state.emitStream()
        else if (frame.type === 'end') deps.state.emit()
      })
      /**
       * Live compaction progress. The summarizer is one `ctx.llm.stream()`
       * call, so its chunks are the only work signal a compaction has between
       * `compaction/start` and `compaction/end` (dsh-llm tags the call
       * `purpose: 'compaction'`, and a manual one runs while the session is
       * idle, so it cannot be confused with the foreground turn's stream).
       * Everything else passes through untouched: the original iterable is
       * returned for any other purpose or session.
       */
      const disposeCompactionStream = ctx.on('llm/stream', (options, next) => {
        const stream = next()
        if (options.purpose !== 'compaction') return stream
        if (options.sessionId === undefined || String(options.sessionId) !== String(session.id)) return stream
        return (async function* compactionStream() {
          for await (const chunk of stream) {
            const compaction = deps.state.compaction
            if (compaction !== undefined && isTokenDelta(chunk)) {
              deps.state.compaction = {
                ...compaction,
                phase: 'summary',
                outputChars: compaction.outputChars + tokenDeltaChars(chunk),
              }
              deps.state.emitStream()
            }
            yield chunk
          }
        })()
      })
      register(disposeCompactionStream)
    } catch (error) {
      deps.owner.dispose()
      throw error
    }
  }
  return { bind }
}
