import { jsx as _jsx } from "react/jsx-runtime";
import React, { createContext, useContext, useEffect, useState } from 'react';
import { registerCustomThemeResolver, setActiveThemeName, setAutoThemeBase, getAutoThemeBase, AUTO_THEME_NAME, } from '../../theme.js';
import { isThemeAvailable, resolveCustomTheme } from '../../customTheme.js';
import { readThemePref, writeThemePref } from '../../themePrefs.js';
import useStdin from '../../ink/hooks/use-stdin.js';
import { oscColor } from '../../ink/terminal-querier.js';
import { parseOscColor } from '../../ink/termio/osc.js';
import { logForDebugging } from '../../utils/debug.js';
/**
 * Theme provider with terminal-background auto-detection. With no explicit
 * `theme` prop, no DSH_TUI_THEME override and no persisted choice
 * (~/.dsh-tui/theme.json), it queries the terminal's background color
 * (OSC 11) before first paint and picks the Gentle Mist Blue `light` palette
 * on light backgrounds, `dark` otherwise. Priority: explicit `theme` prop >
 * DSH_TUI_THEME (built-in or user theme name) > persisted `/theme` choice >
 * OSC 11 detection. An invalid forced name is warned and skipped, so
 * detection still runs. Children render only after the theme settles, so
 * the first frame already carries the final palette — no dark→light flash.
 * Detection never blocks boot: a terminal that ignores OSC 11 (or a 400ms
 * stall) falls back to `dark`. The resolved name is mirrored via
 * setActiveThemeName() for non-React rendering (markdown inline code).
 *
 * The `auto` pseudo-theme turns that one-shot startup detection into a
 * standing choice: `auto` is valid everywhere a theme name is (DSH_TUI_THEME,
 * theme.json, /theme), defers first paint until detection settles like the
 * unforced path, and re-queries OSC 11 on every runtime switch to `auto` —
 * the detected base (light/dark) is mirrored via setAutoThemeBase() so
 * getTheme('auto') resolves it for every consumer. OSC 11 tracks the system
 * theme in terminals that follow it, so `auto` effectively follows the
 * system light/dark mode.
 *
 * The context also exposes setTheme() for the runtime `/theme` picker: it
 * validates the name, persists the choice to ~/.dsh-tui/theme.json and hot
 * swaps the palette (and the module-level mirror) immediately.
 */
// User themes (~/.dsh-tui/themes/<name>.json) resolve through this registry,
// so getTheme() serves them to every themed component and to non-React
// rendering (markdown inline code) without a context.
registerCustomThemeResolver(resolveCustomTheme);
const ThemeContext = createContext({
    theme: 'dark',
    autoBase: 'dark',
    setTheme: () => false,
});
/**
 * DSH_TUI_THEME skips terminal detection (tests, debugging). Accepts a
 * built-in name (auto|light|dark|dark-ansi) or a user theme name; invalid
 * values are warned and ignored by the caller, falling back to detection.
 */
function envThemeOverride() {
    const v = process.env.DSH_TUI_THEME;
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
        console.warn(`[dsh-tui] theme "${forced}" not found (built-ins: auto, light, dark, dark-ansi; user themes: ~/.dsh-tui/themes/*.json); falling back to auto-detection`);
        return false;
    });
    // `auto` (like the unforced path) stays null until detection settles, so
    // the first frame already carries the detected palette.
    const [active, setActive] = useState(forcedValid && forced !== AUTO_THEME_NAME ? forced ?? null : null);
    const { internal_querier, isRawModeSupported } = useStdin();
    /**
     * The palette `auto` resolves to, as React state so a flip re-renders
     * consumers through the context value. Kept in sync with the module-level
     * mirror in theme.ts (non-React rendering reads that one).
     */
    const [autoBase, setAutoBase] = useState(() => getAutoThemeBase());
    const applyAutoBase = React.useCallback((base) => {
        setAutoThemeBase(base);
        setAutoBase(base);
    }, []);
    useEffect(() => {
        if (forcedValid && forced !== AUTO_THEME_NAME)
            return;
        const querier = internal_querier;
        // Settle on the detected base: a concrete forced/unforced name activates
        // directly; `auto` records the base and activates as `auto`.
        const settle = (name, why) => {
            logForDebugging(`theme: ${name} (${why})`);
            if (forced === AUTO_THEME_NAME) {
                applyAutoBase(name);
                setActive(AUTO_THEME_NAME);
            }
            else {
                setActive(name);
            }
        };
        // Stdin responses only flow while raw mode holds the readable listener;
        // without a querier (or raw-mode support) detection is impossible.
        if (querier === null || !isRawModeSupported) {
            settle('dark', 'detection unavailable (no querier/raw mode)');
            return;
        }
        let settled = false;
        const finish = (name, why) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            settle(name, why);
        };
        const timer = setTimeout(() => {
            finish('dark', 'detection timeout');
        }, DETECT_TIMEOUT_MS);
        void Promise.all([querier.send(oscColor(11)), querier.flush()]).then(([r]) => {
            const color = r ? parseOscColor(r.data) : null;
            if (color === null || color.type !== 'rgb') {
                finish('dark', 'no OSC 11 reply');
            }
            else {
                finish(isLightBackground(color.r, color.g, color.b) ? 'light' : 'dark', `OSC 11 bg rgb(${color.r},${color.g},${color.b})`);
            }
        });
        return () => {
            settled = true;
            clearTimeout(timer);
        };
    }, []);
    /**
     * Re-query the terminal background while the app is running (runtime
     * switch to `auto`). Stdin is already in raw mode here — unlike the
     * startup path above — so no raw-mode toggling. Best effort: a terminal
     * that doesn't answer just keeps the current base.
     */
    const redetectAutoBase = React.useCallback(() => {
        const querier = internal_querier;
        if (querier === null || !isRawModeSupported) {
            logForDebugging('theme: auto re-detection unavailable, keeping current base');
            return;
        }
        void Promise.all([querier.send(oscColor(11)), querier.flush()]).then(([r]) => {
            const color = r ? parseOscColor(r.data) : null;
            if (color === null || color.type !== 'rgb')
                return;
            const base = isLightBackground(color.r, color.g, color.b) ? 'light' : 'dark';
            logForDebugging(`theme: auto base ${base} (OSC 11 bg rgb(${color.r},${color.g},${color.b}))`);
            applyAutoBase(base);
        });
    }, [internal_querier, isRawModeSupported, applyAutoBase]);
    /**
     * Runtime theme switch (/theme picker or direct command). Validates the
     * name, persists first (a choice that cannot be saved never silently
     * disappears), then hot swaps the palette. Switching to `auto` applies
     * the last detected base immediately and re-queries OSC 11 in the
     * background, so a theme change since launch is picked up.
     */
    const setTheme = React.useCallback((name) => {
        if (!isThemeAvailable(name)) {
            console.warn(`[dsh-tui] theme "${name}" not found`);
            return false;
        }
        if (!writeThemePref(name)) {
            console.warn('[dsh-tui] failed to write ~/.dsh-tui/theme.json');
            return false;
        }
        setActive(name);
        if (name === AUTO_THEME_NAME)
            redetectAutoBase();
        return true;
    }, [redetectAutoBase]);
    const value = React.useMemo(() => ({ theme: active ?? 'dark', autoBase, setTheme }), [active, autoBase, setTheme]);
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
