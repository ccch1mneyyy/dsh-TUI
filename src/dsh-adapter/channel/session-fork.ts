import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { t } from '../../i18n.js'
import { resolveDshProfileName } from '../../update.js'
import { appendSessionTitle, liveSessionCreateOptions, sliceLiveSessionSeed } from '../compat/index.js'
import { composePreset, runningPresetOf } from '../presets.js'
import { attachSessionToWorkspace } from '../workspace.js'
import { reserveMount, type MountReservation } from '../../sessionMounts.js'
import { mountFailureText } from '../../sessions/resumeFailure.js'
import type { ChannelOwner } from './owner.js'
import type { ChannelState } from './types.js'

type ForkState = Pick<ChannelState, 'working' | 'cwd' | 'provider' | 'model' | 'sessionTitle'>

/** Create a detached `/fork` copy without adopting it into the foreground. */
export function createForkSessionAction(
  ctx: Context,
  state: ForkState,
  deps: {
    owner: Pick<ChannelOwner, 'current'>
    settleCompaction(): Promise<void>
    notify: ChannelState['notify']
    source(): Session
    createDetachedHandle(create: () => Promise<AgentHandle>): Promise<{ handle: AgentHandle; release(): Promise<void> }>
  },
) {
  return async (): Promise<boolean> => {
    const agents = ctx.get('agents') as
      | { create(options: CreateAgentOptions): Promise<AgentHandle> }
      | undefined
    if (!agents) {
      deps.notify(t('fork-unavailable'), { color: 'error' })
      return false
    }
    if (state.working) {
      deps.notify(t('fork-while-working'), { color: 'warning' })
      return false
    }
    await deps.settleCompaction()
    const source = deps.source()
    const childId = SessionId(randomUUID())
    let seed: readonly SessionEvent[]
    try {
      // No boundary: the whole (turn-closed) source log. Slice the SOURCE
      // snapshot — sessions.fork() would register a child and append
      // session/end-seed, so snapshot.length is not a lineage cut.
      seed = sliceLiveSessionSeed(source)
    } catch (error) {
      deps.notify(t('fork-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error' })
      return false
    }
    const forkComposed = await composePreset(ctx, runningPresetOf(source))
    // Reserve BEFORE the factory, and hold it past `detached.release()`.
    //
    // A forked child is driven by this process for the whole creation and then
    // written to once more AFTER the handle is gone (`appendSessionTitle`
    // below), so "the handle was disposed" is not the moment this process stops
    // touching the log. The reservation covers both, and is given back at the
    // end: a fork is a standalone session the user resumes separately, not one
    // this terminal keeps mounted.
    const reserved = await reserveMount(String(childId))
    if (!reserved.ok && reserved.reason !== 'occupied') deps.notify(mountFailureText(reserved), { color: 'warning', timeoutMs: 8000 })
    const reservation: MountReservation = reserved.ok ? reserved.reservation : { settle: () => {}, abandon: () => {} }
    let detached: { handle: AgentHandle; release(): Promise<void> }
    try {
      detached = await deps.createDetachedHandle(() => agents.create(liveSessionCreateOptions({
        sessionId: childId,
        seed,
        runtimeSession: source,
        inheritedCount: seed.length,
        cwd: state.cwd,
        // NO parentSession: a /fork copy is an independent conversation
        // (kimi-code semantics), not a rewind branch — recording lineage
        // would fold it into the source's family in /resume.
        agentPreset: forkComposed.agentPreset,
        agentOptions: { provider: state.provider, model: state.model },
        setup: forkComposed.setup,
      })))
    } catch {
      reservation.abandon()
      deps.notify(t('fork-create-failed'), { color: 'error' })
      return false
    }
    if (!deps.owner.current()) { await detached.release(); reservation.abandon(); return false }
    try {
      await attachSessionToWorkspace(ctx, state.cwd, childId)
    } catch (error) {
      deps.notify(t('fork-attach-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'warning', timeoutMs: 8000 })
    }
    if (!deps.owner.current()) { await detached.release(); reservation.abandon(); return false }
    try {
      await detached.release()
    } catch (error: unknown) {
      ctx.logger.warn('dsh-tui: forked session dispose failed: %o', error)
    }
    try {
      const sourceTitle = state.sessionTitle.trim()
      appendSessionTitle(String(childId), `Fork: ${sourceTitle === '' ? String(source.id).slice(0, 8) : sourceTitle}`)
    } finally {
      // The offline title write is the last touch; from here the fork is the
      // user's to resume somewhere else.
      reservation.abandon()
    }
    const profile = resolveDshProfileName()
    const boot = profile === undefined ? 'dsh --config cordis.yml' : `dsh --profile ${profile}`
    const command = process.platform === 'win32'
      ? `dsh-tui --resume ${childId}`
      : `DSH_TUI_RESUME_SESSION=${childId} ${boot}`
    deps.notify(t('fork-done', { id: String(childId), command }), { timeoutMs: 8000 })
    return true
  }
}
