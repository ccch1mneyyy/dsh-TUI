/**
 * verify-theme-preview — `/theme` 右列预览面板的行为契约。
 *
 * 面板本身很简单，容易在三种地方悄悄退化，所以逐条钉死：
 *
 *   A. 宽终端（≥76 列）预览列与主题列表**同行**并排；焦点主题名出现在预览抬头上。
 *   B. 预览抹的是**焦点行**主题的调色板，不是当前生效主题：焦点在 probe-a 时
 *      屏上出现 probe-a 的工具卡底色/diff 色、不出现 probe-b 的，反之亦然。
 *   C. 窄终端（<76 列）预览**堆叠在列表下方**：预览行号大于列表最后一行，
 *      列表与预览都仍在屏上。
 *   D. 高度预算不够时预览整体让位，主题列表与焦点行仍完整可见——浮层向上
 *      生长，宁可少画预览，也不能把列表顶出可视区。
 *   E. 既有行为不回退：列表标题与 Enter/Esc 提示仍在。
 *
 * 夹具：HOME 指向临时目录，写入两个静态主题（probe-a/probe-b），身份键取
 * 不可能与内置主题撞车的 hex；断言落在真机 SGR 上（38;2/48;2 三元组），
 * 身份键刻意避开 accent/text/success——那三个色块在**每一行**列表里都会出现，
 * 拿它们做"焦点主题"的证据会假阳性。
 *
 * 运行：node --import tsx/esm scripts/verify-theme-preview.tsx
 */
process.env.FORCE_COLOR = '3'

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import chalk from 'chalk'

// ESM 静态 import 先于顶部 env 赋值求值——chalk 在 NO_COLOR 环境里会以 level 0
// 载入，applyTextStyles 剥掉全部 SGR，色值断言必然假阴性（verify-overlay-occlusion 同款）。
chalk.level = 3
// 终端图像探针只会在帧里多出与本次契约无关的涂底，先关掉。
delete process.env.TMUX
delete process.env.STY
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'

/**
 * 两个静态主题：accent/text/success 进列表色块，其余键是预览列的身份证据。
 * 身份键刻意避开 toolCardBackground：默认 `toolBackground: 'none'`，真机工具卡
 * **不涂底**——预览要还原默认外观，涂底反而是在展示一个默认看不到的色（见 G 组）。
 */
const PROBE_A = {
  name: 'probe-a',
  displayName: 'Probe A',
  base: 'dark',
  colors: {
    accent: '#abcdef',
    text: '#b1b2b3',
    success: '#c1c2c3',
    toolCardBackground: '#0f0e0d',
    diffAddedWord: '#12ab34',
    diffRemovedWord: '#ab1234',
    toolDotWrite: '#5a5b5c',
    toolNameMutate: '#6d6e6f',
  },
} as const

const PROBE_B = {
  name: 'probe-b',
  displayName: 'Probe B',
  base: 'light',
  colors: {
    accent: '#fedcba',
    text: '#d1d2d3',
    success: '#e1e2e3',
    toolCardBackground: '#1f1e1d',
    diffAddedWord: '#56cd78',
    diffRemovedWord: '#cd5678',
    toolDotWrite: '#7a7b7c',
    toolNameMutate: '#8d8e8f',
  },
} as const

const home = mkdtempSync(join(tmpdir(), 'dshtui-theme-preview-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
const themeDir = join(home, '.dsh-tui', 'themes')
mkdirSync(themeDir, { recursive: true })
for (const probe of [PROBE_A, PROBE_B]) {
  writeFileSync(join(themeDir, `${probe.name}.json`), JSON.stringify(probe))
}

const [
  { ThemePicker, getThemeOptions },
  { ThemeProvider },
  { TerminalSizeContext },
  { setLang },
  { getTheme },
  { render },
  { renderToScreen },
  { settled, viewportLines, writeParsed },
] = await Promise.all([
  import('../src/components/ThemePicker.js'),
  import('../src/components/design-system/ThemeProvider.js'),
  import('../src/ink/components/TerminalSizeContext.js'),
  import('../src/i18n.js'),
  import('../src/theme.js'),
  import('../src/ui.js'),
  import('../src/ink/render-to-screen.js'),
  import('./lib/term-test.mjs'),
])

// @xterm/headless 的 CJS 互操作没有具名 ESM 导出——仓库脚本一律动态 import。
const { Terminal: XTerm } = await import('@xterm/headless')

// 独立执行的回归不能依赖 CI 的 DSH_TUI_LANG 兜底，显式钉住语言。
setLang('zh')

let failures = 0
function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`ok   ${name}`)
    return
  }
  failures++
  console.error(`FAIL ${name}`)
  console.error(`      ${detail}`)
}

