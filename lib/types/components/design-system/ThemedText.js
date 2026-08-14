import { jsx as _jsx } from "react/jsx-runtime";
import React from 'react';
import Text from '../../ink/components/Text.js';
import { getTheme } from '../../theme.js';
import { useTheme } from './ThemeProvider.js';
/**
 * Colors uncolored ThemedText in the subtree. Precedence: explicit `color` >
 * this > dimColor (ported from the leak's design-system, where message rows
 * set it to `text` on hover).
 */
export const TextHoverColorContext = React.createContext(undefined);
/** Resolves a color value that may be a theme key to a raw Color. */
function resolveColor(color, theme) {
    if (!color)
        return undefined;
    // Check if it's a raw color (starts with rgb(, #, ansi256(, or ansi:)
    if (color.startsWith('rgb(') ||
        color.startsWith('#') ||
        color.startsWith('ansi256(') ||
        color.startsWith('ansi:')) {
        return color;
    }
    // It's a theme key - resolve it
    return theme[color];
}
/**
 * Theme-aware Text component that resolves theme color keys to raw colors
 * (ported from the leak's design-system). This is what lets every ported CC
 * component use `color="subtle"`-style theme keys unchanged.
 */
export default function ThemedText({ color, backgroundColor, dimColor = false, bold = false, italic = false, underline = false, strikethrough = false, inverse = false, wrap = 'wrap', children, }) {
    const [themeName] = useTheme();
    const theme = getTheme(themeName);
    const hoverColor = React.useContext(TextHoverColorContext);
    // Resolve theme keys to raw colors
    const resolvedColor = !color && hoverColor
        ? theme[hoverColor]
        : dimColor
            ? theme.inactive
            : resolveColor(color, theme);
    const resolvedBackgroundColor = backgroundColor
        ? theme[backgroundColor]
        : undefined;
    return (_jsx(Text, { color: resolvedColor, backgroundColor: resolvedBackgroundColor, bold: bold, italic: italic, underline: underline, strikethrough: strikethrough, inverse: inverse, wrap: wrap, children: children }));
}
