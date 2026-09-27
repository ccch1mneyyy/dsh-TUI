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

/** 求 star 标语的命中概率：1/20。 */
export const SPLASH_STAR_CHANCE = 0.05

/** 链接显示文本（比裸 URL 短，整行还能按鲸鱼居中）；退化时 `createHyperlink` 会换成 URL。 */
const SPLASH_STAR_LABEL = 'GitHub'

/**
 * 掷一次「这次 mount 要不要显示求 star 标语」。
 * @param chance - 命中概率（0..1；测试缝可传 0/1 强制不命中/命中）。
 * @param random - 随机源（测试缝，默认 `Math.random`）。
 * @returns 命中为 true。
 */
export function pickSplashStar(chance: number = SPLASH_STAR_CHANCE, random: () => number = Math.random): boolean {
  return random() < chance
}

/** 求 star 标语那一行的三段：链接前文案 + 链接 + 链接后文案。 */
export interface SplashStarLine {
  /** 链接前的文案（调用方按主题上色/扫光）。 */
  readonly lead: string
  /** 链接本身（OSC 8；终端不支持时是纯文本 URL）。 */
  readonly link: string
  /** 链接后的文案。 */
  readonly tail: string
  /** 整行**可见**宽度（终端列）：居中缩进必须按它算，不能沿用 `logo-tagline` 的宽度。 */
  readonly width: number
}

/**
 * 组装求 star 标语那一行。文案走 i18n 字典（中英齐全），链接指向 `SPLASH_STAR_URL`。
 * @param options - `supportsHyperlinks` 是终端能力的测试缝（默认问真实终端）。
 * @returns 三段文案与整行可见宽度。
 */
export function splashStarLine(options?: { supportsHyperlinks?: boolean }): SplashStarLine {
  const supported = options?.supportsHyperlinks ?? supportsHyperlinks()
  const lead = t('logo-star-lead')
  // 不支持 OSC 8 时上屏的是裸 URL（比 `GitHub` 长出 30+ 列），再加尾巴整行就会超出内容宽
  // 被折成两行——那种终端上省掉尾巴：URL 本身已经说明去哪，少一句邀请比折行好看。
  const tail = supported ? t('logo-star-tail') : ''
  const link = createHyperlink(SPLASH_STAR_URL, SPLASH_STAR_LABEL, { supportsHyperlinks: supported })
  return {
    lead,
    link,
    tail,
    // 按可见文本量：不支持超链接时上屏的是 URL 本身，宽度也就跟着变（缩进要重算）。
    width: stringWidth(lead) + stringWidth(supported ? SPLASH_STAR_LABEL : SPLASH_STAR_URL) + stringWidth(tail),
  }
}
