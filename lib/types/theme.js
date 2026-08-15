/**
 * dsh-tui color themes — Gentle Mist Blue (雾蓝) family.
 *
 * Two truecolor palettes share one identity: mist blues carry brand, focus,
 * and interaction; body text stays neutral. `light` is the strict Gentle
 * Mist Blue card (warm off-white background #F6F3ED, ink text #343945) for
 * light terminals; `dark` is its dark-terminal adaptation (warm off-white
 * text, accent-soft blues). `dark-ansi` is the 16-color fallback for
 * terminals without truecolor. The active palette is chosen at startup by
 * querying the terminal background (OSC 11) — see ThemeProvider.
 */
/** The built-in theme names, in display order. */
export const THEME_NAMES = ['dark', 'dark-ansi', 'light'];
const rgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
};
/**
 * Gentle Mist Blue dark adaptation. The blues come straight from the card
 * (#27478C–#ABC2EC); neutrals are warm (derived from #F6F3ED/#343945) so
 * the palette reads calm rather than cyber-hard on a dark terminal.
 */
const darkTheme = {
    autoAccept: rgb('#B3A0D4'), // Soft violet
    bashBorder: rgb('#D194AE'), // Mist rose
    claude: rgb('#7DA1DE'), // Accent Soft — mist brand blue
    claudeShimmer: rgb('#ABC2EC'), // Border Blue for shimmer effect
    claudeBlue_FOR_SYSTEM_SPINNER: rgb('#7DA1DE'),
    claudeBlueShimmer_FOR_SYSTEM_SPINNER: rgb('#ABC2EC'),
    permission: rgb('#ABC2EC'), // Border Blue — pane/dialog accent
    permissionShimmer: rgb('#C9D7F2'),
    planMode: rgb('#7FAE99'), // Muted sage green
    ide: rgb('#5E88CC'), // Accent Blue
    promptBorder: rgb('#55606F'), // Muted blue-gray
    promptBorderShimmer: rgb('#7DA1DE'),
    text: rgb('#E8E6E0'), // Warm off-white (from #F6F3ED)
    inverseText: rgb('#22262E'), // Deep warm charcoal (from #343945)
    inactive: rgb('#8D95A6'), // Mist gray-blue — feeds dimColor
    inactiveShimmer: rgb('#AAB2C2'),
    subtle: rgb('#5E6673'), // Dimmer blue-gray
    suggestion: rgb('#ABC2EC'), // Border Blue — focus/selection
    remember: rgb('#ABC2EC'),
    background: rgb('#5E88CC'), // Accent Blue — badge fill
    success: rgb('#82B89D'), // Mist green (from #4E9675)
    error: rgb('#DA8A93'), // Soft rose
    warning: rgb('#D8B270'), // Soft amber
    merged: rgb('#B3A0D4'), // Soft violet (matches autoAccept)
    warningShimmer: rgb('#E4C78E'),
    diffAdded: rgb('#27392C'),
    diffRemoved: rgb('#3E2A2C'),
    diffAddedDimmed: rgb('#2B352C'),
    diffRemovedDimmed: rgb('#362B2C'),
    diffAddedWord: rgb('#57956B'),
    diffRemovedWord: rgb('#B26671'),
    red_FOR_SUBAGENTS_ONLY: rgb('#D4685E'),
    blue_FOR_SUBAGENTS_ONLY: rgb('#7496D6'),
    green_FOR_SUBAGENTS_ONLY: rgb('#66B285'),
    yellow_FOR_SUBAGENTS_ONLY: rgb('#D1A94E'),
    purple_FOR_SUBAGENTS_ONLY: rgb('#AC8CD2'),
    orange_FOR_SUBAGENTS_ONLY: rgb('#DB8C50'),
    pink_FOR_SUBAGENTS_ONLY: rgb('#D384A8'),
    cyan_FOR_SUBAGENTS_ONLY: rgb('#6FAFB4'),
    professionalBlue: rgb('#7DA1DE'),
    chromeYellow: rgb('#D8B270'),
    clawd_body: rgb('#D98A63'), // Warm mascot orange
    clawd_background: rgb('#000000'),
    userMessageBackground: rgb('#292D36'),
    userMessageBackgroundHover: rgb('#343945'),
    messageActionsBackground: rgb('#2E333D'),
    selectionBg: rgb('#3B4A66'), // Mist-blue tint on dark
    bashMessageBackgroundColor: rgb('#2C3038'),
    memoryBackgroundColor: rgb('#30353D'),
    rate_limit_fill: rgb('#7DA1DE'),
    rate_limit_empty: rgb('#3C414B'),
    fastMode: rgb('#E09A58'),
    fastModeShimmer: rgb('#EAB478'),
    briefLabelYou: rgb('#ABC2EC'),
    briefLabelClaude: rgb('#7DA1DE'),
    rainbow_red: rgb('#D98F8A'),
    rainbow_orange: rgb('#D9A97E'),
    rainbow_yellow: rgb('#D6BE78'),
    rainbow_green: rgb('#93BBA0'),
    rainbow_blue: rgb('#8FA9D6'),
    rainbow_indigo: rgb('#A89CD4'),
    rainbow_violet: rgb('#C29CC0'),
    rainbow_red_shimmer: rgb('#E4AAAA'),
    rainbow_orange_shimmer: rgb('#E4C09C'),
    rainbow_yellow_shimmer: rgb('#E2D29C'),
    rainbow_green_shimmer: rgb('#B0CEBA'),
    rainbow_blue_shimmer: rgb('#AFBFE2'),
    rainbow_indigo_shimmer: rgb('#BFB4DE'),
    rainbow_violet_shimmer: rgb('#D1B4D1'),
};
/**
 * Gentle Mist Blue light theme — the strict original card. Blue carries
 * brand, focus, interaction, and highlight only; body text stays ink gray
 * on the warm off-white family (background #F6F3ED, surface #EEE5D2,
 * surface-alt #E4D9E5).
 */
