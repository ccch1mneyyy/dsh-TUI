/**
 * Decision-point events the TUI fires on the cordis bus so plugins can
 * intercept, cancel, or customize interactive flows — the `session_before_*`
 * style seam (pi's `session_before_fork` / `input` events) expressed in
 * cordis dispatch semantics.
 *
 * All of these are FIRED BY THE CHANNEL and answered by plugins (`ctx.on`).
 * No service row is involved: an absent listener simply means "no opinion",
 * and the built-in flow proceeds unchanged. Dispatch is SERIAL IN ORDER with
 * the first VALID decision winning — see {@link dispatchTuiDecision} for why
 * this is not raw `ctx.serial`: per-listener crash isolation and return-value
 * normalization mean a broken or malformed listener can never skip a later
 * (possibly safety) veto.
 *
 * Synchronous-only rule: handlers may be async, but while a decision is
 * awaited the originating UI flow is parked (the submit is not delivered,
 * the rewind confirm has not happened). Handlers that need user input should
 * use the managed dialogs (`ctx.tuiDialogs`) or open a scene, then resolve.
 */

import type { Context } from '@deepseek-ai/cordis'
import { cleanScalarText } from './sanitize.js'

/** Toast-bound plugin text (veto reasons) is render-path data: sanitized
 *  with the one shared implementation, capped at toast width. */
const NOTICE_CELLS = 200

/**
 * Dispatch a decision event listener-by-listener in registration order.
 *
 * Deliberately NOT `ctx.serial`: cordis bails at ANY non-null/false/undefined
 * return, so a malformed-but-object decision (a blank `{ text }` rewrite, a
 * junk primitive) would cut the chain before a later veto listener runs —
 * and one throwing listener rejects the whole dispatch, skipping every later
 * listener. Here:
 *
 * - a throwing listener is logged and the chain CONTINUES;
 * - each return value passes through `normalize` (per-event validation)
 *   INSIDE the same isolation boundary — a Proxy/throwing-getter return is
 *   logged and skipped like any other invalid shape;
 * - "no opinion" (undefined/null/false) and invalid shapes are logged and
 *   the chain CONTINUES;
 * - the first listener whose NORMALIZED decision is non-undefined wins.
 *
 * Listeners are resolved via the documented `EventsService.dispatch` (context
 * filtering applied); a degraded/fake ctx resolves to zero listeners, i.e.
 * "no opinions", matching the previous try/catch-around-serial degradation.
 */
export async function dispatchTuiDecision<T>(
  ctx: Context,
  name: string,
  payload: Record<string, unknown>,
  normalize: (result: unknown, warn: (what: string) => void) => T | undefined,
): Promise<T | undefined> {
  type Listener = (event: Record<string, unknown>) => unknown
  let listeners: readonly Listener[]
  try {
    const events = (ctx as { events?: { dispatch?(type: string, args: unknown[]): unknown } }).events
    const resolved = events?.dispatch?.('serial', [name, payload])
    listeners = Array.isArray(resolved) ? (resolved as Listener[]) : []
  } catch {
    listeners = []
  }
  const log = (message: string, error?: unknown): void => {
    try {
      if (error === undefined) ctx.logger.warn(message)
      else ctx.logger.warn(message, error)
    } catch {
      // Degraded ctx without a logger: warnings are best-effort.
    }
  }
  for (const listener of listeners) {
    let result: unknown
    try {
      result = await listener(payload)
    } catch (error) {
      log(`dsh-tui: ${name} listener failed; continuing with the next listener: %o`, error)
      continue
    }
    // normalize runs INSIDE the isolation boundary too: a hostile return
    // value (a Proxy or a throwing getter) must not reject the dispatch —
    // that would cut the chain before later veto listeners run, and leave
    // unhandled rejections at the fire-and-forget call sites.
    let decision: T | undefined
    try {
      decision = normalize(result, what => log(`dsh-tui: ${name} listener returned ${what}; ignored`))
    } catch (error) {
      log(`dsh-tui: ${name} listener returned a value that threw during validation; ignored: %o`, error)
      continue
    }
    if (decision !== undefined) return decision
  }
  return undefined
}

/** Shared normalizer for the veto-only decisions (session-switch, compact):
 *  `{ cancel: true, reason? }` or no opinion; everything else is ignored.
 *  The reason is toast-bound plugin text — sanitized (a veto must not
 *  smuggle control sequences onto the screen). */
export function normalizeCancelDecision(
  result: unknown,
  warn: (what: string) => void,
): { cancel: true; reason?: string } | undefined {
  if (result === undefined || result === null || result === false) return undefined
  if (typeof result === 'object' && (result as { cancel?: unknown }).cancel === true) {
    const reason = cleanScalarText((result as { reason?: unknown }).reason, NOTICE_CELLS)
    return { cancel: true, ...(reason === '' ? {} : { reason }) }
  }
  warn('an unrecognized decision shape')
  return undefined
}

