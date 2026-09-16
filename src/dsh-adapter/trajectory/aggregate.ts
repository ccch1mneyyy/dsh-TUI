/**
 * Trajectory aggregate — the hotspot view's data and the session totals.
 *
 * The ledger answers "what happened, in order". This module answers the other
 * question a long session raises: **where did the time go**. Chronological
 * order is the worst order for that, so everything here is grouped and ranked
 * instead: cost per tool, cost per model phase (decode vs. waiting for the
 * first token vs. retry backoff), cost per turn.
 *
 * Three details make the numbers trustworthy rather than merely plausible:
 *
 * - **Own duration only.** A turn's cost is its own bracket, never the sum of
 *   its children — summing both would double-count every tool inside it.
 * - **No fabricated spans.** A step that produced no stream output (no
 *   `assistant/chunk` pre-0.1.5, no embedded settlement stream since — the
 *   request failed, or the log predates chunk capture) contributes no TTFT and
 *   no decode sample rather than a zero that would drag the average down.
 * - **Bursts expand.** A folded run is one ledger row but N calls; the counts
 *   and totals here are over calls, so `count` matches what actually ran.
 */

import type { HotspotRow, HotspotSort, TrajAggregate, TrajNode, TrajTokens, TrajTotals } from './types.js'
import type { StepTiming, TrajBuild } from './projection.js'

