import React, { type Ref } from 'react';
import type { Except } from 'type-fest';
import type { DOMElement } from '../dom.js';
import type { Styles } from '../styles.js';
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
declare function Button(t0: any): any;
export default Button;
export type { ButtonState };
//# sourceMappingURL=Button.d.ts.map