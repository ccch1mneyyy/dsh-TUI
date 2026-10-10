import React from 'react'
import { unlink } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { Box, Text, useInput, useTerminalSize, useNativeCursor } from '../ui.js'
import { SearchBox } from '../components/SearchBox.js'
import { OverlayAbove } from '../components/OverlayAbove.js'
import { CommandSuggestions } from '../components/CommandSuggestions.js'
import type { CommandCompletion } from '../commands.js'
import { LogoV2 } from '../components/LogoV2.js'
import type { Brand } from '../branding.js'
import { resolveLaunchpadLayout, type LaunchpadLayout } from '../components/launchpadLayout.js'
import { type LaunchpadAction } from '../components/launchpadActions.js'
import { kernelSubtitle, type KernelOption } from '../components/kernelCatalog.js'
import { fitParamParts, PARAM_SEPARATOR } from '../components/launchpadParams.js'
import { useTooltip } from '../components/Tooltip.js'
import { resolveSplashTitleFont, pickSplashFont, splashFontById, type SplashFont } from '../components/splashFonts.js'
import { pickSplashEgg, type SplashEgg } from '../components/splashEggs.js'
import { t } from '../i18n.js'
import { isMinimalUiMode } from '../minimalUiMode.js'
import { stringWidth } from '../ink/stringWidth.js'
import { isMod, isPlainReturn } from '../utils/modifiers.js'
import { actionMatches } from '../utils/keymap.js'
import { formatClipboardInsert, readClipboard, type ClipboardRead } from '../utils/clipboard.js'
import { imagePathMediaType, parsePastedImagePath, readBoundedRegularFile, stageClipboardFilePaths } from '../utils/pastedImagePath.js'
import type { ChannelUi } from '../adapter/channel/ui-policy.js'
import { resolveBindingGeneration } from '../components/promptDraftCache.js'
import { imageTokenSpans, snapOffImageToken, expandImageTokenRange } from '../components/composerImageTokens.js'
import {
  collapseToSingleLine,
  insertSingleLineAt,
  matchesPasteShortcut,
  stripBracketedPasteMarkers,
} from '../utils/inputPaste.js'
import type { ClickEvent } from '../ink/events/click-event.js'

/** 动作入口的类型与状态驱动纯函数在 `launchpadActions.ts`（第四版拆出，表驱动回归在那边）。 */
export type { LaunchpadAction } from '../components/launchpadActions.js'

/** 光标闪烁一个相位的毫秒数（用户要求 500–600ms 一相位）。 */
const CARET_BLINK_MS = 550

/**
 * 纯文字入口（2026-10 第六版修订：用户否掉了背景方块高亮——"高光有点 low 而且
 * 鼠标移开之后居然不会消失，我希望换成字体高光，比如移到字体上变蓝加粗"）。
 *
 * - 入口只渲染**一个标签文本**（无键位前缀、无边框、无指针字符 ❯）；
 * - 悬停/焦点 = **文字高光**：主题蓝（suggestion）+ 加粗，不再铺背景方块；
 *   未悬停时就是普通 dim 文字；
 * - **移入/移出都要复原**（上一版的真 bug）：`onMouseEnter` 悬停并带焦点，
 *   `onMouseLeave` 撤悬停；焦点是悬停带进来的（`focused` 为真）就一并交还
 *   输入框——否则"hover 设了焦点、离开没人清"，高亮就赖着不走了；
 * - **恒 1 行高**：标签是纯字符串、单个 Text 渲染，绝无"键帽一行/标签一行"
 *   上下分离（上一版嵌套 span 在真终端上被实测抓到竖排成两行）；
 * - 鼠标契约照仓库规矩：挂得上 `onClick` 才给 hover 反馈；点击
 *   `stopImmediatePropagation`（整页有"点空白收回焦点"的兜底 handler，
 *   不拦住会既执行动作又清焦点）。
 */
function ActionChip({
  label,
  focused,
  onActivate,
  onHover,
  onHoverLeave,
}: {
  label: string
  focused: boolean
  onActivate: () => void
  onHover: () => void
  /** 移出时若焦点是悬停带进来的，交还输入框（BUG 2：移开必须复原）。 */
  onHoverLeave: () => void
}): React.ReactNode {
  const [hovered, setHovered] = React.useState(false)
  const active = hovered || focused
  return (
    <Box
      flexShrink={0}
      height={1}
      onMouseEnter={() => { setHovered(true); onHover() }}
      onMouseLeave={() => { setHovered(false); onHoverLeave() }}
      onClick={(event: ClickEvent) => {
        event.stopImmediatePropagation()
        onActivate()
      }}
    >
      {/* 单个 Text、纯字符串子节点；两侧各一格空格只是间距（fitChips 的宽度
          预算同源 +2），不再是背景方块的内边距。 */}
      <Text
        color={active ? 'suggestion' : undefined}
        bold={active}
        dimColor={!active}
      >
        {` ${label} `}
      </Text>
    </Box>
  )
}

/**
 * 参数行的四段身份（第五版：四段各自可点，点开 Chat 既有的选择器 overlay；
 * 第六版设计 1：`mode` 段换成 `preset`——用户说的"模式"是 Standard/PTC/极简
 * 那套 agent preset（channel.agentPreset + /preset 名册），不是 plan/act）。
 */
export type LaunchpadParamSegment = 'model' | 'effort' | 'preset' | 'permission'

/** 焦点环里参数段的编码：-2 起按显示顺序递减（-1 是输入框，0.. 是动作入口）。 */
const paramFocusOf = (segment: LaunchpadParamSegment): number => -2 - PARAM_SEGMENT_ORDER.indexOf(segment)
/** 焦点值反解参数段；-1（输入框）与动作入口（≥0）都返回 undefined。 */
function segmentOfFocus(focus: number): LaunchpadParamSegment | undefined {
  return focus <= -2 && focus > TIPS_FOCUS ? PARAM_SEGMENT_ORDER[-2 - focus] : undefined
}
/**
 * Tips 行在焦点环里的编码（第六版设计 2）：参数段最深到 -5，Tips 取 -6。
 * 键盘路径是仓库硬规矩——Tips 可点击轮换，就必须有不含鼠标的等价操作
 * （焦点落到 Tips 行 + Enter = 切下一条，与点击同一条 rotateTip）。
 */
const TIPS_FOCUS = -6
/**
 * 左下角工作目录铭牌在焦点环里的编码（第七版）：Tips 之后、环的最后一格。
 * 铭牌可点开工作区切换，键盘路径走焦点环 + Enter（仓库硬规矩：每个可点
 * 目标都要有不含鼠标的等价操作；复用环而不是另绑一个键，焦点环的语义
 * （↑/↓/Tab 与版面顺序一致）自动覆盖它）。
 */
const CWD_CORNER_FOCUS = -7
/**
 * 右下角内核区在焦点环里的编码（第八版）：目录铭牌之后再一格，环的最后一格。
 * 内核区整块可点（点开内核选择器），键盘路径走同一格 + Enter——仓库硬规矩：
 * 每个可点目标都要有不含鼠标的等价操作。它在版面上就在最底（比目录铭牌更靠
 * 右下），所以排在 CWD_CORNER_FOCUS 之后。
 */
const KERNEL_CORNER_FOCUS = -8
/** Tips 自动轮换的默认间隔（第七版：用户要「呼吸感」；手动切换后计时重置）。 */
const TIP_ROTATE_MS = 10_000
/** 参数段固定显示顺序（模型 · 思考深度 · 模式(preset) · 权限）。 */
const PARAM_SEGMENT_ORDER: readonly LaunchpadParamSegment[] = ['model', 'effort', 'preset', 'permission']

/**
 * 参数行的一个可点段（第五版；第六版与 ActionChip 同步改成文字高光）：
 * 同一套鼠标契约——挂得上 onClick 才给 hover 提亮；点击
 * stopImmediatePropagation（不触发整页的收回焦点兜底）；悬停/焦点 =
 * 该段文字变主题蓝 + 加粗（不铺背景方块），宽度不变（不加内边距，
 * 参数行的宽度预算按原文算）；onMouseLeave 复原并交还悬停带进的焦点
 * （与 ActionChip 的 BUG 2 修复同一条规则）。
 *
 * AC-4（第八版）：段被**尾部截断**时（`…` 在屏上、完整名看不见），hover
 * 走仓库既有的 Tooltip 单例层——dwell 600ms 后弹出完整名。两个鼠标手势
 * **手动组合**（`useTooltip` 只返回它自己的一对 handler，直接覆盖会丢掉
 * 高亮与焦点收回）：进入 = 高亮 + 记焦点 +（被截断才）起计时，离开 =
 * 复原高亮 + 交还焦点 + 撤卡片——成对写在一起，第五版 BUG 2「高亮赖着
 * 不走」那类回归没有缝隙可钻。未截断的段手势照旧（高亮/点击/焦点）但
 * **连计时都不起**（与 Tooltip.tsx 头部「只给真的被隐藏的文本挂」同一条
 * 契约），所以完整名在屏上时不会有浮层风险。
 *
 * F-04（T-FIX-03）：撤卡**不只**挂在 pointer-leave 上——**激活**也显式撤
 * （点击，以及键盘焦点环上的 Enter 走 `onParamPick` 的那条）。否则 hover 出卡
 * 后换一段激活，卡片会停在选择器之上、内容还是上一段的完整名（误导）。指针
 * **仍停在段上**时的保留属 tooltip 的既有语义，这里不动：撤的是"这一次激活"
 * 留下的卡片，下一次真正的 mouseenter 照常按 dwell 出卡。
 */
