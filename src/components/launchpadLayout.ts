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
 *   ② no-tip     —— 撤 Tips 行（最可省的一句闲话）
 *   ③ no-hints   —— 撤键帽按钮行（鼠标的礼貌；命令名本身还在 `/` 里）
 *   ④ no-art     —— 撤立绘（13 行，最占地方的那块），只留词标
 *   ⑤ input-only —— 只留词标 + 输入框 + 双角铭牌（最矮的终端也要能敲进去第一句）
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

/** 头部与卡片之间的行间隔（留白：卡片是主角，别贴着大字）。 */
const HERO_TO_CARD_GAP = 1
/** LogoV2 根盒自带的 marginTop——真实占一行，阶梯预算必须算进去，否则恰好卡
 *  阈值时卡片会被挤掉最后一行（夹具实证）。 */
const HERO_TOP_MARGIN = 1
/** 键帽按钮行：紧贴参数行（或框底），不留空行。 */
const HINTS_ROWS = 1
/** Tips 行：自身 1 行 + 上方 1 行留白。 */
const TIP_BLOCK_ROWS = 2
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

  // 第三版行数预算：输入框（恒 3）+ 框下成组行（参数 1 + 键帽 1 + Tips 2）+
  // 双角铭牌 2。撤的顺序保持「从最可省到最不可省」：Tips → 键帽 → 立绘。
  const paramRows = options.params === true ? PARAM_ROWS : 0
  const cardRows = CARD_ROWS
  const withArt = artRows > 0 ? artRows + 1 : 0
  const core = heroBlockRows + HERO_TO_CARD_GAP + cardRows + paramRows + CORNERS_BLOCK_ROWS
  // 每一档的总行数。顺序即从最全的往下掉：先试最全的，放不下就往下掉。
  const stages: readonly (readonly [LaunchpadStage, number])[] = [
    ['full', core + HINTS_ROWS + TIP_BLOCK_ROWS],
    ['no-tip', core + HINTS_ROWS],
    ['no-hints', core],
    ['no-art', core - withArt],
    ['input-only', core - withArt],
  ]
  // 默认落到最省的那一档：终端矮到连它都放不下时，宁可溢出也不把输入框藏起来
  // ——这一屏存在的理由就是能敲进去第一句。
  let stage: LaunchpadStage = 'input-only'
  for (const candidate of stages) {
    if (candidate[1] <= rows) {
      stage = candidate[0]
      break
    }
  }
  const dropArt = (stage === 'no-art' || stage === 'input-only') && withArt > 0
  const heroRowsFinal = dropArt ? titleRows : heroRows
  const heroBlockFinal = showHero ? heroRowsFinal + HERO_TOP_MARGIN : 0
  const showHints = stage === 'full' || stage === 'no-tip'
  const showTip = stage === 'full'
  const total = (showTip ? TIP_BLOCK_ROWS : 0) + (showHints ? HINTS_ROWS : 0) + heroBlockFinal
    + HERO_TO_CARD_GAP + cardRows + paramRows + CORNERS_BLOCK_ROWS
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
    showCorners: true,
    cardRows,
    heroRows: heroRowsFinal,
    totalRows: total,
  }
}
