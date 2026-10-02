/**
 * Session switching every composition shares (docs/agent-backend-design.md
 * §3.5): the `tui/session-switch` veto, the fire-and-forget
 * `tui/session-switched` notice, and `/new` — one prepare → adopt
 * transaction over the binding, with the backend's way of opening a fresh
 * session injected (`NewSessionOpener`). The DSH extension injects its
 * preset / route / mount-reservation / workspace-attach create path; any
 * other backend opens through `ChannelLaunchOptions.openSession`.
 *
 * `/new` refuses while a turn runs, and re-checks after the open: a backend
 * handshake can take long (the Claude CLI: up to a minute), and a prompt the
 * user sent to the current session meanwhile must not be torn down by the
 * adoption that disposes it — the candidate is abandoned instead.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentSession } from '../../../agent/session.js'
import { t } from '../../../i18n.js'
import { dispatchTuiDecision, dispatchTuiNotification, normalizeCancelDecision } from '../../extension-events.js'
import type { ChannelCapabilities } from '../../../adapter/ports/channel-view.js'
import type { ChannelBinding } from '../binding.js'
import type { ChannelOwner } from '../owner.js'
import { resetSessionProjection } from '../session-reset.js'
import type { ChannelLaunchOptions } from '../state.js'
import type { ChannelState } from '../types.js'

export type SessionSwitchKind = 'new' | 'resume' | 'agent-view'
export type SessionSwitchedKind = 'new' | 'resume' | 'rewind' | 'fork' | 'agent-view' | 'background'

/** A guarded workspace handoff (`/workspace`); never on `ChannelUi.newSession()`. */
export interface NewSessionTarget {
  readonly cwd: string
  readonly displayCwd?: string
}

/** One `/new` attempt as the backend opens it. */
export interface NewSessionPlan {
  /** Claim whatever the attempt must hold before the session exists (DSH:
   *  the cross-process mount ledger). Runs once, after planning. */
  reserve?(): Promise<void>
  /** Open the fresh session; runs inside the binding's `prepare`. */
  open(cwd: string): Promise<AgentSession>
  /** Ownership work between preparation and adoption (DSH: workspace
   *  attachment); may notify, must not throw. */
  attach?(candidate: AgentSession, current: () => boolean): Promise<void>
  /** The backend's half of the synchronous adoption tail: reset and bind
   *  the candidate. Returns the id the session-switched notice names. */
  adopt(candidate: AgentSession): string
  /** Exactly once on every exit after `reserve`: keep (commit) or release
   *  what the plan holds. */
  finish?(committed: boolean): void
}

/** How a backend opens a fresh session for `/new`. */
export interface NewSessionOpener {
  /** Synchronous gate before anything else (throws to refuse). */
  assertAllowed?(): void
  /** Whether a session can be opened at all; notifies when not. */
  available(): boolean
  /** Everything between the veto and the open. `undefined` stops quietly
   *  (the binding moved on); a throw becomes the `new-session-failed` notice. */
  plan(target: { readonly cwd: string }, current: () => boolean): Promise<NewSessionPlan | undefined>
}