function ParamChip({
  label,
  fullValue,
  truncated,
  colored,
  focused,
  activationNonce,
  onActivate,
  onHover,
  onHoverLeave,
}: {
  label: string
  /** 完整名（截断前的原值）——只有 `truncated` 为真时它才上卡片。 */
  fullValue: string
  /** 本段是否被尾部截断（AC-4：未截断的段不接 tooltip 手势，只走既有高光）。 */
  truncated: boolean
  /** 模型段常亮浅紫（autoAccept）；其余段默认 dim。 */
  colored?: boolean
  focused: boolean
  /**
   * 键盘激活（焦点环 Enter）信号：每被激活一次 +1，只喂给**刚被激活的那一段**。
   * 点击路径在下面的 `onClick` 里就地撤卡，不需要它；键盘路径的 Enter 由屏级
   * `useInput` 处理，本组件只被"通知"。
   */
  activationNonce?: number
  onActivate: () => void
  onHover: () => void
  /** 移出时若焦点是悬停带进来的，交还输入框（BUG 2：移开必须复原）。 */
  onHoverLeave: () => void
}): React.ReactNode {
  const [hovered, setHovered] = React.useState(false)
  const active = hovered || focused
  // 内容恒为完整名，**是否接手势**由 `truncated` 自己门控（见下面的 handler）：
  // 未截断的段连 dwell 计时都不起，不依赖单例层"空内容不画卡片"的内部约定
  // ——那条约定改天变了也不该由本屏承担。
  const tooltip = useTooltip(fullValue)
  // F-04：键盘激活的撤卡。首渲染把当前值记为基准（`nonce === 基准` 时不动），
  // 之后只在**变化**时撤一次——连续两次 Enter 也各算一次变化。`tooltip` 是
  // `useTooltip` 的 memo 返回值（依赖 `[owner, delayMs]`），所以这条 effect
  // 不会每次渲染都跑。
  const lastActivation = React.useRef(activationNonce ?? 0)
  React.useEffect(() => {
    const nonce = activationNonce ?? 0
    if (nonce === lastActivation.current) return
    lastActivation.current = nonce
    tooltip.onMouseLeave()
  }, [activationNonce, tooltip])
  return (
    <Box
      flexShrink={0}
      height={1}
      onMouseEnter={(event) => {
        setHovered(true)
        onHover()
        // 只有被截断的段才起计时（AC-4：完整名已在屏上时挂卡片是噪音）。
        if (truncated) tooltip.onMouseEnter(event)
      }}
      onMouseLeave={() => {
        setHovered(false)
        onHoverLeave()
        // 离开**恒**撤：进出的两个手势成对，任何误挂的卡片都不许赖着不走
        // （第五版 BUG 2 的同族失败模式）。
        tooltip.onMouseLeave()
      }}
      onClick={(event: ClickEvent) => {
        event.stopImmediatePropagation()
        // F-04：激活即撤卡——只挂 pointer-leave 时，点开这一段的选择器后卡片
        // 会停在它之上（且内容可能还是上一段的完整名）。指针仍停在段上时的
        // 保留属 tooltip 既有语义，这里撤的是"这一次激活"留下的卡片。
        tooltip.onMouseLeave()
        onActivate()
      }}
    >
      <Text
        color={active ? 'suggestion' : colored ? 'autoAccept' : undefined}
        bold={active || colored === true}
        dimColor={!active && colored !== true}
      >
        {label}
      </Text>
    </Box>
  )
}

/**
 * 左下角工作目录铭牌（第七版：可点开工作区切换）。样式契约与 ActionChip/
 * ParamChip 同一套——悬停/焦点 = **文字高光**（主题蓝 + 加粗，不铺背景方块），
 * 恒 1 行高，截断仍走 truncate-middle（窄屏不撑爆）；点击拦住冒泡（不是
 * 「点空白」）；键盘路径 = 焦点环（环的末格）+ Enter，与点击同一条回调。
 */
function CornerChip({
  label,
  focused,
  onActivate,
  onHover,
  onHoverLeave,
}: {
  label: string
  focused: boolean
  onActivate: () => void
  onHover: () => void
  onHoverLeave: () => void
}): React.ReactNode {
  const [hovered, setHovered] = React.useState(false)
  const active = hovered || focused
  return (
    <Box
      flexShrink={1}
      height={1}
      onMouseEnter={() => { setHovered(true); onHover() }}
      onMouseLeave={() => { setHovered(false); onHoverLeave() }}
      onClick={(event: ClickEvent) => {
        event.stopImmediatePropagation()
        onActivate()
      }}
    >
      <Text
        color={active ? 'suggestion' : undefined}
        bold={active}
        dimColor={!active}
        wrap="truncate-middle"
      >
        {label}
      </Text>
    </Box>
  )
}

/**
 * 右下角内核区（第八版）：列出可选内核并标出记住的那个。第一行 TUI 版本不动，其后一行一个内核
 * ——当前内核打 `▸ ` 前缀、保持主题蓝；其余行前缀两格空格、文字 dim（前缀等宽
 * 让名字对齐）。行文本 = `短品牌名 · 副标题`（名字取 manifest 的 shortLabel：DSH /
 * Claude——全名 40 列会挤掉左下角的目录铭牌；副标题 = 版本 / 置灰原因，缺席就
 * 只画名字，见 kernelCatalog 的 kernelSubtitle）。目标形状：
 *
 *     ```text
 *                                              dsh-tui v0.12.0
 *                                ▸ DSH · dsh-core v0.2.0-rc.2
 *                                  Claude · claude-code v2.1.284
 *     ```
 *
 * **整块是一个可点目标**（点开内核选择器）：点击 stopImmediatePropagation——
 * 这一屏有「点空白收回焦点」的 handler，不拦住会既开选择器又清焦点；
 * 悬停/焦点高亮照 CornerChip 那套（主题蓝 + 加粗，未激活时只有当前内核行是
 * 主题蓝、其余行 dim）。键盘路径 = 焦点环的 KERNEL_CORNER_FOCUS + Enter，与
 * 点击同一条回调。没接 onKernelPick 时整块不挂鼠标事件（挂得上 onClick 才给
 * hover 反馈，与 ActionChip/CornerChip 一致），也不进焦点环。
 */
