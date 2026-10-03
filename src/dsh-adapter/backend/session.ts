/**
 * DSH backend session (docs/agent-backend-design.md §3.4, §6): one `Agent`
 * (plus the `AgentHandle` that owns its lifetime, when this process created
 * or resumed it) presented as an `AgentSession`. Live session events and
 * stream frames are translated by the session's own `createDshTranslator`
 * instance, so the translator state (frame fence, open calls) lives exactly as
 * long as the session; inbox, status and compaction-stream bus events become
 * `pending.changed` / `session.status` / `compaction.progress`.
 *
 * DSH specialists that are not capability-shaped yet reach the agent through
 * `capabilities.native.dsh` (only `src/dsh-adapter/**` may read it).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, MessageId, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentEvent, AgentEventMeta, PendingItem } from '../../agent/events.js'
import type { AgentInput, AgentSession, AgentSessionStatus, CancelCause, SubmitPlacement } from '../../agent/session.js'
import { isTokenDelta, tokenDeltaChars } from '../channel/usage.js'
import type { ToolsRegistryLike } from '../channel/types.js'
import { snapshotLiveSessionEvents } from '../compat/liveSession.js'
import { createDshTranslator, type DshTranslator } from './translate.js'

declare module '../../agent/capabilities.js' {
  interface DshNative {
    /** The live DSH agent this session drives. */
    readonly agent: Agent
    /** The lifetime handle, when this session owns the agent's lifetime;
     *  absent for a borrowed registry agent (agent-view attachment). */
    readonly handle: AgentHandle | undefined
    /** The plugin context the session's listeners are installed on. */
    readonly ctx: Context
    /** Raw durable events of the main session, in arrival order. Raw
     *  listeners registered before `subscribe` run before the projector sees
     *  the same event. */
    subscribeRaw(listener: (event: SessionEvent) => void): () => void
    /** The durable session log snapshot (`/trace`, fold restore, seeds). */
    rawHistory(): readonly SessionEvent[]
    /**
     * Synchronously translate a durable replay seed with this session's
     * translator. The channel's adoption transactions replay inside a
     * synchronous tail, which the async `history()` cannot serve.
     */
    translateReplay(events: readonly SessionEvent[]): readonly AgentEvent[]
    /** Forget the translator's per-session state (paired with a projector reset). */
    resetTranslation(): void
    /** The dsh-tools presenters, scoped to this session's agent. */
    readonly presentCallView: DshTranslator['presentCallView']
    readonly presentResultView: DshTranslator['presentResultView']
  }
}

/** What a DSH session wraps: an owned handle, or an agent plus the handle
 *  this process holds for it (`undefined` = a borrowed registry agent). */
export type DshSessionTarget = AgentHandle | { readonly agent: Agent; readonly handle: AgentHandle | undefined }

const SYNC: AgentEventMeta = { replay: false, wake: 'sync' }
const FRAME: AgentEventMeta = { replay: false, wake: 'frame' }
const QUIET: AgentEventMeta = { replay: false, wake: 'none' }

// The borrowed form always names its `handle` slot (possibly undefined);
// anything else is the handle itself.
const isHandle = (target: DshSessionTarget): target is AgentHandle => !('handle' in target)

/** Whether a value is an `AgentSession` rather than a raw DSH agent. */
export function isAgentSession(value: unknown): value is AgentSession {
  return typeof value === 'object' && value !== null &&
    typeof (value as { subscribe?: unknown }).subscribe === 'function' &&
    typeof (value as { capabilities?: unknown }).capabilities === 'object'
}

/**
 * Wrap a DSH agent (and the handle that owns it, if any) as an
 * `AgentSession`. Creating the wrapper acquires nothing: listeners exist only
 * while `subscribe`/`subscribeRaw` subscriptions are live, and only `dispose()`
 * releases the handle.
 */
