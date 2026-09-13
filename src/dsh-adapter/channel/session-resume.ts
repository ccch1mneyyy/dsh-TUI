import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { explicitModelRoute, recordedModelRoute, resolveModelRoute, validateModelRoute } from '../../modelRoute.js'
import { clearResumeTarget, touchAgentViewSession, touchSession, writeResumeTarget } from '../../sessionHistory.js'
import { t } from '../../i18n.js'
import { readModelPref } from '../../modelPrefs.js'
import { migratePresetPref, readPresetPref } from '../../presetPrefs.js'
import { agentViewHasTurns } from '../agent-view.js'
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
  ): Promise<ResumeResult> => {
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
    return deps.binding.adopt(handle, adoption, (committed, disposePrevious) => {
      const previousSessionId = String(committed.agent.session.id)
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
      const keepPrevious = keepCurrent && committed.handle !== undefined
        && (committed.handle.agent.status === 'running' || agentViewHasTurns(snapshotLiveSessionEvents(committed.handle.agent.session)))
      if (committed.handle !== undefined) {
        if (keepPrevious) {
          deps.backgroundHandles.set(previousSessionId, committed.handle)
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
  }

  const resumeInto = (sessionId: string, kind: 'resume' | 'agent-view', keepCurrent: boolean): Promise<ResumeResult> =>
    resume(sessionId, kind, keepCurrent, deps.binding.capture())

  /** `/resume` keeps the entry capture across its veto/compaction awaits, so a rival switch cannot adopt over newer state. */
  const resumeTo = async (sessionId: string): Promise<ResumeResult> => {
    const adoption = deps.binding.capture()
    if (state.working) {
      deps.notify(t('resume-while-working'), { color: 'warning' })
      return { ok: false, reason: 'working' }
    }
    const agents = ctx.get('agents') as ResumeAgents | undefined
    if (!agents) {
      deps.notify(t('resume-unavailable'), { color: 'error' })
      return { ok: false, reason: 'unavailable' }
    }
    if (await deps.sessionSwitchVetoed('resume', sessionId)) return { ok: false, reason: 'cancelled' }
    await deps.settleCompaction()
    const entrySession = deps.binding.agent.session
    return resume(sessionId, 'resume', false, adoption, entrySession)
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
    let handle: AgentHandle
    try {
      handle = await deps.binding.prepare(adoption, () => agents.create({
        sessionId,
        meta: { cwd: targetCwd, ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }) },
        agentOptions: route,
        ...(composed.setup === undefined ? {} : { setup: composed.setup }),
      }))
    } catch (error) {
      if (current()) {
        const message = error instanceof Error ? error.message : String(error)
        deps.notify(t('new-session-failed', { err: message }), { color: 'error', timeoutMs: 8000 })
      }
      return false
    }
    if (!current()) { await deps.binding.abandon(handle); return false }
    try {
      await attachSessionToWorkspace(ctx, targetCwd, sessionId)
    } catch (error) {
      if (current()) deps.notify(t('new-session-attach-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'warning', timeoutMs: 8000 })
    }
    if (!current()) { await deps.binding.abandon(handle); return false }
    // Do not catch this synchronous commit tail. A post-commit setup failure
    // is owned by binding.adopt(), which revokes the new live handle and must
    // reject its caller rather than masquerade as an ordinary precommit false.
    return deps.binding.adopt(handle, adoption, (committed, disposePrevious) => {
      const previousSessionId = String(committed.agent.session.id)
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
  }
  const newSession = (): Promise<boolean> => newSessionWithTarget()

  return { resumeInto, resumeTo, newSession, newSessionWithTarget }
}
