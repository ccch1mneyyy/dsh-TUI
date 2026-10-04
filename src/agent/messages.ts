/**
 * Agent Domain pure helpers for the agent-message model: delivery-state
 * ordering, the neutral view fold, the DSH durable relay source shape, and
 * the stable prompt-failure mapping both adapters share. Types come from the
 * UI ports; no I/O and no backend import, so the same fold serves live
 * traffic and replay.
 */
import type {
  AgentMessageState,
  AgentMessageSubmitResult,
  AgentMessageView,
} from '../adapter/ports/channel-view.js'

/**
 * Rank of each delivery state in the monotone fold (states only advance).
 * `issued` = the request entered an observable path; `queued` = an inbox
 * accepted it; the four explicit outcomes and `unknown` are final. An
 * unrecognized or missing result ends as `unknown` ("no delivery fact")
 * rather than a guessed outcome.
 */
export const AGENT_MESSAGE_STATE_RANK: Readonly<Record<AgentMessageState, number>> = Object.freeze({
  issued: 0,
  queued: 1,
  delivered: 2,
  held: 2,
  refused: 2,
  expired: 2,
  unknown: 2,
})

/** How many observed message views one channel keeps; oldest dropped. */
export const MAX_AGENT_MESSAGES = 200

/**
 * Fold one observation into the ordered view list. `messageId` is the
 * identity: a re-observation (a tool result after its call, a replayed
 * event) updates the same row instead of appending a second one. A state
 * never regresses (a lower-ranked or same-ranked-different state is
 * dropped), `observedAt` refreshes only on an accepted update, and an
 * empty `next.text` (a settlement carries no text) keeps the row's text.
 */
export function foldAgentMessage(views: AgentMessageView[], next: AgentMessageView): void {
  const index = views.findIndex(view => view.messageId === next.messageId)
  if (index === -1) {
    views.push(next)
    if (views.length > MAX_AGENT_MESSAGES) views.splice(0, views.length - MAX_AGENT_MESSAGES)
    return
  }
  const current = views[index]!
  const rank = AGENT_MESSAGE_STATE_RANK
  if (rank[next.state] < rank[current.state]) return
  if (rank[next.state] === rank[current.state] && next.state !== current.state) return
  views[index] = {
    ...current,
    state: next.state,
    observedAt: next.observedAt,
    ...(next.text === '' ? {} : { text: next.text }),
  }
}

/**
 * The DSH durable relay attribution (`AgentMessageSource`,
 * @deepseek-ai/dsh-subagent continuation-messages): kind 'agent-message',
 * form 'relay' and the sending session id. Anything else (a plain user
 * prompt, plugin/injected context, the runtime's 'subagent-settled' notice)
 * is not a relay; an ordinary user text is never guessed into one.
 */
export interface AgentRelaySource {
  readonly senderSessionId: string
}

/** Narrow a durable message source to a relay attribution, or undefined. */
export function agentRelaySourceOf(source: unknown): AgentRelaySource | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const shape = source as { readonly kind?: unknown; readonly form?: unknown; readonly senderSessionId?: unknown }
  if (shape.kind !== 'agent-message' || shape.form !== 'relay') return undefined
  return typeof shape.senderSessionId === 'string' ? { senderSessionId: shape.senderSessionId } : undefined
}

/** First text of durable content blocks (the message body as shown). */
export function agentMessageTextOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const raw of content) {
    const block = raw as { readonly type?: unknown; readonly text?: unknown } | null
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text.trim()
}

/**
 * Map one `ctx.subagents.prompt` failure to the stable submission
 * vocabulary: the continuation manager's RemoteError codes
 * (control-types.d.ts) and caller cancellation keep their names; anything
 * else is a plain failure whose text is safe to show (already an
 * Error#message, never credential material).
 */
export function agentMessageFailureOf(error: unknown): Extract<AgentMessageSubmitResult, { readonly ok: false }> {
  if (error instanceof Error && error.name === 'AbortError') return { ok: false, reason: 'cancelled' }
  const code = (error as { readonly code?: unknown } | null | undefined)?.code
  if (typeof code === 'string') {
    switch (code) {
      case 'subagent/not-resumable': return { ok: false, reason: 'not-resumable' }
      case 'subagent/unauthorized': return { ok: false, reason: 'unauthorized' }
      case 'subagent/delivery-unavailable': return { ok: false, reason: 'delivery-unavailable' }
      case 'subagent/parent-unavailable': return { ok: false, reason: 'parent-unavailable' }
      case 'gateway/cancelled': return { ok: false, reason: 'cancelled' }
      default: break
    }
  }
  return { ok: false, reason: 'failed', message: error instanceof Error ? error.message : String(error) }
}
