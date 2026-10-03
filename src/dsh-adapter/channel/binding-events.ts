import type { Agent, AssistantStreamFrame, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { carrierKeyOf } from '@deepseek-ai/dsh-scope'
import type { ChannelProjection } from '../../channel/projection.js'
import { t } from '../../i18n.js'
import { runningPresetOf } from '../presets.js'
import { agentCapabilityEvidence, resolveAgentCapabilities } from './capabilities.js'
import { createSessionBatchRouter, createSessionBinder, type BindingFeedHooks, type BindingScope } from './core/binding-feed.js'
import type { InputConvergence } from './input-actions.js'
import type { DshChannelBinding } from './binding.js'
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
  binding: DshChannelBinding
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
  /**
   * Preset of the last binding we announced a capability gap for. The gap is a
   * property of the agent's PRESET, so it is reported once per entry into a
   * preset that lacks it (a rebind to the SAME preset — /model, /rewind —
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
  /**
   * The DSH half of every bind (core/binding-feed.ts runs it): the owner-level
   * child listeners once, then per binding the activity seed, the model
   * selection reset, the preferred effort and mode refresh, the model
   * selection waterfalls, and the raw durable-event subscribers. Registered
   * before the core's session subscription, so each raw event reaches the
   * DSH specialists before the projector folds it (the pre-split order).
   */
  const hooks = {
    // This composition maintains mode/effort/command facts through its own
    // specialists, and replays its seed synchronously at adoption.
    ownsSessionFacts: true,
    onGeneration(): void {
      // DSH specialists attach only to a DSH session (design §3.5).
      if (deps.binding.session.capabilities.native.dsh !== undefined) installSubagents()
    },
    onBind({ capture, current, register }: BindingScope): void {
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
      const native = capture.session.capabilities.native.dsh
      if (native === undefined) return
      // Keep the upstream assembly/request pairing, but own each listener as
      // soon as it is installed. The upstream combined disposer is too late
      // if request registration throws, and its post-await assembly write is
      // unsafe after a rebind (including A→B→A ABA).
      const disposeAssembly = native.agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
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
      const disposeRequest = native.agent.ctx.on('agent/request', async (_payload, next) => {
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
    },
  } satisfies BindingFeedHooks

  // Direct regressions drive this owner alone: the same binder the channel
  // feed runs, over the projector they hand in.
  const router = createSessionBatchRouter({
    state: deps.state,
    projector: deps.projector,
    inputConvergence: deps.inputConvergence,
    retireAttachment: deps.retireAttachment,
    warn: message => ctx.logger.warn(message),
  })
  const binder = createSessionBinder({
    owner: deps.owner,
    binding: deps.binding,
    state: deps.state,
    inputConvergence: deps.inputConvergence,
    route: router.route,
    hooks: () => hooks,
  })
  return { bind: binder.bind, hooks }
}

export { createSessionBatchRouter } from './core/binding-feed.js'