function KernelCorner({
  rows,
  focused,
  onActivate,
  onHover,
  onHoverLeave,
}: {
  rows: readonly { id: string; current: boolean; label: string }[]
  focused: boolean
  /** 缺席 = 不可点（也不给 hover 反馈）。 */
  onActivate: (() => void) | undefined
  onHover: () => void
  onHoverLeave: () => void
}): React.ReactNode {
  const [hovered, setHovered] = React.useState(false)
  const interactive = onActivate !== undefined
  const active = interactive && (hovered || focused)
  return (
    // 外层整行右推（块贴右缘，与 TUI 版本那一行同一条右边界），内层左对齐：
    // 行内两格前缀（▸ + 空格 / 两个空格）于是成了**标记列**——几个内核的名字
    // 从同一列开始，箭头只多占最左边那两格。可点目标是内层这个真的画了字的
    // 块（不是整行空白），与 CornerChip 的收缩形态一致。
    <Box flexShrink={0} flexDirection="row" justifyContent="flex-end">
      <Box
        flexDirection="column"
        alignItems="flex-start"
        {...(interactive
          ? {
              onMouseEnter: () => { setHovered(true); onHover() },
              onMouseLeave: () => { setHovered(false); onHoverLeave() },
              onClick: (event: ClickEvent) => {
                event.stopImmediatePropagation()
                onActivate?.()
              },
            }
          : {})}
      >
        {rows.map(row => (
          <Box key={row.id} flexDirection="row" height={1}>
            <Text
              color={row.current ? 'suggestion' : undefined}
              bold={active}
              dimColor={!row.current && !active}
              wrap="truncate-middle"
            >
              {(row.current ? '\u25b8 ' : '  ') + row.label}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

/**
 * Launchpad —— 每次启动的第一屏（取代旧的"只有鲸鱼标题的空白会话"）。
 *
 * 它**不是一个新页面**：整块视觉核心仍然是 `LogoV2`（像素鲸鱼 / 女仆娘立绘、
 * 块体 `DEEPSEEK`/`HARNESS` 大字、节日换词、求 star 彩蛋——一套代码），但走
 * `LogoV2` 的 chrome="minimal" 极简形态并 align="center"：只有立绘与大字，
 * 版号/模型/工作目录/启动提示/欢迎语一概不画（用户实测要求 opencode 式
 * 留白；欢迎语曾经和落地页自己的一行重复，两处一起删）。
 *
 * 版面（2026-10 第三版改版）：**头部 + 输入框 + 框下成组三行**整块水平垂直
 * 双居中，不再把提示行钉到屏幕底部、中间不留大空档：
 *
 *   - 输入框（圆角边框）里**只有输入那一行**；
 *   - 紧贴框下方一行**参数行**（左对齐输入框）：`模型 · 思考深度 · 模式 · 权限`，
 *     四段缺哪段省哪段、全空整行不画；模型段**只显示模型名**（不带 provider/
 *     前缀）且带浅紫主题色（autoAccept）；第五版起四段**各自可点**，点开 Chat
 *     既有的选择器（overlayPanel 盖在本屏之上，选中值就地更新这一行）；
 *   - 隔一行呼吸留白（矮屏阶梯可撤，见 launchpadLayout）再一行**键帽按钮**
 *     （整行右对齐，与输入框右缘对齐）；
 *   - 再下一行 **`● Tips：`**（居中，圆点橙色 warning）。
 *
 * 屏幕最底的双角铭牌（左 `cwd:branch`、右下 `dsh-tui v…` + **内核区**）保留：
 * 第八版起右下第一行仍是 TUI 版本，其后一行一个可选内核——当前内核打 `▸ ` 且
 * 主题蓝，其余行 dim；整块可点（键盘等价操作 = 焦点环末格 + Enter）。
 *
 * **输入框在这一屏是唯一有状态的部件**：用户敲进去的东西必须原样带进聊天页，
 * 否则"第一屏输入的字"就被这一屏吞了。第六版起行首 `/` 会弹出**命令补全面板**
 * （`commands`/`onCommandPick` 两缝，数据与组件都与聊天页 composer 同源），
 * Tab 补全到输入框，Enter/点击执行并清空输入；面板收起时整行原样交给 `onSubmit`，由 `Chat`
 * 走它既有的命令表判定（合并命令表，含 registry 命令）再决定 runCommand 或
 * 发送。本地只读一点：行首是不是 `/`，用来把输入框左边的提示符从 `❯` 换成
 * `⌘`。
 *
 * TTY 输入使用终端原生光标，闪烁与动画继承终端配置。无原生光标的
 * 呈现环境保留约 550ms 的样式闪烁；相位不增删字符、不挪动文本。
 *
 * 居中与降级：宽度走 `resolveSplashLayout` 那一套（与开屏同源，阈值不会漂），
 * 高度走 `resolveLaunchpadLayout`（整块撤：Tips → 键帽行 → 立绘 → 只留输入框）。
 *
 * 鼠标：`onClick`/`onMouseEnter` 只在 `<AlternateScreen>` 里触发，内联模式
 * 天然没有它们，所以每个可点目标都必须有一条键盘路径（这里全部有：焦点 +
 * Enter）。
 */
export function Launchpad({
  query,
  cursorOffset,
  focusIndex,
  isTerminalFocused,
  whale,
  whaleIdle,
  whaleGirl,
  brand,
  fontId,
  egg,
  starred,
  onStarClick,
  firstRun,
  actions,
  overlayPanel,
  inputPaused = false,
  onParamPick,
  model,
  effort,
  preset,
  permission,
  commands,
  onCommandPick,
  clipboardReader = readClipboard,
  imageComposer,
  /** Tips 自动轮换间隔（第七版；测试缝：无头回归注入短间隔确定性驱动相位）。 */
  tipRotateMs = TIP_ROTATE_MS,
  /** 左下角工作目录铭牌被点击/回车时交给 Chat（开既有的 /workspace 工作区菜单）。 */
  onOpenWorkspace,
  /** 右下角内核区的目录行（第八版：一行一个内核，当前那个打 ▸）。 */
  kernels,
  /** 右下角内核区被点击/焦点环 Enter 时交给 Chat（打开内核选择器）。 */
  onKernelPick,
  cwd,
  branch,
  tuiVersion,
  onFocusChange,
  onAction,
  onQueryChange,
  onSubmit,
  onEscape,
  onBlankClick,
}: {
  /** 输入框里的原文（由 Chat 持有——这一屏卸载后它还要活到聊天页）。 */
  query: string
  /** 光标在 `query` 里的 UTF-16 偏移（`SearchBox` 的 `cursorOffset`）。 */
  cursorOffset?: number
  /** 快捷入口的焦点行下标；`-1` 表示焦点在输入框。 */
  focusIndex: number
  isTerminalFocused: boolean
  whale: boolean
  whaleIdle: boolean
  whaleGirl: boolean
  /** 品牌档（当前后端 → `resolveBrand`；见 `branding.ts`）。 */
  brand?: Brand
  fontId?: string | undefined
  /** 测试缝：固定节日词对；null 关闭换词，undefined 按本地日期选择。 */
  egg?: SplashEgg | null
  starred: boolean
  onStarClick?: () => void
  /** 引导还没跑过：Tips 换成首启那一句（动作表本身已由 resolveLaunchpadActions 状态驱动）。 */
  firstRun: boolean
  /**
   * 状态驱动的动作表（第四版）：`Chat` 用真实状态快照解出
   * `resolveLaunchpadActions(state)` 再传进来——这一屏只负责画与交互，
   * 不自己猜"下一步是什么"。恒 ≤4 条；`theme`/`lang`/`settings` 永不在表里。
   */
  actions: readonly LaunchpadAction[]
  /**
   * 盖在落地页之上的选择器面板（第五版）：Chat 把它既有的 picker overlay
   * （/model · /effort · /plan · /permission 那套）原样传进来，本屏只负责
   * 挂载位置——OverlayAbove 锚在输入框卡片顶边、向上展开，选择器吃键盘
   *（见 `inputPaused`），Esc 关掉它回到落地页，选中的值就地更新参数行。
   * 不传 = 没有选择器在开（正常落地页形态）。
   */
  overlayPanel?: React.ReactNode
  /**
   * 选择器盖在落地页之上时为 true：本屏的 useInput 整块让位（选择器的按键
   * 由 Chat 的 overlay 分支处理；未消费的键不许漏进草稿）。
   */
  inputPaused?: boolean
  /**
   * 参数行四段被点击/回车时交给 Chat 的段身份（第五版）。Chat 把它映射到
   * 既有命令（model→/model、effort→/effort、preset→/preset、permission→
   * /permission），打开的就是聊天页同款选择器——本屏不自己造选择器。
   */
  onParamPick?: ((segment: LaunchpadParamSegment) => void) | undefined
  /**
   * 框下参数行的四段（第三版：参数行移出输入框、紧贴框下方，左对齐输入框）：
   * 模型（**只显示模型名**，不带 provider/ 前缀——第五版用户要求「两个都放
   * 太长了」）、思考深度（effort）、模式（第六版设计 1：agent preset 的
   * 显示名，如 Standard/PTC/极简——`Chat` 读 `channel.agentPreset` 那套）、
   * 权限（permission preset 当前身份）。任一段拿不到就省掉那一段，全拿不到
   * 就整行不画（成组行矮一行，见 `resolveLaunchpadLayout` 的 `params`）。
   */
  model?: string | undefined
  effort?: string | undefined
  /** 当前 agent preset 的显示名（Standard/PTC/极简…）；缺省不画那一段。 */
  preset?: string | undefined
  /** 当前权限预设名（`Chat` 读 `channel.permissionPresets()` 的当前身份）；缺省不画。 */
  permission?: string | undefined
  /**
   * 命令补全面板的数据源（第六版 BUG 1）：行首 / 时 Chat 传
   * `channel.commandCompletions(query)` 的结果进来——与聊天页 composer 的
   * 补全**同一个来源、同一个组件**（CommandSuggestions），本屏不另造一套。
   * 不传（或空数组）= 不画面板（孤立回归夹具的默认形态）。
   */
  commands?: readonly CommandCompletion[] | undefined
  /**
   * 补全面板选中一条（Enter/点击）时交给 Chat 的**完整命令行**
   * （如 /setup）。普通命令经 runCommand 执行，模型路由技能作为消息
   * 提交；拒绝时返回提示并保留草稿。
   */
  onCommandPick?: ((commandLine: string) => string | void) | undefined
  /**
   * 剪贴板读取缝（测试打桩用；生产走 `utils/clipboard` 的 `readClipboard`，
   * Chat 不传这一项）。签名与 `readClipboard` 一致。
   */
  clipboardReader?: () => Promise<ClipboardRead>
  /** Chat owns the bindings so attachments survive a full-screen round trip. */
  imageComposer?: { channel: ChannelUi; bindings: Map<string, string> }
  /** Tips 自动轮换间隔（第七版；测试缝，生产用默认 10s）。 */
  tipRotateMs?: number
  /** 左下角工作目录铭牌被点击/焦点环 Enter 时交给 Chat（开 /workspace 菜单）。 */
  onOpenWorkspace?: (() => void) | undefined
  /**
   * 右下角内核区的目录行（第八版：`buildKernelCatalog` 的产物，数组顺序即
   * 显示顺序）；缺省（或空数组）= 右侧只有 TUI 版本那一行——绝不编造内核号，
   * 也不再单独传一个内核版本号（版本已经进了每一行）。
   */
  kernels?: readonly KernelOption[] | undefined
  /**
   * 内核区被点击 / 焦点环 Enter 时交给 Chat（打开内核选择器）。键盘路径是
   * 仓库硬规矩：给了它，焦点环才多出 KERNEL_CORNER_FOCUS 那一格。
   */
  onKernelPick?: (() => void) | undefined
  /** 双角铭牌：左下角的工作路径与分支。 */
  cwd?: string | undefined
  branch?: string | undefined
  /** 双角铭牌：右下第一行的 TUI 版本号（其后是 kernels 的内核区）。 */
  tuiVersion?: string | undefined
  onFocusChange: (index: number) => void
  onAction: (action: LaunchpadAction) => void
  /** 输入框内容变化（含光标位置）。 */
  onQueryChange: (text: string, cursor: number) => void
  /** 提交：交给 Chat 分派；拒绝时返回提示并保留草稿。 */
  onSubmit: (text: string) => string | void
  /** 空输入时按 Esc / `Ctrl+C`：`sessions` 去看会话，`exit` 走双击退出漏斗。 */
  onEscape: (intent: 'sessions' | 'exit') => void
  /** 点空白处：把焦点收回输入框（不是提交、不是关闭）。 */
  onBlankClick: () => void
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  // `columns`/`rows` 已经是**内容区**尺寸（PageMargin 收窄过 context），
  // 所以这里不再减页边距——与 splashLayout 的约法一致。
  // 光标偏移只在"输入框有焦点"时才有意义；未给（或焦点在快捷入口行）时
  // 一律按行尾算——这与 `SearchBox` 自己的 `cursorOffset ?? query.length`
  // 同一条约定，两处必须一致，否则退格会从"看不见的位置"删字。
  const boundImageSpans = (text: string) => imageTokenSpans(text).filter(span => imageComposer?.bindings.has(span.token) === true)
  const imageSpans = boundImageSpans(query)
  const caret = snapOffImageToken(imageSpans, focusIndex === -1 ? (cursorOffset ?? query.length) : query.length, 'nearest')
  /** 焦点是否在输入框上（-1）；参数段（≤-2）与动作入口（≥0）都不算。 */
  const inputFocused = focusIndex === -1

  // ── 命令补全面板（第六版 BUG 1）──────────────────────────────────────────
  // 与聊天页 composer 同一套契约：行首 / + 有候选 → 面板上屏；↑/↓ 移选中、
  // Tab 补全到输入框，Enter/点击执行并清空输入、Esc 只收面板（用户可能只是想
  // 看一眼）。`dismissedFor` 记住"这条 query 被收过"：Esc 之后继续打字
  // （query 变了）面板自然回来，与 PromptInput 的补全行为同源。
  const [paletteIndex, setPaletteIndex] = React.useState(0)
  const [paletteDismissedFor, setPaletteDismissedFor] = React.useState('')
  const paletteCommands = commands !== undefined && query.startsWith('/') && query !== paletteDismissedFor
    ? commands
    : []
  const paletteOpen = inputFocused && paletteCommands.length > 0 && onCommandPick !== undefined
  const paletteSelectedIndex = Math.min(paletteIndex, Math.max(0, paletteCommands.length - 1))
  const paletteSelected = paletteCommands[paletteSelectedIndex]
  const pickCommand = (commandLine: string): void => {
    setPaletteDismissedFor('')
    setPaletteIndex(0)
    const notice = onCommandPick?.(commandLine)
    if (typeof notice === 'string') showPasteNotice(notice)
    else pasteRevisionRef.current += 1
  }

  // ── Tips 轮换（第六版设计 2）─────────────────────────────────────────────
  // 轮换顺序（注释即契约）：launchpad-tip → launchpad-tip-2 → launchpad-tip-3
  // → 回到 launchpad-tip。首启（launchpad-first-run）**优先级最高**：firstRun
  // 为真时整行只显示那一句、不参与轮换（引导没跑完之前别的 Tips 都是噪音）。
  // 点击 Tips 行或把焦点落到 Tips（Enter）都切下一条。
  const TIP_KEYS = ['launchpad-tip', 'launchpad-tip-2', 'launchpad-tip-3'] as const
  const [tipIndex, setTipIndex] = React.useState(0)
  const rotateTip = (): void => { setTipIndex(index => (index + 1) % TIP_KEYS.length) }

  // 粘贴的异步落点：剪贴板读回是异步的，读取期间用户可能继续打字——插入必须
  // 用**当时最新**的 query/caret（PromptInput 用 revision 守同一条；这里没有
  // 本地 state，用每次渲染刷新的 refs 守），不能吃按键那一刻的闭包旧值。
  const queryRef = React.useRef(query)
  queryRef.current = query
  const caretRef = React.useRef(caret)
  caretRef.current = caret
  const changeQuery = (text: string, offset: number): void => {
    const nextCaret = snapOffImageToken(boundImageSpans(text), offset,
      offset < caretRef.current ? 'start' : offset > caretRef.current ? 'end' : 'nearest')
    queryRef.current = text
    caretRef.current = nextCaret
    onQueryChange(text, nextCaret)
  }
  const deleteRange = (start: number, end: number): void => {
    const text = queryRef.current
    const range = expandImageTokenRange(boundImageSpans(text), start, end)
    changeQuery(text.slice(0, range.start) + text.slice(range.end), range.start)
  }
  const clipboardBusyRef = React.useRef(false)
  const pasteRevisionRef = React.useRef(0)
  const mountedRef = React.useRef(true)
  const imageChainRef = React.useRef<Promise<void>>(Promise.resolve())
  React.useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const capturePasteLease = () => {
    const revision = pasteRevisionRef.current
    const channel = imageComposer?.channel
    const agentId = channel?.agentId
    const generation = channel === undefined ? 0 : resolveBindingGeneration(channel)
    const imageGeneration = channel?.stagedImageGeneration?.() ?? 0
    return {
      imageGeneration,
      isCurrent: () => mountedRef.current && revision === pasteRevisionRef.current
        && (channel === undefined || (channel.agentId === agentId
          && resolveBindingGeneration(channel) === generation
          && (channel.stagedImageGeneration?.() ?? 0) === imageGeneration)),
    }
  }
  /** 粘贴提示：落地页没有 toast 基础设施，借 Tips 行显示 4 秒（失败不能静默）。 */
  const [pasteNotice, setPasteNotice] = React.useState<string | undefined>(undefined)
  const noticeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const showPasteNotice = (message: string): void => {
    setPasteNotice(message)
    if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current)
    const timer = setTimeout(() => {
      noticeTimerRef.current = null
      setPasteNotice(undefined)
    }, 4000)
    ;(timer as { unref?: () => void }).unref?.()
    noticeTimerRef.current = timer
  }
  React.useEffect(() => () => {
    if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current)
  }, [])
  /** 单行插入（粘贴）：换行折叠成空格、`\r` 去掉——落地页是单行编辑器，
   *  多行内容不许拼出换行（Enter 才是提交）。落在当下光标处。 */
  const insertSingleLine = (text: string): void => {
    const clean = collapseToSingleLine(text)
    if (clean === '') return
    // 异步落点守则：读回那一刻的 query/caret 才算数（refs 每次渲染刷新）。
    const next = insertSingleLineAt(queryRef.current, caretRef.current, clean)
    changeQuery(next.text, next.caret)
    onFocusChange(-1)
  }
  const pasteImagePaths = (paths: readonly string[], lease: ReturnType<typeof capturePasteLease>, bitmap = false): Promise<void> => {
    const work = async (): Promise<void> => {
      if (!lease.isCurrent()) return
      if (imageComposer === undefined) {
        showPasteNotice(t('input-image-paste-failed', { err: 'image attachments are unavailable in this profile' }))
        return
      }
      const { channel, bindings } = imageComposer
      const limits = channel.stagedImageLimits?.()
      const { parts, staged, failure, failureCode } = await stageClipboardFilePaths(
        paths,
        async path => {
          if (!lease.isCurrent()) throw new Error('the draft changed while the image was being staged')
          if (limits === undefined) throw new Error('image attachments are unavailable in this profile')
          const data = await readBoundedRegularFile(path, limits.maxImageBytes)
          if (!lease.isCurrent()) throw new Error('the draft changed while the image was being staged')
          return channel.stageComposerImage({
            data,
            mediaType: imagePathMediaType(path) ?? 'image/png',
            name: basename(path),
            path: resolve(path),
          }, lease.imageGeneration)
        },
        path => formatClipboardInsert({ kind: 'files', paths: [path] }),
        Math.max(0, (limits?.maxImagesPerMessage ?? 0) - bindings.size),
      )
      if (!lease.isCurrent() || staged.some(handle => channel.hasStagedImage(handle.stageId) !== true)) {
        for (const handle of staged) channel.discardStagedImage(handle.stageId)
        return
      }
      let number = 1
      const reserved = new Set(queryRef.current.match(/\[Image #\d+\]/gu) ?? [])
      const text = parts.map(part => {
        if (part.kind === 'text') return part.value
        while (reserved.has(`[Image #${number}]`)) number += 1
        const token = `[Image #${number++}]`
        bindings.set(token, part.value.stageId)
        return token
      }).join(' ')
      // A failed bitmap export is temporary and must never become a path reference.
      if (!bitmap || staged.length > 0) insertSingleLine(`${text} `)
      if (failure !== '') {
        showPasteNotice(t('input-image-paste-failed', { err: failureCode === 'image-limit' ? t('input-image-paste-limit') : failure }))
      } else if (staged.length > 0) {
        const adapted = staged.filter(handle => handle.adjustment !== undefined).length
        showPasteNotice(adapted > 0
          ? t('input-images-staged-adapted', { count: staged.length, adapted })
          : t('input-images-staged', { count: staged.length }))
      }
    }
    const queued = imageChainRef.current.then(work, work)
    imageChainRef.current = queued.catch(() => undefined)
    return queued
  }

  // 光标闪烁相位（第四版修订：**自动呼吸**，不要求终端 focus 事件）。开关只看
  // 「输入框是这一屏的焦点目标」（focusIndex < 0）——`isTerminalFocused` 依赖
  // The native caret owns blinking in TTYs; only the painted fallback needs
  // a timer. Do not gate it on terminal focus events, which can arrive late.
  const nativeCursor = useNativeCursor()
  const inputActive = inputFocused && !nativeCursor
  const [caretPhase, setCaretPhase] = React.useState(true)
  React.useEffect(() => {
    if (!inputActive) {
      setCaretPhase(true)
      return
    }
    const timer = setInterval(() => { setCaretPhase(phase => !phase) }, CARET_BLINK_MS)
    ;(timer as { unref?: () => void }).unref?.()
    return () => { clearInterval(timer) }
  }, [inputActive])

  // F-04（T-FIX-03）：键盘激活参数段（焦点环 Enter → onParamPick）与点击同一条
  // 语义——**激活即撤卡**。点击的撤卡在 `ParamChip.onClick` 里就地做（它自己
  // 持有 tooltip owner）；键盘路径的 Enter 由下面的屏级 useInput 处理，这里用
  // 一枚自增信号把"刚被激活的是哪一段"传给对应的 ParamChip（`segment` 定位、
  // `nonce` 让连续两次 Enter 也各算一次变化）。指针**仍停在段上**时的保留属
  // tooltip 既有语义，不动。
  const [paramActivation, setParamActivation] = React.useState<{ segment: LaunchpadParamSegment; nonce: number } | null>(null)
  // 参数行（第五版；第六版设计 1 改 preset 段）：**只画值、不画字段名**；
  // 模型段**只显示模型名**（去掉 provider/ 前缀——用户原话「两个都放的话就
  // 太长了」）：`glm-5.3  ·  Max  ·  Standard  ·  default`。模式段显示 agent
  // preset 的显示名（Standard/PTC/极简…，Chat 从 preset 名册解析后传入）；
  // 模型值带浅紫主题色，其余 dim。四段各自可点（onParamPick → Chat 既有的
  // /model · /effort · /preset · /permission 选择器）。
  const paramParts: { segment: LaunchpadParamSegment; value: string; colored?: boolean }[] = (() => {
    const parts: { segment: LaunchpadParamSegment; value: string; colored?: boolean }[] = []
    if (model !== undefined && model !== '') parts.push({ segment: 'model', value: model, colored: true })
    if (effort !== undefined && effort !== '') {
      parts.push({ segment: 'effort', value: effort.charAt(0).toUpperCase() + effort.slice(1) })
    }
    if (preset !== undefined && preset !== '') {
      parts.push({ segment: 'preset', value: preset })
    }
    if (permission !== undefined && permission !== '') parts.push({ segment: 'permission', value: permission })
    return parts
  })()
  // 宽度自适应：参数行是**单行**（折行会把 F 组的「整句要么完整要么不出现」不
  // 变量打碎）。拟合走纯函数 `fitParamParts`（三段式：装得下 → 四段原样；装不下
  // → 按「可缩减量最大」把超长段**尾部截断**（权限段一字不减，`Max` 这类宽度
  // ≤ 下限的短段也不减）；压到各自下限仍超 → 今天的尾部省段），组件不再自己写
  // 累加循环——宽度记账、降级语义与 `…` 的形态都在 `components/launchpadParams.ts`，
  // 纯函数层与屏幕层的回归在 `scripts/verify-launchpad.tsx` 的 Q / R 组。
  const paramBudget = Math.max(24, Math.min(columns - 4, 72)) - 2
  const fittedParams = fitParamParts(paramParts, paramBudget)
  const hasParams = fittedParams.length > 0
  // 双角铭牌：像两枚低调的机械铭牌，把整块界面扎在终端底边上。
  const cornerLeft = [cwd, branch].filter(part => part !== undefined && part !== '').join(':')
  // 右下角铭牌带（第八版）：第一行 TUI 版本，其后一行一个内核。
  // 行文本 = `名字 · 副标题`——副标题（版本 / 置灰原因）与选择器同源
  // （kernelSubtitle），读不到就只画名字，绝不编造。
  const tuiPart = tuiVersion === undefined || tuiVersion === '' ? undefined : `dsh-tui v${tuiVersion}`
  // 名字用**短品牌名**（option.shortLabel，来自 manifest：DSH / Claude，与启动页
  // 「内核 · DSH」那个 chip 同源）：这一格与左下角的 `工作目录:分支` 共用底边，
  // 全名（DeepSeek Harness · … = 40 列）在窄终端里会把左边的目录铭牌挤掉。
  // 选择器那一屏有地方，仍用全名（label）。
  const kernelRows = (kernels ?? []).map(option => {
    const subtitle = kernelSubtitle(option, key => t(key))
    const name = option.shortLabel
    return { id: option.id, current: option.current, label: subtitle === undefined ? name : name + ' \u00b7 ' + subtitle }
  })
  /** 内核区进不进焦点环：画得出来**且**接了回调（可点才需要键盘等价操作）。 */
  const kernelCornerFocusable = kernelRows.length > 0 && onKernelPick !== undefined
  const cardWidth = Math.max(24, Math.min(columns - 4, 72))

  // 当天字体与节日只在 mount 时选一次，并交给 Logo，避免预算与渲染各自读日期。
  const [dailyFont] = React.useState<SplashFont>(() => pickSplashFont())
  const [dailyEgg] = React.useState<SplashEgg | null>(() => egg === undefined ? pickSplashEgg() : egg)
  const font = fontId === undefined ? dailyFont : splashFontById(fontId)
  const titleFont = resolveSplashTitleFont(font, brand, dailyEgg)
  const layout: LaunchpadLayout = resolveLaunchpadLayout(columns, rows, {
    params: hasParams,
    whale,
    whaleGirl,
    font: titleFont,
  })
  // Tips 自动轮换（第七版，用户要「呼吸感」）：约 10s 一换，与点击/焦点+Enter
  // 的手动切换**并存**——手动切换改 tipIndex，本 effect 以 tipIndex 为依赖，
  // 重臂即计时重置（刚点完不会立刻被自动轮换跳走）。只在 Tips 行真的在画、
  // 且不是首启句/粘贴提示时跑；本组件被整屏盖住时随之卸载，定时器自然停。
  // 切换只改那一行文本（TIP_KEYS 查表），行高与居中位置不变——无布局抖动。
  const tipsAutoRotatable = layout.showTip && pasteNotice === undefined && !firstRun
  React.useEffect(() => {
    if (!tipsAutoRotatable) return
    const timer = setInterval(() => { setTipIndex(index => (index + 1) % TIP_KEYS.length) }, tipRotateMs)
    ;(timer as { unref?: () => void }).unref?.()
    return () => { clearInterval(timer) }
  }, [tipsAutoRotatable, tipRotateMs, tipIndex])
  // 一行装得下几个动作：装不下的**不画**（不是截断）——半个标签比少一个
  // 入口更难懂。键盘仍能走到全部入口，丢掉的只是鼠标的礼貌。
  // 第四版标签就是**纯文字**（无键帽/键位前缀）；带插值的（Continue 标题）由 t() 解。
  const chips = fitChips(actions.map(action => t(action.labelKey as never, action.values as never)), columns)
  /**
   * 键帽行放不放得下：`fitChips` 已经按宽度整条取舍（绝不切半个标签），
   * 这里只回答「一条都放不下时还画不画」——不画，省下一行给留白。
   */
  const hintsFit = chips.length > 0

  /**
   * 这一屏独占键盘（`Chat` 在 `supervisorOpen` 那一层之前让位），所以输入
   * 在这里自持——把按键转发给 Chat 反而要多绕一层 state 往返。
   *
   * 编辑能力刻意只做单行编辑器该有的那几样：退格 / Delete / 左右移动 /
   * Home / End / 粘贴。首屏不是编辑器，用户在上面打的第一句通常就一两个
   * 词；多行与 `@` 补全属于聊天页，图片经同一 channel 暂存。
   *
   * `↑/↓` 与 `Tab` 在键帽行上移动焦点；焦点在 `-1` 时这两组键无操作
   * （首屏没有可滚的东西）。
   */
  useInput((input, key, event) => {
    // 选择器盖在这一屏之上时键盘整块让位（Chat 的 overlay 分支处理；Esc 关
    // 选择器回到这里）。没有这道闸，选择器分支没消费的键会漏进草稿。
    if (inputPaused) return
    const query = queryRef.current
    const caret = caretRef.current
    const composing = key.ctrl || key.meta || key.super
    // 终端原生粘贴（bracketed paste：Ctrl+Shift+V / 右键 / Shift+Insert）：
    // ink 把载荷标成 isPasted 交给 useInput；标记字节（\x1b[200~ / 201~）在
    // 解析层已被剥掉，这里的 input 就是纯载荷。换行折叠成单行（见上）。
    if (event?.isPasted === true && input.length > 0) {
      const text = stripBracketedPasteMarkers(input)
      const path = parsePastedImagePath(text)
      if (path !== null && imageComposer !== undefined) {
        const lease = capturePasteLease()
        void pasteImagePaths([path], lease).catch(error => {
          if (lease.isCurrent()) showPasteNotice(t('input-image-paste-failed', { err: String(error) }))
        })
      } else insertSingleLine(text)
      event.stopImmediatePropagation()
      return
    }
    // Ctrl+V / Cmd+V（keymap 的 paste 动作，可经 /settings 重映射；照
    // PromptInput 的做法用 actionMatches，不硬编码键字符串）读系统剪贴板。
    // 曾经的 bug：组合键兜底把 Ctrl+V 一口吞掉，粘贴永远是死的。
    if (matchesPasteShortcut(input, key)) {
      if (!clipboardBusyRef.current) {
        const lease = capturePasteLease()
        clipboardBusyRef.current = true
        void clipboardReader()
          .then(async content => {
            const temporaryPath = content?.kind === 'image' ? content.path : undefined
            try {
              if (!lease.isCurrent()) return
              if (content === null) {
                showPasteNotice(t('input-clipboard-empty' as never))
                return
              }
              if (content.kind === 'unavailable') {
                showPasteNotice(t(content.wsl === true ? 'input-clipboard-unavailable-wsl' as never : 'input-clipboard-unavailable' as never))
                return
              }
              if (content.kind === 'image') {
                if (imagePathMediaType(content.path) === undefined) {
                  showPasteNotice(t('input-image-format-unsupported'))
                  return
                }
                await pasteImagePaths([content.path], lease, true)
                return
              }
              if (content.kind === 'files' && imageComposer !== undefined) {
                await pasteImagePaths(content.paths, lease)
                return
              }
              const text = formatClipboardInsert(content)
              const path = parsePastedImagePath(text)
              if (path !== null && imageComposer !== undefined) await pasteImagePaths([path], lease)
              else insertSingleLine(text)
            } finally {
              if (temporaryPath !== undefined) await unlink(temporaryPath).catch(() => undefined)
            }
          })
          .catch(() => {
            if (lease.isCurrent()) showPasteNotice(t('input-clipboard-read-failed' as never))
          })
          .finally(() => {
            clipboardBusyRef.current = false
          })
      }
      event.stopImmediatePropagation()
      return
    }
    // 第七版：Continue 的专属快捷键（keymap 的 `continue` 动作，默认 Alt+R，
    // 可经 /settings → Shortcuts 重映射）。只在这一屏生效（聊天页不绑这条）；
    // actions 里没有 continue（无可继续会话）时不放假动作——按下即忽略。
    if (actionMatches('continue', input, key)) {
      const continueAction = actions.find(action => action.id === 'continue')
      if (continueAction !== undefined) {
        onAction(continueAction)
        event.stopImmediatePropagation()
        return
      }
    }
    // 命令补全面板（第六版 BUG 1）：面板开着时 ↑/↓/Enter/Tab/Esc 全归面板——
    // 与聊天页 composer 的补全菜单同一套键位。Tab 补全；Enter/点击执行选中命令
    // （onCommandPick → Chat 的 runCommand，绝不 submit）；Esc 只收面板，
    // 草稿一字不动（用户可能只是想看一眼有什么命令）。
    if (paletteOpen && paletteSelected !== undefined) {
      if (key.upArrow || key.downArrow) {
        const count = paletteCommands.length
        setPaletteIndex(previous => (previous + (key.downArrow ? 1 : -1) + count) % count)
        event.stopImmediatePropagation()
        return
      }
      if (key.tab) {
        if (!key.shift) {
          const replacement = paletteSelected.replacement
          setPaletteIndex(0)
          changeQuery(replacement, replacement.length)
        }
        event.stopImmediatePropagation()
        return
      }
      if (isPlainReturn(key)) {
        pickCommand(paletteSelected.commandLine)
        event.stopImmediatePropagation()
        return
      }
      if (key.escape) {
        setPaletteDismissedFor(query)
        event.stopImmediatePropagation()
        return
      }
    }
    if (key.escape) {
      pasteRevisionRef.current += 1
      // 空输入时 Esc 去看会话（首屏最常见的下一步）；已经有字就只清空它,
      // 免得辛苦打的半句话被一次性丢掉。
      if (query !== '') changeQuery('', 0)
      else onEscape('sessions')
      event.stopImmediatePropagation()
      return
    }
    if (key.ctrl && (input === 'c' || input === 'd')) {
      pasteRevisionRef.current += 1
      if (query !== '') changeQuery('', 0)
      else onEscape('exit')
      event.stopImmediatePropagation()
      return
    }
    if (isPlainReturn(key)) {
      // 焦点画在哪一格，Enter 就归谁：Tips 行（-6）切下一条 Tip、参数段（≤-2）
      // 点开它对应的选择器、动作入口（≥0）激活那一条，输入框有焦点（`-1`）时
      // 才把整行原文交回 Chat。键盘路径是仓库硬规矩（每个可点目标都要有），
      // 四段参数、可点击的 Tips 行与两个角标（目录铭牌/内核区）也不例外。
      const focusedSegment = segmentOfFocus(focusIndex)
      if (focusIndex === TIPS_FOCUS) {
        rotateTip()
      } else if (focusIndex === KERNEL_CORNER_FOCUS && onKernelPick !== undefined) {
        // 右下角内核区（第八版）：Enter = 打开内核选择器（与点击同一条回调）。
        onKernelPick()
      } else if (focusIndex === CWD_CORNER_FOCUS && onOpenWorkspace !== undefined) {
        // 左下角工作目录铭牌（第七版）：Enter = 打开既有 /workspace 菜单。
        onOpenWorkspace()
      } else if (focusedSegment !== undefined && onParamPick !== undefined) {
        // 激活即撤卡（F-04）：先记信号——ParamChip 的 effect 在这次提交后撤掉
        // 可能挂着的卡片；键盘路径与点击路径落在同一个 onParamPick 上。
        const activated = focusedSegment
        setParamActivation(prev => ({ segment: activated, nonce: (prev?.nonce ?? 0) + 1 }))
        onParamPick(activated)
      } else {
        const focused = focusIndex >= 0 ? actions[focusIndex] : undefined
        if (focused === undefined) {
          const notice = onSubmit(query)
          if (typeof notice === 'string') showPasteNotice(notice)
          else pasteRevisionRef.current += 1
        } else onAction(focused)
      }
      event.stopImmediatePropagation()
      return
    }
    if (key.tab || key.upArrow || key.downArrow) {
      if (actions.length === 0) return
      const step = key.upArrow || (key.tab && key.shift) ? -1 : 1
      // `-1`（输入框）从下方进入：向"上"回到输入框，向"下"落到第一格——
      // Tab 在输入框上则直接进第一格。
      // 焦点环 = 输入框（`-1`）+ **画出来的**参数段（第五版，先于入口行——
      // 参数行在版面上就在入口行上方，↓ 的空间顺序与环顺序一致）+ **画出来的**
      // 入口 + Tips 行（第六版设计 2，环的最后一格——它在版面上就在入口行下方）。
      // 窄终端里 `fitChips`/参数行的宽度裁剪会丢掉放不下的那几个，按
      // 整张表绕圈会让焦点指着一个看不见的目标、Enter 触发一个看不见的动作。
      const tipsFocusable = layout.showTip && pasteNotice === undefined && !firstRun
      // 左下角铭牌（第七版）：画得出来且接了 onOpenWorkspace 才进环。
      const cornerFocusable = layout.showCorners && cornerLeft !== '' && onOpenWorkspace !== undefined
      // 环的顺序 = 版面顺序（↓ 一路向下）：…→ Tips → 左下目录铭牌 → 右下内核区。
      const ring = [
        -1,
        ...fittedParams.map(part => paramFocusOf(part.segment)),
        ...chips.map(chip => chip.index),
        ...(tipsFocusable ? [TIPS_FOCUS] : []),
        ...(cornerFocusable ? [CWD_CORNER_FOCUS] : []),
        ...(kernelCornerFocusable ? [KERNEL_CORNER_FOCUS] : []),
      ]
      const at = ring.indexOf(focusIndex)
      const next = ring[((at >= 0 ? at : 0) + step + ring.length) % ring.length]!
      onFocusChange(next)
      event.stopImmediatePropagation()
      return
    }
    if (key.leftArrow || key.rightArrow || key.home || key.end) {
      if (!inputFocused) return
      const at = caret
      const next = key.home ? 0
        : key.end ? query.length
          : key.leftArrow ? Math.max(0, prevBoundary(query, at))
            : Math.min(query.length, nextBoundary(query, at))
      changeQuery(query, next)
      event.stopImmediatePropagation()
      return
    }
    if (key.backspace || key.delete) {
      if (!inputFocused) return
      const at = caret
      if (key.backspace) {
        if (at === 0) return
        deleteRange(prevBoundary(query, at), at)
      } else {
        if (at >= query.length) return
        deleteRange(at, nextBoundary(query, at))
      }
      event.stopImmediatePropagation()
      return
    }
    if (isMod(key) && input === 'w') {
      if (!inputFocused) return
      let start = caret
      while (start > 0 && /\s/u.test(query[start - 1]!)) start--
      while (start > 0 && !/\s/u.test(query[start - 1]!)) start--
      deleteRange(start, caret)
      event.stopImmediatePropagation()
      return
    }
    if (composing || key.return) return
    // 可打印输入（含粘贴整段）：接到光标处，交给 SearchBox 的窗口化去滚。
    const typed = input.replace(/[\r\n]+/gu, '')
    if (typed === '') return
    const at = caret
    changeQuery(query.slice(0, at) + typed + query.slice(at), at + typed.length)
    onFocusChange(-1)
    event.stopImmediatePropagation()
  })

  return (
    <Box flexDirection="column" width={columns} height={rows} onClick={onBlankClick}>
      {/* 居中主体：立绘（上）+ 词标（下）+ 输入框 + 框下成组三行，整块水平垂直
          双居中（第三版：参数/键帽/Tips 紧贴输入框成组，不再钉屏幕底、不留空档）。
          上下排布而不是并排——用户实测「logo 和标题一定要居中」：并排时是整组
          居中，词标仍偏在右半边；上下排布让两块各自落在中轴上。 */}
      <Box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center">
        {layout.showHero && (
          <LogoV2
                      fontId={font.id}
                      egg={dailyEgg}
                      whale={layout.showWhale && whale}
                      whaleIdle={whaleIdle}
                      whaleGirl={layout.showWhale && whaleGirl}
                      brand={brand}
                      starred={starred}
                      onStarClick={onStarClick}
                      skipIntro
                      align="center"
                      chrome="minimal"
                      arrangement="column"
                    />
        )}
        {/* 成组块：宽度与输入框同宽（cardWidth），参数行左对齐框缘、键帽行
            右对齐框缘、Tips 行在组内居中（组居中 ⇒ 屏幕居中）。 */}
        {/* 词标与输入框之间的呼吸留白（第六版）：默认 2 行，矮屏阶梯先于
            Tips 撤回 1 行（launchpadLayout 的 heroGapRows）——刻意呼吸，不是遗漏。 */}
        <Box flexDirection="column" width={cardWidth} marginTop={layout.heroGapRows}>
          {/* 输入框：圆角边框里**只有输入那一行**（第三版：参数行移出框外）。
              边框在焦点回到输入框时提亮——终端里没有指针形状，颜色变化是
              唯一的「这里在等你打字」反馈。光标按闪烁相位切换样式。 */}
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={inputFocused ? 'suggestion' : 'inactive'}
            paddingX={1}
            width={cardWidth}
          >
            <SearchBox
              query={query}
              placeholder={t('launchpad-placeholder')}
              // 第七版（用户原话「光标永远不消失 哪怕焦点没了也不消失」）：
              // 只要这一屏在，输入光标**常在**——焦点挪到参数段/入口行只影响
              // 外框提亮（inputFocused），不再当光标的开关。
              isFocused
              isTerminalFocused={inputFocused ? true : isTerminalFocused}
              // 占位紧跟 ❯ 之后左对齐（用户实测要求；只影响落地页这一处）。
              placeholderAlign="left"
              // 边框由外层卡片画——SearchBox 自己那圈收起来，否则就是框套框。
              borderless
              prefix={query.startsWith('/') ? '⌘' : '❯'}
              width={cardWidth - 4}
              cursorOffset={caret}
              imageSpans={imageSpans}
              caretBlink={inputFocused ? caretPhase : true}
            />
          </Box>
          {/* 参数行：框外、紧贴框下（无空行），左对齐输入框（框缘 + padding 2 格）。
              第五版：四段各自可点（ParamChip——挂 onClick 才有 hover 提亮），
              分隔符（双空格 · 双空格，来自 PARAM_SEPARATOR）保持不可点。
              AC-4：被截断的段（`…` 在屏上）另挂 tooltip——完整名走本屏之外的
              单例层（Chat 在落地页分支末尾挂 TooltipLayer），本屏只写锚点。 */}
          {hasParams && (
            <Box paddingLeft={2} height={1} flexDirection="row">
              {fittedParams.map((part, index) => (
                <React.Fragment key={part.segment}>
                  {index > 0 && <Text dimColor>{PARAM_SEPARATOR}</Text>}
                  {onParamPick === undefined ? (
                    <Text
                      color={part.colored === true ? 'autoAccept' : undefined}
                      bold={part.colored === true}
                      dimColor={part.colored !== true}
                    >
                      {part.value}
                    </Text>
                  ) : (
                    <ParamChip
                      label={part.value}
                      fullValue={part.fullValue}
                      truncated={part.truncated}
                      colored={part.colored}
                      focused={focusIndex === paramFocusOf(part.segment)}
                      activationNonce={paramActivation?.segment === part.segment ? paramActivation.nonce : 0}
                      onActivate={() => onParamPick(part.segment)}
                      onHover={() => onFocusChange(paramFocusOf(part.segment))}
                      onHoverLeave={() => {
                        if (focusIndex === paramFocusOf(part.segment)) onFocusChange(-1)
                      }}
                    />
                  )}
                </React.Fragment>
              ))}
            </Box>
          )}
          {/* 选择器浮层（第五版）：Chat 传进来的既有 picker overlay 盖在落地页
              之上——锚在输入框卡片顶边向上展开（与聊天页「picker 紧贴输入框」
              同一姿态），零布局高度、不推动这一屏的版面。第七版：transparent——
              落地页这一侧的浮层是**干净的镂空**（遮挡不叠加）：矩形内空格占位
              遮掉宿主字形、不发背景色（无白底），Kitty 立绘图像仍从默认背景
              透出；聊天页的同一批选择器不受影响（那边不传 transparent）。 */}
          {overlayPanel !== undefined && (
            <OverlayAbove maxHeight={Math.max(rows - 8, 1)} transparent>
              {/* BUG 3：浮层内部的点击（选行/拖滑杆）不算“点空白”——拦住冒泡，
                  只有浮层之外的点击才走整页 onBlankClick 的关面板兜底。 */}
              <Box onClick={(event: ClickEvent) => { event.stopImmediatePropagation() }}>
                {overlayPanel}
              </Box>
            </OverlayAbove>
          )}
          {/* 命令补全面板（第六版 BUG 1）：聊天页同一个 CommandSuggestions 组件、
              同一个锚点姿态（输入框卡片顶边向上展开）。面板里的点击同样拦住
              冒泡（点命令行 = 选中执行，不是“点空白”）。 */}
          {overlayPanel === undefined && paletteOpen && paletteSelected !== undefined && (
            <OverlayAbove maxHeight={Math.max(rows - 8, 1)} transparent>
              <Box onClick={(event: ClickEvent) => { event.stopImmediatePropagation() }}>
                <CommandSuggestions
                  commands={paletteCommands}
                  selectedIndex={paletteSelectedIndex}
                  columns={columns}
                  query={query}
                  onPick={(index) => {
                    const command = paletteCommands[index]
                    if (command !== undefined) {
                      pickCommand(command.commandLine)
                    }
                  }}
                />
              </Box>
            </OverlayAbove>
          )}
        </Box>
        {/* 参数行与入口行之间的呼吸留白（第五版用户实测要求「跟输入框太紧了，
            留一两行空」）：默认 1 行；矮屏阶梯里先于入口行被撤（见
            launchpadLayout 的 PARAM_HINTS_GAP_ROWS）。参数行缺席时不画
            （入口行直接紧贴框底，原契约不变）。 */}
        {hasParams && layout.showHints && hintsFit && layout.hintsGapRows > 0 && (
          <Box flexShrink={0} height={1} />
        )}
        {/* 动作行（第四版纯文字入口）：紧贴参数行（无空行），整行右对齐——
            右缘与输入框右缘对齐。全宽行 + 右 padding = 屏幕与卡片的居中差：入口
            总数可能比卡片宽，钉死在组宽（cardWidth）里会被 yoga 折行（实测），
            所以行宽用整屏。每个入口恒 1 行高（ActionChip 契约）。 */}
        {layout.showHints && hintsFit && (
          <Box
            flexShrink={0}
            flexDirection="row"
            gap={2}
            alignSelf="center"
            width={columns}
            justifyContent="flex-end"
            paddingRight={Math.max(0, Math.floor((columns - cardWidth) / 2))}
          >
            {chips.map(({ index, label }) => (
              <ActionChip
                key={actions[index]!.id}
                label={label}
                focused={focusIndex === index}
                onActivate={() => onAction(actions[index]!)}
                onHover={() => onFocusChange(index)}
                onHoverLeave={() => {
                  if (focusIndex === index) onFocusChange(-1)
                }}
              />
            ))}
          </Box>
        )}
        {/* Tips：`● Tips：` 前缀（圆点橙色 warning）+ 内容 dim，整行居中。
            粘贴提示（空/失败/不可用）临时占用这一行——失败不能静默，
            而行数不变（阶梯预算不动）。 */}
        {/* 入口行与 Tips 之间的呼吸留白（第六版）：默认 2 行，矮屏先撤它再撤
            Tips 行本身（launchpadLayout 的 tipGapRows）——刻意呼吸，不是遗漏。 */}
        {(layout.showTip || pasteNotice !== undefined) && (
          <Box
            flexShrink={0}
            alignSelf="center"
            marginTop={layout.tipGapRows}
            // 第六版设计 2：点击 Tips 行切到下一条（循环）。首启句与粘贴提示
            // 不参与轮换（首启优先级最高；提示是临时占用）。点击拦住冒泡——
            // 点 Tips 不是“点空白”。
            {...(pasteNotice === undefined && !firstRun
              ? { onClick: (event: ClickEvent) => { event.stopImmediatePropagation(); rotateTip() } }
              : {})}
          >
            {pasteNotice === undefined ? (
              <>
                <Text color="warning">● {t('launchpad-tip-prefix')}</Text>
                <Text
                  color={focusIndex === TIPS_FOCUS ? 'suggestion' : undefined}
                  bold={focusIndex === TIPS_FOCUS}
                  dimColor={focusIndex !== TIPS_FOCUS}
                >
                  {firstRun ? t('launchpad-first-run') : t(TIP_KEYS[tipIndex] as never)}
                </Text>
              </>
            ) : (
              <Text color="warning">● {pasteNotice}</Text>
            )}
          </Box>
        )}
      </Box>
      {/* 双角铭牌（第八版：右下从「两行版本号」扩成「TUI 版本 + 内核区」）：
          左下目录铭牌仍 1 行、与第一行**顶对齐**（同一块铭牌带，不散）；
          第一行 = dsh-tui，其后一行一个内核（当前那个打 ▸ 且主题蓝，其余 dim；
          整块可点开选择器）。kernels 缺省时右侧只有第一行（绝不编造内核号）。 */}
      {layout.showCorners && (
        <Box flexShrink={0} flexDirection="column">
          <Box flexShrink={0} flexDirection="row" justifyContent="space-between" height={1}>
            {cornerLeft !== '' && onOpenWorkspace !== undefined ? (
              <CornerChip
                label={cornerLeft}
                focused={focusIndex === CWD_CORNER_FOCUS}
                onActivate={onOpenWorkspace}
                onHover={() => onFocusChange(CWD_CORNER_FOCUS)}
                onHoverLeave={() => {
                  if (focusIndex === CWD_CORNER_FOCUS) onFocusChange(-1)
                }}
              />
            ) : (
              <Text dimColor wrap="truncate-middle">{cornerLeft}</Text>
            )}
            <Text dimColor wrap="truncate-middle">{tuiPart ?? ''}</Text>
          </Box>
          {kernelRows.length > 0 && (
            <KernelCorner
              rows={kernelRows}
              focused={focusIndex === KERNEL_CORNER_FOCUS}
              onActivate={onKernelPick}
              onHover={() => onFocusChange(KERNEL_CORNER_FOCUS)}
              onHoverLeave={() => {
                if (focusIndex === KERNEL_CORNER_FOCUS) onFocusChange(-1)
              }}
            />
          )}
        </Box>
      )}
    </Box>
  )
}

/** 快捷入口之间的间隔列数（与动作行 `gap={2}` 一致，预算必须同源）。 */
export const CHIP_GAP = 2

/**
 * 一行装得下哪几个快捷入口（第四版：纯文字标签）。
 *
 * @param labels - 全部标签（宽度按 `stringWidth` 算，CJK 是双宽）。
 * @param columns - 内容区列数。
 * @returns 保留下来的 `{ index, label }`；装不下就到此为止（绝不切半个）。
 */
export function fitChips(
  labels: readonly string[],
  columns: number,
): readonly { index: number; label: string }[] {
  // 每项画成高亮矩形：` 标签 `（背景铺两侧各 1 格内边距）——预算按
  // `标签宽 + 2` 算；行内 gap 2 格由 CHIP_GAP 同步。
  const budget = Math.max(0, columns - 4)
  const out: { index: number; label: string }[] = []
  let used = 0
  for (let index = 0; index < labels.length; index++) {
    const label = labels[index]!
    const width = stringWidth(label) + 2
    const next = used === 0 ? width : used + CHIP_GAP + width
    if (next > budget) break
    used = next
    out.push({ index, label })
  }
  return out
}

/**
 * 光标左移一个**码位**（不是 UTF-16 单元）。
 *
 * `Array.from` 迭代码位，所以退格/左移不会把一个 emoji 或代理对劈成两半
 * ——`SearchBox` 的窗口化在同一条假设上工作（它的 `windowQuery` 专门有
 * 一段"中途代理对回退到起点"的代码），两边必须一致，否则光标会落在半
 * 个字符里，然后下一次按键就画出一个碎 emoji。
 *
 * @param text - 全文。
 * @param at - 当前 UTF-16 偏移。
 * @returns 左侧一个码位的偏移（已在 0 时返回 0）。
 */
export function prevBoundary(text: string, at: number): number {
  if (at <= 0) return 0
  const before = Array.from(text.slice(0, at))
  before.pop()
  return before.join('').length
}

/**
 * 光标右移一个码位。见 {@link prevBoundary}。
 * @param text - 全文。
 * @param at - 当前 UTF-16 偏移。
 * @returns 右侧一个码位的偏移（到末尾时返回末长）。
 */
export function nextBoundary(text: string, at: number): number {
  if (at >= text.length) return text.length
  const rest = Array.from(text.slice(at))
  const first = rest[0] ?? ''
  return at + first.length
}

/** 最小模式这一屏整体不存在（与 `LogoHeader` 同规则）：直接进会话。 */
export function launchpadVisible(): boolean {
  return !isMinimalUiMode()
}
