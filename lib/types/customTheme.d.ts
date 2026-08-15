/**
 * User-defined color themes for dsh-tui.
 *
 * A theme is a JSON file in `~/.dsh-tui/themes/<name>.json`:
 *
 * ```json
 * { "name": "sakura", "displayName": "Sakura Pink", "base": "dark",
 *   "colors": { "claude": "#FF9EC7", "text": "#E8E6E0" } }
 * ```
 *
 * `base` is required (`light`/`dark`/`dark-ansi`) and selects the built-in
 * palette the file overlays; `colors` holds a subset of Theme keys. `name`
 * defaults to the file name; `displayName` defaults to `name`.
 *
 * Validation is best-effort per key: unknown keys and invalid color values
 * are skipped with a warning on stderr, never fatal; a file whose JSON is
 * malformed or whose `base` is invalid is skipped entirely (also warned).
 * Accepted color value forms (the same forms the built-in palettes and the
 * Ink color engine use): `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(r,g,b)`,
 * `ansi256(n)` and the 16 `ansi:` names.
 */
import { type Theme } from './theme.js';
/** The base palettes a user theme may overlay. */
export declare const THEME_BASE_NAMES: readonly ["light", "dark", "dark-ansi"];
export type ThemeBase = (typeof THEME_BASE_NAMES)[number];
/** The directory user theme files live in (~/.dsh-tui/themes). */
export declare const CUSTOM_THEME_DIR: string;
/** A validated user theme file. `colors` only carries accepted overrides. */
export type CustomThemeSpec = {
    /** Stable id: the file's `name` field, or the file name (minus .json) when omitted. */
    name: string;
    /** Human-readable label for pickers; defaults to `name`. */
    displayName: string;
    /** The built-in palette this theme overlays. */
    base: ThemeBase;
    /** Validated Theme-key overrides (a subset of the base palette). */
    colors: Partial<Theme>;
    /** The underlying file name without .json — the on-disk load key. */
    file: string;
};
/**
 * Whether a name is safe to use as a file name (no path separators or dot
 * traversal). Theme names are user input from DSH_TUI_THEME and /theme, so
 * they must never escape the themes directory.
 */
export declare function isSafeThemeName(name: string): boolean;
/**
 * Whether a value is an accepted color string: #rgb/#rrggbb/#rrggbbaa,
 * rgb(r,g,b), ansi256(n) or one of the 16 ansi: names — the same forms the
 * built-in palettes and the Ink color engine accept.
 * @param value - Candidate color value.
 * @returns True when the value is a well-formed color string.
 */
export declare function isValidThemeColor(value: unknown): value is string;
/**
 * Parse and validate a theme file's contents. Unknown keys and invalid
 * color values are skipped (each warned); a file that is not an object,
 * has an invalid `base`, or has a non-object `colors` is rejected entirely.
 * @param text - Raw file contents.
 * @param fileName - File name (with or without the .json extension); the
 *   load key and the default theme name when the file omits `name`.
 * @returns The validated spec, or undefined when the file is unusable.
 */
export declare function parseCustomTheme(text: string, fileName: string): CustomThemeSpec | undefined;
/**
 * Load and validate one user theme by name.
 * @param name - Theme name (file name without .json).
 * @param dir - Themes directory (injectable for tests).
 * @returns The validated spec, or undefined when missing/invalid.
 */
export declare function loadCustomTheme(name: string, dir?: string): CustomThemeSpec | undefined;
/**
 * Discover every usable user theme in the themes directory, sorted by name.
 * Invalid files are skipped (each warned by parseCustomTheme).
 * @param dir - Themes directory (injectable for tests).
 * @returns The validated specs found.
 */
export declare function listCustomThemes(dir?: string): CustomThemeSpec[];
/**
 * Overlay a spec's overrides onto its base palette.
 * @param spec - Validated theme spec.
 * @returns The full concrete palette.
 */
export declare function buildTheme(spec: CustomThemeSpec): Theme;
/**
 * Resolve a user theme name to its full palette, cached after first load.
 * A `name` field that differs from the file name is indexed on the first
 * miss, so display names resolve everywhere. Failures are not cached, so a
 * file fixed while the TUI runs can be picked up on the next attempt.
 * @param name - User theme name.
 * @returns The built palette, or undefined when unknown/invalid.
 */
export declare function resolveCustomTheme(name: string): Theme | undefined;
/**
 * Whether a name selects a usable theme: a built-in palette, the `auto`
 * pseudo-theme, or a valid user theme file. Used for DSH_TUI_THEME /
 * persisted-preference validation and the runtime /theme switch.
 * @param name - Candidate theme name.
 * @returns True when the theme resolves.
 */
export declare function isThemeAvailable(name: string): boolean;
/** Drop the resolved-theme cache and name index (tests, or after themes change on disk). */
export declare function clearCustomThemeCache(): void;
//# sourceMappingURL=customTheme.d.ts.map