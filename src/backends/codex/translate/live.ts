/**
 * Live app-server notifications of one thread → Agent Domain events
 * (docs/codex-backend-design.md §7.5): the stateful half of the translator.
 * Items go through the shared mapping (`items.ts`); this module adds the
 * stream deltas, turn boundaries, usage, status, settings and notices.
 *
 * Session concerns stay in the session (`session/*`): which inputs a user
 * message claims, approvals, the turn the input queue waits on, `/diff`.
 *
 * Every field is narrowed from `unknown`; an unknown method is ignored
 * (debug-logged), never fatal.
 */
import type { AgentEvent, AgentEventMeta } from '../../../agent/events.js'
import type { TodoPanelItem } from '../../../adapter/ports/channel-view.js'
import { t } from '../../../i18n.js'
import { modeIdOf } from '../modes.js'
import { arr, num, rec, str, text, type Rec } from '../narrow.js'
import { NOTIFY } from '../protocol/index.js'
import { closeTurn, ensureAttempt, itemEvents, reportUsage, type ItemContext } from './items.js'
import { mcpStartupNotice, retryNotice, reviewNotice, turnEndReason, warningNotice } from './notices.js'
import { tokenUsageOf } from './usage.js'

/** The thread settings the status line shows (compared on change). */
export interface SettingsSnapshot {
  model: string
  effort: string | null
  modeId: string
  /** Permission policy and collaboration mode remain orthogonal. */
  permissionMode?: string
  approvalPolicy?: unknown
  sandboxPolicy?: unknown
  collaborationMode?: Rec
}

export interface LiveTranslator {
  /** Translate one notification for this thread. */
  notification(method: string, params: Rec): AgentEvent[]
  /** Close the open turn without a `turn/completed` (connection lost,
   *  forced settle). */
  forceClose(reason: Parameters<typeof closeTurn>[2]): AgentEvent[]
  readonly ctx: ItemContext
  readonly settings: SettingsSnapshot
}

/** Renderer urgency of one notification's batch. */
export function wakeOf(method: string, events: readonly AgentEvent[]): AgentEventMeta['wake'] {
  if (method === NOTIFY.agentMessageDelta || method === NOTIFY.planDelta || method === NOTIFY.reasoningSummaryTextDelta
    || method === NOTIFY.reasoningSummaryPartAdded || method === NOTIFY.reasoningTextDelta || method === NOTIFY.commandOutputDelta) return 'frame'
  return events.every(event => event.type === 'session.status' || event.type === 'pending.changed') ? 'none' : 'sync'
}

/** `turn/plan/updated` step status in the todo panel's vocabulary. */
function todoStatus(status: string | undefined): TodoPanelItem['status'] {
  return status === 'completed' ? 'completed' : status === 'inProgress' || status === 'in_progress' ? 'in_progress' : 'pending'
}

