/**
 * The one transcript feed of a channel (docs/agent-backend-design.md §3.5
 * items 1–3): the shared projector, the session-batch router that is its only
 * writer, and the bind that follows the bound session — for any backend.
 *
 * `bind(seed?)` advances the binding generation, resets input convergence,
 * links the session's prompts to the stores Chat renders, and subscribes the
 * router to the captured session. By default it also paints the session's
 * durable history and seeds the session-level facts from the session's
 * capabilities. The history is the `seed` the caller read before the
 * adoption (design §4.11: a resume reads `history()` ahead of the
 * synchronous adopt), painted synchronously BEFORE the subscription — so no
 * live event can land ahead of it; without a seed it is read once,
 * asynchronously, and dropped if live rows painted first. An extension that
 * owns those facts and replays its seed synchronously itself (the DSH
 * specialists) sets `ownsSessionFacts`, and adds its raw per-binding
 * listeners through `onBind`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentEvent, AgentEventMeta, AgentEventOf } from '../../../agent/events.js'
import type { AgentSession } from '../../../agent/session.js'
import { attachInteraction } from '../../../channel/interaction.js'
import { createChannelProjection, type ChannelProjection, type ChannelProjectionDeps } from '../../../channel/projection.js'
import { logForDebugging } from '../../../utils/debug.js'
import type { BindingCapture, ChannelBinding } from '../binding.js'
import type { InputConvergence } from '../input-actions.js'
import type { ChannelOwner } from '../owner.js'
import type { ChannelLaunchOptions } from '../state.js'
import type { ChannelState } from '../types.js'
import type { SessionControls } from './session-controls.js'

/** What one bind hands an extension's per-binding listeners. */
export interface BindingScope {
  readonly capture: BindingCapture
  /** Owner live and the binding still the captured one (ABA-safe). */
  current(): boolean
  /** Own a listener for this binding period (released on the next adoption). */
  register<T extends () => void>(dispose: T): T
}

/** Extension points of the feed (all optional; see the module comment). */
export interface BindingFeedHooks {
  /** Right after the generation advances (DSH: owner-level child listeners). */
  onGeneration?(): void
  /** After input convergence resets, before the session subscription. */
  onBind?(scope: BindingScope): void
  /** After the bind returned (outside its rollback). */
  afterBind?(): void
  /** The extension maintains the session-level facts and replays its seed
   *  synchronously: no history repaint, no capability observer. */
  readonly ownsSessionFacts?: boolean
  /** Forget the bound session's translator state with the projector's. */
  resetTranslation?(): void
}

/**
 * The one session-batch writer path, shared by every channel composition:
 * binding-generation fence over the whole batch, session status and
 * pending-queue bookkeeping, compaction-progress gating, then the shared
 * projector and the renderer wake the backend asked for.
 */
