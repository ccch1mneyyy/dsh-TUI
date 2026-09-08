import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { resolveModelRoute, validateModelRoute } from '../../modelRoute.js'
import { readModelPref } from '../../modelPrefs.js'
import { readPresetPref } from '../../presetPrefs.js'
import { clearResumeTarget, touchAgentViewSession, touchSession } from '../../sessionHistory.js'
import { t } from '../../i18n.js'
import { composePreset } from '../presets.js'
import { attachSessionToWorkspace } from '../workspace.js'
import { resetSessionProjection } from './session-reset.js'
import type { createChannelBinding } from './binding.js'
import type { ChannelOwner } from './owner.js'
import type { BackgroundResult, ChannelState } from './types.js'

type Binding = ReturnType<typeof createChannelBinding>

/** `/bg` foreground handoff. The binding remains the sole identity writer;
 * this action only parks the exact previous handle passed by its transaction. */
export function createBackgroundCurrentAction(
  ctx: Context,
  state: Pick<ChannelState,
    'cwd' | 'status' | 'agentId' | 'loadedContext' | 'contextWindow' |
    'effortLevels' | 'reasoningEffort' | 'emit' | 'notify'> & Parameters<typeof resetSessionProjection>[0],
  options: { configuredPreset?: string; configuredProvider?: string; configuredModel?: string; provider: string; model: string },
  deps: {
    owner: Pick<ChannelOwner, 'current'>
    binding: Pick<Binding, 'capture' | 'isCurrent' | 'prepare' | 'abandon' | 'adopt'>
    backgroundHandles: Map<string, AgentHandle>
    rowIds: { value: number }
    resetProjector(): void
    resetSubagents(): void
    resetJobs(): void
    refreshEffortLevels(): void
    bindAgent(): void
    refreshCommands(): void
    refreshLoadedContext(): Promise<void>
    refreshSkillCommands(): Promise<void>
    clearStagedImages(): void
    notifySessionSwitched(kind: 'background', sessionId: string, previousSessionId: string): void
    /** Owner-guarded channel notification; never call raw state.notify here. */
    notify(text: string, options?: { color?: 'error' | 'warning'; timeoutMs?: number }): unknown
    notifyAgentView(): void
  },
): () => Promise<BackgroundResult> {
  return async () => {
    const adoption = deps.binding.capture()
    const agents = ctx.get('agents') as { create(options: CreateAgentOptions): Promise<AgentHandle> } | undefined
    if (!agents) {
      deps.notify(t('agentview-dispatch-unavailable'), { color: 'error' })
      return { ok: false, reason: 'unavailable' }
    }
    const sessionId = SessionId(randomUUID())
    try {
      const composed = await composePreset(ctx, options.configuredPreset ?? readPresetPref())
      const route = await validateModelRoute(
        ctx.get('llm') as { listModels(provider: string): Promise<readonly { id: string }[]> } | undefined,
        resolveModelRoute({ provider: options.configuredProvider, model: options.configuredModel }, readModelPref(), { provider: options.provider, model: options.model }),
        { provider: options.provider, model: options.model },
      )
      const handle = await deps.binding.prepare(adoption, () => agents.create({
        sessionId,
        meta: { cwd: state.cwd, ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }) },
        agentOptions: route.route,
        ...(composed.setup === undefined ? {} : { setup: composed.setup }),
      }))
      if (!deps.binding.isCurrent(adoption)) { await deps.binding.abandon(handle); return { ok: false, reason: 'failed', error: 'Channel lifetime ended' } }
      try {
        await attachSessionToWorkspace(ctx, state.cwd, sessionId)
      } catch (error) {
        // The workspace ledger is optional bookkeeping, but preserve the
        // baseline stderr warning for operators diagnosing a degraded host.
        ctx.logger.warn('dsh-tui: background session attachment failed: %o', error)
      }
      // Do not adopt after attachment unless the exact captured foreground is
      // still current. A replacement is not a license to target that newer
      // agent; the prepared candidate is abandoned instead.
      if (!deps.binding.isCurrent(adoption)) {
        await deps.binding.abandon(handle)
        return { ok: false, reason: 'failed', error: 'Channel lifetime ended' }
      }
      return deps.binding.adopt(handle, adoption, (previous, disposePrevious) => {
        const previousSessionId = String(previous.agent.session.id)
        if (previous.handle !== undefined) {
          deps.backgroundHandles.set(previousSessionId, previous.handle)
          disposePrevious('park')
        }
        resetSessionProjection(state, deps.rowIds, deps.resetProjector, deps.resetSubagents, deps.resetJobs)
        state.status = handle.agent.status
        state.agentId = handle.agent.id
        state.loadedContext = undefined
        state.contextWindow = undefined
        state.effortLevels = undefined
        state.reasoningEffort = undefined
        deps.refreshEffortLevels()
        // Reset the input FIFO and pending-decision indicators BEFORE the first
        // emit (main's bind → clear → refresh order).
        deps.clearStagedImages()
        deps.bindAgent()
        deps.refreshCommands()
        void deps.refreshLoadedContext()
        void deps.refreshSkillCommands()
        clearResumeTarget()
        touchSession(handle.agent.id)
        touchAgentViewSession(previousSessionId)
        touchAgentViewSession(String(handle.agent.id))
        deps.notifySessionSwitched('background', String(handle.agent.id), previousSessionId)
        deps.notifyAgentView()
        return { ok: true, backgroundedSessionId: previousSessionId }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.notify(t('agentview-dispatch-failed', { err: message }), { color: 'error', timeoutMs: 8000 })
      return { ok: false, reason: 'failed', error: message }
    }
  }
}
