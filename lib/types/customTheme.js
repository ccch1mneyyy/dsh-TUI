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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTheme, AUTO_THEME_NAME } from './theme.js';
import { DATA_DIR } from './utils/paths.js';
/** The base palettes a user theme may overlay. */
export const THEME_BASE_NAMES = ['light', 'dark', 'dark-ansi'];
/** The directory user theme files live in (~/.dsh-tui/themes). */
export const CUSTOM_THEME_DIR = join(DATA_DIR, 'themes');
// #rgb / #rrggbb / #rrggbbaa
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// rgb(r,g,b) — the storage form of the built-in truecolor palettes
const RGB_RE = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/;
// ansi256(n) — supported by the Ink color engine
const ANSI256_RE = /^ansi256\(\s*(\d{1,3})\s*\)$/;
// The 16 standard ANSI names (the dark-ansi palette's storage form)
const ANSI_NAMES = new Set([
    'ansi:black',
    'ansi:red',
    'ansi:green',
    'ansi:yellow',
    'ansi:blue',
    'ansi:magenta',
    'ansi:cyan',
    'ansi:white',
    'ansi:blackBright',
    'ansi:redBright',
    'ansi:greenBright',
    'ansi:yellowBright',
    'ansi:blueBright',
    'ansi:magentaBright',
    'ansi:cyanBright',
    'ansi:whiteBright',
]);
/** Resolved custom palettes, keyed by theme name (never caches failures). */
const cache = new Map();
/**
 * `spec.name` → load key (file name), so a theme whose `name` field differs
 * from its file name still resolves (DSH_TUI_THEME, /theme, persistence all
 * speak the display name). Filled lazily on the first name miss.
 */
const nameIndex = new Map();
let nameIndexed = false;
function isThemeBase(value) {
    return THEME_BASE_NAMES.includes(value);
}
/**
 * Whether a name is safe to use as a file name (no path separators or dot
 * traversal). Theme names are user input from DSH_TUI_THEME and /theme, so
 * they must never escape the themes directory.
 */
export function isSafeThemeName(name) {
    return (name.length > 0 &&
        name !== '.' &&
        name !== '..' &&
        !name.includes('/') &&
        !name.includes('\\'));
}
/**
 * Whether a value is an accepted color string: #rgb/#rrggbb/#rrggbbaa,
 * rgb(r,g,b), ansi256(n) or one of the 16 ansi: names — the same forms the
 * built-in palettes and the Ink color engine accept.
 * @param value - Candidate color value.
 * @returns True when the value is a well-formed color string.
 */
export function isValidThemeColor(value) {
    if (typeof value !== 'string')
        return false;
    if (HEX_RE.test(value))
        return true;
    const rgb = RGB_RE.exec(value);
    if (rgb !== null) {
        return rgb.slice(1).every(channel => Number(channel) <= 255);
    }
    const ansi = ANSI256_RE.exec(value);
    if (ansi !== null)
        return Number(ansi[1]) <= 255;
    return ANSI_NAMES.has(value);
}
function warn(message) {
    console.warn(`[dsh-tui] ${message}`);
}
/**
 * Parse and validate a theme file's contents. Unknown keys and invalid
 * color values are skipped (each warned); a file that is not an object,
 * has an invalid `base`, or has a non-object `colors` is rejected entirely.
 * @param text - Raw file contents.
 * @param fileName - File name (with or without the .json extension); the
 *   load key and the default theme name when the file omits `name`.
 * @returns The validated spec, or undefined when the file is unusable.
 */