export function createSessionSwitch(ctx: Context, deps: {
  owner: Pick<ChannelOwner, 'current'>
  binding: Pick<ChannelBinding, 'session' | 'capture' | 'isCurrent' | 'prepare' | 'abandon' | 'adopt'>
  state: () => Pick<ChannelState, 'agentId' | 'cwd' | 'displayCwd' | 'working' | 'pending'>
  notify: ChannelState['notify']
  withDecisionPending<T>(name: string, pending: Promise<T>): Promise<T>
  /** What a parked decision's staleness is judged by: the same conversation
   *  across rebinds (default: the session object itself). */
  conversationKey(session: AgentSession): object
  describeWorkspace(cwd: string): { description?: string }
  resetIdeSelection(): void
  clearStagedImages(): void
  opener(): NewSessionOpener | undefined
  unavailable(name: string): void
}) {
  const { binding, notify } = deps

  /**
   * The `tui/session-switch` decision event (pi's `session_before_switch`),
   * fired before `/new` or `/resume` replaces the live session (rewind has
   * its own prompt event). The first answering plugin may veto the switch;
   * the reason is toasted here so the fallback string stays host-localized.
   */
  const sessionSwitchVetoed = async (kind: SessionSwitchKind, targetSessionId?: string): Promise<boolean> => {
    // D-6 stale detection captures the CONVERSATION REFERENCE (session ids
    // are reusable — ABA): a slow decision must not let an older switch roll
    // over a newer session the user already switched to mid-await.
    const origin = deps.conversationKey(binding.session)
    const state = deps.state()
    const decision = await deps.withDecisionPending('tui/session-switch', dispatchTuiDecision(ctx, 'tui/session-switch', {
      kind,
      ...(targetSessionId === undefined ? {} : { targetSessionId }),
      sessionId: state.agentId,
      cwd: state.cwd,
    }, normalizeCancelDecision))
    if (deps.conversationKey(binding.session) !== origin) {
      // The world changed while the decision parked: drop the pending
      // switch instead of replacing the user's newer session.
      notify(t('ext-stale-dropped'), { color: 'warning', timeoutMs: 4000 })
      return true
    }
    if (decision !== undefined) {
      notify(decision.reason ?? t('ext-action-cancelled'), { color: 'warning', timeoutMs: 4000 })
      return true
    }
    return false
  }

  /** Fire-and-forget `tui/session-switched` (parallel): per-session plugin
   *  state rebinds here. Listener failures are logged, never propagated —
   *  the switch itself already succeeded. */
  const notifySessionSwitched = (kind: SessionSwitchedKind, sessionId: string, previousSessionId: string): void => {
    try {
      void dispatchTuiNotification(ctx, 'tui/session-switched', { kind, sessionId, previousSessionId, cwd: deps.state().cwd }).catch((error: unknown) => {
        ctx.logger.warn('dsh-tui: tui/session-switched listener failed: %o', error)
      })
    } catch (error) {
      // A bare embedder's context may lack the event bus entirely; the
      // switch itself already succeeded, so this stays a log line.
      ctx.logger.warn('dsh-tui: tui/session-switched dispatch failed: %o', error)
    }
  }

  const failed = (current: () => boolean, error: unknown): false => {
    if (current()) notify(t('new-session-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
    return false
  }

  /** `/new` (and the `/workspace` handoff): a fresh session of the bound backend. */
  const newSession = async (target?: NewSessionTarget): Promise<boolean> => {
    const opener = deps.opener()
    if (opener === undefined) {
      deps.unavailable('new')
      return false
    }
    opener.assertAllowed?.()
    const adoption = binding.capture()
    const state = deps.state()
    const targetCwd = target?.cwd ?? state.cwd
    const targetDisplayCwd = target?.displayCwd
    const current = (): boolean => deps.owner.current() && binding.isCurrent(adoption)
    if (state.working) {
      notify(t('new-session-while-working'), { color: 'warning' })
      return false
    }
    if (!opener.available()) return false
    // What was already queued when /new began (a backend that holds queued
    // inputs while idle keeps them); only input that arrives during the
    // switch counts as racing it.
    const queuedAtStart = new Set(state.pending.map(item => item.id))
    let plan: NewSessionPlan
    try {
      if (await sessionSwitchVetoed('new') || !current()) return false
      const planned = await opener.plan({ cwd: targetCwd }, current)
      if (planned === undefined) return false
      plan = planned
    } catch (error) {
      return failed(current, error)
    }
    await plan.reserve?.()
    // Do not catch the synchronous commit tail. A post-commit setup failure
    // is owned by binding.adopt(), which revokes the new live session and
    // must reject its caller rather than masquerade as an ordinary false.
    let committed = false
    try {
      let candidate: AgentSession
      try {
        candidate = await binding.prepare(adoption, () => plan.open(targetCwd))
      } catch (error) {
        return failed(current, error)
      }
      if (!current()) { await binding.abandon(candidate); return false }
      if (plan.attach !== undefined) {
        await plan.attach(candidate, current)
        if (!current()) { await binding.abandon(candidate); return false }
      }
      // Review item 9: the open may have taken long (a backend handshake),
      // and the session may have started a turn meanwhile, or taken a
      // prompt the user sent while waiting. Adopting now would dispose that
      // session mid-turn and lose the prompt: abandon the candidate and keep
      // the session the user is working in.
      const live = deps.state()
      if (live.working || live.pending.some(item => !queuedAtStart.has(item.id))) {
        await binding.abandon(candidate)
        if (current()) notify(t('new-session-raced'), { color: 'warning', timeoutMs: 8000 })
        return false
      }
      const result = binding.adopt(candidate, adoption, (previous, disposePrevious) => {
        const previousSessionId = previous.session.ref.sessionId
        const tail = deps.state()
        // The target only becomes shared channel state inside the successful
        // adoption tail. A losing prepared session therefore cannot publish
        // or roll back another workspace's cwd.
        tail.cwd = targetCwd
        tail.displayCwd = targetDisplayCwd ?? deps.describeWorkspace(targetCwd).description ?? targetCwd
        deps.resetIdeSelection()
        // Reset the input FIFO and the pending-decision indicators BEFORE the
        // first emit: a submit enqueued from a session-changed subscriber must
        // land on a fresh chain instead of behind the replaced session's
        // parked promise (main's bind → clear → refresh order).
        deps.clearStagedImages()
        const sessionId = plan.adopt(candidate)
        disposePrevious('dispose')
        notifySessionSwitched('new', sessionId, previousSessionId)
        return true
      })
      committed = true
      return result
    } finally {
      plan.finish?.(committed)
    }
  }

  return { sessionSwitchVetoed, notifySessionSwitched, newSession }
}

export type SessionSwitch = ReturnType<typeof createSessionSwitch>

/**
 * `/new` for a session served by the core alone: the backend's own `open`
 * (`ChannelLaunchOptions.openSession`), then the common projection reset,
 * the new session's identity, capability snapshot and command list, and the
 * bind.
 */
export function createBackendOpener(deps: {
  open: NonNullable<ChannelLaunchOptions['openSession']>
  state: ChannelState
  rowIds: { value: number }
  resetProjection(): void
  snapshotOf(session: AgentSession): ChannelCapabilities
  /** Forget the replaced session's backend commands and reports. */
  resetControls(): void
  bind(): void
}): NewSessionOpener {
  const { state } = deps
  return {
    available: () => true,
    plan: () => Promise.resolve({
      open: cwd => deps.open({ kind: 'create', cwd }),
      adopt(candidate) {
        resetSessionProjection(state, deps.rowIds, deps.resetProjection, () => undefined, () => undefined)
        state.agentId = candidate.ref.sessionId
        state.sessionId = candidate.ref.sessionId
        state.capabilities = deps.snapshotOf(candidate)
        deps.resetControls()
        deps.bind()
        state.emit()
        return candidate.ref.sessionId
      },
    }),
  }
}
