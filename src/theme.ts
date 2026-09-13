/**
 * dsh-tui color themes — Gentle Mist Blue (雾蓝) family.
 *
 * Two truecolor palettes share one identity: mist blues carry brand, focus,
 * and interaction; body text stays neutral. `light` uses white panel
 * surfaces (#FFFFFF) and ink text (#343945) for
 * light terminals; `dark` is its dark-terminal adaptation (warm off-white
 * text, accent-soft blues). `dark-ansi` is the 16-color fallback for
 * terminals without truecolor. The active palette is chosen at startup by
 * querying the terminal background (OSC 11) — see ThemeProvider.
 *
 * `auto` is a pseudo-theme, not a palette: it resolves to `light` or `dark`
 * from the terminal background detected via OSC 11 (which tracks the system
 * theme in terminals that follow it). ThemeProvider re-runs detection every
 * time `auto` is selected and pushes the result through setAutoThemeBase(),
 * so getTheme('auto') always serves the currently detected palette.
 */

export type Theme = {
  autoAccept: string
  bashBorder: string
  /** Primary brand/focus color. */
  accent: string
  toolNameMutate: string
  toolNameExec: string
  /** Primary brand/focus shimmer color. */
  accentShimmer: string
  /** Working activity indicator color. */
  activity: string
  /** Working activity indicator shimmer color. */
  activityShimmer: string
  permission: string
  permissionShimmer: string
  planMode: string
  ide: string
  promptBorder: string
  promptBorderShimmer: string
  text: string
  inverseText: string
  inactive: string
  inactiveShimmer: string
  subtle: string
  suggestion: string
  remember: string
  background: string
  // Semantic colors
  success: string
  error: string
  warning: string
  merged: string
  warningShimmer: string
  // Diff colors
  diffAdded: string
  diffRemoved: string
  diffAddedDimmed: string
  diffRemovedDimmed: string
  diffAddedWord: string
  diffRemovedWord: string
  // Tool card surfaces (two depth levels; the card itself takes the dim
  // shade, diff context rows the lighter one, changed rows the diff palette)
  toolCardBackground: string
  toolCardBackgroundDim: string
  // Tool status dots, by tool category (error always wins with a red ✗)
  toolDotExec: string
  toolDotRead: string
  toolDotWrite: string
  toolDotWeb: string
  toolDotTask: string
  // Diff syntax highlighting (user themes may override any of these)
  syntaxKeyword: string
  syntaxString: string
  syntaxComment: string
  syntaxNumber: string
  syntaxFunction: string
  syntaxType: string
  syntaxVariable: string
  syntaxOperator: string
  syntaxPunctuation: string
  syntaxConstant: string
  // Agent colors
  // Grove colors
  professionalBlue: string
  // Chrome colors
  chromeYellow: string
  // TUI V2 colors
  /** Mascot body color. */
  mascotBody: string
  /** Input/editor background color. */
  inputBackground: string
  userMessageBackground: string
  userMessageBackgroundHover: string
  messageActionsBackground: string
  selectionBg: string
  bashMessageBackgroundColor: string
  memoryBackgroundColor: string
  rate_limit_fill: string
  rate_limit_empty: string
  fastMode: string
  fastModeShimmer: string
  userPromptLabel: string
  // Subagent message colors
  subagentBullet: string
  subagentDescription: string
  subagentModel: string
  subagentElapsed: string
  subagentToolName: string
  subagentStatusRunning: string
  subagentStatusCompleted: string
  subagentStatusFailed: string
}

/**
 * Theme keys used by pre-semantic theme files and plugin descriptors.
 * Keep this input compatibility surface separate from the resolved Theme
 * contract: palettes exposed to consumers contain semantic keys only.
 */
export type DeprecatedThemeKey =
  | 'claude'
  | 'claudeShimmer'
  | 'claudeBlue_FOR_SYSTEM_SPINNER'
  | 'claudeBlueShimmer_FOR_SYSTEM_SPINNER'
  | 'clawd_body'
  | 'clawd_background'
  | 'briefLabelYou'