export function createSessionBatchRouter(deps: {
  state: ChannelState
  projector: ChannelProjection
  inputConvergence: InputConvergence
  /** Drop channel-side context attached to a discarded input (DSH pre-step
   *  attachments); absent where nothing is ever attached. */
  retireAttachment?(messageId: string): void
  /** The backend reset the conversation in place (`session.reset`, live):
   *  the events before it in the batch are projected first, those after it
   *  land on the cleared view. Absent = the event is projected (ignored). */
  onReset?(event: AgentEventOf<'session.reset'>): void
  warn(message: string): void
}) {
  const reconcileRetiredProjection = (status: 'idle' | 'disposed'): void => {
    if (!deps.state.working) return
    deps.warn(`dsh-tui: agent became ${status} while the channel still projected an open turn; releasing volatile UI gates`)
    deps.inputConvergence.cancelInFlight = false
    deps.state.cancelPending = false
    deps.state.working = false
    deps.state.activeToolCount = 0
    deps.projector.settleStreaming()
    deps.projector.updateSpinnerMode()
  }

  /** `session.status` as the backend reports it. */
  const applyStatus = (status: 'idle' | 'running' | 'requires-action' | 'disposed'): void => {
    if (status === 'disposed') {
      deps.state.status = 'disposed'
      reconcileRetiredProjection('disposed')
      deps.state.emit()
      return
    }
    // The channel's status is idle/running only; a parked prompt is mid-turn.
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

  /** Monotonic count of live turns that started on a bound session (`/new`
   *  compares it across its open: a whole turn may come and go meanwhile). */
  let turnStarts = 0

  const route = (batch: readonly AgentEvent[], meta: AgentEventMeta, current: () => boolean): void => {
    // The generation fence covers the WHOLE batch, whatever it carries: a
    // callback retained past a rebind (an in-flight dispatch, a compaction
    // summary stream that outlived the binding it started under) must never
    // write the replacement session's transcript.
    if (!current()) return
    let admitted: AgentEvent[] | undefined
    let progressOnly = batch.length > 0
    for (const [index, event] of batch.entries()) {
      switch (event.type) {
        case 'turn.start':
          if (!meta.replay) turnStarts += 1
          break
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
    // The one writer of the foreground transcript. A live conversation
    // reset splits the batch: what came before it is projected first.
    const onReset = meta.replay ? undefined : deps.onReset
    if (onReset !== undefined && events.some(event => event.type === 'session.reset')) {
      let start = 0
      events.forEach((event, index) => {
        if (event.type !== 'session.reset') return
        if (index > start) deps.projector.apply(events.slice(start, index), meta)
        onReset(event)
        start = index + 1
      })
      if (start < events.length) deps.projector.apply(events.slice(start), meta)
    } else {
      deps.projector.apply(events, meta)
    }
    if (meta.wake === 'frame') deps.state.emitStream()
    else if (meta.wake !== 'none') deps.state.emit()
  }

  return { route, reconcileRetiredProjection, turnStarts: (): number => turnStarts }
}

/**
 * The bind that follows the bound session: shared by the channel feed below
 * and the DSH binding-events owner (which direct regressions drive alone).
 */
export function createSessionBinder(deps: {
  owner: ChannelOwner
  binding: Pick<ChannelBinding, 'bind' | 'capture' | 'isCurrent' | 'subscribe'>
  state: Pick<ChannelState, 'agentBindingGeneration' | 'status'>
  inputConvergence: InputConvergence
  route(batch: readonly AgentEvent[], meta: AgentEventMeta, current: () => boolean): void
  hooks(): BindingFeedHooks
  /** The stores a session's prompts park in (`ChannelLaunchOptions.interaction`). */
  interaction?: ChannelLaunchOptions['interaction']
  /** The session-level facts kept unless the extension owns them. */
  facts?: {
    observe(batch: readonly AgentEvent[], session: AgentSession, current: () => boolean): void
    /** Paint the history read ahead of the bind (before the subscription). */
    replay(history: readonly AgentEvent[]): void
    /** After the subscription: `replayed` = the history was already painted. */
    seed(capture: BindingCapture, current: () => boolean, replayed: boolean): void
  }
}) {
  const { owner, binding, state, inputConvergence } = deps
  /**
   * The bound session's prompts ↔ the stores Chat renders (design §4.7). One
   * link per binding: a replaced session (or a released channel) withdraws
   * everything it parked, so no panel outlives its session.
   */
  let interactionLink: ReturnType<typeof attachInteraction> | undefined
  if (deps.interaction !== undefined) owner.own(() => { interactionLink?.release() })

  /** Bind the current session: the one subscription feeding the projector. */
  const bind = (seed?: readonly AgentEvent[]): void => {
    const hooks = deps.hooks()
    try {
      state.agentBindingGeneration = binding.bind()
      hooks.onGeneration?.()
      inputConvergence.cancelInFlight = false
      inputConvergence.interruptSeq += 1
      const capture = binding.capture()
      const session = capture.session
      const current = (): boolean => owner.current() && binding.isCurrent(capture)
      const register = <T extends () => void>(dispose: T): T => {
        binding.subscribe(dispose)
        return dispose
      }
      hooks.onBind?.({ capture, current, register })
      const interaction = deps.interaction
      let link: ReturnType<typeof attachInteraction> | undefined
      if (interaction !== undefined) {
        interactionLink?.release()
        link = attachInteraction({ ...interaction, debug: logForDebugging }, { sessionId: session.ref.sessionId, capabilities: session.capabilities })
        interactionLink = link
      }
      const facts = hooks.ownsSessionFacts === true ? undefined : deps.facts
      // The history read ahead of the adoption paints first: every live
      // event follows it (design §4.11).
      if (facts !== undefined && seed !== undefined) facts.replay(seed)
      if (facts === undefined && link === undefined) {
        register(session.subscribe((batch, meta) => deps.route(batch, meta, current)))
      } else {
        register(session.subscribe((batch, meta) => {
          // Prompts first: a batch that also closes the turn must not leave
          // a panel behind it; the generation fence applies to both halves.
          if (current()) {
            link?.apply(batch)
            facts?.observe(batch, session, current)
          }
          deps.route(batch, meta, current)
        }))
      }
      facts?.seed(capture, current, seed !== undefined)
    } catch (error) {
      owner.dispose()
      throw error
    }
    hooks.afterBind?.()
  }
  return { bind }
}

export function createBindingFeed(ctx: Context, deps: {
  owner: ChannelOwner
  binding: ChannelBinding
  state: ChannelState
  options: Pick<ChannelLaunchOptions, 'interaction'>
  inputConvergence: InputConvergence
  /** The projector's channel-side dependencies; `jobs` and `pricingWindow`
   *  stay writable until the channel starts (`configureProjection`). */
  projection: Omit<ChannelProjectionDeps, 'inputConvergence'>
  retireAttachment(messageId: string): void
  controls: SessionControls
  hooks(): BindingFeedHooks
  /** A live `session.reset` (see createSessionBatchRouter). */
  onReset?(event: AgentEventOf<'session.reset'>): void
}) {
  const { owner, binding, state, inputConvergence, controls } = deps
  // The projector reads its deps per use, so an extension can install its
  // job feed and pricing policy before any event is projected.
  const projectorDeps: ChannelProjectionDeps = { ...deps.projection, inputConvergence }
  const projector = createChannelProjection(state, projectorDeps)
  const router = createSessionBatchRouter({
    state,
    projector,
    inputConvergence,
    retireAttachment: deps.retireAttachment,
    ...(deps.onReset === undefined ? {} : { onReset: deps.onReset }),
    warn: message => ctx.logger.warn(message),
  })

  /** Forget every per-session projection ledger: the projector's and the
   *  bound session translator's (the pre-split reducer reset both at once). */
  const resetProjection = (): void => {
    projector.reset()
    deps.hooks().resetTranslation?.()
  }

  /** Paint a settled history: no live toasts, no open turn left behind. */
  const paintHistory = (events: readonly AgentEvent[]): void => {
    if (events.length === 0) return
    projector.apply(events, { replay: true })
    projector.settleStreaming()
    state.working = false
    state.cancelPending = false
  }

  /**
   * The fallback for a bind without a history read ahead of it (an embedder
   * handing `createChannel` a session whose history it never read): read it
   * once, asynchronously, and paint it only while nothing live has painted
   * — ordering it after live rows that already arrived would misplace both.
   * Every core adoption (`/new`, `/resume`, a rewind's fork) and the plugin's
   * startup session pass the history in instead (design §4.11).
   */
  const replayHistory = (capture: BindingCapture, current: () => boolean): void => {
    void capture.session.history().then(events => {
      if (events.length === 0 || !current()) return
      if (state.rows.length > 0) {
        logForDebugging('channel: history arrived after live rows; not replayed')
        return
      }
      paintHistory(events)
      state.emit()
    }).catch((error: unknown) => {
      logForDebugging(`channel: history failed (${error instanceof Error ? error.message : String(error)})`)
    })
  }

  const statusOf = (session: AgentSession): ChannelState['status'] =>
    session.status === 'running' || session.status === 'requires-action'
      ? 'running'
      : session.status === 'disposed' ? 'disposed' : 'idle'

  const binder = createSessionBinder({
    owner,
    binding,
    state,
    inputConvergence,
    route: router.route,
    hooks: deps.hooks,
    interaction: deps.options.interaction,
    facts: {
      observe: controls.observe,
      replay: paintHistory,
      seed(capture, current, replayed) {
        state.status = statusOf(capture.session)
        if (!replayed) replayHistory(capture, current)
        controls.seed(capture.session, current)
      },
    },
  })

  return {
    projector,
    router,
    bind: binder.bind,
    resetProjection,
    /** Install the backend's job-registry feed and pricing policy (before start). */
    configureProjection(update: Partial<Pick<ChannelProjectionDeps, 'jobs' | 'pricingWindow'>>): void {
      if (update.jobs !== undefined) projectorDeps.jobs = update.jobs
      if (update.pricingWindow !== undefined) projectorDeps.pricingWindow = update.pricingWindow
    },
  }
}

export type BindingFeed = ReturnType<typeof createBindingFeed>
