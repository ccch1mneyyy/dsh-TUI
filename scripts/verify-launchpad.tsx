/**
 * verify-launchpad — 启动页版面、输入、动作、降级档位与内核目录回归。
 *
 * The controlled query loop mirrors Chat; callbacks and screen text are both
 * observable so focus-only and tip-only input can settle early.
 *
 * 钉住的契约（2026-10 第三版改版）：
 *
 *   A. 版面：头部走 LogoV2 chrome=minimal + arrangement=column——**立绘在上、
 *      DEEPSEEK/HARNESS 大字在下**，两块各自水平居中；头部里没有版号/模型/
 *      工作目录/启动提示/欢迎语（它们各有更低频的位置：参数进卡片、目录与
 *      版本进双角铭牌）。居中主体 = 头部 + **复合卡片**：圆角边框（只有一层，
 *      不框套框）里只有输入行（SearchBox borderless），参数条移出框外紧贴框下
 *      ——第四版只画值不画字段名（第六版模式段 = preset 显示名）：
 *      `glm-5.3  ·  Max  ·  Standard  ·  default`
 *      （任一段拿不到就省掉，全空整条不画）。框下再一行**纯文字动作入口**
 *      （ActionChip：无键帽/键位前缀/指针，悬停或焦点 = 整块矩形高亮，恒 1 行高，
 *      整行右对齐输入框右缘）；居中 Tips 行（● 前置圆点，首启 warning 色 +
 *      `launchpad-first-run`）；双角铭牌：左下 `displayCwd:branch`、右下 `dsh-tui v<版本>`。
 *   B. 输入：这一屏是**受控**的（query 由 Chat 持有），夹具必须闭环回写。
 *      敲字进 query、退格/←/→/Home/End 走 caret、Enter 把整行**原文**交给
 *      onSubmit、Esc 有字先清空而空输入才去看会话、Ctrl+C 空输入交 exit；
 *      前缀随行首 `/` 从 `❯` 变 `⌘`。
 *   C. 动作入口：纯文字标签（无键帽）；真 SGR 点击触发动作、悬停移焦点并
 *      整块高亮；↑/↓/Tab 焦点环 = 输入框(-1) + **画出来的**入口（第一行再 ↑
 *      回输入框）；整行右对齐（含 fitChips 裁掉尾部后的窄屏）；行高恒 1。
 *   D. 纯函数：resolveLaunchpadActions 表驱动（第七版四格：Continue(条件) ·
 *      会话与工作区 · 设置 · 条件位 jobs>update>star>help 优先级，单独/
 *      多重/全不成立各一行）、truncateContinueTitle 边界、fitChips 不切半个
 *      标签、阶梯阈值（full → no-tip → no-hints → no-art → input-only）、
 *      fitParamParts 三段式（装得下→原样 / 装不下→尾部截断且权限段不被截 /
 *      压到下限仍超→今天的尾部省段）。theme/lang/doctor 永不出现；settings 固定在第三格。
 *   E. 宽度不变量：120/100/72/60/48 列下任何一行都不超宽；标签/Tips 要么完整
 *      出现在同一行、要么整条不出现（不许被切断的半句）。参数段按 DESIGN D7：
 *      **带 `…` 的尾部截断视为完整呈现**（显式标记的降级），不带 `…` 的半截
 *      与整段消失仍判失败。
 *   R. 屏幕级：参数行三段式的**逐字节期望行**（AC-1/2/3/5）——长 preset 四段
 *      同屏且权限段一字不少、窄屏回落今天的尾部省段、焦点环只收画出来的段。
 *   S. 屏幕级 AC-4：被截断段的 tooltip——真 SGR motion 悬停 600ms 出完整名、
 *      离开即撤且高亮复原、点击/键盘仍开对应选择器、未截断段绝不弹卡片。
 *   PK. 屏幕级：命令补全面板的**卡片几何**——面板锚在 cardWidth 宽的成组块里，
 *      交给 SuggestionCard 的 columns 必须是 cardWidth（不是整屏 columns）：上下
 *      边框闭合（`╮`/`╯`）、卡片行数 = 边框 2 + 命令数（长描述行不多出幽灵空行）、
 *      过长描述在卡片内截断成 `…` 而不是被右 `│` 覆盖。宽/窄终端各钉一遍。
 *
 * Run: node --import tsx/esm scripts/verify-launchpad.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import fakeHome from './lib/fake-home.mjs' // 必须最先：DATA_DIR 在 import 时定死
import { settle, settled, sleep, viewportLines } from './lib/term-test.mjs'
import { stringWidth } from '../src/ink/stringWidth.js'
// 只借类型（import type 被 tsx 整体擦除，不影响上面 fake-home 的加载顺序）。
import type { KernelOption } from '../src/components/kernelCatalog.js'

const { Terminal: XTerm } = xterm
const [
  { render, ThemeProvider, AlternateScreen, Text, Box },
  { Launchpad, fitChips, prevBoundary, nextBoundary },
  { resolveLaunchpadLayout },
  { resolveLaunchpadActions, truncateContinueTitle, LAUNCHPAD_CONTINUE_TITLE_MAX },
  { fitParamParts, PARAM_SEPARATOR, PARAM_SEGMENT_MIN_WIDTH, PARAM_UNTRUNCABLE_SEGMENT },
  { splashFontById },
  { t },
  { TooltipLayer, getTooltipSnapshot },
  { applyCompanionSkin },
] = await Promise.all([
  import('../src/ui.js'),
  import('../src/screens/Launchpad.js'),
  import('../src/components/launchpadLayout.js'),
  import('../src/components/launchpadActions.js'),
  import('../src/components/launchpadParams.js'),
  import('../src/components/splashFonts.js'),
  import('../src/i18n.js',
  ),
  import('../src/components/Tooltip.js'),
  import('../src/tuiDisplayPrefs.js'),
])
// 本脚本锁的是落地页版面/阶梯契约（WHALE_ART_ROWS=13 那套预算）：吉祥物
// 皮肤用 store 钉在 'whale'，避免默认 deepy 把立绘换成 15 行字母格宠物
// （吉祥物形态归 verify-splash-mascot 管）。
applyCompanionSkin('whale')

/** 内核目录由 buildKernelCatalog 生成，与 Chat 使用同一构造函数。 */
const { buildKernelCatalog } = await import('../src/components/kernelCatalog.js')

/** 夹具的默认状态：有上次会话 + 条件位全不成立（动作表 = Continue·会话与工作区·设置·内核·帮助）。 */
const DEFAULT_ACTIONS = resolveLaunchpadActions({ lastSessionTitle: '修个登录页', jobsRunning: false, updateAvailable: false, starDue: false })
/** 默认五个入口的屏上标签（zh）；缺省 backendId 使用短标签。 */
const CONTINUE_LABEL = '继续「修个登录页」'
const SESSIONS_WORKSPACE_LABEL = '会话与工作区'
const SETTINGS_LABEL = '设置'
const BACKEND_LABEL = '内核'
const HELP_LABEL = '帮助'
const JOBS_LABEL = '后台任务'
const UPDATE_LABEL = '有新版本'
const STAR_LABEL = '投喂一颗 Star'

