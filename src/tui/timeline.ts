/**
 * Fullscreen conversation timeline (research §3.4.4): the per-tick DATA
 * layer behind the turn rail, sticky prompt header, and back-to-bottom pill
 * — their views land in M4b; this module owns only the derivation.
 *
 * The chat screen feeds one {@link TimelineFrame} per update tick: the
 * transcript's recorded row geometry (TranscriptView.renderRows, §3.4.2),
 * the header height (the transcript's offset inside the ScrollView content,
 * §3.4.3), and the ScrollView's scroll metrics. From those it derives:
 *
 * - the `TimelineSnapshot` (turns in conversation order, content-space tops,
 *   active/up/down ownership) via the renderer-neutral model
 *   (`timeline-model.ts` — the same functions the source main's MessageList
 *   scan was ported into, so ownership rules cannot drift);
 * - the pill's unseen state: a stable row-ID anchor (the source Chat's
 *   `lastSeenRowIdRef` semantics — pinned when the viewport leaves the
 *   bottom, cleared on return) plus `countUnseenRows` over the measured row
 *   tops, decrementing as new rows' tops enter the viewport.
 *
 * Derivations are memoized on geometry identity + header height (the
 * transcript replaces its geometry array only on a real re-render), and the
 * published {@link TimelineState} is identity-stable while the consumed
 * content is unchanged — scroll-tick callers pay an O(turns) integer scan
 * and a field compare, never a rebuild (research §5.2's allocation-storm
 * warning). Inline mode never constructs a frame (no ScrollView), so no
 * snapshot/pill data exists there (§3.4.8).
 */
import {
  computeTimelineSnapshot,
  countUnseenRows,
  nextUnseenAnchor,
  type TimelineSnapshot,
  type TimelineTurn,
} from './timeline-model.js'
import type { TranscriptRowGeometry } from './components/transcript.js'

/** One tick's inputs, gathered by the chat screen. */
export interface TimelineFrame {
  /** Transcript session epoch (TranscriptProjection meta): a change means
   *  row ids restarted (/new, /resume, model swap) — every id-keyed
   *  derivation and the unseen anchor reset. */
  readonly sessionEpoch: number
  /** Row geometry of the last transcript render, in transcript-local line
   *  space; identity-stable while the transcript's render cache holds. */
  readonly geometry: readonly TranscriptRowGeometry[]
  /** The transcript's offset inside the ScrollView content — the header
   *  height (§3.4.3). The header lives IN the scroll content, so a row's
   *  content-space top is its transcript-local startRow plus this. */
  readonly headerHeight: number
  /** Projected viewport top in content coordinates (ScrollView.scrollTop). */
  readonly scrollTop: number
  readonly viewportHeight: number
  /** Full scroll-content height (ScrollView.contentHeight). */
  readonly contentHeight: number
  /** ScrollView.isFollowingEnd — the source's isSticky equivalent. */
  readonly atBottom: boolean
}

/** The published per-tick result; consumers treat it as immutable. */
export interface TimelineState {
  readonly snapshot: TimelineSnapshot
  /** Pill anchor: the id of the last row seen before leaving the bottom,
   *  null while at the bottom (source `lastSeenRowIdRef`). */
  readonly unseenAnchor: number | null
  /** Rows past the anchor whose top edge is still below the viewport. */
  readonly unseenCount: number
  /** Content overflows the viewport (rail eligibility input, §3.3). */
  readonly scrollable: boolean
  /** Viewport pinned to the content end (pill visibility input, §3.5). */
  readonly atBottom: boolean
}

const EMPTY_SNAPSHOT: TimelineSnapshot = Object.freeze({
  turns: [],
  activeId: null,
  upId: null,
  downId: null,
})

/** Pre-first-frame default: nothing scrollable, parked at the bottom. */
const INITIAL_STATE: TimelineState = Object.freeze({
  snapshot: EMPTY_SNAPSHOT,
  unseenAnchor: null,
  unseenCount: 0,
  scrollable: false,
  atBottom: true,
})

