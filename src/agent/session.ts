/**
 * The live session handle a channel holds (docs/agent-backend-design.md §3.4):
 * one replay source, one event subscription, one input path, cancellation and
 * disposal. Everything backend-specific beyond that is a typed capability.
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
 * turn; `interrupt` drops them because the caller re-delivers them at once;
 * `switch`/`dispose` leave the session.
 */
export type CancelCause = 'user' | 'interrupt' | 'switch' | 'dispose'

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
  cancel(cause: CancelCause): Promise<{ readonly stillQueued: readonly string[] }>
  dispose(): Promise<void>
}
