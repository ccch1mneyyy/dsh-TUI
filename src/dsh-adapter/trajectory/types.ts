/**
 * Trajectory projection — the data contract shared by the adapter-side fold
 * and the UI-side scene (issue #80 evolution).
 *
 * Two rules shape every type here, and both exist because the projection
 * feeds a terminal that repaints on a keystroke:
 *
 * 1. **Nodes carry references, never derived copies.** A node's `detail` is
 *    the raw event string exactly as the log holds it — JS strings are
 *    immutable and shared, so keeping one costs a pointer, while flattening
 *    or truncating it at fold time would allocate a second copy of every
 *    tool argument in the session AND bake in a width the terminal has not
 *    chosen yet. The view calls {@link previewText} on the ~15 rows it is
 *    about to paint; everything else stays untouched.
 * 2. **Full content is never held at all.** `seq`/`endSeq` address the
 *    owning events, and the inspector re-reads them from the session's own
 *    immutable snapshot on demand. The projection is an index, not a mirror.
 */

/** The row kinds a trajectory node can carry. */
export type TrajKind =
  | 'turn'
  | 'step'
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'subtool'
  | 'retry'
  | 'approval'
  | 'compaction'
  | 'system'
  | 'context'
  | 'todo'

/** Bracket outcome; open brackets stay `running` until their closer lands. */
export type TrajStatus = 'running' | 'ok' | 'error'

