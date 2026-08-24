/**
 * Shared row-renderer plumbing for the transcript (plan §1.3, WP-03).
 *
 * A {@link RowComponent} renders ONE `ChatRow` to ANSI lines. It is not a
 * pi-tui `Component` itself — `TranscriptView` is the component; rows are its
 * render workers with a slightly richer contract:
 *
 * - `render(width, marginTop)` — the CC-style 1-row top margin between turns
 *   is position-dependent (the first visible row has none), so the list
 *   passes it per call; the cache key includes it.
 * - `invalidate()` — drop the cached lines. Called by the list when the
 *   row's fingerprint moved (the channel mutates row fields IN PLACE), when
 *   the row is streaming (its text grows per chunk), or on a theme switch.
 * - `setRow(row)` — refresh the row reference. Row objects are usually
 *   stable with in-place field mutation, but some paths replace them
 *   (subagent sync rebuilds `row.subagent` every time, session restore
 *   replaces whole rows); the reference must never go stale.
 *
 * {@link CachedRow} implements the (width, marginTop)-keyed cache: while the
 * width holds and nobody invalidated, `render` returns the cached array
 * with zero allocation.
 */
import type { ChatRow } from '../../../dsh-adapter/channel.js'

/** View-level toggles every row reads at build time. Owned and mutated by
 *  `TranscriptView`, which invalidates the affected rows on every change. */
export interface RowContext {
  /** Ctrl+O verbose: full reasoning, full tool args/results, uncapped bodies. */
  expanded: boolean
  /** Per-row expansion, toggled by clicking a foldable card (research §4.3).
   *  Replaced (never mutated) on each toggle, like the source's React state. */
  expandedRows: ReadonlySet<number>
  /** Streaming reasoning rows the user clicked folded (source
   *  `streamFoldedRows`): streaming defaults to the live view, so the click
   *  fold needs its own switch — settled rows read `expandedRows` instead and
   *  the two defaults never flip each other. */
  streamFoldedRows: ReadonlySet<number>
  /** Channel thinking-block display mode; drives the streaming preview ticker. */
  thinkingFold: 'preview' | 'full'
  /** Working-activity preset name; drives the subagent card's running glyph. */
  activityFrames: string | undefined
}

export interface RowComponent {
  render(width: number, marginTop: boolean): string[]
  invalidate(): void
  setRow(row: ChatRow): void
}

export abstract class CachedRow implements RowComponent {
  private cache: { width: number; marginTop: boolean; lines: string[] } | undefined

  constructor(protected row: ChatRow, protected readonly ctx: RowContext) {}

  setRow(row: ChatRow): void {
    this.row = row
  }

  invalidate(): void {
    this.cache = undefined
  }

  render(width: number, marginTop: boolean): string[] {
    const cache = this.cache
    if (cache !== undefined && cache.width === width && cache.marginTop === marginTop) {
      return cache.lines
    }
    const lines = this.build(width, marginTop)
    this.cache = { width, marginTop, lines }
    return lines
  }

  protected abstract build(width: number, marginTop: boolean): string[]
}

/**
 * Cheap content fingerprint deciding whether a cached row must re-render.
 *
 * The channel mutates row fields in place (`text += chunk`,
 * `tool.status = ...`), so object identity proves nothing. Row text only
 * ever grows or is replaced wholesale (fold/restore), so `text.length`
 * tracks content change without comparing megabyte strings; presentation
 * views are set-once references, tracked by presence. Running tool/subagent
 * rows additionally mix in the wall-clock second so their live elapsed
 * label ticks over on the next update (the old `nowSec` prop).
 *
 * Anything this misses is covered by the list's second rule: rows with
 * `streaming === true` are invalidated unconditionally on every revision.
 */
export function rowFingerprint(row: ChatRow, nowMs: number): string {
  let fp =
    `${row.kind}|${row.streaming === true ? 1 : 0}|${row.text.length}|` +
    `${row.durationMs ?? ''}|${row.folded === true ? 1 : 0}|${row.executionTarget ?? ''}`
  const tool = row.tool
  if (tool !== undefined) {
    fp +=
      `|t${tool.status},${tool.argsText.length},${tool.argsFull?.length ?? ''},` +
      `${tool.resultText?.length ?? ''},${tool.resultFull?.length ?? ''},` +
      `${tool.errorText?.length ?? ''},${tool.durationMs ?? ''},` +
      `${tool.callView === undefined ? 0 : 1},${tool.resultView === undefined ? 0 : 1}`
    if (tool.status === 'running') {
      fp += `,${Math.floor(Math.max(0, nowMs - tool.startedAt) / 1000)}`
    }
  }
  return fp
}
