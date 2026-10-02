/**
 * Session switching every composition shares (docs/agent-backend-design.md
 * §3.5, §4.11): the `tui/session-switch` veto, the fire-and-forget
 * `tui/session-switched` notice, `/new` and the generic `/resume` — each one
 * prepare → adopt transaction over the binding, with the backend's way of
 * opening the session injected. The DSH extension injects its preset / route
 * / mount-reservation / workspace-attach create path (and keeps its own
 * `/resume`, which parks sessions in this process); any other backend opens
 * through `ChannelLaunchOptions.openSession`.
 *
 * `/new` and `/resume` refuse while a turn runs, and re-check after the open:
 * a backend handshake can take long (the Claude CLI: up to a minute), and a
 * prompt the user sent to the current session meanwhile must not be torn
 * down by the adoption that disposes it — the candidate is abandoned instead.
 *
 * `/resume` reads the target's durable history BEFORE the synchronous
 * adoption and paints it inside the adoption, ahead of the subscription:
 * nothing the live session emits can land before its history (design
 * §4.11). The cross-process mount ledger is claimed under the backend-
 * qualified key (`claude:<id>`) for the whole attempt, exactly like a DSH
 * disk resume: a session another TUI process drives is refused.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentEvent } from '../../../agent/events.js'
import { formatSessionRef } from '../../../agent/refs.js'
import type { AgentSession } from '../../../agent/session.js'
import { t } from '../../../i18n.js'
import { mountFailureText } from '../../../sessions/resumeFailure.js'
import { releaseMount, reserveMount, reserveNewSession, type MountReservation } from '../../../sessionMounts.js'
import { dispatchTuiDecision, dispatchTuiNotification, normalizeCancelDecision } from '../../extension-events.js'
import type { ChannelCapabilities } from '../../../adapter/ports/channel-view.js'
import type { ChannelBinding } from '../binding.js'
import type { ChannelOwner } from '../owner.js'
import { resetSessionProjection } from '../session-reset.js'
import type { ChannelLaunchOptions } from '../state.js'
import type { ChannelState, ResumeResult } from '../types.js'

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
  /**
   * The backend's own contract for an input still in the channel's FIFO
   * when `/new` adopts (a parked `tui/input` decision, an `@` or IDE read):
   * `true` = it is stale-dropped with a notice, never delivered anywhere
   * (DSH, pinned by verify-session-reset-hygiene scenario 8); absent = the
   * input belongs to the session it was typed in, so `/new` is abandoned
   * instead (a backend handshake can take a minute — Phase 4a review 6).
   */
  readonly dropsParkedInputs?: boolean
  /** Synchronous gate before anything else (throws to refuse). */
  assertAllowed?(): void
  /** Whether a session can be opened at all; notifies when not. */
  available(): boolean
  /** Everything between the veto and the open. `undefined` stops quietly
   *  (the binding moved on); a throw becomes the `new-session-failed` notice. */
  plan(target: { readonly cwd: string }, current: () => boolean): Promise<NewSessionPlan | undefined>
}

/** One `/resume` attempt (or a rewind's adoption of its fork) as the
 *  backend opens it. */
export interface ResumeSessionPlan {
  /** Claim the session before it opens (the cross-process mount ledger);
   *  a returned result refuses the resume. Runs once, after the veto. */
  reserve?(): Promise<ResumeResult | undefined>
  /** Open the session AND read its durable history; runs inside the
   *  binding's `prepare`. */
  open(): Promise<AgentSession>
  /** The backend's half of the synchronous adoption tail (paints the history
   *  read by `open`, then binds). Returns the id the switched notice names. */
  adopt(candidate: AgentSession): string
  /** Exactly once on every exit after `reserve`: keep or release. */
  finish?(committed: boolean): void
}

/** How a backend reopens a persisted session (`/resume`, a rewind's fork). */
export interface ResumeSessionOpener {
  plan(target: { readonly sessionId: string }): ResumeSessionPlan
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
  /**
   * Monotonic activity of the bound session, compared across the open:
   * inputs dispatched (the input FIFO and `!!`), whether one is still on its
   * way, and live turns started.
   */
  activity(): { readonly inputs: number; readonly unsettled: boolean; readonly turnStarts: number; readonly parked?: string }
  /** How `/resume` reopens a persisted session (undefined = unavailable). */
  resumeOpener?(): ResumeSessionOpener | undefined
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

  /**
   * Review 6 (Phase 4b): an input still on its way to the bound session (a
   * parked decision, an `@` read, a `!!` command) would race any switch —
   * refuse at once, naming it, instead of after a handshake of up to a
   * minute. Not for an opener that stale-drops parked inputs (the DSH
   * contract).
   */
  const parkedInputRefused = (dropsParkedInputs: boolean): boolean => {
    if (dropsParkedInputs) return false
    const activity = deps.activity()
    if (!activity.unsettled) return false
    const parked = (activity.parked ?? '').replace(/\s+/gu, ' ').trim()
    notify(t('session-switch-input-parked', { input: parked.length > 40 ? `${parked.slice(0, 40)}…` : parked }), { color: 'warning', timeoutMs: 8000 })
    return true
  }

