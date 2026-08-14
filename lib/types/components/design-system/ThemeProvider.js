import { jsx as _jsx } from "react/jsx-runtime";
import React, { createContext, useContext, useEffect, useState } from 'react';
import { registerCustomThemeResolver, setActiveThemeName } from '../../theme.js';
import { isThemeAvailable, resolveCustomTheme } from '../../customTheme.js';
import { readThemePref, writeThemePref } from '../../themePrefs.js';
import useStdin from '../../ink/hooks/use-stdin.js';
import { oscColor } from '../../ink/terminal-querier.js';
import { parseOscColor } from '../../ink/termio/osc.js';
import { logForDebugging } from '../../utils/debug.js';
/**
 * Theme provider with terminal-background auto-detection. With no explicit
 * `theme` prop, no CC_TUI_THEME override and no persisted choice
 * (~/.dsh-cc/theme.json), it queries the terminal's background color
 * (OSC 11) before first paint and picks the Gentle Mist Blue `light` palette
 * on light backgrounds, `dark` otherwise. Priority: explicit `theme` prop >
 * CC_TUI_THEME (built-in or user theme name) > persisted `/theme` choice >
 * OSC 11 detection. An invalid forced name is warned and skipped, so
 * detection still runs. Children render only after the theme settles, so
 * the first frame already carries the final palette — no dark→light flash.
 * Detection never blocks boot: a terminal that ignores OSC 11 (or a 400ms
 * stall) falls back to `dark`. The resolved name is mirrored via
 * setActiveThemeName() for non-React rendering (markdown inline code).
 *
 * The context also exposes setTheme() for the runtime `/theme` picker: it
 * validates the name, persists the choice to ~/.dsh-cc/theme.json and hot
 * swaps the palette (and the module-level mirror) immediately.
 */
// User themes (~/.dsh-cc/themes/<name>.json) resolve through this registry,
// so getTheme() serves them to every themed component and to non-React
// rendering (markdown inline code) without a context.
registerCustomThemeResolver(resolveCustomTheme);
const ThemeContext = createContext({
    theme: 'dark',
    setTheme: () => false,
});
/**
 * CC_TUI_THEME skips terminal detection (tests, debugging). Accepts a
 * built-in name (light|dark|dark-ansi) or a user theme name; invalid values
 * are warned and ignored by the caller, falling back to detection.
 */
function envThemeOverride() {
    const v = process.env.CC_TUI_THEME;
    return v === undefined || v === '' ? undefined : v;
}
/** Detection round-trip is normally ~10ms locally; this only bounds pathological stalls. */
const DETECT_TIMEOUT_MS = 400;
/**
 * sRGB luma (Rec. 601). The threshold biases dark: a light palette on a
 * dark terminal is far less readable than the reverse, and the dark
 * palette is the pre-detection status quo.
 */
function isLightBackground(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b > 140;
}
export function ThemeProvider({ children, theme, }) {
    // Resolution happens once on mount: the forced chain (prop > env >
    // persisted) or null, which arms OSC 11 detection.
    const [forced] = useState(() => theme ?? envThemeOverride() ?? readThemePref());
    const [forcedValid] = useState(() => {
        if (forced === undefined)
            return false;
        if (isThemeAvailable(forced))
            return true;
        console.warn(`[dsh-cc-tui] theme "${forced}" not found (built-ins: light, dark, dark-ansi; user themes: ~/.dsh-cc/themes/*.json); falling back to auto-detection`);
        return false;
    });
    const [active, setActive] = useState(forcedValid ? forced ?? null : null);
    const { internal_querier, setRawMode, isRawModeSupported } = useStdin();
    useEffect(() => {
        if (forcedValid)
            return;
        const querier = internal_querier;
        // Stdin responses only flow while raw mode holds the readable listener;
        // without a querier (or raw-mode support) detection is impossible.
        if (querier === null || !isRawModeSupported) {
            logForDebugging('theme: detection unavailable (no querier/raw mode), using dark');
            setActive('dark');
            return;
        }
        let settled = false;
        const finish = (name, why) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            setRawMode(false);
            logForDebugging(`theme: ${name} (${why})`);
            setActive(name);
        };
        const timer = setTimeout(() => { finish('dark', 'detection timeout'); }, DETECT_TIMEOUT_MS);
        setRawMode(true);
        void Promise.all([querier.send(oscColor(11)), querier.flush()]).then(([r]) => {
            const color = r ? parseOscColor(r.data) : null;
            if (color === null || color.type !== 'rgb') {
                finish('dark', 'no OSC 11 reply');
            }
            else {
                finish(isLightBackground(color.r, color.g, color.b) ? 'light' : 'dark', `OSC 11 bg rgb(${color.r},${color.g},${color.b})`);
            }
        });
    }, []);
    /**
     * Runtime theme switch (/theme picker or direct command). Validates the
     * name, persists first (a choice that cannot be saved never silently
     * disappears), then hot swaps the palette.
     */
    const setTheme = React.useCallback((name) => {
        if (!isThemeAvailable(name)) {
            console.warn(`[dsh-cc-tui] theme "${name}" not found`);
            return false;
        }
        if (!writeThemePref(name)) {
            console.warn('[dsh-cc-tui] failed to write ~/.dsh-cc/theme.json');
            return false;
        }
        setActive(name);
        return true;
    }, []);
    const value = React.useMemo(() => ({ theme: active ?? 'dark', setTheme }), [active, setTheme]);
    useEffect(() => {
        if (active !== null)
            setActiveThemeName(active);
    }, [active]);
    if (active === null)
        return null;
    return _jsx(ThemeContext.Provider, { value: value, children: children });
}
/**
 * Resolves the active theme name and the runtime setter. Returns
 * `[themeName, setTheme]` — the first element matches the leak's shape.
 */
export function useTheme() {
    const { theme, setTheme } = useContext(ThemeContext);
    return [theme, setTheme];
}
