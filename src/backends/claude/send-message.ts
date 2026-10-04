/**
 * The Claude SendMessage tool's neutral observation (design agent-team-full
 * §2.2/§5.4): the parent's model-authored relay to another agent is the ONLY
 * child-directed send Claude exposes, and its tool call/result on the parent
 * lane is the observable fact. Pure parsing/projection only — the hooks in
 * translate.ts decide where an observation belongs (main lane = the parent
 * itself sent it; a subagent lane = that subagent sent it, keyed by the
 * delegating call).
 *
 * Delivery honesty rules (agent-team §5.2):
 *  - a call alone proves nothing beyond `issued` (a successful tool call is
 *    NOT a delivery fact);
 *  - only a structured result field naming a state (`delivery`/`status` in
 *    {delivered, held, refused, expired}) or an explicit error marks more;
 *  - any other shape — including a bare success — is `unknown`, the legal
 *    terminal. Nothing is ever inferred from the tool having succeeded.
 */
import type { AgentMessageState, AgentMessageView } from '../../adapter/ports/channel-view.js'

type Record_ = Readonly<Record<string, unknown>>
const rec = (value: unknown): Record_ | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record_ : undefined
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

/** The SendMessage tool input as this module recognizes it: the addressed
 *  agent (`to`) and the body (`message`, falling back to `text`). An input
 *  without both is not an observable fact — no view is fabricated for it. */
export interface SendMessageInput {
  readonly to: string
  readonly text: string
}

/** Parse one SendMessage tool call's input; undefined when unrecognizable. */
export function parseSendMessageInput(input: unknown): SendMessageInput | undefined {
  const args = rec(input)
  if (args === undefined) return undefined
  const to = str(args.to)
  const body = str(args.message) ?? str(args.text)
  if (to === undefined || to === '' || body === undefined || body === '') return undefined
  return { to, text: body }
}

/** The observation of one call (agent-team §5.4): state `issued`. `lane`
 *  names the sending subagent's delegating call id; on the main lane the
 *  sender is the parent itself (rendered from the absent `from`). */
export function sendMessageCallView(input: { readonly callId: string; readonly lane?: string; readonly observedAt: number; readonly input: SendMessageInput }): AgentMessageView {
  return {
    messageId: input.callId,
    ...(input.lane === undefined ? {} : { from: input.lane }),
    to: input.input.to,
    via: 'claude-parent-mediated',
    text: input.input.text,
    state: 'issued',
    sourceRef: input.callId,
    observedAt: input.observedAt,
  }
}

/** The states a structured result may explicitly name (agent-team §3). */
const EXPLICIT_STATES: Readonly<Record<string, AgentMessageState>> = Object.freeze({
  delivered: 'delivered',
  held: 'held',
  refused: 'refused',
  expired: 'expired',
})

/**
 * The settled state of one SendMessage result: an explicit error is a
 * refusal fact; a structured `delivery`/`status` field naming a state
 * marks exactly that; any other shape — including a bare success — is
 * `unknown` (never a guessed delivery).
 */
export function sendMessageResultState(result: { readonly isError: boolean; readonly structured: unknown }): AgentMessageState {
  if (result.isError) return 'refused'
  const structured = rec(result.structured)
  if (structured !== undefined) {
    for (const key of ['delivery', 'status'] as const) {
      const named = EXPLICIT_STATES[str(structured[key]) ?? '']
      if (named !== undefined) return named
    }
  }
  return 'unknown'
}

/** The settlement observation of one call: the same durable identity (the
 *  parent tool call id); the fold advances the state and nothing else. */
export function sendMessageResultView(input: { readonly callId: string; readonly observedAt: number; readonly state: AgentMessageState }): AgentMessageView {
  return {
    messageId: input.callId,
    via: 'claude-parent-mediated',
    text: '',
    state: input.state,
    sourceRef: input.callId,
    observedAt: input.observedAt,
  }
}