const lightTheme = {
    autoAccept: rgb('#9B86B8'), // Muted violet (from surface-alt pink-mist)
    bashBorder: rgb('#C07A93'), // Muted rose (from surface-alt pink-mist)
    claude: rgb('#3F6CC4'), // Primary Blue — brand
    claudeShimmer: rgb('#5E88CC'), // Accent Blue for shimmer effect
    claudeBlue_FOR_SYSTEM_SPINNER: rgb('#3F6CC4'),
    claudeBlueShimmer_FOR_SYSTEM_SPINNER: rgb('#5E88CC'),
    permission: rgb('#3F6CC4'), // Primary Blue — pane/dialog accent
    permissionShimmer: rgb('#5E88CC'),
    planMode: rgb('#4E9675'), // Sage green
    ide: rgb('#5E88CC'), // Accent Blue
    promptBorder: rgb('#ABC2EC'), // Border Blue
    promptBorderShimmer: rgb('#7DA1DE'), // Accent Soft
    text: rgb('#343945'), // Ink
    inverseText: rgb('#F6F3ED'), // Warm off-white (on colored fills)
    inactive: rgb('#8991A0'), // Text-muted — feeds dimColor
    inactiveShimmer: rgb('#626978'), // Text-secondary
    subtle: rgb('#A6ADBA'), // Lower contrast than inactive
    suggestion: rgb('#3F6CC4'), // Primary Blue — focus/selection
    remember: rgb('#27478C'), // Deep Outline — picker titles
    background: rgb('#3F6CC4'), // Primary Blue — badge fill
    success: rgb('#4E9675'),
    error: rgb('#C65D6B'), // Muted rose-red
    warning: rgb('#C08A3E'), // Muted amber
    merged: rgb('#9B86B8'), // Muted violet (matches autoAccept)
    warningShimmer: rgb('#D0A050'),
    diffAdded: rgb('#DCEBDD'),
    diffRemoved: rgb('#F2DEDE'),
    diffAddedDimmed: rgb('#E4EFE5'),
    diffRemovedDimmed: rgb('#F5E6E4'),
    diffAddedWord: rgb('#A9D3B4'),
    diffRemovedWord: rgb('#E5B3AE'),
    red_FOR_SUBAGENTS_ONLY: rgb('#BE5A52'),
    blue_FOR_SUBAGENTS_ONLY: rgb('#3F6CC4'),
    green_FOR_SUBAGENTS_ONLY: rgb('#4E9675'),
    yellow_FOR_SUBAGENTS_ONLY: rgb('#B98A34'),
    purple_FOR_SUBAGENTS_ONLY: rgb('#9678B4'),
    orange_FOR_SUBAGENTS_ONLY: rgb('#C97F4A'),
    pink_FOR_SUBAGENTS_ONLY: rgb('#C06E97'),
    cyan_FOR_SUBAGENTS_ONLY: rgb('#5698A0'),
    professionalBlue: rgb('#5E88CC'),
    chromeYellow: rgb('#C99A3F'),
    clawd_body: rgb('#D98A63'), // Warm mascot orange
    clawd_background: rgb('#F6F3ED'),
    userMessageBackground: rgb('#EEE5D2'), // Surface
    userMessageBackgroundHover: rgb('#E4D9E5'), // Surface Alt
    messageActionsBackground: rgb('#E4D9E5'),
    selectionBg: rgb('#D5DEF2'), // Mist-blue tint on warm white
    bashMessageBackgroundColor: rgb('#EAE1D3'),
    memoryBackgroundColor: rgb('#E4D9E5'),
    rate_limit_fill: rgb('#7DA1DE'),
    rate_limit_empty: rgb('#DDD5C7'),
    fastMode: rgb('#D98E4A'),
    fastModeShimmer: rgb('#E2A465'),
    briefLabelYou: rgb('#5E88CC'),
    briefLabelClaude: rgb('#3F6CC4'),
    rainbow_red: rgb('#D98888'),
    rainbow_orange: rgb('#D9A276'),
    rainbow_yellow: rgb('#CEB264'),
    rainbow_green: rgb('#8AB392'),
    rainbow_blue: rgb('#87A3D3'),
    rainbow_indigo: rgb('#9C92C8'),
    rainbow_violet: rgb('#BB92B8'),
    rainbow_red_shimmer: rgb('#E4A6A6'),
    rainbow_orange_shimmer: rgb('#E4BB96'),
    rainbow_yellow_shimmer: rgb('#DEC988'),
    rainbow_green_shimmer: rgb('#A9C8AF'),
    rainbow_blue_shimmer: rgb('#A9BCE0'),
    rainbow_indigo_shimmer: rgb('#B7AFD8'),
    rainbow_violet_shimmer: rgb('#CFB0CC'),
};
/**
 * Dark ANSI theme using only the 16 standard ANSI colors, for terminals
 * without true color support (verbatim from the leak).
 *
 * User themes (JSON files in ~/.dsh-tui/themes/) overlay one of these three
 * bases — see customTheme.ts. `getTheme` resolves them through a resolver
 * registered by ThemeProvider.
 */
