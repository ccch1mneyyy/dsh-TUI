import React from 'react';
/**
 * The `/thinking` dialog, ported from the leak's ThinkingToggle.tsx: a
 * permission-colored Pane with a bold title, the Enabled/Disabled select
 * (with CC's option descriptions), and the Enter/Esc hint line.
 *
 * When `confirmationPending` is set (mid-conversation toggle), the select is
 * replaced by CC's yellow warning block and the hint line becomes
 * Enter confirm / Esc cancel; keyboard handling lives in the caller (Chat).
 */
export declare function ThinkingToggle({ currentValue, focusIndex, confirmationPending, }: {
    currentValue: boolean;
    focusIndex: number;
    /** Set while a mid-conversation toggle awaits Enter confirmation. */
    confirmationPending: boolean | null;
}): React.ReactNode;
//# sourceMappingURL=ThinkingToggle.d.ts.map