let failures = 0
let checks = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  if (ok) console.log(`ok   ${name}`)
  else {
    failures++
    console.error(`FAIL ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

const COLS = 120
const ROWS = 40
const CWD = '/tmp/verify-launchpad'
const BRANCH = 'main'
const VERSION = '9.9.9'
/** 参数行只画值，模型段显示模型名；模式段使用 agent preset 显示名。 */
const PARAM_LINE = 'glm-5.3  ·  Max  ·  Standard  ·  default'
/** 夹具固定 bold 字面：大字 needle 与阶梯阈值都不随当天轮换的字体漂。 */
const FONT = splashFontById('bold')

/**
 * 参数行的四段载荷（T03 起夹具可传自定义四段）。`effort` 传**名册原值**
 * （`max`），屏上是首字母大写的显示值（`Max`）——与组件同一条规则。
 * 缺的段 = 拿不到，整段不画（与 `params: false` 的档一致）。
 */
interface ParamFixture {
  model?: string
  effort?: string
  preset?: string
  permission?: string
}
/** 既有夹具的四段（120 列下 = `PARAM_LINE`）：默认调用一律走它，老用例零改动。 */
const DEFAULT_PARAMS: ParamFixture = { model: 'glm-5.3', effort: 'max', preset: 'Standard', permission: 'default' }
/** 屏上四段的显示文本（空/缺的段不画；`effort` 首字母大写）。 */
function displayedParams(params: ParamFixture): readonly string[] {
  const effort = params.effort === undefined || params.effort === ''
    ? undefined
    : params.effort.charAt(0).toUpperCase() + params.effort.slice(1)
  return [params.model, effort, params.preset, params.permission]
    .filter((value): value is string => value !== undefined && value !== '')
}
/** AC-1/AC-5 载荷：14 + 3 + 38 + 18 格四段（preset = 38 格的 agent preset 显示名）。 */
const AC1_PARAMS: ParamFixture = {
  model: 'deepseek-flash',
  effort: 'max',
  preset: 'Standard (Git Bash · official tooling)',
  permission: 'danger-full-access',
}
/** AC-2① 载荷：preset 拉到 76 格（比 AC-1 更狠的超宽量），其余段与 AC-1 同。 */
const AC2_PRESET_HUGE_PARAMS: ParamFixture = {
  ...AC1_PARAMS,
  preset: 'Standard (Git Bash · official tooling) — nightly variant with custom tooling',
}
/** AC-2② 载荷：模型名（32 格）与 preset（38 格）都长。 */
const AC2_LONG_MODEL_PARAMS: ParamFixture = { ...AC1_PARAMS, model: 'deepseek-v3.2-exp-custom-ft-2026' }

class FakeStdout extends Writable {
  isTTY = true
  /** 渲染帧计数：闪烁相位切换会重绘（样式变、文本不变），帧数是"真的在闪"的无头证据。 */
  writeCount = 0
  constructor(private readonly terminal: InstanceType<typeof XTerm>) { super() }
  get columns(): number { return this.terminal.cols }
  get rows(): number { return this.terminal.rows }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.writeCount += 1
    this.terminal.write(String(chunk), callback)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, callback: () => void): void { callback() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  override ref(): this { return this }
  override unref(): this { return this }
}

interface Ev { type: string; value?: unknown; cursor?: number }

interface OpenOptions {
  columns?: number
  rows?: number
  query?: string
  firstRun?: boolean
  whale?: boolean
  /** 参数行四段；false = 全不传（卡片矮一行的档）、对象 = 自定义四段。默认带全。 */
  params?: boolean | ParamFixture
  /** 双角铭牌三段；false = 全不传。默认带全。 */
  corners?: boolean
  /** 剪贴板桩内容；undefined = 空文本，null = 剪贴板为空（读得到但没东西）。 */
  clipboard?: string | null
  /** 剪贴板读回延迟（ms）——异步落点守则用例在延迟窗口里继续打字。 */
  clipboardDelay?: number
  /** 默认动作表：已有上次会话，条件动作均未触发。 */
  actions?: readonly ReturnType<typeof resolveLaunchpadActions>[number][]
  /** 终端焦点标志；false = 模拟"从未收到 focus 事件"（光标仍必须自动呼吸）。 */
  terminalFocused?: boolean
  /** 为 overlayPanel 提供测试内容。 */
  overlayPanel?: boolean
  /** 高探针面板：探针行加六行空白，覆盖部分大字。 */
  overlayPanelTall?: boolean
  /** 提供时才显示命令补全面板。 */
  commands?: readonly { name: string; description: string; commandLine?: string }[]
  /** 提供时才显示命令补全面板。 */
  commands?: readonly { name: string; description: string; commandLine?: string }[]
  /** 提供时才显示命令补全面板。 */
  commands?: readonly { name: string; description: string; commandLine?: string }[]
  /** 模拟键盘交给覆盖层处理。 */
  inputPaused?: boolean
  /** Tips 轮换间隔。 */
  tipRotateMs?: number
  /** 接上左下角铭牌的 onOpenWorkspace（true = 记 workspace 事件）。 */
  cornerWorkspace?: boolean
  /**
   * 右下角内核区的目录行，由 buildKernelCatalog 生成。
   * 不给 = 只画 TUI 版本那一行。
   */
  kernels?: readonly KernelOption[]
  /** 接上内核区的 onKernelPick（true = 点击/Enter 记一条 'kernel' 事件）。 */
  kernelPick?: boolean
}

async function openLaunchpad(events: Ev[], options: OpenOptions = {}) {
  const columns = options.columns ?? COLS
  const rows = options.rows ?? ROWS
  const term = new XTerm({ cols: columns, rows, scrollback: 0, allowProposedApi: true })
  const out = new FakeStdout(term)
  const input = new FakeStdin()
  const paramFixture: ParamFixture = options.params === false
    ? {}
    : typeof options.params === 'object' ? options.params : DEFAULT_PARAMS
  const corners = options.corners !== false

  // 受控闭环：Chat 持有 query/caret/focus，这里照抄那三条回调的接线。
  function Harness(): React.ReactNode {
    const [query, setQuery] = React.useState(options.query ?? '')
    const [caret, setCaret] = React.useState((options.query ?? '').length)
    const [focus, setFocus] = React.useState(-1)
    const page = (
      <Launchpad
        query={query}
        cursorOffset={caret}
        focusIndex={focus}
        isTerminalFocused={options.terminalFocused ?? true}
        whale={options.whale ?? true}
        whaleIdle={false}
        whaleGirl={false}
        starred={false}
        fontId="bold"
        firstRun={options.firstRun ?? false}
        actions={options.actions ?? DEFAULT_ACTIONS}
        overlayPanel={options.overlayPanel === true ? <Text>PICKER-PROBE 选择器探针</Text>
          : options.overlayPanelTall === true ? (
            <Box flexDirection="column">
              <Text>PICKER-PROBE 选择器探针</Text>
              <Text> </Text>
              <Text> </Text>
              <Text> </Text>
              <Text> </Text>
              <Text> </Text>
              <Text> </Text>
            </Box>
          ) : undefined}
        inputPaused={options.inputPaused === true}
        onParamPick={(segment) => { events.push({ type: 'param', value: segment }) }}
        model={paramFixture.model}
        effort={paramFixture.effort}
        preset={paramFixture.preset}
        permission={paramFixture.permission}
        commands={options.commands}
        onCommandPick={(commandLine) => { events.push({ type: 'command', value: commandLine }) }}
        tipRotateMs={options.tipRotateMs}
        kernels={options.kernels}
        onKernelPick={options.kernelPick === true ? () => { events.push({ type: 'kernel' }) } : undefined}
        onOpenWorkspace={options.cornerWorkspace === true ? () => { events.push({ type: 'workspace' }) } : undefined}
        cwd={corners ? CWD : undefined}
        branch={corners ? BRANCH : undefined}
        tuiVersion={corners ? VERSION : undefined}
        clipboardReader={() => new Promise((resolve, reject) => {
          const deliver = () => {
            if (options.clipboard === null) resolve(null)
            else if (options.clipboard === undefined) resolve({ kind: 'text', text: '' })
            else resolve({ kind: 'text', text: options.clipboard })
          }
          const delay = options.clipboardDelay ?? 0
          const timer = setTimeout(delay === 0 ? deliver : () => {
            // 延迟桩按读失败路径演练 reject 的另一种形态时再扩；这里只做成功延迟。
            deliver()
          }, delay)
          ;(timer as { unref?: () => void }).unref?.()
          void reject
        })}
        onFocusChange={(index) => { events.push({ type: 'focus', value: index }); setFocus(index) }}
        onAction={(action) => { events.push({ type: 'action', value: action.command }) }}
        onQueryChange={(text, cursor) => {
          events.push({ type: 'query', value: text, cursor })
          setQuery(text)
          setCaret(cursor)
        }}
        onSubmit={(text) => { events.push({ type: 'submit', value: text }) }}
        onEscape={(intent) => { events.push({ type: 'escape', value: intent }) }}
        onBlankClick={() => { events.push({ type: 'blank' }); setFocus(-1) }}
      />
    )
    // AC-4：与 Chat 的落地页分支同姿态——单例 Tooltip 层挂在树的最外层最后
    // （ParamChip 只写锚点，卡片由它画；Tooltip.tsx 的语义/延迟/几何一律不改）。
    return (
      <>
        {page}
        <TooltipLayer />
      </>
    )
  }

  const app = await render(
    <ThemeProvider theme="dark">
      <AlternateScreen>
        <Harness />
      </AlternateScreen>
    </ThemeProvider>,
    {
      stdin: input as never,
      stdout: out as never,
      stderr: new FakeStderr() as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )

  const screen = () => viewportLines(term).join('\n')
  /** 输入可只改变局部焦点或 Tips，不一定触发宿主回调。 */
  const send = async (data: string): Promise<void> => {
    await settled(() => screen().length > 0)
    const before = events.length
    const frame = screen()
    const writes = out.writeCount
    input.write(data)
    await settle(() => events.length > before || screen() !== frame)
    if (events.length > before && screen() === frame && out.writeCount === writes) {
      await settle(() => out.writeCount > writes)
    }
  }
  const click = async (needle: string): Promise<void> => {
    await settled(() => findCell(term, needle) !== null)
    const found = findCell(term, needle)
    if (found === null) throw new Error(`click target not on screen: ${needle}`)
    const before = events.length
    const frame = screen()
    const writes = out.writeCount
    input.write(`\u001b[<0;${found.col};${found.row}M\u001b[<0;${found.col};${found.row}m`)
    await settle(() => events.length > before || screen() !== frame)
    if (events.length > before && screen() === frame && out.writeCount === writes) {
      await settle(() => out.writeCount > writes)
    }
  }
  return { term, input, app, out, screen, send, click, close: () => { app.unmount() } }
}

/**
 * 目标文本的**终端列号**（1 起，鼠标 SGR 用）。
 *
 * `term-test` 的 `findText` 给的是**字符串下标**——含中日韩（双宽）字符时它比真实列号小，
 * 点过去会落在两个入口之间的空白上（第 1 个入口前是 ASCII 空格所以看不出问题）。
 * 这里按显示宽度重算，才对得上 xterm 的单元格坐标。
 */
function findCell(term: InstanceType<typeof XTerm>, needle: string): { col: number; row: number } | null {
  const lines = viewportLines(term)
  for (let row = 0; row < lines.length; row++) {
    const at = lines[row]!.indexOf(needle)
    if (at >= 0) return { col: stringWidth(lines[row]!.slice(0, at)) + 1, row: row + 1 }
  }
  return null
}

const last = (events: readonly Ev[], type: string): Ev | undefined =>
  [...events].reverse().find(e => e.type === type)

/** needle 所在的**视口行号**（0 起）；不在屏上返回 -1。 */
function rowOf(term: InstanceType<typeof XTerm>, needle: string): number {
  const lines = viewportLines(term)
  for (let i = 0; i < lines.length; i++) if (lines[i]!.includes(needle)) return i
  return -1
}
function countOf(term: InstanceType<typeof XTerm>, needle: string): number {
  return viewportLines(term).reduce((n, l) => n + (l.split(needle).length - 1), 0)
}
/**
 * 一个串的**前半**（半句检测用；取上整，非空串至少 1 个字符）。
 * 「半句判据」在两个地方用同一份定义：F 组的被切断检测与 R 组的"整段不在"。
 *
 * ⚠️ 这里按 **UTF-16 码元** `slice`：对含代理对（emoji/ZWJ）的文本，切出来的
 * "前半"不是原串的合法前缀 ⇒ 以此为前提的 `indexOf` 探针**永不命中**、F2 判据
 * 对这类文本永不判红（REVIEW F-05，见 `isSilentlyCut` 的盲区清单）。
 * 这是判据的已知边界，不是本轮引入的回归。
 */
function halfOf(text: string): string {
  return text.slice(0, Math.ceil(text.length / 2))
}
/** 行首缩进的显示宽度。 */
function leftGap(line: string): number {
  const m = /^\s*/.exec(line)
  return m === null ? 0 : stringWidth(m[0])
}
/** 两份整屏快照的首个差异行（"屏上零新字形"负例失败时的定位证据）。 */
function firstScreenDiff(before: string, after: string): string {
  const a = before.split('\n')
  const b = after.split('\n')
  for (let row = 0; row < Math.max(a.length, b.length); row++) {
    if (a[row] !== b[row]) return `row=${row} before=${JSON.stringify(a[row])} after=${JSON.stringify(b[row])}`
  }
  return ''
}
/** 行尾留白的显示宽度。 */
function rightGap(line: string, columns: number): number {
  const trimmed = line.replace(/\s+$/u, '')
  return Math.max(0, columns - stringWidth(trimmed))
}
/**
 * 该行**第一个非空格字符**所在单元格。前缀是空格（或 ▸ 这种宽窄有争议的字形）
 * 时，按列号算术去取会踩宽度口径；扫格取首个字形则与画法无关。
 */
function firstGlyphCell(term: InstanceType<typeof XTerm>, row: number, columns: number) {
  const line = row < 0 ? undefined : term.buffer.active.getLine(row)
  if (line === undefined) return undefined
  for (let col = 0; col < columns; col++) {
    const cell = line.getCell(col)
    if ((cell?.getChars() ?? '').trim() !== '') return cell
  }
  return undefined
}

/**
 * 前景色的判据串。**别拿 xterm 的 isDim() 判「变暗」**：本仓的 `dimColor` 是
 * ThemedText 的语义（换成主题 inactive 色），根本不发 ANSI 2（见
 * components/design-system/ThemedText.tsx 的 Props 注释）。
 */
function fgKeyOf(cell: ReturnType<typeof firstGlyphCell>): string {
  if (cell === undefined) return 'none'
  if (cell.isFgDefault()) return 'default'
  if (cell.isFgRGB()) return 'rgb:' + cell.getFgColor().toString(16)
  if (cell.isFgPalette()) return 'palette:' + cell.getFgColor()
  return 'ansi:' + cell.getFgColor()
}

/** 行内某段文字**首字符**的单元格（前缀须是 ASCII——列号按显示宽度算）。 */
function cellAtText(term: InstanceType<typeof XTerm>, lines: readonly string[], row: number, needle: string) {
  const text = row < 0 ? '' : lines[row] ?? ''
  const at = text.indexOf(needle)
  const line = row < 0 ? undefined : term.buffer.active.getLine(row)
  if (line === undefined || at < 0) return undefined
  return line.getCell(stringWidth(text.slice(0, at)))
}

/** 一行里同时含全部 needle。 */
const rowHasAll = (line: string, needles: readonly string[]): boolean => needles.every(n => line.includes(n))

// ── A. 版面 ─────────────────────────────────────────────────────────────────
const baseEvents: Ev[] = []
const base = await openLaunchpad(baseEvents)
// 钉的是**具体字形**而不是「有块字符」：鲸鱼 sprite 自己也画 ▄▀，泛匹配测不出大字没了。
// 字形来自当天那款字体，所以夹具用 `fontId: 'bold'` 固定（与 splash 回归同一口径）。
check('A1 画出 DEEPSEEK 大字（bold 字形的 D+E 行）',
  await settled(() => base.screen().includes('██▀▀▄▄ ██▀▀▀▀')))
check('A1b 画出像素鲸鱼 sprite（不是只有大字）',
  await settled(() => base.screen().includes('▀▀▀▀▄  ▄▄▀▀▀')))
await settled(() => base.screen().includes('❯'))
{
  const whaleRow = rowOf(base.term, '▀▀▀▀▄  ▄▄▀▀▀')
  const titleRow = rowOf(base.term, '██▀▀▄▄ ██▀▀▀▀')
  check('A1c arrangement=column：立绘行在大字行**之上**', whaleRow >= 0 && titleRow >= 0 && whaleRow < titleRow,
    `whale=${whaleRow} title=${titleRow}`)
  // 立绘 sprite 不满盒、大字每行右缘随字形浮动，按**包围盒**量整体居中：
  // min(左留白) 与 max(右端) 之间的盒子中心必须落在屏幕中轴 ±2。
  const lines = viewportLines(base.term)
  const boxDiff = (rows: readonly string[]): number => {
    const lefts = rows.map(l => leftGap(l))
    const rights = rows.map(l => stringWidth(l)) // 已 trimEnd：右端即宽度
    const left = Math.min(...lefts)
    const right = Math.max(...rights)
    return Math.abs((left + right) / 2 - COLS / 2)
  }
  const artRows = lines.slice(0, titleRow).map(l => l.replace(/\s+$/u, '')).filter(l => l.length > 0)
  const artDiff = boxDiff(artRows)
  check('A1d 立绘整体水平居中（包围盒中心与屏幕中轴差 ≤2）', artDiff <= 2, `diff=${artDiff}`)
  // 大字块：所有行共享同一左缘（同一缩进），最宽的行自身也居中。
  const titleRows = lines.filter(l => l.includes('█')).map(l => l.replace(/\s+$/u, ''))
  const lefts = titleRows.map(l => leftGap(l))
  const widestTitle = titleRows.reduce((a, b) => (stringWidth(b) > stringWidth(a) ? b : a), '')
  check('A1e 大字块整体居中：各行左缘一致（差 ≤2）且最宽行左右留白差 ≤2',
    titleRows.length > 0 && Math.max(...lefts) - Math.min(...lefts) <= 2
      && Math.abs(leftGap(widestTitle) - rightGap(widestTitle, COLS)) <= 2,
    `leftVar=${Math.max(...lefts) - Math.min(...lefts)} widestDiff=${Math.abs(leftGap(widestTitle) - rightGap(widestTitle, COLS))}`)
}
// 极简头部契约：头部只留立绘 + 大字；模型只允许出现在卡片参数条里。
check('A2 模型串只出现在参数条那一行（头部不画模型行）',
  countOf(base.term, 'glm-5.3') === 1 && rowOf(base.term, 'glm-5.3') > rowOf(base.term, '╭'),
  `count=${countOf(base.term, 'glm-5.3')}`)
// 工作目录/版号只允许出现在双角铭牌（最底 3 行）里。
{
  const lines = viewportLines(base.term)
  const bottom = lines.slice(-3).join('\n')
  check('A3 工作目录只在双角铭牌（最底 3 行）里，且带 :branch',
    countOf(base.term, CWD) === 1 && bottom.includes(CWD) && bottom.includes(CWD + ':' + BRANCH),
    `count=${countOf(base.term, CWD)}`)
  check('A3b 版号词标（✦ dsh-TUI v…）不进头部', !base.screen().includes('✦'))
  check('A3c 版本号只在右下铭牌（dsh-tui v<版本>）',
    countOf(base.term, VERSION) === 1 && bottom.includes('dsh-tui v' + VERSION),
    `count=${countOf(base.term, VERSION)}`)
}
// 动作入口为纯文字；悬停和焦点会高亮整块。
{
  const lines = viewportLines(base.term)
  const hintRow = lines.find(l => l.includes(CONTINUE_LABEL)) ?? ''
  check('A4 动作入口行画出来了（Continue 那条在）', hintRow !== '')
  check('A4b 纯文字入口：没有键帽键位前缀（/setup、esc、/model、?、指针都不在入口行）',
    !hintRow.includes('/setup') && !hintRow.includes('esc') && !hintRow.includes('/model')
      && !hintRow.includes('?') && !hintRow.includes('▸') && !hintRow.includes('❯'),
    hintRow.trim().slice(0, 80))
  check('A4c 五个入口在同一行、行高恒 1（每个标签整屏只出现在这一行；第七版四格 + 内核）',
    rowHasAll(hintRow, [CONTINUE_LABEL, SESSIONS_WORKSPACE_LABEL, SETTINGS_LABEL, BACKEND_LABEL, HELP_LABEL])
      && lines.filter(l => l.includes(CONTINUE_LABEL)).length === 1
      && lines.filter(l => l.includes(SESSIONS_WORKSPACE_LABEL)).length === 1
      && lines.filter(l => l.includes(SETTINGS_LABEL)).length === 1
      && lines.filter(l => l.includes(BACKEND_LABEL)).length === 1
      // 合并/移除契约：旧入口（历史会话、工作区分立、环境体检）绝不再出现。
      && !base.screen().includes('历史会话') && !base.screen().includes('环境体检')
      && viewportLines(base.term).filter(l => l.includes('工作区')).every(l => l.includes(SESSIONS_WORKSPACE_LABEL)),
    hintRow.trim().slice(0, 90))
  check('A4d theme/lang/settings 不出现在落地页（属于 Settings，永不在入口行）',
    !base.screen().includes('换主题') && !base.screen().includes('界面语言'),
    base.screen().slice(0, 60))
  // 右对齐的判据换成「与输入框右缘对齐」：行宽（trim 右）应等于卡片右缘列。
  const cardRow = lines.find(l => l.includes('╭')) ?? ''
  const cardLeft = leftGap(cardRow)
  const cardRight = cardLeft + Math.max(24, Math.min(COLS - 4, 72))
  check('A4e 入口行右对齐输入框右缘（行尾 = 卡片右缘 ±1）',
    Math.abs(stringWidth(hintRow.replace(/\s+$/u, '')) - cardRight) <= 1,
    `rowEnd=${stringWidth(hintRow.replace(/\s+$/u, ''))} cardRight=${cardRight}`)
}
check('A5 输入框占位提示到位', await settled(() => base.screen().includes('说点什么')))
check('A6 极简头部：启动提示行不上屏', await settled(() => !base.screen().includes('提示：')))
// 欢迎语不在落地页重复显示。
check('A6b 欢迎语不再出现（重复的 tagline 已删干净，一处都不剩）',
  await settled(() => !base.screen().includes('探索未至之境')))
// 复合卡片：圆角边框**只有一层**（SearchBox 自己那圈收起来了，不框套框）。
check('A6c 输入卡片只有一层圆角边框（╭ ╰ 各恰好一个，不框套框）',
  await settled(() => countOf(base.term, '╭') === 1 && countOf(base.term, '╰') === 1),
  `╭=${countOf(base.term, '╭')} ╰=${countOf(base.term, '╰')}`)
{
  const top = rowOf(base.term, '╭')
  const bottom = rowOf(base.term, '╰')
  const input = rowOf(base.term, '❯')
  const param = rowOf(base.term, 'glm-5.3')
  check('A6d 参数行移出输入框：框里只有输入行，参数行紧贴 ╰ 下一行',
    top < input && input < bottom && param === bottom + 1,
    [`╭=${top}`, `❯=${input}`, `param=${param}`, `╰=${bottom}`].join(' '))
  check('A6e 参数行文案 = 模型 · 思考深度 · 模式(preset) · 权限（四段，模型名带浅紫）',
    param >= 0 && base.screen().includes(PARAM_LINE), PARAM_LINE)
  check('A6e2 模型段只显示模型名（无 provider/ 前缀，参数行没有斜杠）',
    param >= 0 && !(viewportLines(base.term)[param] ?? '').includes('/') && !base.screen().includes('zhipu'),
    (viewportLines(base.term)[param] ?? '').trim())
  // 左对齐输入框：参数行行首 = 卡片左缘 + 2（边框 1 + padding 1）。
  const cardLeft = leftGap((viewportLines(base.term).find(l => l.includes('╭')) ?? ''))
  check('A6f 参数行左对齐输入框（行首 = 卡片左缘 + 2）',
    Math.abs(leftGap(viewportLines(base.term)[param] ?? '') - (cardLeft + 2)) <= 1,
    `paramLeft=${leftGap(viewportLines(base.term)[param] ?? '')} cardLeft=${cardLeft}`)
  // 参数行与入口行之间留一行空白；窄屏可移除。
  const lines = viewportLines(base.term)
  const hint = lines.findIndex(l => l.includes(CONTINUE_LABEL))
  const tip = lines.findIndex(l => l.includes('● Tips'))
  const corner = lines.findIndex((l, i) => i > tip && l.includes(CWD))
  check('A6g 参数行仍紧贴框、入口行隔一行呼吸留白（hint = param + 2，中间是空行）',
    hint === param + 2 && (lines[param + 1] ?? 'x').trim() === '',
    'hint=' + hint + ' param=' + param + ' mid=' + JSON.stringify(lines[param + 1]))
  // 词标与输入框之间留两行空白。
  const titleBottom = lines.reduce((acc, l, i) => l.includes('█') ? i : acc, -1)
  const cardTop = lines.findIndex(l => l.includes('╭'))
  check('A6g2 词标与输入框之间隔两行呼吸留白（第六版，cardTop = titleBottom + 3）',
    titleBottom >= 0 && cardTop === titleBottom + 3
      && (lines[titleBottom + 1] ?? 'x').trim() === '' && (lines[titleBottom + 2] ?? 'x').trim() === '',
    `titleBottom=${titleBottom} cardTop=${cardTop}`)
  check('A6h Tips 行 = 入口行 + 3（第六版：两行呼吸留白后居中收尾）',
    tip === hint + 3 && (lines[hint + 1] ?? 'x').trim() === '' && (lines[hint + 2] ?? 'x').trim() === '',
    `tip=${tip} hint=${hint} mid1=${JSON.stringify(lines[hint + 1])} mid2=${JSON.stringify(lines[hint + 2])}`)
  check('A6i 整组不钉屏幕底：Tips 与双角铭牌之间仍有留白', tip >= 0 && corner > tip + 1,
    `tip=${tip} corner=${corner}`)
}
check('A7 输入框前缀是 ❯（行首不是 /）', await settled(() => base.screen().includes('❯')))
base.close()
// 无参数档：三段全拿不到时整条不画（卡片矮一行），框还在、输入还在。
{
  const ev: Ev[] = []
  const plain = await openLaunchpad(ev, { params: false })
  await settled(() => plain.screen().includes('❯'))
  const between = viewportLines(plain.term)
    .slice(rowOf(plain.term, '╭') + 1, rowOf(plain.term, '╰'))
  check('A7b 四段全空时参数行整条不画（框里只有输入行，框下一行就是入口行）',
    !plain.screen().includes('·') && between.length === 1 && between[0]!.includes('❯')
      && viewportLines(plain.term)[rowOf(plain.term, '╰') + 1]!.includes(SETTINGS_LABEL),
    JSON.stringify(between))
  plain.close()
}
// Tips：平时 launchpad-tip，首启 launchpad-first-run；input-only 连它一起撤。
{
  const ev: Ev[] = []
  const firstRun = await openLaunchpad(ev, { firstRun: true })
  check('A8 firstRun=true 时 Tips 换成首启文案（且不再有平时那句）',
    await settled(() => firstRun.screen().includes('第一次用 dsh-TUI')
      && !firstRun.screen().includes('输入 / 看全部命令')),
    firstRun.screen().slice(0, 200))
  firstRun.close()
  // input-only 是兜底档：no-art 与它同阈值，no-art 放得下时永远先命中 no-art，
  // 所以它的真挂载行数只能取 no-art 首行的下一行（溢出兜底）。
  const at = (rows: number) => resolveLaunchpadLayout(COLS, rows, { whale: true, font: FONT, params: true })
  let noArt = 1
  while (noArt <= 80 && at(noArt).stage !== 'no-art') noArt++
  const rows = noArt - 1
  const ev2: Ev[] = []
  const only = await openLaunchpad(ev2, { firstRun: true, rows })
  await settled(() => only.screen().includes('❯') || only.screen().includes('⌘') || only.screen().includes('╭'))
  check('A9 input-only 档连首启 Tips 一起撤（输入卡片必须还在）',
    !only.screen().includes('第一次用') && !only.screen().includes('●')
      && (only.screen().includes('❯') || only.screen().includes('⌘') || only.screen().includes('╭')),
    'rows=' + rows)
  only.close()
}
// Tips 行几何：● 在行首、整行居中。
{
  const ev: Ev[] = []
  const s = await openLaunchpad(ev)
  await settled(() => s.screen().includes('●'))
  const line = viewportLines(s.term).find(l => l.includes('●')) ?? ''
  const diff = Math.abs(leftGap(line) - rightGap(line, COLS))
  check('A10 Tips 行居中（左右留白差 ≤3）且以 ● Tips： 前缀开头',
    diff <= 3 && line.trimStart().startsWith('● Tips：'),
    `diff=${diff} line=${JSON.stringify(line.trim())}`)
  s.close()
}
// 光标闪烁只切换样式，不增删字符；输入行文本跨相位保持不变。
// 必须逐字节一致，否则无头回归会随相位抖动、测试变成看运气。
{
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { query: '闪烁探针' })
  await settled(() => s.screen().includes('闪烁探针'))
  const rowBefore = viewportLines(s.term).find(l => l.includes('闪烁探针')) ?? ''
  // 固定窗:探针 断言「状态不得改变」——闪烁本身是被测语义，等超过两个相位
  //（550ms/相位）再取第二帧比对。
  await new Promise(resolve => setTimeout(resolve, 1300))
  const rowAfter = viewportLines(s.term).find(l => l.includes('闪烁探针')) ?? ''
  check('A11 光标闪烁不改变视口文本（相位是纯样式切换，回归不抖动）',
    rowBefore !== '' && rowBefore === rowAfter, JSON.stringify([rowBefore, rowAfter]))
  s.close()
}

// ── B. 输入 ─────────────────────────────────────────────────────────────────
{
  const ev: Ev[] = []
  const s = await openLaunchpad(ev)
  await s.send('h')
  await s.send('i')
  check('B1 敲字按受控闭环回到 query', last(ev, 'query')?.value === 'hi', JSON.stringify(last(ev, 'query')))
  check('B2 屏幕同步显示已输入的原文', await settled(() => s.screen().includes('hi')))
  await s.send('\r')
  check('B3 Enter 把整行原文交给 onSubmit', last(ev, 'submit')?.value === 'hi', JSON.stringify(last(ev, 'submit')))
  s.close()
}
{
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { query: '/help' })
  check('B4 行首是 / 时前缀变 ⌘', await settled(() => s.screen().includes('⌘')))
  await s.send('\r')
  check('B5 命令不在本地解码，整行原文交回 Chat',
    last(ev, 'submit')?.value === '/help', JSON.stringify(last(ev, 'submit')))
  s.close()
}
{
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { query: '半句话' })
  await settled(() => s.screen().includes('半句话'))
  await s.send('\u001b')
  check('B6 有字时 Esc 只清空（不去看会话）',
    last(ev, 'query')?.value === '' && last(ev, 'escape') === undefined,
    JSON.stringify(ev))
  await new Promise(resolve => setTimeout(resolve, 60)) // 固定窗:pacing 超过 Ink 单独 Escape 的 50ms 消歧窗口
  await s.send('\u001b')
  check('B7 空输入再按 Esc 才交 sessions', last(ev, 'escape')?.value === 'sessions', JSON.stringify(ev))
  s.close()
}
{
  const ev: Ev[] = []
  const s = await openLaunchpad(ev)
  await s.send('\u0003')
  check('B8 空输入 Ctrl+C 交 exit（双击退出的第一下）', last(ev, 'escape')?.value === 'exit')
  s.close()
}
{
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { query: 'ab' })
  await s.send('\u007f')
  check('B9 退格从光标处删一个字符', last(ev, 'query')?.value === 'a', JSON.stringify(last(ev, 'query')))
  const ev2: Ev[] = []
  const s2 = await openLaunchpad(ev2, { query: 'ab' })
  await s2.send('\u001b[D')
  check('B10 ← 只移光标不改文本', last(ev2, 'query')?.value === 'ab' && last(ev2, 'query')?.cursor === 1,
    JSON.stringify(last(ev2, 'query')))
  await s2.send('\u007f')
  check('B11 光标在中间时退格删的是左边那个字符',
    last(ev2, 'query')?.value === 'b', JSON.stringify(last(ev2, 'query')))
  s.close()
  s2.close()
}

// ── B12+ 粘贴 ──
{
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { clipboard: 'UI粘贴内容' })
  await s.send('\x16') // Ctrl+V（keymap paste 动作，默认 ctrl+v）
  check('B12 Ctrl+V 把剪贴板内容插进输入框（落点 = 当下光标）',
    await settled(() => last(ev, 'query')?.value === 'UI粘贴内容')
      && await settled(() => s.screen().includes('UI粘贴内容')),
    JSON.stringify(last(ev, 'query')))
  s.close()
}
{
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { clipboard: 'a\r\nb\rc\nd' })
  await s.send('\x16')
  check('B13 多行剪贴板折叠成单行（换行→空格、\r 去掉，Enter 才是提交）',
    await settled(() => last(ev, 'query')?.value === 'a b c d'),
    JSON.stringify(last(ev, 'query')))
  s.close()
}
{
  const ev: Ev[] = []
  const s = await openLaunchpad(ev)
  const before = ev.length
  s.input.write('\u001b[200~x\ny\u001b[201~')
  await settle(() => ev.length > before)
  check('B14 bracketed paste（终端原生粘贴）也落进输入框并折叠成单行',
    last(ev, 'query')?.value === 'x y', JSON.stringify(last(ev, 'query')))
  s.close()
}
{
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { clipboard: null })
  // 不走 send()：空剪贴板不产生任何事件（send 会等到超时，提示早被 4s 定时器撤掉）。
  s.input.write('\x16')
  check('B15 剪贴板为空不静默：Tips 行换成「剪贴板为空」提示',
    await settled(() => s.screen().includes('剪贴板为空')),
    s.screen().slice(0, 200))
  s.close()
}
{
  // 异步落点守则：读回延迟窗口里继续打字，插入必须落在**当时最新**的 query/caret。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { query: 'ab', clipboard: 'X', clipboardDelay: 60 })
  const before = ev.length
  s.input.write('\x16')
  // 固定窗:pacing 读取在途的打字无可观测完成条件（键序本身是被测语义）。
  await new Promise(resolve => setTimeout(resolve, 15))
  await s.send('c') // 读取未回时先打一个字
  await settle(() => last(ev, 'query')?.value === 'abcX', { timeoutMs: 2000 })
  check('B16 异步读回用最新 query/caret（延迟窗口里打的字不被旧闭包吃掉）',
    last(ev, 'query')?.value === 'abcX', JSON.stringify(ev.slice(before)))
  s.close()
}

// ── C. 键位标签 ─────────────────────────────────────────────────────────────
{
  const ev: Ev[] = []
  const s = await openLaunchpad(ev)
  await s.send('\u001b[B')
  check('C1 ↓ 从输入框落到参数行第一段（模型，focus=-2）', last(ev, 'focus')?.value === -2,
    JSON.stringify(last(ev, 'focus')))
  await s.send('\u001b[B')
  check('C2 再 ↓ 走到第二段（思考深度，focus=-3）', last(ev, 'focus')?.value === -3)
  await s.send('\u001b[A')
  check('C3 ↑ 退回第一段', last(ev, 'focus')?.value === -2)
  await s.send('\u001b[A')
  check('C3b 第一段再 ↑ 回到输入框（环的上一格就是 -1）', last(ev, 'focus')?.value === -1,
    JSON.stringify(last(ev, 'focus')))
  // 焦点环依次经过输入框、参数段和入口。
  for (let i = 0; i < 5; i++) await s.send('\u001b[B')
  check('C3c 连 ↓ 穿过参数行落到第一条入口（focus=0）', last(ev, 'focus')?.value === 0,
    JSON.stringify(last(ev, 'focus')))
  await s.send('\r')
  check('C4 焦点在入口上时 Enter 走 onAction（不是提交输入框）',
    last(ev, 'action')?.value === 'continue' && last(ev, 'submit') === undefined,
    JSON.stringify(ev.slice(-3)))
  await s.send('x')
  check('C5 在标签行上敲字把焦点收回输入框，并接进 query',
    last(ev, 'focus')?.value === -1 && last(ev, 'query')?.value === 'x',
    JSON.stringify(ev.slice(-2)))
  s.close()
}
{
  const ev: Ev[] = []
  const s = await openLaunchpad(ev)
  await settled(() => s.screen().includes(CONTINUE_LABEL))
  const before = ev.length
  await s.click(CONTINUE_LABEL)
  check('C6 真鼠标点击入口 → onAction(同一条命令)',
    last(ev, 'action')?.value === 'continue', JSON.stringify(ev.slice(before)))
  const afterClick = ev.length
  await s.click(SESSIONS_WORKSPACE_LABEL)
  // 点击不带 motion 事件，所以这里只钉"动作落在被点的那一条"（hover 另有用例）。
  check('C7 点第二条入口 → 动作落到那一条（不是永远第一条）',
    last(ev, 'action')?.value === 'home', JSON.stringify(ev.slice(afterClick)))
  s.close()
}
{
  // hover（mode 1003 motion，无按键）→ ActionChip 的 onMouseEnter → onFocusChange；
  // 移开指针后，onMouseLeave 将焦点还给输入框。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev)
  await settled(() => findCell(s.term, HELP_LABEL) !== null)
  const target = findCell(s.term, HELP_LABEL)!
  const beforeHover = ev.length
  s.input.write(`\u001b[<35;${target.col};${target.row}M`)
  check('C7b 鼠标悬停入口即移焦点（mode 1003，无需点击；帮助 = 第 5 条，含内核入口）',
    await settled(() => last(ev, 'focus')?.value === 4), JSON.stringify(ev.slice(beforeHover)))
  // 移到入口行之外的空白格（大字区）：onMouseLeave 必须把焦点交还输入框。
  const blank = findCell(s.term, '██▀▀▄▄')!
  s.input.write(`\u001b[<35;${blank.col};${blank.row}M`)
  check('C7c 鼠标移开后焦点复原（悬停带进的焦点交还输入框，BUG 2 回归）',
    await settled(() => last(ev, 'focus')?.value === -1), JSON.stringify(ev.slice(beforeHover)))
  s.close()
}
{
  const ev: Ev[] = []
  const s = await openLaunchpad(ev)
  await s.send('\t')
  check('C8 Tab 从输入框落到参数行第一段（模型，focus=-2）',
    last(ev, 'focus')?.value === -2, JSON.stringify(ev.slice(-2)))
  const beforeBlank = ev.length
  await s.send('\t')
  check('C9 再 Tab 前进一段（思考深度，focus=-3）', last(ev, 'focus')?.value === -3,
    JSON.stringify(ev.slice(beforeBlank)))
  // 焦点环依次包含输入框、参数段、入口和 Tips 行。
  // 从 -3 再 Tab 8 次：-4→-5→0→1→2→3→4→-6（Tips），第 9 次绕回输入框。
  for (let i = 0; i < 8; i++) await s.send('\t')
  check('C9b Tab 走到环尾的 Tips 行（focus=-6，可点击目标进了焦点环）',
    last(ev, 'focus')?.value === -6, JSON.stringify(last(ev, 'focus')))
  await s.send('\t')
  check('C9c 再 Tab 绕回输入框（-1）',
    last(ev, 'focus')?.value === -1, JSON.stringify(last(ev, 'focus')))
  s.close()
}
{
  const ev: Ev[] = []
  const s = await openLaunchpad(ev)
  await s.send('\u001b[B')
  await s.send('\r')
  await settled(() => last(ev, 'action') !== undefined)
  const beforeBlank = ev.length
  // 点大字区空白格；Tips 行是可点击目标，不触发空白回调。
  await s.click('██▀▀▄▄')
  check('C10 空白点击（onBlankClick）把焦点收回输入框',
    last(ev, 'blank') !== undefined, JSON.stringify(ev.slice(beforeBlank)))
  s.close()
}
{
  // 码位边界：删一个字不能把 emoji 劈成半个代理对（prevBoundary/nextBoundary 是导出契约）
  const text = 'a\u{1F600}b'
  const prev = prevBoundary(text, 3)
  const next = nextBoundary(text, 1)
  check('C11 光标边界不落在代理对中间', prev === 1 && next === 3, 'prev=' + prev + ' next=' + next)
}
{
  // 入口使用纯文字标签；theme 和 lang 不属于动作表；
  // settings 由第三格承担（用户拍板），doctor 已移除。
  const all = [
    resolveLaunchpadActions({ lastSessionTitle: 'x', jobsRunning: false, updateAvailable: false, starDue: false }),
    resolveLaunchpadActions({ jobsRunning: true, updateAvailable: false, starDue: false }),
    resolveLaunchpadActions({ jobsRunning: false, updateAvailable: true, starDue: false }),
    resolveLaunchpadActions({ jobsRunning: false, updateAvailable: false, starDue: true }),
    resolveLaunchpadActions({ jobsRunning: true, updateAvailable: true, starDue: true }),
  ].flat()
  const commands = new Set(all.map(a => a.command))
  check('C12 theme/lang/doctor 永不在动作表（全状态枚举；settings 在第三格是第七版契约）',
    !commands.has('theme') && !commands.has('lang') && !commands.has('doctor'),
    [...commands].join(','))
}

// ── D. 阶梯降级 ─────────────────────────────────────────────────────────────
// 阈值不写死：头部的行数随字体浮动，所以档位边界由**纯函数**推导（夹具同款
// bold 字体 + params:true），再拿真实的那个行数去挂载，断言才钉的是阶梯本身。
{
  const at = (rows: number) => resolveLaunchpadLayout(COLS, rows, { whale: true, font: FONT, params: true })
  const firstRow = (stage: string): number => {
    for (let r = 1; r <= 80; r++) if (at(r).stage === stage) return r
    return -1
  }
  const fullRows = firstRow('full')
  const noTipRows = firstRow('no-tip')
  const noHintsRows = firstRow('no-hints')
  const noArtRows = firstRow('no-art')
  // input-only 是兜底档：连 no-art 都放不下时才落在它上面（两者阈值同高，
  // 从上往下取边界），所以它的边界 = no-art 首行 - 1，不能从 1 往上扫。
  const onlyRows = noArtRows - 1
  const full = at(fullRows)
  const noTip = at(noTipRows)
  const noHints = at(noHintsRows)
  const noArt = at(noArtRows)
  const only = at(onlyRows)
  check('D1 五个档位都到达得了，行数严格递减（no-art 与 input-only 同阈值，差在兜底语义）',
    fullRows > noTipRows && noTipRows > noHintsRows && noHintsRows > noArtRows && noArtRows > onlyRows && onlyRows > 0,
    [fullRows, noTipRows, noHintsRows, noArtRows, onlyRows].join(','))
  check('D1b 各档 totalRows 也严格递减（no-art 与 input-only 都撤了立绘，应相等）',
    full.totalRows > noTip.totalRows && noTip.totalRows > noHints.totalRows
      && noHints.totalRows > noArt.totalRows && noArt.totalRows === only.totalRows,
    [full.totalRows, noTip.totalRows, noHints.totalRows, noArt.totalRows, only.totalRows].join(','))
  // full 档默认保留一行间隔；少一行时先移除间隔（stage 仍为 full），
  // 再矮才撤 Tips——撤留白永远排在撤 Tips / 撤键帽之前。
  // firstRow('full') 命中的是**紧凑 full**（留白已撤）：阶梯里 full+留白比它高一行。
  check('D1c full 默认带呼吸留白；矮一行先撤留白（gap 1→0，stage 仍 full）',
    at(fullRows).stage === 'full' && at(fullRows).hintsGapRows === 0
      && at(fullRows + 1).stage === 'full' && at(fullRows + 1).hintsGapRows === 1
      && at(fullRows + 1).totalRows === at(fullRows).totalRows + 1,
    'gap@fullRows=' + at(fullRows).hintsGapRows + ' gap@fullRows+1=' + at(fullRows + 1).hintsGapRows)
  check('D1c2 第六版两处呼吸（heroGap/tipGap）与参数留白同一批撤：紧凑档 1/1、松档 2/2，恢复顺序 = 参数留白 → 两处呼吸（都在撤 Tips 之前）',
    at(fullRows).heroGapRows === 1 && at(fullRows).tipGapRows === 1
      && at(fullRows + 1).heroGapRows === 1 && at(fullRows + 1).hintsGapRows === 1
      && at(fullRows + 3).heroGapRows === 2 && at(fullRows + 3).tipGapRows === 2
      && at(fullRows + 3).totalRows === at(fullRows).totalRows + 3,
    'compact=' + at(fullRows).heroGapRows + '/' + at(fullRows).tipGapRows
      + ' loose=' + at(fullRows + 3).heroGapRows + '/' + at(fullRows + 3).tipGapRows)
  check('D1d no-tip 同样先撤留白再撤键帽（no-tip 也有留白/紧凑两档）',
    at(noTipRows).stage === 'no-tip' && at(noTipRows).hintsGapRows === 0
      && at(noTipRows + 1).stage === 'no-tip' && at(noTipRows + 1).hintsGapRows === 1,
    'gap@noTipRows=' + at(noTipRows).hintsGapRows + ' gap@noTipRows+1=' + at(noTipRows + 1).hintsGapRows)
  check('D2 full 档：立绘 + 大字 + 键位标签 + Tips + 铭牌全在，且真放得下',
    full.showWhale && full.showBigTitle && full.showHints && full.showTip && full.showCorners
      && full.totalRows <= fullRows,
    'total=' + full.totalRows + ' rows=' + fullRows)
  check('D3 no-tip 档：只撤 Tips，键位标签留着',
    !noTip.showTip && noTip.showHints && noTip.showWhale && noTip.totalRows <= noTipRows,
    'total=' + noTip.totalRows + ' rows=' + noTipRows)
  check('D4 no-hints 档：键位标签也撤，头部（立绘+大字）留着',
    !noHints.showHints && !noHints.showTip && noHints.showWhale && noHints.showBigTitle
      && noHints.showHero && noHints.totalRows <= noHintsRows,
    'total=' + noHints.totalRows + ' rows=' + noHintsRows)
  check('D5 no-art 档：立绘撤掉，大字留着',
    !noArt.showWhale && noArt.showBigTitle && !noArt.showHints && !noArt.showTip
      && noArt.showHero && noArt.showCorners && noArt.totalRows <= noArtRows,
    'total=' + noArt.totalRows + ' rows=' + noArtRows)
  check('D5b input-only 兜底档：连它都放不下时也保卡片与铭牌（溢出保输入）',
    only.stage === 'input-only' && !only.showWhale && !only.showHints && !only.showTip
      && only.showHero && only.showCorners,
    'stage=' + only.stage + ' total=' + only.totalRows + ' rows=' + onlyRows)
  check('D5c params 缺席时整屏矮两行（参数行 + 只为它存在的呼吸留白；卡片恒 3 行）',
    resolveLaunchpadLayout(COLS, ROWS, { whale: true, font: FONT, params: true }).totalRows
      - resolveLaunchpadLayout(COLS, ROWS, { whale: true, font: FONT, params: false }).totalRows === 2
      && resolveLaunchpadLayout(COLS, ROWS, { whale: true, font: FONT, params: false }).cardRows === 3
      && resolveLaunchpadLayout(COLS, ROWS, { whale: true, font: FONT, params: false }).hintsGapRows === 0)
}
{
  const at = (rows: number) => resolveLaunchpadLayout(COLS, rows, { whale: true, font: FONT, params: true })
  const firstRow = (stage: string): number => {
    for (let r = 1; r <= 80; r++) if (at(r).stage === stage) return r
    return -1
  }
  {
    const rows = firstRow('full')
    const ev: Ev[] = []
    const s = await openLaunchpad(ev, { rows })
    check('D6 真挂载 full 档：动作入口行 + Tips 圆点 + 铭牌都在',
      await settled(() => s.screen().includes(CONTINUE_LABEL) && s.screen().includes('●')
        && s.screen().includes('dsh-tui v' + VERSION)), 'rows=' + rows)
    s.close()
  }
  {
    const rows = firstRow('no-tip')
    const ev: Ev[] = []
    const s = await openLaunchpad(ev, { rows })
    check('D7 真挂载 no-tip 档：Tips 行整块撤掉，动作入口还在',
      await settled(() => !s.screen().includes('●') && !s.screen().includes('看全部命令')
        && s.screen().includes(CONTINUE_LABEL)), 'rows=' + rows)
    s.close()
  }
  {
    const rows = firstRow('no-hints')
    const ev: Ev[] = []
    const s = await openLaunchpad(ev, { rows })
    check('D8 真挂载 no-hints 档：动作入口行也撤掉，立绘还画着',
      await settled(() => !s.screen().includes('●') && !s.screen().includes(CONTINUE_LABEL)
        && (at(rows).showWhale ? s.screen().includes('▀▀▀▀▄  ▄▄▀▀▀') : true)
        && s.screen().includes('██▀▀▄▄')), 'rows=' + rows)
    s.close()
  }
  {
    const rows = firstRow('no-art')
    const ev: Ev[] = []
    const s = await openLaunchpad(ev, { rows })
    check('D9 真挂载 no-art 档：立绘没了，大字与输入卡片留着',
      await settled(() => !s.screen().includes('▄▄▀▀▀') && s.screen().includes('██▀▀▄▄')
        && s.screen().includes('❯') && s.screen().includes('dsh-tui v' + VERSION)), 'rows=' + rows)
    s.close()
  }
  {
    const rows = firstRow('no-art') - 1
    const ev: Ev[] = []
    const s = await openLaunchpad(ev, { rows })
    check('D10 真挂载 input-only（溢出兜底）：立绘撤掉、输入卡片必须还在',
      await settled(() => !s.screen().includes('▄▄▀▀▀')
        && (s.screen().includes('❯') || s.screen().includes('⌘') || s.screen().includes('╭'))), 'rows=' + rows)
    s.close()
  }
}

// ── E. 纯函数（resolveLaunchpadActions 表驱动 + fitChips + 截断）──────────────
{
  // 表驱动回归：每种条件组合都核对入口行与优先级——
  // 单独成立、多个同时成立、全不成立三类都要钉（详见 launchpadActions.ts）。
  const BASE = { lastSessionTitle: '修个登录页', jobsRunning: false, updateAvailable: false, starDue: false }
  const rows: readonly { name: string; state: Record<string, unknown>; ids: readonly string[]; commands: readonly string[]; firstLabelKey?: string }[] = [
    { name: '常态（条件位全不成立 → 帮助兜底）', state: BASE, ids: ['continue', 'sessions-workspace', 'settings', 'backend', 'help'], commands: ['continue', 'home', 'settings', 'kernel', 'help'] },
    { name: '条件位①单独成立（jobs）', state: { ...BASE, jobsRunning: true }, ids: ['continue', 'sessions-workspace', 'settings', 'backend', 'jobs'], commands: ['continue', 'home', 'settings', 'kernel', 'jobs'] },
    { name: '条件位②单独成立（update）', state: { ...BASE, updateAvailable: true }, ids: ['continue', 'sessions-workspace', 'settings', 'backend', 'update'], commands: ['continue', 'home', 'settings', 'kernel', 'update'] },
    { name: '条件位③单独成立（star）', state: { ...BASE, starDue: true }, ids: ['continue', 'sessions-workspace', 'settings', 'backend', 'star'], commands: ['continue', 'home', 'settings', 'kernel', 'star'] },
    { name: '①+②同时成立：①胜（jobs > update）', state: { ...BASE, jobsRunning: true, updateAvailable: true }, ids: ['continue', 'sessions-workspace', 'settings', 'backend', 'jobs'], commands: ['continue', 'home', 'settings', 'kernel', 'jobs'] },
    { name: '②+③同时成立：②胜（update > star）', state: { ...BASE, updateAvailable: true, starDue: true }, ids: ['continue', 'sessions-workspace', 'settings', 'backend', 'update'], commands: ['continue', 'home', 'settings', 'kernel', 'update'] },
    { name: '①+③同时成立：①胜（jobs > star）', state: { ...BASE, jobsRunning: true, starDue: true }, ids: ['continue', 'sessions-workspace', 'settings', 'backend', 'jobs'], commands: ['continue', 'home', 'settings', 'kernel', 'jobs'] },
    { name: '①②③全成立：①胜', state: { ...BASE, jobsRunning: true, updateAvailable: true, starDue: true }, ids: ['continue', 'sessions-workspace', 'settings', 'backend', 'jobs'], commands: ['continue', 'home', 'settings', 'kernel', 'jobs'] },
    { name: '无上次会话（Continue 整格缺席，条件位照常）', state: { jobsRunning: false, updateAvailable: false, starDue: false }, ids: ['sessions-workspace', 'settings', 'backend', 'help'], commands: ['home', 'settings', 'kernel', 'help'] },
    { name: '无上次会话 × 条件位①', state: { jobsRunning: true, updateAvailable: false, starDue: false }, ids: ['sessions-workspace', 'settings', 'backend', 'jobs'], commands: ['home', 'settings', 'kernel', 'jobs'] },
  ]
  for (const row of rows) {
    const actions = resolveLaunchpadActions(row.state as never)
    check(`E1 ${row.name}：位置 = ${row.ids.join('/')}`,
      actions.length === row.ids.length && actions.every((a, i) => a.id === row.ids[i] && a.command === row.commands[i]),
      actions.map(a => a.id + ':' + a.command).join(','))
    if (row.firstLabelKey !== undefined) {
      check(`E1b ${row.name}：首位条件按钮用 ${row.firstLabelKey}`, actions[0]?.labelKey === row.firstLabelKey,
        actions[0]?.labelKey ?? '')
    }
  }
  // 纯函数：不改入参（深冻结夹具，若函数原地写会抛 TypeError）。
  const frozen = Object.freeze({ lastSessionTitle: '冻结标题', jobsRunning: false, updateAvailable: false, starDue: false })
  const fromFrozen = resolveLaunchpadActions(frozen)
  check('E2 纯函数：不改入参（冻结状态对象直解）',
    fromFrozen.length === 5 && frozen.lastSessionTitle === '冻结标题',
    JSON.stringify(fromFrozen.map(a => a.id)))
  // Continue 带标题：标签键 + 插值；标题超宽截断（含省略号、显示宽度封顶）。
  const titled = resolveLaunchpadActions({ lastSessionTitle: '修个登录页', jobsRunning: false, updateAvailable: false, starDue: false })
  check('E3 有上次会话时 Continue 带标题（labelKey = continue-titled，values.title）',
    titled[0]?.labelKey === 'launchpad-action-continue-titled' && titled[0]?.values?.title === '修个登录页',
    JSON.stringify(titled[0]))
  const long = resolveLaunchpadActions({ lastSessionTitle: '这是一个特别特别特别特别特别长的会话标题', jobsRunning: false, updateAvailable: false, starDue: false })
  check('E4 超宽标题截断到省略号（宽度 ≤ 上限、尾部是 …）',
    (long[0]?.values?.title ?? '').endsWith('…') && stringWidth(long[0]?.values?.title ?? '') <= LAUNCHPAD_CONTINUE_TITLE_MAX,
    JSON.stringify(long[0]?.values?.title))
  check('E5 truncateContinueTitle 边界：空串/纯空白=空、短串原样、换行折叠',
    truncateContinueTitle('') === '' && truncateContinueTitle('   ') === '' && truncateContinueTitle('短标题') === '短标题'
      && truncateContinueTitle('a\nb') === 'a b',
    JSON.stringify([truncateContinueTitle(''), truncateContinueTitle('短标题'), truncateContinueTitle('a\nb')]))
  // 空标题 = 无历史：落到常态档（没有点了没反应的 Continue）。
  check('E6 lastSessionTitle 为空白 = 无历史（不造 Continue，落常态档）',
    resolveLaunchpadActions({ lastSessionTitle: '   ', jobsRunning: false, updateAvailable: false, starDue: false })[0]?.id === 'sessions-workspace',
    resolveLaunchpadActions({ lastSessionTitle: '   ', jobsRunning: false, updateAvailable: false, starDue: false }).map(a => a.id).join(','))
  // 内核入口：backendId 缺省时使用短标签，提供时显示对应名称（名称来自
  // kernelCatalog 的 displayName，chip 上屏「内核 · Claude」/「Kernel · DSH」）。
  const namedBackend = resolveLaunchpadActions({ lastSessionTitle: '修个登录页', jobsRunning: false, updateAvailable: false, starDue: false, backendId: 'claude' })
  check('E6b backendId=claude：内核入口带名（labelKey = backend-named，values.name = Claude）',
    namedBackend.find(a => a.id === 'backend')?.labelKey === 'launchpad-action-backend-named' && namedBackend.find(a => a.id === 'backend')?.values?.name === 'Claude',
    JSON.stringify(namedBackend.find(a => a.id === 'backend')))
  check("E6c backendId 缺省：内核入口用短标签（无插值，阶段B接线前的回退）",
    resolveLaunchpadActions({ lastSessionTitle: '修个登录页', jobsRunning: false, updateAvailable: false, starDue: false }).find(a => a.id === 'backend')?.labelKey === 'launchpad-action-backend'
      && resolveLaunchpadActions({ lastSessionTitle: '修个登录页', jobsRunning: false, updateAvailable: false, starDue: false }).find(a => a.id === 'backend')?.values === undefined)
  check('E6d backendId=dsh：带名 DSH',
    resolveLaunchpadActions({ jobsRunning: false, updateAvailable: false, starDue: false, backendId: 'dsh' }).find(a => a.id === 'backend')?.values?.name === 'DSH')
}
{
  const labels = DEFAULT_ACTIONS.map(a => t(a.labelKey as never, a.values as never))
  const wide = fitChips(labels, COLS)
  const allComplete = wide.every(chip => labels[chip.index] === chip.label)
  check('E8 fitChips 只整条取用，绝不切半个标签（120 列五条全画）', allComplete && wide.length === 5,
    wide.map(c => c.label).join(' | '))
  const narrow = fitChips(['这是一个很长的入口标签'], 8)
  check('E9 放不下就整条不画（不是截断）', narrow.length === 0,
    JSON.stringify(narrow))
  // 48 列：预算 44，四条 zh 标签装不下最后一条（模型）——整条裁掉、不切半。
}

// ── K. 内核选择：目录、kernel.json 记忆与 boot 优先级 ──
{
  const { buildKernelCatalog, kernelDisplayName, kernelVersionLabel, kernelSubtitle } = await import('../src/components/kernelCatalog.js')
  const { readKernelPrefs, writeKernelPrefs, resolveRememberedBackend } = await import('../src/kernelPrefs.js')
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  // 目录：DSH 恒在恒可选（默认内核）；claude 依探测结果定可选性。版本一律是
  // **显示串**（产品前缀 + 版本号），不再是裸版本号。
  const dshOnly = buildKernelCatalog({ current: 'dsh', dshVersion: '0.2.6' })
  check('K1 目录：DSH 恒可选并带版本显示串；claude / codex 未探测=置灰为「检测中…」（不是未安装）',
    dshOnly.length === 3 && dshOnly[0]?.id === 'dsh' && dshOnly[0]?.current === true && dshOnly[0]?.selectable === true && dshOnly[0]?.version === 'dsh-core v0.2.6'
      && dshOnly[1]?.id === 'claude' && dshOnly[1]?.current === false && dshOnly[1]?.selectable === false && dshOnly[1]?.reasonKey === 'kernel-probing'
      && dshOnly[2]?.id === 'codex' && dshOnly[2]?.selectable === false && dshOnly[2]?.reasonKey === 'kernel-probing',
    JSON.stringify(dshOnly))
  const ok = buildKernelCatalog({ current: 'claude', dshVersion: '0.2.6', statuses: { claude: { installed: true, auth: 'ok', version: '2.1.287' } } })
  check('K2 目录：installed+auth=ok 的 claude 可选、版本显示串、current 标记在 claude',
    ok[0]?.current === false && ok[1]?.selectable === true && ok[1]?.current === true && ok[1]?.version === 'claude-code v2.1.287' && ok[1]?.reasonKey === undefined,
    JSON.stringify(ok))
  check('K3 目录：auth=missing 置灰(未登录)；auth=unknown 仍可选（分不清≠没有）；installed=false → 未安装',
    buildKernelCatalog({ current: 'dsh', statuses: { claude: { installed: true, auth: 'missing', version: '1.2.3' } } })[1]?.selectable === false
      && buildKernelCatalog({ current: 'dsh', statuses: { claude: { installed: true, auth: 'missing' } } })[1]?.reasonKey === 'kernel-unavailable-auth-missing'
      && buildKernelCatalog({ current: 'dsh', statuses: { claude: { installed: true, auth: 'unknown' } } })[1]?.selectable === true
      && buildKernelCatalog({ current: 'dsh', statuses: { claude: { installed: false, version: '1.2.3' } } })[1]?.reasonKey === 'kernel-unavailable-not-installed')
  check('K4 显示名：dsh→DSH、claude→Claude（chip 插值与重启通知共用）',
    kernelDisplayName('dsh') === 'DSH' && kernelDisplayName('claude') === 'Claude')
  // 版本显示串：产品前缀表（dsh→dsh-core、claude→claude-code）；空/缺省 = undefined
  // （调用方整段省掉，绝不画一个空壳的 v）；未知 id 不编造产品名。
  check('K4b kernelVersionLabel：产品前缀 + 空格 + v + 版本号；空串/缺省 undefined；未知 id 裸版本',
    kernelVersionLabel('dsh', '0.2.0-rc.2') === 'dsh-core v0.2.0-rc.2'
      && kernelVersionLabel('claude', '2.0.1') === 'claude-code v2.0.1'
      && kernelVersionLabel('dsh', '') === undefined && kernelVersionLabel('dsh') === undefined
      && kernelVersionLabel('custom', '9.9.9') === '9.9.9',
    JSON.stringify([kernelVersionLabel('dsh', '0.2.0-rc.2'), kernelVersionLabel('dsh', ''), kernelVersionLabel('custom', '9.9.9')]))
  // 副标题：版本 · 置灰原因——谁有拼谁，两样都没有 = undefined（底栏与选择器共用）。
  const subtitleOf = (input: Parameters<typeof buildKernelCatalog>[0]) => buildKernelCatalog(input).map(option => kernelSubtitle(option, key => 'R:' + key))
  check('K4c kernelSubtitle：版本·原因 / 只有版本 / 只有原因 / 都没有=undefined',
    subtitleOf({ current: 'dsh', dshVersion: '0.2.6' })[1] === 'R:kernel-probing'
      && subtitleOf({ current: 'dsh', dshVersion: '0.2.6', statuses: { claude: { installed: false } } })[1] === 'R:kernel-unavailable-not-installed'
      && subtitleOf({ current: 'dsh', dshVersion: '0.2.6' })[0] === 'dsh-core v0.2.6'
      && subtitleOf({ current: 'dsh' })[0] === undefined
      && subtitleOf({ current: 'dsh', statuses: { claude: { installed: true, auth: 'missing', version: '1.2.3' } } })[1] === 'claude-code v1.2.3 · R:kernel-unavailable-auth-missing',
    JSON.stringify(subtitleOf({ current: 'dsh', dshVersion: '0.2.6' })))

  // kernel.json 记忆：原子写（tmp+rename，claude prefs.ts 同款）往返。
  const dir = mkdtempSync(join(tmpdir(), 'verify-launchpad-kernel-'))
  const file = join(dir, 'kernel.json')
  writeKernelPrefs({ backend: 'claude' }, file)
  check('K5 kernel.json：写后读回（形状 backend: claude，原子 tmp+rename）',
    readKernelPrefs(file).backend === 'claude' && readFileSync(file, 'utf8').includes('"backend": "claude"'),
    readFileSync(file, 'utf8'))
  writeKernelPrefs({ backend: 'dsh' }, file)
  check('K5b kernel.json：覆盖写往返（claude→dsh）', readKernelPrefs(file).backend === 'dsh')
  writeFileSync(file, '{ not json', 'utf8')
  check('K6 kernel.json：坏 JSON 读作无记忆（读失败=无记忆，不抛）', readKernelPrefs(file).backend === undefined)
  writeFileSync(file, '{"backend":"nonsense"}', 'utf8')
  check('K6b kernel.json：非法 backend 值读作无记忆', readKernelPrefs(file).backend === undefined)
  writeFileSync(file, '{"backend":"claude","extra":1}', 'utf8')
  check('K6c kernel.json：未知字段容忍，backend 保留', readKernelPrefs(file).backend === 'claude')

  // boot 优先级：config > env > memory > dsh（launchpad 记忆只垫底）。
  const P = (configured?: 'dsh' | 'claude', envRaw?: string, memory?: 'dsh' | 'claude') =>
    resolveRememberedBackend({ configured, envRaw, memory })
  check('K7 boot 优先级：config 压过 env+记忆；env 压过记忆；记忆垫底；全空=dsh',
    P('dsh', 'claude', 'claude') === 'dsh' && P(undefined, 'claude', 'dsh') === 'claude'
      && P(undefined, undefined, 'claude') === 'claude' && P() === 'dsh')
  check('K7b boot 优先级：非法 env → dsh（不是记忆——与启动警告 starting on dsh 一致）；空白 env = 无 env',
    P(undefined, 'nonsense', 'claude') === 'dsh' && P(undefined, '  CLAUDE  ', 'dsh') === 'claude' && P(undefined, '', 'claude') === 'claude')
  check('K7c boot 优先级：env 大小写/空白归一（镜像 normalizeBackendChoice）',
    P(undefined, 'Claude', 'dsh') === 'claude' && P(undefined, ' dsh ', 'claude') === 'dsh')
  // 记忆只被选择器写：boot 解析（读路径）绝不改文件。
  writeKernelPrefs({ backend: 'claude' }, file)
  const before = readFileSync(file, 'utf8')
  void P(); void P(undefined, undefined, 'dsh'); void P('claude'); void P(undefined, 'dsh')
  check('K8 记忆不被 boot 读取改写（读路径零写入；显式 --backend 启动也不改写——boot 不调 write）', readFileSync(file, 'utf8') === before)

  // 一次性内核切换必须让替换进程启动到目标内核——
  // restartTui 的 backend 选项把 KERNEL_SWITCH_HANDOFF_ENV 放进替换进程
  // env，boot 的 resolver 把它排在 Config 行之前；没有它，显式 backend: dsh
  // 的配置行让切换白重启一回。普通冷启动合同（K7）不动。
  const H = (handoff?: 'dsh' | 'claude', configured?: 'dsh' | 'claude', envRaw?: string, memory?: 'dsh' | 'claude') =>
    resolveRememberedBackend({ ...(handoff === undefined ? {} : { handoff }), configured, envRaw, memory })
  check('K10 切换 handoff 压过 Config：configured=dsh/env=claude/memory=claude/handoff=claude → claude；同参数无 handoff 仍 → dsh',
    H('claude', 'dsh', 'claude', 'claude') === 'claude' && H(undefined, 'dsh', 'claude', 'claude') === 'dsh')
  check('K10b 反向切换同样成立：handoff=dsh 压过 configured=claude',
    H('dsh', 'claude', 'claude', 'claude') === 'dsh')
  check('K10c 非法 handoff 按不存在处理（回落到 Config > env > memory）',
    resolveRememberedBackend({ handoff: 'nonsense' as never, configured: 'claude' }) === 'claude'
      && resolveRememberedBackend({ handoff: '' as never, memory: 'claude' }) === 'claude')

  // 组合根整链：restartChildEnv 生成切换进程环境变量 →
  // 用 boot 同款输入喂真实 resolver，断言落到目标内核（选择器侧的
  // onSwitchBackend 驱动由 verify-launchpad-onboarding-chat X5 锁定）。
  const { restartChildEnv, writeLastRunRecord, readLastRunRecord } = await import('../src/update.js')
  const { KERNEL_SWITCH_HANDOFF_ENV: HANDOFF_ENV } = await import('../src/kernelPrefs.js')
  const captured = restartChildEnv(
    // 一个被显式钉在 dsh 上的外层进程（--backend dsh 启动 + 旧内核的自动
    // resume marker 在 env 里）接受切换 → claude：
    { DSH_TUI_BACKEND: 'dsh', DSH_TUI_RESUME_SESSION: 'dsh-session-1' },
    '',
    'restart',
    { backend: 'claude' },
  )
  check('K11 切换替换 env：backend/handoff 都钉到目标内核，旧内核的 resume marker 被滤掉',
    captured.DSH_TUI_BACKEND === 'claude' && captured[HANDOFF_ENV] === 'claude' && captured.DSH_TUI_RESUME_SESSION === undefined,
    JSON.stringify({ backend: captured.DSH_TUI_BACKEND, handoff: captured[HANDOFF_ENV], resume: captured.DSH_TUI_RESUME_SESSION }))
  // boot 读法与 plugin.ts 相同：handoff 从捕获 env 读、backend 原文进 envRaw、
  // Config 行仍钉旧内核（dsh）——组合根必须解析到 claude。
  check('K11b 组合根解析：捕获 env + Config 行钉 dsh → 实际落到 claude（不是白重启）',
    resolveRememberedBackend({ handoff: 'claude', configured: 'dsh', envRaw: captured.DSH_TUI_BACKEND, memory: 'dsh' }) === 'claude')
  check('K11c 无 handoff 键的同一 env 仍按 Config 走 dsh（K7 合同不被顺手改掉）',
    resolveRememberedBackend({ configured: 'dsh', envRaw: captured.DSH_TUI_BACKEND, memory: 'dsh' }) === 'dsh')
  check('K11d 普通 /restart 替换 env 不携带任何 handoff 覆盖（一次性，不外泄给非切换子进程）',
    restartChildEnv({ [HANDOFF_ENV]: 'claude' } as NodeJS.ProcessEnv, 's1', 'restart', {})[HANDOFF_ENV] === undefined)
  // boot 消费即删除：一次性语义的变异陷阱（读了不删 → 泄漏给孙进程）。
  const bootSource = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
  check('K12 plugin.ts boot 消费 handoff 后从 process.env 删除（一次性语义）',
    bootSource.includes('delete process.env[KERNEL_SWITCH_HANDOFF_ENV]'))

  // ── 内核切换后的最后运行记录 ──
  // 记录由最后运行的实例写（plugin boot + 退出漏斗刷新），launcher 的
  // fallback retry 重新读取并明确置新 backend。这里锁 src 侧的往返与容错，
  // 以及组合根的写入接线；bin 侧的 retry 权威次序在 verify-safe-mode。
  const recordDir = mkdtempSync(join(tmpdir(), 'verify-launchpad-lastrun-'))
  const recordFile = join(recordDir, 'last-run.json')
  writeLastRunRecord({ backendId: 'claude', sessionId: 'claude-42', cwd: 'D:/w', attemptId: 'a1', pid: 4242 }, recordFile)
  const stamped = readLastRunRecord(recordFile)
  check('LR1 last-run 记录原子写往返（updatedAt 由写入侧盖章）',
    stamped !== undefined && stamped.backendId === 'claude' && stamped.sessionId === 'claude-42' && stamped.cwd === 'D:/w' && stamped.attemptId === 'a1' && stamped.pid === 4242 && typeof stamped.updatedAt === 'number' && stamped.updatedAt > 0,
    JSON.stringify(stamped))
  writeLastRunRecord({ backendId: 'dsh', sessionId: '', cwd: 'D:/w', attemptId: 'a2' }, recordFile)
  check('LR1b 空会话（无可恢复）也如实落盘：sessionId 空串保留（重试=目标内核冷启动）',
    readLastRunRecord(recordFile)?.sessionId === '')
  writeFileSync(recordFile, '{ not json', 'utf8')
  check('LR2 坏 JSON 读作 undefined（不抛）', readLastRunRecord(recordFile) === undefined)
  writeFileSync(recordFile, '{"backendId":"nonsense","sessionId":"x","cwd":"c","attemptId":"a","updatedAt":1}', 'utf8')
  check('LR2b 非法 backendId 读作 undefined（拒绝跨域恢复的载体）', readLastRunRecord(recordFile) === undefined)
  writeFileSync(recordFile, '{"backendId":"claude","sessionId":"x","attemptId":"a","updatedAt":1}', 'utf8')
  check('LR2c 缺 cwd 字段读作 undefined', readLastRunRecord(recordFile) === undefined)
  const blocker2 = join(recordDir, 'blocker-file')
  writeFileSync(blocker2, 'x')
  let recordThrew = false
  try {
    writeLastRunRecord({ backendId: 'dsh', sessionId: 's', cwd: 'c', attemptId: 'a' }, blocker2)
  } catch {
    recordThrew = true
  }
  check('LR3 写失败绝不抛（best-effort，退化到 launcher 旧逻辑）', !recordThrew)
  rmSync(recordDir, { recursive: true, force: true })
  // 组合根写入接线：启动与退出路径都要更新最后运行记录。
  const funnelSource = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
  const refreshCalls = funnelSource.split('refreshLastRunRecord()').length - 1
  check('LR4 plugin.ts 写记录接线齐：boot 落盘 + 崩溃/更新//restart/干净退出四个漏斗分支刷新（内核切换分支不写——替换进程自己写）',
    funnelSource.includes('const refreshLastRunRecord = (): void =>') && refreshCalls === 5,
    'refresh calls=' + refreshCalls)

  // 启动页的 boot 门（用户实测：kernel.json 记住 claude 后全新启动直接进聊天页、
  // 没有启动页）。契约断言组合根 plugin.ts 里的**调用点**——门只剩 noResume
  // （带 resume 目标的启动直达会话）与 DSH_TUI_NO_LAUNCHPAD（自动化逃生门），
  // backend 不参与：记住的内核是 dsh 还是 claude，全新启动一律先落启动页。
  const pluginSource = readFileSync(new URL('../src/dsh-adapter/plugin.ts', import.meta.url), 'utf8')
  const declLine = (name: string): string => {
    const at = pluginSource.indexOf('const ' + name + ' = ')
    const end = pluginSource.indexOf('\n', at)
    return at < 0 || end < 0 ? '' : pluginSource.slice(at, end)
  }
  const launchpadBoot = declLine('launchpadOnBoot')
  check('K9 启动页 boot 门：launchpadOnBoot 不带 dshBoot（claude 记忆启动同样落启动页），门仍是 noResume + DSH_TUI_NO_LAUNCHPAD',
    launchpadBoot.includes('noResume') && launchpadBoot.includes('DSH_TUI_NO_LAUNCHPAD') && !launchpadBoot.includes('dshBoot'),
    launchpadBoot)
  check('K9b 另两个 boot 屏仍 DSH 专属：workspace home 与首启引导的门不动（dshBoot 保留）',
    declLine('openHomeOnBoot').includes('dshBoot') && declLine('onboardingOnBoot').includes('dshBoot'),
    declLine('openHomeOnBoot') + ' / ' + declLine('onboardingOnBoot'))
}

// ── Q. 纯函数：参数行三段式（fitParamParts；AC-1/2/3/5 的纯函数层）─────────
// DESIGN D1 的三档：①四段原样装得下 → 逐字节不变；②装不下 → 按「可缩减量最大」
// 逐步**尾部截断**（权限段不被截断、宽度 ≤ 下限的段不可减）；③非权限段全到下限
// 仍超预算 → 复用今天的尾部省段（原始宽度、按显示顺序、首个超预算即 break）。
// 断言锚在**宽度关系与档位**上（总宽 ≤ 预算 / truncated 标志 / 权限段一字不少 /
// 尾部是 …），不把「第 66 列」这类计数写成判据（L-025）——数字只出现在载荷里。
{
  interface ParamRow {
    readonly segment: string
    readonly value: string
    readonly colored?: boolean
  }
  /** 参数段之间的分隔符（与 Launchpad 版式同一条：两侧各两格）。 */
  const SEPARATOR = '  ·  '
  // 分隔符是**一个决定**，不是三份字面量：模块导出的常量与这里的字面量（版式
  // 契约的独立复制品）必须一致——屏幕层另有逐字节断言（`PARAM_LINE`）。对不上
  // 就在这里早红，别等屏上错位。T03 接入时请用 `PARAM_SEPARATOR` 渲染分隔符。
  check('Q0 分隔符常量与版式字面量逐字节一致', PARAM_SEPARATOR === SEPARATOR, JSON.stringify(PARAM_SEPARATOR))
  /** 一段参数行的显示宽度：各段宽之和 + 分隔符 ×（段数 - 1）。 */
  const lineWidth = (parts: readonly { value: string }[]): number =>
    parts.reduce((sum, part, index) => sum + stringWidth(part.value) + (index === 0 ? 0 : stringWidth(SEPARATOR)), 0)
  /**
   * 今天的尾部省段（改造前 `Launchpad.tsx` 参数行的累加循环，逐字节复刻）。
   * 兜底档必须与它逐字节一致，所以这里**独立写一份当期望**，绝不复用被测函数
   * ——拿实现证实现等于没证。只做宽度累加，不参与任何截断。
   */
  const legacyFit = (parts: readonly ParamRow[], budget: number): readonly string[] => {
    const kept: string[] = []
    let used = 0
    for (const part of parts) {
      const width = stringWidth(part.value)
      const next = kept.length === 0 ? width : used + stringWidth(SEPARATOR) + width
      if (next > budget) break
      kept.push(part.value)
      used = next
    }
    return kept
  }
  /**
   * 契约推出来的「截断档下限预算」：非权限段压到 `PARAM_SEGMENT_MIN_WIDTH`、
   * 权限段一字不减，再加分隔符。它是 D2/D4 的定义，不是实现的中间量。
   */
  const floorBudget = (parts: readonly ParamRow[]): number => parts.reduce(
    (sum, part, index) => sum + (index === 0 ? 0 : stringWidth(SEPARATOR))
      + (part.segment === PARAM_UNTRUNCABLE_SEGMENT
        ? stringWidth(part.value)
        : Math.min(stringWidth(part.value), PARAM_SEGMENT_MIN_WIDTH)),
    0,
  )
  /** AC-1 的复现载荷：38 格的 agent preset 显示名（`·` 按窄字符算 1 格）。 */
  const PRESET_LONG = 'Standard (Git Bash · official tooling)'
  /** 既有夹具四段（120 列 / 预算 70）：改造前后必须逐字节一致。 */
  const FIXTURE_PARTS: readonly ParamRow[] = [
    { segment: 'model', value: 'glm-5.3', colored: true },
    { segment: 'effort', value: 'Max' },
    { segment: 'preset', value: 'Standard' },
    { segment: 'permission', value: 'default' },
  ]
  // 载荷里的 `effort` 传的是**显示值** `Max`：组件在调纯函数前已把首字母大写
  // （`Launchpad.tsx` 的 paramParts），T03 接入时保持该口径。
  const AC1_PARTS: readonly ParamRow[] = [
    { segment: 'model', value: 'deepseek-flash', colored: true },
    { segment: 'effort', value: 'Max' },
    { segment: 'preset', value: PRESET_LONG },
    { segment: 'permission', value: 'danger-full-access' },
  ]
  /** AC-2①：preset 极长（76 格），其余段与 AC-1 同。 */
  const PRESET_HUGE_PARTS: readonly ParamRow[] = [
    AC1_PARTS[0] as ParamRow,
    AC1_PARTS[1] as ParamRow,
    { segment: 'preset', value: PRESET_LONG + ' — nightly variant with custom tooling' },
    AC1_PARTS[3] as ParamRow,
  ]
  /** AC-2②：模型名（48 格）与 preset（38 格）都长。 */
  const MODEL_AND_PRESET_LONG_PARTS: readonly ParamRow[] = [
    { segment: 'model', value: 'deepseek-official/deepseek-flash-preview-2027-10', colored: true },
    AC1_PARTS[1] as ParamRow,
    AC1_PARTS[2] as ParamRow,
    AC1_PARTS[3] as ParamRow,
  ]
  const cases: readonly {
    readonly name: string
    readonly parts: readonly ParamRow[]
    readonly budget: number
    readonly tier: 'fit' | 'truncated' | 'fallback'
    readonly truncatedSegments: readonly string[]
  }[] = [
    { name: '装得下：既有夹具四段 @120 列预算（AC-3 纯函数层）', parts: FIXTURE_PARTS, budget: 70, tier: 'fit', truncatedSegments: [] },
    { name: 'AC-1 长 preset（预算 70）：四段都在、只截 preset', parts: AC1_PARTS, budget: 70, tier: 'truncated', truncatedSegments: ['preset'] },
    { name: 'AC-2① preset 极长：… 只出现在最长的非权限段', parts: PRESET_HUGE_PARTS, budget: 70, tier: 'truncated', truncatedSegments: ['preset'] },
    { name: 'AC-2② preset 与 model 都长：两段被截、权限段不动', parts: MODEL_AND_PRESET_LONG_PARTS, budget: 70, tier: 'truncated', truncatedSegments: ['model', 'preset'] },
    { name: 'AC-5 窄预算 42（@48 列）：回落今天的尾部省段', parts: AC1_PARTS, budget: 42, tier: 'fallback', truncatedSegments: [] },
    { name: '边界：预算 = 各段下限之和（截断档边缘，四段都在）', parts: AC1_PARTS, budget: floorBudget(AC1_PARTS), tier: 'truncated', truncatedSegments: ['model', 'preset'] },
    { name: '边界：下限之和 - 1（兜底档边缘）', parts: AC1_PARTS, budget: floorBudget(AC1_PARTS) - 1, tier: 'fallback', truncatedSegments: [] },
  ]
  for (const [index, row] of cases.entries()) {
    const label = `Q${index + 1} ${row.name}`
    const fitted = fitParamParts(row.parts, row.budget)
    const values = fitted.map(part => part.value)
    const original = row.parts.map(part => part.value)
    const total = lineWidth(fitted)
    const allPresent = fitted.length === row.parts.length
    const truncatedNow = fitted.filter(part => part.truncated).map(part => part.segment)
    // ① 档位判据（不是列数判据）：fit / fallback 两档要求行文本与「原样」/「今天的
    //    省段」逐字节一致；截断档要求四段都在——截断永不省段，省段才是兜底。
    const expectedLine = row.tier === 'fit'
      ? original.join(SEPARATOR)
      : row.tier === 'fallback'
        ? legacyFit(row.parts, row.budget).join(SEPARATOR)
        : undefined
    check(`${label}：档位 = ${row.tier}`,
      row.tier === 'truncated' ? allPresent : values.join(SEPARATOR) === expectedLine,
      `tier=${row.tier} present=${fitted.length}/${row.parts.length} line=${JSON.stringify(values.join(SEPARATOR))} expected=${JSON.stringify(expectedLine)}`)
    // ② 单行不变量：三档任何一档都不许超预算。
    check(`${label}：总宽 ≤ 预算`, total <= row.budget, `total=${total} budget=${row.budget}`)
    // ③ 缩减对象由 D2「可缩减量最大优先」决定——表里逐档钉死（含空：没段被截）。
    check(`${label}：被截断的段 = [${row.truncatedSegments.join(', ')}]`,
      truncatedNow.join(',') === row.truncatedSegments.join(','), `truncated=[${truncatedNow.join(',')}]`)
    // ④ 「截断」与「切断」的分界（AC-5 的屏上不变量，纯函数层是同一条）：
    //    value ≠ fullValue ⇔ truncated，且被截的尾巴必须显式带 `…`。
    const cutSilently = fitted.filter(part =>
      (part.value !== part.fullValue) !== part.truncated || (part.truncated && !part.value.endsWith('…')))
    check(`${label}：没有被切断却没有 … 的段`, cutSilently.length === 0,
      JSON.stringify(cutSilently.map(part => `${part.segment}:${part.value}`)))
    // ⑤ 权限段：截断档必须完整（一字不少）；三档里都**永不**出现 `…`（AC-2）；
    //    兜底档按今天的顺序被省段是允许的（用户裁决），但绝不出现半截权限名。
    const permission = fitted.find(part => part.segment === PARAM_UNTRUNCABLE_SEGMENT)
    const permissionSource = row.parts.find(part => part.segment === PARAM_UNTRUNCABLE_SEGMENT)
    check(`${label}：权限段一字不少且从不含 …`,
      row.tier === 'fallback'
        ? permission === undefined || permission.value === permissionSource?.value
        : permission !== undefined && permission.value === permissionSource?.value && !permission.truncated
          && !permission.value.includes('…'),
      JSON.stringify(permission))
    // ⑥ 功能仍触发（L-012/L-014 的另一半）：每段都带得出完整名（T04 的 tooltip 靠它），
    //    且截断是**尾部**截断——显示值是完整名的前缀，不是中部/头部切一刀。
    const brokenFull = fitted.filter((part, i) =>
      part.fullValue !== row.parts[i]?.value || !part.fullValue.startsWith(part.value.replace(/…$/u, '')))
    check(`${label}：每段带完整名且显示值是完整名的前缀（尾部截断）`, brokenFull.length === 0,
      JSON.stringify(brokenFull.map(part => `${part.segment}:${part.value}|${part.fullValue}`)))
  }
  // 段身份 / 顺序 / 配色原样透传——T03 的焦点环与 T04 的 tooltip 都认这些字段。
  const passedThrough = fitParamParts(AC1_PARTS, 70)
  check('Q8 段身份 / 顺序 / colored 原样透传（T03 的焦点环依赖它）',
    passedThrough.map(part => part.segment).join(',') === 'model,effort,preset,permission'
      && passedThrough[0]?.colored === true && passedThrough[1]?.colored === undefined,
    JSON.stringify(passedThrough.map(part => [part.segment, part.colored])))
  // Q8b–Q8d（REVIEW F-09 / T-FIX-05）：**档位有类型载体**。上面表里的 `row.tier`
  // 是测试自己推出来的期望；`fitParamParts` 的返回项现在自带 `tier`
  // （`fit` / `truncated` / `fallback`，同一行的各段恒相同）——"哪一档"从注释与
  // 测试推断变成**能被程序检查**的字段，三档各钉一条。
  const tierOf = (parts: readonly ParamRow[], budget: number): string =>
    fitParamParts(parts, budget).map(part => part.tier).join(',')
  check('Q8b tier 载体：装得下 → 每段 tier=fit（既有夹具 @ 预算 70）',
    tierOf(FIXTURE_PARTS, 70) === 'fit,fit,fit,fit', `tier=${tierOf(FIXTURE_PARTS, 70)}`)
  check('Q8c tier 载体：截断档 → 每段 tier=truncated（AC-1 @ 预算 70）',
    tierOf(AC1_PARTS, 70) === 'truncated,truncated,truncated,truncated', `tier=${tierOf(AC1_PARTS, 70)}`)
  check('Q8d tier 载体：兜底档 → 每段 tier=fallback（AC-1 @ 预算 42）',
    tierOf(AC1_PARTS, 42) === 'fallback,fallback', `tier=${tierOf(AC1_PARTS, 42)}`)
  // 纯函数：不改入参（深冻结；原地写会抛 TypeError）。
  const frozenParts = Object.freeze(AC1_PARTS.map(part => Object.freeze({ ...part })))
  const fromFrozen = fitParamParts(frozenParts, 70)
  check('Q9 纯函数：不改入参（冻结载荷直解）',
    frozenParts[2]?.value === PRESET_LONG && fromFrozen.length === 4,
    JSON.stringify(fromFrozen.map(part => part.value)))
  // 退化档：没段 → 空；单段超预算 1 格 → 截到预算内；权限段单独放不下 → 宁可不画。
  check('Q10 空输入 → 空输出', fitParamParts([], 70).length === 0)
  const oneShort = fitParamParts([{ segment: 'model', value: 'deepseek-flash' }], 13)
  check('Q11 单段超预算 1 格 → 尾部截断到预算内（带 …）',
    oneShort.length === 1 && oneShort[0]?.truncated === true && oneShort[0]?.value.endsWith('…') === true
      && stringWidth(oneShort[0]?.value ?? '') <= 13,
    JSON.stringify(oneShort[0]))
  const onlyPermission = fitParamParts([{ segment: 'permission', value: 'danger-full-access' }], 10)
  check('Q12 权限段单独放不下 → 整段不画，绝不截断权限名（AC-2 的底线）',
    onlyPermission.length === 0, JSON.stringify(onlyPermission))
  const shortFloor = [
    { segment: 'model', value: 'deepseek-flash', colored: true },
    { segment: 'effort', value: 'Max' },
  ]
  const floorAttempt = fitParamParts(shortFloor, 17)
  check('Q13 宽度 ≤ 下限的段不可减（Max 不被砍）：压不动就回落今天的省段',
    floorAttempt.map(part => part.value).join(SEPARATOR) === legacyFit(shortFloor, 17).join(SEPARATOR)
      && floorAttempt.every(part => part.fullValue === part.value),
    JSON.stringify(floorAttempt.map(part => part.value)))
}

// ── R. 屏幕级：参数行三段式（AC-1/AC-2/AC-3/AC-5 的真挂载读数）───────────────
// Q 组钉纯函数层（哪一档、哪一段被减）；这一组钉**屏上结果**：逐字节期望行。
// 期望行是契约的独立复制品——每段文本写成字面量（只有分隔符取模块常量，
// Q0/A6e 已把它与版式字面量钉在一起），**不调用被测函数**（L-014：用独立载荷
// 构造"交付物没走过的跳"）。表驱动：一行 = 一份载荷 + 一个列数，覆盖一条 AC。
{
  interface ScreenRow {
    readonly name: string
    readonly params: ParamFixture
    readonly columns: number
    /** 屏上四段的呈现（显示顺序；截断段 = 前缀 + `…`），被省的段不在这里。 */
    readonly shown: readonly string[]
    /** 被截断的段的**完整名**（屏上是它的前缀 + `…`）；空 = 全部原样。 */
    readonly truncatedFull: readonly string[]
    /** **整段不出现**的段（兜底档按今天的顺序省段）：屏上连前半都不该有。 */
    readonly dropped: readonly string[]
    /** 焦点环里参数段的预期编码（-2 起按显示顺序），验证"环只收画出来的段"。 */
    readonly ring: readonly number[]
  }
  const rows: readonly ScreenRow[] = [
    {
      name: 'AC-1 长 preset：四段同屏、只截 preset、权限段一字不少',
      params: AC1_PARAMS,
      columns: 120,
      shown: ['deepseek-flash', 'Max', 'Standard (Git Bash …', 'danger-full-access'],
      truncatedFull: ['Standard (Git Bash · official tooling)'],
      dropped: [],
      ring: [-2, -3, -4, -5],
    },
    {
      name: 'AC-2① preset 极长（76 格）：权限段仍完整、屏上权限名不带 …',
      params: AC2_PRESET_HUGE_PARAMS,
      columns: 120,
      shown: ['deepseek-flash', 'Max', 'Standard (Git Bash …', 'danger-full-access'],
      truncatedFull: ['Standard (Git Bash · official tooling) — nightly variant with custom tooling'],
      dropped: [],
      ring: [-2, -3, -4, -5],
    },
    {
      name: 'AC-2② preset 与模型都长：两段被截、权限段不动',
      params: AC2_LONG_MODEL_PARAMS,
      columns: 120,
      shown: ['deepseek-v3.2-exp-cus…', 'Max', 'Standard (G…', 'danger-full-access'],
      truncatedFull: ['deepseek-v3.2-exp-custom-ft-2026', 'Standard (Git Bash · official tooling)'],
      dropped: [],
      ring: [-2, -3, -4, -5],
    },
    {
      name: 'AC-3 既有夹具：逐字节不变、行内无 …',
      params: DEFAULT_PARAMS,
      columns: 120,
      shown: ['glm-5.3', 'Max', 'Standard', 'default'],
      truncatedFull: [],
      dropped: [],
      ring: [-2, -3, -4, -5],
    },
    {
      name: 'AC-5 同一载荷 @48 列：回落今天的尾部省段（逐字节一致）',
      params: AC1_PARAMS,
      columns: 48,
      shown: ['deepseek-flash', 'Max'],
      truncatedFull: [],
      dropped: ['Standard (Git Bash · official tooling)', 'danger-full-access'],
      ring: [-2, -3],
    },
  ]
  for (const row of rows) {
    const ev: Ev[] = []
    const s = await openLaunchpad(ev, { columns: row.columns, params: row.params })
    const displayed = displayedParams(row.params)
    const expected = row.shown.join(PARAM_SEPARATOR)
    // 等第一段上屏再读（等不到就是后面各条断言失败，不在等待里静默吞掉）。
    await settled(() => s.screen().includes(displayed[0] ?? ''))
    const lines = viewportLines(s.term)
    const bottom = rowOf(s.term, '╰')
    const paramRow = bottom + 1
    const raw = lines[paramRow] ?? ''
    const text = raw.trim()
    // ① 逐字节期望行（含分隔符与截断形态；行首的 paddingLeft 由 ⑥ 单独钉）。
    check(`R1@${row.columns} ${row.name}：参数行逐字节等于期望行`,
      text === expected, `got=${JSON.stringify(text)} expected=${JSON.stringify(expected)}`)
    // ② 行宽不变量：整行 ≤ 单行预算（预算由列数**现算**，不冻结成列数阈值——L-025）。
    const budget = Math.max(24, Math.min(row.columns - 4, 72)) - 2
    check(`R2@${row.columns} ${row.name}：行宽 ≤ 预算且不超屏`,
      stringWidth(text) <= budget && stringWidth(raw) <= row.columns,
      `w=${stringWidth(text)} budget=${budget} raw=${stringWidth(raw)} cols=${row.columns}`)
    // ③ 屏上段 = 期望（L-012 的"症状消失"面）：画出来的**都在这一行**、每段
    //    要么原样要么是"前缀 + `…`"；省掉的段**整段不在**（连前半都不许有）。
    const fullFor = (shown: string): string | undefined => displayed.find(full =>
      full === shown || (shown.endsWith('…') && full.startsWith(shown.slice(0, -1))))
    const shownOk = row.shown.every(shown => text.includes(shown) && fullFor(shown) !== undefined)
    const droppedOk = row.dropped.every(full => !lines.some(l => l.includes(halfOf(full))))
    const coversAll = row.shown.length + row.dropped.length === displayed.length
    check(`R3@${row.columns} ${row.name}：屏上段 = 期望（画的都在且完整呈现，省的整段不在）`,
      [coversAll, shownOk, droppedOk].every(Boolean),
      `${row.shown.length}/${displayed.length} shown=${JSON.stringify(row.shown)}`
        + ` 意外露头的省段=${JSON.stringify(row.dropped.filter(full => lines.some(l => l.includes(halfOf(full)))))}`)
    // ④ 被截断的段 = 期望的那几段：截断必须**显式**带 `…`、是尾部截断，且真的在屏上。
    const truncatedShown = row.shown.filter(shown => shown.endsWith('…'))
    const truncatedOk = truncatedShown.length === row.truncatedFull.length
      && row.truncatedFull.every(full => truncatedShown.some(shown =>
        text.includes(shown) && full.startsWith(shown.slice(0, -1))))
    check(`R4@${row.columns} ${row.name}：带 … 的段 = 期望的 ${row.truncatedFull.length} 段（尾部截断）`,
      truncatedOk, JSON.stringify(truncatedShown))
    // ⑤ 权限段（AC-2 的底线）：画出来就**一字不少**且它之后的文本里永不出现 `…`；
    //    这一档省掉它时必须是整段不在，不能是"半截权限名"。
    const permission = row.params.permission ?? ''
    const permissionDrawn = row.shown.some(shown =>
      shown === permission || (shown.endsWith('…') && permission.startsWith(shown.slice(0, -1))))
    const permissionAt = text.indexOf(permission)
    const permissionOk = permissionDrawn
      ? permissionAt >= 0 && !text.slice(permissionAt).includes('…')
      : !lines.some(l => l.includes(halfOf(permission)))
    check(`R5@${row.columns} ${row.name}：权限段${permissionDrawn ? '一字不少且不含 …' : '整段省掉（不是半截）'}`,
      permission !== '' && permissionOk,
      `drawn=${permissionDrawn} at=${permissionAt} tail=${JSON.stringify(permissionAt < 0 ? '' : text.slice(permissionAt))}`)
    // ⑥ 版式不变量：单行（整条期望行只落在一行上）、紧贴框下、行首 = 框缘 + 2。
    const cardLeft = leftGap(lines.find(l => l.includes('╭')) ?? '')
    check(`R6@${row.columns} ${row.name}：单行 + 紧贴框下 + 左对齐输入框（paddingLeft 2）`,
      lines.filter(l => l.trim() === expected).length === 1 && paramRow === bottom + 1
        && Math.abs(leftGap(raw) - (cardLeft + 2)) <= 1 && text !== '',
      `rows=${lines.filter(l => l.trim() === expected).length} param=${paramRow} bottom=${bottom} left=${leftGap(raw)} cardLeft=${cardLeft}`)
    // ⑦ 功能仍触发（L-012/L-014 的另一半）：焦点环只收**画出来的**段，落点顺序
    //     = 模型→深度→模式→权限，走完参数段落第一条入口（环里没有多余的参数格）。
    const walk: unknown[] = []
    for (let step = 0; step < row.ring.length; step++) {
      await s.send('\u001b[B')
      walk.push(last(ev, 'focus')?.value)
    }
    await s.send('\u001b[B')
    check(`R7@${row.columns} ${row.name}：焦点环 = [${row.ring.join(', ')}] 且之后落第一条入口`,
      walk.join(',') === row.ring.join(',') && last(ev, 'focus')?.value === 0,
      `${walk.join(',')} → ${JSON.stringify(last(ev, 'focus')?.value)} expected=${row.ring.join(',')} → 0`)
    s.close()
  }
}

// ── S. AC-4：截断段的 tooltip（hover 出完整名 / 离开即撤 / 点击与键盘不退化）────
// AC-4 是**屏幕级**契约：真 SGR mode-1003 motion 悬停 → 600ms dwell → 单例浮层画卡片。
// 夹具的 Harness 与 Chat 的落地页分支同姿态（`<Launchpad/>` + `<TooltipLayer/>` 兄弟，
// 层挂在树的最外层最后）——Chat.tsx 里的真实挂载点由 verify-launchpad-onboarding-chat
// （真 Chat 树）兜底。负例断言的是"**不变量**"（未截断段与无 … 的载荷都不许弹卡片）：
// 轮询到的谓词恒真不算证据，所以用带标签的固定观察窗，并让同一会话紧接的正例
// 证明浮层是活的（不是"没挂所以什么都不出"）。
const AC1_FULL_PRESET = 'Standard (Git Bash · official tooling)'
const AC1_SHOWN_PRESET = 'Standard (Git Bash …'
{
  // ①③⑤a 在同一屏（AC-1 载荷）：**先负例后正例**——负例的观察窗里浮层是活的，
  // 同一会话紧接着就为截断段弹出卡片，排除"层没挂"的假绿。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { params: AC1_PARAMS })
  await settled(() => s.screen().includes(AC1_SHOWN_PRESET))
  // ⑤a 负例：未截断的 model 段（屏上无 …）hover 满一个 dwell 窗口——卡片会替换它
  // 覆盖的格子，屏上出任何新字形都会被抓到；单例 store 也必须仍是空。
  const modelCell = findCell(s.term, 'deepseek-flash')!
  const quietBefore = viewportLines(s.term).join('\n')
  s.input.write(`\u001b[<35;${modelCell.col};${modelCell.row}M`)
  const modelHoverLive = await settled(() => last(ev, 'focus')?.value === -2)
  // 固定窗:探针 dwell（600ms）已过 + 余量——断言"未截断段不弹卡片"这个不变量
  await sleep(900)
  const quietAfter = viewportLines(s.term).join('\n')
  check('S1 未截断段 hover 仍走既有手势（高亮 → 焦点落模型段 -2），但不弹卡片（整屏逐字节不变 + 单例 store 空）',
    modelHoverLive && getTooltipSnapshot() === null && quietAfter === quietBefore,
    `focus=${JSON.stringify(last(ev, 'focus')?.value)} store=${JSON.stringify(getTooltipSnapshot())} `
      + firstScreenDiff(quietBefore, quietAfter))
  // ① 正例：hover 到 dwell —— 卡片显示**完整 preset 名**，且锚在被悬停行**之上**。
  const presetCell = findCell(s.term, AC1_SHOWN_PRESET)!
  const hoveredAt = Date.now()
  s.input.write(`\u001b[<35;${presetCell.col};${presetCell.row}M`)
  const cardShown = await settled(() => s.screen().includes(AC1_FULL_PRESET))
  const dwellMs = Date.now() - hoveredAt
  const cardRow = rowOf(s.term, AC1_FULL_PRESET)
  check('S2 被截断段 hover 停留约 600ms 后卡片显示完整名（AC-4①：dwell ≥ 500ms、卡片在锚点行之上）',
    cardShown && dwellMs >= 500 && cardRow >= 0 && cardRow < presetCell.row - 1,
    `dwell=${dwellMs}ms shown=${cardShown} cardRow=${cardRow} anchorRow=${presetCell.row - 1}`)
  // ② 离开即撤：卡片消失 + 该段高亮复原（第五版 BUG 2 的病灶面：hover 带进的焦点要交还）。
  const blankCell = findCell(s.term, '██▀▀▄▄')!
  s.input.write(`\u001b[<35;${blankCell.col};${blankCell.row}M`)
  const cardGone = await settled(() => !s.screen().includes(AC1_FULL_PRESET)
    && getTooltipSnapshot() === null && last(ev, 'focus')?.value === -1)
  check('S3 离开后卡片立即消失且高亮复原（AC-4②：屏上无完整名 + store 空 + focus 回 -1）',
    cardShown && cardGone,
    `wasShown=${cardShown} focus=${JSON.stringify(last(ev, 'focus')?.value)} store=${JSON.stringify(getTooltipSnapshot())}`)
  // ③ 点击仍打开该段的选择器（落点必须是 preset，不是别的段）。
  const beforeClick = ev.length
  await s.click(AC1_SHOWN_PRESET)
  check('S4 点击被截断段仍打开对应选择器（AC-4②：param = preset）',
    last(ev, 'param')?.value === 'preset', JSON.stringify(ev.slice(beforeClick)))
  s.close()
}
{
  // ④ 键盘不退化（AC-4③）：焦点环仍四段（模型→深度→模式→权限），Enter 开对应选择器。
  // 鼠标只在 AlternateScreen 存在，键盘等价路径必须独立成立（DESIGN 风险 R3）。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { params: AC1_PARAMS })
  await settled(() => s.screen().includes(AC1_SHOWN_PRESET))
  const walk: unknown[] = []
  for (let step = 0; step < 3; step++) {
    await s.send('\t')
    walk.push(last(ev, 'focus')?.value)
  }
  // 焦点此刻在被截断的 preset 段（-4）上：Enter 打开 /preset（与鼠标同一条 onParamPick）。
  await s.send('\r')
  const presetPick = last(ev, 'param')?.value
  await s.send('\t')
  walk.push(last(ev, 'focus')?.value)
  await s.send('\r')
  const permissionPick = last(ev, 'param')?.value
  check('S5 焦点环仍含四段（模型→深度→模式→权限 = -2/-3/-4/-5）：截断不减少键盘可达目标',
    walk.join(',') === '-2,-3,-4,-5', walk.join(','))
  check('S6 键盘 Enter 在被截断的 preset 段上打开 /preset（截断不失去等价操作）',
    presetPick === 'preset', JSON.stringify(presetPick))
  check('S7 再走一段 Enter 落在权限段 → /permission（环不串段）',
    permissionPick === 'permission', JSON.stringify(permissionPick))
  s.close()
}
{
  // ⑤b 负例（AC-3 默认夹具：参数行内无 …）：hover 参数段一个 dwell 窗口——屏上零新
  // 字形、单例 store 仍空；手势本身照旧活着（高亮 + 焦点），不是"没接上所以没反应"。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev)
  await settled(() => s.screen().includes('Standard'))
  const paramLine = viewportLines(s.term).find(l => l.includes('Standard')) ?? ''
  const target = findCell(s.term, 'Standard')!
  const quietBefore = viewportLines(s.term).join('\n')
  s.input.write(`\u001b[<35;${target.col};${target.row}M`)
  const hoverLive = await settled(() => last(ev, 'focus')?.value === -4)
  // 固定窗:探针 dwell（600ms）已过 + 余量——断言"无 … 的载荷不弹卡片"这个不变量
  await sleep(900)
  const quietAfter = viewportLines(s.term).join('\n')
  check('S8 AC-3 默认夹具（无 …）hover 参数段：手势活着但不出卡片（整屏逐字节不变 + store 空）',
    hoverLive && !paramLine.includes('…') && getTooltipSnapshot() === null && quietAfter === quietBefore,
    `focus=${JSON.stringify(last(ev, 'focus')?.value)} store=${JSON.stringify(getTooltipSnapshot())} `
      + firstScreenDiff(quietBefore, quietAfter))
  s.close()
}
{
  // ⑥ F-04（T-FIX-03）：**激活即撤卡**——hover 出卡后点这一段，指针**仍停在段上**
  // （不再有 pointer-leave 收敛），卡片必须立刻消失：否则它会停在刚打开的选择器
  // 之上，而 `param` 事件本身照常发出（鼠标选择器路径不退化）。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { params: AC1_PARAMS })
  await settled(() => s.screen().includes(AC1_SHOWN_PRESET))
  const cell = findCell(s.term, AC1_SHOWN_PRESET)!
  s.input.write(`\u001b[<35;${cell.col};${cell.row}M`)
  const cardShown = await settled(() => s.screen().includes(AC1_FULL_PRESET) && getTooltipSnapshot() !== null)
  const beforeClick = ev.length
  await s.click(AC1_SHOWN_PRESET)
  const picked = last(ev, 'param')?.value
  const cardGone = await settled(() => !s.screen().includes(AC1_FULL_PRESET) && getTooltipSnapshot() === null)
  check('S9 点击被截断段（指针仍在段上）→ 卡片立即消失且 param=preset（F-04：激活即撤卡，选择器路径不退化）',
    cardShown && cardGone && picked === 'preset',
    `cardShown=${cardShown} cardGone=${cardGone} param=${JSON.stringify(picked)} `
      + `store=${JSON.stringify(getTooltipSnapshot())} ${JSON.stringify(ev.slice(beforeClick))}`)
  s.close()
}
{
  // ⑦ F-04（T-FIX-03）：键盘激活走同一条语义。hover 出卡时焦点已被 hover 带进
  // preset 段（-4），直接按 Enter（屏级 useInput → onParamPick）：卡片同样必须
  // 消失——这一条与 S9 的差别只在"激活从哪里来"，两条路径都不许把上一段的
  // 完整名留在选择器之上。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { params: AC1_PARAMS })
  await settled(() => s.screen().includes(AC1_SHOWN_PRESET))
  const cell = findCell(s.term, AC1_SHOWN_PRESET)!
  s.input.write(`\u001b[<35;${cell.col};${cell.row}M`)
  const hoverFocused = await settled(() => last(ev, 'focus')?.value === -4)
  const cardShown = await settled(() => s.screen().includes(AC1_FULL_PRESET) && getTooltipSnapshot() !== null)
  const beforeKey = ev.length
  await s.send('\r')
  const picked = last(ev, 'param')?.value
  const cardGone = await settled(() => !s.screen().includes(AC1_FULL_PRESET) && getTooltipSnapshot() === null)
  check('S10 键盘 Enter 激活被截断段（卡片已挂）→ 卡片立即消失且 param=preset（F-04：两条激活路径同语义）',
    hoverFocused && cardShown && cardGone && picked === 'preset',
    `focus=${JSON.stringify(last(ev, 'focus')?.value)} cardShown=${cardShown} cardGone=${cardGone} `
      + `param=${JSON.stringify(picked)} store=${JSON.stringify(getTooltipSnapshot())} ${JSON.stringify(ev.slice(beforeKey))}`)
  s.close()
}

// ── F. 宽度不变量（整屏：任何一行都不超宽、没有切断的半句） ─────────────────
// 整屏不变量：每个键位标签、Tips 文案、参数段要么完整出现在**同一行**，要么
// 整条不出现；任何一行 trim 后 ≤ 列数。
// **判据（DESIGN D7 修订）**：参数段允许以 `…` 结尾的**尾部截断**——截断是
// **显式标记**的（`…` 摆在屏上，用户看得见"这里还有字"），视为完整呈现；
// 不带 `…` 的半截（字形被裁掉却没有任何提示）与整段消失才是缺陷形态，仍判失败。
// 为什么这不是放水：旧判据的"前半在屏、完整串不在 ⇒ 切断"会把**合法的截断**
// 与**无标记的切断**判成同一类，于是要么误报、要么被迫放弃"参数行必须完整"的
// 不变量；新判据只是把"显式标记的降级"从缺陷里摘出来——每一条 half 判据仍要求
// "要么完整、要么显式标记"，F1 的"任何一行不超宽"原样保留，R 组另有逐字节期望行。
//
// **档位覆盖（REVIEW F-06 · T-FIX-04 补齐）**：F1/F2 的五档矩阵用**短名夹具**
// （四段原样总宽 40 ≤ 最小预算 42）⇒ 五档**全在 fit 档**；长名载荷下的**截断档**
// 与**兜底档**由下面的 F4@76 / F5@48 各自用同一对不变量 + 档位形态断言覆盖。
//
// **F1 形状的已知边界**：「任何一行 trim 后 ≤ 列数」对**组合出来的超宽行**判不出
// ——终端会在列宽处**折行**，超宽内容变成下一行的前几个字符，每一行本身仍 ≤ 列数
// （读数：`probe/fix/T-FIX-04-xterm-wrap-probe.txt`，48 列里写 100 个 `x` ⇒
// 48/48/4 三行）。这条判据抓的是**宽度记账与终端格子不一致**（emoji/ZWJ 计数差那
// 一类，见 F-08），而"参数行不超预算"由 R1/R2 的逐字节期望行 + 预算判据钉住。
const CHIP_LABELS = DEFAULT_ACTIONS.map(a => t(a.labelKey as never, a.values as never))
const TIP_TEXTS = [t('launchpad-tip' as never), t('launchpad-first-run' as never)]
/**
 * `text` 是否**无标记地被切断**：前半串在屏上，但没有任何一次出现是
 * "完整串"或"前缀 + `…`"（后者是 D3 的尾部截断，合法呈现）。
 * 整段不在屏上（没找到前半串）不算切断——窄屏按宽度整段省掉是契约行为。
 *
 * ⚠️ **已知盲区（REVIEW F-05 · 登记 `KNOWN-ISSUES`）——它不是"参数段完整性"的
 * 通用守卫**，只是"切痕 ≥ 半个串且同屏没有完整串"这一形态的探针：
 *   ① **不足半个串的无标记半截判不出**：探针就是前半串，切得比它短时屏上根本
 *      找不到锚点（`probe/review/readings-zwj-f2.txt`：@70%/55%/50% 判红，
 *      @45%/25% 判不出）；
 *   ② **`halfOf` 用 UTF-16 `slice`**：代理对（emoji/ZWJ 序列）被从中间切开后
 *      的"前半"不是原串的合法前缀，`indexOf` 永不命中 ⇒ 对这类文本**永不判红**
 *      （`readings-zwj-f2.txt` 第 27-37 行；当前载荷是 ASCII，非活漏洞）；
 *   ③ **完整串出现在别处就放行**：同一行是半截、但完整串在另一行（如 tooltip
 *      卡片行）时，`isSilentlyCut` 会在那一行命中"完整串"并返回 false
 *      （`readings-zwj-f2.txt` 末行）。
 * 参数段的**完整性**另由 Q 组（纯函数三档契约）与 R 组（逐字节期望行）钉住。
 */
function isSilentlyCut(lines: readonly string[], text: string): boolean {
  const half = halfOf(text)
  let seen = false
  for (const line of lines) {
    for (let at = line.indexOf(half); at >= 0; at = line.indexOf(half, at + 1)) {
      seen = true
      let matched = 0
      while (matched < text.length && line[at + matched] === text[matched]) matched += 1
      if (matched === text.length || line[at + matched] === '…') return false
    }
  }
  return seen
}
/** 整屏的"被切断"清单：标签/Tips 用完整串判据；参数段按上面的 D7 判据。 */
function cutHalves(lines: readonly string[], paramTexts: readonly string[]): string[] {
  const hard = [...CHIP_LABELS, ...TIP_TEXTS].filter(text =>
    lines.some(l => l.includes(halfOf(text))) && !lines.some(l => l.includes(text)))
  return [...hard, ...paramTexts.filter(text => isSilentlyCut(lines, text))]
}
for (const cols of [120, 100, 72, 60, 48]) {
  // 注意载荷：默认短名夹具（四段原样总宽 40 ≤ 最小预算 42）⇒ 这五档**全在 fit 档**，
  // 截断档/兜底档的不变量由 F4@76 / F5@48（REVIEW F-06）覆盖；判据本身的盲区见
  // `isSilentlyCut` 的注释。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { columns: cols })
  await settled(() => s.screen().trim().length > 0)
  const lines = viewportLines(s.term)
  const overflow = lines.map((l, i) => ({ w: stringWidth(l.replace(/\s+$/u, '')), i }))
    .filter(x => x.w > cols)
  check(`F1@${cols} 整屏不变量：任何一行都不超宽`, overflow.length === 0,
    overflow.map(x => `row=${x.i} w=${x.w}`).join(' '))
  // 参数行按**段**判（模型/思考深度/模式/权限）：窄屏下尾部段按宽度省掉是
  // 契约行为（单行预算），整句判据会把合法省段误判成切断。
  const cut = cutHalves(lines, displayedParams(DEFAULT_PARAMS))
  check(`F2@${cols} 没有被切断的半句（标签/Tips 要么完整要么不出现；参数段要么完整、要么带 …）`,
    cut.length === 0, cut.join(' | '))
  s.close()
}
// F3：D7 新判据的**正面证据**——AC-1 的长 preset 在屏上是"前缀 + `…`"，旧判据
// 会把它误判成半句，新判据必须放行；同时要求那个带 `…` 的呈现**真的在屏上**
// （否则这条断言在"还没接线"的形态下也能空过，等于没测）。
{
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { params: AC1_PARAMS })
  await settled(() => s.screen().includes('Standard (Git Bash …'))
  const lines = viewportLines(s.term)
  const cut = cutHalves(lines, displayedParams(AC1_PARAMS))
  check('F3@120 带 `…` 的尾部截断不算被切断（D7 新判据的正面证据）',
    cut.length === 0 && lines.some(l => l.includes('Standard (Git Bash …')),
    `${cut.join(' | ')} | ${JSON.stringify(lines.filter(l => l.includes('Standard')))}`)
  s.close()
}
// F4/F5（REVIEW F-06）：**截断档 / 兜底档的真实渲染不变量**。上面 F1/F2 的五档
// 矩阵是短名夹具（全 fit 档）、F3@120 只覆盖截断档的"无标记半截"，兜底档此前
// **0 条**不变量断言。这里换长名载荷（AC-1）补两档，断言形状与 F1/F2 同源：
// 每档两条不变量（不超宽 / 无无标记半截）+ 一条**档位形态**（截断档四段同屏且
// preset 显式带 `…`；兜底档与今天逐字节一致且无 `…` 泄漏）。
// 档位读数（**不是**阈值，L-025）：`probe/round4/param-band.txt` —— AC-1 载荷
// 兜底档最大列数 = 65、截断档最小列数 = 66；76 列 = 预算 70 的截断档、
// 48 列 = 预算 42 的兜底档（两者都是该档的**代表列**，不是边界）。
{
  // F4@76（截断档）：四段同屏、只截 preset、权限段一字不少、行宽 ≤ 预算。
  const cols = 76
  const budget = Math.max(24, Math.min(cols - 4, 72)) - 2
  const shown = ['deepseek-flash', 'Max', 'Standard (Git Bash …', 'danger-full-access']
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { columns: cols, params: AC1_PARAMS })
  await settled(() => s.screen().includes('Standard (Git Bash …'))
  const lines = viewportLines(s.term)
  const overflow = lines.map((l, i) => ({ w: stringWidth(l.replace(/\s+$/u, '')), i }))
    .filter(x => x.w > cols)
  check(`F4@${cols} 截断档（AC-1 载荷）：整屏不变量——任何一行都不超宽`, overflow.length === 0,
    overflow.map(x => `row=${x.i} w=${x.w}`).join(' '))
  const cut = cutHalves(lines, displayedParams(AC1_PARAMS))
  check(`F4b@${cols} 截断档（AC-1 载荷）：没有被切断的半句（preset 显式带 …、权限段一字不少）`,
    cut.length === 0, cut.join(' | '))
  const row = (lines.find(l => l.includes('danger-full-access')) ?? '').trim()
  const rowWidth = stringWidth(row)
  check(`F4c@${cols} 截断档（AC-1 载荷）：四段同屏 + preset 段带 … + 行宽 ≤ 预算`,
    shown.every(needle => row.includes(needle)) && rowWidth <= budget,
    `w=${rowWidth} budget=${budget} row=${JSON.stringify(row)}`)
  s.close()
}
{
  // F5@48（兜底档）：**与今天逐字节一致**（尾部整段省）+ **无 `…` 泄漏**。
  // 期望行按契约字面量写（分隔符取模块常量，A6e 已把它钉在版式上）——不调用被测函数。
  const cols = 48
  const budget = Math.max(24, Math.min(cols - 4, 72)) - 2
  const expected = ['deepseek-flash', 'Max'].join(PARAM_SEPARATOR)
  const dropped = ['Standard (Git Bash · official tooling)', 'danger-full-access']
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { columns: cols, params: AC1_PARAMS })
  await settled(() => s.screen().includes('deepseek-flash'))
  const lines = viewportLines(s.term)
  const overflow = lines.map((l, i) => ({ w: stringWidth(l.replace(/\s+$/u, '')), i }))
    .filter(x => x.w > cols)
  check(`F5@${cols} 兜底档（AC-1 载荷）：整屏不变量——任何一行都不超宽`, overflow.length === 0,
    overflow.map(x => `row=${x.i} w=${x.w}`).join(' '))
  const cut = cutHalves(lines, displayedParams(AC1_PARAMS))
  check(`F5b@${cols} 兜底档（AC-1 载荷）：没有被切断的半句（省掉的段整段不在、留下的段完整）`,
    cut.length === 0, cut.join(' | '))
  const paramRow = rowOf(s.term, '╰') + 1
  const text = (lines[paramRow] ?? '').trim()
  // 「无 `…` 泄漏」按**参数行**判：屏上别处另有合法的省略号（输入框占位提示
  // `说点什么，或输入 / 看命令…`），整屏扫 `…` 会把那条误算成泄漏。
  const paramLeak = text.includes('…')
  check(`F5c@${cols} 兜底档（AC-1 载荷）：与今天逐字节一致（尾部省段）+ 参数行无 … 泄漏`,
    text === expected && !paramLeak && stringWidth(text) <= budget
      && dropped.every(full => !lines.some(l => l.includes(halfOf(full)))),
    `got=${JSON.stringify(text)} expected=${JSON.stringify(expected)} budget=${budget} `
      + `paramLeak=${paramLeak} `
      + `droppedVisible=${JSON.stringify(dropped.filter(full => lines.some(l => l.includes(halfOf(full)))))}`)
  s.close()
}

// ── G. 入口裁剪、输入光标与占位 ──
{
  // 48 列：fitChips 裁掉尾部（帮助），剩下三条**仍然右对齐输入框右缘**。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { columns: 48 })
  await settled(() => s.screen().includes(SESSIONS_WORKSPACE_LABEL))
  const lines = viewportLines(s.term)
  const hintRow = lines.find(l => l.includes(CONTINUE_LABEL)) ?? ''
  const cardRow = lines.find(l => l.includes('╭')) ?? ''
  const cardLeft = leftGap(cardRow)
  const cardWidth = Math.max(24, Math.min(48 - 4, 72))
  check('G1 入口被裁掉后整行仍右对齐（行尾 = 卡片右缘 ±1，且被裁的不画半句）',
    hintRow !== '' && !hintRow.includes(HELP_LABEL) && !hintRow.includes(BACKEND_LABEL) && Math.abs(stringWidth(hintRow.replace(/\s+$/u, '')) - (cardLeft + cardWidth)) <= 1,
    `rowEnd=${stringWidth(hintRow.replace(/\s+$/u, ''))} cardRight=${cardLeft + cardWidth} ${hintRow.trim()}`)
  check('G2 裁剪后行高仍恒 1（三个入口同在一行、各只出现一次）',
    rowHasAll(hintRow, [CONTINUE_LABEL, SESSIONS_WORKSPACE_LABEL, SETTINGS_LABEL])
      && lines.filter(l => l.includes(CONTINUE_LABEL)).length === 1
      && lines.filter(l => l.includes(SESSIONS_WORKSPACE_LABEL)).length === 1,
    hintRow.trim())
  s.close()
}
{
  // 条件动作不得破坏入口行的对齐和行高——jobs/update/star/help
  // 四种条件位各挂一次，入口行仍然恒 1 行、右对齐输入框右缘、四格齐整。
  const variants: [string, string, Record<string, unknown>][] = [
    ['jobs', JOBS_LABEL, { jobsRunning: true, updateAvailable: false, starDue: false }],
    ['update', UPDATE_LABEL, { jobsRunning: false, updateAvailable: true, starDue: false }],
    ['star', STAR_LABEL, { jobsRunning: false, updateAvailable: false, starDue: true }],
    ['help', HELP_LABEL, { jobsRunning: false, updateAvailable: false, starDue: false }],
  ]
  for (const [kind, label, state] of variants) {
    const s = await openLaunchpad([], { actions: resolveLaunchpadActions({ lastSessionTitle: '修个登录页', ...(state as never) }) })
    await settled(() => s.screen().includes(label))
    const lines = viewportLines(s.term)
    const hintRow = lines.find(l => l.includes(label)) ?? ''
    const cardLeft = leftGap(lines.find(l => l.includes('╭')) ?? '')
    const cardRight = cardLeft + Math.max(24, Math.min(COLS - 4, 72))
    check(`G2b 条件位=${kind}：五格同一行、行高恒 1、仍右对齐（对齐/行高契约不随条件位漂）`,
      rowHasAll(hintRow, [CONTINUE_LABEL, SESSIONS_WORKSPACE_LABEL, SETTINGS_LABEL, BACKEND_LABEL, label])
        && lines.filter(l => l.includes(label)).length === 1
        && lines.filter(l => l.includes(BACKEND_LABEL)).length === 1
        && Math.abs(stringWidth(hintRow.replace(/\s+$/u, '')) - cardRight) <= 1,
      `${kind} ${hintRow.trim().slice(0, 90)}`)
    s.close()
  }
}
{
  // 自动呼吸：**不注入任何 focus 事件**（isTerminalFocused=false）时，光标
  // 闪烁必须在 1.4s 内产生 ≥2 个新渲染帧（相位切换 = 样式重绘；文本不变）。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { terminalFocused: false })
  await settled(() => s.screen().includes('❯'))
  const before = s.out.writeCount
  // 固定窗:呼吸相位 无完成事件可观测（相位切换本身是被测语义），按两个相位窗口等。
  await new Promise(resolve => setTimeout(resolve, 1400))
  check('G3 没有焦点事件光标也自动闪烁（1.4s 内 ≥2 个相位帧，不用手动点一下）',
    s.out.writeCount - before >= 2, `frames=${s.out.writeCount - before}`)
  s.close()
}
{
  // 占位文本紧跟 ❯ 和块状光标；有输入时隐藏。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev)
  await settled(() => s.screen().includes('说点什么'))
  const line = viewportLines(s.term).find(l => l.includes('说点什么')) ?? ''
  const cardLeft = leftGap(viewportLines(s.term).find(l => l.includes('╭')) ?? '')
  const phCol = stringWidth(line.slice(0, line.indexOf('说点什么')))
  check('G4 占位左对齐：与 ❯ 同行、紧跟其后（不在右缘）',
    line.includes('❯') && phCol > 0 && phCol <= cardLeft + 2 + stringWidth('❯ ') + 4
      && rightGap(line, COLS) > 20,
    `phCol=${phCol} cardLeft=${cardLeft} ${JSON.stringify(line.trim())}`)
  s.close()
  const ev2: Ev[] = []
  const s2 = await openLaunchpad(ev2, { query: '有输入了' })
  check('G5 有输入时占位消失（输入行只显示原文）',
    await settled(() => s2.screen().includes('有输入了') && !s2.screen().includes('说点什么')),
    s2.screen().slice(0, 120))
  s2.close()
}

{
  // doctor、setup 和 setup-provider 不属于落地页入口；
  // （首启由引导向导承担，provider 配置经向导或 /settings 可达）。
  const evn: Ev[] = []
  const normal = await openLaunchpad(evn, { firstRun: true })
  check('G6 首启档也没有快速配置/provider 条件按钮（引导向导盖在落地页之上承担首启）',
    await settled(() => normal.screen().includes(CONTINUE_LABEL)
      && !normal.screen().includes('快速配置') && !normal.screen().includes('配置 provider')
      && !normal.screen().includes('环境体检')),
    normal.screen().slice(0, 100))
  normal.close()
}

// ── H. 参数段选择器 ──
{
  // 键盘路径（仓库硬规矩：每个可点目标都要有键盘路径）：↓ 走到段、Enter 打开。
  const cases: [string, number][] = [['model', 1], ['effort', 2], ['preset', 3], ['permission', 4]]
  for (const [segment, downs] of cases) {
    const ev: Ev[] = []
    const s = await openLaunchpad(ev)
    for (let i = 0; i < downs; i++) await s.send('\u001b[B')
    await s.send('\r')
    check('H1 Enter 打开 ' + segment + ' 段（键盘路径；环顺序 模型→深度→模式(preset)→权限）',
      last(ev, 'param')?.value === segment && last(ev, 'submit') === undefined,
      JSON.stringify(last(ev, 'param')))
    s.close()
  }
}
{
  // 鼠标路径：真 SGR 点击每一段——四段各自落到自己的 onParamPick。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev)
  await settled(() => findCell(s.term, 'glm-5.3') !== null)
  const picks: string[] = []
  for (const needle of ['glm-5.3', 'Max', 'Standard', 'default']) {
    await s.click(needle)
    picks.push(needle + '→' + String(last(ev, 'param')?.value))
  }
  check('H2 点击四段各自触发对应 onParamPick（不是永远第一段）',
    last(ev, 'param')?.value === 'permission' && ev.filter(e => e.type === 'param').length === 4,
    picks.join(' '))
  s.close()
}
{
  // hover（mode 1003 motion，无按键）→ ParamChip 的 onMouseEnter → 焦点移到该段。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev)
  await settled(() => findCell(s.term, 'Max') !== null)
  const target = findCell(s.term, 'Max')!
  const before = ev.length
  s.input.write('\u001b[<35;' + target.col + ';' + target.row + 'M')
  check('H3 悬停参数段即移焦点（思考深度 = focus -3）',
    await settled(() => last(ev, 'focus')?.value === -3), JSON.stringify(ev.slice(before)))
  s.close()
}
{
  // 选择器盖在落地页之上：overlayPanel 探针上屏、且在输入框卡片**上方**。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { overlayPanel: true })
  check('H4 选择器面板盖在落地页之上（探针在屏上、且位于输入框卡片上方）',
    await settled(() => s.screen().includes('PICKER-PROBE 选择器探针'))
      && rowOf(s.term, 'PICKER-PROBE') >= 0 && rowOf(s.term, 'PICKER-PROBE') < rowOf(s.term, '╭'),
    'probe=' + rowOf(s.term, 'PICKER-PROBE') + ' card=' + rowOf(s.term, '╭'))
  check('H4b 选择器开着时落地页仍在（参数行/输入框都没被踢出去）',
    s.screen().includes('说点什么') && s.screen().includes(PARAM_LINE))
  s.close()
}
{
  // inputPaused：选择器开着时本屏键盘整块让位——按键不落进草稿。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { inputPaused: true })
  const before = ev.length
  s.input.write('x')
  // 固定窗:让位 无事件可观测（静默本身是被测语义）。
  await new Promise(resolve => setTimeout(resolve, 150))
  check('H5 inputPaused 时按键不进草稿（事件零增长）', ev.length === before,
    JSON.stringify(ev.slice(before)))
  s.close()
}
{
  // 矮屏撤留白后的真挂载形态：紧凑 full 档下入口行回到紧贴参数行（param+1）。
  const at = (rows: number) => resolveLaunchpadLayout(COLS, rows, { whale: true, font: FONT, params: true })
  let fullGap = 1
  while (fullGap <= 80 && at(fullGap).stage !== 'full') fullGap++
  // fullGap = 紧凑 full 的阈值（留白已撤）：入口行应回到紧贴参数行。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { rows: fullGap })
  await settled(() => s.screen().includes(CONTINUE_LABEL))
  const lines = viewportLines(s.term)
  const param = lines.findIndex(l => l.includes('glm-5.3'))
  const hint = lines.findIndex(l => l.includes(CONTINUE_LABEL))
  check('H6 矮屏撤掉呼吸留白后入口行紧贴参数行（输入框还在，没被留白挤掉）',
    param >= 0 && hint === param + 1 && s.screen().includes('╭'),
    'rows=' + fullGap + ' param=' + param + ' hint=' + hint)
  // 紧凑档的间隔恢复到一行：词标→输入框、入口行→Tips
  // 1 行留白——撤留白绝不把输入框挤掉（卡片与 Tips 都还在）。
  const tip = lines.findIndex(l => l.includes('● Tips'))
  const titleBottom = lines.reduce((acc, l, i) => l.includes('█') ? i : acc, -1)
  const cardTop = lines.findIndex(l => l.includes('╭'))
  check('H6b 紧凑档两处呼吸都撤回 1 行（cardTop=titleBottom+2、tip=hint+2），输入框与 Tips 仍在',
    s.screen().includes('● Tips') && cardTop === titleBottom + 2 && tip === hint + 2
      && s.screen().includes('╭') && s.screen().includes('❯'),
    `titleBottom=${titleBottom} cardTop=${cardTop} hint=${hint} tip=${tip}`)
  s.close()
}

// ── K. 命令补全面板 ──
{
  // 输入 / 即上面板：候选来自 commands（Chat 传 channel.commandCompletions）。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, {
    commands: [
      { name: 'setup', description: 'Re-run the first-run guide', commandLine: '/setup ' },
      { name: 'help', description: 'Show shortcuts', commandLine: '/help ' },
    ],
  })
  await s.send('/')
  check('K1 行首 / 弹出命令补全面板（候选上屏：setup/help 都在）',
    await settled(() => s.screen().includes('setup') && s.screen().includes('help')),
    s.screen().slice(0, 160))
  // 面板选中（Enter）= 执行命令（onCommandPick），不是 submit。
  await s.send('\r')
  check('K2 面板开着时 Enter 执行选中命令（onCommandPick，绝不 submit）',
    last(ev, 'command')?.value === '/setup ' && last(ev, 'submit') === undefined,
    JSON.stringify(ev.slice(-2)))
  s.close()
}
{
  // ↓ 移选中、Enter 执行第二条；Tab 与 Enter 同路径。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, {
    commands: [
      { name: 'setup', description: 'Re-run the first-run guide', commandLine: '/setup ' },
      { name: 'help', description: 'Show shortcuts', commandLine: '/help ' },
    ],
  })
  await s.send('/')
  await s.send('\u001b[B')
  await s.send('\r')
  check('K3 ↓ 移到第二条、Enter 执行那一条', last(ev, 'command')?.value === '/help ',
    JSON.stringify(last(ev, 'command')))
  s.close()
  const ev2: Ev[] = []
  const s2 = await openLaunchpad(ev2, {
    commands: [{ name: 'setup', description: 'Re-run the first-run guide', commandLine: '/setup ' }],
  })
  await s2.send('/')
  await s2.send('\t')
  check('K4 Tab 也是执行选中命令（与聊天页补全菜单同键位）',
    last(ev2, 'command')?.value === '/setup ' && last(ev2, 'submit') === undefined,
    JSON.stringify(ev2.slice(-2)))
  s2.close()
}
{
  // Esc 只收面板（草稿不动）；收掉后 Enter 才走 onSubmit 原文。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, {
    commands: [{ name: 'help', description: 'Show shortcuts', commandLine: '/help ' }],
  })
  await s.send('/he')
  await settled(() => s.screen().includes('help'))
  await s.send('\u001b')
  check('K5 Esc 只收面板（草稿一字不动，面板消失）',
    await settled(() => !s.screen().includes('Show shortcuts')) && last(ev, 'query')?.value === '/he',
    JSON.stringify(last(ev, 'query')))
  await s.send('\r')
  check('K6 面板收掉后 Enter 回到原文提交路径（onSubmit 收到 /he）',
    last(ev, 'submit')?.value === '/he' && last(ev, 'command') === undefined,
    JSON.stringify(last(ev, 'submit')))
  s.close()
}
{
  // 普通文本走 submit，不触发 onCommandPick。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, {
    commands: [{ name: 'setup', description: 'Re-run the first-run guide', commandLine: '/setup ' }],
  })
  await s.send('h')
  await s.send('i')
  await s.send('\r')
  check('K7 普通文本走 onSubmit（命令路径不触发）',
    last(ev, 'submit')?.value === 'hi' && last(ev, 'command') === undefined,
    JSON.stringify(ev.slice(-2)))
  s.close()
}
{
  // 鼠标：点面板里的命令行 = 选中执行（与 Enter 同路径）。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, {
    commands: [{ name: 'setup', description: 'Re-run the first-run guide', commandLine: '/setup ' }],
  })
  await s.send('/')
  await s.click('setup')
  check('K8 点击面板命令行执行该命令（不是点空白）',
    last(ev, 'command')?.value === '/setup ' && last(ev, 'blank') === undefined,
    JSON.stringify(ev.slice(-2)))
  s.close()
}

// ── K9. 面板卡片几何（浮层宽度契约）────────────────────────────────────────
// 面板经 OverlayAbove（`left:0/right:0`）锚在**成组块**里，成组块宽 =
// `cardWidth = max(24, min(columns - 4, 72))`，而卡片根节点 `width:'100%'` 填满
// 它。所以交给 SuggestionCard 的 columns 必须是 cardWidth，不是整屏 columns——
// 传整屏时（0.13.0 起的缺陷）卡片按整屏算边框与行宽，屏幕上是：
//   ① 上下边框比卡片宽，被 `truncate-end` 截成 `…`（右上 `╮` / 右下 `╯` 消失）；
//   ② 行内容比内容盒宽 2 列 → flex 收缩，长描述行的 `…` 落进右 `│` 那一格被
//      覆盖（描述看起来被硬切），同一条边还被亚 1 列宽的 `│` 测量多顶出**一条
//      幽灵空行**（`measure-text` 的 `ceil(1 / 0.973) = 2`）。
// 夹具刻意用长描述（真源 `cmd-desc-setup`）撑出②，两类宽度各钉一遍。
const PALETTE_COMMANDS: readonly { name: string; description: string; commandLine: string }[] = [
  { name: 'status', description: t('cmd-desc-status' as never), commandLine: '/status ' },
  // `settings` 是名字最长的一条（8 列）：它把名字列撑到 13，与真实 `/s` 列表同形。
  // 少了它，宽终端下最长的一行正好卡在内容盒宽度上，幽灵空行就漏测了。
  { name: 'settings', description: t('cmd-desc-settings' as never), commandLine: '/settings ' },
  { name: 'setup', description: t('cmd-desc-setup' as never), commandLine: '/setup ' },
  { name: 'skills', description: t('cmd-desc-skills' as never), commandLine: '/skills ' },
]

async function checkPaletteCardGeometry(columns: number, label: string): Promise<void> {
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { columns, commands: PALETTE_COMMANDS })
  await s.send('/')
  await settled(() => rowOf(s.term, '╭─ 命令') >= 0)
  const cardWidth = Math.max(24, Math.min(columns - 4, 72))
  const lines = viewportLines(s.term)
  const topRow = rowOf(s.term, '╭─ 命令')
  // 从顶边框往下收集到第一条 `╰`（面板底边框；再往下才是输入框自己的边框）。
  const card: string[] = []
  for (let i = topRow; i >= 0 && i < lines.length; i++) {
    card.push(lines[i]!)
    if (lines[i]!.includes('╰')) break
  }
  const top = (card[0] ?? '').trimEnd()
  const bottom = (card[card.length - 1] ?? '').trimEnd()
  const longRow = (card.find(line => line.includes('setup')) ?? '').trimEnd()
  // 面板左右缘 = 成组块左右缘，行首那段缩进不算卡片宽度。
  const boxTop = lines.slice(topRow + card.length).find(line => line.includes('╭')) ?? ''
  check(`PK1@${columns} ${label}：面板顶边框闭合（右上是 ╮，不是被截出来的 …），宽度 = cardWidth`,
    top.endsWith('╮') && stringWidth(top) - leftGap(top) === cardWidth,
    `top=${JSON.stringify(top)} w=${stringWidth(top) - leftGap(top)} cardWidth=${cardWidth}`)
  check(`PK2@${columns} ${label}：面板底边框闭合（右下是 ╯），宽度 = cardWidth`,
    bottom.endsWith('╯') && stringWidth(bottom) - leftGap(bottom) === cardWidth,
    `bottom=${JSON.stringify(bottom)} w=${stringWidth(bottom) - leftGap(bottom)} cardWidth=${cardWidth}`)
  check(`PK3@${columns} ${label}：卡片行数 = 边框 2 + 命令 ${PALETTE_COMMANDS.length}（长描述行不再多出一条幽灵空行）`,
    card.length === PALETTE_COMMANDS.length + 2 && card.every(line => line.trim() !== ''),
    `lines=${card.length} card=${JSON.stringify(card)}`)
  check(`PK4@${columns} ${label}：过长描述在卡片内截断并带 …（不是被右 │ 覆盖吃掉）`,
    /…\s*│$/u.test(longRow) && stringWidth(longRow) - leftGap(longRow) === cardWidth,
    `row=${JSON.stringify(longRow)} w=${stringWidth(longRow) - leftGap(longRow)}`)
  check(`PK5@${columns} ${label}：面板与输入框同左缘（同一成组块，浮层不漂）`,
    leftGap(boxTop) === leftGap(top) && stringWidth(boxTop) - leftGap(boxTop) === cardWidth,
    `box=${JSON.stringify(boxTop)} boxLeft=${leftGap(boxTop)} panelLeft=${leftGap(top)}`)
  s.close()
}

await checkPaletteCardGeometry(COLS, '宽终端（cardWidth 触顶 72）')
await checkPaletteCardGeometry(60, '窄终端（cardWidth = columns - 4）')

// ── L. Tips 点击与键盘轮换 ──
{
  const ev: Ev[] = []
  const s = await openLaunchpad(ev)
  await settled(() => s.screen().includes('输入 / 看全部命令'))
  await s.click('输入 / 看全部命令')
  check('L1 点击 Tips 切到第二条（launchpad-tip-2 上屏）',
    await settled(() => s.screen().includes('Ctrl+V 直接粘贴')), s.screen().slice(0, 160))
  await new Promise(resolve => setTimeout(resolve, 550)) // 固定窗:pacing 连续点击靠近同一行时避开双击判定
  await s.click('Ctrl+V 直接粘贴')
  check('L2 再点切到第三条（launchpad-tip-3 上屏）',
    await settled(() => s.screen().includes('参数行四段都能点')), '')
  await new Promise(resolve => setTimeout(resolve, 550)) // 固定窗:pacing 同上，确保这是第三次单击
  await s.click('参数行四段都能点')
  check('L3 第三次点击循环回第一条',
    await settled(() => s.screen().includes('输入 / 看全部命令')), s.screen().slice(-240))
  s.close()
}
{
  // 键盘路径（仓库硬规矩）：焦点环走到 Tips（-6）+ Enter = 切下一条。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev)
  // 环 = 输入框 → 参数四段 → 入口五条（含内核）→ Tips（-6）：从 -1 数 10 步 Tab。
  for (let i = 0; i < 10; i++) await s.send('\t')
  await settled(() => last(ev, 'focus')?.value === -6)
  await s.send('\r')
  check('L4 焦点在 Tips 行上 Enter 切下一条（与点击同一条 rotateTip）',
    await settled(() => s.screen().includes('Ctrl+V 直接粘贴')) && last(ev, 'submit') === undefined,
    s.screen().slice(0, 160))
  s.close()
}
{
  // 首启句优先级最高：不参与轮换，点击不切。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { firstRun: true })
  await settled(() => s.screen().includes('第一次用 dsh-TUI'))
  await s.click('第一次用 dsh-TUI')
  // 固定窗:首启不轮换 无事件可观测（不切本身是被测语义），等一拍再读屏。
  await new Promise(resolve => setTimeout(resolve, 150))
  check('L5 首启句不参与轮换（点击后仍是那一句，不切到别的 Tip）',
    s.screen().includes('第一次用 dsh-TUI') && !s.screen().includes('Ctrl+V 直接粘贴'),
    s.screen().slice(0, 160))
  s.close()
}

// ── M. 覆盖层内外的点击语义 ──
{
  // 浮层内部点击：拦住冒泡，不触发整页 onBlankClick（否则选行=既选又关）。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { overlayPanel: true })
  await settled(() => s.screen().includes('PICKER-PROBE'))
  const before = ev.length
  await s.click('PICKER-PROBE')
  check('M1 点击选择器浮层内部不触发空白兜底（选行不是点空白）',
    last(ev, 'blank') === undefined, JSON.stringify(ev.slice(before)))
  // 浮层之外的点击：走空白兜底（Chat 侧据此关掉选择器，见 onboarding-chat 回归）。
  await s.click('██▀▀▄▄')
  check('M2 点击浮层之外的空白触发 onBlankClick（Chat 用它关选择器）',
    last(ev, 'blank') !== undefined, JSON.stringify(ev.slice(before)))
  s.close()
}


// ── N. 输入光标反显 ──
{
  // ① 行尾打字：刚输入的字符与光标**同时可见**（EN + ZH 各一次）。判据用
  //    终端格级属性：行里既有非反显的字符格、又有反显格（行尾反显空格），
  //    且视口纯文本里字符原样在（没有被光标顶掉/吃掉）。
  const cellScan = (s: ReturnType<typeof openLaunchpad>, ch: string) => {
    const lines = viewportLines(s.term)
    for (let row = 0; row < lines.length; row++) {
      if (!lines[row]!.includes(ch)) continue
      const line = s.term.buffer.active.getLine(row)!
      let charPlain = false
      let inverseCell = false
      for (let col = 0; col < s.term.cols; col++) {
        const cell = line.getCell(col)
        if (cell === undefined) continue
        if (cell.getChars() === ch && !cell.isInverse()) charPlain = true
        if (cell.isInverse()) inverseCell = true
      }
      return { charPlain, inverseCell, text: lines[row]!.trim() }
    }
    return { charPlain: false, inverseCell: false, text: '' }
  }
  {
    const ev: Ev[] = []
    const s = await openLaunchpad(ev)
    await settled(() => s.screen().includes('❯'))
    await s.send('a')
    const en = cellScan(s, 'a')
    check('N1 行尾打英文字：字符与光标同时可见（字符格非反显 + 行内存在反显格 = 行尾反显空格）',
      en.charPlain && en.inverseCell && en.text.includes('a'),
      JSON.stringify(en))
    await s.send('好')
    const zh = cellScan(s, '好')
    check('N1b 行尾打中文：宽字符与光标同时可见（不被劈半、不被吃掉）',
      zh.charPlain && zh.inverseCell && zh.text.includes('好'),
      JSON.stringify(zh))
    s.close()
  }
  {
    // ② 行中光标：反显块**压在当前字符身上**（对那一个字符 inverse），
    //    前后字符常规显示、一个都不消失；视口纯文本逐字符等于原文
    //    （绝不另起一格画方块、绝不增删字符）。
    const ev: Ev[] = []
    const s = await openLaunchpad(ev, { query: 'abc' })
    await settled(() => s.screen().includes('abc'))
    await s.send('\u001b[D')
    await s.send('\u001b[D')
    const lines = viewportLines(s.term)
    const row = lines.findIndex(l => l.includes('abc'))
    check('N2 行中光标压在字身上（b 反显，a/c 常规可见，文本逐字符不变）',
      row >= 0 && (() => {
        const line = s.term.buffer.active.getLine(row)!
        let aPlain = false; let bInverse = false; let cPlain = false
        for (let col = 0; col < s.term.cols; col++) {
          const cell = line.getCell(col)
          if (cell === undefined) continue
          if (cell.getChars() === 'a') aPlain = !cell.isInverse()
          if (cell.getChars() === 'b') bInverse = cell.isInverse()
          if (cell.getChars() === 'c') cPlain = !cell.isInverse()
        }
        return aPlain && bInverse && cPlain && (lines[row]!.trim().includes('abc'))
      })(),
      row >= 0 ? lines[row]!.trim() : 'row not found')
    s.close()
  }
  // ③ 闪烁相位逐字节不变已由 A11 钉死（相位只切样式）；此处补「反显 ↔ 常规」
  //    的相位语义：相位帧数 ≥2 已由 G3 钉死，不重复挂机。
  {
    // ④ 空输入：光标压在占位文本的第一个字符上。
    //    文本与「无光标」逐字节相同（没有多出来的块字符格），首字符带反显。
    const ev: Ev[] = []
    const s = await openLaunchpad(ev)
    await settled(() => s.screen().includes('说点什么'))
    const lines = viewportLines(s.term)
    const row = lines.findIndex(l => l.includes('说点什么'))
    const ph = '说点什么，或输入 / 看命令…'
    check('N3 空输入：光标压在占位首字身上（行文本与无光标逐字节相同，首字符反显）',
      row >= 0 && (() => {
        const text = lines[row]!.trimEnd()
        // 逐字节契约：行里就是 前缀 + 空格 + 占位原文，没有额外格子。
        if (!text.includes('❯ ' + ph)) return false
        const line = s.term.buffer.active.getLine(row)!
        let firstInverse = false
        for (let col = 0; col < s.term.cols; col++) {
          const cell = line.getCell(col)
          if (cell === undefined) continue
          if (cell.getChars() === '说') firstInverse = cell.isInverse()
        }
        return firstInverse
      })(),
      row >= 0 ? lines[row]!.trim() : 'row not found')
    s.close()
  }
  {
    // ⑤ 失焦不消失（用户原话「哪怕焦点没了也不消失」）：从不注入 focus 事件
    //    （terminalFocused:false）光标仍在——输入行里存在反显格。
    const ev: Ev[] = []
    const s = await openLaunchpad(ev, { terminalFocused: false })
    await settled(() => s.screen().includes('说点什么'))
    const lines = viewportLines(s.term)
    const row = lines.findIndex(l => l.includes('说点什么'))
    check('N4 无 focus 事件光标仍在（反显格存在；闪烁帧数由 G3 另行钉死）',
      row >= 0 && (() => {
        const line = s.term.buffer.active.getLine(row)!
        for (let col = 0; col < s.term.cols; col++) {
          const cell = line.getCell(col)
          if (cell !== undefined && cell.isInverse()) return true
        }
        return false
      })(),
      row >= 0 ? lines[row]!.trim() : 'row not found')
    s.close()
  }
  {
    // ⑥ 行尾反显空格不额外占格：反显格紧贴最后一个字符之后，且那一格是空格
    //    （不是把某个字符顶掉），其后没有别的非空内容。
    const ev: Ev[] = []
    const s = await openLaunchpad(ev)
    await settled(() => s.screen().includes('❯'))
    await s.send('ab')
    await settled(() => s.screen().includes('ab'))
    const lines = viewportLines(s.term)
    const row = lines.findIndex(l => l.includes('ab'))
    check('N5 行尾光标 = 紧贴末字符的反显空格（不占文本格、不吃字符）',
      row >= 0 && (() => {
        const raw = lines[row]!
        // 行 = 缩进 + │ + ' ❯ ab ' + 空格 + 右边框：行首到 ab 全是 ASCII
        //（空格/│/❯ 都是单宽），字符串下标 == 终端列号。
        if (!raw.includes('❯ ab')) return false
        const at = raw.indexOf('ab')
        const line = s.term.buffer.active.getLine(row)!
        const caretCell = line.getCell(at + 2)
        const beyond = line.getCell(at + 3)
        return caretCell !== undefined && caretCell.isInverse()
          && (caretCell.getChars() === '' || caretCell.getChars() === ' ')
          // 反显空格之后就是普通空白（没有被顶出来的字符），行没有被撑动。
          && beyond !== undefined && !beyond.isInverse() && (beyond.getChars() === '' || beyond.getChars() === ' ')
      })(),
      row >= 0 ? lines[row]!.trim() : 'row not found')
    s.close()
  }
}

// ── R. Tips 轮换与角标点击 ──
{
  // Tips 自动轮换：短间隔（300ms）注入，跨一次自动轮换后文案换到下一条、
  // **Tips 行之外的行逐字节不变**（呼吸感不许带来布局抖动）。手动切换后计时
  // 重置：点击切一条，紧接着的一个自动窗口内不再跳（间隔远大于测试窗口时钉
  // 死为「点击后 tipIndex 不被自动轮换立刻改掉」——这里用 5s 间隔 + 点击 +
  // 800ms 窗口验证不被跳走）。
  const TIP_A = '输入 / 看全部命令'
  const TIP_B = 'Ctrl+V 直接粘贴'
  {
    const ev: Ev[] = []
    const s = await openLaunchpad(ev, { tipRotateMs: 300 })
    await settled(() => s.screen().includes(TIP_A))
    const before = viewportLines(s.term)
    const tipRowBefore = before.findIndex(l => l.includes('● Tips：'))
    // 固定窗:Tips轮换 轮换本身是被测语义（无完成事件可轮询），按 >2 个间隔等。
    await new Promise(resolve => setTimeout(resolve, 800))
    const after = viewportLines(s.term)
    const tipRowAfter = after.findIndex(l => l.includes('● Tips：'))
    const othersSame = before.every((line, i) => i === tipRowBefore || after[i] === line)
    // 慢 runner 上 800ms 窗口可能跨过两个 300ms 相位，接受 B 或 C（换到
    // 「下一条」的顺序语义由 R2 的手动单步钉死）。
    check('R1 Tips 自动轮换：文案换成下一批之一，Tips 行位置不变（仍在同一行号）',
      tipRowBefore >= 0 && tipRowAfter === tipRowBefore
        && (after[tipRowAfter]!.includes(TIP_B) || after[tipRowAfter]!.includes('参数行四段都能点'))
        && before[tipRowBefore] !== after[tipRowAfter],
      `before=${JSON.stringify(before[tipRowBefore])} after=${JSON.stringify(after[tipRowAfter])}`)
    check('R1b 自动轮换零布局抖动：Tips 行之外的行逐字节不变', othersSame,
      before.map((l, i) => after[i] === l ? '' : `${i}: ${JSON.stringify(l)} -> ${JSON.stringify(after[i])}`).filter(x => x !== '').join(' ; '))
    s.close()
  }
  {
    // 手动切换重置计时：5s 间隔下点击切到某条，800ms 窗口内不被自动轮换跳走。
    const ev: Ev[] = []
    const s = await openLaunchpad(ev, { tipRotateMs: 5000 })
    await settled(() => s.screen().includes(TIP_A))
    await s.click('● Tips：')
    await settled(() => s.screen().includes(TIP_B))
    // 固定窗:手动重置 计时重置是被测语义，窗口须显著小于间隔。
    await new Promise(resolve => setTimeout(resolve, 800))
    check('R2 手动切换后计时重置（800ms 窗口内不被 5s 自动轮换跳走）',
      s.screen().includes(TIP_B) && !s.screen().includes('参数行四段都能点'),
      s.screen().slice(0, 120))
    s.close()
  }
}
{
  // 左下角工作目录铭牌：真鼠标点击 → onOpenWorkspace；键盘路径 = 焦点环末格
  // （-1 → 参数4 → 入口4 → Tips → 铭牌，Tab×11）+ Enter 同一条回调。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { cornerWorkspace: true })
  await settled(() => s.screen().includes(CWD))
  const before = ev.length
  await s.click(CWD)
  check('R3 点击左下角工作目录铭牌 → onOpenWorkspace（既有 /workspace 路径）',
    last(ev, 'workspace') !== undefined, JSON.stringify(ev.slice(before)))
  // 环 = -1 → 参数4（-2..-5）→ 入口5（0..4，含内核）→ Tips（-6）→ 铭牌（-7）：Tab×11。
  for (let i = 0; i < 11; i++) await s.send('\t')
  const beforeKb = ev.length
  await s.send('\r')
  check('R3b 键盘路径：焦点环走到铭牌（环末格）+ Enter → 同一条回调',
    last(ev, 'workspace') !== undefined && last(ev, 'focus')?.value === -7,
    JSON.stringify(ev.slice(beforeKb)))
  s.close()
}
{
  // 右下角铭牌：第一行显示 dsh-tui，其后一行显示一个内核（当前项标记为
  // ▸、主题蓝），行与行右缘对齐（同一块铭牌带）；kernels 缺省时右侧只有第一行
  // （降级不编造内核号）。底部带满 3 行后，输入框在任何档位都不被挤掉
  // （input-only 档由 D 组钉死；这里再钉 corners 行数）。
  const s = await openLaunchpad([], { kernels: buildKernelCatalog({ current: 'dsh', dshVersion: '0.2.0-rc.2' }) })
  await settled(() => s.screen().includes('dsh-core v0.2.0-rc.2'))
  const lines = viewportLines(s.term)
  const tuiRow = lines.findIndex(l => l.includes(`dsh-tui v${VERSION}`))
  const kernelRow = lines.findIndex(l => l.includes('dsh-core v0.2.0-rc.2'))
  check('R4 右下角：TUI 版本在上、内核行紧随其后，两块右缘对齐（同一块铭牌带）',
    tuiRow >= 0 && kernelRow === tuiRow + 1
      && Math.abs(rightGap(lines[tuiRow]!, COLS) - rightGap(lines[kernelRow]!, COLS)) <= 1,
    `tui=${JSON.stringify(lines[tuiRow]?.trimEnd())} kernel=${JSON.stringify(lines[kernelRow]?.trimEnd())}`)
  check('R4b 左下目录铭牌与版本第一行顶对齐（同一块铭牌带，一高一低不许）',
    tuiRow >= 0 && (lines[tuiRow]!.includes(CWD) || lines[tuiRow]!.trim() === ''),
    JSON.stringify(lines[tuiRow]?.trimEnd()))
  s.close()
  const s2 = await openLaunchpad([])
  await settled(() => s2.screen().includes(`dsh-tui v${VERSION}`))
  check('R4c 内核目录缺省：右侧只有 TUI 一行（不编造内核号、也不画 ▸）',
    !s2.screen().includes('dsh-core v') && !s2.screen().includes('\u25b8'), s2.screen().slice(-120))
  s2.close()
}

// ── S. 右下角内核区 ──
// 用户原话：「在这里显示可以选择的内核 并且有箭头或者高亮 表明目前记忆中启动
// 的内核」——目录由 kernelCatalog 的真实派生函数造（夹具不手写形状）。
{
  // 底栏用**短品牌名**（kernelDisplayName：DSH / Claude，与「内核 · DSH」那个 chip
  // 同源）——全名 40 列会把左下角的目录铭牌挤掉；全名留给选择器那一屏。
  const DSH_LABEL = 'DSH'
  const CLAUDE_LABEL = 'Claude'
  /** 当前内核的前缀（两格宽，与「不多不少两个空格」的其余行对齐）。 */
  const MARK = '\u25b8 '
  /** Launchpad 的 KERNEL_CORNER_FOCUS（内核区在焦点环里的编码）。 */
  const KERNEL_FOCUS = -8
  const probing = buildKernelCatalog({ current: 'dsh', dshVersion: '0.2.0-rc.2' })
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { kernels: probing, kernelPick: true })
  await settled(() => s.screen().includes('dsh-tui v' + VERSION))
  const lines = viewportLines(s.term)
  const tuiRow = lines.findIndex(l => l.includes('dsh-tui v' + VERSION))
  const dshRow = lines.findIndex(l => l.includes(MARK + DSH_LABEL))
  const claudeRow = lines.findIndex(l => l.includes(CLAUDE_LABEL))
  const firstGlyph = (row: number) => firstGlyphCell(s.term, row, COLS)
  /** 对照基准：右下角第一行 TUI 版本号。 */
  const tuiCell = cellAtText(s.term, lines, tuiRow, 'dsh-tui v' + VERSION)
  check('S1 内核区排在 TUI 版本之下，一行一个内核：当前行打 ▸ 且带版本串',
    tuiRow >= 0 && dshRow === tuiRow + 1 && claudeRow === tuiRow + 2
      && lines[dshRow]!.includes('dsh-core v0.2.0-rc.2'),
    `tui=${tuiRow} dsh=${dshRow} claude=${claudeRow} ${JSON.stringify(lines[dshRow]?.trimEnd())}`)
  const dshFg = fgKeyOf(firstGlyph(dshRow))
  const claudeFg = fgKeyOf(firstGlyph(claudeRow))
  check('S2 当前内核行正常亮度（与 dim 行不同色），其余行两个空格前缀且与 TUI 版本行同色（dim）',
    dshFg !== claudeFg && claudeFg === fgKeyOf(tuiCell) && claudeFg !== 'default'
      && !lines[claudeRow]!.includes(MARK)
      // 前缀等宽：两个名字的起始列相同（▸ + 空格 vs 两个空格）。
      && stringWidth(lines[dshRow]!.slice(0, lines[dshRow]!.indexOf(DSH_LABEL)))
        === stringWidth(lines[claudeRow]!.slice(0, lines[claudeRow]!.indexOf(CLAUDE_LABEL))),
    `dsh=${dshFg} claude=${claudeFg} tui=${fgKeyOf(tuiCell)} claude=${JSON.stringify(lines[claudeRow]?.trimEnd())}`)
  check('S2b 底栏画短品牌名（DSH / Claude），全名一个都不画（全名只进选择器）',
    lines[dshRow]!.includes(MARK + DSH_LABEL + ' \u00b7 ') && lines[claudeRow]!.trim().startsWith(CLAUDE_LABEL + ' \u00b7 ')
      && !lines.some(l => l.includes('DeepSeek Harness') || l.includes('Claude Agent')),
    `dsh=${JSON.stringify(lines[dshRow]?.trimEnd())} claude=${JSON.stringify(lines[claudeRow]?.trimEnd())}`)
  check('S3 探测未回来：claude 行显示「检测中…」——置灰但**不是**「未安装」',
    claudeRow >= 0 && lines[claudeRow]!.includes('检测中…') && !lines[claudeRow]!.includes('未安装'),
    JSON.stringify(lines[claudeRow]?.trimEnd()))
  // 鼠标路径：整块是一个可点目标（点开选择器 = Chat 的 onKernelPick），点击
  // 拦住冒泡，不能同时算「点空白」（那会既开选择器又清焦点）。
  const beforeClick = ev.length
  await s.click(DSH_LABEL)
  check('S4 点击内核区 → onKernelPick（整块一个目标，且不是「点空白」）',
    last(ev, 'kernel') !== undefined && !ev.slice(beforeClick).some(e => e.type === 'blank'),
    JSON.stringify(ev.slice(beforeClick)))
  // 悬停将焦点移到内核区；非当前项从 dim 切换为高亮，
  // 行**亮起来**（加粗）——这就是「可以点」的鼠标反馈。
  const beforeHover = ev.length
  const hoverAt = findCell(s.term, CLAUDE_LABEL)!
  s.input.write('\u001b[<35;' + hoverAt.col + ';' + hoverAt.row + 'M')
  check('S5 悬停内核区 → 焦点落到 KERNEL_CORNER_FOCUS(-8)（鼠标与键盘同一格）',
    await settled(() => last(ev, 'focus')?.value === KERNEL_FOCUS), JSON.stringify(ev.slice(beforeHover)))
  check('S5b 悬停高亮：非当前行不再是 dim 色且加粗（悬停前的对照见 S2）',
    await settled(() => fgKeyOf(firstGlyph(claudeRow)) !== fgKeyOf(tuiCell) && (firstGlyph(claudeRow)?.isBold() ?? 0) > 0),
    `fg=${fgKeyOf(firstGlyph(claudeRow))} tui=${fgKeyOf(tuiCell)} bold=${firstGlyph(claudeRow)?.isBold()}`)
  s.close()
  // 键盘路径（仓库硬规矩：每个可点目标都要有不含鼠标的等价操作）：焦点环末格
  // 是内核区，Enter 与点击同一条回调。环 = 输入框(-1) → 参数4 → 入口5 →
  // Tips(-6) → 目录铭牌(-7) → 内核区(-8)，共 13 格。这里铭牌也接上，钉死顺序。
  const ev2: Ev[] = []
  const s2 = await openLaunchpad(ev2, { kernels: probing, kernelPick: true, cornerWorkspace: true })
  await settled(() => s2.screen().includes(MARK + DSH_LABEL))
  for (let i = 0; i < 11; i++) await s2.send('\t')
  const atCwd = last(ev2, 'focus')?.value
  await s2.send('\t')
  const atKernel = last(ev2, 'focus')?.value
  const beforeEnter = ev2.length
  await s2.send('\r')
  check('S6 焦点环：目录铭牌(-7) 之后才是内核区(-8)；Enter 触发 onKernelPick（不是提交）',
    atCwd === -7 && atKernel === KERNEL_FOCUS && last(ev2, 'kernel') !== undefined && last(ev2, 'submit') === undefined,
    `cwd=${atCwd} kernel=${atKernel} ${JSON.stringify(ev2.slice(beforeEnter))}`)
  s2.close()
  {
    // 已探测「未安装」：置灰原因是未安装（与「检测中…」分得清）。
    const s3 = await openLaunchpad([], { kernels: buildKernelCatalog({ current: 'dsh', dshVersion: '0.2.0-rc.2', statuses: { claude: { installed: false } } }) })
    check('S7 已探测未安装：claude 行显示「未安装」',
      await settled(() => s3.screen().includes(CLAUDE_LABEL + ' · 未安装')), s3.screen().slice(-160))
    s3.close()
  }
  {
    // 已探测可用：版本串是**产品前缀 + 版本号**，且这一行不变暗（可选）。
    const s4 = await openLaunchpad([], { kernels: buildKernelCatalog({ current: 'dsh', dshVersion: '0.2.0-rc.2', statuses: { claude: { installed: true, auth: 'ok', version: '2.0.1' } } }) })
    check('S8 可选内核显示版本串：claude-code v2.0.1（不是裸版本号）',
      await settled(() => s4.screen().includes(CLAUDE_LABEL + ' · claude-code v2.0.1')), s4.screen().slice(-160))
    const lines4 = viewportLines(s4.term)
    const tui4 = lines4.findIndex(l => l.includes('dsh-tui v' + VERSION))
    const claude4 = rowOf(s4.term, CLAUDE_LABEL)
    const claude4Fg = fgKeyOf(firstGlyphCell(s4.term, claude4, COLS))
    // 底栏只管「现在跑的是它」：可选择的内核行**照样** dim（可选性由选择器那一行
    // 表达——picker 里只有不可选行才变暗，两条不同的口径各测各的）。
    check('S8b 可选但非当前的内核行在底栏仍 dim（可不可选归选择器表达）',
      claude4Fg === fgKeyOf(cellAtText(s4.term, lines4, tui4, 'dsh-tui v' + VERSION)),
      'claude=' + claude4Fg + ' tui=' + fgKeyOf(cellAtText(s4.term, lines4, tui4, 'dsh-tui v' + VERSION)))
    s4.close()
  }
}

// ── O. 落地页浮层遮挡 ──
{
  // 形态（用户实测两轮定的）：浮层矩形内**每一格都被空格占位**——宿主屏的
  // 字形（大字/立绘字符画）不得残留（防重影）；但**不发背景色 SGR**（无白底；
  // Kitty 立绘图像仍从终端默认背景透出）。判据用高探针（探针行 + 6 行空白）：
  const plain = await openLaunchpad([])
  await settled(() => plain.screen().includes('██▀▀▄▄ ██▀▀▀▀'))
  const baseline = viewportLines(plain.term)
  const baselineArtRows = baseline.filter(l => l.includes('█')).length
  plain.close()
  const withOverlay = await openLaunchpad([], { overlayPanelTall: true })
  await settled(() => withOverlay.screen().includes('PICKER-PROBE'))
  const lines = viewportLines(withOverlay.term)
  const probeRow = lines.findIndex(l => l.includes('PICKER-PROBE'))
  const cardRow = lines.findIndex(l => l.includes('╭'))
  // 探针浮层 = probeRow..cardRow-1（锚在卡片顶边向上展开、紧贴）。
  const overlayRows: number[] = []
  for (let r = probeRow; r >= 0 && r < cardRow; r++) overlayRows.push(r)
  const occluded = overlayRows.filter(r => lines[r]!.includes('PICKER-PROBE') === false)
  check('O1 遮挡不变量：浮层矩形内没有启动页的字形（空白行不含 █/▀/▄，防重影）',
    probeRow >= 0 && cardRow > probeRow && occluded.length > 0
      && occluded.every(r => !lines[r]!.includes('█') && !lines[r]!.includes('▀') && !lines[r]!.includes('▄')),
    `probe=${probeRow} card=${cardRow} blankRows=${JSON.stringify(occluded.map(r => lines[r]!.trim()))}`)
  check('O1b 探针面板真的在屏上（盖在输入框上方），且大字在浮层之外原样在',
    probeRow >= 0 && probeRow < cardRow && lines.filter(l => l.includes('█')).length < baselineArtRows,
    `artRows=${lines.filter(l => l.includes('█')).length}/${baselineArtRows}`)
  {
    // 无底色不变量：浮层区域内的格子背景是终端默认（无背景色块）。xterm 的
    // BufferCell.isBgDefault() 是判据；不透明旧姿态会带 toolCardBackground。
    const row = occluded[0] ?? -1
    const line = row >= 0 ? withOverlay.term.buffer.active.getLine(row) : undefined
    let bgDefault = false
    let checked = 0
    if (line !== undefined) {
      for (let col = 0; col < COLS; col++) {
        const cell = line.getCell(col)
        if (cell === undefined) continue
        checked += 1
        if (cell.isBgDefault()) bgDefault = true
        else { bgDefault = false; break }
      }
    }
    check('O2 无底色不变量：浮层空白行的格子背景全是终端默认（没有色块）',
      row >= 0 && checked > 0 && bgDefault,
      `row=${row} checked=${checked}`)
  }
  withOverlay.close()
}

// ── P. Continue 的 Alt+R 快捷键 ──
{
  const ev: Ev[] = []
  const s = await openLaunchpad(ev)
  await settled(() => s.screen().includes(CONTINUE_LABEL))
  const before = ev.length
  await s.send('\u001br')
  check('P1 Alt+R 触发 Continue（keymap 的 continue 动作，默认 alt+r）',
    last(ev, 'action')?.value === 'continue' && last(ev, 'submit') === undefined,
    JSON.stringify(ev.slice(before)))
  s.close()
  const ev2: Ev[] = []
  const s2 = await openLaunchpad(ev2, { actions: resolveLaunchpadActions({ jobsRunning: false, updateAvailable: false, starDue: false }) })
  await settled(() => s2.screen().includes(SESSIONS_WORKSPACE_LABEL))
  const before2 = ev2.length
  await s2.send('\u001br')
  check('P2 没有可继续会话时 Alt+R 不放假动作（无 action，也不把 r 漏进草稿）',
    last(ev2, 'action') === undefined && last(ev2, 'query') === undefined,
    JSON.stringify(ev2.slice(before2)))
  s2.close()
}

if (failures === 0) console.log(`\nverify-launchpad: ${checks} checks, all passed`)
else console.error(`\nverify-launchpad: ${failures} of ${checks} checks FAILED`)
process.exit(failures === 0 ? 0 : 1)