export function createLiveTranslator(ctx: ItemContext, settings: SettingsSnapshot): LiveTranslator {
  /** The window last announced (a change re-announces). */
  let contextWindow: number | undefined
  /** Native turn id → our turn number (bounded): a straggler usage update
   *  naming an already-closed turn is attributed to THAT turn, never folded
   *  into whatever turn is live when it finally arrives. */
  const turnNumbers = new Map<string, number>()
  /** Turns closed here (by `turn/completed` or a forced settle): their late
   *  item, delta and usage traffic changes nothing (bounded, newest kept). */
  const closedTurns = new Set<string>()
  const markClosed = (id: string | undefined): void => {
    if (id === undefined || id === '') return
    closedTurns.add(id)
    if (closedTurns.size > 64) closedTurns.delete(closedTurns.values().next().value!)
  }

  const deltaTo = (out: AgentEvent[], kind: 'text' | 'reasoning', textDelta: string, index: number): void => {
    if (textDelta === '' || !ctx.turnOpen) return
    const attempt = ensureAttempt(ctx, out)
    if (kind === 'reasoning') attempt.streamedReasoning += textDelta
    else attempt.streamedText += textDelta
    out.push({ type: 'assistant.delta', attemptId: attempt.id, index, time: ctx.now(), delta: { kind, text: textDelta } })
  }

  const notification = (method: string, params: Rec): AgentEvent[] => {
    const out: AgentEvent[] = []
    const now = ctx.now()
    // A late notification of a turn already closed (an item that completes
    // after a forced settle) must not reopen it as a phantom turn. Metering
    // is the one exemption: a usage update is not turn content, and Codex
    // reports a turn's final model call after `turn/completed` — dropping it
    // would lose the session token totals, the tps readout and the context
    // occupancy. A late arrival still books its totals and refreshes the
    // context reading without reopening anything.
    const turnOf = str(params.turnId) ?? (method === NOTIFY.turnStarted ? str(rec(params.turn)?.id) : undefined)
    if (turnOf !== undefined && closedTurns.has(turnOf) && method !== NOTIFY.threadTokenUsageUpdated) return out
    switch (method) {
      case NOTIFY.turnStarted: {
        const id = str(rec(params.turn)?.id)
        if (id !== undefined) ctx.turnId = id
        return out
      }
      case NOTIFY.turnCompleted: {
        const turn = rec(params.turn) ?? {}
        const id = str(turn.id)
        // A repeated completion of a turn already closed changes nothing.
        if (id !== undefined && closedTurns.has(id)) return out
        if (id !== undefined && !ctx.turnOpen) ctx.turnId = id
        closeTurn(ctx, out, turnEndReason(turn), now)
        if (id !== undefined) {
          turnNumbers.set(id, ctx.turn)
          if (turnNumbers.size > 64) turnNumbers.delete(turnNumbers.keys().next().value!)
        }
        markClosed(id ?? ctx.turnId)
        return out
      }
      case NOTIFY.itemStarted:
      case NOTIFY.itemCompleted: {
        const item = rec(params.item)
        if (item === undefined) return out
        const turnId = str(params.turnId)
        if (turnId !== undefined && !ctx.turnOpen) ctx.turnId = turnId
        const events = itemEvents(item, method === NOTIFY.itemStarted ? 'started' : 'completed', ctx, now)
        // itemEvents may have opened the turn and fixed its number: record the
        // native-id → turn mapping AFTER it ran (a premature record would store
        // the previous turn's number).
        if (turnId !== undefined) {
          turnNumbers.set(turnId, ctx.turn)
          if (turnNumbers.size > 64) turnNumbers.delete(turnNumbers.keys().next().value!)
        }
        return events
      }
      case NOTIFY.agentMessageDelta:
      case NOTIFY.planDelta:
        deltaTo(out, 'text', str(params.delta) ?? '', 1)
        return out
      case NOTIFY.reasoningSummaryTextDelta: {
        const itemId = str(params.itemId) ?? ''
        const attempt = ctx.attempt
        if (attempt !== undefined) attempt.summarized.add(itemId)
        deltaTo(out, 'reasoning', str(params.delta) ?? '', 0)
        return out
      }
      case NOTIFY.reasoningSummaryPartAdded: {
        const attempt = ctx.attempt
        if (attempt !== undefined && attempt.streamedReasoning !== '' && !attempt.streamedReasoning.endsWith('\n\n')) deltaTo(out, 'reasoning', '\n\n', 0)
        return out
      }
      case NOTIFY.reasoningTextDelta: {
        // Raw reasoning shows only for an item that streams no summary.
        const itemId = str(params.itemId) ?? ''
        if (ctx.attempt?.summarized.has(itemId) === true) return out
        ctx.attempt?.rawReasoning.add(itemId)
        deltaTo(out, 'reasoning', str(params.delta) ?? '', 0)
        return out
      }
      case NOTIFY.commandOutputDelta:
      case NOTIFY.terminalInteraction: {
        const callId = str(params.itemId)
        if (callId !== undefined && ctx.openTools.has(callId)) {
          const value = method === NOTIFY.commandOutputDelta ? str(params.delta) : str(params.stdin)
          if (value !== undefined && value !== '') out.push({ type: 'tool.output', callId, text: method === NOTIFY.terminalInteraction ? `⏎ ${value}` : value, time: now })
        }
        return out
      }
      case NOTIFY.mcpToolCallProgress: {
        const callId = str(params.itemId)
        const open = callId === undefined ? undefined : ctx.openTools.get(callId)
        if (callId !== undefined && open !== undefined) out.push({ type: 'tool.progress', callId, elapsedMs: Math.max(0, now - open.startedAt) })
        return out
      }
      case NOTIFY.turnPlanUpdated: {
        const items = arr(params.plan).flatMap(raw => {
          const step = rec(raw)
          const content = str(step?.step)
          return content === undefined ? [] : [{ content, status: todoStatus(str(step?.status)) }]
        })
        out.push({ type: 'todo.write', items })
        return out
      }
      case NOTIFY.threadTokenUsageUpdated: {
        const { last, window } = tokenUsageOf(params)
        if (window !== undefined && window !== contextWindow) {
          contextWindow = window
          out.push({ type: 'context.capacity', contextWindow: window })
        }
        if (last !== undefined) {
          const nativeTurn = str(params.turnId)
          const attributed = nativeTurn === undefined || nativeTurn === ctx.turnId ? ctx.turn : turnNumbers.get(nativeTurn)
          reportUsage(ctx, out, last, now, attributed === undefined || attributed === ctx.turn ? undefined : { turn: attributed, stale: true })
        }
        const total = num(rec(rec(params.tokenUsage)?.last)?.totalTokens)
        if (total !== undefined) out.push({ type: 'context.usage', used: Math.max(0, total - 12_000), ...(contextWindow === undefined ? {} : { max: Math.max(0, contextWindow - 12_000) }) })
        return out
      }
      case NOTIFY.threadStatusChanged: {
        const status = rec(params.status)
        switch (str(status?.type)) {
          case 'active': {
            const flags = arr(status?.activeFlags)
            out.push({ type: 'session.status', status: flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput') ? 'requires-action' : 'running' })
            return out
          }
          case 'idle':
            out.push({ type: 'session.status', status: 'idle' })
            return out
          case 'systemError':
            out.push({ type: 'session.status', status: 'idle' }, { type: 'notice', level: 'error', key: 'codex-system-error', text: t('codex-system-error') })
            return out
          default:
            return out
        }
      }
      case NOTIFY.threadNameUpdated: {
        const name = text(params.threadName)
        if (name !== undefined) out.push({ type: 'session.title', title: name, source: 'auto' })
        return out
      }
      case NOTIFY.threadSettingsUpdated: {
        const next = rec(params.threadSettings)
        if (next === undefined) return out
        const model = str(next.model)
        if (model !== undefined && model !== '' && model !== settings.model) {
          settings.model = model
          ctx.model = model
          out.push({ type: 'model.changed', model, ...(str(next.modelProvider) === undefined ? {} : { provider: str(next.modelProvider)! }), source: 'settings' })
        }
        const effort = next.effort === null ? null : str(next.effort)
        if (effort !== undefined && effort !== settings.effort) {
          settings.effort = effort
          out.push({ type: 'effort.changed', effort })
        }
        if (next.approvalPolicy !== undefined) settings.approvalPolicy = next.approvalPolicy
        if (next.sandboxPolicy !== undefined) settings.sandboxPolicy = next.sandboxPolicy
        const permissionMode = modeIdOf(settings.approvalPolicy, settings.sandboxPolicy)
        settings.permissionMode = permissionMode
        if (rec(next.collaborationMode) !== undefined) settings.collaborationMode = rec(next.collaborationMode)
        const modeId = settings.collaborationMode?.mode === 'plan' ? 'plan' : permissionMode
        if (modeId !== settings.modeId) {
          settings.modeId = modeId
          out.push({ type: 'mode.changed', modeId })
        }
        return out
      }
      case NOTIFY.modelRerouted: {
        const to = str(params.toModel)
        if (to === undefined || to === '') return out
        settings.model = to
        ctx.model = to
        out.push(
          { type: 'model.changed', model: to, source: 'fallback' },
          { type: 'notice', level: 'warning', key: 'reroute', text: t('codex-rerouted', { from: str(params.fromModel) ?? '', to, reason: str(params.reason) ?? '' }) },
        )
        return out
      }
      case NOTIFY.error: {
        const notice = retryNotice(params)
        if (notice !== undefined) out.push(notice)
        return out
      }
      case NOTIFY.warning:
      case NOTIFY.guardianWarning: {
        const notice = warningNotice(method, params)
        if (notice !== undefined) out.push(notice)
        return out
      }
      case NOTIFY.autoApprovalReviewStarted:
      case NOTIFY.autoApprovalReviewCompleted: {
        const notice = reviewNotice(method, params)
        if (notice !== undefined) out.push(notice)
        return out
      }
      case NOTIFY.strictReviewRequired:
        out.push({ type: 'notice', level: 'info', key: 'strict-review', text: t('codex-strict-review') })
        return out
      case NOTIFY.threadCompacted:
        if (!ctx.compactionSeen) out.push({ type: 'compaction.end', ok: true, contextReplaced: true, time: now })
        return out
      case NOTIFY.threadClosed:
      case NOTIFY.threadArchived:
      case NOTIFY.threadDeleted:
        out.push({ type: 'notice', level: 'warning', key: 'thread-state', text: t(method === NOTIFY.threadClosed ? 'codex-thread-closed' : method === NOTIFY.threadArchived ? 'codex-thread-archived' : 'codex-thread-deleted') })
        return out
      case NOTIFY.mcpServerStartupStatusUpdated: {
        const notice = mcpStartupNotice(params)
        if (notice !== undefined) out.push(notice)
        return out
      }
      case NOTIFY.hookStarted:
      case NOTIFY.hookCompleted: {
        const run = rec(params.run)
        const id = str(run?.id) ?? ''
        const event = str(run?.eventName) ?? str(params.eventName) ?? ''
        const status = str(run?.status)
        const duration = num(run?.durationMs)
        out.push({
          type: 'notice',
          level: 'info',
          key: `hook:${id}`,
          text: method === NOTIFY.hookStarted
            ? t('codex-hook-started', { event })
            : t(status === 'failed' || status === 'blocked' ? 'codex-hook-failed' : 'codex-hook-done', { event, duration: duration === undefined ? '' : `${Math.round(duration)} ms` }),
        })
        return out
      }
      default:
        return out
    }
  }

  return {
    notification(method: string, params: Rec): AgentEvent[] {
      try {
        return notification(method, params)
      } catch (error) {
        ctx.debug(`codex: translating ${method} failed (${error instanceof Error ? error.message : String(error)})`)
        return []
      }
    },
    forceClose(reason) {
      const out: AgentEvent[] = []
      if (!ctx.turnOpen && ctx.attempt === undefined && ctx.openTools.size === 0) return out
      closeTurn(ctx, out, reason, ctx.now())
      // The force-closed turn's late traffic changes nothing.
      markClosed(ctx.turnId)
      return out
    },
    ctx,
    settings,
  }
}
