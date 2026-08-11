/**
 * cc-tui color themes — Gentle Mist Blue (雾蓝) family.
 *
 * Two truecolor palettes share one identity: mist blues carry brand, focus,
 * and interaction; body text stays neutral. `light` is the strict Gentle
 * Mist Blue card (warm off-white background #F6F3ED, ink text #343945) for
 * light terminals; `dark` is its dark-terminal adaptation (warm off-white
 * text, accent-soft blues). `dark-ansi` is the 16-color fallback for
 * terminals without truecolor. The active palette is chosen at startup by
 * querying the terminal background (OSC 11) — see ThemeProvider.
 */
export type Theme = {
    autoAccept: string;
    bashBorder: string;
    claude: string;
    claudeShimmer: string;
    claudeBlue_FOR_SYSTEM_SPINNER: string;
    claudeBlueShimmer_FOR_SYSTEM_SPINNER: string;
    permission: string;
    permissionShimmer: string;
    planMode: string;
    ide: string;
    promptBorder: string;
    promptBorderShimmer: string;
    text: string;
    inverseText: string;
    inactive: string;
    inactiveShimmer: string;
    subtle: string;
    suggestion: string;
    remember: string;
    background: string;
    success: string;
    error: string;
    warning: string;
    merged: string;
    warningShimmer: string;
    diffAdded: string;
    diffRemoved: string;
    diffAddedDimmed: string;
    diffRemovedDimmed: string;
    diffAddedWord: string;
    diffRemovedWord: string;
    red_FOR_SUBAGENTS_ONLY: string;
    blue_FOR_SUBAGENTS_ONLY: string;
    green_FOR_SUBAGENTS_ONLY: string;
    yellow_FOR_SUBAGENTS_ONLY: string;
    purple_FOR_SUBAGENTS_ONLY: string;
    orange_FOR_SUBAGENTS_ONLY: string;
    pink_FOR_SUBAGENTS_ONLY: string;
    cyan_FOR_SUBAGENTS_ONLY: string;
    professionalBlue: string;
    chromeYellow: string;
    clawd_body: string;
    clawd_background: string;
    userMessageBackground: string;
    userMessageBackgroundHover: string;
    messageActionsBackground: string;
    selectionBg: string;
    bashMessageBackgroundColor: string;
    memoryBackgroundColor: string;
    rate_limit_fill: string;
    rate_limit_empty: string;
    fastMode: string;
    fastModeShimmer: string;
    briefLabelYou: string;
    briefLabelClaude: string;
    rainbow_red: string;
    rainbow_orange: string;
    rainbow_yellow: string;
    rainbow_green: string;
    rainbow_blue: string;
    rainbow_indigo: string;
    rainbow_violet: string;
    rainbow_red_shimmer: string;
    rainbow_orange_shimmer: string;
    rainbow_yellow_shimmer: string;
    rainbow_green_shimmer: string;
    rainbow_blue_shimmer: string;
    rainbow_indigo_shimmer: string;
    rainbow_violet_shimmer: string;
};
/** The supported theme names, in display order. */
export declare const THEME_NAMES: readonly ["dark", "dark-ansi", "light"];
/** A renderable theme. Always resolvable to a concrete color palette. */
export type ThemeName = (typeof THEME_NAMES)[number];
/**
 * Resolve a theme name to its concrete color palette.
 * @param themeName - The theme to resolve.
 * @returns The matching palette; unknown names fall back to `dark`.
 */
export declare function getTheme(themeName: ThemeName): Theme;
/**
 * Set the module-level active theme; ThemeProvider calls this once
 * background detection settles.
 * @param name - The theme to activate.
 */
export declare function setActiveThemeName(name: ThemeName): void;
/**
 * Resolve the currently active theme for non-React rendering.
 * @returns The palette of the module-level active theme.
 */
export declare function getActiveTheme(): Theme;
//# sourceMappingURL=theme.d.ts.map