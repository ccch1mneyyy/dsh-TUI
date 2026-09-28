/**
 * 开屏的两个彩蛋——都只改**文字**，字体轮换、鲸鱼动画、窄终端阶梯一律照旧：
 *
 * ① 节日换词：本地日期命中整天窗口时，把下排词换成 `HAPPINESS` / `MERRY` /
 *    `NEW YEAR`（上排仍是 `DEEPSEEK`）。字距由 `withTagline` 按新词重解，
 *    所以换词不会把两行搞成不等宽。
 * ② 小概率求 star：每次 mount 掷一次（默认 1/20），命中就把底部欢迎语换成
 *    一句带仓库链接的话。链接走 `createHyperlink`，不支持 OSC 8 的终端自动
 *    退化成纯文本 URL；命中概率与终端能力都是可注入的测试缝。
 */

import { t } from '../i18n.js'
import { stringWidth } from '../ink/stringWidth.js'
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js'
import { createHyperlink } from '../terminal-utils/hyperlink.js'
import type { UsageStats } from '../usageStats.js'

/** 一个节日彩蛋：当天要用的上下两排词。 */
export interface SplashEgg {
  /** 稳定 id（回归按 id 命中）。 */
  readonly id: string
  /** 上排词。 */
  readonly top: string
  /** 下排词。 */
  readonly bottom: string
}

/** 上排词固定是品牌名；彩蛋换的是下排。 */
const EGG_TOP = 'DEEPSEEK'

interface DatedEgg extends SplashEgg {
  /** 本地日期：月（1-12）。 */
  readonly month: number
  /** 本地日期：日。 */
  readonly day: number
}

/**
 * 节日表（本地日期，整天窗口——与启动时刻无关）。三个词的字母在每款字体里
 * 都有字形（`verify-splash-eggs.tsx` 逐款钉死，缺一个就会画成空心方块）。
 */
const SPLASH_EGGS: readonly DatedEgg[] = [
  { id: 'april-fools', month: 4, day: 1, top: EGG_TOP, bottom: 'HAPPINESS' },
  { id: 'christmas', month: 12, day: 25, top: EGG_TOP, bottom: 'MERRY' },
  { id: 'new-year', month: 1, day: 1, top: EGG_TOP, bottom: 'NEW YEAR' },
]

/**
 * 当天是不是彩蛋日。
 * @param now - 注入的当前时间（测试缝；生产用 `new Date()`）。
 * @returns 命中的彩蛋（含当天要用的词对）；没命中返回 `null`（照常画 `HARNESS`）。
 */
export function pickSplashEgg(now: Date = new Date()): SplashEgg | null {
  const month = now.getMonth() + 1
  const day = now.getDate()
  return SPLASH_EGGS.find(egg => egg.month === month && egg.day === day) ?? null
}

/** 求 star 标语指向的仓库。 */
export const SPLASH_STAR_URL = 'https://github.com/ccch1mneyyy/dsh-TUI'

/** 链接显示文本（比裸 URL 短，整行还能按鲸鱼居中）。 */
const SPLASH_STAR_LABEL = 'Star'

/** 求 star 彩蛋的三行结构（标题 / 数字 / 求星）。 */
export interface SplashStarLine {
  /** 标题行：替换平时的欢迎语（本次会话 star 过后换成"捡到星星"版）。 */
  readonly title: string
  /** 数字行：本机实测累计值。 */
  readonly stats: string
  /**
   * 求星行（`Star` 上是 OSC 8 链接），已拼好；**终端不支持超链接时为
   * `null`**——那行会退化成裸 URL，长 30+ 列会把整块撑破，宁可不显示。
   */
  readonly ask: string | null
  /** 整块里**最宽一行**的可见宽度：居中缩进必须按它算。 */
  readonly width: number
}

/** 剥掉 OSC 8 包裹序列（量可见宽度用）。 */
const stripHyperlink = (text: string): string => text.replace(/\x1b\]8;;[^\x07]*\x07/gu, '')

/**
 * 组装求 star 彩蛋。文案走 i18n 字典（中英齐全），`{{hours}}`/`{{launches}}`
 * 换成本机**实测**的累计值，`{{key}}` 换成生效中的快捷键显示。
 * @param options - `usage` 是本机累计用量；`supportsHyperlinks` 是终端能力的测试缝；
 *   `keyHint` 是快捷键显示（如 `Alt+S`）；`caught` 表示本次会话已经 star 过。
 * @returns 三行文案与最宽行可见宽度。
 */
export function splashStarLine(options: {
  usage: UsageStats
  supportsHyperlinks?: boolean
  keyHint?: string
  caught?: boolean
}): SplashStarLine {
  const supported = options.supportsHyperlinks ?? supportsHyperlinks()
  const hours = Math.max(1, Math.round(options.usage.totalMs / 3_600_000))
  const launches = Math.max(1, options.usage.launches)
  const title = t(options.caught === true ? 'logo-star-caught' : 'logo-star-title')
  const stats = t('logo-star-stats', { hours, launches })
  const ask = supported
    ? t('logo-star-ask', {
      star: createHyperlink(SPLASH_STAR_URL, SPLASH_STAR_LABEL, { supportsHyperlinks: true }),
      key: options.keyHint ?? '',
    })
    : null
  return {
    title,
    stats,
    ask,
    width: Math.max(
      stringWidth(title),
      stringWidth(stats),
      ask === null ? 0 : stringWidth(stripHyperlink(ask)),
    ),
  }
}
