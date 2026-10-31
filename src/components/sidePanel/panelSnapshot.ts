/**
 * The curated read-only session snapshot plugin surfaces get
 * (`host.snapshot()` on panels and scenes, §18.2). A structural copy of a
 * whitelist of ChannelUi fields — never transcript text, credentials or file
 * contents — rebuilt on every call so a plugin cannot hold a live reference.
 *
 * `usage` (docs/plugin-ui-kit-design.md §4) reads the SAME fields the footer
 * `ctx`, `/tokens` and the Info panel read, so a plugin's numbers agree with
 * the host's: occupancy from `contextOccupancy`, the composition from
 * `contextBreakdown`, the running totals from `tokens`, and the cost through
 * the footer's own rule (a backend-reported cost wins; otherwise the local
 * DeepSeek estimate when the official route priced something).
 */
import { getLang } from '../../i18n.js'
import { estimateSessionCostSnapshotCny, isDeepSeekOfficialProvider } from '../../deepseekPricing.js'
import type { ChannelUi } from '../../adapter/channel/ui-policy.js'
import type { ActivityView } from '../../dsh-adapter/activity-store.js'
import type { TuiPanelSnapshot, TuiPanelUsage } from '../../dsh-adapter/panels.js'

/** Partial embedder channels and test stubs omit fields; read defensively. */
type SnapshotChannel = Partial<ChannelUi>

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** The backend-neutral usage block of the snapshot. */
export function panelUsageOf(channel: SnapshotChannel | undefined): TuiPanelUsage {
  const occupancy = channel?.contextOccupancy
  const breakdown = channel?.contextBreakdown
  const tokens = channel?.tokens
  return Object.freeze({
    occupancy: occupancy === undefined
      ? undefined
      : Object.freeze({
        usedTokens: finite(occupancy.usedTokens),
        contextWindow: typeof occupancy.contextWindow === 'number' && Number.isFinite(occupancy.contextWindow)
          ? occupancy.contextWindow
          : undefined,
        source: occupancy.source,
      }),
    breakdown: breakdown === undefined
      ? undefined
      : Object.freeze({
        systemTokens: finite(breakdown.systemTokens),
        toolsTokens: finite(breakdown.toolsTokens),
        messageTokens: finite(breakdown.messageTokens),
      }),
    tokens: Object.freeze({
      input: finite(tokens?.input),
      output: finite(tokens?.output),
      cacheRead: finite(tokens?.cacheRead),
      cacheWrite: finite(tokens?.cacheWrite),
    }),
    cost: costOf(channel),
  })
}

function costOf(channel: SnapshotChannel | undefined): TuiPanelUsage['cost'] {
  const report = channel?.costReport
  if (report !== undefined) {
    return Object.freeze({ currency: report.currency, amount: finite(report.amount), source: report.source })
  }
  const provider = channel?.provider
  if (provider === undefined || !isDeepSeekOfficialProvider(provider) || channel?.tokens === undefined) return undefined
  const estimate = estimateSessionCostSnapshotCny({
    provider,
    main: channel.mainCost ?? {},
    subagents: channel.subagentCost ?? [],
    fallbackTokens: channel.tokens,
    fallbackModel: channel.model ?? '',
  })
  // Same gate as the footer: only a priced amount is a cost (unpriced usage
  // alone is a token count, not a bill).
  if (estimate === undefined || !(estimate.total > 0)) return undefined
  return Object.freeze({ currency: 'CNY', amount: estimate.total, source: 'estimate' as const })
}

/**
 * What {@link buildPanelSnapshot} reads, as a fixed-length memo key: by value
 * where the channel mutates in place (the token totals) or derives on read
 * (occupancy, breakdown, goal fields), by identity where it replaces the
 * value (todos, jobs, subagents, cost lists). `version` is left out on
 * purpose — it bumps on every streamed delta, and nothing else the snapshot
 * shows moves with it, so the compact rows keyed on this get a snapshot
 * without it (TuiPanelCompactSnapshot). A key that did not change means the snapshot would not.
 */
export function panelSnapshotInputs(
  channel: SnapshotChannel | undefined,
  activity: ActivityView | undefined,
  approvals: number,
  questions: number,
): readonly unknown[] {
  const occupancy = channel?.contextOccupancy
  const breakdown = channel?.contextBreakdown
  const tokens = channel?.tokens
  const goal = channel?.goal
  return [
    channel,
    channel?.sessionId,
    channel?.cwd,
    channel?.working,
    channel?.spinnerMode,
    goal?.objective,
    goal?.phase,
    goal?.roundsStarted,
    goal?.maxGoalRounds,
    channel?.todos,
    channel?.backgroundJobs,
    channel?.subagents,
    occupancy?.usedTokens,
    occupancy?.contextWindow,
    occupancy?.source,
    breakdown?.systemTokens,
    breakdown?.toolsTokens,
    breakdown?.messageTokens,
    tokens?.input,
    tokens?.output,
    tokens?.cacheRead,
    tokens?.cacheWrite,
    channel?.costReport,
    channel?.subagentCost,
    channel?.provider,
    channel?.model,
    getLang(),
    activity,
    approvals,
    questions,
  ]
}

/** Length of {@link panelSnapshotInputs} (memo dependency lists are fixed-length). */
export const PANEL_SNAPSHOT_INPUT_COUNT = panelSnapshotInputs(undefined, undefined, 0, 0).length

/** Build the curated snapshot (a fresh frozen structural copy per call). */
export function buildPanelSnapshot(
  channel: SnapshotChannel | undefined,
  activity: ActivityView | undefined,
  attention: { readonly approvals: number; readonly questions: number } | undefined,
): TuiPanelSnapshot {
  const goal = channel?.goal
  return Object.freeze({
    sessionId: channel?.sessionId ?? '',
    cwd: channel?.cwd ?? '',
    lang: getLang(),
    working: channel?.working === true,
    spinnerMode: channel?.spinnerMode ?? 'idle',
    version: channel?.version ?? 0,
    goal: goal === undefined
      ? undefined
      : Object.freeze({
        objective: goal.objective,
        phase: goal.phase,
        roundsStarted: goal.roundsStarted,
        maxGoalRounds: goal.maxGoalRounds,
      }),
    todos: Object.freeze((channel?.todos ?? []).map(item => Object.freeze({
      content: item.content,
      status: item.status,
    }))),
    backgroundJobs: Object.freeze((channel?.backgroundJobs ?? []).map(job => Object.freeze({
      id: job.id,
      kind: job.kind,
      label: job.label,
      status: job.status,
      progress: job.progress,
      detail: job.detail,
      startedAt: job.startedAt,
    }))),
    subagents: Object.freeze((channel?.subagents ?? []).map(sub => Object.freeze({
      agentId: sub.agentId,
      description: sub.description,
      status: sub.status,
      mode: sub.mode,
      model: sub.model,
      startedAt: sub.startedAt,
      completedAt: sub.completedAt,
    }))),
    attention: Object.freeze({
      approvals: attention?.approvals ?? 0,
      questions: attention?.questions ?? 0,
    }),
    activity: activity === undefined ? undefined : Object.freeze({ ...activity }),
    usage: panelUsageOf(channel),
  }) as TuiPanelSnapshot
}
