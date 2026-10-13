import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { t } from '../../i18n.js'
import { WORKING_GATE_NOTICES } from '../../commands.js'
import { dispatchTuiDecision, normalizeCancelDecision } from '../extension-events.js'
import { serviceForAgent } from '../presets.js'
import type { ChannelOwner } from './owner.js'
import type { ChannelState } from './types.js'
import { isTokenDelta, tokenDeltaChars } from './usage.js'

interface ManualCompaction {
  controller: AbortController
  settled: Promise<void>
  row: ChannelState['compaction']
}

type CompactionState = Pick<ChannelState, 'agentId' | 'cwd' | 'working' | 'compaction' | 'emit' | 'emitStream'>
type Notify = ChannelState['notify']

/** One manual compaction transaction per live agent, including agents parked
 * by `/bg`. `settle` aborts the transaction of the FOREGROUND binding — the
 * session a switch is leaving — so returning to a compacting background session
 * keeps it running while navigating to a different one still settles it. */
export function createManualCompaction(
  ctx: Context,
  state: CompactionState,
  deps: {
    owner: Pick<ChannelOwner, 'current' | 'signal' | 'own'>
    agent(): Agent
    withDecisionPending<T>(name: string, pending: Promise<T>): Promise<T>
    notify: Notify
  },
) {
  const active = new Map<Agent, ManualCompaction>()
  const cancelled = new WeakSet<AbortController>()
  /** Aborts the user asked for (Esc / Ctrl+C) rather than an ownership change:
   *  only those are reported as a cancellation instead of a failure. */
  const userCancelled = new WeakSet<AbortController>()
  deps.owner.own(ctx.on('agent/disposed', ({ agent }) => {
    const transaction = active.get(agent)
    if (transaction === undefined) return
    active.delete(agent)
    cancelled.add(transaction.controller)
    transaction.controller.abort(new Error('agent disposed'))
  }))

  const settle = async (): Promise<void> => {
    const agent = deps.agent()
    const transaction = active.get(agent)
    if (transaction === undefined) return
    active.delete(agent)
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
    if (!deps.owner.current() || deps.owner.signal.aborted) return
    const originAgent = deps.agent()
    if (active.has(originAgent)) return
    const compactService = serviceForAgent<{
      compactNow(agent: unknown, signal: AbortSignal): Promise<unknown>
    }>(ctx, originAgent, 'compaction')
    if (!compactService) {
      deps.notify(t('compact-unavailable'), { color: 'warning' })
      return
    }
    if (state.working) {
      deps.notify(t(WORKING_GATE_NOTICES.compact), { color: 'warning' })
      return
    }
    const controller = new AbortController()
    const transaction: ManualCompaction = { controller, settled: Promise.resolve(), row: undefined }
    const isLive = () => deps.owner.current()
      && !deps.owner.signal.aborted
      && !cancelled.has(controller)
    const isCurrent = () => isLive() && deps.agent() === originAgent
    let disposeStream: (() => void) | undefined
    let disposeEnd: (() => void) | undefined
    const releaseOwner = deps.owner.own(() => {
      cancelled.add(controller)
      controller.abort(new Error('channel lifetime ended'))
      try { disposeStream?.() } finally { disposeEnd?.() }
    })
    const originAgentId = state.agentId
    let finished = false
    const settled = (async () => {
      try {
        const decision = await deps.withDecisionPending('tui/compact', dispatchTuiDecision(ctx, 'tui/compact', {
          sessionId: originAgentId,
          cwd: state.cwd,
        }, normalizeCancelDecision))
        // A view switch may park this agent while the decision is pending.
        // Disposal and snapshot actions revoke it; parking does not.
        if (!isLive()) return
        if (userCancelled.has(controller)) {
          if (isCurrent()) deps.notify(t('compact-cancelled'))
          return
        }
        if (decision !== undefined) {
          if (isCurrent()) deps.notify(decision.reason ?? t('ext-action-cancelled'), { color: 'warning', timeoutMs: 4000 })
          return
        }
        if (originAgent.status === 'running' || (isCurrent() && state.working)) {
          if (isCurrent()) deps.notify(t(WORKING_GATE_NOTICES.compact), { color: 'warning' })
          return
        }
        // The status row replaces the old 4s toast: a real compaction runs for
        // tens of seconds (measured: median ~25s, p90 ~70s), and the toast was
        // gone for all but the first four of them.
        const row = {
          startedAt: Date.now(),
          phase: 'prefill' as const,
          outputChars: 0,
          cancellable: true,
        }
        transaction.row = row
        if (isCurrent()) {
          state.compaction = row
          state.emit()
        }
        // Unlike the foreground stream subscription, this observer stays with
        // the transaction across rebinds. The feed delegates manual progress
        // here so a chunk is counted once, including after returning from /bg.
        disposeStream = ctx.on('llm/stream', (options, next) => {
          const stream = next()
          if (!isLive() || options.purpose !== 'compaction' || options.sessionId === undefined
            || String(options.sessionId) !== String(originAgent.session.id)) return stream
          return (async function* () {
            for await (const chunk of stream) {
              if (isLive() && transaction.row !== undefined && isTokenDelta(chunk)) {
                transaction.row = { ...transaction.row, phase: 'summary', outputChars: transaction.row.outputChars + tokenDeltaChars(chunk) }
                if (isCurrent()) {
                  state.compaction = transaction.row
                  state.emitStream()
                }
              }
              yield chunk
            }
          })()
        })
        disposeEnd = ctx.on('session/event', (session, event) => {
          // Older hosts carry the bracket as legacy events outside the
          // current SessionEvent union, just like the DSH translator accepts.
          if (session !== originAgent.session || (event as { type: string }).type !== 'compaction/end') return
          // Retire the row HERE as well. Clearing only the transaction row
          // would defeat the identity check in the `finally` below and leave a
          // stale cancellable row whenever the projector does not also fold
          // this event (a host whose translator drops the legacy bracket).
          if (isCurrent() && state.compaction === transaction.row) {
            state.compaction = undefined
            state.emit()
          }
          transaction.row = undefined
        })
        try {
          // Compact the entry agent, never a later binding read after await.
          const result = await compactService.compactNow(originAgent, controller.signal)
          if (!isCurrent()) return
          deps.notify(result ? t('compact-done') : t('compact-nothing'))
        } catch (error: unknown) {
          if (userCancelled.has(controller)) {
            if (isCurrent()) deps.notify(t('compact-cancelled'))
            return
          }
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
        // The durable `compaction/end` event already cleared the row on every
        // path that reached the host; this covers the ones that never did
        // (vetoed decision, unavailable service, a throw before the bracket).
        if (deps.agent() === originAgent && state.compaction !== undefined && state.compaction === transaction.row) {
          state.compaction = undefined
          state.emit()
        }
        if (active.get(originAgent) === transaction) active.delete(originAgent)
        releaseOwner()
      }
    })()
    // Install before the decision await so a switch/fork settles a pending
    // decision too, rather than letting it start compaction after its seed.
    // A synchronous embedder failure is already handled by the IIFE above.
    transaction.settled = settled
    if (!finished) active.set(originAgent, transaction)
  }

  /** Abort the in-flight manual compaction the user asked to stop. */
  const cancel = (): void => {
    const transaction = active.get(deps.agent())
    if (transaction === undefined) return
    userCancelled.add(transaction.controller)
    transaction.controller.abort(new Error('user cancelled compaction'))
  }

  /** Restore only this live agent's row; settled/replayed brackets stay closed. */
  const restore = (): void => {
    const transaction = active.get(deps.agent())
    if (transaction === undefined) return
    state.compaction = transaction.row
    state.emit()
  }

  return { compact, settle, cancel, restore, ownsProgress: () => active.get(deps.agent())?.row !== undefined }
}
