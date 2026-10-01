import { bigTextWidth } from './bigfont.js'
import { WHALE_BOX_WIDTH } from './splashLayout.js'
import type { SplashFont } from './splashFonts.js'

/**
 * 落地页的降级阶梯——两个轴一起解：
 *
 * **宽轴**：上下排布之后立绘与词标各自独立判断（谁都别挤谁）——词标放不下就
 * 退化成一行纯文字标题，立绘放不下（窄于盒宽）就不画。
 * **高轴**是本模块的：落地页是整屏、放不下就没了，所以按行数再排一次顺序
 * **整块撤**，顺序从最可省到最不可省：
 *
 *   ① full       —— 头部 + 输入框 + 紧贴框下的成组三行（参数/键帽/Tips）+ 双角铭牌
 *   ② full-撤呼吸 —— 第六版两处呼吸留白（词标↔输入框、入口行↔Tips，各 2 行）
 *                   先撤回紧档 1 行，参数行留白随后也撤——**留白是刻意的
 *                   呼吸感，不是遗漏**；所有留白永远排在 Tips/入口行之前撤
 *   ③ no-tip     —— 撤 Tips 行（最可省的一句闲话）
 *   ④ no-hints   —— 撤键帽按钮行（鼠标的礼貌；命令名本身还在 `/` 里）
 *   ⑤ no-art     —— 撤立绘（13 行，最占地方的那块），只留词标
 *   ⑥ input-only —— 只留词标 + 输入框 + 双角铭牌（最矮的终端也要能敲进去第一句）
 *
 * 双角铭牌（工作路径:分支 / 版本号）钉在最底一行，是这一屏唯一不随阶梯消失的
 * 装饰——它把整块界面扎在终端底边上。
 *
 * 版面契约（2026-10 第三版）：
 * - 头部走 LogoV2 的 chrome=minimal + arrangement=column：立绘在上、
 *   DEEPSEEK/HARNESS 大字在下，两块各自水平居中；版号/模型/工作目录/提示一律不进
 *   头部（它们各自有更低频的位置：参数进框下成组行，目录与版本进底角）。
 * - 输入框（圆角边框）里**只有输入那一行**；参数行移到框外、紧贴框下方，
 *   左对齐输入框。整组（头部 + 输入框 + 参数/键帽/Tips 三行）垂直居中，
 *   不钉屏幕底、中间不留大空档。
 * - 键帽按钮行整行右对齐（与输入框右缘对齐）；Tips 行居中、`● Tips：` 前缀。
 *
 * 所有列数按**内容区**算（PageMargin 已经把 TerminalSizeContext 收窄）；行数
 * 同理。落地页不自己减页边距。
 */

/** 鲸鱼/女仆娘立绘（含盒）的行数。 */
const WHALE_ART_ROWS = 13
/** 块体大字的行数：上排 5 + 空 1 + 下排 5。 */
const BIG_TITLE_ROWS = 11
/** 只留文字的档位：一行纯标题。 */
const PLAIN_TITLE_ROWS = 1

/** 输入框卡片占的行数：边框 2 + 输入 1（第三版：参数行移出框外）。 */
export const CARD_ROWS = 3
/** 框下参数行的行数（模型/思考深度/模式/权限全空时整行不画）。 */
export const PARAM_ROWS = 1

/**
 * 头部与卡片之间的呼吸留白（第六版，2026-10 用户原话「DeepSeekHarness 和
 * 输入框中间空一行」）：默认 2 行。**这是刻意的版面呼吸感，不是遗漏**——
 * 别在重构时把它当成 bug 修掉。矮屏阶梯里它排在参数行留白之后、Tips 行
 * 之前被撤（撤到紧档 1 行），绝不让呼吸把输入框挤掉。
 */
const HERO_TO_CARD_GAP = 2
/** 矮屏撤呼吸后的紧档（第五版的老间距：词标与输入框隔 1 行）。 */
const HERO_TO_CARD_GAP_TIGHT = 1
/** LogoV2 根盒自带的 marginTop——真实占一行，阶梯预算必须算进去，否则恰好卡
 *  阈值时卡片会被挤掉最后一行（夹具实证）。 */
const HERO_TOP_MARGIN = 1
/**
 * 参数行与入口行之间的呼吸留白（第五版，2026-10 用户实测「跟输入框太紧了，
 * 留一两行空」）：默认 1 行。**这行留白是刻意的版面呼吸感，不是遗漏**——
 * 别在重构时把它当成 bug 修掉。只在参数行画出来时才存在（参数全空时入口行
 * 直接紧贴框底，原契约不变）。矮屏阶梯里它的取舍顺序排在 Tips 之后、
 * 键帽行之前：先撤留白、再撤键帽行，绝不让这行呼吸把输入框挤掉。
 */
