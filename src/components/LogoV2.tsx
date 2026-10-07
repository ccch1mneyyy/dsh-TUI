import React from 'react'
import { getLang, t as tr, tOr } from '../i18n.js'
import { pickRandomTip, type Tip } from '../tips.js'
import { upstreamDriftSummary, UPSTREAM_VALIDATED_VERSION, type UpstreamDriftSummary } from '../dsh-adapter/contract.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Box, Text, useAnimationFrame, useTerminalImages, useTerminalSize } from '../ui.js'
import { getTheme, isLightThemeActive } from '../theme.js'
import { BRAND_SPLASH_WORDS, BRAND_TAGLINE, type Brand } from '../branding.js'
import { useTheme } from './design-system/ThemeProvider.js'
import { interpolateColor, parseRGB } from './Spinner/spinnerUtils.js'
import { renderBigText } from './bigfont.js'
import { COLUMN_GAP, WHALE_BOX_WIDTH, resolveSplashLayout } from './splashLayout.js'
import { withTagline, pickSplashFont, splashFontById, type SplashFont } from './splashFonts.js'
import { pickSplashEgg, splashStarLine, type SplashEgg } from './splashEggs.js'
import { isHistoricMilestone, markStarAsked, pendingStarMilestone, recordLaunch, STAR_MILESTONES, usageSnapshot } from '../usageStats.js'
import { effectiveComboDisplay } from '../utils/keymap.js'
import { stringWidth } from '../ink/stringWidth.js'
import { BRAND, EMBER, EMBER_BRIGHT, EMBER_FLASH, EMBER_LIGHT, EMBER_PALE, EMBER_PAPER, EMBER_PAPER_FLASH, FLASH, ICE, LAVENDER, LAVENDER_BRIGHT, LAVENDER_FLASH, LAVENDER_LIGHT, LAVENDER_PALE, LAVENDER_PAPER, LAVENDER_PAPER_FLASH, LAVENDER_SOFT, PALE, sweep } from './shimmer.js'
import { STANDARD_FRAME_INDEX, WhaleArt } from './Whale.js'
import { WhaleGirlArt } from './WhaleGirl.js'
import { ClaudeGirlArt } from './ClaudeGirl.js'
import { CLAUDE_GIRL_ASSETS, MAID_ASSETS, MAID_BOX_CENTER, MaidPortrait, useMaidPortraits } from './maidPortrait.js'
import { SplashMascot, useSplashMascotSkin } from './sidePanel/companion/SplashMascot.js'
import { OPENING_SEQUENCES, pickOpeningSequence, WHALE_FRAME_INDEX, type OpeningStep, type WhaleIntroId } from './whaleFrames.js'
import { RESTING_POSE, type WhaleLayerPose } from './whaleLayers.js'
import {
  initialWhaleIdleState,
  nextWhaleIdleStep,
  type WhaleIdleState,
} from './whaleIdle.js'

/** Intro-phase heart pass (whole frames — the planner owns the settled phase). */
const INTRO_HEART_PASS: readonly number[] = [
  WHALE_FRAME_INDEX.heart1, WHALE_FRAME_INDEX.heart2, WHALE_FRAME_INDEX.heart3,
]

/**
 * Header badge version, read from the installed package.json so the display
 * never drifts from the published version. Falls back to a literal when the
 * package metadata is unreadable (unusual layouts).
 */
const VERSION = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json')
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? '0.1.0'
  } catch {
    return '0.1.0'
  }
})()

/**
 * Center of the whale art's bounding box: sprite columns 3..34 (center
 * 18.5) of the 40-wide box. The welcome tagline is indented so its own
 * center lands on this column — for the 14-column Chinese tagline that is
 * 18.5 − 7 = 11.5 → 12 leading spaces. (Centering on the full 40-column
 * box would need 13, which reads one column right of the whale body.)
 * The pad is recomputed from the rendered tagline's display width so
 * longer locales — e.g. the 21-column English tagline → 8 — stay
 * centered under the art too.
 */
const WHALE_CENTER = 18.5

/** 「高兴鲸娘」停留时长（点她之后自动回安静版）。 */
const MAID_HAPPY_MS = 3000

/** `max` → `Max` (effort levels arrive lower-case from the adapter). */
function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1)
}

/**
 * The header splash: one layout, two phases. The **opening** (~1.7–3.5s,
 * once) plays one of three whale intros — the classic blink + spout +
 * tail-wag combo, the heart pass, or the sleep-Z float — rolled on every
 * mount (see `pickOpeningSequence`): randomly at startup, and again
 * randomly on each `/deepseek` easter-egg replay — and runs the shimmer
 * sweeps; the **settled** header is the same tree frozen at t=0 — whale
 * on the standard pose, sweep highlights parked off-screen, clock
 * unsubscribed, zero timers.
 *
 * Layout: the 13-row pixel whale beside a text column of matching height —
 * the `✦ dsh-TUI` wordmark with version, the `DEEPSEEK`/`HARNESS` tagline in
 * the 5-row block font (brand-blue → ice gradient, a blank row between the
 * two words, both stretched to the same width — see `splashFonts.ts` for the
 * eight faces and the per-face kerning), the model/effort and
 * cwd in plain text (no brand-color highlight), the startup tip, and below
 * the whale the welcome tagline, centered under the art, in ice
 * blue. Narrow terminals climb down the `resolveSplashLayout` ladder —
 * whale + big text, then the big text alone, then the whale alone, then one
 * plain title line. The face rotates by local date (`pickSplashFont`), so a
 * given day always shows the same one.
 *
 * Two easter eggs sit on top of that layout without changing it (both live in
 * `splashEggs.ts`): the holiday word pair swaps the two big-text words on its
 * date (`MERRY` on 12/25, …), and a 1-in-20 roll replaces the welcome tagline
 * with a clickable "star us on GitHub" line whose indent is recomputed from
 * its own width.
 */
