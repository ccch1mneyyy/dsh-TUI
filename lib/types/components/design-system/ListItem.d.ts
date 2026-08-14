import React, { type ReactNode } from 'react';
export type ListItemProps = {
    /** Whether this item is currently focused (keyboard selection).
     *  Shows the pointer indicator (❯) when true. */
    isFocused: boolean;
    /** Whether this item is selected (chosen/checked).
     *  Shows the checkmark indicator (✓) when true. */
    isSelected?: boolean;
    /** The content to display for this item. */
    children: ReactNode;
    /** Optional description text displayed below the main content. */
    description?: string;
    /** Show a down arrow indicator instead of pointer (scroll hints). */
    showScrollDown?: boolean;
    /** Show an up arrow indicator instead of pointer (scroll hints). */
    showScrollUp?: boolean;
    /** Whether to apply automatic styling based on focus/selection state. */
    styled?: boolean;
    /** Disabled items show dimmed text and no indicators. */
    disabled?: boolean;
    /**
     * Whether this ListItem should declare the terminal cursor position.
     * Set false when a child (e.g. BaseTextInput) declares its own cursor.
     * @default true
     */
    declareCursor?: boolean;
};
/**
 * A list item for selection UIs (ported from the leak's
 * design-system/ListItem.tsx): `❯` pointer for the focused row, `✓`
 * checkmark for the selected row, description on an indented second line,
 * and CC's color states (focused = suggestion blue, selected = success
 * green).
 */
export declare function ListItem({ isFocused, isSelected, children, description, showScrollDown, showScrollUp, styled, disabled, declareCursor, }: ListItemProps): React.ReactNode;
//# sourceMappingURL=ListItem.d.ts.map