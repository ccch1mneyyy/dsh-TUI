/**
 * The live session handle a channel holds: one replay source, one event
 * subscription, one input path, cancellation and disposal. Everything
 * backend-specific beyond that is a typed capability.
 */
import type { SessionCapabilities } from './capabilities.js'
import type { AgentEvent, AgentEventMeta, ContentBlockView, ImageRef } from './events.js'
import type { AgentSessionRef } from './refs.js'

/** One user input as the channel hands it to the backend. */
export interface AgentInput {
  /** The typed text (the transcript bubble). */
  readonly text: string
  /** Model-facing blocks already expanded by the channel (`@` mentions,
   *  IDE selection); absent = just `text`. */
  readonly blocks?: readonly ContentBlockView[]
  readonly images?: readonly ImageRef[]
  /** Channel-generated id; the backend echoes it on pending/turn attribution. */
  readonly clientMessageId: string
  /**
   * A backend-native message the backend's own input pipeline already built
   * for this input (DSH: the `UserMessage` whose id is `clientMessageId`);
   * opaque to everyone else, ignored by backends that do not recognize it.
   */
  readonly native?: unknown
}

/**
 * Where an input lands: `turn` — start a turn when idle; `steer` — join the
 * running turn at its next step boundary; `followup` — run after the current
 * turn; `now` — interrupt the current turn and deliver immediately.
 */
export type SubmitPlacement = 'turn' | 'steer' | 'followup' | 'now'

/** Lifecycle state of a session handle. */
export type AgentSessionStatus = 'starting' | 'idle' | 'running' | 'requires-action' | 'disposed'

/**
 * Why a cancellation was requested: `user` keeps queued inputs for the next
 * turn; `interrupt` drops them, and the channel parks the dropped copies as
 * a dock and re-delivers nothing until the user asks (as Claude Code does);
 * `switch`/`dispose` leave the session.
 */
export type CancelCause = 'user' | 'interrupt' | 'switch' | 'dispose'

/** How definite a cancel receipt's `stillQueued` list is. The channel's
 * dock only allows edit/resend once the backend's copies are gone, so only
 * a `confirmed` answer may read as "the queue is empty". `unknown` (no
 * receipt came back, e.g. an older CLI) and `failed` (the cancel request
 * itself failed) carry the conservative request-time snapshot of what the
 * cancel covered instead. */
export type CancelOutcome = 'confirmed' | 'unknown' | 'failed'

/** The receipt of a cancel: `stillQueued` names the inputs (channel
 * clientMessageIds) whose backend copies were not confirmed withdrawn. A
 * `confirmed` answer is the backend's live queue snapshot (the copies that
 * will still run); anything else is the request-time snapshot of the
 * covered inputs, never a definite empty queue. */
export interface CancelReceipt {
  readonly stillQueued: readonly string[]
  readonly outcome: CancelOutcome
}

/** One live backend session. */
export interface AgentSession {
  readonly ref: AgentSessionRef
  readonly cwd: string
  readonly status: AgentSessionStatus
  readonly capabilities: SessionCapabilities
  /** The durable replay seed, in the same vocabulary as live events. */
  history(): Promise<readonly AgentEvent[]>
  /** Follow live events; returns the unsubscriber. */
  subscribe(listener: (batch: readonly AgentEvent[], meta: AgentEventMeta) => void): () => void
  submit(input: AgentInput, placement: SubmitPlacement): Promise<{ readonly accepted: boolean; readonly reason?: string }>
  /**
   * Withdraw a queued input; false when the backend already claimed it. A
   * backend that can answer synchronously does (the channel's Alt+Up
   * contract is synchronous); an async answer is not-yet-withdrawn to it.
   */
  removePending(clientMessageId: string): boolean | Promise<boolean>
  /** Cancel the running turn. An `interrupt` also asks the backend to drop
   *  its queued inputs; the receipt says which copies are still live. A
   *  receipt whose `outcome` is not `confirmed` must never be read as an
   *  empty queue: the backend may still hold every copy. */
  cancel(cause: CancelCause): Promise<CancelReceipt>
  dispose(): Promise<void>
}