const darkAnsiTheme = {
    autoAccept: 'ansi:magentaBright',
    bashBorder: 'ansi:magentaBright',
    claude: 'ansi:blueBright',
    claudeShimmer: 'ansi:blueBright',
    claudeBlue_FOR_SYSTEM_SPINNER: 'ansi:blueBright',
    claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'ansi:blueBright',
    permission: 'ansi:blueBright',
    permissionShimmer: 'ansi:blueBright',
    planMode: 'ansi:cyanBright',
    ide: 'ansi:blue',
    promptBorder: 'ansi:white',
    promptBorderShimmer: 'ansi:whiteBright',
    text: 'ansi:whiteBright',
    inverseText: 'ansi:black',
    inactive: 'ansi:white',
    inactiveShimmer: 'ansi:whiteBright',
    subtle: 'ansi:white',
    suggestion: 'ansi:blueBright',
    remember: 'ansi:blueBright',
    background: 'ansi:cyanBright',
    success: 'ansi:greenBright',
    error: 'ansi:redBright',
    warning: 'ansi:yellowBright',
    merged: 'ansi:magentaBright',
    warningShimmer: 'ansi:yellowBright',
    diffAdded: 'ansi:green',
    diffRemoved: 'ansi:red',
    diffAddedDimmed: 'ansi:green',
    diffRemovedDimmed: 'ansi:red',
    diffAddedWord: 'ansi:greenBright',
    diffRemovedWord: 'ansi:redBright',
    red_FOR_SUBAGENTS_ONLY: 'ansi:redBright',
    blue_FOR_SUBAGENTS_ONLY: 'ansi:blueBright',
    green_FOR_SUBAGENTS_ONLY: 'ansi:greenBright',
    yellow_FOR_SUBAGENTS_ONLY: 'ansi:yellowBright',
    purple_FOR_SUBAGENTS_ONLY: 'ansi:magentaBright',
    orange_FOR_SUBAGENTS_ONLY: 'ansi:redBright',
    pink_FOR_SUBAGENTS_ONLY: 'ansi:magentaBright',
    cyan_FOR_SUBAGENTS_ONLY: 'ansi:cyanBright',
    professionalBlue: 'ansi:blueBright',
    chromeYellow: 'ansi:yellowBright',
    clawd_body: 'ansi:redBright',
    clawd_background: 'ansi:black',
    userMessageBackground: 'ansi:blackBright',
    userMessageBackgroundHover: 'ansi:white',
    messageActionsBackground: 'ansi:blackBright',
    selectionBg: 'ansi:blue',
    bashMessageBackgroundColor: 'ansi:black',
    memoryBackgroundColor: 'ansi:blackBright',
    rate_limit_fill: 'ansi:yellow',
    rate_limit_empty: 'ansi:white',
    fastMode: 'ansi:redBright',
    fastModeShimmer: 'ansi:redBright',
    briefLabelYou: 'ansi:blueBright',
    briefLabelClaude: 'ansi:blueBright',
    rainbow_red: 'ansi:red',
    rainbow_orange: 'ansi:redBright',
    rainbow_yellow: 'ansi:yellow',
    rainbow_green: 'ansi:green',
    rainbow_blue: 'ansi:cyan',
    rainbow_indigo: 'ansi:blue',
    rainbow_violet: 'ansi:magenta',
    rainbow_red_shimmer: 'ansi:redBright',
    rainbow_orange_shimmer: 'ansi:yellow',
    rainbow_yellow_shimmer: 'ansi:yellowBright',
    rainbow_green_shimmer: 'ansi:greenBright',
    rainbow_blue_shimmer: 'ansi:cyanBright',
    rainbow_indigo_shimmer: 'ansi:blueBright',
    rainbow_violet_shimmer: 'ansi:magentaBright',
};
/**
 * Resolve a theme name to its concrete color palette.
 * @param themeName - The theme to resolve (built-in or user theme name).
 * @returns The matching palette; unknown names fall back to `dark`.
 */