const PARAM_HINTS_GAP_ROWS = 1
/** 键帽按钮行：参数行之下、隔一行呼吸留白（矮屏可撤，见 PARAM_HINTS_GAP_ROWS）。 */
const HINTS_ROWS = 1
/**
 * Tips 行：自身 1 行 + 上方呼吸留白（第六版，用户原话「继续等按钮和 tips
 * 中间空一行」→ 入口行与 Tips 之间默认 2 行空行）。**这行留白同样是刻意的
 * 呼吸感，不是遗漏**；矮屏阶梯里先撤它（回到 1 行）再撤 Tips 行本身。
 */
const TIP_BLOCK_ROWS = 3
/** 矮屏撤呼吸后的紧档（自身 1 + 留白 1）。 */
const TIP_BLOCK_ROWS_TIGHT = 2
/** 双角铭牌：自身 1 行 + 上方 1 行留白。 */
const CORNERS_BLOCK_ROWS = 2

/** 该尺寸下渲染哪一档。 */
export type LaunchpadStage = 'full' | 'no-tip' | 'no-hints' | 'no-art' | 'input-only'

/** 一屏落地页在该尺寸下要渲染哪些部件。 */
export interface LaunchpadLayout {
  /** 整块撤的顺序档位。 */
  readonly stage: LaunchpadStage
  /** 渲染像素鲸鱼 / 女仆娘立绘（宽轴决定；窄了不画，免得被裁）。 */
  readonly showWhale: boolean
  /** 渲染 DEEPSEEK / HARNESS 块体大字。 */
  readonly showBigTitle: boolean
  /** 大字放不下、立绘也放不下：退化成一行纯文字标题。 */
  readonly showPlainTitle: boolean
  /** 头部整块是否渲染。 */
  readonly showHero: boolean
  /** 键帽按钮行（框下成组行的第二行，右对齐）。 */
  readonly showHints: boolean
  /** 居中 Tips 行（成组行的第三行）。 */
  readonly showTip: boolean
  /**
   * 参数行与入口行之间的呼吸留白行数（0 或 1）：默认 1；矮屏阶梯里排在
   * Tips 之后、键帽行之前被撤掉。参数行缺席时恒 0（没有可隔开的两行）。
   */
  readonly hintsGapRows: number
  /**
   * 词标与输入框之间的呼吸留白行数（1 或 2，第六版默认 2——刻意的呼吸感，
   * 不是遗漏）：矮屏阶梯里先于 Tips 行被撤回紧档 1。
   */
  readonly heroGapRows: number
  /**
   * 入口行与 Tips 行之间的呼吸留白行数（1 或 2，第六版默认 2）：矮屏阶梯
   * 里先于 Tips 行被撤回紧档 1（Tips 行本身更晚才整行撤掉）。
   */
  readonly tipGapRows: number
  /** 双角铭牌行（永远画：它是这一屏的底边锚点）。 */
  readonly showCorners: boolean
  /** 输入框卡片占的行数（边框 2 + 输入 1，恒 3）。 */
  readonly cardRows: number
  /** 头部本体占的行数（不含 LogoV2 根盒的 marginTop）。 */
  readonly heroRows: number
  /** 内容总行数——测试用来钉死这一档真的放得下。 */
  readonly totalRows: number
}

/**
 * @param columns - 内容区列数。
 * @param rows - 内容区行数。
 * @param options - whale / whaleGirl 对应设置项；font 是当天那款字体（字身宽度
 *   不同，宽轴阈值也跟着不同）；params 是框下有没有参数行（模型/思考深度/模式/
 *   权限全拿不到时为 false，成组行矮一行）。
 * @returns 该尺寸下要渲染的部件。
 */
