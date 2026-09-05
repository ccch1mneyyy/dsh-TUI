import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { t } from '../../i18n.js'
import { dispatchTuiDecision, normalizeCancelDecision } from '../extension-events.js'
import { serviceForAgent } from '../presets.js'
import type { ChannelOwner } from './owner.js'
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
    owner: Pick<ChannelOwner, 'current' | 'signal' | 'own'>
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
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        transaction.settled,
        new Promise<void>(resolve => { timeout = setTimeout(resolve, 3000) }),
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  const compact = (): void => {
    if (!deps.owner.current() || deps.owner.signal.aborted || active !== undefined) return
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
    const controller = new AbortController()
    const isCurrent = () => deps.owner.current()
      && !deps.owner.signal.aborted
      && !cancelled.has(controller)
      && deps.agent() === originAgent
    const releaseOwner = deps.owner.own(() => {
      cancelled.add(controller)
      controller.abort(new Error('channel lifetime ended'))
    })
    const originAgentId = state.agentId
    let finished = false
    const settled = (async () => {
      try {
        const decision = await deps.withDecisionPending('tui/compact', dispatchTuiDecision(ctx, 'tui/compact', {
          sessionId: originAgentId,
          cwd: state.cwd,
        }, normalizeCancelDecision))
        // A revoked owner stays silent, but retain the original stale-agent
        // classification when this channel remains active on a new binding.
        if (!deps.owner.current() || deps.owner.signal.aborted || cancelled.has(controller)) return
        if (deps.agent() !== originAgent) {
          deps.notify(t('ext-compact-stale'), { color: 'warning', timeoutMs: 4000 })
          return
        }
        if (decision !== undefined) {
          deps.notify(decision.reason ?? t('ext-action-cancelled'), { color: 'warning', timeoutMs: 4000 })
          return
        }
        if (state.working) {
          deps.notify(t('compact-while-working'), { color: 'warning' })
          return
        }
        deps.notify(t('compact-working'))
        try {
          // Compact the entry agent, never a later binding read after await.
          const result = await compactService.compactNow(originAgent, controller.signal)
          if (!isCurrent()) return
          deps.notify(result ? t('compact-done') : t('compact-nothing'))
          if (result) deps.onComplete()
        } catch (error: unknown) {
          if (!isCurrent() || cancelled.has(controller)) return
          if ((error as { code?: unknown }).code === 'persistence') {
            deps.notify(t('compact-flush-failed'), { color: 'warning', timeoutMs: 12000 })
            return
          }
          deps.notify(
            t('compact-failed', { err: error instanceof Error ? error.message : String(error) }),
            { color: 'error', timeoutMs: 8000 },
          )
        }
      } catch (error: unknown) {
        // dispatch is normally isolated, but do not create an unhandled
        // rejection if an embedder's pending wrapper fails.
        if (!isCurrent()) return
        deps.notify(
          t('compact-failed', { err: error instanceof Error ? error.message : String(error) }),
          { color: 'error', timeoutMs: 8000 },
        )
      } finally {
        finished = true
        releaseOwner()
        const currentTransaction = active as ManualCompaction | undefined
        if (currentTransaction?.controller === controller) active = undefined
      }
    })()
    // Install before the decision await so a switch/fork settles a pending
    // decision too, rather than letting it start compaction after its seed.
    // A synchronous embedder failure is already handled by the IIFE above.
    if (!finished) active = { controller, settled }
  }

  return { compact, settle }
}
