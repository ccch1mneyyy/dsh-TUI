import React from 'react'
import { Box, Text, useInput, useTerminalSize } from '../ui.js'
import { SearchBox } from '../components/SearchBox.js'
import { LogoV2 } from '../components/LogoV2.js'
import { resolveLaunchpadLayout, type LaunchpadLayout } from '../components/launchpadLayout.js'
import { type LaunchpadAction } from '../components/launchpadActions.js'
import { pickSplashFont, splashFontById, type SplashFont } from '../components/splashFonts.js'
import { t } from '../i18n.js'
import { isMinimalUiMode } from '../minimalUiMode.js'
import { stringWidth } from '../ink/stringWidth.js'
import { isPlainReturn } from '../utils/modifiers.js'
import { formatClipboardInsert, readClipboard, type ClipboardRead } from '../utils/clipboard.js'
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
 * 纯文字入口（2026-10 第四版：用户否掉了键帽形态——"要不做按钮了 就放一个文字
 * 但是鼠标移过去有 hover 这一个方形矩形会高亮"）。
 *
 * - 入口只渲染**一个标签文本**（无键位前缀、无边框、无指针字符 ❯）；
 * - 悬停/焦点 = 该入口所占的那块矩形**整体高亮**（userMessageBackgroundHover
 *   背景铺满标签两侧各一格的内边距，菜单选中那种方块感）——这是唯一的交互
 *   反馈；未悬停时就是普通 dim 文字；
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
}: {
  label: string
  focused: boolean
  onActivate: () => void
  onHover: () => void
}): React.ReactNode {
  const [hovered, setHovered] = React.useState(false)
  const active = hovered || focused
  return (
    <Box
      flexShrink={0}
      height={1}
      onMouseEnter={() => { setHovered(true); onHover() }}
      onMouseLeave={() => { setHovered(false) }}
      onClick={(event: ClickEvent) => {
        event.stopImmediatePropagation()
        onActivate()
      }}
    >
      {/* 单个 Text、纯字符串子节点：高亮矩形由背景色铺出（含两侧各一格内边距）。 */}
      <Text
        backgroundColor={active ? 'userMessageBackgroundHover' : undefined}
        color={focused ? 'suggestion' : undefined}
        bold={focused}
        dimColor={!active}
      >
        {` ${label} `}
      </Text>
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
 *     四段缺哪段省哪段、全空整行不画；模型名带浅紫主题色（autoAccept）；
 *   - 再下一行**键帽按钮**（整行右对齐，与输入框右缘对齐）；
 *   - 再下一行 **`● Tips：`**（居中，圆点橙色 warning）。
 *
 * 屏幕最底的双角铭牌（左 `cwd:branch`、右版本号）保留。
 *
 * **输入框在这一屏是唯一有状态的部件**：用户敲进去的东西必须原样带进聊天页，
 * 否则"第一屏输入的字"就被这一屏吞了。所以这里不在本地解码任何命令——整行
 * 原样交给 `onSubmit`，由 `Chat` 走它既有的补全/命令表路径。本地只读一点：
 * 行首是不是 `/`，用来把输入框左边的提示符从 `❯` 换成 `⌘`。
 *
 * 光标闪烁：只在输入框有焦点（`focusIndex < 0`）且终端持有焦点时跑，
 * 约 550ms 一个相位；**相位只切换样式**（inverse ↔ inverse+dim，见
 * `SearchBox` 的 `caretBlink` 契约），不增删任何字符——无头回归读的是
 * 视口纯文本，闪烁对它不可见，断言不随相位抖动。
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
  fontId,
  starred,
  onStarClick,
  firstRun,
  actions,
  provider,
  model,
  effort,
  mode,
  permission,
  clipboardReader = readClipboard,
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
  fontId?: string | undefined
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
   * 框下参数行的四段（第三版：参数行移出输入框、紧贴框下方，左对齐输入框）：
   * 模型（provider/model）、思考深度（effort）、模式（plan/act）、权限
   * （permission preset 当前身份）。任一段拿不到就省掉那一段，全拿不到就
   * 整行不画（成组行矮一行，见 `resolveLaunchpadLayout` 的 `params`）。
   */
  provider?: string | undefined
  model?: string | undefined
  effort?: string | undefined
  /** 会话模式（`Chat` 读 `channel.mode.plan`）；缺省不画那一段。 */
  mode?: 'plan' | 'act' | undefined
  /** 当前权限预设名（`Chat` 读 `channel.permissionPresets()` 的当前身份）；缺省不画。 */
  permission?: string | undefined
  /**
   * 剪贴板读取缝（测试打桩用；生产走 `utils/clipboard` 的 `readClipboard`，
   * Chat 不传这一项）。签名与 `readClipboard` 一致。
   */
  clipboardReader?: () => Promise<ClipboardRead>
  /** 双角铭牌：左下角的工作路径与分支。 */
  cwd?: string | undefined
  branch?: string | undefined
  /** 双角铭牌：右下角的版本号。 */
  tuiVersion?: string | undefined
  onFocusChange: (index: number) => void
  onAction: (action: LaunchpadAction) => void
  /** 输入框内容变化（含光标位置）。 */
  onQueryChange: (text: string, cursor: number) => void
  /** 提交：整行原文交给 Chat，由它走命令表/模型两条既有的路。 */
  onSubmit: (text: string) => void
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
  const caret = focusIndex >= 0 ? query.length : (cursorOffset ?? query.length)

  // 粘贴的异步落点：剪贴板读回是异步的，读取期间用户可能继续打字——插入必须
  // 用**当时最新**的 query/caret（PromptInput 用 revision 守同一条；这里没有
  // 本地 state，用每次渲染刷新的 refs 守），不能吃按键那一刻的闭包旧值。
  const queryRef = React.useRef(query)
  queryRef.current = query
  const caretRef = React.useRef(caret)
  caretRef.current = caret
  const clipboardBusyRef = React.useRef(false)
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
    onQueryChange(next.text, next.caret)
    onFocusChange(-1)
  }

  // 光标闪烁相位（第四版修订：**自动呼吸**，不要求终端 focus 事件）。开关只看
  // 「输入框是这一屏的焦点目标」（focusIndex < 0）——`isTerminalFocused` 依赖
  // DECSET 1004 focus 事件，Windows Terminal 下要点击窗口才发，拿它当开关就
  // 出现"必须手动点一下才开始闪"（用户实测）。它其余的语义（SearchBox 的
  // 失焦降级等）保留，只是不再控制闪烁。样式切换、字符不动（模块头注释里
  // 的契约）。定时器 unref——探针宿主不因闪烁挂着事件循环。
  const inputActive = focusIndex < 0
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

  // 参数行（第四版：**只画值、不画字段名**——用户原话"为什么还要强调一下模型…
  // 大家都知道是模型啊，不用画蛇添足"）：`zhipu/glm-5.3  ·  Max  ·  Execute  ·  default`。
  // 模式值固定 `Plan`/`Execute`（不本地化的产品词）；模型值带浅紫主题色，其余 dim。
  const paramParts = (() => {
    const modelLabel = [provider, model].filter(part => part !== undefined && part !== '').join('/')
    const effortLabel = effort === undefined || effort === '' ? '' : effort.charAt(0).toUpperCase() + effort.slice(1)
    const modeLabel = mode === 'plan' ? 'Plan' : mode === 'act' ? 'Execute' : ''
    const parts: { value: string; colored?: boolean }[] = []
    if (modelLabel !== '') parts.push({ value: modelLabel, colored: true })
    if (effortLabel !== '') parts.push({ value: effortLabel })
    if (modeLabel !== '') parts.push({ value: modeLabel })
    if (permission !== undefined && permission !== '') parts.push({ value: permission })
    return parts
  })()
  // 宽度自适应：参数行是**单行**（折行会把 F 组的「整句要么完整要么不出现」不
  // 变量打碎）。装不下时从尾部省段（最不重要的先走：权限 → 模式 → 思考深度），
  // 连第一段都放不下就整行不画。分隔符是 `  ·  `（两侧各两格）。
  const paramBudget = Math.max(24, Math.min(columns - 4, 72)) - 2
  const fittedParams: typeof paramParts = []
  let paramUsed = 0
  for (const part of paramParts) {
    const width = stringWidth(part.value)
    const next = fittedParams.length === 0 ? width : paramUsed + 5 + width
    if (next > paramBudget) break
    fittedParams.push(part)
    paramUsed = next
  }
  const hasParams = fittedParams.length > 0
  // 双角铭牌：像两枚低调的机械铭牌，把整块界面扎在终端底边上。
  const cornerLeft = [cwd, branch].filter(part => part !== undefined && part !== '').join(':')
  const cornerRight = tuiVersion === undefined || tuiVersion === '' ? undefined : `dsh-tui v${tuiVersion}`
  const cardWidth = Math.max(24, Math.min(columns - 4, 72))

  const layout: LaunchpadLayout = resolveLaunchpadLayout(columns, rows, {
    params: hasParams,
    whale,
    whaleGirl,
    font: launchpadFont(fontId),
  })
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
   * 词；多行、图片、`@` 补全都属于聊天页，敲 Enter 就过去了。
   *
   * `↑/↓` 与 `Tab` 在键帽行上移动焦点；焦点在 `-1` 时这两组键无操作
   * （首屏没有可滚的东西）。
   */
  useInput((input, key, event) => {
    const composing = key.ctrl || key.meta || key.super
    // 终端原生粘贴（bracketed paste：Ctrl+Shift+V / 右键 / Shift+Insert）：
    // ink 把载荷标成 isPasted 交给 useInput；标记字节（\x1b[200~ / 201~）在
    // 解析层已被剥掉，这里的 input 就是纯载荷。换行折叠成单行（见上）。
    if (event?.isPasted === true && input.length > 0) {
      insertSingleLine(stripBracketedPasteMarkers(input))
      event.stopImmediatePropagation()
      return
    }
    // Ctrl+V / Cmd+V（keymap 的 paste 动作，可经 /settings 重映射；照
    // PromptInput 的做法用 actionMatches，不硬编码键字符串）读系统剪贴板。
    // 曾经的 bug：组合键兜底把 Ctrl+V 一口吞掉，粘贴永远是死的。
    if (matchesPasteShortcut(input, key)) {
      if (!clipboardBusyRef.current) {
        clipboardBusyRef.current = true
        void clipboardReader()
          .then(content => {
            if (content === null) {
              showPasteNotice(t('input-clipboard-empty' as never))
              return
            }
            if (content.kind === 'unavailable') {
              showPasteNotice(t(content.wsl === true ? 'input-clipboard-unavailable-wsl' as never : 'input-clipboard-unavailable' as never))
              return
            }
            if (content.kind === 'image') {
              // 单行编辑器不能暂存图片（staged image 是聊天页的能力）；
              // 插入临时文件路径只会留一条谁也读不懂的路径——提示而不是插入。
              showPasteNotice(t('input-clipboard-unavailable' as never))
              return
            }
            insertSingleLine(formatClipboardInsert(content))
          })
          .catch(() => {
            showPasteNotice(t('input-clipboard-read-failed' as never))
          })
          .finally(() => {
            clipboardBusyRef.current = false
          })
      }
      event.stopImmediatePropagation()
      return
    }
    if (key.escape) {
      // 空输入时 Esc 去看会话（首屏最常见的下一步）；已经有字就只清空它,
      // 免得辛苦打的半句话被一次性丢掉。
      if (query !== '') onQueryChange('', 0)
      else onEscape('sessions')
      event.stopImmediatePropagation()
      return
    }
    if (key.ctrl && (input === 'c' || input === 'd')) {
      if (query !== '') onQueryChange('', 0)
      else onEscape('exit')
      event.stopImmediatePropagation()
      return
    }
    if (isPlainReturn(key)) {
      // 焦点画在哪一格，Enter 就归谁：`❯` 落在键帽行上时激活那一条，
      // 输入框有焦点（`-1`）时才把整行原文交回 Chat。
      // `ListItem` 是纯展示原语（`onClick` 只接鼠标），所以键盘这条路
      // 必须由本屏自己走完——否则入口只能点、不能按，和模块头部
      // 「每个可点目标都必须有一条键盘路径」的约定不符。
      const focused = focusIndex >= 0 ? actions[focusIndex] : undefined
      if (focused === undefined) onSubmit(query)
      else onAction(focused)
      event.stopImmediatePropagation()
      return
    }
    if (key.tab || key.upArrow || key.downArrow) {
      if (actions.length === 0) return
      const step = key.upArrow || (key.tab && key.shift) ? -1 : 1
      // `-1`（输入框）从下方进入：向"上"回到输入框，向"下"落到第一行——
      // Tab 在输入框上则直接进第一行。
      // 焦点环 = 输入框（`-1`）+ **画出来的**入口。窄终端里 `fitChips` 会丢掉放不下的
      // 那几个，按整张动作表绕圈会让 `❯` 指着一个看不见的入口、Enter 触发一个看不见的
      // 动作。第一行再按 ↑ 回到输入框（环的上一格就是 `-1`），这也是注释里承诺的那条路。
      const ring = [-1, ...chips.map(chip => chip.index)]
      const at = ring.indexOf(focusIndex)
      const next = ring[((at >= 0 ? at : 0) + step + ring.length) % ring.length]!
      onFocusChange(next)
      event.stopImmediatePropagation()
      return
    }
    if (key.leftArrow || key.rightArrow || key.home || key.end) {
      if (focusIndex >= 0) return
      const at = caret
      const next = key.home ? 0
        : key.end ? query.length
          : key.leftArrow ? Math.max(0, prevBoundary(query, at))
            : Math.min(query.length, nextBoundary(query, at))
      onQueryChange(query, next)
      event.stopImmediatePropagation()
      return
    }
    if (key.backspace || key.delete) {
      if (focusIndex >= 0) return
      const at = caret
      if (key.backspace) {
        if (at === 0) return
        const cut = prevBoundary(query, at)
        onQueryChange(query.slice(0, cut) + query.slice(at), cut)
      } else {
        if (at >= query.length) return
        onQueryChange(query.slice(0, at) + query.slice(nextBoundary(query, at)), at)
      }
      event.stopImmediatePropagation()
      return
    }
    if (composing || key.return) return
    // 可打印输入（含粘贴整段）：接到光标处，交给 SearchBox 的窗口化去滚。
    const typed = input.replace(/[\r\n]+/gu, '')
    if (typed === '') return
    const at = caret
    onQueryChange(query.slice(0, at) + typed + query.slice(at), at + typed.length)
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
                      fontId={fontId}
                      whale={layout.showWhale && whale}
                      whaleIdle={whaleIdle}
                      whaleGirl={layout.showWhale && whaleGirl}
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
        <Box flexDirection="column" width={cardWidth} marginTop={1}>
          {/* 输入框：圆角边框里**只有输入那一行**（第三版：参数行移出框外）。
              边框在焦点回到输入框时提亮——终端里没有指针形状，颜色变化是
              唯一的「这里在等你打字」反馈。光标按闪烁相位切换样式。 */}
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={focusIndex < 0 ? 'suggestion' : 'inactive'}
            paddingX={1}
            width={cardWidth}
          >
            <SearchBox
              query={query}
              placeholder={t('launchpad-placeholder')}
              isFocused={focusIndex < 0}
              // 焦点在输入框时按持焦渲染（光标常在、随相位呼吸）；焦点挪到
              // 动作行时才交回真实的终端焦点标志（那时光标本来就不该画）。
              isTerminalFocused={focusIndex < 0 ? true : isTerminalFocused}
              // 占位紧跟 ❯ 之后左对齐（用户实测要求；只影响落地页这一处）。
              placeholderAlign="left"
              // 边框由外层卡片画——SearchBox 自己那圈收起来，否则就是框套框。
              borderless
              prefix={query.startsWith('/') ? '⌘' : '❯'}
              width={cardWidth - 4}
              cursorOffset={caret}
              caretBlink={focusIndex < 0 ? caretPhase : true}
            />
          </Box>
          {/* 参数行：框外、紧贴框下（无空行），左对齐输入框（框缘 + padding 2 格）。 */}
          {hasParams && (
            <Box paddingLeft={2} height={1}>
              <Text dimColor>
                {fittedParams.map((part, index) => (
                  <React.Fragment key={part.value}>
                    {index > 0 && '  ·  '}
                    <Text color={part.colored === true ? 'autoAccept' : undefined} bold={part.colored === true}>
                      {part.value}
                    </Text>
                  </React.Fragment>
                ))}
              </Text>
            </Box>
          )}
        </Box>
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
              />
            ))}
          </Box>
        )}
        {/* Tips：`● Tips：` 前缀（圆点橙色 warning）+ 内容 dim，整行居中。
            粘贴提示（空/失败/不可用）临时占用这一行——失败不能静默，
            而行数不变（阶梯预算不动）。 */}
        {(layout.showTip || pasteNotice !== undefined) && (
          <Box flexShrink={0} alignSelf="center" marginTop={1}>
            {pasteNotice === undefined ? (
              <>
                <Text color="warning">● {t('launchpad-tip-prefix')}</Text>
                <Text dimColor>{firstRun ? t('launchpad-first-run') : t('launchpad-tip')}</Text>
              </>
            ) : (
              <Text color="warning">● {pasteNotice}</Text>
            )}
          </Box>
        )}
      </Box>
      {/* 双角铭牌：左下工作路径:分支、右下版本号——低调，但把界面扎在底边上。 */}
      {layout.showCorners && (
        <Box flexShrink={0} flexDirection="row" justifyContent="space-between">
          <Text dimColor wrap="truncate-middle">{cornerLeft}</Text>
          <Text dimColor wrap="truncate-middle">{cornerRight ?? ''}</Text>
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

/**
 * 当天那款字体：设置项 pin 住就用它，否则按日期轮换。
 * 与 `LogoV2` 同源——两边必须解出同一款，否则宽轴阈值会互相矛盾。
 *
 * @param fontId - 设置项 `dsh-tui.splashFont` 的值。
 * @returns 那款字体。
 */
function launchpadFont(fontId: string | undefined): SplashFont {
  return fontId === undefined ? pickSplashFont() : splashFontById(fontId)
}

/** 最小模式这一屏整体不存在（与 `LogoHeader` 同规则）：直接进会话。 */
export function launchpadVisible(): boolean {
  return !isMinimalUiMode()
}
