import { PointerEvent, type PointerEventInit } from './pointer-event.js'

/**
 * Which phase of a drag gesture the event represents — a subset of the
 * DOM HTML5 drag event semantics:
 *
 * - `dragstart`: the pointer moved for the first time after a press on a
 *   drag target (DOM fires dragstart on first move, not on press)
 * - `dragmove`:   subsequent motion while the button stays held
 * - `dragend`:    the button was released (or the session was interrupted
 *   by focus loss / screen swap) after dragstart had fired
 */
export type DragEventType = 'dragstart' | 'dragmove' | 'dragend'

/**
 * Component-level drag event (DOM HTML5 drag semantics subset).
 *
 * A drag session opens on an unmodified LEFT-button press over a node
 * whose ancestor chain carries an `onDragStart` handler, but stays
 * dormant until the first drag motion — `dragstart` fires then, followed
 * by `dragmove` on every further motion and `dragend` on release. A
 * press+release without any movement never fires drag events and still
 * resolves to a normal click (`onClick`). Modifier presses (shift/alt/
 * ctrl) never open a drag session — they keep the baseline text-selection
 * gesture. Only works inside `<AlternateScreen>` where mouse tracking is
 * enabled.
 *
 * Bubbles from the captured drag target up through parentNode (the target
 * is captured at press, so motion events keep going to it even when the
 * pointer leaves its rect — like DOM element capture). Call
 * `stopImmediatePropagation()` to prevent ancestors' handlers from
 * firing.
 *
 * `col`/`row` are the current absolute pointer position (0-indexed);
 * `startCol`/`startRow` is the press origin; `localCol`/`localRow` are
 * recomputed per handler from the nodeCache rect so containers see
 * coordinates relative to themselves.
 */
export class DragEvent extends PointerEvent {
  /** 0-indexed screen column of the press that started this drag. */
  readonly startCol: number
  /** 0-indexed screen row of the press that started this drag. */
  readonly startRow: number

  constructor(
    type: DragEventType,
    col: number,
    row: number,
    startCol: number,
    startRow: number,
    init?: PointerEventInit,
  ) {
    super(type, col, row, {
      ...init,
      action: type === 'dragend' ? 'release' : 'move',
    })
    this.startCol = startCol
    this.startRow = startRow
  }
}
