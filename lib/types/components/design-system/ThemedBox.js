import { jsx as _jsx } from "react/jsx-runtime";
import Box from '../../ink/components/Box.js';
import { getTheme } from '../../theme.js';
import { useTheme } from './ThemeProvider.js';
/** Resolves a color value that may be a theme key to a raw Color. */
function resolveColor(color, theme) {
    if (!color)
        return undefined;
    if (color.startsWith('rgb(') ||
        color.startsWith('#') ||
        color.startsWith('ansi256(') ||
        color.startsWith('ansi:')) {
        return color;
    }
    return theme[color];
}
/**
 * Theme-aware Box component that resolves theme color keys to raw colors
 * (ported from the leak's design-system).
 */
function ThemedBox({ borderColor, borderTopColor, borderBottomColor, borderLeftColor, borderRightColor, backgroundColor, ...rest }) {
    const [themeName] = useTheme();
    const theme = getTheme(themeName);
    return (_jsx(Box, { ...rest, borderColor: resolveColor(borderColor, theme), borderTopColor: resolveColor(borderTopColor, theme), borderBottomColor: resolveColor(borderBottomColor, theme), borderLeftColor: resolveColor(borderLeftColor, theme), borderRightColor: resolveColor(borderRightColor, theme), backgroundColor: resolveColor(backgroundColor, theme) }));
}
export default ThemedBox;
