/**
 * Data collection for the `/migrate` source picker, plus the command
 * classifier and the child-report parser.
 *
 * Combines the name-only scan count (list mode's fast path) with the
 * recent-activity detector into the row shape the picker renders. Pure data:
 * no React, no Cordis — Chat imports these helpers and owns all UI.
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

/** One source's import outcome, parsed from the CLI child's stdout. */
export interface ImportSummary {
  readonly agentId: string
  readonly imported: number
  readonly existing: number
}

/**
 * Parse per-source import counters out of the CLI's report lines
 * (`[<agentId>] imported 12 · already present 3`). Pure string work so the
 * TUI's completion notification can carry real numbers (PRD #3) without
 * re-running any scan.
 */
export function parseImportSummary(stdout: string): ImportSummary[] {
  const summaries: ImportSummary[] = []
  for (const match of stdout.matchAll(/\[([a-z0-9-]+)\] imported (\d+)(?: · already present (\d+))?/gu)) {
    summaries.push({
      agentId: match[1]!,
      imported: Number(match[2]),
      existing: match[3] === undefined ? 0 : Number(match[3]),
    })
  }
  return summaries
}

/**
 * Classify one `/migrate` command line (the text AFTER the command word) into
 * the action Chat must take. Pure and registry-driven on purpose: whether a
 * command is valid must never depend on the picker having been opened first
 * (`migrateRows` is empty on a fresh mount, which used to make every
 * `/migrate <agent>` report an unknown source), and the CLI keeps the same
 * one-source rule (`dsh-tui migrate a b` is a usage error there too).
 *
 * @param rawInput - arguments after `/migrate`, e.g. `" claude-code --dry-run"`.
 * @param knownAgentIds - the adapter registry's ids (see MIGRATION_ADAPTERS).
 */
export function resolveMigrateCommand(rawInput: string, knownAgentIds: readonly string[]): MigrateCommand {
  const words = rawInput.trim().split(/\s+/u).filter(Boolean)
  const dryRun = words.includes('--dry-run')
  const agents = words.filter(word => word !== '--dry-run')
  // One source per invocation: the CLI rejects a second word, and silently
  // importing only the first would hide which selection the user asked for.
  if (agents.length > 1) return { kind: 'usage' }
  const wanted = agents[0]
  if (wanted === undefined) return dryRun ? { kind: 'dry-run-needs-source' } : { kind: 'picker' }
  if (!knownAgentIds.includes(wanted)) return { kind: 'unknown', agentId: wanted }
  return { kind: 'import', agentId: wanted, dryRun }
}

/** What one `/migrate` line asks for. */
export type MigrateCommand =
  | { readonly kind: 'picker' }
  | { readonly kind: 'import', readonly agentId: string, readonly dryRun: boolean }
  | { readonly kind: 'unknown', readonly agentId: string }
  /** More than one source named: rejected, like the CLI's usage error. */
  | { readonly kind: 'usage' }
  /** `--dry-run` with no source: previewing needs to know what to preview. */
  | { readonly kind: 'dry-run-needs-source' }