  const failed = (current: () => boolean, error: unknown): false => {
    if (current()) notify(t('new-session-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
    return false
  }

  /**
   * Review item 9 (and its Phase 4a follow-up), for `/new` and `/resume`:
   * the open may take long (a backend handshake), and the bound session may
   * run — or still be running — work the user started meanwhile: a turn
   * (even one that already finished: `working` alone misses it), a prompt
   * queued in the backend, or an input still in the channel's own FIFO (a
   * parked decision, an `@` or IDE-selection read, a `!!` command). Adopting
   * then would dispose that session and lose the work: the caller abandons
   * its candidate. What was already queued when the switch began does not
   * count (a backend that holds queued inputs while idle keeps them).
   * `dropsParkedInputs`: the backend stale-drops FIFO inputs at adoption
   * instead (the DSH contract), so they do not race it.
   */
  const raceProbe = (dropsParkedInputs: boolean): (() => boolean) => {
    const queuedAtStart = new Set(deps.state().pending.map(item => item.id))
    const activityAtStart = deps.activity()
    return () => {
      const live = deps.state()
      const activity = deps.activity()
      return live.working
        || live.pending.some(item => !queuedAtStart.has(item.id))
        || activity.turnStarts !== activityAtStart.turnStarts
        || (!dropsParkedInputs && (activity.inputs !== activityAtStart.inputs || activity.unsettled))
    }
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
    if (parkedInputRefused(opener.dropsParkedInputs === true)) return false
    const raced = raceProbe(opener.dropsParkedInputs === true)
    const abandonRaced = async (candidate: AgentSession): Promise<false> => {
      await binding.abandon(candidate)
      if (current()) notify(t('new-session-raced'), { color: 'warning', timeoutMs: 8000 })
      return false
    }
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
      // Checked before the attach too: an abandoned candidate must not have
      // been accounted to a workspace first (DSH ownership is durable).
      if (raced()) return await abandonRaced(candidate)
      if (plan.attach !== undefined) {
        await plan.attach(candidate, current)
        if (!current()) { await binding.abandon(candidate); return false }
      }
      if (raced()) return await abandonRaced(candidate)
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

  /**
   * `/resume` (and the adoption of a rewind's fork, `kind: 'rewind'`): a
   * persisted session of the bound backend replaces the bound one. The bound
   * session is closed by the adoption; a running turn refuses the switch.
   */
  const resumeSession = async (sessionId: string, kind: 'resume' | 'rewind' = 'resume'): Promise<ResumeResult> => {
    const opener = deps.resumeOpener?.()
    if (opener === undefined) {
      deps.unavailable('resume')
      return { ok: false, reason: 'unavailable' }
    }
    // Already attached: a no-op, not a switch (never reopen the live session).
    if (sessionId === binding.session.ref.sessionId) return { ok: true }
    const adoption = binding.capture()
    const current = (): boolean => deps.owner.current() && binding.isCurrent(adoption)
    const state = deps.state()
    if (state.working) {
      notify(t(kind === 'rewind' ? 'rewind-while-working' : 'resume-while-working'), { color: 'warning' })
      return { ok: false, reason: 'working' }
    }
    if (parkedInputRefused(false)) return { ok: false, reason: 'cancelled' }
    const raced = raceProbe(false)
    // A rewind asked its own question (the rewind prompt) already.
    if (kind === 'resume') {
      try {
        if (await sessionSwitchVetoed('resume', sessionId)) return { ok: false, reason: 'cancelled' }
      } catch (error) {
        return resumeFailed(current, error)
      }
    }
    if (!current()) return { ok: false, reason: 'cancelled' }
    const plan = opener.plan({ sessionId })
    let committed = false
    try {
      const refused = await plan.reserve?.()
      if (refused !== undefined) return refused
      if (!current()) return { ok: false, reason: 'cancelled' }
      let candidate: AgentSession
      try {
        candidate = await binding.prepare(adoption, () => plan.open())
      } catch (error) {
        return resumeFailed(current, error)
      }
      if (!current()) { await binding.abandon(candidate); return { ok: false, reason: 'cancelled' } }
      // The /new race rule: work that started on the bound session while
      // the other one was opening keeps its session.
      if (raced()) {
        await binding.abandon(candidate)
        if (current()) notify(t('resume-raced'), { color: 'warning', timeoutMs: 8000 })
        return { ok: false, reason: 'cancelled' }
      }
      const result = binding.adopt<ResumeResult>(candidate, adoption, (previous, disposePrevious) => {
        const previousSessionId = previous.session.ref.sessionId
        const tail = deps.state()
        tail.cwd = candidate.cwd
        tail.displayCwd = deps.describeWorkspace(candidate.cwd).description ?? candidate.cwd
        deps.resetIdeSelection()
        deps.clearStagedImages()
        const adopted = plan.adopt(candidate)
        disposePrevious('dispose')
        notifySessionSwitched(kind, adopted, previousSessionId)
        return { ok: true }
      })
      committed = true
      return result
    } finally {
      plan.finish?.(committed)
    }
  }

  const resumeFailed = (current: () => boolean, error: unknown): ResumeResult => {
    const message = error instanceof Error ? error.message : String(error)
    if (current()) notify(t('resume-failed', { err: message }), { color: 'error', timeoutMs: 8000 })
    return { ok: false, reason: 'failed', error: message }
  }

  return { sessionSwitchVetoed, notifySessionSwitched, newSession, resumeSession }
}

export type SessionSwitch = ReturnType<typeof createSessionSwitch>

/** The mount ledger as the core uses it (injectable for regressions). */
export interface SessionMountLedger {
  reserve(key: string): ReturnType<typeof reserveMount>
  /** Announce a freshly created session (a refusal costs announcement only). */
  announce(key: string): void
  release(key: string): void
}

/** The process-wide ledger (`~/.dsh-tui/session-mounts.json`). */
export const SESSION_MOUNT_LEDGER: SessionMountLedger = {
  reserve: key => reserveMount(key),
  announce: key => { void reserveNewSession(key).then(({ reservation }) => { reservation.settle() }, () => undefined) },
  release: key => { releaseMount(key) },
}

/**
 * `/new` and `/resume` for a session served by the core alone: the backend's
 * own `open`, the session's history read ahead of the adoption, then the
 * common projection reset, the new session's identity, capability snapshot
 * and command list, the history painted and the bind. The mount ledger holds
 * the backend-qualified key of the bound session (`claude:<id>`): a resume
 * claims it for the whole attempt and refuses one another TUI process holds;
 * a create announces its fresh id; the replaced session's claim is released.
 */
export function createBackendOpener(deps: {
  open: NonNullable<ChannelLaunchOptions['openSession']>
  state: ChannelState
  rowIds: { value: number }
  resetProjection(): void
  /** Forget the replaced session's subagents and background jobs. */
  resetActivity?(): void
  snapshotOf(session: AgentSession): ChannelCapabilities
  /** Forget the replaced session's backend commands and reports. */
  resetControls(): void
  bind(seed: readonly AgentEvent[]): void
  /** The bound session (its backend-qualified reference is the ledger key). */
  bound(): AgentSession
  mounts: SessionMountLedger
  touch?(sessionId: string): void
  notify: ChannelState['notify']
}): { create: NewSessionOpener; resume: ResumeSessionOpener } {
  const { state } = deps
  const boundKey = (): string => formatSessionRef(deps.bound().ref)
  /** Open, then read the history ahead of the adoption (a failed read
   *  closes the session it opened). */
  const openWithHistory = async (open: () => Promise<AgentSession>): Promise<{ session: AgentSession; history: readonly AgentEvent[] }> => {
    const session = await open()
    try {
      return { session, history: await session.history() }
    } catch (error) {
      await session.dispose().catch(() => undefined)
      throw error
    }
  }
  const adoptWith = (candidate: AgentSession, history: readonly AgentEvent[]): string => {
    resetSessionProjection(state, deps.rowIds, deps.resetProjection, () => { deps.resetActivity?.() }, () => undefined)
    state.agentId = candidate.ref.sessionId
    state.sessionId = candidate.ref.sessionId
    state.capabilities = deps.snapshotOf(candidate)
    deps.resetControls()
    deps.bind(history)
    deps.touch?.(candidate.ref.sessionId)
    state.emit()
    return candidate.ref.sessionId
  }
  return {
    create: {
      available: () => true,
      plan: () => {
        let history: readonly AgentEvent[] = []
        // The session the adoption replaces (an adoption commits only while
        // the binding is still the one captured with this plan).
        const previousKey = boundKey()
        return Promise.resolve({
          open: async cwd => {
            const opened = await openWithHistory(() => deps.open({ kind: 'create', cwd }))
            history = opened.history
            return opened.session
          },
          adopt: candidate => adoptWith(candidate, history),
          finish(committed) {
            if (!committed) return
            deps.mounts.announce(boundKey())
            deps.mounts.release(previousKey)
          },
        })
      },
    },
    resume: {
      plan(target) {
        let history: readonly AgentEvent[] = []
        let reservation: MountReservation | undefined
        const previousKey = boundKey()
        // Within one backend per process: the target is of the bound backend.
        const key = formatSessionRef({ backendId: deps.bound().ref.backendId, sessionId: target.sessionId })
        return {
          async reserve() {
            const reserved = await deps.mounts.reserve(key)
            if (reserved.ok) { reservation = reserved.reservation; return undefined }
            const text = mountFailureText(reserved)
            deps.notify(text, { color: 'error', timeoutMs: 8000 })
            return reserved.reason === 'occupied'
              ? { ok: false, reason: 'occupied', pid: reserved.holders[0] ?? 0 }
              : { ok: false, reason: 'failed', error: text }
          },
          async open() {
            const opened = await openWithHistory(() => deps.open({ kind: 'resume', sessionId: target.sessionId }))
            history = opened.history
            return opened.session
          },
          adopt: candidate => adoptWith(candidate, history),
          finish(committed) {
            if (committed) reservation?.settle()
            else reservation?.abandon()
            if (committed) deps.mounts.release(previousKey)
          },
        }
      },
    },
  }
}
