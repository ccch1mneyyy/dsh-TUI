import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { explicitModelRoute, recordedModelRoute, resolveModelRoute, validateModelRoute } from '../../modelRoute.js'
import { clearResumeTarget, writeResumeTarget, touchAgentViewSession, touchSession } from '../../sessionHistory.js'
import { mountFailureText } from '../../sessions/resumeFailure.js'
import { t } from '../../i18n.js'
import { readModelPref } from '../../modelPrefs.js'
import { migratePresetPref, readPresetPref } from '../../presetPrefs.js'
import { agentViewHasTurns } from '../agent-view.js'
import {
  occupancyOf,
  readSessionOwners,
  reserveMount,
  reserveNewSession,
  type MountReservation,
} from '../../sessionMounts.js'
import { ensureLegacySessionEventTypes } from '../compat/index.js'
import { snapshotLiveSessionEvents } from '../compat/liveSession.js'
import { composePreset, resolvePersistedPreset, resolvePersistedRoute } from '../presets.js'
import { attachSessionToWorkspace } from '../workspace.js'
import { resetSessionProjection } from './session-reset.js'
import type { createChannelBinding } from './binding.js'
import type { ChannelOwner } from './owner.js'
import { assertCapabilityShadowPolicy, type AdapterRuntimeOptions } from '../../adapter/kernel/runtime.js'
import type { ChannelState, ResumeResult } from './types.js'

type Binding = ReturnType<typeof createChannelBinding>
type ResumeState = Pick<
  ChannelState,
  | 'working'
  | 'status'
  | 'agentId'
  | 'cwd'
  | 'displayCwd'
  | 'agentPreset'
  | 'provider'
  | 'model'
  | 'loadedContext'
  | 'contextWindow'
  | 'effortLevels'
  | 'reasoningEffort'
  | 'working'
  | 'emit'
> & Parameters<typeof resetSessionProjection>[0]

export type NewSessionTarget = {
  /** Internal guarded workspace handoff; never exposed on ChannelUi.newSession(). */
  readonly cwd: string
  readonly displayCwd?: string
}

type ResumeAgents = {
  resume(options: {
    resumeSessionId: SessionId
    agentOptions?: { provider?: string; model?: string }
    setup?: CreateAgentOptions['setup']
  }): Promise<AgentHandle>
  /**
   * The live agent for a session id, when this process already hosts one.
   * Optional: a composition without the roster still resumes from disk, it
   * just cannot tell "already mounted here" from "on disk" up front.
   */
  get?(id: SessionId): Agent | undefined
}

