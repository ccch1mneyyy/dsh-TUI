/**
 * Persisted color-theme preference. The `/theme` choice (built-in palette
 * or user theme name) survives restarts in `~/.dsh-cc/theme.json`, mirroring
 * the working-activity preference (`~/.dsh-cc/working-activity.json`). The
 * file is best-effort: a missing or corrupt file just falls back to the
 * default (terminal-background auto-detection). The preference only wins
 * when CC_TUI_THEME is unset — see ThemeProvider.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isSafeThemeName } from './customTheme.js';
const PREFS_DIR = join(homedir(), '.dsh-cc');
/**
 * Parse a persisted `{ theme }` value; anything else yields undefined.
 * @param text - Raw file contents.
 * @returns The theme name when valid, else undefined.
 */
export function parseThemePref(text) {
    try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return undefined;
        const theme = parsed.theme;
        return typeof theme === 'string' && isSafeThemeName(theme) ? theme : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * The persisted theme name, or undefined when unset or invalid.
 * @param dir - Prefs directory (injectable for tests).
 * @returns The persisted theme name, if any.
 */
export function readThemePref(dir = PREFS_DIR) {
    try {
        return parseThemePref(readFileSync(join(dir, 'theme.json'), 'utf8'));
    }
    catch {
        return undefined;
    }
}
/**
 * Persist the chosen theme name (best effort).
 * @param name - Theme name to persist.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was written, false on failure.
 */
export function writeThemePref(name, dir = PREFS_DIR) {
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'theme.json'), JSON.stringify({ theme: name }, null, 2));
        return true;
    }
    catch {
        return false;
    }
}
