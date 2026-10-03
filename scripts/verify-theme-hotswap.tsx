/**
 * 主题热切换 → 正文重绘回归（U-5 链接色）。
 *
 * markdown 把主题色**烤进 ANSI 字符串**（链接 accent 走 `createHyperlink` 的默认
 * style，读 `getActiveTheme()`），于是「换主题后已渲染的正文要跟着变色」需要两条
 * 前提同时成立：
 *   1. `Markdown` 的 `React.memo` 必须因换主题而失效——context 更新绕过 memo，
 *      所以组件要真的消费主题上下文；
 *   2. `ThemeProvider` 的模块级镜像必须在**渲染期**写入，早于同一次提交里子组件
 *      的渲染；写进 `useEffect` 会晚一帧，烤出来的是上一个主题的颜色。
 * 任一条缺失，真机表现都是「切换主题后链接色不变，重启才更新」（其余三类 chrome
 * 都是即时更新，所以只有链接显得卡住）。
 *
 * oracle：真实渲染器画进 xterm，读链接标签格的 fg；同时钉住**第一次**上屏的
 * 链接 SGR，防止「首帧烤上一主题、靠异步 state 更新纠正」这类假绿灯。
 *
 * 最后一段换成**运行时同名重注册**：插件在同一批里释放、再用同一个
 * 名字注册，名字不变而 resolver 已经换了新色板——Provider 的 context value
 * 必须跟着色板身份走，正文才会重绘。这一段挂真实 Cordis `TuiThemeRuntime`。
 *
 * Run: node --import tsx/esm scripts/verify-theme-hotswap.tsx
 */
import './lib/fake-home.mjs'
import type { Context } from '@deepseek-ai/cordis'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
// 让 createHyperlink 走 OSC 8 路径：不支持超链接的终端只显示 URL，标签不上屏。
process.env.TERM_PROGRAM = 'kitty'
process.env.FORCE_HYPERLINK = '1'
delete process.env.TMUX

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { Markdown }, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/Markdown.js'),
  import('./lib/term-test.mjs'),
])
const { render, ThemeProvider, Box, Text, useTheme } = ui
const { settled, viewportLines } = termTest

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra === '' ? '' : `  (${extra})`}`)
  if (!ok) failures++
}

/** light 的 accent（`#3F6CC4`）：真彩 SGR → xterm 报 0x3f6cc4。 */
const LIGHT_ACCENT = 0x3f6cc4
const LIGHT_SGR = '\u001b[38;2;63;108;196m'
/** dark-ansi 的 accent 是 `ansi:blueBright`（SGR 94）→ xterm 报 16 色索引 12。 */
const DARK_ANSI_ACCENT = 12
/** 只有 OSC 8 可用的终端才显示标签文本，链接就在这一格里测颜色。 */
const LINK = '[label](https://example.com/x)'
/** 运行时注册的主题名（phase 2）：不带静态文件主题前缀，避免与用户目录撞名。 */
const RUNTIME_THEME = 'probe:hotswap'

