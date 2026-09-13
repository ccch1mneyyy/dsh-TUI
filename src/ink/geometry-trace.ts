/**
 * Geometry forensics — per-frame scroll-geometry trace (issues #421/#433).
 *
 * `DSH_TUI_GEOMETRY_TRACE=<file>` appends one JSON line per painted frame:
 * the frame's trigger cause, every ScrollBox's resolved geometry (scrollTop
 * before/after follow + drain + virtual clamp, scrollHeight/maxScroll
 * prev/cur, sticky/shrunk/grew flags, clamp bounds), the MessageList
 * virtualization window, and aux counters (e.g. PromptInput content rows).
 *
 * Zero overhead when the env is unset: every entry point returns on a
 * module-const boolean, so the disabled path is a single predictable branch.
 *
 * Ordering contract: causes and React-side notes (list geometry, aux) land
 * BETWEEN frames — at event/commit time, before the throttled paint. The
 * renderer adds scroll geometry during the paint; endGeometryFrame flushes
 * and resets. First-noted cause wins (the origin of the frame chain); no
 * note at paint time means a plain reconciler commit.
 */
import { appendFileSync } from 'node:fs'

export type FrameCause =
  | 'react-commit'
  | 'animation'
  | 'scroll'
  | 'scroll-drain'
  | 'overlay-shrink'
  | 'measure'
  | 'resize'
  | 'reanchor'
  | 'immediate'

export const GEOMETRY_TRACE_ENABLED = process.env.DSH_TUI_GEOMETRY_TRACE !== undefined &&
  process.env.DSH_TUI_GEOMETRY_TRACE !== ''

const TRACE_PATH = process.env.DSH_TUI_GEOMETRY_TRACE ?? ''

export type ScrollGeometryNote = {
  sticky: boolean
  shrunk: boolean
  grew: boolean
  atBottom: boolean
  /** scrollTop captured before at-bottom follow (the user's logical view). */
  scrollTopBeforeFollow: number
  /** scrollTop after pendingScrollDelta drain, before clamps. */
  cur: number
  /** scrollTop written back to the DOM node (post follow/drain, pre virtual clamp). */
  scrollTop: number
  /** What actually gets painted this frame (post cMin/cMax virtual clamp). */
  renderScrollTop: number
  scrollHeight: number
  prevScrollHeight: number
  innerHeight: number
  maxScroll: number
  prevMaxScroll: number
  clampMin: number | null
  clampMax: number | null
}

export type ListGeometryNote = {
  start: number
  end: number
  topPad: number
  bottomPad: number
  /** Estimated total content height from cached row heights. */
  total: number
  base: number
  sticky: boolean
  pending: number
  viewport: number
  termRows: number
  columns: number
  rowCount: number
}

interface TraceState {
  frame: number
  cause: FrameCause | null
  scroll: ScrollGeometryNote[]
  list: ListGeometryNote | null
  aux: Record<string, number>
}

let state: TraceState = {
  frame: -1,
  cause: null,
  scroll: [],
  list: null,
  aux: {}
}

/** Tag the origin of the next painted frame. First note in the window wins. */
export function noteFrameCause(cause: FrameCause): void {
  if (!GEOMETRY_TRACE_ENABLED) return
  if (state.cause === null) state.cause = cause
}

/** Renderer-side note, one per ScrollBox encountered during the paint. */
export function noteScrollGeometry(note: ScrollGeometryNote): void {
  if (!GEOMETRY_TRACE_ENABLED) return
  state.scroll.push(note)
}

/** React-side note from MessageList's virtualization pass (latest wins). */
export function noteListGeometry(note: ListGeometryNote): void {
  if (!GEOMETRY_TRACE_ENABLED) return
  state.list = note
}

/** Scalar forensics (PromptInput content rows, …). Latest wins. */
export function noteAuxNumber(key: string, value: number): void {
  if (!GEOMETRY_TRACE_ENABLED) return
  state.aux[key] = value
}

/** Paint begins: just tag the frame id — inter-frame notes belong to it. */
export function beginGeometryFrame(frame: number): void {
  if (!GEOMETRY_TRACE_ENABLED) return
  state.frame = frame
}

/** Paint ends: flush one JSON line and reset the inter-frame window. */
export function endGeometryFrame(durationMs: number): void {
  if (!GEOMETRY_TRACE_ENABLED) return
  if (state.frame >= 0) {
    const line = JSON.stringify({
      t: new Date().toISOString(),
      frame: state.frame,
      cause: state.cause ?? 'react-commit',
      ms: Math.round(durationMs * 10) / 10,
      scroll: state.scroll,
      list: state.list,
      aux: state.aux
    })
    try {
      appendFileSync(TRACE_PATH, line + '\n')
    } catch {
      // Unwritable path etc. — forensics must never break rendering.
    }
  }
  state = { frame: -1, cause: null, scroll: [], list: null, aux: {} }
}