class FakeStdout extends Writable {
  columns: number
  rows: number
  isTTY = true
  output = ''
  term: InstanceType<typeof XTerm>
  /** xterm 异步分块解析的落盘链：读屏前必须先等它排空。 */
  private parsed: Promise<void> = Promise.resolve()

  constructor(columns: number, rows: number, term: InstanceType<typeof XTerm>) {
    super()
    this.columns = columns
    this.rows = rows
    this.term = term
  }

  _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void {
    const text = String(chunk)
    this.output += text
    this.parsed = this.parsed.then(() => writeParsed(this.term, text))
    cb()
  }

  flush(): Promise<void> {
    return this.parsed
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void): void {
    cb()
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  isRaw = false
  setRawMode(): this {
    return this
  }
  override ref(): this {
    return this
  }
  override unref(): this {
    return this
  }
}

/** 一个 hex 色的前景/背景 SGR 三元组（38;2 / 48;2 都算"画出来了"）。 */
function triples(hex: string): string[] {
  const match = /^#([0-9a-f]{6})$/iu.exec(hex.trim())
  if (match === null) return []
  const value = Number.parseInt(match[1]!, 16)
  const r = (value >> 16) & 0xff
  const g = (value >> 8) & 0xff
  const b = value & 0xff
  return [`38;2;${r};${g};${b}`, `48;2;${r};${g};${b}`]
}

function painted(output: string, hex: string): boolean {
  return triples(hex).some(triple => output.includes(triple))
}

/** 面板的自然高度（yoga 布局，与真机同一套）：用来验证它装得进浮层高度预算。 */
function panelHeight(columns: number, rows: number, focusIndex: number): number {
  return renderToScreen(
    <ThemeProvider theme="light">
      <TerminalSizeContext.Provider value={{ columns, rows }}>
        <ThemePicker focusIndex={focusIndex} currentTheme="light" />
      </TerminalSizeContext.Provider>
    </ThemeProvider>,
    columns,
  ).height
}

type Screen = {
  lines: string[]
  output: string
  rowOf: (text: string) => number
}

/** 在给定终端尺寸下渲染一次 /theme 面板，返回真机屏幕与原始 SGR 流。 */
async function screenAt(columns: number, rows: number, focusIndex: number): Promise<Screen> {
  const term = new XTerm({ cols: columns, rows, allowProposedApi: true })
  const stdout = new FakeStdout(columns, rows, term)
  const stdin = new FakeStdin()
  const tree = (
    <ThemeProvider theme="light">
      <TerminalSizeContext.Provider value={{ columns, rows }}>
        <ThemePicker focusIndex={focusIndex} currentTheme="light" />
      </TerminalSizeContext.Provider>
    </ThemeProvider>
  )
  const instance = await render(tree, {
    stdin,
    stdout,
    stderr: new FakeStderr(),
    exitOnCtrlC: false,
    patchConsole: false,
  })
  instance.rerender(tree)
  // 面板标题是"这一帧已经画出来"的锚点；色值断言之前先等它出现。
  const paintedTitle = await settled(() => stdout.output.includes(LIST_TITLE))
  await stdout.flush()
  const lines = paintedTitle ? viewportLines(term, rows) : []
  const output = stdout.output
  stdout.isTTY = false
  instance.unmount()
  return {
    lines,
    output,
    rowOf: (text: string) => lines.findIndex(line => line.includes(text)),
  }
}

const LIST_TITLE = '颜色主题'
const PREVIEW_TITLE = '主题预览'
const HINT = 'Enter 确认'
const WIDE_COLUMNS = 110
const WIDE_ROWS = 40
const NARROW_COLUMNS = 70
const NARROW_ROWS = 40
const THRESHOLD_COLUMNS = 76
const ACTIVE_THEME = 'light'

const options = getThemeOptions()
const indexA = options.findIndex(option => option.value === PROBE_A.name)
const indexB = options.findIndex(option => option.value === PROBE_B.name)
const activeToolDot = getTheme(ACTIVE_THEME).toolDotWrite

check(
  'fixture: 两个静态探针主题已进入目录',
  indexA >= 0 && indexB >= 0,
  `probe-a=${indexA} probe-b=${indexB}（HOME=${home}）`,
)

// --- A/B: 宽终端并排，且跟随焦点行 ----------------------------------------
{
  const screen = await screenAt(WIDE_COLUMNS, WIDE_ROWS, indexA)
  const previewRow = screen.rowOf(PREVIEW_TITLE)
  const listRow = screen.rowOf(LIST_TITLE)
  check(
    'A1 宽终端出现预览抬头',
    previewRow >= 0,
    `未找到「${PREVIEW_TITLE}」；屏幕：\n${screen.lines.join('\n')}`,
  )
  check(
    'A2 宽终端预览与列表同行（并排）',
    previewRow >= 0 && previewRow === listRow,
    `previewRow=${previewRow} listRow=${listRow}`,
  )
  check(
    'A3 预览抬头带焦点主题名',
    screen.lines[previewRow]?.includes(PROBE_A.displayName) === true,
    `第 ${previewRow} 行：${screen.lines[previewRow] ?? '<无>'}`,
  )
  // 文本一律读视口（纯文本），不读原始 SGR 流：提示行 `**Enter** 确认` 的
  // 加粗会在 "Enter" 与 " 确认" 之间插一个 SGR reset，字符串包含判断必然假阴性。
  check(
    'A4 既有列表与提示仍在',
    screen.rowOf(LIST_TITLE) >= 0 && screen.rowOf(HINT) >= 0,
    `listRow=${screen.rowOf(LIST_TITLE)} hintRow=${screen.rowOf(HINT)}`,
  )
  check(
    'B1 预览用焦点主题的工具卡点色',
    painted(screen.output, PROBE_A.colors.toolDotWrite),
    `未出现 ${PROBE_A.colors.toolDotWrite} 的 38;2/48;2`,
  )
  check(
    'B2 预览用焦点主题的 diff 增行色',
    painted(screen.output, PROBE_A.colors.diffAddedWord),
    `未出现 ${PROBE_A.colors.diffAddedWord} 的 38;2/48;2`,
  )
  check(
    'B3 预览不抹另一主题的色',
    !painted(screen.output, PROBE_B.colors.toolDotWrite) &&
      !painted(screen.output, PROBE_B.colors.diffAddedWord),
    `出现了 probe-b 的 ${PROBE_B.colors.toolDotWrite}/${PROBE_B.colors.diffAddedWord}`,
  )
  check(
    'B4 预览不抹当前生效主题的色',
    !painted(screen.output, activeToolDot),
    `出现了 ${ACTIVE_THEME} 的 ${activeToolDot}`,
  )
  check(
    'B5 工具卡还原默认外观：不涂 toolCardBackground 底色',
    !painted(screen.output, PROBE_A.colors.toolCardBackground),
    `出现了 ${PROBE_A.colors.toolCardBackground} 的底色——默认 toolBackground 是 none，真机卡片不涂底`,
  )
  check(
    'A5 预览画出了代码块与工具卡正文',
    screen.lines.some(line => line.includes("const theme = pick('dark')")) &&
      screen.lines.some(line => line.includes('src/theme.ts')),
    `代码行=${screen.lines.some(line => line.includes('const theme = pick'))} 工具卡=${screen.lines.some(line => line.includes('src/theme.ts'))}`,
  )
}

// --- B6: 焦点移到另一行，预览跟着换色 --------------------------------------
{
  const screen = await screenAt(WIDE_COLUMNS, WIDE_ROWS, indexB)
  check(
    'B6 焦点换行后预览改用新主题的色',
    painted(screen.output, PROBE_B.colors.toolDotWrite) &&
      painted(screen.output, PROBE_B.colors.diffAddedWord) &&
      !painted(screen.output, PROBE_A.colors.toolDotWrite),
    `probe-b 出现=${painted(screen.output, PROBE_B.colors.toolDotWrite)} probe-a 出现=${painted(screen.output, PROBE_A.colors.toolDotWrite)}`,
  )
}

// --- C: 窄终端堆叠在列表下方 ----------------------------------------------
{
  const screen = await screenAt(NARROW_COLUMNS, NARROW_ROWS, indexA)
  const previewRow = screen.rowOf(PREVIEW_TITLE)
  const hintRow = screen.rowOf(HINT)
  check(
    'C1 窄终端预览仍在（堆叠）',
    previewRow >= 0 && hintRow >= 0,
    `previewRow=${previewRow} hintRow=${hintRow}`,
  )
  check(
    'C2 窄终端预览在列表最后一行之下',
    previewRow > hintRow && hintRow >= 0,
    `previewRow=${previewRow} hintRow=${hintRow}`,
  )
}

// --- E: 阈值 76 列两侧的行为分界 -------------------------------------------
{
  const below = await screenAt(THRESHOLD_COLUMNS - 1, WIDE_ROWS, indexA)
  const at = await screenAt(THRESHOLD_COLUMNS, WIDE_ROWS, indexA)
  check(
    `E1 ${THRESHOLD_COLUMNS - 1} 列仍是堆叠`,
    below.rowOf(PREVIEW_TITLE) > below.rowOf(LIST_TITLE),
    `previewRow=${below.rowOf(PREVIEW_TITLE)} listRow=${below.rowOf(LIST_TITLE)}`,
  )
  check(
    `E2 ${THRESHOLD_COLUMNS} 列起并排`,
    at.rowOf(PREVIEW_TITLE) >= 0 && at.rowOf(PREVIEW_TITLE) === at.rowOf(LIST_TITLE),
    `previewRow=${at.rowOf(PREVIEW_TITLE)} listRow=${at.rowOf(LIST_TITLE)}`,
  )
}

// --- D: 高度预算不够时预览让位，列表不受影响 ------------------------------
{
  const screen = await screenAt(NARROW_COLUMNS, 14, indexA)
  check(
    'D1 预算不足时预览整体不画',
    screen.rowOf(PREVIEW_TITLE) < 0,
    `第 ${screen.rowOf(PREVIEW_TITLE)} 行仍有预览抬头`,
  )
  check(
    'D2 列表与焦点行不受预览让位影响',
    screen.rowOf(HINT) >= 0 && screen.lines.some(line => line.includes(PROBE_A.displayName)),
    `hintRow=${screen.rowOf(HINT)} 焦点行在屏=${screen.lines.some(line => line.includes(PROBE_A.displayName))}`,
  )
}

// --- F: 预览不得把面板顶出浮层高度预算 ------------------------------------
// OverlayAbove 给面板的预算是 terminalRows - 8（聊天浮层给 composer/状态行留的
// 行数）；面板比它高时，超出的部分从**顶部**被裁掉——被裁的正是主题列表。
// 列表本身占 2 行/项（label + 描述），6 项 12 行，堆叠布局必须先把它算掉，
// 否则窄终端上"多出来的预览"会把列表顶出屏幕。
{
  for (const columns of [NARROW_COLUMNS, WIDE_COLUMNS]) {
    for (const rows of [30, 34, 40, 44]) {
      const height = panelHeight(columns, rows, indexA)
      check(
        `F ${columns}×${rows} 面板装得进预算`,
        height <= rows - 8,
        `面板 ${height} 行 > 预算 ${rows - 8} 行`,
      )
    }
  }
  // 反过来：预算真的够时预览必须在——否则上面四条可以靠"永不画预览"骗过。
  const roomy = await screenAt(NARROW_COLUMNS, 44, indexA)
  check(
    'F5 预算充足时窄终端确实画出堆叠预览',
    roomy.rowOf(PREVIEW_TITLE) > roomy.rowOf(LIST_TITLE),
    `previewRow=${roomy.rowOf(PREVIEW_TITLE)} listRow=${roomy.rowOf(LIST_TITLE)}`,
  )
}

rmSync(home, { recursive: true, force: true })

if (failures > 0) {
  console.error(`verify-theme-preview: ${failures} 处失败`)
  process.exit(1)
}
console.log('✓ verify-theme-preview: 并排/堆叠、焦点跟随、预算让位与既有行为全部符合契约')
assert.ok(true)
