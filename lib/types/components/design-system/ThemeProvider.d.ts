import React from 'react';
export declare function ThemeProvider({ children, theme, }: {
    children: React.ReactNode;
    theme?: string;
}): React.ReactNode;
/**
 * Resolves the active theme name and the runtime setter. Returns
 * `[themeName, setTheme]` — the first element matches the leak's shape.
 */
export declare function useTheme(): [string, (name: string) => boolean];
//# sourceMappingURL=ThemeProvider.d.ts.map