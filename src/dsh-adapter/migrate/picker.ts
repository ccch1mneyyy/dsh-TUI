/**
 * Data collection for the `/migrate` source picker.
 *
 * Combines the name-only scan count (list mode's fast path) with the
 * recent-activity detector into the row shape the picker renders. Pure data:
 * no React, no Cordis — Chat imports this one function and owns all UI.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/picker
 */
import { MIGRATION_ADAPTERS } from './index.js'
import { collectActivitySamples, recentAgentsFrom, type AdapterScanSpec } from './recent-agents.js'

/** One selectable picker row (rendered by components/MigratePicker.tsx). */
export interface MigratePickerRow {
  readonly agentId: string
  readonly label: string
  readonly count: number
  /** Minutes since the newest source activity, when inside the window. */
  readonly minutesAgo?: number
}

/** Each adapter's name-only scan shape, shared by count() callers and the activity hint. */
export const MIGRATE_SCAN_SPECS: Readonly<Record<string, AdapterScanSpec>> = {
  'claude-code': { maxDepth: 3, fileMatch: name => name.endsWith('.jsonl') },
  codex: { maxDepth: 5, fileMatch: name => name.startsWith('rollout-') && name.endsWith('.jsonl') },
  omp: { maxDepth: 3, fileMatch: name => name.endsWith('.jsonl') },
  zcode: { maxDepth: 3, fileMatch: name => name.endsWith('.json') },
  'grok-build': { maxDepth: 2, fileMatch: name => name === 'chat_history.jsonl' },
}

const scanOf = (agentId: string): AdapterScanSpec | undefined => MIGRATE_SCAN_SPECS[agentId]

/**
 * Collect picker rows for every registered adapter: scan count plus a
 * recent-activity badge when the source was used inside the window. Recent
 * sources sort first (newest activity at top), cold sources keep registry
 * order. Sub-second at real-world scale, but still meant for a background
 * pass — never the render path.
 */
export function collectMigratePickerRows(nowMs: number): MigratePickerRow[] {
  const samples = collectActivitySamples(MIGRATION_ADAPTERS, adapter => scanOf(adapter.id))
  const recent = new Map(recentAgentsFrom(samples, nowMs).map(agent => [agent.agentId, agent.minutesAgo]))
  const rows = MIGRATION_ADAPTERS.map(adapter => ({
    agentId: adapter.id,
    label: adapter.label,
    count: adapter.count !== undefined ? adapter.count() : adapter.discover().sessions.length,
    minutesAgo: recent.get(adapter.id),
  }))
  return rows.sort((a, b) => {
    const aRecent = a.minutesAgo ?? Number.MAX_SAFE_INTEGER
    const bRecent = b.minutesAgo ?? Number.MAX_SAFE_INTEGER
    return aRecent - bRecent
  })
}