/** Persisted-session and fresh-session foreground actions. */
export function createSessionResumeActions(
  ctx: Context,
  state: ResumeState,
  options: {
    configuredPreset?: string
    configuredProvider?: string
    configuredModel?: string
    provider: string
    model: string
  },
  deps: {
    owner: Pick<ChannelOwner, 'current'>
    binding: Pick<Binding, 'agent' | 'capture' | 'isCurrent' | 'prepare' | 'abandon' | 'adopt'>
    /**
     * Adopt an agent this process already has live. `/resume` uses it so a
     * target that is already running here is re-attached in place (parking the
     * session left behind) instead of being resumed a second time from its log.
     */
    adoptLive(target: Agent): Promise<ResumeResult>
    backgroundHandles: Map<string, AgentHandle>
    rowIds: { value: number }
    resetProjector(): void
    resetSubagents(): void
    resetJobs(): void
    replay(events: readonly SessionEvent[]): void
    settleReplay(): void
    describeWorkspace(cwd: string): { description?: string }
    refreshGitBranch(): void
    bindAgent(): void
    refreshCommands(): void
    refreshLoadedContext(): Promise<void>
    refreshSkillCommands(): Promise<void>
    clearStagedImages(): void
    /** Drop the live IDE selection: the adopted session's cwd differs from
     *  the one the selection was made in. */
    resetIdeSelection(): void
    settleCompaction(): Promise<void>
    sessionSwitchVetoed(kind: 'new' | 'resume' | 'agent-view', targetSessionId?: string): Promise<boolean>
    notify: ChannelState['notify']
    notifySessionSwitched(kind: 'new' | 'resume' | 'agent-view', sessionId: string, previousSessionId: string): void
    runtime: AdapterRuntimeOptions
  },
) {
  const resetAndBind = (
    handle: AgentHandle,
    agentPreset: string | undefined,
    route: { provider: string; model: string } | undefined,
    replay: boolean,
  ): void => {
    resetSessionProjection(state, deps.rowIds, deps.resetProjector, deps.resetSubagents, deps.resetJobs)
    state.status = handle.agent.status
    state.agentId = handle.agent.id
    state.agentPreset = agentPreset
    if (route !== undefined) {
      state.provider = route.provider
      state.model = route.model
    }
    state.loadedContext = undefined
    state.contextWindow = undefined
    state.effortLevels = undefined
    state.reasoningEffort = undefined
    if (replay) {
      deps.replay(snapshotLiveSessionEvents(handle.agent.session))
      deps.settleReplay()
      // A resumed log can end mid-turn; mirror boot's post-replay status.
      state.working = handle.agent.status === 'running'
    }
    deps.bindAgent()
    deps.refreshCommands()
    void deps.refreshLoadedContext()
    void deps.refreshSkillCommands()
  }

  /** Resume a persisted session, optionally parking the attached agent for agent-view attachment. */
  const resume = async (
    sessionId: string,
    kind: 'resume' | 'agent-view',
    keepCurrent: boolean,
    adoption: ReturnType<Binding['capture']>,
    entrySession?: Agent['session'],
    /**
     * The ledger reservation this call holds for `sessionId`; ended by this
     * function on every exit. `settle` on a commit (the agent is in the
     * registry from then on), `abandon` on every path that ends WITHOUT one —
     * including a throwing `binding.adopt()` and a setup failure inside its
     * tail, which revokes the candidate.
     */
    reservation?: MountReservation,
  ): Promise<ResumeResult> => {
    /**
     * The reservation is ended on EVERY exit from here, so the attempt owns it
     * for the whole body: `settle` on a commit (the agent is in the registry
     * from then on), `abandon` on everything else — a throwing
     * `binding.adopt()`, a setup failure inside its tail, and also a throw from
     * the preset/route reads below, which used to sit outside any guard and
     * would have left a pin that republishes the session as ours on every beat.
     */
    let committed = false
    try {
      return await runResume()
    } finally {
      if (committed) reservation?.settle()
      else reservation?.abandon()
    }

    async function runResume(): Promise<ResumeResult> {
      const agents = ctx.get('agents') as ResumeAgents | undefined
      if (!agents) {
        deps.notify(t('resume-unavailable'), { color: 'error' })
        return { ok: false, reason: 'unavailable' }
      }
      ensureLegacySessionEventTypes()
      const composed = await composePreset(ctx, await resolvePersistedPreset(ctx, SessionId(sessionId)))
      const explicitRoute = explicitModelRoute({ provider: options.configuredProvider, model: options.configuredModel })
      const persistedRoute = await resolvePersistedRoute(ctx, SessionId(sessionId))
      let handle: AgentHandle
      try {
        handle = await deps.binding.prepare(adoption, () => agents.resume({
          resumeSessionId: SessionId(sessionId),
          agentOptions: {
            provider: explicitRoute?.provider ?? persistedRoute?.provider,
            model: explicitRoute?.model ?? persistedRoute?.model,
          },
          ...(composed.setup === undefined ? {} : { setup: composed.setup }),
        }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        deps.notify(t('resume-failed', { err: message }), { color: 'error', timeoutMs: 8000 })
        return { ok: false, reason: 'failed', error: message }
      }
      if (!deps.binding.isCurrent(adoption)) {
        await deps.binding.abandon(handle)
        return { ok: false, reason: 'cancelled' }
      }
      try {
        await attachSessionToWorkspace(ctx, handle.agent.session.header.cwd ?? state.cwd, SessionId(sessionId))
      } catch (error) {
        deps.notify(t('resume-attach-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'warning', timeoutMs: 8000 })
      }
      if (entrySession !== undefined && (!deps.owner.current() || deps.binding.agent.session !== entrySession)) {
        await deps.binding.abandon(handle)
        deps.notify(t('resume-session-changed'), { color: 'error' })
        return { ok: false, reason: 'failed', error: 'live session changed during resume' }
      }
      // `adopt` is a transaction: it revokes the candidate and disposes it when
      // the tail fails, and it can also refuse before the tail ever runs. Only a
      // normal return is a commit, which is what the outer finally keys on.
      const result = deps.binding.adopt<ResumeResult>(handle, adoption, (committedBinding, disposePrevious) => {
        const previousSessionId = String(committedBinding.agent.session.id)
        state.cwd = handle.agent.session.header.cwd ?? state.cwd
        state.displayCwd = deps.describeWorkspace(state.cwd).description ?? state.cwd
        deps.resetIdeSelection()
        deps.refreshGitBranch()
        // Reset the input FIFO and pending-decision indicators BEFORE the first
        // emit (main's bind → clear → refresh order); see the /new tail.
        deps.clearStagedImages()
        resetAndBind(handle, composed.agentPreset, explicitRoute ?? recordedModelRoute(snapshotLiveSessionEvents(handle.agent.session)), true)
        writeResumeTarget(sessionId)
        touchSession(sessionId)
        state.emit()
        const keepPrevious = keepCurrent && committedBinding.handle !== undefined
          && (committedBinding.handle.agent.status === 'running' || agentViewHasTurns(snapshotLiveSessionEvents(committedBinding.handle.agent.session)))
        if (committedBinding.handle !== undefined) {
          if (keepPrevious) {
            deps.backgroundHandles.set(previousSessionId, committedBinding.handle)
            disposePrevious('park')
          } else {
            disposePrevious('dispose')
          }
        }
        if (kind === 'agent-view') {
          touchAgentViewSession(sessionId)
          touchAgentViewSession(previousSessionId)
        }
        deps.notifySessionSwitched(kind, sessionId, previousSessionId)
        return { ok: true }
      })
      committed = true
      return result
    }
  }

  /**
   * Reserve `sessionId` for a disk resume on THIS terminal.
   *
   * Returning a reservation means the caller owns the session in the ledger
   * until it calls `finish()`. That covers the whole attempt, not just the
   * `agents.resume` call: the awaits in between (veto, compaction, preset and
   * route reads) are exactly the window a publisher beat — or a peer — could
   * otherwise slip into.
   * @param sessionId - Session about to be resumed from disk.
   * @returns The reservation, or the refusal to hand back to the caller.
   */
  const reserveDiskResume = async (
    sessionId: string,
  ): Promise<{ readonly ok: true; readonly reservation: MountReservation } | { readonly ok: false; readonly result: ResumeResult }> => {
    // Cheap pre-filter for the friendly toast: the authoritative conflict test
    // runs inside reserveMount, under the ledger lock.
    const occupancy = occupancyOf(sessionId, readSessionOwners())
    if (occupancy.kind === 'occupied') {
      deps.notify(t('resume-session-occupied', { pid: occupancy.pid }), { color: 'error', timeoutMs: 8000 })
      return { ok: false, result: { ok: false, reason: 'occupied', pid: occupancy.pid } }
    }
    const reserved = await reserveMount(sessionId)
    if (!reserved.ok) {
      if (reserved.reason === 'occupied') {
        const pid = reserved.holders[0] ?? 0
        deps.notify(t('resume-session-occupied', { pid }), { color: 'error', timeoutMs: 8000 })
        return { ok: false, result: { ok: false, reason: 'occupied', pid } }
      }
      // Both of these are refusals, not conflicts, and neither may be dressed
      // up as "held by pid 0". The generic failure branch carries the sentence.
      return { ok: false, result: { ok: false, reason: 'failed', error: mountFailureText(reserved) } }
    }
    return { ok: true, reservation: reserved.reservation }
  }

  /**
   * Reserve a freshly minted session id for a create on THIS terminal. See
   * `reserveNewSession`: a new id cannot conflict, so a refusal is a loss of
   * announcement rather than a reason to stop, and it is warned about.
   * @param sessionId - Session id minted for the new agent.
   * @returns The reservation (a no-op when the claim could not be made).
   */
  const reserveCreatedSession = async (sessionId: string): Promise<MountReservation> => {
    const { reservation, failure } = await reserveNewSession(sessionId)
    if (failure !== undefined && failure.reason !== 'occupied') {
      deps.notify(mountFailureText(failure), { color: 'warning', timeoutMs: 8000 })
    }
    return reservation
  }

  const resumeInto = async (sessionId: string, kind: 'resume' | 'agent-view', keepCurrent: boolean): Promise<ResumeResult> => {
    const adoption = deps.binding.capture()
    const agents = ctx.get('agents') as ResumeAgents | undefined
    if (!agents) {
      deps.notify(t('resume-unavailable'), { color: 'error' })
      return { ok: false, reason: 'unavailable' }
    }
    // Same reservation as `/resume`: this is the other public door onto the
    // disk path (`ChannelUi.attachToAgent`), and a mount that skips the ledger
    // is a mount a peer can race from the outside.
    const reserved = await reserveDiskResume(sessionId)
    if (!reserved.ok) return reserved.result
    return resume(sessionId, kind, keepCurrent, adoption, undefined, reserved.reservation)
  }

  /**
   * `/resume` — mount a session on THIS terminal, the same non-destructive way
   * `/agentview` does.
   *
   * There used to be two different mount models behind these two commands.
   * `/agentview` parked the session it left behind (it kept running in this
   * process and was reachable again from the view), while `/resume` DISPOSED
   * it, and refused outright while a turn was running. That split was never a
   * decision about resuming; it was an accident of the two commands growing
   * separately, and it is what made `/resume` feel like a different product
   * from the session overview sitting one command away.
   *
   * The unified model is the overview's, because it is the one that matches
   * what a TUI terminal actually is: one process that can host several agent
   * sessions at once. So:
   *
   * - Leaving a session parks it (`keepCurrent`), it does not end it, and the
   *   parked handle is reachable from the session screen afterwards.
   * - A running turn is not a refusal. The user is switching what they are
   *   LOOKING at, not asking the model to stop; the turn keeps running in the
   *   background and its row keeps reporting progress.
   *
   * The one thing that IS refused is a session another TUI process already has
   * mounted: two processes driving one append-only log interleave its events.
   * The occupancy check happens BEFORE the resume awaits (which yield), and
   * the claim is published immediately after it so this process owns the
   * session before any other process can pass the same check.
   *
   * The reservation also outlives those awaits: it is released only when the
   * attempt ends without a commit. The publisher's beat derives its set from
   * the agent registry, which does not list the target yet, so a reservation
   * that was not held across them could be erased by this process's own
   * heartbeat and handed straight to a peer.
   */
  const resumeTo = async (sessionId: string): Promise<ResumeResult> => {
    const adoption = deps.binding.capture()
    const agents = ctx.get('agents') as ResumeAgents | undefined
    if (!agents) {
      deps.notify(t('resume-unavailable'), { color: 'error' })
      return { ok: false, reason: 'unavailable' }
    }
    // The attached session as of entry, so a rival switch that commits while
    // the awaits below yield cannot be adopted over.
    const entrySession = deps.binding.agent.session
    // Already attached: this is a no-op, not a switch.
    //
    // The live-adoption path below hands `backgroundHandles.get(targetId)` to
    // `binding.switchTo()`, and a session this terminal is CURRENTLY attached
    // to has no entry there — its handle is the binding's own `currentHandle`.
    // Calling it with `undefined` therefore parks nothing, and the adoption's
    // default disposition disposes the handle that IS running, so a second
    // Enter on the `current` row stopped the live turn while reporting success.
    // `attachToAgent()` has always short-circuited here; this is the same rule
    // for the unified screen's `/resume` path.
    if (String(sessionId) === String(entrySession.id)) return { ok: true }
    // A live agent of this process is already mounted here; there is nothing
    // to claim and nothing that can be occupied. Adoption takes the live
    // handle (parking the current one) with no occupancy round-trip.
    const live = agents.get?.(SessionId(sessionId))
    let reservation: MountReservation | undefined
    if (live === undefined) {
      const reserved = await reserveDiskResume(sessionId)
      if (!reserved.ok) return reserved.result
      reservation = reserved.reservation
    }
    if (await deps.sessionSwitchVetoed('resume', sessionId)) {
      reservation?.abandon()
      return { ok: false, reason: 'cancelled' }
    }
    await deps.settleCompaction()
    if (!deps.binding.isCurrent(adoption) || deps.binding.agent.session !== entrySession) {
      reservation?.abandon()
      return { ok: false, reason: 'cancelled' }
    }
    // The target was read BEFORE those awaits. Re-read it in BOTH directions:
    // the registry can have replaced or dropped that agent while we yielded
    // (adopting the captured object would hand the screen a session nothing
    // owns any more), and it can also have GROWN one — a peer action mounting
    // this very session here means the disk path below would resume a log this
    // process is already driving. `agent-view-projection.attach` has always made
    // the first check.
    const liveNow = agents.get?.(SessionId(sessionId))
    if (liveNow !== live) {
      reservation?.abandon()
      return { ok: false, reason: 'cancelled' }
    }
    // A live target is adopted in place — the same path `/agentview` uses, so
    // the session being left is parked rather than disposed of. Only a target
    // with no live agent here goes back to the persistence backend.
    if (live !== undefined) return deps.adoptLive(live)
    return resume(sessionId, 'agent-view', true, adoption, entrySession, reservation)
  }

  const newSessionWithTarget = async (target?: NewSessionTarget): Promise<boolean> => {
    // The typed workspace target seam still creates a real Agent/session; it
    // must pass the same shadow policy gate as the public /new action.
    assertCapabilityShadowPolicy('host.channel.actions.new-session', deps.runtime.mode, deps.runtime.slices)
    const adoption = deps.binding.capture()
    const targetCwd = target?.cwd ?? state.cwd
    const targetDisplayCwd = target?.displayCwd
    const current = (): boolean => deps.owner.current() && deps.binding.isCurrent(adoption)
    if (state.working) {
      deps.notify(t('new-session-while-working'), { color: 'warning' })
      return false
    }
    const agents = ctx.get('agents') as { create(options: CreateAgentOptions): Promise<AgentHandle> } | undefined
    if (!agents) {
      deps.notify(t('new-session-unavailable'), { color: 'error' })
      return false
    }
    let sessionId: SessionId
    let composed: Awaited<ReturnType<typeof composePreset>>
    let route: { provider: string; model: string }
    try {
      if (await deps.sessionSwitchVetoed('new') || !current()) return false
      await deps.settleCompaction()
      if (!current()) return false
      sessionId = SessionId(randomUUID())
      const presetPref = options.configuredPreset === undefined ? readPresetPref() : undefined
      composed = await composePreset(ctx, options.configuredPreset ?? presetPref)
      if (!current()) return false
      const resolved = resolveModelRoute(
        { provider: options.configuredProvider, model: options.configuredModel },
        readModelPref(),
        { provider: options.provider, model: options.model },
      )
      const llm = ctx.get('llm') as { listModels(provider: string): Promise<readonly { id: string }[]> } | undefined
      const validated = await validateModelRoute(llm, resolved, { provider: options.provider, model: options.model })
      route = validated.route
      if (!current()) return false
      if (!migratePresetPref(presetPref, composed.agentPreset)) {
        deps.notify(t('preset-switched-pref-failed', { id: composed.agentPreset ?? presetPref ?? 'unknown' }), { color: 'warning' })
      }
      if (validated.rejected !== undefined) {
        deps.notify(t('model-route-invalid', { provider: validated.rejected.provider, model: validated.rejected.model, fallback: `${route.provider}/${route.model}` }), { color: 'warning', timeoutMs: 8000 })
      }
    } catch (error) {
      if (current()) {
        const message = error instanceof Error ? error.message : String(error)
        deps.notify(t('new-session-failed', { err: message }), { color: 'error', timeoutMs: 8000 })
      }
      return false
    }
    // Reserve BEFORE the factory runs: the moment `agents.create` returns, this
    // process holds the only write handle on a log no peer has been told about
    // yet, and the publisher would not name it until its next beat.
    const reservation = await reserveCreatedSession(sessionId)
    let handle: AgentHandle
    try {
      handle = await deps.binding.prepare(adoption, () => agents.create({
        sessionId,
        meta: { cwd: targetCwd, ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }) },
        agentOptions: route,
        ...(composed.setup === undefined ? {} : { setup: composed.setup }),
      }))
    } catch (error) {
      reservation.abandon()
      if (current()) {
        const message = error instanceof Error ? error.message : String(error)
        deps.notify(t('new-session-failed', { err: message }), { color: 'error', timeoutMs: 8000 })
      }
      return false
    }
    if (!current()) { await deps.binding.abandon(handle); reservation.abandon(); return false }
    try {
      await attachSessionToWorkspace(ctx, targetCwd, sessionId)
    } catch (error) {
      if (current()) deps.notify(t('new-session-attach-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'warning', timeoutMs: 8000 })
    }
    if (!current()) { await deps.binding.abandon(handle); reservation.abandon(); return false }
    // Do not catch this synchronous commit tail. A post-commit setup failure
    // is owned by binding.adopt(), which revokes the new live handle and must
    // reject its caller rather than masquerade as an ordinary precommit false.
    let committed = false
    try {
      const result = deps.binding.adopt(handle, adoption, (committedBinding, disposePrevious) => {
        const previousSessionId = String(committedBinding.agent.session.id)
        // The target only becomes shared channel state inside the successful
        // adoption tail. A losing prepared handle therefore cannot publish or
        // roll back another workspace's cwd.
        state.cwd = targetCwd
        state.displayCwd = targetDisplayCwd ?? deps.describeWorkspace(targetCwd).description ?? targetCwd
        deps.resetIdeSelection()
        // Reset the input FIFO and the pending-decision indicators BEFORE the
        // first emit: a submit enqueued from a session-changed subscriber must
        // land on a fresh chain instead of behind the replaced session's parked
        // promise (main's bind → clear → refresh order).
        deps.clearStagedImages()
        resetAndBind(handle, composed.agentPreset, route, false)
        clearResumeTarget()
        touchSession(handle.agent.id)
        disposePrevious('dispose')
        deps.notifySessionSwitched('new', String(handle.agent.id), previousSessionId)
        return true
      })
      committed = true
      return result
    } finally {
      if (committed) reservation.settle()
      else reservation.abandon()
    }
  }
  const newSession = (): Promise<boolean> => newSessionWithTarget()

  return { resumeInto, resumeTo, newSession, newSessionWithTarget }
}
