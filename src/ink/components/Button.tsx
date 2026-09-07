import React, { type Ref, useCallback, useEffect, useRef, useState } from 'react';
import type { Except } from 'type-fest';
import type { DOMElement } from '../dom.js';
import type { ClickEvent } from '../events/click-event.js';
import type { FocusEvent } from '../events/focus-event.js';
import type { KeyboardEvent } from '../events/keyboard-event.js';
import type { Styles } from '../styles.js';
import Box from './Box.js';
type ButtonState = {
  focused: boolean;
  hovered: boolean;
  active: boolean;
};
export type Props = Except<Styles, 'textWrap'> & {
  ref?: Ref<DOMElement>;
  /**
   * Called when the button is activated via Enter, Space, or click.
   */
  onAction: () => void;
  /**
   * Tab order index. Defaults to 0 (in tab order).
   * Set to -1 for programmatically focusable only.
   */
  tabIndex?: number;
  /**
   * Focus this button when it mounts.
   */
  autoFocus?: boolean;
  /**
   * Render prop receiving the interactive state. Use this to
   * style children based on focus/hover/active — Button itself
   * is intentionally unstyled.
   *
   * If not provided, children render as-is (no state-dependent styling).
   */
  children: ((state: ButtonState) => React.ReactNode) | React.ReactNode;
};
function Button({ onAction, children, tabIndex = 0, ref, autoFocus, ...style }: Props) {
  const [state, setState] = useState<ButtonState>({ focused: false, hovered: false, active: false })
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const handleKey = useCallback((event: KeyboardEvent) => {
    if (event.key !== 'return' && event.key !== ' ') return
    event.preventDefault()
    clearTimeout(timer.current)
    setState(current => ({ ...current, active: true }))
    timer.current = setTimeout(() => setState(current => ({ ...current, active: false })), 100)
    onAction()
  }, [onAction])
  const onFocus = useCallback(() => setState(current => ({ ...current, focused: true })), [])
  const onBlur = useCallback(() => setState(current => ({ ...current, focused: false })), [])
  const onMouseEnter = useCallback(() => setState(current => ({ ...current, hovered: true })), [])
  const onMouseLeave = useCallback(() => setState(current => ({ ...current, hovered: false })), [])
  return <Box {...style} ref={ref} autoFocus={autoFocus} tabIndex={tabIndex}
    onClick={onAction} onKeyDown={handleKey} {...{ onFocus, onBlur, onMouseEnter, onMouseLeave }}>
    {typeof children === 'function' ? children(state) : children}
  </Box>
}
export default Button
export type { ButtonState }
