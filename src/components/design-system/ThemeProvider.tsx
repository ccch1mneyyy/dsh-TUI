import React, { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import {
  getTheme,
  isThemeAvailable,
  isLightThemeActive,
  registerCustomThemeResolver,
  setActiveThemeName,
  setAutoThemeBase,
  getAutoThemeBase,
  AUTO_THEME_NAME,
  THEME_NAMES,
} from '../../theme.js'
import { brandThemeFor, getActiveBrand, subscribeActiveBrand } from '../../branding.js'
import instances from '../../ink/instances.js'
import { resolveCustomTheme } from '../../customTheme.js'
import type { TuiThemeHost } from '../../dsh-adapter/themes.js'
import { useRuntimeThemeSnapshot } from '../../hooks/useRuntimeThemeSnapshot.js'
import { readThemePref, writeThemePref } from '../../themePrefs.js'
import useStdin from '../../ink/hooks/use-stdin.js'
import useApp from '../../ink/hooks/use-app.js'
import { oscColor } from '../../ink/terminal-querier.js'
import { parseOscColor } from '../../ink/termio/osc.js'
import { logForDebugging } from '../../utils/debug.js'

/**
 * Theme provider with terminal-background auto-detection. With no explicit
 * `theme` prop, no DSH_TUI_THEME override and no persisted choice
 * (~/.dsh-tui/theme.json), it queries the terminal's background color
 * (OSC 11) before first paint and picks the Gentle Mist Blue `light` palette
 * on light backgrounds, `dark` otherwise. Priority: explicit `theme` prop >
 * DSH_TUI_THEME (built-in, static, or runtime plugin name) > persisted `/theme`
 * choice > OSC 11 detection. An invalid forced name is warned and skipped, so
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
 * validates static or plugin names, persists the choice to ~/.dsh-tui/theme.json
 * and hot swaps the palette (and the module-level mirror) immediately. A
 * disappearing plugin theme falls back safely without erasing the request.
 */

// Static user themes (~/.dsh-tui/themes/<name>.json) resolve through this
// registry; the optional runtime host resolver is installed by the Cordis
// service. Together they serve every themed component and non-React rendering.
registerCustomThemeResolver(resolveCustomTheme)

type ThemeContextValue = {
  /** The active theme name: a built-in, static JSON, or runtime plugin theme. */
  theme: string
  /**
   * The palette `auto` currently resolves to. Part of the context value so
   * a detected-base flip re-renders consumers even though the theme name
   * stays `auto` (they re-resolve the palette via getTheme(theme)).
   */
  autoBase: 'light' | 'dark'
  /**
   * Switch themes at runtime. Persists to ~/.dsh-tui/theme.json and hot
   * swaps the palette; false when the name is unknown or cannot persist.
   */
  setTheme: (name: string) => boolean
  /**
   * The colour the terminal actually shows behind the UI, as `#rrggbb`:
   * the OSC 11 answer when the terminal gave one, else white/black by the
   * rendered palette's lightness. Terminal-image placements need it as
   * their opaque backing (Sixel has no alpha — transparent pixels must
   * composite onto something), and it is the same target the backdrop
   * shade fades toward.
   */
  terminalBackground: `#${string}`
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  autoBase: 'dark',
  setTheme: () => false,
  terminalBackground: '#000000',
})

/**
 * DSH_TUI_THEME skips terminal detection (tests, debugging). Accepts a
 * built-in, static JSON, or runtime plugin theme name; invalid
 * values are warned and ignored by the caller, falling back to detection.
 * Exported for /reload, which must respect the env override's precedence.
 */
export function envThemeOverride(): string | undefined {
  const v = process.env.DSH_TUI_THEME
  return v === undefined || v === '' ? undefined : v
}

/** Detection round-trip is normally ~10ms locally; this only bounds pathological stalls. */
const DETECT_TIMEOUT_MS = 400

/**
 * sRGB luma (Rec. 601). The threshold biases dark: a light palette on a
 * dark terminal is far less readable than the reverse, and the dark
 * palette is the pre-detection status quo.
 */
function isLightBackground(r: number, g: number, b: number): boolean {
  return 0.299 * r + 0.587 * g + 0.114 * b > 140
}