/** Per-message token accounting, present only when the adapter reported it. */
export interface TrajTokens {
  readonly input: number
  readonly output: number
  readonly think: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/**
 * A run of consecutive same-name calls folded into one ledger row.
 *
 * The fold replaces the run with a *synthetic* node that carries this burst;
 * `members` holds the original nodes, still live and still the objects the
 * bracket-pairing maps mutate when their closers land. Totals are therefore
 * derived on read ({@link burstDurationMs}, {@link burstErrors}) rather than
 * maintained incrementally — a member closing after the fold needs no
 * bookkeeping, and there is no head/member self-reference to trip a walker.
 */
export interface TrajBurst {
  /** Tool name shared by every member. */
  readonly name: string
  /** Every folded call, in log order. */
  readonly members: readonly TrajNode[]
}

/** Summed own-duration of the burst members whose brackets have closed. */
export function burstDurationMs(burst: TrajBurst): number {
  let total = 0
  for (const member of burst.members) total += member.durationMs ?? 0
  return total
}

/** Number of burst members that failed. */
export function burstErrors(burst: TrajBurst): number {
  let count = 0
  for (const member of burst.members) if (member.status === 'error') count += 1
  return count
}

/** True while any burst member is still running. */
export function burstRunning(burst: TrajBurst): boolean {
  return burst.members.some(member => member.status === 'running')
}

/**
 * One row of the trajectory ledger.
 *
 * Fields filled when the opening event is consumed are `readonly`; fields a
 * later closing event completes (`endSeq`, `durationMs`, `status`, …) are
 * mutable, matching the fold's in-place bracket pairing.
 */
export interface TrajNode {
  /** Seq of the opening event — the inspector's lookup key. */
  readonly seq: number
  /** Epoch-ms timestamp of the opening event. */
  readonly time: number
  readonly kind: TrajKind
  /** Owning turn; 0 for events that precede the first `turn/start`. */
  readonly turn: number
  /** Owning step, when the event carried one. */
  readonly step?: number
  /**
   * Short, already-bounded label: a tool name, `turn 3`, a retry code. Safe
   * to render as-is — it never holds user or model prose.
   */
  readonly label: string
  /** Raw one-line-preview source (arguments, message text). Never flattened. */
  readonly detail?: string
  /** Raw result-preview source rendered after the `→`. Never flattened. */
  outcome?: string
  /** Seq of the closing event, once it lands. */
  endSeq?: number
  /** Own wall-clock duration, filled when the bracket closes. */
  durationMs?: number
  status?: TrajStatus
  /** Message-level token accounting (assistant rows only). */
  tokens?: TrajTokens
  /** Tool-call identity, used for `tool/call` ↔ `tool/result` pairing. */
  readonly callId?: string
  /** Code-runner sub-call identity (`tool/code-dispatch*` pre-0.1.5, `tool/ptc-dispatch*` since). */
  readonly subCallId?: string
  /** Failure identity when `status === 'error'` (e.g. `RATE_LIMIT`). */
  errorCode?: string
  /** Attempt count on a `retry` row (one row per retry sequence). */
  attempts?: number
  /**
   * Set on the synthetic node that stands in for a folded run of same-name
   * calls. The node itself is not one of the members.
   */
  readonly burst?: TrajBurst
  /**
   * True while this node belongs to seed history — events replayed from a
   * resumed/forked log rather than produced by this lifecycle. The scene
   * dims them so a resumed session's inherited past is visually distinct.
   * Mutable because only the LAST `session/end-seed` bounds the inherited
   * range, so a re-seeded log re-marks the rows folded before it.
   */
  seed?: boolean
}

/** Minimum run length that folds into a {@link TrajBurst}. */
export const BURST_MIN = 3

/** Timeline channel a node contributes to in the wave band. */
export type WaveChannel = 'input' | 'model' | 'tool'

/** One column of the wave band. */
export interface WaveBucket {
  /** Total weight in this column, before normalization. */
  weight: number
  /**
   * Rows in this column, regardless of cost.
   *
   * Separate from `weight` because structural rows (turn/step) deliberately
   * contribute no cost — their span is their children's — yet a column holding
   * one is NOT empty. Conflating the two rendered such columns as gaps, which
   * at status-line scale made the strip look broken rather than quiet.
   */
  count: number
  /** Per-channel weights; the dominant one drives the column's color. */
  readonly channels: { input: number; model: number; tool: number }
  /** Any member failed. */
  error: boolean
  /** Any member is an `llm/retry`. */
  retry: boolean
  /** Any member is still running. */
  running: boolean
  /** Ledger index of the first node in this column, for click-to-seek. */
  firstIndex: number
}

/** The wave band projected at one specific column count. */
export interface WaveBand {
  readonly buckets: readonly WaveBucket[]
  /**
   * Weight that maps to the tallest glyph — the 95th percentile of non-empty
   * columns, not the maximum. Columns above it clamp to a full block.
   */
  readonly peak: number
  /**
   * Lowest NON-EMPTY bucket weight. Glyph levels are normalized between this
   * and {@link peak} rather than from zero: a typical bucket already sits near
   * half of `log1p(peak)`, so a zero-based scale leaves the lower half of the
   * glyph ramp permanently unused and the band reads as a flat smear.
   */
  readonly floor: number
  /** Turn-boundary markers as `[turn, bucketIndex]`, for the ruler row. */
  readonly turns: readonly (readonly [number, number])[]
}

/** How the wave band maps nodes onto columns. */
export type WaveProjection =
  /** One column per equal slice of the node index range. */
  | 'sequence'
  /** Columns proportional to wall-clock, idle gaps included. */
  | 'time'
  /** Columns proportional to wall-clock with idle gaps compressed out. */
  | 'compressed'

/** Ordered cycle for the `m` key. */
export const WAVE_PROJECTIONS: readonly WaveProjection[] = ['sequence', 'time', 'compressed']

/** One row of the hotspot view: a named cost bucket. */
export interface HotspotRow {
  readonly label: string
  /** Summed wall-clock across every member. */
  readonly totalMs: number
  readonly count: number
  /** Summed tokens where the group carries accounting. */
  readonly tokens: number
  /** True for rows that represent a failure cost (retry backoff). */
  readonly error?: boolean
  /** Ledger index of the group's first member, for `Enter` to seek. */
  readonly firstIndex: number
}

/** The hotspot view's three sections plus the session totals. */
export interface TrajAggregate {
  /** Per tool name, descending by `totalMs`. */
  readonly tools: readonly HotspotRow[]
  /** Model-side cost: decode, time-to-first-token, retry backoff. */
  readonly model: readonly HotspotRow[]
  /** Per turn, descending by `totalMs`. */
  readonly turns: readonly HotspotRow[]
  readonly totals: TrajTotals
}

/** Session-level counters shown in the scene header and the status badge. */
export interface TrajTotals {
  readonly turns: number
  readonly steps: number
  /** Ledger rows, after burst folding. */
  readonly rows: number
  /** Tool + subtool call count, before burst folding. */
  readonly calls: number
  readonly errors: number
  readonly retries: number
  /** Wall-clock from the first to the last event. */
  readonly spanMs: number
  /** Summed tool own-duration. */
  readonly toolMs: number
  /** Summed assistant decode duration (first token → completion). */
  readonly decodeMs: number
  /** Summed time-to-first-token. */
  readonly ttftMs: number
  /** Number of steps that contributed a TTFT sample. */
  readonly ttftSamples: number
  /** Summed retry backoff. */
  readonly retryMs: number
  readonly tokens: TrajTokens
}

/** Hotspot sort keys, cycled by the `t` key. */
export type HotspotSort = 'duration' | 'count' | 'tokens'

/** Ordered cycle for the `t` key. */
export const HOTSPOT_SORTS: readonly HotspotSort[] = ['duration', 'count', 'tokens']

/**
 * Collapse whitespace and cap a raw detail string for one-line display.
 *
 * The scan is bounded: only the first `limit * 4 + 16` code units are ever
 * examined, so a 200 KB tool result costs the same as a 200-byte one. This
 * is the ONLY place raw detail becomes a display string, and it runs per
 * painted row, never per stored node.
 *
 * @param raw - Untrusted message, argument, or result text.
 * @param limit - Maximum characters to return, excluding the ellipsis.
 * @returns Flattened preview, suffixed with `…` when the source was longer.
 */
export function previewText(raw: string, limit: number): string {
  if (limit <= 0) return ''
  // Bounded window: enough slack that collapsing runs of whitespace still
  // yields `limit` visible characters in the worst realistic case.
  const window = raw.slice(0, limit * 4 + 16)
  const flat = window.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) {
    // Only authoritative when the window covered the whole source; a source
    // longer than the window is still truncated even if the window collapsed
    // below the limit.
    return raw.length <= window.length ? flat : `${flat}…`
  }
  return `${flat.slice(0, limit)}…`
}
