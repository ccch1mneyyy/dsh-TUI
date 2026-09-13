import React, { type PropsWithChildren, type Ref } from 'react';
import type { Except } from 'type-fest';
import type { DOMElement } from '../dom.js';
import type { ClickEvent } from '../events/click-event.js';
import type { ContextMenuEvent } from '../events/context-menu-event.js';
import type { DragEvent } from '../events/drag-event.js';
import type { FocusEvent } from '../events/focus-event.js';
import type { KeyboardEvent } from '../events/keyboard-event.js';
import type { PointerEvent } from '../events/pointer-event.js';
import type { WheelEvent } from '../events/wheel-event.js';
import type { Styles } from '../styles.js';
import * as warn from '../warn.js';
export type Props = Except<Styles, 'textWrap'> & {
  ref?: Ref<DOMElement>;
  /**
   * Tab order index. Nodes with `tabIndex >= 0` participate in
   * Tab/Shift+Tab cycling; `-1` means programmatically focusable only.
   */
  tabIndex?: number;
  /**
   * Focus this element when it mounts. Like the HTML `autofocus`
   * attribute — the FocusManager calls `focus(node)` during the
   * reconciler's `commitMount` phase.
   */
  autoFocus?: boolean;
  /**
   * Fired on left-button click (press + release without drag). Only works
   * inside `<AlternateScreen>` where mouse tracking is enabled — no-op
   * otherwise. The event bubbles from the deepest hit Box up through
   * ancestors; call `event.stopImmediatePropagation()` to stop bubbling.
   */
  onClick?: (event: ClickEvent) => void;
  /**
   * Fired on right-button press (SGR button 2). Only works inside
   * `<AlternateScreen>` where mouse tracking is enabled — no-op
   * otherwise. The event bubbles from the deepest hit Box up through
   * ancestors; call `event.stopImmediatePropagation()` to stop bubbling.
   * Carries absolute `col`/`row` so a handler can anchor a popup menu at
   * the pointer.
   */
  onContextMenu?: (event: ContextMenuEvent) => void;
  /**
   * Drag protocol (DOM HTML5 drag semantics subset). Fired when the
   * pointer FIRST MOVES after an unmodified left-button press inside
   * this Box (DOM fires dragstart on first move, not on press) — only
   * inside `<AlternateScreen>` with mouse tracking enabled, and only
   * when no modifier (shift/alt/ctrl) was held at press. `onDragMove`
   * fires on every further motion (bubbles from this Box up through
   * ancestors), `onDragEnd` on release or when the session is
   * interrupted (focus loss / screen swap). A press+release without
   * movement fires NO drag events and still triggers `onClick`.
   */
  onDragStart?: (event: DragEvent) => void;
  /** Fired on each pointer motion after dragstart. See onDragStart. */
  onDragMove?: (event: DragEvent) => void;
  /** Fired on release after dragstart. See onDragStart. */
  onDragEnd?: (event: DragEvent) => void;
  onFocus?: (event: FocusEvent) => void;
  onFocusCapture?: (event: FocusEvent) => void;
  onBlur?: (event: FocusEvent) => void;
  onBlurCapture?: (event: FocusEvent) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  onKeyDownCapture?: (event: KeyboardEvent) => void;
  /**
   * Fired when the mouse moves into this Box's rendered rect. Like DOM
   * `mouseenter`, does NOT bubble — moving between children does not
   * re-fire on the parent. Only works inside `<AlternateScreen>` where
   * mode-1003 mouse tracking is enabled.
   */
  onMouseEnter?: (event: PointerEvent) => void;
  /** Fired when the mouse moves out of this Box's rendered rect. */
  onMouseLeave?: (event: PointerEvent) => void;
  /**
   * Fired when a wheel event occurs over this Box's rendered rect (the
   * position-routed path: dispatchWheel hit-tests the deepest node whose
   * ancestor chain carries an onWheel handler — ScrollBox receives its
   * scrolls this way). `deltaY`/`deltaX` are terminal rows/columns per
   * wheel notch, positive = scroll down/right.
   */
  onWheel?: (event: WheelEvent) => void;
};

/** Flex layout container with renderer event forwarding. */
function Box({ children, ref, tabIndex, autoFocus, onClick, onContextMenu,
  onDragStart, onDragMove, onDragEnd, onWheel, onFocus, onFocusCapture,
  onBlur, onBlurCapture, onKeyDown, onKeyDownCapture, onMouseEnter, onMouseLeave,
  flexDirection = 'row', flexWrap = 'nowrap', flexGrow = 0, flexShrink = 1,
  ...layout
}: PropsWithChildren<Props>) {
  for (const key of SPACING_KEYS) warn.ifNotInteger(layout[key], key)
  const style: Styles = {
    ...layout, flexDirection, flexWrap, flexGrow, flexShrink,
    overflowX: layout.overflowX ?? layout.overflow ?? 'visible',
    overflowY: layout.overflowY ?? layout.overflow ?? 'visible',
  }
  return <ink-box {...{ ref, tabIndex, autoFocus, style, onClick, onContextMenu,
    onDragStart, onDragMove, onDragEnd, onWheel, onFocus, onFocusCapture,
    onBlur, onBlurCapture, onKeyDown, onKeyDownCapture, onMouseEnter, onMouseLeave,
  }}>{children}</ink-box>
}

const SPACING_KEYS = [
  'margin', 'marginX', 'marginY', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
  'padding', 'paddingX', 'paddingY', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
  'gap', 'columnGap', 'rowGap',
] as const

export default React.memo(Box)
