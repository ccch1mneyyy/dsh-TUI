/**
 * verify-launchpad — 启动落地页（Launchpad）回归。
 *
 * 钉住的契约（2026-10 第三版改版）：
 *
 *   A. 版面：头部走 LogoV2 chrome=minimal + arrangement=column——**立绘在上、
 *      DEEPSEEK/HARNESS 大字在下**，两块各自水平居中；头部里没有版号/模型/
 *      工作目录/启动提示/欢迎语（它们各有更低频的位置：参数进卡片、目录与
 *      版本进双角铭牌）。居中主体 = 头部 + **复合卡片**：圆角边框（只有一层，
 *      不框套框）里只有输入行（SearchBox borderless），参数条移出框外紧贴框下
 *      ——第四版只画值不画字段名：`zhipu/glm-5.3  ·  Max  ·  Execute  ·  default`
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
 *   D. 纯函数：resolveLaunchpadActions 表驱动（首启/配置问题/有上次会话/常态/
 *      git 分支/刚升级 每状态一行，钉位置与理由）、truncateContinueTitle 边界、
 *      fitChips 不切半个标签、阶梯阈值（full → no-tip → no-hints → no-art →
 *      input-only，字段 showWhale/showBigTitle/showHero/showHints/showTip/
 *      showCorners/cardRows）。theme/lang/settings 永不出现。
 *   E. 宽度不变量：120/100/72/60/48 列下任何一行都不超宽；标签/Tips/参数条
 *      要么完整出现在同一行、要么整条不出现（不许被切断的半句）。
 *
 * 运行：node --import tsx/esm scripts/verify-launchpad.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import fakeHome from './lib/fake-home.mjs' // 必须最先：DATA_DIR 在 import 时定死
import { settle, settled, viewportLines } from './lib/term-test.mjs'
import { stringWidth } from '../src/ink/stringWidth.js'

const { Terminal: XTerm } = xterm
const [
  { render, ThemeProvider, AlternateScreen, Text },
  { Launchpad, fitChips, prevBoundary, nextBoundary },
  { resolveLaunchpadLayout },
  { resolveLaunchpadActions, truncateContinueTitle, LAUNCHPAD_CONTINUE_TITLE_MAX },
  { splashFontById },
  { t },
] = await Promise.all([
  import('../src/ui.js'),
  import('../src/screens/Launchpad.js'),
  import('../src/components/launchpadLayout.js'),
  import('../src/components/launchpadActions.js'),
  import('../src/components/splashFonts.js'),
  import('../src/i18n.js',
  ),
])

/** 夹具的默认状态：有上次会话（常态最常见的一档，动作表 = Continue·Sessions·Workspace·Model）。 */
const DEFAULT_ACTIONS = resolveLaunchpadActions({ onboardingPending: false, configProblem: false, lastSessionTitle: '修个登录页' })
/** 默认档四个入口的屏上标签（zh）。 */
const CONTINUE_LABEL = '继续「修个登录页」'

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
/** 第五版参数行：只画值、模型段**只显示模型名**（无 provider/ 前缀）。 */
const PARAM_LINE = 'glm-5.3  ·  Max  ·  Execute  ·  default'
/** 夹具固定 bold 字面：大字 needle 与阶梯阈值都不随当天轮换的字体漂。 */
const FONT = splashFontById('bold')

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
  /** 参数条三段；false = 全不传（卡片矮一行的档）。默认带全。 */
  params?: boolean
  /** 双角铭牌三段；false = 全不传。默认带全。 */
  corners?: boolean
  /** 剪贴板桩内容；undefined = 空文本，null = 剪贴板为空（读得到但没东西）。 */
  clipboard?: string | null
  /** 剪贴板读回延迟（ms）——异步落点守则用例在延迟窗口里继续打字。 */
  clipboardDelay?: number
  /** 动作表（第四版：默认 = 有上次会话的常态档）。 */
  actions?: readonly ReturnType<typeof resolveLaunchpadActions>[number][]
  /** 终端焦点标志；false = 模拟"从未收到 focus 事件"（光标仍必须自动呼吸）。 */
  terminalFocused?: boolean
  /** 传一个探针面板给 overlayPanel（第五版：选择器盖在落地页之上）。 */
  overlayPanel?: boolean
  /** 模拟"选择器开着"（第五版：本屏键盘整块让位）。 */
  inputPaused?: boolean
}