const RETIRED_THEME_KEYS = [
  "briefLabelClaude",
  "red_FOR_SUBAGENTS_ONLY",
  "blue_FOR_SUBAGENTS_ONLY",
  "green_FOR_SUBAGENTS_ONLY",
  "yellow_FOR_SUBAGENTS_ONLY",
  "purple_FOR_SUBAGENTS_ONLY",
  "orange_FOR_SUBAGENTS_ONLY",
  "pink_FOR_SUBAGENTS_ONLY",
  "cyan_FOR_SUBAGENTS_ONLY",
  "rainbow_red",
  "rainbow_red_shimmer",
  "rainbow_orange",
  "rainbow_orange_shimmer",
  "rainbow_yellow",
  "rainbow_yellow_shimmer",
  "rainbow_green",
  "rainbow_green_shimmer",
  "rainbow_blue",
  "rainbow_blue_shimmer",
  "rainbow_indigo",
  "rainbow_indigo_shimmer",
  "rainbow_violet",
  "rainbow_violet_shimmer"
] as const
export type RetiredThemeKey = (typeof RETIRED_THEME_KEYS)[number]
const retiredThemeKeys: ReadonlySet<string> = new Set(RETIRED_THEME_KEYS)

/** Obsolete, unused palette slots are accepted only at input boundaries. */
export function isRetiredThemeKey(value: string): value is RetiredThemeKey {
  return retiredThemeKeys.has(value)
}

export type ThemeColorKey = keyof Theme | DeprecatedThemeKey | RetiredThemeKey

export const DEPRECATED_THEME_KEY_ALIASES: Readonly<Record<DeprecatedThemeKey, keyof Theme>> = Object.freeze({
  claude: 'accent',
  claudeShimmer: 'accentShimmer',
  claudeBlue_FOR_SYSTEM_SPINNER: 'activity',
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'activityShimmer',
  clawd_body: 'mascotBody',
  clawd_background: 'inputBackground',
  briefLabelYou: 'userPromptLabel',
})

/** Convert a legacy persisted/plugin key to its semantic key. */
export function normalizeThemeKey(value: string): keyof Theme | undefined {
  if (Object.prototype.hasOwnProperty.call(DEPRECATED_THEME_KEY_ALIASES, value)) {
    return DEPRECATED_THEME_KEY_ALIASES[value as DeprecatedThemeKey]
  }
  return Object.prototype.hasOwnProperty.call(darkTheme, value)
    ? value as keyof Theme
    : undefined
}

/** Whether a key is accepted at a theme input boundary, including aliases. */
export function isThemeColorKey(value: unknown): value is ThemeColorKey {
  return typeof value === 'string' && normalizeThemeKey(value) !== undefined
}

/** The built-in theme names, in display order. */
export const THEME_NAMES = ['dark', 'dark-ansi', 'light'] as const

/**
 * The `auto` pseudo-theme: not a palette, but a standing request to follow
 * the terminal background (OSC 11, which tracks the system theme in
 * terminals that follow it). Selectable everywhere a theme name is
 * (/theme, DSH_TUI_THEME, ~/.dsh-tui/theme.json); getTheme() resolves it to
 * the last detected `light`/`dark` palette via the auto base below.
 */
export const AUTO_THEME_NAME = 'auto'

/**
 * The palette `auto` currently resolves to, mirrored module-level so
 * getTheme('auto') works for non-React rendering without a context.
 * ThemeProvider sets this on every detection (startup and runtime switch);
 * defaults to `dark` until the first detection settles (the pre-detection
 * status quo, biased dark for readability).
 */
let autoBase: 'light' | 'dark' = 'dark'

/**
 * Record the palette `auto` should resolve to. Called by ThemeProvider
 * after each terminal-background detection while `auto` is active.
 * @param name - The detected base palette.
 */
export function setAutoThemeBase(name: 'light' | 'dark'): void {
  autoBase = name
}

/** The palette `auto` currently resolves to (`light` or `dark`). */
export function getAutoThemeBase(): 'light' | 'dark' {
  return autoBase
}

/**
 * Any theme name: a built-in palette (`light`/`dark`/`dark-ansi`), a user
 * theme from ~/.dsh-tui/themes/<name>.json, or a host runtime contribution.
 * Always resolvable to a concrete color palette via getTheme() (unknown names
 * fall back to `dark`).
 */
export type ThemeName = string