export function getTheme(themeName) {
    switch (themeName) {
        case 'light':
            return lightTheme;
        case 'dark-ansi':
            return darkAnsiTheme;
        default:
            return customThemeResolver?.(themeName) ?? darkTheme;
    }
}
/**
 * Resolver that maps a user theme name to a fully built palette (see
 * customTheme.ts). Wired by ThemeProvider at startup so non-React rendering
 * (markdown inline code) resolves user themes through getActiveTheme().
 */
let customThemeResolver;
/**
 * Register the custom-theme resolver. Called once by ThemeProvider; the
 * resolver must return `undefined` for names it does not know so getTheme
 * falls back to `dark`.
 * @param resolver - Resolves a user theme name to a built palette.
 */
export function registerCustomThemeResolver(resolver) {
    customThemeResolver = resolver;
}
/**
 * The theme chosen at startup, mirrored module-level so non-React rendering
 * (markdown inline code in cc/markdown.ts) can resolve palette colors
 * without a context. ThemeProvider sets this once detection settles.
 */
let activeThemeName = 'dark';
/**
 * Set the module-level active theme; ThemeProvider calls this once
 * background detection settles and on every runtime theme switch.
 * @param name - The theme to activate.
 */
export function setActiveThemeName(name) {
    activeThemeName = name;
}
/**
 * Resolve the currently active theme for non-React rendering.
 * @returns The palette of the module-level active theme.
 */
export function getActiveTheme() {
    return getTheme(activeThemeName);
}