export function LogoV2({
  model = '',
  effort,
  cwd = '',
  skipIntro = false,
  intro,
  tip,
  fontId,
  whale = true,
  whaleIdle = true,
  whaleGirl = false,
  brand = 'deepseek',
  starred = false,
  starReveal,
  onStarClick,
  working = false,
  drift,
  egg,
  starChance,
  align = 'start',
  chrome = 'full',
  arrangement = 'row',
  companionSkin,
}: {
  /** 模型/effort/工作目录只画在 full 形态里；minimal（落地页）不传也行。 */
  model?: string
  effort?: string | undefined
  cwd?: string
  /** Test seam: mount straight into the settled header (probes skip the intro). */
  skipIntro?: boolean
  /** Test seam: pin the intro animation instead of rolling one at startup. */
  intro?: WhaleIntroId
  /** Big-text face id (settings `dsh-tui.splashFont`); undefined → the
   * date-rotated `pickSplashFont()`. */
  fontId?: string | undefined
  /** Test seam: pin the startup tip line (probes need a deterministic tip). */
  tip?: Tip
  /** Test seam: pin the holiday word pair instead of reading the local date
   * (`null` forces the normal words; `undefined` — production — rolls by
   * date). See `splashEggs.ts`. */
  egg?: SplashEgg | null
  /** Test seam: pin the star tagline's chance (1 forces the egg, 0 suppresses
   * it; production rolls `SPLASH_STAR_CHANCE` once per mount). */
  starChance?: number
  /** Show the pixel whale art (settings `dsh-tui.whale`); off → text-only header. */
  whale?: boolean
  /** Swap the header's pixel whale for the maid portrait (settings
   * `dsh-tui.whaleGirl`; off by default). The portrait renders FIRST as a
   * real raster through the terminal image protocols (Kitty/Sixel —
   * `maidPortrait.tsx`), keeping the art's full fidelity; when the terminal
   * cannot (inline mode, unsupported protocol, decode failure) the
   * character-art maid (`WhaleGirl.tsx`, the author's placeholder to be
   * replaced with better art) takes the slot. Both forms are static, so
   * `whaleIdle` only animates the whale. */
  whaleGirl?: boolean
  /** 品牌档（当前后端 → `brandOfProvider`，见 `branding.ts`）：claude 时
   * 大字词换 `CLAUDE`/`CODE`、配色换橙阶、立绘槽固定 Claude 娘（不看
   * whaleGirl 设置——鲸鱼与鲸鱼娘是 DeepSeek 品牌资产）。测试缝：缺省
   * `deepseek`，行为与品牌化之前逐字节一致。 */
  brand?: Brand
  /** 本次会话已经 star 过：彩蛋标题换成「捡到一颗小星星啦」，不再重复求。 */
  starred?: boolean
  /** 彩蛋渐显的测试缝：`instant` 时三行一次画全（静态渲染夹具用；真机不传）。 */
  starReveal?: 'instant'
  /** 求 star 标语那一行被点击时执行（一键 star，与 `/star` / `Alt+S` 同一个
   * 动作）。不传则那一行不可点——只有它出现时才有这个交互。 */
  onStarClick?: () => void
  /** Welcome-phase idle whale behaviors — fin flutters, tail thumps,
   * sleep after inactivity (settings `dsh-tui.whaleIdle`; on by default —
   * an explicit `false` keeps the settled header timer-free). Click-hearts
   * work regardless, until the freeze. */
  whaleIdle?: boolean
  /** Whether an agent turn is active. The FIRST active turn permanently
   * freezes the whale to the static standard frame (the idle planner and
   * click-hearts are welcome-phase features); sustained !working before
   * that lets it fall asleep. */
  working?: boolean
  /** Test seam: pin/suppress the upstream-drift notice (`null` forces it off;
   * `undefined` — the production default — auto-detects the install). */
  drift?: UpstreamDriftSummary | null
  /**
   * 排版对齐，默认 `start` = 转录区顶部那一版（逐字节不变）：
   *
   * - `start`  —— 并排行**占满整行**（`width="100%"`），欢迎语靠
   *   `welcomePad` 对齐到鲸鱼的视觉中线。转录区顶部要的正是这个：它左对齐在
   *   内容列上，下面的消息行也跟着左对齐。
   * - `center` —— 落地页要的那一版：**整块按内容宽度居中**（并排行不再是
   *   100% 宽，根盒 `alignItems="center"`），欢迎语交给外层居中、不再自己
   *   加缩进。缩进那套是"左对齐时把标语钉在鲸鱼下方"的解，居中的版面上
   *   再用一次就整体右移了。
   *
   * 内容完全同源（鲸鱼、字体、彩蛋、提示、漂移告警都走同一套代码），只有
   * 对齐交给父级。
   */
  align?: 'start' | 'center'
  /**
   * 装饰密度，默认 full = 转录区顶部那一版（逐字节不变）：词标 + 版本、
   * 模型/effort、工作目录、启动提示、漂移告警、欢迎语一应俱全。
   *
   * - full    —— 对话页开屏的信息密度（「我在哪、用的哪个模型」的答案）。
   * - minimal —— 落地页那一版（opencode 式留白）：只留立绘与块体
   *   DEEPSEEK/HARNESS 大字，其余信息行一概不画；欢迎语平时也不画
   *   （落地页的版面契约里它整行删除），只有求 star 里程碑标语出现时才
   *   画那几行——里程碑的露出不因落地页改版而丢。
   *
   * 内容与交互（字体、彩蛋、点击爱心/女仆娘、idle 规划器）两条 chrome
   * 完全同源，差异只在文字列的密度。
   */
  chrome?: 'full' | 'minimal'
  /**
   * 立绘与词标的排布：`row`（默认，转录区开屏形态：图在左、字在右）或
   * `column`（落地页形态：图在上、字在下，两者各自水平居中）。
   * 用户实测反馈「logo 和标题一定要居中」——并排时是**整组**居中，词标仍然
   * 偏在右半边；上下排布让两块各自落在中轴上，居中这件事不再有歧义。
   */
  arrangement?: 'row' | 'column'
  /** 测试缝：钉住启动页吉祥物皮肤（undefined——生产——读 companion.skin；
   *  'whale'/未知 = 维持原鲸鱼/女仆娘路径，见 SplashMascot.tsx）。 */
  companionSkin?: string
}): React.ReactNode {
  // One intro per logo mount: the production path rolls (startup splash
  // and each /deepseek replay roll independently), the `intro` seam pins
  // a specific animation for probes.
  const [sequence] = React.useState<readonly OpeningStep[]>(() => OPENING_SEQUENCES[intro ?? pickOpeningSequence().id])
  const [step, setStep] = React.useState(skipIntro ? sequence.length : 0)
  const settled = step >= sequence.length

  // Opening clock: drives the shimmer sweep and big-text highlight only
  // while the intro plays; `null` afterwards unsubscribes so the settled
  // header never repaints. 60ms frames keep the sweep lively.
  const [ref, time] = useAnimationFrame(settled ? null : 60)

  // Frame chain: dwell per sequence entry, then settle for good.
  React.useEffect(() => {
    if (settled) return
    const timer = setTimeout(() => {
      setStep(s => s + 1)
    }, sequence[step].ms)
    return () => {
      clearTimeout(timer)
    }
  }, [step, settled, sequence])

  // First task latches the freeze: once an agent turn starts, the settled
  // whale drops to the static standard frame for the rest of the session —
  // idle motion and click-hearts are a welcome-phase feature, and a frozen
  // logo costs nothing while the transcript scrolls it off-screen.
  const [whaleFrozen, setWhaleFrozen] = React.useState(false)
  React.useEffect(() => {
    if (working) setWhaleFrozen(true)
  }, [working])

  // ── 启动页吉祥物（2026-10 复用轮）：companion.skin 驱动 ────────────────
  // deepy → 字母格动画；whaleGirl → 鲸娘动画（图像协议自适应，首帧字母格
  // 同步可画）；两者都取代艺术槽的原住民（分层鲸/静态女仆娘立绘）。
  // 'whale'/未知皮肤 → undefined，原路径零改动。冻结/落地页（whaleIdle=
  // false）时吉祥物定格 idle 帧 0、零时钟（SplashMascot 内部保证）。
  const mascotSkin = useSplashMascotSkin(companionSkin)

  // ── Whale behaviors (ported from the dsh-ui-whale pet) ─────────────────
  // Intro-phase click → heart pass: whole heart frames over the opening
  // animation (one-way heart1→heart2→heart3). Once the header settles, the
  // layered planner below owns hearts as an overlay, so this state only
  // matters before settle. heartKey restarts the pass on every click, even
  // when heartSeq is already 0 (setHeartSeq(0) alone bails in React when the
  // value is unchanged).
  const [heartSeq, setHeartSeq] = React.useState(-1)
  const [heartKey, setHeartKey] = React.useState(0)
  React.useEffect(() => {
    if (heartSeq < 0) return
    // Once settled with the layered planner on, hearts are the planner's
    // overlay — a whole-frame pass started during the intro ends here. The
    // freeze (first task) tears interactions down the same way. A settled
    // header with `whaleIdle` off has no planner, so the whole-frame pass
    // keeps playing there (click-hearts don't depend on the setting).
    if (settled && (whaleIdle || whaleFrozen)) {
      setHeartSeq(-1)
      return
    }
    const timer = setTimeout(() => {
      setHeartSeq(s => (s >= INTRO_HEART_PASS.length - 1 ? -1 : s + 1))
    }, 350)
    return () => {
      clearTimeout(timer)
    }
  }, [heartSeq, heartKey, settled, whaleIdle, whaleFrozen])

  /** 预览缝：`DSH_TUI_STAR_LINE=1` 时开屏就显示求 star 标语行（不记账）。 */
  const starLinePreview = process.env.DSH_TUI_STAR_LINE === '1'
  const [themeName] = useTheme()
  /** 终端真底色（Sixel 不透明衬底；见渲染处的注释）。 */
  const theme = getTheme(themeName)
  const { columns } = useTerminalSize()

  const wordmarkRGB = parseRGB(theme.accent) ?? BRAND
  const wordmarkShimmerRGB = parseRGB(theme.accentShimmer) ?? ICE
  const taglineRGB = parseRGB(theme.activity) ?? ICE

  // 按天轮换的大字字体：同一天内恒定、隔天换一款；`fontId`（设置项）可 pin 住一款。
  const [dailyFont] = React.useState<SplashFont>(() => pickSplashFont())
  const font = fontId === undefined ? dailyFont : splashFontById(fontId)

  // 品牌词（`branding.ts`）：claude 内核换 `CLAUDE`/`CODE`、codex 内核换
  // `CODEX`/`HARNESS`——字身不变、字距取最宽可行解（两词字数差大，紧解上排
  // 字距只有 1、整体局促），窄终端阶梯阈值跟着当天真实标题宽度走，与彩蛋
  // 共用 `withTagline`。
  const words = BRAND_SPLASH_WORDS[brand]
  const brandFont = brand !== 'deepseek' ? withTagline(font, words.top, words.bottom, { wide: true }) : font

  // 节日彩蛋：本地日期整天恒定，每次 mount 只判一次（照 pickSplashFont 的写法）。
  // 只换下排词——上排钉在品牌词上（deepseek 的 `DEEPSEEK` / claude 的 `CLAUDE`
  // / codex 的 `CODEX`）。
  const [dailyEgg] = React.useState<SplashEgg | null>(() => (egg === undefined ? pickSplashEgg() : egg))
  const titleFont = dailyEgg === null ? brandFont : withTagline(font, brand === 'deepseek' ? font.tagline.top : words.top, dailyEgg.bottom, { wide: brand !== 'deepseek' })

  // 窄终端阶梯：鲸鱼 + 大字 → 纯大字 → 纯鲸鱼 → 一行纯文字（阈值随字体字身宽度变）。
  const splash = resolveSplashLayout(columns, { whale, font: titleFont })
  /**
   * 上下排布（落地页）时立绘与词标**不共行**，宽轴那套「谁挤掉谁」的判定不适用：
   * 立绘只看自己放不放得下（盒宽）。照并排阈值走会在 55–96 列这一大段把立绘判掉，
   * 而落地页明明有一整行宽度给它——实测症状是「撤立绘」那一档不生效：矮屏上鲸鱼
   * 照画，把大字与卡片挤出屏幕。
   */
  const stacked = arrangement === 'column'
  const { showWhale, showBigTitle, showPlainTitle } = stacked
    ? {
        showWhale: whale && columns >= WHALE_BOX_WIDTH,
        showBigTitle: splash.showBigTitle,
        showPlainTitle: !splash.showBigTitle,
      }
    : splash

  // 女仆娘档优先走**真图**（Kitty/Sixel 终端图像协议，见 `maidPortrait.tsx`）；
  // 协议不可用（内联模式、终端不支持）或资产解码失败时，回落到字符画版
  // 女仆娘（`WhaleGirl.tsx` 半块精灵——作者占位，之后会换更好看的）。
  // claude 品牌档（`branding.ts`）的立绘槽固定 Claude 娘（同一套盒几何：
  // 真图 = `assets/claude-girl/`，回落 = `ClaudeGirl.tsx`），不看 whaleGirl
  // 设置——像素鲸鱼与鲸鱼娘是 DeepSeek 品牌的资产。
  // 两种形态都是静态立绘：闲置动画与点击爱心仍是鲸鱼专属。
  // `maidImageActive` 只在「真图画出来了」时为真。
  const claudeArt = brand === 'claude'
  const portraitMode = whaleGirl || claudeArt
  const imagesAvailable = useTerminalImages(portraitMode)
  const portraits = useMaidPortraits(portraitMode && imagesAvailable, claudeArt ? CLAUDE_GIRL_ASSETS : MAID_ASSETS)
  const maidSource = portraits?.normal
  const maidImageActive = portraitMode && imagesAvailable && maidSource !== undefined
  // 点一下她 → 换成「高兴鲸娘」几秒（自动回安静版；第一个任务后定格、
  // 不再响应，与鲸鱼的规则一致）。定时器在卸载/重挂时清掉。
  const [maidHappy, setMaidHappy] = React.useState(false)
  const maidHappyTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const reactMaid = React.useCallback((): void => {
    setMaidHappy(true)
    if (maidHappyTimerRef.current !== null) clearTimeout(maidHappyTimerRef.current)
    const timer = setTimeout(() => {
      maidHappyTimerRef.current = null
      setMaidHappy(false)
    }, MAID_HAPPY_MS)
    ;(timer as { unref?: () => void }).unref?.()
    maidHappyTimerRef.current = timer
  }, [])
  React.useEffect(() => () => {
    if (maidHappyTimerRef.current !== null) clearTimeout(maidHappyTimerRef.current)
  }, [])

  // Welcome-phase idle behaviors (settings `dsh-tui.whaleIdle`): fin
  // flutters, tail thumps and blinks while idle, and a sleep-Z loop after
  // sustained inactivity — all as INDEPENDENT layers composed per tick
  // (whaleLayers.ts), so a click heart plays over a mid-wag tail or the
  // sleep-Z loop instead of replacing it. The planner is event-driven —
  // while the whale rests, the ONLY pending timer is the one waiting for
  // the next due event, and with the setting off there is no timer at all
  // (the idle-wakeup contract keeps holding). The freeze latch above tears
  // the whole thing down at the first agent turn; the planner's working
  // branch only ever runs for the same-tick race before the latch renders.
  const [idlePose, setIdlePose] = React.useState<WhaleLayerPose | null>(null)
  const idleStateRef = React.useRef<WhaleIdleState>(initialWhaleIdleState(0))
  const pendingHeartRef = React.useRef(false)
  const tickRef = React.useRef<(() => void) | null>(null)
  React.useEffect(() => {
    // 女仆娘档（真图或字符画）与吉祥物档（SplashMascot 自带节拍器）都
    // 不需要鲸鱼的闲置规划器：那两条路径里分层鲸根本没画。
    if (!settled || !whaleIdle || !showWhale || whaleFrozen || portraitMode || mascotSkin !== undefined) {
      setIdlePose(null)
      tickRef.current = null
      return
    }
    // A working flip restarts the loop: work wakes a sleeping whale and
    // slides every idle deadline forward (see nextWhaleIdleStep).
    idleStateRef.current = initialWhaleIdleState(Date.now())
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = (): void => {
      // A click can drive tick() directly (tickRef.current?.() in the click
      // handler) while the timer armed by the previous tick is still pending —
      // drop it first, or every click forks an extra rescheduling chain that
      // outlives the effect cleanup (which only knows the latest timer).
      if (timer !== undefined) clearTimeout(timer)
      const heart = pendingHeartRef.current
      pendingHeartRef.current = false
      const step = nextWhaleIdleStep(idleStateRef.current, { working, heart }, Date.now())
      idleStateRef.current = step.state
      setIdlePose(step.pose)
      timer = setTimeout(tick, step.delayMs)
      // The planner reschedules forever while mounted — unref so the chain
      // never holds the process alive on its own. The interactive TUI stays
      // up on its TTY/stdin handles; probe hosts that mount the header
      // without unmounting get a clean event-loop drain instead of a hang.
      ;(timer as { unref?: () => void }).unref?.()
    }
    tickRef.current = tick
    tick()
    return () => {
      tickRef.current = null
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [settled, whaleIdle, showWhale, working, whaleFrozen, portraitMode])
  // Render priority: the layered planner pose owns the settled header while
  // it runs (hearts and blinks compose over the body planes). Otherwise a
  // click heart plays as whole heart frames over the intro — or over the
  // settled standard pose when `whaleIdle` is off (no planner there).
  const frameIndex = heartSeq >= 0
    ? (INTRO_HEART_PASS[heartSeq] ?? STANDARD_FRAME_INDEX)
    : !settled
      ? sequence[step].frame
      : STANDARD_FRAME_INDEX
  // Frozen clock for the settled header: t=0 parks every sweep highlight
  // off-screen, leaving the static gradient behind.
  const t = settled ? 0 : time

  // 品牌欢迎语（claude 档专用文案；deepseek 沿用 i18n 的 `logo-tagline`）。
  // 英文是两行（\n 分隔）——渲染与居中都按行处理，见下方 welcomeWidth/渲染。
  const brandTagline = BRAND_TAGLINE[brand]
  const tagline = brand !== 'deepseek'
    ? (getLang() === 'zh' ? brandTagline.zh : brandTagline.en)
    : tr('logo-tagline')
  /** 欢迎语逐行拆开（单行文案就是一元素）。 */
  const taglineLines = tagline.split('\n')
  // 求 star 改由**本机用量里程碑**触发（累计启动次数 / 累计在线时长），不再每次随机：
  // 跨档时只报最高那一档、每档只报一次（`usageStats` 记账）。`starChance` 退化成测试缝
  // ——0 关掉、非 0 强开（强开时用最高那档的文案）。`DSH_TUI_STAR_LINE=1`
  // 是给人看效果的预览缝：强开标语行且**不记账**（生产不设这个变量）。
  const [starMilestone] = React.useState<number | null>(() => {
    const usage = recordLaunch()
    if (starLinePreview) return STAR_MILESTONES.length - 1
    if (starChance === 0) return null
    if (starChance !== undefined) return STAR_MILESTONES.length - 1
    const pending = pendingStarMilestone(usage)
    // 历史性时刻（99h / 999 次）不走标语行——那两档归 Chat 的开屏弹窗
    //（弹窗自己 markStarAsked）。这里既不画也不记，档位保持待报；
    // 弹窗这轮没机会弹（回合中等）就留给下一次启动。
    return pending !== null && isHistoricMilestone(pending) ? null : pending
  })
  const starLine = starMilestone === null
    ? null
    : splashStarLine({ usage: usageSnapshot(), keyHint: effectiveComboDisplay('star'), caught: starred })
  // 彩蛋的渐显：标题先出，数字一秒后、求星行两秒后各跟一行（只在标语块
  // 出现时播一次；本次会话已 star 过、或重挂时直接展开）。
  const starLineActive = starLine !== null
  const starRevealInstant = starReveal === 'instant'
  const [revealed, setRevealed] = React.useState(() => (starRevealInstant ? 2 : 0))
  React.useEffect(() => {
    if (!starLineActive) return
    if (starRevealInstant || starred === true) {
      setRevealed(2)
      return
    }
    const timers = [
      setTimeout(() => setRevealed(previous => Math.max(previous, 1)), 1000),
      setTimeout(() => setRevealed(previous => Math.max(previous, 2)), 2000),
    ]
    for (const timer of timers) (timer as { unref?: () => void }).unref?.()
    return () => { for (const timer of timers) clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在标语块出现时播一次
  }, [starLineActive])
  // 显示过就把这一档记下来，下次启动不再冒出来（同档只求一次）。预览缝
  // （`DSH_TUI_STAR_LINE=1`）不记账——那是给人看效果的，不该消耗档位。
  React.useEffect(() => {
    if (starMilestone !== null && !starLinePreview) markStarAsked(starMilestone)
  }, [starMilestone])
  // One random tip per mount: the settled header must not re-roll on every
  // repaint (language switch, terminal resize), or the line would flicker.
  // `tip` is a test seam; production always passes undefined and rolls.
  const [randomTip] = React.useState<Tip>(() => tip ?? pickRandomTip())
  // Upstream-drift notice, merged to one line: computed once per mount from
  // the same memoized contract data the adapter checks (undefined when the
  // install matches). `drift` is a test seam to pin or suppress it.
  const [driftLine] = React.useState<UpstreamDriftSummary | null | undefined>(() =>
    drift === undefined ? upstreamDriftSummary() : drift,
  )
  // Indent that centers the tagline under the whale art's bounding box, from
  // the width the line ACTUALLY shows: the star easter egg renders a longer
  // line than `logo-tagline`, so reusing the tagline's width would push it
  // visibly off-center.
  // 多行欢迎语取**最宽行**算宽（居中缩进以此为准，窄行再各自补半差）。
  const welcomeWidth = starLine === null
    ? Math.max(...taglineLines.map(line => stringWidth(line)))
    : starLine.width
  // 居中排版（落地页）交给父级的 `alignItems="center"`，缩进一律为 0；只有
  // 转录区顶部那一版才需要"把标语钉在鲸鱼下方"。这条判据与根盒的
  // `align` 走同一个开关，否则两种对齐会各偏一点。
  const welcomePad = align === 'center'
    ? 0
    : showWhale
      ? Math.max(0, Math.round((portraitMode ? MAID_BOX_CENTER : WHALE_CENTER) - welcomeWidth / 2))
      : 2

  // 两行标题各自用字体声明的字距；下排再按 `bottomIndent` 居中——
  // 两者一起保证画出来的列数相等（见 splashFonts 的 tagline 契约）。
  // 节日彩蛋换的就是这里的两排词（`titleFont` 已按当天词对重解字距）。
  const { top: fontTop, bottom, topKerning, bottomKerning, bottomIndent } = titleFont.tagline
  // 品牌词对经 withTagline 重解后 fontTop 即品牌上排词（含彩蛋日的钉顶）。
  const top = fontTop
  // 大字配色按字体/品牌解析（运行时 `palette`（扩展缝）最优先）：
  // - deepseek：主题 accent → activity → PALE 的蓝白阶（品牌化之前的行为）；
  // - claude：cc-bridge 校过的深橙 → 浅橙，两行同一对端点——第二行终点不再
  //   落到写死的蓝白 PALE；
  // - bevel（半立体）两个品牌都随基色派生亮/暗两档（提亮 / 压暖黑）：字形
  //   自带 █/▓ 明暗笔画，叠上主题色渐变才是"金属受光"。旧版写死的静态灰阶
  //   在任何主题下都像没上色（用户反馈的"灰色字体"）。
  // claude 双主题的大字端点：深底 #D77757 → 淡橙；浅底（claude-paper）反向
  // ——正色压深 #C96442、高光也变深（浅底上"亮"是加深）。bevel 的金属明暗
  // 两档同样以当档基色派生。
  const brandPaper = brand !== 'deepseek' && isLightThemeActive(themeName)
  // 品牌大字色阶（跨两行三档，从左上到右下走完）：claude 陶土橙、codex 薰衣草
  // 紫；深底从亮档起步奔最亮收，浅底反向从深化档起步（浅底上"亮"是加深）。
  // deepseek 不在表内——沿用主题 wordmark/tagline/PALE 的蓝白阶。
  const brandLadder = brand === 'claude'
    ? (brandPaper
        ? { base: EMBER, start: EMBER, mid: EMBER_LIGHT, end: EMBER_BRIGHT, flash: EMBER_PAPER_FLASH }
        : { base: EMBER_LIGHT, start: EMBER_LIGHT, mid: EMBER_BRIGHT, end: EMBER_PALE, flash: EMBER_FLASH })
    : brand === 'codex'
      ? (brandPaper
          ? { base: LAVENDER_PAPER, start: LAVENDER_PAPER, mid: LAVENDER_LIGHT, end: LAVENDER, flash: LAVENDER_PAPER_FLASH }
          : { base: LAVENDER_BRIGHT, start: LAVENDER_BRIGHT, mid: LAVENDER_SOFT, end: LAVENDER_PALE, flash: LAVENDER_FLASH })
      : undefined
  const brandBase = brandLadder?.base ?? wordmarkRGB
  const bevelShade = titleFont.id === 'bevel'
    ? {
        from: interpolateColor(brandBase, { r: 255, g: 255, b: 255 }, 0.45),
        to: interpolateColor(brandBase, { r: 24, g: 18, b: 12 }, 0.55),
      }
    : undefined
  // 扫光高光同族：橙字上扫过蓝光会很脏；claude 深底暖阳高光、浅底深化高光。
  const flash = brandLadder?.flash ?? FLASH
  // claude 渐变是**跨两行的三档色阶**（行一 起→中、行二 中→收），整幅从左
  // 上到右下走完色阶。起点两轮提亮（用户反馈"还是暗"）：深底直接从亮档
  // #E68A69 起步 → #EFA97E → 奶油橙 #FBD6B0（官方正色 #D77757 明度中等、
  // 压深底发闷，只留给浅底当起点）；浅底 #D77757 → #E68A69 → #EFA97E。
  const titleFrom = titleFont.palette?.from
    ?? bevelShade?.from
    ?? brandLadder?.start
    ?? wordmarkRGB
  const titleTopTo = titleFont.palette?.to
    ?? bevelShade?.to
    ?? brandLadder?.mid
    ?? taglineRGB
  const titleBottomFrom = titleFont.palette?.from
    ?? bevelShade?.from
    ?? brandLadder?.mid
    ?? taglineRGB
  const titleBottomTo = titleFont.palette?.to
    ?? bevelShade?.to
    ?? brandLadder?.end
    ?? PALE
  const bigDeepSeek = renderBigText(titleFont, top, t, titleFrom, titleTopTo, flash, 60, topKerning)
  const bigHarness = renderBigText(titleFont, bottom, t, titleBottomFrom, titleBottomTo, flash, 60, bottomKerning, bottomIndent)
  // 立绘槽位的**唯一真源**：文字列的实际行数。full = 词标 1 + 两排大字 +
  // 两排之间空 1 行 + 模型/目录/提示 3 行；minimal = 只有两排大字 + 空行
  //（信息行整块不画，见 chrome prop）。槽位与它等高，图片既不压过文字列
  // 也不留一截在下面（实机反馈「超出去、不和谐」）；大字换字体/换词时也
  // 自动跟着变，不写死数字。
  const textColumnRows = bigDeepSeek.length + bigHarness.length + (chrome === 'minimal' ? 1 : 5)

  return (
    <Box
      ref={ref}
      flexDirection="column"
      marginTop={1}
      {...(align === 'center' ? { alignItems: 'center' } : {})}
    >
      <Box
        flexDirection={arrangement === 'column' ? 'column' : 'row'}
        gap={arrangement === 'column' ? 1 : COLUMN_GAP}
        alignItems="center"
        {...(align === 'center' || arrangement === 'column' ? {} : { width: '100%' })}
      >
        {showWhale && (
          <Box
            flexDirection="column"
            alignItems="center"
            flexShrink={0}
            onClick={(): void => {
              // Frozen (first task started): the whale is a static logo —
              // clicks do nothing. Settled: the layered planner consumes the
              // click on its next tick — run that tick immediately so the
              // heart shows instantly instead of after the current delay.
              // Intro: the whole-frame heart pass above. The maid (raster)
              // reacts with the happy portrait instead of hearts; character-
              // art fallback stays static.
              if (whaleFrozen) return
              if (maidImageActive) {
                reactMaid()
                return
              }
              if (portraitMode) return
              if (settled && whaleIdle) {
                pendingHeartRef.current = true
                tickRef.current?.()
              } else {
                setHeartSeq(0)
                setHeartKey(k => k + 1)
              }
            }}
          >
            {/* 美术本体钳在 WHALE_BOX_WIDTH：文字列几何在所有皮肤形态下与
                鲸鱼形态逐字节一致（tip 行截断/阶梯契约），吉祥物（31 格）在
                盒内居中。 */}
            <Box width={WHALE_BOX_WIDTH} flexDirection="column" alignItems="center">
            {/* claude 品牌档的立绘槽钉死 Claude 娘——吉祥物（deepy/鲸娘皮肤）
                是 DeepSeek 品牌的资产，不跟 claude 档混用。 */}
            {!claudeArt && mascotSkin !== undefined ? (
              <SplashMascot skin={mascotSkin} active={!whaleFrozen && whaleIdle} />
            ) : portraitMode ? (
              // 槽位**与文字列严格等高**（textColumnRows）：真图与字符画女仆
              // 娘共用同一个盒，真图解码完成换画时头部高度不跳，视觉上两者
              // 齐平、谁也不多出一截。真图**不带衬底**（transparent）：立绘
              // 自己裁掉了画布留白，Sixel 只画被她覆盖的像素，终端底色/壁纸
              // 从她周围透出来——以前那块底色是「没有 alpha 只能合成」的旧约束
              // 留下的，现在不需要了。最优先永远是真图，字符画只是协议不可用
              // 时的保底。
              <Box
                width={WHALE_BOX_WIDTH}
                height={textColumnRows}
                flexDirection="row"
                justifyContent="center"
                alignItems="center"
              >
                {maidImageActive ? (
                  <MaidPortrait
                    source={maidHappy ? (portraits?.happy ?? maidSource) : maidSource}
                    maxColumns={WHALE_BOX_WIDTH}
                    maxRows={textColumnRows}
                    presentation="transcript"
                  />
                ) : (
                  claudeArt ? <ClaudeGirlArt width={WHALE_BOX_WIDTH} /> : <WhaleGirlArt width={WHALE_BOX_WIDTH} />
                )}
              </Box>
            ) : (
              <WhaleArt
                frameIndex={frameIndex}
                pose={settled && whaleIdle && !whaleFrozen ? (idlePose ?? RESTING_POSE) : undefined}
                width={WHALE_BOX_WIDTH}
              />
            )}
            </Box>
          </Box>
        )}
        {/* 鲸鱼独占一档（大字放不下、又还得下鲸鱼）：文字列只剩几列，画出来
            只会是 `✦ dsh…` 这种残句——整列不画，开屏就留鲸鱼 + 下面的标语。 */}
        {(showBigTitle || showPlainTitle) && (
          <Box flexDirection="column" flexShrink={1}>
            {/* 词标 + 版本号是 full 形态的信息面：落地页只要品牌本身
                （用户实测反馈「版号可以删掉」），minimal 一行都不画。 */}
            {chrome !== 'minimal' && (
              <Text wrap="truncate-end">
                {sweep('✦ dsh-TUI', t, wordmarkRGB, wordmarkShimmerRGB, 60)}
                <Text dimColor>{'  v' + VERSION}</Text>
              </Text>
            )}
            {showBigTitle ? (
              <>
                {/* 裁掉每行**尾部字距空白**（不可见但计入 Text 宽度）：不裁的话
                    盒子按含尾距的宽度居中，墨迹整体被往左拽 ~tk/2 列（用户点名
                    的居中问题）。行首缩进（bottomIndent）不动，SGR 由行尾 reset
                    序列收尾、不会被误伤。 */}
                {bigDeepSeek.map((row, index) => (
                  <Text key={`ds-${index}`} wrap="truncate-end">
                    {row.replace(/\s+$/u, '')}
                  </Text>
                ))}
                <Box height={1} />
                {bigHarness.map((row, index) => (
                  <Text key={`h-${index}`} wrap="truncate-end">
                    {row.replace(/\s+$/u, '')}
                  </Text>
                ))}
              </>
            ) : (
              showPlainTitle && (
                <Text color="accent" bold wrap="truncate-end">
                  {words.plain}
                </Text>
              )
            )}
            {/* 模型/effort、工作目录、启动提示、漂移告警同上：这些是
                「我在哪、用哪个模型」的答案，属于对话页开屏；落地页要留白
                （用户实测反馈「工作目录、tip 可以删掉」）。 */}
            {chrome !== 'minimal' && (
              <>
                <Text wrap="truncate-end">
                  {model}
                  {effort !== undefined && <Text dimColor>{' · ' + capitalize(effort) + ' effort'}</Text>}
                </Text>
                <Text dimColor wrap="truncate-end">
                  {cwd}
                </Text>
                <Text wrap="truncate-end">
                  <Text dimColor>{tr('logo-tip-prefix')}</Text>
                  {getLang() === 'zh' ? randomTip.zh : randomTip.en}
                  <Text dimColor>{' · /tips ' + tr('logo-tip-more')}</Text>
                </Text>
              </>
            )}
            {chrome !== 'minimal' && driftLine != null && (
              <Text color="warning" wrap="wrap">
                ⚠{' '}
                {tOr(
                  `logo-drift-${driftLine.kind}`,
                  `The dsh engine (${driftLine.versions.join(' / ')}) does not match the validated ${UPSTREAM_VALIDATED_VERSION}; reinstall via npm i -g @deepseek-ai/dsh@${UPSTREAM_VALIDATED_VERSION}.`,
                  {
                    installed: driftLine.versions.join(' / '),
                    validated: UPSTREAM_VALIDATED_VERSION,
                    primary: UPSTREAM_VALIDATED_VERSION,
                  },
                )}
              </Text>
            )}
          </Box>
        )}
      </Box>
      {/* 求 star 彩蛋整块可点：点一下 = 一次一键 star（与 `/star`、`Alt+S`
          同一个动作；终端里按 Ctrl/Cmd 点 `Star` 那几个字才是开浏览器）。
          平时那句欢迎语不可点——只有彩蛋在邀请用户。 */}
      {/* minimal 形态平时整块不画：落地页版面只要「图 + 大字」，欢迎语在
          那边曾与落地页自己的一行重复（用户实测「重复了两次 删掉」）；
          求 star 里程碑出现时仍画那几行——里程碑露出不因落地页改版而丢。 */}
      {(chrome !== 'minimal' || starLine !== null) && (
      <Box flexDirection="column" marginTop={1} {...(starLine === null || onStarClick === undefined ? {} : { onClick: onStarClick })}>
        {starLine === null ? (
          // 多行欢迎语（claude 品牌英文 slogan 是两行）：`center` 版式交给
          // 父级逐行居中；`start` 版式在立绘中线下**块内居中**——窄行补半差，
          // 两行的中轴对齐而不是左缘对齐。
          taglineLines.map(line => (
            <Box
              key={line}
              paddingLeft={align === 'center'
                ? 0
                : welcomePad + Math.max(0, Math.round((welcomeWidth - stringWidth(line)) / 2))}
            >
              <Text>{sweep(line, t, taglineRGB, flash, 60)}</Text>
            </Box>
          ))
        ) : (
          <>
            <Box paddingLeft={welcomePad}>
              <Text>{sweep(starLine.title, t, taglineRGB, flash, 60)}</Text>
            </Box>
            {revealed >= 1 && (
              <Box paddingLeft={welcomePad}>
                <Text dimColor>{starLine.stats}</Text>
              </Box>
            )}
            {revealed >= 2 && starred !== true && starLine.ask !== null && (
              <Box paddingLeft={welcomePad}>
                <Text>{starLine.ask}</Text>
              </Box>
            )}
          </>
        )}
      </Box>
      )}
    </Box>
  )
}