export function resolveLaunchpadLayout(
  columns: number,
  rows: number,
  options: { whale: boolean; whaleGirl?: boolean; font: SplashFont; params?: boolean },
): LaunchpadLayout {
  const { font } = options
  // 与 resolveSplashLayout 同一套阈值：末尾那一格字距也算进去，否则恰好卡阈值
  // 时 Ink 会把最后一个字形换成省略号。
  const titleWidth = bigTextWidth(font, font.tagline.top, font.tagline.topKerning) + font.tagline.topKerning
  const showBigTitle = columns >= titleWidth
  const artBox = WHALE_BOX_WIDTH
  const wantsArt = options.whale || options.whaleGirl === true
  // 上下排布：立绘只看自己放不放得下，不再和词标抢同一行的宽度。
  const showWhale = wantsArt && columns >= artBox
  const showPlainTitle = !showBigTitle && !showWhale
  const showHero = showWhale || showBigTitle || showPlainTitle

  // 上下排布时头部 = 立绘 + 间隔 1 + 大字；退化档位取各自实际行数。
  const artRows = showWhale ? WHALE_ART_ROWS : 0
  const titleRows = showBigTitle ? BIG_TITLE_ROWS : PLAIN_TITLE_ROWS
  const heroRows = showHero ? (artRows > 0 ? artRows + 1 + titleRows : titleRows) : 0
  // 头部整块（含根盒 marginTop）实际占的行数：阶梯与 totalRows 都按它算。
  const heroBlockRows = showHero ? heroRows + HERO_TOP_MARGIN : 0

  // 第六版行数预算：输入框（恒 3）+ 框下成组行（参数 1 + 呼吸留白 0/1 +
  // 键帽 1 + Tips 3）+ 双角铭牌 2。撤的顺序「从最可省到最不可省」：
  // 新增的两处呼吸（词标↔输入框、入口行↔Tips）→ 参数行呼吸留白 → Tips 行
  // 本身 → 键帽行 → 立绘（**所有留白永远排在 Tips/入口行之前撤**，
  // 绝不让呼吸把输入框挤掉）。
  const paramRows = options.params === true ? PARAM_ROWS : 0
  const gapRows = paramRows > 0 ? PARAM_HINTS_GAP_ROWS : 0
  const cardRows = CARD_ROWS
  const withArt = artRows > 0 ? artRows + 1 : 0
  const core = heroBlockRows + cardRows + paramRows + CORNERS_BLOCK_ROWS
  // 每一档的总行数。顺序即从最全的往下掉：先试最全的，放不下就往下掉。
  // full 带 4 个变体（呼吸×参数留白的紧/松组合）、no-tip 带 3 个：
  // 呼吸在（默认 2/2）→ 撤呼吸（紧档 1/1）→ 撤参数留白，全部都矮于撤 Tips。
  const stages: readonly { stage: LaunchpadStage; breath: boolean; gap: boolean; rows: number }[] = [
    { stage: 'full', breath: true, gap: true, rows: core + HERO_TO_CARD_GAP + gapRows + HINTS_ROWS + TIP_BLOCK_ROWS },
    { stage: 'full', breath: false, gap: true, rows: core + HERO_TO_CARD_GAP_TIGHT + gapRows + HINTS_ROWS + TIP_BLOCK_ROWS_TIGHT },
    { stage: 'full', breath: true, gap: false, rows: core + HERO_TO_CARD_GAP + HINTS_ROWS + TIP_BLOCK_ROWS },
    { stage: 'full', breath: false, gap: false, rows: core + HERO_TO_CARD_GAP_TIGHT + HINTS_ROWS + TIP_BLOCK_ROWS_TIGHT },
    { stage: 'no-tip', breath: false, gap: true, rows: core + HERO_TO_CARD_GAP_TIGHT + gapRows + HINTS_ROWS },
    { stage: 'no-tip', breath: true, gap: false, rows: core + HERO_TO_CARD_GAP + HINTS_ROWS },
    { stage: 'no-tip', breath: false, gap: false, rows: core + HERO_TO_CARD_GAP_TIGHT + HINTS_ROWS },
    { stage: 'no-hints', breath: false, gap: false, rows: core + HERO_TO_CARD_GAP_TIGHT },
    { stage: 'no-art', breath: false, gap: false, rows: core + HERO_TO_CARD_GAP_TIGHT - withArt },
    { stage: 'input-only', breath: false, gap: false, rows: core + HERO_TO_CARD_GAP_TIGHT - withArt },
  ]
  // 默认落到最省的那一档：终端矮到连它都放不下时，宁可溢出也不把输入框藏起来
  // ——这一屏存在的理由就是能敲进去第一句。
  let stage: LaunchpadStage = 'input-only'
  let keepGap = false
  let keepBreath = false
  for (const candidate of stages) {
    if (candidate.rows <= rows) {
      stage = candidate.stage
      keepGap = candidate.gap
      keepBreath = candidate.breath
      break
    }
  }
  const dropArt = (stage === 'no-art' || stage === 'input-only') && withArt > 0
  const heroRowsFinal = dropArt ? titleRows : heroRows
  const heroBlockFinal = showHero ? heroRowsFinal + HERO_TOP_MARGIN : 0
  const showHints = stage === 'full' || stage === 'no-tip'
  const showTip = stage === 'full'
  // 留白只画在「参数行 ↔ 入口行」之间：两行都在且这一档保住了留白才算数。
  const hintsGapRows = showHints && keepGap ? gapRows : 0
  // 两处呼吸（词标↔输入框、入口行↔Tips）：默认 2 行，矮屏先撤回紧档 1 行。
  const heroGapRows = keepBreath ? HERO_TO_CARD_GAP : HERO_TO_CARD_GAP_TIGHT
  const tipGapRows = keepBreath ? TIP_BLOCK_ROWS - 1 : TIP_BLOCK_ROWS_TIGHT - 1
  const total = (showTip ? 1 + tipGapRows : 0) + hintsGapRows + (showHints ? HINTS_ROWS : 0) + heroBlockFinal
    + heroGapRows + cardRows + paramRows + CORNERS_BLOCK_ROWS
  return {
    stage,
    // dropArt 只撤立绘——`heroRowsFinal`/`totalRows` 都按「撤立绘、留大字」算，
    // 这里跟着把大字也杀掉会让字段自相矛盾（测试代理实测抓到）。
    showWhale: showWhale && !dropArt,
    showBigTitle,
    showPlainTitle: showBigTitle ? false : showPlainTitle || dropArt,
    showHero,
    showHints,
    showTip,
    hintsGapRows,
    heroGapRows,
    tipGapRows,
    showCorners: true,
    cardRows,
    heroRows: heroRowsFinal,
    totalRows: total,
  }
}