const term = new XTerm({ cols: 90, rows: 20, allowProposedApi: true })
const frames: string[] = []
class FakeStdout extends Writable {
  isTTY = true
  override _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void {
    frames.push(String(chunk))
    term.write(String(chunk), cb)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  override _write(_c: unknown, _e: BufferEncoding, cb: () => void): void {
    cb()
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  isRaw = false
  setRawMode(next: boolean): this {
    this.isRaw = next
    return this
  }
  override setEncoding(): this {
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
}

const findText = (text: string): { col: number; row: number } | null => {
  const lines = viewportLines(term)
  for (let row = 0; row < lines.length; row++) {
    const col = lines[row]!.indexOf(text)
    if (col >= 0) return { col, row }
  }
  return null
}
const fgAt = (text: string): number | 'missing' => {
  const pos = findText(text)
  if (pos === null) return 'missing'
  const cell = term.buffer.active.getLine(term.buffer.active.baseY + pos.row)?.getCell(pos.col)
  return cell === undefined || cell.isFgDefault() ? 'missing' : cell.getFgColor()
}
const themeLine = (): string =>
  (viewportLines(term).find(line => line.includes('theme=')) ?? '').trim()

/** 第一次上屏的链接标签及其前景 SGR——首帧就烤错主题时这里会露馅。
 *  取 `label` 在帧流里**第一次**出现的位置，与紧邻其前的**那一条** SGR 拼起来：
 *  不分真彩还是 16 色。只认真彩的写法会被「首帧发 ANSI 蓝、后续重绘才是真彩
 *  accent」骗过去——等待条件与断言都会落在后面的重绘上，正是这条门禁要防的
 *  首帧错误。只取紧邻的一条，不吞掉更早的 reset，否则正确首帧会被拼成
 *  `\e[0m\e[38;2;…m` 而假红。 */
const firstLinkSgr = (): string => {
  const joined = frames.join('')
  const at = joined.indexOf('label')
  if (at < 0) return ''
  const sgr = /\u001b\[[0-9;]*m$/.exec(joined.slice(0, at))?.[0]
  return sgr === undefined ? '' : `${sgr}label`
}

const setThemeRef: { current: ((name: string) => boolean) | null } = { current: null }
function Fixture(): React.ReactNode {
  const [themeName, setTheme] = useTheme()
  React.useEffect(() => {
    setThemeRef.current = setTheme
  }, [setTheme])
  return (
    <Box flexDirection="column">
      <Text>{`theme=${themeName}`}</Text>
      <Markdown>{LINK}</Markdown>
    </Box>
  )
}

const app = await render(<ThemeProvider theme="light"><Fixture /></ThemeProvider>, {
  stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
  stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
  stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
  exitOnCtrlC: false,
  patchConsole: false,
})

try {
  const painted = await settled(() => fgAt('label') === LIGHT_ACCENT)
  check('首帧链接色 = 当前主题 accent（不是上一主题）',
    painted && firstLinkSgr() === `${LIGHT_SGR}label`,
    `first=${JSON.stringify(firstLinkSgr())} ${themeLine()}`)

  const beforeSwitch = frames.length
  setThemeRef.current?.('dark-ansi')
  const switched = await settled(() => fgAt('label') === DARK_ANSI_ACCENT)
  // 只扫切换后追加的帧：整轮里含 phase-1 的 light 帧，`includes` 扫全量会被
  // 无关帧满足。这条承重的是 `switched`，SGR 断言必须同源。
  check('切到 dark-ansi 后链接重绘为 16 色亮蓝（94m）',
    switched && frames.slice(beforeSwitch).join('').includes('\u001b[94m'),
    `fg=${fgAt('label')} ${themeLine()}`)

  setThemeRef.current?.('light')
  const back = await settled(() => fgAt('label') === LIGHT_ACCENT)
  check('再切回 light 仍重绘（不是一次性）', back, `fg=${fgAt('label')} ${themeLine()}`)

  // ── 运行时同名重注册 ──────────────────────────────────────────────────
  // 插件在同一批里先释放、再注册**同名**主题：名字不变，resolver 已经换了一个
  // 新色板对象（themes.ts 每次注册都新建并冻结）。Provider 的 context value
  // 必须跟着色板身份换，否则按色板身份 memo 的正文（Markdown）根本不重渲染，
  // 屏幕停在旧色——切到别的主题再切回来才刷新。
  const [{ Context }, { TuiThemeRuntime, getHostThemes }] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('../src/dsh-adapter/themes.js'),
  ])
  const root = new Context()
  await root.plugin(TuiThemeRuntime)
  const host = getHostThemes(root.get('tuiThemes'))
  if (host === undefined) throw new Error('tuiThemes host did not mount')
  let pluginContext: Context | undefined
  await root.plugin({
    name: 'hotswap-probe',
    inject: ['tuiThemes'],
    apply: (context: Context) => { pluginContext = context },
  })
  const registerAccent = (accent: string): (() => void) =>
    pluginContext!.tuiThemes.register({ name: RUNTIME_THEME, base: 'dark', colors: { accent } }, pluginContext)
  const disposeRed = registerAccent('#CC0000')
  // 清屏后另起一个带 host 的 app：phase 1 留在屏幕上的 'label' 不能被 findText 找到。
  term.reset()
  const app2 = await render(
    <ThemeProvider theme={RUNTIME_THEME} themeHost={host}><Fixture /></ThemeProvider>,
    {
      stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  try {
    check('运行时主题：链接按注册色板上屏',
      await settled(() => fgAt('label') === 0xcc0000), `fg=${fgAt('label')}`)
    disposeRed()
    registerAccent('#00CC00')
    check('同名重注册（同批释放+注册）后正文重绘为新色板',
      await settled(() => fgAt('label') === 0x00cc00), `fg=${fgAt('label')}`)
  } finally {
    app2.unmount()
    await root.fiber.dispose()
  }
} finally {
  app.unmount()
  term.dispose()
}

if (failures > 0) {
  console.error(`\nverify-theme-hotswap: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nall theme hot-swap checks passed')