async function openLaunchpad(events: Ev[], options: OpenOptions = {}) {
  const columns = options.columns ?? COLS
  const rows = options.rows ?? ROWS
  const term = new XTerm({ cols: columns, rows, scrollback: 0, allowProposedApi: true })
  const out = new FakeStdout(term)
  const input = new FakeStdin()
  const params = options.params !== false
  const corners = options.corners !== false

  // 受控闭环：Chat 持有 query/caret/focus，这里照抄那三条回调的接线。
  function Harness(): React.ReactNode {
    const [query, setQuery] = React.useState(options.query ?? '')
    const [caret, setCaret] = React.useState((options.query ?? '').length)
    const [focus, setFocus] = React.useState(-1)
    return (
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
        overlayPanel={options.overlayPanel === true ? <Text>PICKER-PROBE 选择器探针</Text> : undefined}
        inputPaused={options.inputPaused === true}
        onParamPick={(segment) => { events.push({ type: 'param', value: segment }) }}
        model={params ? 'glm-5.3' : undefined}
        effort={params ? 'max' : undefined}
        mode={params ? 'act' : undefined}
        permission={params ? 'default' : undefined}
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
  /** 注入按键并等到它**产生了事件**（比固定 sleep 稳，且失败即断言失败）。 */
  const send = async (data: string): Promise<void> => {
    const before = events.length
    input.write(data)
    await settle(() => events.length > before)
  }
  const click = async (needle: string): Promise<void> => {
    await settled(() => findCell(term, needle) !== null)
    const found = findCell(term, needle)
    if (found === null) throw new Error(`click target not on screen: ${needle}`)
    const before = events.length
    input.write(`\u001b[<0;${found.col};${found.row}M\u001b[<0;${found.col};${found.row}m`)
    await settle(() => events.length > before)
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
/** 行首缩进的显示宽度。 */
function leftGap(line: string): number {
  const m = /^\s*/.exec(line)
  return m === null ? 0 : stringWidth(m[0])
}
/** 行尾留白的显示宽度。 */
function rightGap(line: string, columns: number): number {
  const trimmed = line.replace(/\s+$/u, '')
  return Math.max(0, columns - stringWidth(trimmed))
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
// 动作入口行（第四版：纯文字标签、无键帽；悬停/焦点 = 整块矩形高亮）。
{
  const lines = viewportLines(base.term)
  const hintRow = lines.find(l => l.includes(CONTINUE_LABEL)) ?? ''
  check('A4 动作入口行画出来了（Continue 那条在）', hintRow !== '')
  check('A4b 纯文字入口：没有键帽键位前缀（/setup、esc、/model、?、指针都不在入口行）',
    !hintRow.includes('/setup') && !hintRow.includes('esc') && !hintRow.includes('/model')
      && !hintRow.includes('?') && !hintRow.includes('▸') && !hintRow.includes('❯'),
    hintRow.trim().slice(0, 80))
  check('A4c 四个入口在同一行、行高恒 1（每个标签整屏只出现在这一行）',
    rowHasAll(hintRow, [CONTINUE_LABEL, '历史会话', '工作区', '模型'])
      && lines.filter(l => l.includes(CONTINUE_LABEL)).length === 1
      && lines.filter(l => l.includes('历史会话')).length === 1
      && lines.filter(l => l.includes('工作区')).length === 1,
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
// 欢迎语曾经画了两遍（LogoV2 一行 + 落地页自己一行），改版后整块删除。
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
  check('A6e 参数行文案 = 模型 · 思考深度 · 模式 · 权限（四段，模型名带浅紫）',
    param >= 0 && base.screen().includes(PARAM_LINE), PARAM_LINE)
  check('A6e2 模型段只显示模型名（无 provider/ 前缀，参数行没有斜杠）',
    param >= 0 && !(viewportLines(base.term)[param] ?? '').includes('/') && !base.screen().includes('zhipu'),
    (viewportLines(base.term)[param] ?? '').trim())
  // 左对齐输入框：参数行行首 = 卡片左缘 + 2（边框 1 + padding 1）。
  const cardLeft = leftGap((viewportLines(base.term).find(l => l.includes('╭')) ?? ''))
  check('A6f 参数行左对齐输入框（行首 = 卡片左缘 + 2）',
    Math.abs(leftGap(viewportLines(base.term)[param] ?? '') - (cardLeft + 2)) <= 1,
    `paramLeft=${leftGap(viewportLines(base.term)[param] ?? '')} cardLeft=${cardLeft}`)
  // 第五版：参数行与入口行之间隔一行呼吸留白（用户实测要求；矮屏阶梯可撤）。
  const lines = viewportLines(base.term)
  const hint = lines.findIndex(l => l.includes(CONTINUE_LABEL))
  const tip = lines.findIndex(l => l.includes('● Tips'))
  const corner = lines.findIndex((l, i) => i > tip && l.includes(CWD))
  check('A6g 参数行仍紧贴框、入口行隔一行呼吸留白（hint = param + 2，中间是空行）',
    hint === param + 2 && (lines[param + 1] ?? 'x').trim() === '',
    'hint=' + hint + ' param=' + param + ' mid=' + JSON.stringify(lines[param + 1]))
  // 第六版：词标（大字末行）与输入框之间隔两行呼吸留白（用户实测要求）。
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
      && viewportLines(plain.term)[rowOf(plain.term, '╰') + 1]!.includes('历史会话'),
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
// 光标闪烁（第三版）：相位只切换样式、绝不增删字符——输入行的视口纯文本跨相位
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
  await s.send('\u001b')
  check('B6 有字时 Esc 只清空（不去看会话）',
    last(ev, 'query')?.value === '' && last(ev, 'escape') === undefined,
    JSON.stringify(ev))
  await s.send('\u001b')
  check('B7 空输入再按 Esc 才交 sessions', last(ev, 'escape')?.value === 'sessions')
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

// ── B12+ 粘贴（2026-10 第三版新增：曾经 Ctrl+V 被组合键兜底吞掉，粘贴全死）──
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
  // 环顺序 = 输入框 → 参数四段 → 入口（第五版）：连 ↓ 穿过参数行落到第一条入口。
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
  await s.click('历史会话')
  // 点击不带 motion 事件，所以这里只钉"动作落在被点的那一条"（hover 另有用例）。
  check('C7 点第二条入口 → 动作落到那一条（不是永远第一条）',
    last(ev, 'action')?.value === 'home', JSON.stringify(ev.slice(afterClick)))
  s.close()
}
{
  // hover（mode 1003 motion，无按键）→ HintChip 的 onMouseEnter → onFocusChange
  const ev: Ev[] = []
  const s = await openLaunchpad(ev)
  await settled(() => findCell(s.term, '模型') !== null)
  const target = findCell(s.term, '模型')!
  const beforeHover = ev.length
  s.input.write(`\u001b[<35;${target.col};${target.row}M`)
  check('C7b 鼠标悬停入口即移焦点（mode 1003，无需点击；模型 = 第 4 条）',
    await settled(() => last(ev, 'focus')?.value === 3), JSON.stringify(ev.slice(beforeHover)))
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
  // 焦点环 = 输入框 + 参数四段 + 画出来的入口（120 列四条全画）。从 -3 再
  // Tab 6 次：-4→-5→0→1→2→3→-1，绕回输入框。
  for (let i = 0; i < 7; i++) await s.send('\t')
  check('C9b Tab 绕完参数行与四条入口回到输入框（-1）',
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
  // 点 Tips 行（普通 Text，没有自己的 onClick）：事件冒泡到根盒才会走 onBlankClick。
  await s.click('输入 / 看全部命令')
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
  // 第四版：入口是纯文字标签，没有键帽键位——任何状态下都不该出现 theme/lang/settings。
  const all = [
    resolveLaunchpadActions({ onboardingPending: true, configProblem: false }),
    resolveLaunchpadActions({ onboardingPending: false, configProblem: true }),
    resolveLaunchpadActions({ onboardingPending: false, configProblem: false, lastSessionTitle: 'x' }),
    resolveLaunchpadActions({ onboardingPending: false, configProblem: false }),
  ].flat()
  const commands = new Set(all.map(a => a.command))
  check('C12 theme/lang/settings 永不在动作表（全状态枚举）',
    !commands.has('theme') && !commands.has('lang') && !commands.has('settings'),
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
  // 第五版呼吸留白：full 默认带 1 行留白；矮一行先撤留白（stage 仍是 full），
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
  // 表驱动回归：每个状态一行，钉死四个位置放什么、为什么（详见 launchpadActions.ts 的优先级表）。
  const rows: readonly { name: string; state: Record<string, unknown>; ids: readonly string[]; commands: readonly string[]; firstLabelKey?: string }[] = [
    { name: '首启（引导未完成）', state: { onboardingPending: true, configProblem: false }, ids: ['setup', 'workspace', 'model', 'help'], commands: ['setup', 'workspace', 'model', 'help'], firstLabelKey: 'launchpad-action-setup' },
    { name: '配置问题（provider 未配）', state: { onboardingPending: false, configProblem: true }, ids: ['setup', 'sessions', 'workspace', 'model'], commands: ['setup', 'home', 'workspace', 'model'], firstLabelKey: 'launchpad-action-setup-provider' },
    { name: '有上次会话', state: { onboardingPending: false, configProblem: false, lastSessionTitle: '修个登录页' }, ids: ['continue', 'sessions', 'workspace', 'model'], commands: ['continue', 'home', 'workspace', 'model'] },
    { name: '常态（无上次会话）', state: { onboardingPending: false, configProblem: false }, ids: ['sessions', 'workspace', 'model', 'help'], commands: ['home', 'workspace', 'model', 'help'] },
    { name: 'Git 项目（有分支）', state: { onboardingPending: false, configProblem: false, lastSessionTitle: 'x', gitBranch: 'main' }, ids: ['continue', 'sessions', 'workspace', 'model'], commands: ['continue', 'home', 'workspace', 'model'] },
    { name: '刚升级（无数据源）', state: { onboardingPending: false, configProblem: false, lastSessionTitle: 'x', justUpgraded: true }, ids: ['continue', 'sessions', 'workspace', 'model'], commands: ['continue', 'home', 'workspace', 'model'] },
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
  const frozen = Object.freeze({ onboardingPending: false, configProblem: false, lastSessionTitle: '冻结标题' })
  const fromFrozen = resolveLaunchpadActions(frozen)
  check('E2 纯函数：不改入参（冻结状态对象直解）',
    fromFrozen.length === 4 && frozen.lastSessionTitle === '冻结标题',
    JSON.stringify(fromFrozen.map(a => a.id)))
  // Continue 带标题：标签键 + 插值；标题超宽截断（含省略号、显示宽度封顶）。
  const titled = resolveLaunchpadActions({ onboardingPending: false, configProblem: false, lastSessionTitle: '修个登录页' })
  check('E3 有上次会话时 Continue 带标题（labelKey = continue-titled，values.title）',
    titled[0]?.labelKey === 'launchpad-action-continue-titled' && titled[0]?.values?.title === '修个登录页',
    JSON.stringify(titled[0]))
  const long = resolveLaunchpadActions({ onboardingPending: false, configProblem: false, lastSessionTitle: '这是一个特别特别特别特别特别长的会话标题' })
  check('E4 超宽标题截断到省略号（宽度 ≤ 上限、尾部是 …）',
    (long[0]?.values?.title ?? '').endsWith('…') && stringWidth(long[0]?.values?.title ?? '') <= LAUNCHPAD_CONTINUE_TITLE_MAX,
    JSON.stringify(long[0]?.values?.title))
  check('E5 truncateContinueTitle 边界：空串/纯空白=空、短串原样、换行折叠',
    truncateContinueTitle('') === '' && truncateContinueTitle('   ') === '' && truncateContinueTitle('短标题') === '短标题'
      && truncateContinueTitle('a\nb') === 'a b',
    JSON.stringify([truncateContinueTitle(''), truncateContinueTitle('短标题'), truncateContinueTitle('a\nb')]))
  // 空标题 = 无历史：落到常态档（没有点了没反应的 Continue）。
  check('E6 lastSessionTitle 为空白 = 无历史（不造 Continue，落常态档）',
    resolveLaunchpadActions({ onboardingPending: false, configProblem: false, lastSessionTitle: '   ' })[0]?.id === 'sessions',
    resolveLaunchpadActions({ onboardingPending: false, configProblem: false, lastSessionTitle: '   ' }).map(a => a.id).join(','))
  // 首启优先于配置问题（引导覆盖面更广，先跑引导）。
  check('E7 首启 × 配置问题同时成立：按首启档（Quick Setup 第一位）',
    resolveLaunchpadActions({ onboardingPending: true, configProblem: true })[0]?.labelKey === 'launchpad-action-setup',
    '')
}
{
  const labels = DEFAULT_ACTIONS.map(a => t(a.labelKey as never, a.values as never))
  const wide = fitChips(labels, COLS)
  const allComplete = wide.every(chip => labels[chip.index] === chip.label)
  check('E8 fitChips 只整条取用，绝不切半个标签（120 列四条全画）', allComplete && wide.length === 4,
    wide.map(c => c.label).join(' | '))
  const narrow = fitChips(['这是一个很长的入口标签'], 8)
  check('E9 放不下就整条不画（不是截断）', narrow.length === 0,
    JSON.stringify(narrow))
  // 48 列：预算 44，四条 zh 标签装不下最后一条（模型）——整条裁掉、不切半。
  const clipped = fitChips(labels, 48)
  check('E9b 48 列裁掉放不下的尾部入口（整条取舍）',
    clipped.length === 3 && clipped.every(c => labels[c.index] === c.label),
    clipped.map(c => c.label).join(' | '))
}

// ── F. 宽度不变量（整屏：任何一行都不超宽、没有切断的半句） ─────────────────
// 旧的「提示行不许出现被切断的半句」升级成整屏不变量：每个键位标签、Tips 文案、
// 参数条要么完整出现在**同一行**，要么整条不出现；任何一行 trim 后 ≤ 列数。
// 半句检测用**渲染后的形态**：键帽文本 ` /key ` + 分隔空格 + 标签，键与标签
// 之间是两个空格（键帽右内边距一格 + 分隔一格）。
const CHIP_LABELS = DEFAULT_ACTIONS.map(a => t(a.labelKey as never, a.values as never))
const TIP_TEXTS = [t('launchpad-tip' as never), t('launchpad-first-run' as never)]
for (const cols of [120, 100, 72, 60, 48]) {
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { columns: cols })
  await settled(() => s.screen().trim().length > 0)
  const lines = viewportLines(s.term)
  const overflow = lines.map((l, i) => ({ w: stringWidth(l.replace(/\s+$/u, '')), i }))
    .filter(x => x.w > cols)
  check(`F1@${cols} 整屏不变量：任何一行都不超宽`, overflow.length === 0,
    overflow.map(x => `row=${x.i} w=${x.w}`).join(' '))
  // 半句检测：标签/文案的前半出现在屏上、却找不到完整串 = 被切断。
  // 参数行按**段**判（模型/思考深度/模式/权限）：窄屏下尾部段按宽度省掉是
  // 契约行为（launchpadLayout 的单行预算），整句判据会把合法省段误判成切断。
  const PARAM_SEGMENTS = ['glm-5.3', 'Max', 'Execute', 'default']
  const wholes = [...CHIP_LABELS, ...TIP_TEXTS, ...PARAM_SEGMENTS]
  const cut = wholes.filter(text => {
    const half = text.slice(0, Math.ceil(text.length / 2))
    const onScreen = lines.some(l => l.includes(half))
    const whole = lines.some(l => l.includes(text))
    return onScreen && !whole
  })
  check(`F2@${cols} 没有被切断的半句（标签/Tips/参数条要么完整要么不出现）`, cut.length === 0,
    cut.join(' | '))
  s.close()
}

// ── G. 第四版专项：裁剪后仍右对齐、行高恒 1、自动闪烁、占位左对齐 ─────────
{
  // 48 列：fitChips 裁掉"模型"，剩下三条**仍然右对齐输入框右缘**。
  const ev: Ev[] = []
  const s = await openLaunchpad(ev, { columns: 48 })
  await settled(() => s.screen().includes('历史会话'))
  const lines = viewportLines(s.term)
  const hintRow = lines.find(l => l.includes(CONTINUE_LABEL)) ?? ''
  const cardRow = lines.find(l => l.includes('╭')) ?? ''
  const cardLeft = leftGap(cardRow)
  const cardWidth = Math.max(24, Math.min(48 - 4, 72))
  check('G1 入口被裁掉后整行仍右对齐（行尾 = 卡片右缘 ±1，且被裁的不画半句）',
    hintRow !== '' && !hintRow.includes('模型') && Math.abs(stringWidth(hintRow.replace(/\s+$/u, '')) - (cardLeft + cardWidth)) <= 1,
    `rowEnd=${stringWidth(hintRow.replace(/\s+$/u, ''))} cardRight=${cardLeft + cardWidth} ${hintRow.trim()}`)
  check('G2 裁剪后行高仍恒 1（三个入口同在一行、各只出现一次）',
    rowHasAll(hintRow, [CONTINUE_LABEL, '历史会话', '工作区'])
      && lines.filter(l => l.includes(CONTINUE_LABEL)).length === 1
      && lines.filter(l => l.includes('历史会话')).length === 1,
    hintRow.trim())
  s.close()
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
  // 占位左对齐（第四版）：紧跟 ❯ + 块状光标之后；有输入时消失。
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
  // 首启/配置问题的条件按钮真的渲染（onboarding 完成且配置正常后永久消失）。
  const first = await openLaunchpad([], { firstRun: true, actions: resolveLaunchpadActions({ onboardingPending: true, configProblem: false }) })
  check('G6 首启：Quick Setup 是第一位入口（引导完成后不再出现）',
    await settled(() => first.screen().includes('快速配置')
      && (viewportLines(first.term).find(l => l.includes('快速配置')) ?? '').includes('工作区')),
    first.screen().slice(0, 100))
  first.close()
  const broken = await openLaunchpad([], { actions: resolveLaunchpadActions({ onboardingPending: false, configProblem: true }) })
  check('G7 配置问题：Set up provider 是第一位入口（其余三位不变）',
    await settled(() => broken.screen().includes('配置 provider')
      && (viewportLines(broken.term).find(l => l.includes('配置 provider')) ?? '').includes('历史会话')),
    broken.screen().slice(0, 100))
  broken.close()
  const evn: Ev[] = []
  const normal = await openLaunchpad(evn)
  check('G8 常态：没有 setup 条件按钮（onboarding 完成且配置正常 → 永久消失）',
    await settled(() => !normal.screen().includes('快速配置') && !normal.screen().includes('配置 provider')),
    normal.screen().slice(0, 100))
  normal.close()
}

// ── H. 第五版专项：参数行四段可点 + 选择器盖在落地页之上 ─────────────────
{
  // 键盘路径（仓库硬规矩：每个可点目标都要有键盘路径）：↓ 走到段、Enter 打开。
  const cases: [string, number][] = [['model', 1], ['effort', 2], ['mode', 3], ['permission', 4]]
  for (const [segment, downs] of cases) {
    const ev: Ev[] = []
    const s = await openLaunchpad(ev)
    for (let i = 0; i < downs; i++) await s.send('\u001b[B')
    await s.send('\r')
    check('H1 Enter 打开 ' + segment + ' 段（键盘路径；环顺序 模型→深度→模式→权限）',
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
  for (const needle of ['glm-5.3', 'Max', 'Execute', 'default']) {
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
  // 第六版呼吸也撤干净：紧凑档下词标→输入框回到 1 行留白、入口行→Tips 回到
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

if (failures === 0) console.log(`\nverify-launchpad: ${checks} checks, all passed`)
else console.error(`\nverify-launchpad: ${failures} of ${checks} checks FAILED`)
process.exit(failures === 0 ? 0 : 1)