export function ThemeProvider({
  children,
  theme,
  themeHost,
}: {
  children: React.ReactNode
  theme?: string
  /** Optional runtime theme host; absent in headless/static embeds. */
  themeHost?: TuiThemeHost
}): React.ReactNode {
  const runtimeThemeSnapshot = useRuntimeThemeSnapshot(themeHost)
  // Resolution happens once on mount: the forced chain (prop > env >
  // persisted) or null, which arms OSC 11 detection.
  const [forced] = useState<string | undefined>(() =>
    theme ?? envThemeOverride() ?? readThemePref(),
  )
  const [forcedValid] = useState<boolean>(() => {
    if (forced === undefined) return false
    if (isThemeAvailable(forced)) return true
    console.warn(
      `[dsh-tui] theme "${forced}" not found (built-ins: ${AUTO_THEME_NAME}, ${THEME_NAMES.join(', ')}; static ~/.dsh-tui/themes/*.json; runtime plugin themes); falling back to auto-detection`,
    )
    return false
  })
  // `auto` (like the unforced path) stays null until detection settles, so
  // the first frame already carries the detected palette.
  const [active, setActive] = useState<string | null>(
    forcedValid && forced !== AUTO_THEME_NAME ? forced ?? null : null,
  )
  // Keep the user's requested name independent from the rendered fallback. If
  // a plugin theme disappears, this lets a later registration restore it while
  // the persisted preference remains untouched.
  const requestedThemeRef = React.useRef<string | undefined>(forced)
  const { internal_querier, isRawModeSupported } = useStdin()
  const { stdout } = useApp()
  /**
   * The terminal background OSC 11 reported, if any. It is the colour a
   * backdrop shade fades explicit colours toward (see StylePool.withDim);
   * without it the shade falls back to black/white by theme lightness.
   */
  const [detectedBackground, setDetectedBackground] = useState<
    { r: number; g: number; b: number } | null
  >(null)

  /**
   * The palette `auto` resolves to, as React state so a flip re-renders
   * consumers through the context value. Kept in sync with the module-level
   * mirror in theme.ts (non-React rendering reads that one).
   */
  const [autoBase, setAutoBase] = useState<'light' | 'dark'>(() => getAutoThemeBase())
  const applyAutoBase = React.useCallback((base: 'light' | 'dark'): void => {
    setAutoThemeBase(base)
    setAutoBase(base)
  }, [])

  useEffect(() => {
    if (forcedValid && forced !== AUTO_THEME_NAME) return
    const querier = internal_querier
    // Settle on the detected base: a concrete forced/unforced name activates
    // directly; `auto` records the base and activates as `auto`.
    const settle = (name: 'light' | 'dark', why: string): void => {
      logForDebugging(`theme: ${name} (${why})`)
      const requested = requestedThemeRef.current
      if (forced !== AUTO_THEME_NAME && requested !== undefined && isThemeAvailable(requested)) {
        setActive(requested)
      } else if (forced === AUTO_THEME_NAME) {
        applyAutoBase(name)
        setActive(AUTO_THEME_NAME)
      } else {
        setActive(name)
      }
    }
    // Stdin responses only flow while raw mode holds the readable listener;
    // without a querier (or raw-mode support) detection is impossible.
    if (querier === null || !isRawModeSupported) {
      settle('dark', 'detection unavailable (no querier/raw mode)')
      return
    }
    let settled = false
    const finish = (name: 'light' | 'dark', why: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      settle(name, why)
    }
    const timer = setTimeout(() => {
      finish('dark', 'detection timeout')
    }, DETECT_TIMEOUT_MS)
    void Promise.all([querier.send(oscColor(11)), querier.flush()]).then(([r]) => {
      const color = r ? parseOscColor(r.data) : null
      if (color === null || color.type !== 'rgb') {
        finish('dark', 'no OSC 11 reply')
      } else {
        setDetectedBackground({ r: color.r, g: color.g, b: color.b })
        finish(
          isLightBackground(color.r, color.g, color.b) ? 'light' : 'dark',
          `OSC 11 bg rgb(${color.r},${color.g},${color.b})`,
        )
      }
    })
    return () => {
      settled = true
      clearTimeout(timer)
    }
  }, [])

  /**
   * Re-query the terminal background while the app is running (runtime
   * switch to `auto`). Stdin is already in raw mode here — unlike the
   * startup path above — so no raw-mode toggling. Best effort: a terminal
   * that doesn't answer just keeps the current base.
   */
  const redetectAutoBase = React.useCallback((): void => {
    const querier = internal_querier
    if (querier === null || !isRawModeSupported) {
      logForDebugging('theme: auto re-detection unavailable, keeping current base')
      return
    }
    void Promise.all([querier.send(oscColor(11)), querier.flush()]).then(([r]) => {
      const color = r ? parseOscColor(r.data) : null
      if (color === null || color.type !== 'rgb') return
      setDetectedBackground({ r: color.r, g: color.g, b: color.b })
      const base = isLightBackground(color.r, color.g, color.b) ? 'light' : 'dark'
      logForDebugging(`theme: auto base ${base} (OSC 11 bg rgb(${color.r},${color.g},${color.b}))`)
      applyAutoBase(base)
    })
  }, [internal_querier, isRawModeSupported, applyAutoBase])

  /**
   * Runtime theme switch (/theme picker or direct command). Validates the
   * name, persists first (a choice that cannot be saved never silently
   * disappears), then hot swaps the palette. Switching to `auto` applies
   * the last detected base immediately and re-queries OSC 11 in the
   * background, so a theme change since launch is picked up.
   */
  const setTheme = React.useCallback(
    (name: string): boolean => {
      if (!isThemeAvailable(name)) {
        console.warn(`[dsh-tui] theme "${name}" not found`)
        return false
      }
      if (!writeThemePref(name)) {
        console.warn('[dsh-tui] failed to write ~/.dsh-tui/theme.json')
        return false
      }
      requestedThemeRef.current = name
      // /theme 手选是明确意愿：品牌默认档从此让位（见 renderedTheme 的锁定判定）。
      brandThemeLockRef.current = true
      setActive(name)
      if (name === AUTO_THEME_NAME) redetectAutoBase()
      return true
    },
    [redetectAutoBase],
  )

  useEffect(() => {
    if (active !== null && !isThemeAvailable(active)) {
      // A runtime plugin can disappear while its name remains persisted. Do
      // not render getTheme(name)'s dark fallback under the stale name; keep
      // the requested name in the ref and use a safe auto palette instead.
      setActive(AUTO_THEME_NAME)
      redetectAutoBase()
      return
    }
    const requested = requestedThemeRef.current
    if (
      requested !== undefined &&
      requested !== AUTO_THEME_NAME &&
      requested !== active &&
      isThemeAvailable(requested)
    ) {
      // The plugin theme was unavailable during boot (or briefly unloaded),
      // but has registered again. Restore the persisted/requested choice.
      setActive(requested)
    }
  }, [active, redetectAutoBase, runtimeThemeSnapshot])

  // ── 品牌默认档（branding.ts）───────────────────────────────────────────
  // Claude 后端（claude 品牌）时把默认主题档替换成 Claude 双主题（claude-dark
  // / claude-paper，按解析档深浅自动落位）——启动页
  // 与对话页跟着后端整体换色。锁定判定（用户表达过明确意愿时不覆盖）：
  // - 显式 `theme` prop / `DSH_TUI_THEME`：锁；
  // - 会话内 `/theme` 手选：锁（setTheme 置位）；
  // - 启动时读到的 `~/.dsh-tui/theme.json` 持久化偏好：**不锁**——那是切换
  //   品档联动之前的历史选择，压住「选了后端整个主题就变」的联动就再也
  //   切不过去；想固定外观走 `/theme` 重选或设置项 `dsh-tui.brand`。
  // 品牌经 useSyncExternalStore 订阅：`/settings` 切品牌 → Chat 调
  // setActiveBrand → 这里即时换档，不重挂组件。
  const brand = useSyncExternalStore(subscribeActiveBrand, getActiveBrand)
  const brandThemeLockRef = React.useRef<boolean>(theme !== undefined || envThemeOverride() !== undefined)
  const renderedTheme = (() => {
    const resolved = active === null
      ? 'dark'
      : isThemeAvailable(active)
        ? active
        : AUTO_THEME_NAME
    if (brandThemeLockRef.current) return resolved
    // 品牌双主题按**解析后色板**的深浅落位：浅色（含 `pink-day` 这类浅底内置名、
    // 浅色自定义主题，以及浅色终端下的 `auto`）→ 浅色版，深色 → 深色版——两套
    // 共用同一强调色，切明暗不丢品牌识别（claude 陶土橙、codex 薰衣草紫）。
    return brandThemeFor(brand, resolved) ?? resolved
  })()
  // 模块级镜像必须**在渲染期**写入（不是 effect）：markdown 把主题色烤进
  // ANSI 字符串（链接 accent、行内代码 permission…），而它正是被这次 context
  // 更新触发重渲染的——放进 effect 会让它读到上一帧的主题名，于是换主题后
  // 链接颜色要等重启才更新。镜像只服务非 React 渲染（markdown/hyperlink）。
  // 当前色板的**身份**：运行时主题在同一批里释放并重注册时名字不变，但 resolver
  // 已经换了一个新色板对象（themes.ts 每次注册都新建并冻结）。context value 必须
  // 跟着它换，否则消费者（含按色板身份 memo 的 Markdown）完全不重渲染，屏幕停在
  // 旧色——切走再切回才刷新。放进 value 依赖即可：内置/静态主题的身份稳定，
  // 不会因此多渲染。
  const renderedPalette = getTheme(renderedTheme)
  setActiveThemeName(renderedTheme)
  const value = React.useMemo(
    () => ({
      theme: renderedTheme,
      autoBase,
      setTheme,
      // 与下面 setShadeTarget 用同一个口径（OSC 11 的回答，缺失时按明暗取
      // 白/黑）——terminal 图像的不透明衬底就合成到这个颜色上。
      // 只在与主题明暗**一致**时才采信 OSC 11 的回答：透明背景/背景图形态
      // 的终端会报一个跟画面对不上的颜色，那时宁可用纯白（浅色主题）或
      // 纯黑（深色主题）——深色终端上糊一块白底最突兀。
      terminalBackground: hexRgb(imageBackingColor(detectedBackground, renderedTheme)),
    }),
    [renderedTheme, renderedPalette, autoBase, setTheme, detectedBackground],
  )
  // Backdrop shade target: the detected terminal background when OSC 11
  // answered, else black/white by the rendered theme's lightness. `autoBase`
  // is a dependency because `auto` resolves through it.
  useEffect(() => {
    if (active === null) return
    const ink = instances.get(stdout)
    if (ink === undefined) return
    ink.setShadeTarget(
      detectedBackground
        ?? (isLightThemeActive(renderedTheme) ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 }),
    )
  }, [active, renderedTheme, autoBase, detectedBackground, stdout])

  if (active === null) return null
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/**
 * Resolves the active theme name and the runtime setter. Returns
 * `[themeName, setTheme]`.
 */