export function createDshSession(ctx: Context, target: DshSessionTarget): AgentSession {
  const agent = target.agent
  const handle = isHandle(target) ? target : target.handle
  // The tools registry is read once per session (the pre-split reducer read
  // it once per channel), on the first presenter call: wrapping an agent
  // touches no host service.
  let tools: { readonly registry: ToolsRegistryLike | undefined } | undefined
  const translatorDeps = {
    tools: () => (tools ??= { registry: ctx.get('tools') as ToolsRegistryLike | undefined }).registry,
    scope: () => agent,
    attachments: () => ctx.get('attachments'),
  }
  const translator = createDshTranslator(translatorDeps)
  let disposed = false
  /** Inputs this session queued that the inbox has not claimed or discarded. */
  const pending = new Map<string, PendingItem>()

  /**
   * One `session/event` listener per subscription period, shared by raw and
   * translated subscribers: raw subscribers (the DSH specialists) see each
   * main-session event before the translated batch reaches the projector —
   * the pre-split single listener's order — and the bus sees exactly one
   * foreground listener, as before. Each install is inert once removed.
   */
  const rawListeners = new Set<(event: SessionEvent) => void>()
  const eventListeners = new Set<(event: SessionEvent) => void>()
  let eventTap: { dispose(): void } | undefined
  const tapEvents = (): void => {
    if (eventTap !== undefined) return
    let live = true
    const dispose = ctx.on('session/event', (subject, event) => {
      if (!live || subject !== agent.session) return
      for (const listener of [...rawListeners]) listener(event)
      for (const listener of [...eventListeners]) listener(event)
    })
    eventTap = { dispose: () => { live = false; dispose() } }
  }
  const untapEvents = (): void => {
    if (rawListeners.size > 0 || eventListeners.size > 0 || eventTap === undefined) return
    const tap = eventTap
    eventTap = undefined
    tap.dispose()
  }

  /** Every listener install is owned at once; a throwing unsubscriber does not
   *  stop the rest (the first failure is rethrown after all ran). */
  const disposeAll = (disposers: (() => void)[]): void => {
    let failure: unknown
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch (error) { failure ??= error }
    }
    if (failure !== undefined) throw failure
  }

  const messageFor = (input: AgentInput): UserMessage => {
    // The channel's DSH input pipeline already built the durable message (its
    // id IS the clientMessageId the channel tracked pending/selection/context
    // under); any other caller gets a fresh message from its blocks.
    const native = input.native as UserMessage | undefined
    if (native !== undefined && native.id === input.clientMessageId) return native
    return createUserMessage({
      content: (input.blocks ?? [{ type: 'text', text: input.text }]) as ContentBlock[],
      source: { kind: 'user' },
    })
  }

  const native = {
    kind: 'dsh' as const,
    agent,
    handle,
    ctx,
    subscribeRaw(listener: (event: SessionEvent) => void): () => void {
      const entry = (event: SessionEvent): void => listener(event)
      rawListeners.add(entry)
      try {
        tapEvents()
      } catch (error) {
        rawListeners.delete(entry)
        throw error
      }
      return () => {
        rawListeners.delete(entry)
        untapEvents()
      }
    },
    rawHistory: (): readonly SessionEvent[] => snapshotLiveSessionEvents(agent.session),
    translateReplay: (events: readonly SessionEvent[]): readonly AgentEvent[] => translator.translateReplay(events),
    resetTranslation: (): void => translator.reset(),
    presentCallView: translator.presentCallView,
    presentResultView: translator.presentResultView,
  }

  const session: AgentSession = {
    get ref() { return { backendId: 'dsh', sessionId: String(agent.session.id) } },
    get cwd(): string {
      return (agent.session as { header?: { cwd?: string } }).header?.cwd ?? ''
    },
    get status(): AgentSessionStatus {
      if (disposed) return 'disposed'
      return agent.status === 'running' ? 'running' : 'idle'
    },
    // DSH withdraws through the agent inbox synchronously (`removePending`).
    capabilities: { retractPending: true, native: { dsh: native } },
    // A throwaway translator: `history()` is a read, so it must neither reset
    // the live translator's frame fence nor leave the replay's open calls in
    // the live open-call ledger. (Adoption seeds still go through
    // `native.translateReplay`, which is a deliberate live reset.)
    history: () => Promise.resolve(createDshTranslator(translatorDeps).translateReplay(snapshotLiveSessionEvents(agent.session))),

    subscribe(listener) {
      // A callback the bus retained past unsubscription (a dispatch already
      // in flight, an ABA rebind) is inert: nothing is translated for it.
      let active = true
      const disposers: (() => void)[] = [() => { active = false }]
      const own = (dispose: () => void): void => { disposers.push(dispose) }
      try {
        own(ctx.on('agent/status', ({ agent: subject, status }) => {
          if (!active || subject !== agent) return
          listener([{ type: 'session.status', status }], QUIET)
        }))
        own(ctx.on('agent/disposed', ({ agent: subject }) => {
          if (!active || subject !== agent) return
          disposed = true
          listener([{ type: 'session.status', status: 'disposed' }], QUIET)
        }))
        /**
         * The inbox removed one message. Both events retire the pending entry;
         * the channel retires attached context only for a discard:
         * `agent/inbox/claimed` fires while the loop claims the batch, BEFORE
         * the resident `agent/pre-step` listener can append the attachment
         * (dsh-agent-loop: `inbox.claim()` → claimed event → `agent/pre-step`).
         */
        const retire = (payload: { agent: unknown; message: { id?: unknown } }, how: 'claimed' | 'discarded'): void => {
          if (!active || payload.agent !== agent) return
          const messageId = payload.message?.id
          if (typeof messageId !== 'string') return
          pending.delete(messageId)
          const items = [...pending.values()]
          listener([how === 'claimed'
            ? { type: 'pending.changed', items, claimed: [messageId] }
            : { type: 'pending.changed', items, discarded: [messageId] }], QUIET)
        }
        own(ctx.on('agent/inbox/claimed', payload => retire(payload, 'claimed')))
        own(ctx.on('agent/inbox/discarded', payload => retire(payload, 'discarded')))
        const onEvent = (event: SessionEvent): void => {
          if (!active) return
          // Legacy per-token chunks arrive as session events; they wake the
          // renderer frame-coalesced like live stream frames.
          listener(translator.translateEvent(event), (event as { type: string }).type === 'assistant/chunk' ? FRAME : SYNC)
        }
        eventListeners.add(onEvent)
        own(() => {
          eventListeners.delete(onEvent)
          untapEvents()
        })
        tapEvents()
        // 0.1.5 live streaming: per-token chunks are transient attempt frames
        // on this agent-scoped channel; the durable settlement still arrives
        // through `session/event`. Pre-0.1.5 hosts never emit it. Start frames
        // change nothing renderer-visible on their own.
        own(ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
          if (!active || subject !== agent) return
          listener(translator.translateFrame(frame), frame.type === 'chunk' ? FRAME : frame.type === 'end' ? SYNC : QUIET)
        }))
        /**
         * Live compaction progress. The summarizer is one `ctx.llm.stream()`
         * call, so its chunks are the only work signal a compaction has between
         * `compaction/start` and `compaction/end` (dsh-llm tags the call
         * `purpose: 'compaction'`, and a manual one runs while the session is
         * idle, so it cannot be confused with the foreground turn's stream).
         * Everything else passes through untouched: the original iterable is
         * returned for any other purpose or session.
         */
        // A summary stream that started while subscribed keeps reporting until
        // it ends (the pre-split stream wrapper did; the channel decides what
        // a late report may still touch).
        own(ctx.on('llm/stream', (options, next) => {
          const stream = next()
          if (!active || options.purpose !== 'compaction') return stream
          if (options.sessionId === undefined || String(options.sessionId) !== String(agent.session.id)) return stream
          return (async function* compactionStream() {
            for await (const chunk of stream) {
              if (isTokenDelta(chunk)) listener([{ type: 'compaction.progress', outputChars: tokenDeltaChars(chunk) }], FRAME)
              yield chunk
            }
          })()
        }))
      } catch (error) {
        try { disposeAll(disposers) } catch { /* the install failure stays primary */ }
        throw error
      }
      return () => disposeAll(disposers)
    },

    // Synchronous by contract for DSH: steer/followup run before this returns,
    // and a synchronous throw reaches the caller synchronously (the input
    // pipeline rolls its bookkeeping back on it).
    submit(input: AgentInput, placement: SubmitPlacement) {
      const message = messageFor(input)
      const queued = placement === 'steer' ? 'steer' : 'followup'
      pending.set(message.id, { id: message.id, text: input.text, placement: queued })
      try {
        if (placement === 'now') agent.cancel({ kind: 'user' })
        if (placement === 'steer') agent.steer(message)
        else agent.followup(message)
      } catch (error) {
        pending.delete(message.id)
        throw error
      }
      return Promise.resolve({ accepted: true })
    },

    // Official dsh-agent rc.6: withdrawal goes through the agent's inbox
    // projection — `Inbox.remove(messageId)` durably records the cancellation
    // (an `agent/inbox/spliced` session event) and publishes
    // `agent/inbox/discarded`. False when the message was already claimed.
    removePending(clientMessageId: string): boolean {
      const removed = agent.inbox.remove(MessageId(clientMessageId))
      if (removed) pending.delete(clientMessageId)
      return removed
    },

    cancel(cause: CancelCause) {
      // `user` keeps the queue (queued/steered inputs run as the next turn);
      // `interrupt` drops it — the channel parks those inputs as a dock and
      // re-delivers nothing until the user sends it (keepInbox stays
      // exclusive to the user-cancel / normal-turn-end paths); a
      // switch/dispose never resumes the old queue either.
      if (cause === 'user') agent.cancel({ kind: 'user' }, { keepInbox: true })
      else agent.cancel({ kind: 'user' })
      return Promise.resolve({ stillQueued: cause === 'user' ? [...pending.keys()] : [] })
    },

    dispose(): Promise<void> {
      return handle === undefined ? Promise.resolve() : handle.dispose()
    },
  }
  return session
}

/** The DSH escape hatch of a session, when it is a DSH session. */
export function dshNativeOf(session: AgentSession) {
  return session.capabilities.native.dsh
}

/** The DSH agent behind a session; throws for a non-DSH session. */
export function dshAgentOf(session: AgentSession): Agent {
  const native = session.capabilities.native.dsh
  if (native === undefined) throw new Error(`dsh-tui: session ${session.ref.backendId}:${session.ref.sessionId} is not a DSH session`)
  return native.agent
}

/** The lifetime handle of a DSH session this process created or resumed;
 *  throws when the session borrows its agent (or is not a DSH session). */
export function dshHandleOf(session: AgentSession): AgentHandle {
  const handle = session.capabilities.native.dsh?.handle
  if (handle === undefined) throw new Error(`dsh-tui: session ${session.ref.backendId}:${session.ref.sessionId} owns no DSH handle`)
  return handle
}
