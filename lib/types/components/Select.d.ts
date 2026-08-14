import React from 'react';
export type SelectOption = {
    value: string;
    /** Row content; plain strings render inline, richer rows may carry color swatches. */
    label: React.ReactNode;
    description?: string;
};
/**
 * A single-choice select list in the CC CustomSelect style (ported visual:
 * ListItem rows with ❯ focus pointer, ✓ selected checkmark, descriptions,
 * scroll arrows). Keyboard navigation is owned by the parent dialog, which
 * passes focus/selection indices back in.
 */
export declare function Select({ options, focusIndex, selectedValue, visibleOptionCount, }: {
    options: readonly SelectOption[];
    /** Index of the keyboard-focused row (shows the ❯ pointer). */
    focusIndex: number;
    /** Value of the chosen row (shows the ✓ checkmark). */
    selectedValue: string | undefined;
    visibleOptionCount?: number;
}): React.ReactNode;
//# sourceMappingURL=Select.d.ts.map