export function useTheme(): [string, (name: string) => boolean] {
  const { theme, setTheme } = useContext(ThemeContext)
  return [theme, setTheme]
}

/** `{r,g,b}` → `#rrggbb` for colour strings the style layer accepts. */
function hexRgb(color: { r: number; g: number; b: number }): `#${string}` {
  const part = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`
}

/**
 * The opaque colour terminal images composite onto: the OSC 11 answer while
 * it agrees with the rendered palette's lightness, else pure white (light
 * palette) / pure black (dark palette). A light terminal must never get a
 * dark slab, and a dark terminal must never get a white one.
 */
function imageBackingColor(
  detected: { r: number; g: number; b: number } | null,
  themeName: string,
): { r: number; g: number; b: number } {
  const light = isLightThemeActive(themeName)
  const fallback = light ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 }
  if (detected === null) return fallback
  // Rec. 601 luma: > 0.5 counts as a light background.
  const luma = (0.299 * detected.r + 0.587 * detected.g + 0.114 * detected.b) / 255
  return (luma > 0.5) === light ? detected : fallback
}

/**
 * The colour the terminal shows behind the UI (`#rrggbb`): the OSC 11
 * answer when available, else white/black by palette lightness. Terminal
 * image placements use it as their opaque Sixel backing.
 */
export function useTerminalBackground(): `#${string}` {
  return useContext(ThemeContext).terminalBackground
}
