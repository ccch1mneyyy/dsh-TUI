import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { t } from '../../i18n.js'
import { dispatchTuiDecision, normalizeCancelDecision } from '../extension-events.js'
import { serviceForAgent } from '../presets.js'
import type { ChannelState } from './types.js'

interface ManualCompaction {
  controller: AbortController
  settled: Promise<void>
}

type CompactionState = Pick<ChannelState, 'agentId' | 'cwd' | 'working'>
type Notify = ChannelState['notify']

/** Owns the one manual compaction transaction that must settle before a switch. */
export function createManualCompaction(
  ctx: Context,
  state: CompactionState,
  deps: {
    agent(): Agent
    withDecisionPending<T>(name: string, pending: Promise<T>): Promise<T>
    notify: Notify
    onComplete(): void
  },
) {
  let active: ManualCompaction | undefined
  const cancelled = new WeakSet<AbortController>()

  const settle = async (): Promise<void> => {
    const transaction = active
    if (transaction === undefined) return
    active = undefined
    cancelled.add(transaction.controller)
    transaction.controller.abort(new Error('session switch'))
    deps.notify(t('compact-cancelled-switch'), { color: 'warning', timeoutMs: 4000 })
    await Promise.race([
      transaction.settled,
      new Promise<void>(resolve => { setTimeout(resolve, 3000) }),
    ])
  }

  const compact = (): void => {
    const originAgent = deps.agent()
    const compactService = serviceForAgent<{
      compactNow(agent: unknown, signal: AbortSignal): Promise<unknown>
    }>(ctx, originAgent, 'compaction')
    if (!compactService) {
      deps.notify(t('compact-unavailable'), { color: 'warning' })
      return
    }
    if (state.working) {
      deps.notify(t('compact-while-working'), { color: 'warning' })
      return
    }
    const originAgentId = state.agentId
    void (async () => {
      const decision = await deps.withDecisionPending('tui/compact', dispatchTuiDecision(ctx, 'tui/compact', {
        sessionId: originAgentId,
        cwd: state.cwd,
      }, normalizeCancelDecision))
      if (decision !== undefined) {
        deps.notify(decision.reason ?? t('ext-action-cancelled'), { color: 'warning', timeoutMs: 4000 })
        return
      }
      if (deps.agent() !== originAgent) {
        deps.notify(t('ext-compact-stale'), { color: 'warning', timeoutMs: 4000 })
        return
      }
      if (state.working) {
        deps.notify(t('compact-while-working'), { color: 'warning' })
        return
      }
      const controller = new AbortController()
      deps.notify(t('compact-working'))
      const settled = (async () => {
        try {
          const result = await compactService.compactNow(deps.agent(), controller.signal)
          deps.notify(result ? t('compact-done') : t('compact-nothing'))
          if (result) deps.onComplete()
        } catch (error: unknown) {
          if ((error as { code?: unknown }).code === 'persistence') {
            deps.notify(t('compact-flush-failed'), { color: 'warning', timeoutMs: 12000 })
            return
          }
          if (cancelled.has(controller)) return
          deps.notify(
            t('compact-failed', { err: error instanceof Error ? error.message : String(error) }),
            { color: 'error', timeoutMs: 8000 },
          )
        }
      })()
      active = { controller, settled }
      void settled.finally(() => {
        if (active?.controller === controller) active = undefined
      })
    })().catch((error: unknown) => {
      deps.notify(
        t('compact-failed', { err: error instanceof Error ? error.message : String(error) }),
        { color: 'error', timeoutMs: 8000 },
      )
    })
  }

  return { compact, settle }
}
