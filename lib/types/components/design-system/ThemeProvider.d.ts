import React from 'react';
import { type ThemeName } from '../../theme.js';
export declare function ThemeProvider({ children, theme, }: {
    children: React.ReactNode;
    theme?: ThemeName;
}): React.ReactNode;
/** Resolves the active `ThemeName`. Returns `[themeName]` to match the leak's shape. */
export declare function useTheme(): [ThemeName];
//# sourceMappingURL=ThemeProvider.d.ts.map