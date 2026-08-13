import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from '../../ui.js';
import { useDeclaredCursor } from '../../ink/hooks/use-declared-cursor.js';
import { POINTER, DOWN_ARROW, UP_ARROW, TICK } from '../../cc/figures.js';
/**
 * A list item for selection UIs (ported from the leak's
 * design-system/ListItem.tsx): `❯` pointer for the focused row, `✓`
 * checkmark for the selected row, description on an indented second line,
 * and CC's color states (focused = suggestion blue, selected = success
 * green).
 */
export function ListItem({ isFocused, isSelected = false, children, description, showScrollDown, showScrollUp, styled = true, disabled = false, declareCursor, }) {
    // Park the native terminal cursor on the pointer indicator so screen
    // readers / magnifiers track the focused item (CC behavior). (0,0) is the
    // top-left of this Box, where the pointer renders.
    const cursorRef = useDeclaredCursor({
        line: 0,
        column: 0,
        active: isFocused && !disabled && declareCursor !== false,
    });
    function renderIndicator() {
        if (disabled) {
            return _jsx(Text, { children: " " });
        }
        if (isFocused) {
            return _jsx(Text, { color: "suggestion", children: POINTER });
        }
        if (showScrollDown) {
            return _jsx(Text, { dimColor: true, children: DOWN_ARROW });
        }
        if (showScrollUp) {
            return _jsx(Text, { dimColor: true, children: UP_ARROW });
        }
        return _jsx(Text, { children: " " });
    }
    function getTextColor() {
        if (disabled)
            return 'inactive';
        if (!styled)
            return undefined;
        if (isSelected)
            return 'success';
        if (isFocused)
            return 'suggestion';
        return undefined;
    }
    return (_jsxs(Box, { ref: cursorRef, flexDirection: "column", children: [_jsxs(Box, { flexDirection: "row", gap: 1, children: [renderIndicator(), styled ? (_jsx(Text, { color: getTextColor(), dimColor: disabled, children: children })) : (children), isSelected && !disabled && _jsx(Text, { color: "success", children: TICK })] }), description && (_jsx(Box, { paddingLeft: 2, children: _jsx(Text, { color: "inactive", children: description }) }))] }));
}
