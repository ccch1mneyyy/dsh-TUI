/**
 * Claude Code theme, ported verbatim from the leaked source
 * (`src/utils/theme.ts`). Only the dark palettes are kept — the plugin is a
 * personal terminal tool and dark is the default everywhere it runs. The
 * `Theme` type is a structural copy so design-system components ported from
 * the leak (`ThemedText`, `ThemedBox`, `Spinner*`) keep compiling untouched.
 */
export const THEME_NAMES = ['dark', 'dark-ansi'];
/**
 * Dark theme using explicit RGB values to avoid inconsistencies from users'
 * custom terminal ANSI color definitions (verbatim from the leak).
 */
const darkTheme = {
    autoAccept: 'rgb(175,135,255)', // Electric violet
    bashBorder: 'rgb(253,93,177)', // Bright pink
    claude: 'rgb(77,107,254)', // DeepSeek blue (replaces Claude orange)
    claudeShimmer: 'rgb(120,146,255)', // Lighter DeepSeek blue for shimmer effect
    claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(147,165,255)', // Blue for system spinner
    claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(177,195,255)',
    permission: 'rgb(177,185,249)', // Light blue-purple
    permissionShimmer: 'rgb(207,215,255)',
    planMode: 'rgb(72,150,140)', // Muted sage green
    ide: 'rgb(71,130,200)', // Muted blue
    promptBorder: 'rgb(136,136,136)', // Medium gray
    promptBorderShimmer: 'rgb(166,166,166)',
    text: 'rgb(255,255,255)', // White
    inverseText: 'rgb(0,0,0)', // Black
    inactive: 'rgb(153,153,153)', // Light gray
    inactiveShimmer: 'rgb(193,193,193)',
    subtle: 'rgb(80,80,80)', // Dark gray
    suggestion: 'rgb(177,185,249)', // Light blue-purple
    remember: 'rgb(177,185,249)',
    background: 'rgb(0,204,204)', // Bright cyan
    success: 'rgb(78,186,101)', // Bright green
    error: 'rgb(255,107,128)', // Bright red
    warning: 'rgb(255,193,7)', // Bright amber
    merged: 'rgb(175,135,255)', // Electric violet (matches autoAccept)
    warningShimmer: 'rgb(255,223,57)',
    diffAdded: 'rgb(34,92,43)',
    diffRemoved: 'rgb(122,41,54)',
    diffAddedDimmed: 'rgb(71,88,74)',
    diffRemovedDimmed: 'rgb(105,72,77)',
    diffAddedWord: 'rgb(56,166,96)',
    diffRemovedWord: 'rgb(179,89,107)',
    red_FOR_SUBAGENTS_ONLY: 'rgb(220,38,38)',
    blue_FOR_SUBAGENTS_ONLY: 'rgb(37,99,235)',
    green_FOR_SUBAGENTS_ONLY: 'rgb(22,163,74)',
    yellow_FOR_SUBAGENTS_ONLY: 'rgb(202,138,4)',
    purple_FOR_SUBAGENTS_ONLY: 'rgb(147,51,234)',
    orange_FOR_SUBAGENTS_ONLY: 'rgb(234,88,12)',
    pink_FOR_SUBAGENTS_ONLY: 'rgb(219,39,119)',
    cyan_FOR_SUBAGENTS_ONLY: 'rgb(8,145,178)',
    professionalBlue: 'rgb(106,155,204)',
    chromeYellow: 'rgb(251,188,4)',
    clawd_body: 'rgb(215,119,87)',
    clawd_background: 'rgb(0,0,0)',
    userMessageBackground: 'rgb(55, 55, 55)',
    userMessageBackgroundHover: 'rgb(70, 70, 70)',
    messageActionsBackground: 'rgb(44, 50, 62)',
    selectionBg: 'rgb(38, 79, 120)',
    bashMessageBackgroundColor: 'rgb(65, 60, 65)',
    memoryBackgroundColor: 'rgb(55, 65, 70)',
    rate_limit_fill: 'rgb(177,185,249)',
    rate_limit_empty: 'rgb(80,83,112)',
    fastMode: 'rgb(255,120,20)',
    fastModeShimmer: 'rgb(255,165,70)',
    briefLabelYou: 'rgb(122,180,232)',
    briefLabelClaude: 'rgb(77,107,254)',
    rainbow_red: 'rgb(235,95,87)',
    rainbow_orange: 'rgb(245,139,87)',
    rainbow_yellow: 'rgb(250,195,95)',
    rainbow_green: 'rgb(145,200,130)',
    rainbow_blue: 'rgb(130,170,220)',
    rainbow_indigo: 'rgb(155,130,200)',
    rainbow_violet: 'rgb(200,130,180)',
    rainbow_red_shimmer: 'rgb(250,155,147)',
    rainbow_orange_shimmer: 'rgb(255,185,137)',
    rainbow_yellow_shimmer: 'rgb(255,225,155)',
    rainbow_green_shimmer: 'rgb(185,230,180)',
    rainbow_blue_shimmer: 'rgb(180,205,240)',
    rainbow_indigo_shimmer: 'rgb(195,180,230)',
    rainbow_violet_shimmer: 'rgb(230,180,210)',
};
/**
 * Dark ANSI theme using only the 16 standard ANSI colors, for terminals
 * without true color support (verbatim from the leak).
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
    professionalBlue: 'rgb(106,155,204)',
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
export function getTheme(themeName) {
    switch (themeName) {
        case 'dark-ansi':
            return darkAnsiTheme;
        default:
            return darkTheme;
    }
}
//# sourceMappingURL=theme.js.map