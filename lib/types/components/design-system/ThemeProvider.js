import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useContext } from 'react';
/**
 * Simplified theme provider for the cc-tui port. The leaked Claude Code
 * original resolved `auto` against the terminal's system theme and persisted
 * the choice; cc-tui is dark-first and exposes the palette via `useTheme`.
 */
const ThemeContext = createContext('dark');
export function ThemeProvider({ children, theme = 'dark', }) {
    return (_jsx(ThemeContext.Provider, { value: theme, children: children }));
}
/** Resolves the active `ThemeName`. Returns `[themeName]` to match the leak's shape. */
export function useTheme() {
    return [useContext(ThemeContext)];
}
//# sourceMappingURL=ThemeProvider.js.map