/** Zero token accounting, used as the reduce seed. */
const NO_TOKENS: TrajTokens = { input: 0, output: 0, think: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * Visit every logical call in ledger order, expanding burst rows.
 *
 * @param nodes - The folded ledger.
 * @param visit - Receives each call node plus the ledger index of the row it
 *   is displayed under (the burst row's index, for folded members).
 */
export function forEachCall(
  nodes: readonly TrajNode[],
  visit: (node: TrajNode, ledgerIndex: number) => void,
): void {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!
    if (node.burst !== undefined) {
      for (const member of node.burst.members) visit(member, index)
      continue
    }
    if (node.kind === 'tool' || node.kind === 'subtool') visit(node, index)
  }
}

/** One accumulating group before it becomes a {@link HotspotRow}. */
interface Bucket {
  totalMs: number
  count: number
  tokens: number
  firstIndex: number
  error?: boolean
}

/** Get or create a bucket, remembering the first ledger index that hit it. */
function bucket(map: Map<string, Bucket>, key: string, ledgerIndex: number): Bucket {
  let slot = map.get(key)
  if (slot === undefined) {
    slot = { totalMs: 0, count: 0, tokens: 0, firstIndex: ledgerIndex }
    map.set(key, slot)
  }
  return slot
}

/** Materialize and rank buckets. */
function rank(map: Map<string, Bucket>, sort: HotspotSort): HotspotRow[] {
  const rows: HotspotRow[] = []
  for (const [label, slot] of map) {
    rows.push({
      label,
      totalMs: slot.totalMs,
      count: slot.count,
      tokens: slot.tokens,
      error: slot.error,
      firstIndex: slot.firstIndex,
    })
  }
  return sortRows(rows, sort)
}

/**
 * Rank hotspot rows by the active sort key.
 *
 * Ties break on label so the order is total — an unstable order would make
 * rows jump between frames while the session streams.
 */
export function sortRows(rows: readonly HotspotRow[], sort: HotspotSort): HotspotRow[] {
  const key = (row: HotspotRow): number =>
    sort === 'count' ? row.count : sort === 'tokens' ? row.tokens : row.totalMs
  return [...rows].sort((a, b) => key(b) - key(a) || a.label.localeCompare(b.label))
}

/**
 * Derive the hotspot groups and session totals from a projection.
 *
 * @param build - The current projection.
 * @param sort - Ranking key for the tool and turn groups.
 * @returns Ranked groups plus the counters the scene header and status badge
 *   read. Pure: nothing here mutates the build.
 */
export function aggregate(build: TrajBuild, sort: HotspotSort = 'duration'): TrajAggregate {
  const { nodes, timing, counts } = build

  const tools = new Map<string, Bucket>()
  const turns = new Map<string, Bucket>()

  let calls = 0
  let toolMs = 0
  let retryMs = 0
  let steps = 0
  let turnCount = 0
  let tokens = NO_TOKENS

  forEachCall(nodes, (node, ledgerIndex) => {
    calls += 1
    const slot = bucket(tools, node.label, ledgerIndex)
    slot.count += 1
    slot.totalMs += node.durationMs ?? 0
    toolMs += node.durationMs ?? 0
    if (node.status === 'error') slot.error = true
  })

  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!
    switch (node.kind) {
      case 'turn': {
        turnCount += 1
        const slot = bucket(turns, node.label, index)
        slot.count += 1
        slot.totalMs += node.durationMs ?? 0
        if (node.status === 'error') slot.error = true
        break
      }
      case 'step':
        steps += 1
        break
      case 'retry':
        retryMs += node.durationMs ?? 0
        break
      default:
        break
    }
    if (node.tokens !== undefined) {
      tokens = {
        input: tokens.input + node.tokens.input,
        output: tokens.output + node.tokens.output,
        think: tokens.think + node.tokens.think,
        cacheRead: tokens.cacheRead + node.tokens.cacheRead,
        cacheWrite: tokens.cacheWrite + node.tokens.cacheWrite,
      }
    }
  }

  // Attribute each step's token cost to its turn, so the turn ranking can be
  // sorted by tokens as well as by wall-clock.
  for (const node of nodes) {
    if (node.tokens === undefined) continue
    const slot = turns.get(`turn ${node.turn}`)
    if (slot !== undefined) {
      slot.tokens += node.tokens.input + node.tokens.output + node.tokens.think
    }
  }

  const { decodeMs, ttftMs, ttftSamples } = modelTiming(timing)

  const model: HotspotRow[] = []
  if (decodeMs > 0) model.push({ label: 'decode', totalMs: decodeMs, count: ttftSamples, tokens: tokens.output, firstIndex: 0 })
  if (ttftSamples > 0) model.push({ label: 'ttft', totalMs: ttftMs, count: ttftSamples, tokens: 0, firstIndex: 0 })
  if (retryMs > 0 || counts.retries > 0) {
    const firstRetry = nodes.findIndex(node => node.kind === 'retry')
    model.push({ label: 'retry', totalMs: retryMs, count: counts.retries, tokens: 0, error: true, firstIndex: Math.max(0, firstRetry) })
  }

  const first = nodes[0]
  const last = nodes[nodes.length - 1]
  const spanMs = first === undefined || last === undefined ? 0 : Math.max(0, lastTime(last) - first.time)

  const totals: TrajTotals = {
    turns: turnCount,
    steps,
    rows: nodes.length,
    calls,
    // Failure and retry counts come from the fold's own O(1) counters rather
    // than being recomputed here: the status-line chip reads them on every
    // chat frame, and two independent tallies of the same session would
    // eventually disagree — which is exactly what they did.
    errors: counts.errors,
    retries: counts.retries,
    spanMs,
    toolMs,
    decodeMs,
    ttftMs,
    ttftSamples,
    retryMs,
    tokens,
  }

  return {
    tools: rank(tools, sort),
    model: sortRows(model, sort),
    turns: rank(turns, sort),
    totals,
  }
}

/** The latest instant a node covers — its close, or its start when open. */
function lastTime(node: TrajNode): number {
  return node.time + (node.durationMs ?? 0)
}

/**
 * Sum decode and time-to-first-token across steps.
 *
 * A step contributes only when it actually streamed: `firstChunk` present
 * means the model produced output, so `firstChunk - startTime` is a real TTFT
 * and `lastChunk - firstChunk` a real decode span. Steps without chunks are
 * skipped entirely rather than counted as zero.
 */
function modelTiming(timing: ReadonlyMap<string, StepTiming>): {
  decodeMs: number
  ttftMs: number
  ttftSamples: number
} {
  let decodeMs = 0
  let ttftMs = 0
  let ttftSamples = 0
  for (const slot of timing.values()) {
    if (slot.firstChunk === undefined) continue
    ttftMs += Math.max(0, slot.firstChunk - slot.startTime)
    ttftSamples += 1
    if (slot.lastChunk !== undefined) decodeMs += Math.max(0, slot.lastChunk - slot.firstChunk)
  }
  return { decodeMs, ttftMs, ttftSamples }
}