const rgb = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`
}

/**
 * Gentle Mist Blue dark adaptation. The blues come straight from the card
 * (#27478C–#ABC2EC); neutrals are warm (derived from #F6F3ED/#343945) so
 * the palette reads calm rather than cyber-hard on a dark terminal.
 */
const darkTheme: Theme = {
  autoAccept: rgb('#B3A0D4'), // Soft violet
  bashBorder: rgb('#D194AE'), // Mist rose
  accent: rgb('#7DA1DE'), // Accent Soft — mist brand blue
  toolNameMutate: rgb('#E5C07B'), // soft gold — Edit/Write (warm accent)
  toolNameExec: rgb('#56B6C2'), // mist cyan — Bash/exec tools
  accentShimmer: rgb('#ABC2EC'), // Border Blue for shimmer effect
  activity: rgb('#7DA1DE'),
  activityShimmer: rgb('#ABC2EC'),
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
  toolCardBackground: rgb('#242B3A'), // lighter blue-grey card surface
  toolCardBackgroundDim: rgb('#1C2330'), // deeper blue substrate
  toolDotExec: rgb('#7FAE99'), // sage green — bash/pwsh
  toolDotRead: rgb('#82B8C7'), // cyan blue — read/grep/glob
  toolDotWrite: rgb('#B3A0D4'), // soft violet — edit/write
  toolDotWeb: rgb('#7DA1DE'), // mist blue — web search/fetch
  toolDotTask: rgb('#D194AE'), // mist rose — subagent/jobs
  syntaxKeyword: rgb('#78A0D6'), // muted anchor blue
  syntaxString: rgb('#79AD91'), // mist green, distinct without neon saturation
  syntaxComment: rgb('#74808D'), // neutral blue-grey
  syntaxNumber: rgb('#C89B70'), // softened warm amber
  syntaxFunction: rgb('#6FAEB5'), // muted cyan
  syntaxType: rgb('#A98FBF'), // softened violet
  syntaxVariable: rgb('#C9D1D9'), // near-text
  syntaxOperator: rgb('#93A1B0'), // blue grey
  syntaxPunctuation: rgb('#7A8694'), // dim blue grey
  syntaxConstant: rgb('#C98291'), // softened rose
  professionalBlue: rgb('#7DA1DE'),
  chromeYellow: rgb('#D8B270'),
  mascotBody: rgb('#D98A63'), // Warm mascot orange
  inputBackground: rgb('#000000'),
  userMessageBackground: '', // user turn: no fill, gold bold text only (Kimi style)
  userMessageBackgroundHover: rgb('#3B5BDB'), // hover/expand: blue block with gold text
  messageActionsBackground: rgb('#2E333D'),
  selectionBg: rgb('#3B4A66'), // Mist-blue tint on dark
  bashMessageBackgroundColor: rgb('#2C3038'),
  memoryBackgroundColor: rgb('#30353D'),
  rate_limit_fill: rgb('#7DA1DE'),
  rate_limit_empty: rgb('#3C414B'),
  fastMode: rgb('#E09A58'),
  fastModeShimmer: rgb('#EAB478'),
  userPromptLabel: rgb('#FFDF80'),
  subagentBullet: rgb('#D194AE'),
  subagentDescription: rgb('#E8E6E0'),
  subagentModel: rgb('#8D95A6'),
  subagentElapsed: rgb('#8D95A6'),
  subagentToolName: rgb('#7DA1DE'),
  subagentStatusRunning: rgb('#7DA1DE'),
  subagentStatusCompleted: rgb('#82B89D'),
  subagentStatusFailed: rgb('#DA8A93'),
}

/**
 * Gentle Mist Blue light theme — the strict original card. Blue carries
 * brand, focus, interaction, and highlight only; body text stays ink gray
 * on the warm off-white family (background #F6F3ED, surface #EEE5D2,
 * surface-alt #E4D9E5).
 */
const lightTheme: Theme = {
  autoAccept: rgb('#9B86B8'), // Muted violet (from surface-alt pink-mist)
  bashBorder: rgb('#C07A93'), // Muted rose (from surface-alt pink-mist)
  accent: rgb('#3F6CC4'), // Primary Blue — brand
  toolNameMutate: rgb('#8A6A00'), // deep gold - Edit/Write (warm accent)
  toolNameExec: rgb('#0F7A8A'), // deep cyan - Bash/exec tools
  accentShimmer: rgb('#5E88CC'), // Accent Blue for shimmer effect
  activity: rgb('#3F6CC4'),
  activityShimmer: rgb('#5E88CC'),
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
  toolCardBackground: rgb('#FFFFFF'), // neutral white panel surface
  toolCardBackgroundDim: rgb('#FFFFFF'), // white tool-card substrate
  toolDotExec: rgb('#4E7A4E'),
  toolDotRead: rgb('#3F7E8F'),
  toolDotWrite: rgb('#7A5CA8'),
  toolDotWeb: rgb('#4A63A8'),
  toolDotTask: rgb('#B04A5A'),
  syntaxKeyword: rgb('#3F68B5'), // clear primary blue without neon saturation
  syntaxString: rgb('#3F805F'), // readable muted green
  syntaxComment: rgb('#7D858F'), // neutral blue-grey
  syntaxNumber: rgb('#A7652B'), // warm amber accent
  syntaxFunction: rgb('#2E7E8A'), // muted cyan
  syntaxType: rgb('#7E55A4'), // softened violet
  syntaxVariable: rgb('#343945'),
  syntaxOperator: rgb('#5B6672'),
  syntaxPunctuation: rgb('#9AA0A8'),
  syntaxConstant: rgb('#A84472'), // muted rose accent
  professionalBlue: rgb('#5E88CC'),
  chromeYellow: rgb('#C99A3F'),
  mascotBody: rgb('#D98A63'), // Warm mascot orange
  inputBackground: rgb('#F6F3ED'),
  userMessageBackground: '', // user turn: no fill in light mode, gold text only
  userMessageBackgroundHover: rgb('#DCE4FB'), // subtle blue tint on hover/expand
  messageActionsBackground: rgb('#E4D9E5'),
  selectionBg: rgb('#D5DEF2'), // Mist-blue tint on warm white
  bashMessageBackgroundColor: rgb('#EAE1D3'),
  memoryBackgroundColor: rgb('#E4D9E5'),
  rate_limit_fill: rgb('#7DA1DE'),
  rate_limit_empty: rgb('#DDD5C7'),
  fastMode: rgb('#D98E4A'),
  fastModeShimmer: rgb('#E2A465'),
  userPromptLabel: rgb('#A67600'),
  subagentBullet: rgb('#C07A93'),
  subagentDescription: rgb('#343945'),
  subagentModel: rgb('#8991A0'),
  subagentElapsed: rgb('#8991A0'),
  subagentToolName: rgb('#3F6CC4'),
  subagentStatusRunning: rgb('#3F6CC4'),
  subagentStatusCompleted: rgb('#4E9675'),
  subagentStatusFailed: rgb('#C65D6B'),
}

/**
 * Dark ANSI theme using only the 16 standard ANSI colors, for terminals
 * without true color support.
 *
 * User themes (JSON files in ~/.dsh-tui/themes/) and host runtime themes
 * overlay one of these three bases — see customTheme.ts and the adapter seam.
 * `getTheme` resolves static themes through the resolver registered by
 * ThemeProvider, then consults the optional runtime resolver.
 */
const darkAnsiTheme: Theme = {
  autoAccept: 'ansi:magentaBright',
  bashBorder: 'ansi:magentaBright',
  accent: 'ansi:blueBright',
  toolNameMutate: 'ansi:yellowBright',
  toolNameExec: 'ansi:cyanBright',
  accentShimmer: 'ansi:cyanBright',
  activity: 'ansi:blueBright',
  activityShimmer: 'ansi:cyanBright',
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
  toolCardBackground: 'ansi:blackBright',
  toolCardBackgroundDim: 'ansi:black',
  toolDotExec: 'ansi:greenBright',
  toolDotRead: 'ansi:cyanBright',
  toolDotWrite: 'ansi:magentaBright',
  toolDotWeb: 'ansi:blueBright',
  toolDotTask: 'ansi:redBright',
  syntaxKeyword: 'ansi:blueBright',
  syntaxString: 'ansi:greenBright',
  syntaxComment: 'ansi:blackBright',
  syntaxNumber: 'ansi:yellowBright',
  syntaxFunction: 'ansi:cyanBright',
  syntaxType: 'ansi:magentaBright',
  syntaxVariable: 'ansi:white',
  syntaxOperator: 'ansi:white',
  syntaxPunctuation: 'ansi:blackBright',
  syntaxConstant: 'ansi:redBright',
  professionalBlue: 'ansi:blueBright',
  chromeYellow: 'ansi:yellowBright',
  mascotBody: 'ansi:yellowBright',
  inputBackground: 'ansi:black',
  userMessageBackground: '',
  userMessageBackgroundHover: 'ansi:blue',
  messageActionsBackground: 'ansi:blackBright',
  selectionBg: 'ansi:blue',
  bashMessageBackgroundColor: 'ansi:black',
  memoryBackgroundColor: 'ansi:blackBright',
  rate_limit_fill: 'ansi:yellow',
  rate_limit_empty: 'ansi:white',
  fastMode: 'ansi:redBright',
  fastModeShimmer: 'ansi:redBright',
  userPromptLabel: 'ansi:yellowBright',
  subagentBullet: 'ansi:magentaBright',
  subagentDescription: 'ansi:whiteBright',
  subagentModel: 'ansi:white',
  subagentElapsed: 'ansi:white',
  subagentToolName: 'ansi:cyanBright',
  subagentStatusRunning: 'ansi:blueBright',
  subagentStatusCompleted: 'ansi:greenBright',
  subagentStatusFailed: 'ansi:redBright',
}

interface NormalizedThemeCacheEntry {
  readonly signature: string
  readonly palette: Theme
}

const normalizedThemeCache = new WeakMap<object, NormalizedThemeCacheEntry>()

/** Include every own value so a mutable legacy resolver cannot serve stale data. */
function themeObjectSignature(raw: Record<string, unknown>): string {
  return Object.keys(raw)
    .sort()
    .map(key => `${key.length}:${key}=${typeof raw[key]}:${String(raw[key])}`)
    .join('|')
}

/**
 * Normalize a palette returned by an older resolver or plugin. Resolvers are
 * process-local extension points, so an already loaded plugin may still
 * return the pre-semantic keys after this package has been upgraded. Canonical
 * keys win when both forms are present; aliases are removed from the resolved
 * palette so every consumer sees one stable Theme shape.
 */
export function normalizeThemePalette(value: unknown): Theme | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const hasDeprecatedKey = (Object.keys(DEPRECATED_THEME_KEY_ALIASES) as DeprecatedThemeKey[])
    .some(key => Object.prototype.hasOwnProperty.call(raw, key))
  if (!hasDeprecatedKey && !Object.keys(raw).some(isRetiredThemeKey)) return value as Theme
  const signature = themeObjectSignature(raw)
  const cached = normalizedThemeCache.get(raw)
  if (cached?.signature === signature) return cached.palette
  const normalized = { ...raw }
  for (const key of RETIRED_THEME_KEYS) delete normalized[key]
  for (const [deprecated, canonical] of Object.entries(DEPRECATED_THEME_KEY_ALIASES) as [DeprecatedThemeKey, keyof Theme][]) {
    if (normalized[canonical] === undefined && typeof normalized[deprecated] === 'string') {
      normalized[canonical] = normalized[deprecated]
    }
    delete normalized[deprecated]
  }
  const palette = Object.freeze(normalized as Theme)
  normalizedThemeCache.set(raw, { signature, palette })
  return palette
}

/**
 * Resolve a theme name to its concrete color palette.
 * @param themeName - The theme to resolve (built-in, `auto`, or user theme
 *   name).
 * @returns The matching palette; `auto` resolves to the detected base
 *   (light/dark), unknown names fall back to `dark`.
 */
export function getTheme(themeName: ThemeName): Theme {
  switch (themeName) {
    case 'light':
      return lightTheme
    // `dark` is an explicit case (not the default): built-in bases must
    // resolve without touching the custom-theme resolver — parseCustomTheme
    // calls getTheme(base) while the resolver may still be indexing, and a
    // resolver round-trip there re-enters theme-file parsing recursively.
    case 'dark':
      return darkTheme
    case 'dark-ansi':
      return darkAnsiTheme
    case AUTO_THEME_NAME:
      return autoBase === 'light' ? lightTheme : darkTheme
    default: {
      // Static file themes keep precedence over runtime contributions. A
      // resolver that returns undefined declines the name and lets the next
      // layer try; both layers still fall back to the dark identity below.
      const custom = customThemeResolver?.(themeName)
      if (custom !== undefined) return normalizeThemePalette(custom) ?? darkTheme
      const runtime = runtimeThemeResolver?.(themeName)
      return normalizeThemePalette(runtime) ?? darkTheme
    }
  }
}

/** A resolver for a fully built palette. Undefined means “not mine”. */
export type ThemeResolver = (name: string) => Theme | undefined

/**
 * Resolver that maps a user theme name to a fully built palette (see
 * customTheme.ts). Wired by ThemeProvider at startup so non-React rendering
 * (markdown inline code) resolves user themes through getActiveTheme().
 */
let customThemeResolver: ThemeResolver | undefined

/** Runtime resolver registrations, newest host first; cleanup removes one token. */
interface RuntimeResolverRegistration {
  readonly token: object
  readonly resolver: ThemeResolver
}

const runtimeResolverRegistrations: RuntimeResolverRegistration[] = []
let runtimeThemeResolver: ThemeResolver | undefined

/**
 * Whether the active theme's RESOLVED palette renders on a light background.
 * Keyed off the resolved palette's IDENTITY for the built-ins (auto resolves
 * to the shared light/dark instance, so this covers auto-with-light-terminal
 * that theme-NAME comparisons miss) and off the ink-text luminance for
 * custom and runtime themes (light palettes pair with dark ink). The palette's
 * `background` field is a badge fill, not the terminal background — never a
 * lightness signal. Colour-pair variants (effort ignition hues) consume this.
 */
export function isLightThemeActive(themeName: ThemeName): boolean {
  const theme = getTheme(themeName)
  if (theme === lightTheme) return true
  if (theme === darkTheme || theme === darkAnsiTheme) return false
  // 自定义或运行时主题：按文本墨色亮度判定——浅底配深墨（ink）、深底配亮墨。
  // 调色板的 background 字段是徽标填充色而非终端背景，不能作判据。
  const ink = theme.text
  const rgb = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(ink)
  if (rgb === null) return false
  const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  return 0.299 * r + 0.587 * g + 0.114 * b < 140
}

/**
 * Register the custom-theme resolver. Called once by ThemeProvider; the
 * resolver must return `undefined` for names it does not know so getTheme
 * falls back to `dark`.
 * @param resolver - Resolves a user theme name to a built palette.
 */
export function registerCustomThemeResolver(resolver: ThemeResolver): void {
  customThemeResolver = resolver
}

/**
 * Register the host runtime resolver. The returned cleanup is generation-safe:
 * disposing an older registration cannot clear a resolver installed later;
 * nested registrations restore the previous live resolver when they leave.
 */
export function registerRuntimeThemeResolver(resolver: ThemeResolver): () => void {
  if (typeof resolver !== 'function') return () => {}
  const registration: RuntimeResolverRegistration = { token: {}, resolver }
  runtimeResolverRegistrations.push(registration)
  runtimeThemeResolver = resolver
  return () => {
    const index = runtimeResolverRegistrations.findIndex(item => item.token === registration.token)
    if (index === -1) return
    runtimeResolverRegistrations.splice(index, 1)
    const current = runtimeResolverRegistrations.at(-1)
    runtimeThemeResolver = current?.resolver
  }
}

/** Clear all runtime resolvers, primarily for isolated host teardown/tests. */
export function clearRuntimeThemeResolver(): void {
  runtimeResolverRegistrations.length = 0
  runtimeThemeResolver = undefined
}

/**
 * Whether a name resolves through the built-ins, static custom resolver, or
 * the optional runtime resolver. This deliberately remains separate from
 * customTheme.isThemeAvailable(), whose contract is static-file-only.
 */
export function isThemeAvailable(themeName: ThemeName): boolean {
  if (
    themeName === AUTO_THEME_NAME ||
    THEME_NAMES.includes(themeName as (typeof THEME_NAMES)[number])
  ) return true
  try {
    return customThemeResolver?.(themeName) !== undefined
      || runtimeThemeResolver?.(themeName) !== undefined
  } catch {
    return false
  }
}

/**
 * The theme chosen at startup, mirrored module-level so non-React rendering
 * (markdown inline code in terminal-utils/markdown.ts) can resolve palette colors
 * without a context. ThemeProvider sets this once detection settles.
 */
let activeThemeName: ThemeName = 'dark'

/**
 * Set the module-level active theme; ThemeProvider calls this once
 * background detection settles and on every runtime theme switch.
 * @param name - The theme to activate.
 */
export function setActiveThemeName(name: ThemeName): void {
  activeThemeName = name
}

/**
 * Resolve the currently active theme for non-React rendering.
 * @returns The palette of the module-level active theme.
 */
export function getActiveTheme(): Theme {
  return getTheme(activeThemeName)
}