/** Shared context every decision event carries. */
export interface TuiDecisionContext {
  /** The live session (agent) id the flow belongs to. */
  sessionId: string
  /** Working directory of the session. */
  cwd: string
}

/**
 * Fired before user-typed text is delivered to the model (`submit` and
 * `steer`; local `!`/`!!` shell lines never fire it — they are not model
 * input). The message is NOT yet in the session log; nothing is observable
 * from the transcript at this point.
 */
export interface TuiInputEvent extends TuiDecisionContext {
  /** The trimmed text as typed. */
  text: string
  /** Where the text would go: a new turn (`followup`) or the running one. */
  delivery: 'followup' | 'steer'
}

export type TuiInputDecision =
  /** Replace the text; the substitute is delivered instead. */
  | { text: string }
  /** The plugin consumed the input itself; nothing is delivered. An optional
   *  notice is toasted so the user is not left wondering where the line went. */
  | { handled: true; notice?: string }
  /** Drop the input; an optional reason is toasted as a warning. */
  | { cancel: true; reason?: string }
  /** No opinion — delivery proceeds unchanged. */
  | undefined

/**
 * Fired when the rewind picker confirms a message, BEFORE the fork happens.
 * `seq` is the session event seq of the picked user message (the fork itself
 * lands just before its turn — see channel.rewindTo).
 */
export interface TuiRewindPromptEvent extends TuiDecisionContext {
  /** Text of the picked message. */
  text: string
  /** Session event seq of the picked message. */
  seq: number
}

/** One extra rewind mode offered by a plugin (e.g. "also restore files"). */
export interface TuiRewindMode {
  /** Stable id reported back in `TuiRewindDoneEvent.mode`. */
  id: string
  /** One-line label shown in the confirm pane. */
  label: string
  /** Optional dimmed description under the label. */
  description?: string
}

export type TuiRewindPromptDecision =
  /** Abort the rewind; the picker stays open. Optional reason is toasted. */
  | { cancel: true; reason?: string }
  /** Extra choices rendered in the confirm pane on top of the built-in
   *  conversation-only rewind (which stays option zero). */
  | { modes: readonly TuiRewindMode[] }
  /** No opinion — the plain confirm pane shows, exactly as before. */
  | undefined

/**
 * Fired after a rewind completed: the forked session is live and the
 * transcript replayed. The first listener returning a non-empty string has
 * it toasted as the post-rewind summary (serial bail semantics).
 */
export interface TuiRewindDoneEvent extends TuiDecisionContext {
  /** Text of the message that was rewound to (back in the input). */
  text: string
  /** The mode id the user picked, or null for the built-in
   *  conversation-only rewind. */
  mode: string | null
  /** Inclusive source seq the fork cut at (the child's seed end). */
  boundarySeq: number
  /** The session that was forked away from. */
  sourceSessionId: string
  /** The freshly created fork session — now the live one. */
  childSessionId: string
}

/**
 * Fired before the live session is replaced (`/new` or `/resume`; rewind has
 * its own prompt event above). `targetSessionId` is set for resume only.
 */
export interface TuiSessionSwitchEvent extends TuiDecisionContext {
  kind: 'new' | 'resume'
  targetSessionId?: string
}

export type TuiSessionSwitchDecision =
  /** Abort the switch; the current session stays live. Optional reason is
   *  toasted as a warning. */
  | { cancel: true; reason?: string }
  | undefined

/**
 * Notification (parallel, fire-and-forget) after the live session changed.
 * Listener errors are logged, never propagated. Rebind per-session state
 * here; `previousSessionId` is undefined only when there was nothing live
 * before (not currently produced — every switch has a live source).
 */
export interface TuiSessionSwitchedEvent extends TuiDecisionContext {
  kind: 'new' | 'resume' | 'rewind'
  /** The session that just went live. */
  sessionId: string
  previousSessionId?: string
}

/** Fired before manual `/compact` runs. */
export interface TuiCompactEvent extends TuiDecisionContext {}

export type TuiCompactDecision =
  /** Abort the compaction; optional reason is toasted as a warning. */
  | { cancel: true; reason?: string }
  | undefined

declare module '@deepseek-ai/cordis' {
  interface Events {
    'tui/input'(event: TuiInputEvent): TuiInputDecision | Promise<TuiInputDecision>
    'tui/rewind-prompt'(event: TuiRewindPromptEvent): TuiRewindPromptDecision | Promise<TuiRewindPromptDecision>
    'tui/rewind-done'(event: TuiRewindDoneEvent): string | undefined | Promise<string | undefined>
    'tui/session-switch'(event: TuiSessionSwitchEvent): TuiSessionSwitchDecision | Promise<TuiSessionSwitchDecision>
    'tui/session-switched'(event: TuiSessionSwitchedEvent): void | Promise<void>
    'tui/compact'(event: TuiCompactEvent): TuiCompactDecision | Promise<TuiCompactDecision>
  }
}