export class ChatTimeline {
  private epoch = -1
  private geometry: readonly TranscriptRowGeometry[] = []
  private headerHeight = -1
  private turns: readonly TimelineTurn[] = []
  private rowTops: ReadonlyArray<{ id: number; top: number }> = []
  private unseenAnchor: number | null = null
  private published: TimelineState = INITIAL_STATE

  /** The latest published state (identity-stable while inputs are). */
  get state(): TimelineState {
    return this.published
  }

  /**
   * Advance one tick. Idempotent: same inputs return the same published
   * object, so callers may tick as often as they like (update tick now, a
   * per-frame view pull in M4b) without churning consumers.
   */
  update(frame: TimelineFrame): TimelineState {
    if (frame.sessionEpoch !== this.epoch) {
      // Session replacement: row ids restarted — drop every id-keyed
      // derivation with the anchor (the geometry/scroll state follow on the
      // same tick).
      this.epoch = frame.sessionEpoch
      this.geometry = []
      this.headerHeight = -1
      this.turns = []
      this.rowTops = []
      this.unseenAnchor = null
    }

    // Turns/rowTops change ONLY when the geometry or the header offset does
    // — the transcript replaces the geometry array on every real re-render,
    // so identity + headerHeight is the whole memo key.
    if (frame.geometry !== this.geometry || frame.headerHeight !== this.headerHeight) {
      this.geometry = frame.geometry
      this.headerHeight = frame.headerHeight
      const turns: TimelineTurn[] = []
      const rowTops: { id: number; top: number }[] = []
      for (const row of frame.geometry) {
        if (row.startRow >= 0) rowTops.push({ id: row.rowId, top: frame.headerHeight + row.startRow })
        if (row.kind !== 'user') continue
        turns.push(
          row.folded
            ? { id: row.rowId, top: -1, preview: row.preview, folded: true }
            : { id: row.rowId, top: frame.headerHeight + row.startRow, preview: row.preview },
        )
      }
      this.turns = turns
      this.rowTops = rowTops
    }

    const maxScroll = Math.max(0, frame.contentHeight - frame.viewportHeight)
    const snapshot = computeTimelineSnapshot(this.turns, frame.scrollTop, maxScroll)

    // Pill state machine (§3.5): anchor the last row id when leaving the
    // bottom, count anchored rows whose top is still below the viewport,
    // clear on return to the bottom.
    const lastRowId = frame.geometry.length === 0 ? null : frame.geometry[frame.geometry.length - 1]!.rowId
    this.unseenAnchor = nextUnseenAnchor(this.unseenAnchor, frame.atBottom, lastRowId)
    const unseenCount = countUnseenRows(this.rowTops, this.unseenAnchor, frame.scrollTop + frame.viewportHeight)

    // Change detection (the source's report signature): the turns identity
    // pins the geometry generation — any top change rebuilds the array —
    // and the ids pin the viewport-derived targets. Republish only when a
    // consumed field actually changed.
    const scrollable = frame.contentHeight > frame.viewportHeight
    const prev = this.published
    if (
      prev.snapshot.turns === snapshot.turns &&
      prev.snapshot.activeId === snapshot.activeId &&
      prev.snapshot.upId === snapshot.upId &&
      prev.snapshot.downId === snapshot.downId &&
      prev.unseenAnchor === this.unseenAnchor &&
      prev.unseenCount === unseenCount &&
      prev.scrollable === scrollable &&
      prev.atBottom === frame.atBottom
    ) {
      return prev
    }
    const next: TimelineState = Object.freeze({
      snapshot,
      unseenAnchor: this.unseenAnchor,
      unseenCount,
      scrollable,
      atBottom: frame.atBottom,
    })
    this.published = next
    return next
  }
}
