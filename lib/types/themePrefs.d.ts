/**
 * Persisted color-theme preference. The `/theme` choice (built-in palette
 * or user theme name) survives restarts in `~/.dsh-tui/theme.json`, mirroring
 * the working-activity preference (`~/.dsh-tui/working-activity.json`). The
 * file is best-effort: a missing or corrupt file just falls back to the
 * default (terminal-background auto-detection). The preference only wins
 * when DSH_TUI_THEME is unset — see ThemeProvider.
 */
/**
 * Parse a persisted `{ theme }` value; anything else yields undefined.
 * @param text - Raw file contents.
 * @returns The theme name when valid, else undefined.
 */
export declare function parseThemePref(text: string): string | undefined;
/**
 * The persisted theme name, or undefined when unset or invalid.
 * @param dir - Prefs directory (injectable for tests).
 * @returns The persisted theme name, if any.
 */
export declare function readThemePref(dir?: string): string | undefined;
/**
 * Persist the chosen theme name (best effort).
 * @param name - Theme name to persist.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was written, false on failure.
 */
export declare function writeThemePref(name: string, dir?: string): boolean;
//# sourceMappingURL=themePrefs.d.ts.map