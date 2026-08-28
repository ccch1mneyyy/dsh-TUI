import { PointerEvent, type PointerEventInit } from './pointer-event.js'

/**
 * Mouse context-menu event. Fired on right-button press (SGR button 2,
 * low bits of the raw button byte), mirroring the DOM `contextmenu` event
 * which shows on mousedown. Only works inside `<AlternateScreen>` where
 * mouse tracking is enabled — right presses are ignored elsewhere.
 *
 * Bubbles from the deepest hit node up through parentNode. Call
 * stopImmediatePropagation() to prevent ancestors' onContextMenu from
 * firing.
 *
 * Carries the raw SGR button byte (`button`: low bits 2 = right button,
 * with 0x04 shift / 0x08 alt / 0x10 ctrl modifier bits) plus absolute
 * `col`/`row`, so a handler can anchor a popup menu at the pointer.
 */
export class ContextMenuEvent extends PointerEvent {
  constructor(col: number, row: number, init?: PointerEventInit) {
    super('contextmenu', col, row, { ...init, action: 'press' })
  }
}
