/**
 * 品牌档案：开屏与主题按当前后端展示；Codex 仅换标题，不换主题/宠物。
 *
 * 默认 `deepseek`（雾蓝 + `DEEPSEEK`/`HARNESS` + 鲸鱼/鲸鱼娘）；当会话绑在
 * Claude 后端（`backendCapabilities.backendId === 'claude'`，见
 * `backends/claude/`）时切到 `claude`（橙色 + `CLAUDE`/`CODE` + Claude 娘，
 * 立绘见 `assets/claude-girl/`）。启动页与对话页的主题跟着换：ThemeProvider
 * 在品牌未被显式锁定时把默认档替换成 `claude` 橙色主题（显式 `DSH_TUI_THEME`
 * / 会话内 `/theme` 手选永远优先）。
 *
 * 手动档：设置项 `dsh-tui.brand`（`auto` | `deepseek` | `claude`，默认
 * `auto` = 跟后端自动切，`/settings` 可实时改）。`DSH_TUI_BRAND` 环境变量
 * 优先级最高（预览/测试缝）。
 *
 * 后端在一个进程内不变（切内核 = 重启进程走 `kernel.json` 记忆），所以品牌
 * 实际上是 boot 时定死的；但读取仍走 `backendCapabilities`（在 ui-policy
 * 的 reactive 清单里），未来进程内热切也不用改这里。
 */

/** Codex only swaps the title; theme and mascot retain the default branches. */
export type Brand = 'deepseek' | 'claude' | 'codex'

// 设置值类型住在端口的显示偏好词汇表里（ports 目录不许 import 到目录外），
// 这里转出去：设置链（Config / channel / /settings 面板）只认这一个入口。
export type { BrandSetting } from './adapter/ports/channel-display.js'
import type { BrandSetting } from './adapter/ports/channel-display.js'

/** 设置项的合法值表（注册与归一化共用一份）。 */
export const BRAND_SETTING_VALUES: readonly BrandSetting[] = ['auto', 'deepseek', 'claude']

/**
 * 归一化不可信来源的设置值：合法值原样通过，其余（含未设置）回落 `auto`。
 */
export function normalizeBrandSetting(value: unknown): BrandSetting {
  return typeof value === 'string' && (BRAND_SETTING_VALUES as readonly string[]).includes(value)
    ? (value as BrandSetting)
    : 'auto'
}

/**
 * 后端 id → 品牌档：`claude` → claude；`codex` → 仅标题；`dsh`、未知与
 * `acp:*` 外部代理一律回落默认品牌（未来某代理想要自己的品牌再单加）。
 * @param backendId - `channel.backendCapabilities.backendId`。
 */
export function brandOfBackend(backendId: string | undefined): Brand {
  return backendId === 'claude' ? 'claude' : backendId === 'codex' ? 'codex' : 'deepseek'
}

/**
 * 合成当前品牌：`DSH_TUI_BRAND`（测试缝，最高）> 设置项显式锁定 > 后端自动。
 * @param setting - 归一化后的设置值（`auto` = 跟后端）。
 * @param backendId - 当前后端 id。
 */
export function resolveBrand(setting: BrandSetting | undefined, backendId: string | undefined): Brand {
  const forced = process.env.DSH_TUI_BRAND
  if (forced === 'claude' || forced === 'deepseek') return forced
  if (setting === 'claude' || setting === 'deepseek') return setting
  return brandOfBackend(backendId)
}

/** 一副开屏标题词：两行大字 + 窄终端纯文字档。 */
export interface BrandSplashWords {
  readonly top: string
  readonly bottom: string
  readonly plain: string
}

/** 各品牌的开屏标题词（大字重解字距见 `splashFonts.withTagline`）。 */
export const BRAND_SPLASH_WORDS: Readonly<Record<Brand, BrandSplashWords>> = Object.freeze({
  deepseek: Object.freeze({ top: 'DEEPSEEK', bottom: 'HARNESS', plain: 'DeepSeek Harness' }),
  claude: Object.freeze({ top: 'CLAUDE', bottom: 'CODE', plain: 'Claude Code' }),
  codex: Object.freeze({ top: 'CODEX', bottom: 'HARNESS', plain: 'Codex' }),
})

/** claude 品牌按终端深浅落的两套内置主题（theme.ts 注册：墨黑 / 暖纸张，
 *  共用同一套陶土橙强调色——切明暗不丢品牌识别）。 */
export const CLAUDE_BRAND_THEMES: Readonly<{ dark: 'claude-dark'; light: 'claude-paper' }> = Object.freeze({
  dark: 'claude-dark',
  light: 'claude-paper',
})

/** 开屏欢迎语（品牌档；deepseek 沿用 i18n 的 `logo-tagline`）。英文两行以
 *  `\n` 分隔，渲染层按行拆开居中。 */
export const BRAND_TAGLINE: Readonly<Record<Brand, { readonly zh: string; readonly en: string }>> = Object.freeze({
  deepseek: Object.freeze({ zh: '', en: '' }),
  codex: Object.freeze({ zh: '', en: '' }),
  claude: Object.freeze({ zh: '创造精彩，守护关键。', en: "Create what's exciting.\nMaintain what's essential." }),
})

/** `/settings` 里 `dsh-tui.brand` 的选项（结构与 `SPLASH_FONT_OPTIONS` 同形）。 */
export const BRAND_SETTING_OPTIONS: readonly {
  readonly value: BrandSetting
  readonly label: string
  readonly descriptions: { readonly zh: string }
}[] = [
  { value: 'auto', label: 'Follow backend (default)', descriptions: { zh: '跟随后端（默认）' } },
  { value: 'deepseek', label: 'DeepSeek (mist blue)', descriptions: { zh: 'DeepSeek（雾蓝）' } },
  { value: 'claude', label: 'Claude Code (orange)', descriptions: { zh: 'Claude Code（橙）' } },
]

// ── 品牌的运行时镜像（ThemeProvider 在 Chat 外层，拿不到 channel prop） ──────
// 与 theme.ts 的 autoBase 镜像同一思路：plugin 在首帧渲染前 `setActiveBrand`
// 铺好初值（避免蓝→橙闪一下），Chat 在品牌变化时跟进更新；
// ThemeProvider 用 useSyncExternalStore 订阅，切档即时生效。

let activeBrand: Brand = 'deepseek'
const brandListeners = new Set<() => void>()

/** 更新当前品牌（值不变时无操作）。 */
export function setActiveBrand(brand: Brand): void {
  if (brand === activeBrand) return
  activeBrand = brand
  for (const listener of brandListeners) listener()
}

/** 当前品牌（`setActiveBrand` 之前是默认档 `deepseek`）。 */
export function getActiveBrand(): Brand {
  return activeBrand
}

/** 订阅品牌变化（`useSyncExternalStore` 的订阅缝）。 */
export function subscribeActiveBrand(listener: () => void): () => void {
  brandListeners.add(listener)
  return () => {
    brandListeners.delete(listener)
  }
}
