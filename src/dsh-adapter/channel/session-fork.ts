import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { t } from '../../i18n.js'
import { resolveDshProfileName } from '../../update.js'
import { appendSessionTitle } from '../compat/index.js'
import { composePreset, runningPresetOf } from '../presets.js'
import { attachSessionToWorkspace } from '../workspace.js'
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
    source(): { id: SessionId; events: readonly SessionEvent[] }
    createDetachedHandle(create: () => Promise<AgentHandle>): Promise<{ handle: AgentHandle; release(): Promise<void> }>
  },
) {
  return async (): Promise<boolean> => {
    const sessions = ctx.get('sessions') as
      | { fork(source: unknown, boundary?: number): { events: readonly SessionEvent[] } }
      | undefined
    const agents = ctx.get('agents') as
      | { create(options: CreateAgentOptions): Promise<AgentHandle> }
      | undefined
    if (!sessions || !agents) {
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
      seed = sessions.fork(source).events
    } catch (error) {
      deps.notify(t('fork-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error' })
      return false
    }
    const forkComposed = await composePreset(ctx, runningPresetOf(source as never))
    let detached: { handle: AgentHandle; release(): Promise<void> }
    try {
      detached = await deps.createDetachedHandle(() => agents.create({
        sessionId: childId,
        seed,
        meta: {
          cwd: state.cwd,
          seedLength: seed.length,
          ...(forkComposed.agentPreset === undefined ? {} : { agentPreset: forkComposed.agentPreset }),
        },
        agentOptions: { provider: state.provider, model: state.model },
        ...(forkComposed.setup === undefined ? {} : { setup: forkComposed.setup }),
      }))
    } catch {
      deps.notify(t('fork-create-failed'), { color: 'error' })
      return false
    }
    if (!deps.owner.current()) { await detached.release(); return false }
    try {
      await attachSessionToWorkspace(ctx, state.cwd, childId)
    } catch (error) {
      deps.notify(t('fork-attach-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'warning', timeoutMs: 8000 })
    }
    if (!deps.owner.current()) { await detached.release(); return false }
    try {
      await detached.release()
    } catch (error: unknown) {
      ctx.logger.warn('dsh-tui: forked session dispose failed: %o', error)
    }
    const sourceTitle = state.sessionTitle.trim()
    appendSessionTitle(String(childId), `Fork: ${sourceTitle === '' ? String(source.id).slice(0, 8) : sourceTitle}`)
    const profile = resolveDshProfileName()
    const boot = profile === undefined ? 'dsh --config cordis.yml' : `dsh --profile ${profile}`
    const command = process.platform === 'win32'
      ? `dsh-tui --resume ${childId}`
      : `DSH_TUI_RESUME_SESSION=${childId} ${boot}`
    deps.notify(t('fork-done', { id: String(childId), command }), { timeoutMs: 8000 })
    return true
  }
}