export function parseCustomTheme(text, fileName) {
    const fileKey = fileName.toLowerCase().endsWith('.json')
        ? fileName.slice(0, -'.json'.length)
        : fileName;
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        warn(`theme file "${fileName}" is not valid JSON; skipped`);
        return undefined;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        warn(`theme file "${fileName}" is not a JSON object; skipped`);
        return undefined;
    }
    const raw = parsed;
    const base = raw.base;
    if (typeof base !== 'string' || !isThemeBase(base)) {
        warn(`theme "${fileName}": invalid or missing "base" (expected light|dark|dark-ansi); file skipped`);
        return undefined;
    }
    const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : fileKey;
    if (!isSafeThemeName(name)) {
        warn(`theme "${fileName}": unsafe "name" ("${name}"); file skipped`);
        return undefined;
    }
    const displayName = typeof raw.displayName === 'string' && raw.displayName.trim() !== ''
        ? raw.displayName.trim()
        : name;
    const colorsRaw = raw.colors;
    if (colorsRaw === undefined) {
        return { name, displayName, base, colors: {}, file: fileKey };
    }
    if (colorsRaw === null ||
        typeof colorsRaw !== 'object' ||
        Array.isArray(colorsRaw)) {
        warn(`theme "${fileName}": "colors" must be an object; file skipped`);
        return undefined;
    }
    // Key/color validation against the base palette, so unknown keys and bad
    // values are skipped per key (warned) instead of killing the theme.
    const baseTheme = getTheme(base);
    const colors = {};
    for (const [key, value] of Object.entries(colorsRaw)) {
        if (!(key in baseTheme)) {
            warn(`theme "${fileName}": unknown color key "${key}" skipped`);
            continue;
        }
        if (!isValidThemeColor(value)) {
            warn(`theme "${fileName}": invalid color value for "${key}" (want #rgb/#rrggbb/#rrggbbaa, rgb(r,g,b), ansi256(n) or ansi:name); skipped`);
            continue;
        }
        colors[key] = value;
    }
    return { name, displayName, base, colors, file: fileKey };
}
/**
 * Load and validate one user theme by name.
 * @param name - Theme name (file name without .json).
 * @param dir - Themes directory (injectable for tests).
 * @returns The validated spec, or undefined when missing/invalid.
 */
export function loadCustomTheme(name, dir = CUSTOM_THEME_DIR) {
    if (!isSafeThemeName(name))
        return undefined;
    try {
        return parseCustomTheme(readFileSync(join(dir, `${name}.json`), 'utf8'), name);
    }
    catch {
        // Missing or unreadable file: a normal condition during discovery, no warning.
        return undefined;
    }
}
/**
 * Discover every usable user theme in the themes directory, sorted by name.
 * Invalid files are skipped (each warned by parseCustomTheme).
 * @param dir - Themes directory (injectable for tests).
 * @returns The validated specs found.
 */
export function listCustomThemes(dir = CUSTOM_THEME_DIR) {
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return [];
    }
    return entries
        .filter(entry => entry.toLowerCase().endsWith('.json'))
        .map(entry => entry.slice(0, -'.json'.length))
        .filter(isSafeThemeName)
        .map(name => loadCustomTheme(name, dir))
        .filter((spec) => spec !== undefined)
        .sort((a, b) => a.name.localeCompare(b.name));
}
/**
 * Overlay a spec's overrides onto its base palette.
 * @param spec - Validated theme spec.
 * @returns The full concrete palette.
 */
export function buildTheme(spec) {
    return { ...getTheme(spec.base), ...spec.colors };
}
/**
 * Resolve a user theme name to its full palette, cached after first load.
 * A `name` field that differs from the file name is indexed on the first
 * miss, so display names resolve everywhere. Failures are not cached, so a
 * file fixed while the TUI runs can be picked up on the next attempt.
 * @param name - User theme name.
 * @returns The built palette, or undefined when unknown/invalid.
 */
export function resolveCustomTheme(name) {
    if (!isSafeThemeName(name))
        return undefined;
    const cached = cache.get(name);
    if (cached !== undefined)
        return cached;
    indexCustomThemeNames();
    const file = nameIndex.get(name) ?? name;
    const spec = loadCustomTheme(file);
    if (spec === undefined)
        return undefined;
    const theme = buildTheme(spec);
    cache.set(name, theme);
    return theme;
}
/**
 * Index every discovered theme's `name` → file name once, lazily. Kept
 * separate from the palette cache so a miss is cheap after the first scan.
 */
function indexCustomThemeNames() {
    if (nameIndexed)
        return;
    for (const spec of listCustomThemes()) {
        nameIndex.set(spec.name, spec.file);
    }
    nameIndexed = true;
}
/**
 * Whether a name selects a usable theme: a built-in palette, the `auto`
 * pseudo-theme, or a valid user theme file. Used for DSH_TUI_THEME /
 * persisted-preference validation and the runtime /theme switch.
 * @param name - Candidate theme name.
 * @returns True when the theme resolves.
 */
export function isThemeAvailable(name) {
    if (name === AUTO_THEME_NAME || isThemeBase(name))
        return true;
    return resolveCustomTheme(name) !== undefined;
}
/** Drop the resolved-theme cache and name index (tests, or after themes change on disk). */
export function clearCustomThemeCache() {
    cache.clear();
    nameIndex.clear();
    nameIndexed = false;
}
