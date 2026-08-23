import type { DOMElement } from '../dom.js'
import { nodeCache } from '../node-cache.js'
import { TerminalEvent, type EventTarget } from './terminal-event.js'

/**
 * Pointer action reported by the terminal protocol.
 *
 * - `press`: a button went down (SGR `M` terminator / X10 press)
 * - `release`: a button came up (SGR `m` terminator; X10 cannot report this)
 * - `move`: pointer motion (SGR drag bit or mode-1003 no-button motion)
 */
export type PointerAction = 'press' | 'release' | 'move'

/** Optional state when constructing a {@link PointerEvent}. */
export type PointerEventInit = {
  /** Raw protocol button byte (SGR bits: 0x04 shift, 0x08 alt, 0x10 ctrl). */
  button?: number
  action?: PointerAction
  bubbles?: boolean
  cancelable?: boolean
}

/**
 * Base class for pointer-derived terminal events (click, wheel, hover).
 *
 * Carries the raw SGR/X10 button byte so handlers can read modifier flags
 * (`shift`/`alt`/`ctrl`) without re-parsing the escape sequence, plus
 * per-handler local coordinates: `_prepareForTarget` recomputes
 * `localCol`/`localRow` from the nodeCache rect before each handler fires,
 * so an onClick on a container sees coordinates relative to that container,
 * not to the child the pointer actually landed on.
 *
 * `meta` is deliberately always false: xterm.js drops metaKey before SGR
 * encoding (the SGR bit we call "meta" is wired to alt), so no pointer
 * protocol can distinguish it reliably.
 */
export class PointerEvent extends TerminalEvent {
  /** 0-indexed screen column of the pointer. */
  readonly col: number
  /** 0-indexed screen row of the pointer. */
  readonly row: number
  /** Raw protocol button byte (SGR encoding). */
  readonly button: number
  /** Which pointer action produced this event. */
  readonly action: PointerAction
  /** Shift held (SGR button bit 0x04). */
  readonly shift: boolean
  /** Alt/Option held (SGR button bit 0x08). */
  readonly alt: boolean
  /** Ctrl held (SGR button bit 0x10). */
  readonly ctrl: boolean
  /** Always false — see class doc. */
  readonly meta = false
  /** Column relative to the current handler's node (set during dispatch). */
  localCol = 0
  /** Row relative to the current handler's node (set during dispatch). */
  localRow = 0

  constructor(type: string, col: number, row: number, init?: PointerEventInit) {
    super(type, {
      bubbles: init?.bubbles ?? true,
      cancelable: init?.cancelable ?? true,
    })
    this.col = col
    this.row = row
    this.button = init?.button ?? 0
    this.action = init?.action ?? 'move'
    this.shift = (this.button & 0x04) !== 0
    this.alt = (this.button & 0x08) !== 0
    this.ctrl = (this.button & 0x10) !== 0
  }

  /**
   * Refresh localCol/localRow for the node whose handler is about to run.
   * Nodes without a cached rect (not rendered this frame) get 0,0 — handlers
   * should prefer absolute col/row when that distinction matters.
   */
  override _prepareForTarget(target: EventTarget): void {
    const rect = nodeCache.get(target as DOMElement)
    this.localCol = rect ? this.col - rect.x : 0
    this.localRow = rect ? this.row - rect.y : 0
  }
}
