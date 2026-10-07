/**
 * claude 品牌档（Claude 后端）契约，见 `src/branding.ts`：
 * ① 信号解析：backendId（'claude' → claude，'dsh'/空/acp:* → deepseek）；
 *    设置项合成（env > 显式锁定 > auto 跟后端）；归一化（垃圾 → auto）；
 * ② 词表：deepseek = DEEPSEEK/HARNESS/'DeepSeek Harness'，claude = CLAUDE/CODE/'Claude Code'；
 * ③ 内置 `claude` 主题：关键锚点色（品牌橙/暖褐衬底/语义色不动）、进 THEME_NAMES、
 *    与 `dark` 是两套身份；ThemeProvider 的品牌默认档：prop/env 显式与
 *    `/theme` 手选锁定，**启动持久化偏好不锁定**（切品牌联动要能压过历史
 *    的 theme.json）；
 * ④ LogoV2 品牌分支：挂真组件读屏——CLAUDE/CODE 两行上屏（deepseek 档照旧
 *    DEEPSEEK/HARNESS）、Claude 娘字符画在**不看 whaleGirl 设置**的情况下占住
 *    立绘槽（协议不可用时的回落路径）、彩蛋日上排钉 CLAUDE、窄终端纯文字档
 *    是 'Claude Code'；
 * ⑤ bevel 的静态灰阶已拆除（配色随主题派生——修复"灰色字体"）。
 * Run: node --import tsx/esm scripts/verify-splash-brand.tsx
 */
// 隔离用户级偏好：ThemeProvider 的强制链读 ~/.dsh-tui/theme.json，usageStats
// 写 ~/.dsh-tui/——指到空临时目录，测试不受本机配置影响也不污染本机计数。
// （os.homedir 在 win32 读 USERPROFILE、posix 读 HOME，调用期生效。）
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const sandboxHome = mkdtempSync(join(tmpdir(), 'dsh-tui-brand-verify-'))
process.env.USERPROFILE = sandboxHome
process.env.HOME = sandboxHome
delete process.env.DSH_TUI_THEME
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'
delete process.env.DSH_TUI_BRAND

const [
  React,
  { PassThrough, Writable },
  { brandOfBackend, resolveBrand, normalizeBrandSetting, BRAND_SPLASH_WORDS, BRAND_SETTING_VALUES, setActiveBrand, getActiveBrand },
  { getTheme, isThemeAvailable, isLightThemeActive, THEME_NAMES },
  { render, ThemeProvider, useTheme },
  { LogoV2 },
  { paintedWidth, renderBigText },
  { splashFontById, withTagline, SPLASH_FONTS },
  { CLAUDE_GIRL_ROWS },
  { renderToScreen },
  { cellAt },
  { TerminalSizeContext },
  { settle },
] = await Promise.all([
  import('react'),
  import('node:stream'),
  import('../src/branding.js'),
  import('../src/theme.js'),
  import('../src/ui.js'),
  import('../src/components/LogoV2.js'),
  import('../src/components/bigfont.js'),
  import('../src/components/splashFonts.js'),
  import('../src/components/ClaudeGirl.js'),
  import('../src/ink/render-to-screen.js'),
  import('../src/ink/screen.js'),
  import('../src/ink/components/TerminalSizeContext.js'),
  import('./lib/term-test.mjs'),
])

// 剥 ANSI：除了以 m 结尾的 SGR，还要吃掉行尾的 \x1b[K（erase-line）——
// 精灵行的渲染产物带它，漏剥会让 includes 的 needle 混入不可见控制符。
const SGR = /\x1b\[[0-9;]*[A-Za-z]/g
const strip = (row: string): string => row.replace(SGR, '')

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`)
  if (!ok) failed += 1
}

// ── ① 信号解析 ────────────────────────────────────────────────────────────
check('backendId：claude → claude', brandOfBackend('claude') === 'claude')
check('Codex auto resolves the codex brand', brandOfBackend('codex') === 'codex' && resolveBrand('auto', 'codex') === 'codex')
check('Codex is an explicit brand setting (lavender tier)', normalizeBrandSetting('codex') === 'codex' && BRAND_SETTING_VALUES.includes('codex'))
check('Explicit existing brands still override Codex', resolveBrand('deepseek', 'codex') === 'deepseek' && resolveBrand('claude', 'codex') === 'claude')
check('Codex title words, without a new font', BRAND_SPLASH_WORDS.codex.top === 'CODEX' && BRAND_SPLASH_WORDS.codex.bottom === 'HARNESS' && BRAND_SPLASH_WORDS.codex.plain === 'Codex' && SPLASH_FONTS.every(font => font.glyphs.X.length === 5 && font.glyphs.X.every(row => row.length === font.glyphWidth)))
check('backendId：dsh/空/acp:* → deepseek', ['dsh', undefined, '', 'acp:gemini', 'claude-code'].every(id => brandOfBackend(id) === 'deepseek'), 'claude-code 是 product 名，不是 backendId')
check('resolveBrand：auto 跟后端', resolveBrand('auto', 'claude') === 'claude' && resolveBrand('auto', 'dsh') === 'deepseek' && resolveBrand(undefined, 'claude') === 'claude')
check('resolveBrand：显式锁定压过后端', resolveBrand('deepseek', 'claude') === 'deepseek' && resolveBrand('claude', 'dsh') === 'claude')
check('normalizeBrandSetting：合法值透传、垃圾回落 auto',
  BRAND_SETTING_VALUES.every(v => normalizeBrandSetting(v) === v) && normalizeBrandSetting('junk') === 'auto' && normalizeBrandSetting(undefined) === 'auto' && normalizeBrandSetting(42) === 'auto')
try {
  process.env.DSH_TUI_BRAND = 'claude'
  check('DSH_TUI_BRAND=claude 强制生效（dsh 后端 + 显式 deepseek 也被覆盖）', resolveBrand('deepseek', 'dsh') === 'claude')
  process.env.DSH_TUI_BRAND = 'deepseek'
  check('DSH_TUI_BRAND=deepseek 强制生效（claude 后端也被覆盖）', resolveBrand(undefined, 'claude') === 'deepseek')
} finally {
  delete process.env.DSH_TUI_BRAND
}

// ── ② 词表 ────────────────────────────────────────────────────────────────
check('deepseek 词表', BRAND_SPLASH_WORDS.deepseek.top === 'DEEPSEEK' && BRAND_SPLASH_WORDS.deepseek.bottom === 'HARNESS' && BRAND_SPLASH_WORDS.deepseek.plain === 'DeepSeek Harness')
check('claude 词表', BRAND_SPLASH_WORDS.claude.top === 'CLAUDE' && BRAND_SPLASH_WORDS.claude.bottom === 'CODE' && BRAND_SPLASH_WORDS.claude.plain === 'Claude Code')

// ── ③ claude 双主题 ───────────────────────────────────────────────────────
const claudeDark = getTheme('claude-dark')
const claudePaper = getTheme('claude-paper')
check('陶土橙品牌槽（dark #D77757 / paper #C96442）',
  claudeDark.accent === 'rgb(215,119,87)' && claudePaper.accent === 'rgb(201,100,66)',
  `${claudeDark.accent} / ${claudePaper.accent}`)
check('面板墨黑阶（dark）/ 纸张阶（paper）',
  claudeDark.toolCardBackground === 'rgb(36,34,31)' && claudePaper.toolCardBackground === 'rgb(255,253,248)',
  `${claudeDark.toolCardBackground} / ${claudePaper.toolCardBackground}`)
check('文字三档黑白灰（dark 奶油白 / paper 墨黑）',
  claudeDark.text === 'rgb(244,241,234)' && claudeDark.inactive === 'rgb(184,178,168)' && claudePaper.text === 'rgb(37,35,31)',
  `${claudeDark.text} / ${claudePaper.text}`)
check('语义状态各自成对（成功/错误）',
  claudeDark.success === 'rgb(129,150,106)' && claudePaper.success === 'rgb(104,125,81)'
  && claudeDark.error === 'rgb(217,107,95)' && claudePaper.error === 'rgb(187,81,72)')
check('输入框边框陶土橙（与开屏品牌色同源）+ 背景透明（治黑块）',
  claudeDark.promptBorder === 'rgb(215,119,87)' && claudePaper.promptBorder === 'rgb(201,100,66)'
  && claudeDark.inputBackground === '' && claudePaper.inputBackground === '',
  `${claudeDark.promptBorder} / ${claudePaper.promptBorder}`)
check('语法注释/运算符走黑白灰（正文不彩色）',
  claudeDark.syntaxComment === 'rgb(129,124,116)' && claudeDark.syntaxOperator === 'rgb(184,178,168)'
  && claudePaper.syntaxComment === 'rgb(150,144,135)',
  claudeDark.syntaxComment)
check('品牌橙残留槽位（web 点/子代理名/徽标）',
  claudeDark.toolDotWeb === 'rgb(215,119,87)' && claudeDark.subagentToolName === 'rgb(215,119,87)' && claudeDark.ide !== getTheme('dark').ide,
  claudeDark.toolDotWeb)
check('双主题进 THEME_NAMES 且深浅判定正确',
  THEME_NAMES.includes('claude-dark') && THEME_NAMES.includes('claude-paper')
  && isThemeAvailable('claude-dark') && isThemeAvailable('claude-paper')
  && !isLightThemeActive('claude-dark') && isLightThemeActive('claude-paper'))
check('与 deepseek 系是两套身份', claudeDark.accent !== getTheme('dark').accent && getTheme('dark').accent === 'rgb(125,161,222)')

// ── ③a codex 双主题（Codex Lavender / Codex Paper，branding.ts）──────────
const codexLavender = getTheme('codex-lavender')
const codexPaper = getTheme('codex-paper')
check('薰衣草紫品牌槽（lavender #A69BE8 / paper #8A7ED9）',
  codexLavender.accent === 'rgb(166,155,232)' && codexPaper.accent === 'rgb(138,126,217)',
  `${codexLavender.accent} / ${codexPaper.accent}`)
check('面板墨黑阶（lavender）/ 纸张阶（paper）',
  codexLavender.toolCardBackground === 'rgb(32,32,40)' && codexPaper.toolCardBackground === 'rgb(255,255,255)',
  `${codexLavender.toolCardBackground} / ${codexPaper.toolCardBackground}`)
check('文字三档黑白灰（lavender 近白 / paper 墨黑）',
  codexLavender.text === 'rgb(244,244,247)' && codexLavender.inactive === 'rgb(184,184,196)' && codexPaper.text === 'rgb(23,23,28)',
  `${codexLavender.text} / ${codexPaper.text}`)
check('语义状态各自成对（成功/错误）',
  codexLavender.success === 'rgb(127,179,138)' && codexPaper.success === 'rgb(95,139,105)'
  && codexLavender.error === 'rgb(217,114,124)' && codexPaper.error === 'rgb(196,90,102)')
check('紫底选中块 + 深紫输入框边框 + 背景透明',
  codexLavender.selectionBg === 'rgb(40,37,67)' && codexPaper.selectionBg === 'rgb(236,233,251)'
  && codexLavender.promptBorder === 'rgb(117,105,199)' && codexPaper.promptBorder === 'rgb(138,126,217)'
  && codexLavender.inputBackground === '' && codexPaper.inputBackground === '')
check('语法注释/运算符走黑白灰（正文不彩色）',
  codexLavender.syntaxComment === 'rgb(125,125,138)' && codexLavender.syntaxOperator === 'rgb(184,184,196)'
  && codexPaper.syntaxComment === 'rgb(141,141,152)')
check('品牌紫残留槽位（web 点/子代理名/徽标）',
  codexLavender.toolDotWeb === 'rgb(143,155,255)' && codexLavender.subagentToolName === 'rgb(166,155,232)' && codexLavender.ide !== getTheme('dark').ide,
  codexLavender.toolDotWeb)
check('codex 双主题进 THEME_NAMES 且深浅判定正确',
  THEME_NAMES.includes('codex-lavender') && THEME_NAMES.includes('codex-paper')
  && isThemeAvailable('codex-lavender') && isThemeAvailable('codex-paper')
  && !isLightThemeActive('codex-lavender') && isLightThemeActive('codex-paper'))
check('与 deepseek/claude 系是三套身份',
  codexLavender.accent !== getTheme('dark').accent && codexLavender.accent !== claudeDark.accent && codexPaper.accent !== claudePaper.accent)

// ── ③b ThemeProvider 品牌默认档 ────────────────────────────────────────────
// 未强制路径靠 OSC 11 检测的 passive effect settle（renderToScreen 同步卸载，
// 跑不到 effect），所以这里用真 ink render + 假 TTY：无 OSC 应答 → 400ms 超时
// → dark 基档 → 品牌映射。
const WIDTH = 120
let capturedTheme = ''
const Probe = (): React.ReactElement => {
  const [name] = useTheme()
  capturedTheme = name
  return <TerminalSizeContext.Provider value={{ columns: WIDTH, rows: 40 }}>probe</TerminalSizeContext.Provider>
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
class FakeOutput extends Writable {
  columns = WIDTH
  rows = 40
  isTTY = true
  writes: string[] = []
  _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.writes.push(String(chunk))
    callback(null)
  }
}
const mountProvider = async (props: Record<string, unknown>): Promise<string> => {
  capturedTheme = ''
  const stdin = new FakeStdin()
  const output = new FakeOutput()
  const instance = await render(React.createElement(ThemeProvider, { ...props, children: React.createElement(Probe) }), {
    stdin,
    stdout: output as unknown as NodeJS.WriteStream,
  })
  await settle(() => capturedTheme !== '', { timeoutMs: 3000 })
  instance.unmount()
  return capturedTheme
}
setActiveBrand('deepseek')
check('deepseek 品牌：默认档是 dark', await mountProvider({}) === 'dark')
setActiveBrand('codex')
check('codex 品牌：默认档按终端深浅落 codex-lavender', await mountProvider({}) === 'codex-lavender')
setActiveBrand('claude')
check('claude 品牌：默认档按终端深浅落 claude-dark', await mountProvider({}) === 'claude-dark')
check('显式 prop 选择优先于品牌默认档', await mountProvider({ theme: 'light' }) === 'light')
process.env.DSH_TUI_THEME = 'dark'
check('DSH_TUI_THEME 显式选择优先于品牌默认档', await mountProvider({}) === 'dark')
delete process.env.DSH_TUI_THEME
check('品牌档不落盘：未显式选择时后端品牌即时生效', await mountProvider({}) === 'claude-dark')
// 启动持久化偏好不锁品牌（用户明确要「选了后端整个主题就变」——历史
// theme.json 压住联动就永远切不过去；想固定走 /theme 重选或 dsh-tui.brand）。
{
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(join(sandboxHome, '.dsh-tui'), { recursive: true })
  writeFileSync(join(sandboxHome, '.dsh-tui', 'theme.json'), JSON.stringify({ theme: 'light' }))
  check('启动持久化偏好不锁品牌但定深浅：theme.json=light + claude 品牌 → claude-paper', await mountProvider({}) === 'claude-paper')
  writeFileSync(join(sandboxHome, '.dsh-tui', 'theme.json'), JSON.stringify({ theme: 'dark' }))
  setActiveBrand('deepseek')
  check('deepseek 品牌照常尊重持久化偏好（theme.json=dark → dark）', await mountProvider({}) === 'dark')
  writeFileSync(join(sandboxHome, '.dsh-tui', 'theme.json'), JSON.stringify({ theme: 'light' }))
  check('deepseek 品牌照常尊重持久化偏好（theme.json=light → light）', await mountProvider({}) === 'light')
  setActiveBrand('codex')
  check('codex 品牌：持久化偏好不锁品牌但定深浅（theme.json=light → codex-paper）', await mountProvider({}) === 'codex-paper')
  // /theme 会话内手选的锁定语义由 brandThemeLockRef 承担（需要调 setTheme，
  // 读屏脚本够不到；typecheck + ThemeProvider 内注释钉住语义）。
  writeFileSync(join(sandboxHome, '.dsh-tui', 'theme.json'), JSON.stringify({ theme: 'auto' }))
}
setActiveBrand('deepseek')

// ── ④ 挂真 LogoV2 读屏 ────────────────────────────────────────────────────
const TEXT_LEFT = 42
const baseProps = { model: 'probe-model', cwd: '/tmp/probe', skipIntro: true, fontId: 'bold', drift: null, egg: null, starChance: 0 } as const
const cellChar = (screen: ReturnType<typeof renderToScreen>['screen'], column: number, row: number): string => {
  const cell = cellAt(screen, column, row)
  return cell === undefined ? '' : cell.char
}
const rowsOf = (element: React.ReactElement): { rows: string[]; screen: ReturnType<typeof renderToScreen>['screen'] } => {
  const { screen, height } = renderToScreen(element, WIDTH)
  const rows = Array.from({ length: height }, (_, row) =>
    Array.from({ length: WIDTH }, (_, column) => cellChar(screen, column, row)).join('').trimEnd(),
  )
  return { rows, screen }
}
const view = (child: React.ReactElement): React.ReactElement => (
  <TerminalSizeContext.Provider value={{ columns: WIDTH, rows: 40 }}>{child}</TerminalSizeContext.Provider>
)
const textAt = (line: string): string => line.padEnd(TEXT_LEFT).slice(TEXT_LEFT).trimEnd()

const expectedTitleRows = (top: string, bottom: string): string[] => {
  // 品牌词（CLAUDE/CODEX 族）走 uniform 解（两行同字距）——与 LogoV2 的品牌
  // 分支同参；这些读屏用例都是钉左形态（无 align prop），两行左缘对齐、
  // 缩进为 0。deepseek 词对用字体表默认的 tight 解。
  const brandTitle = top === 'CLAUDE' || top === 'CODEX'
  const font = brandTitle
    ? withTagline(splashFontById('bold'), top, bottom, { uniform: true })
    : withTagline(splashFontById('bold'), top, bottom)
  const ink = { r: 232, g: 145, b: 63 }
  return [
    ...renderBigText(font, top, 0, ink, ink, ink, 60, font.tagline.topKerning, 0),
    '',
    ...renderBigText(font, bottom, 0, ink, ink, ink, 60, font.tagline.bottomKerning, brandTitle ? 0 : font.tagline.bottomIndent),
  ].map(row => strip(row).trimEnd())
}
const screenHasBlock = (rows: string[], expected: readonly string[]): boolean =>
  rows.some((_, index) => expected.every((want, offset) => textAt(rows[index + offset] ?? '') === want))

{
  const { rows } = rowsOf(view(<LogoV2 {...baseProps} brand="claude" />))
  check('claude 档：CLAUDE / CODE 两行上屏（含中间空行）', screenHasBlock(rows, expectedTitleRows('CLAUDE', 'CODE')))
  check('claude 档：不画 DEEPSEEK / HARNESS', !screenHasBlock(rows, expectedTitleRows('DEEPSEEK', 'HARNESS')))
  check('claude 档欢迎语换成品牌 slogan（创造精彩，守护关键。）',
    rows.some(line => line.includes('创造精彩，守护关键。')) && !rows.some(line => line.includes('探索未至之境')))
  // Claude 娘字符画（协议不可用的回落路径）：不看 whaleGirl 设置就占住立绘槽。
  // 判据取**全表最长**的半块字符连笔（▀▄，大字用 █、文字列用 ASCII，不会撞）
  // ——它是精灵的一部分，精灵上屏则它必然上屏；比"首非空行的 run"稳。
  const longestRun = CLAUDE_GIRL_ROWS
    .flatMap(row => strip(row).split(/\s+/))
    .reduce((best, part) => (part.length > best.length ? part : best), '')
  check('claude 档：Claude 娘字符画在立绘槽（whaleGirl=false 也生效）',
    longestRun.length >= 8 && rows.some(line => line.includes(longestRun)), `连笔 ${longestRun.length} 格`)
}
{
  const { rows } = rowsOf(view(<LogoV2 {...baseProps} />))
  check('deepseek 档（缺省 prop）：DEEPSEEK / HARNESS 照旧', screenHasBlock(rows, expectedTitleRows('DEEPSEEK', 'HARNESS')))
  check('deepseek 档：不画 CLAUDE / CODE', !screenHasBlock(rows, expectedTitleRows('CLAUDE', 'CODE')))
}
{
  const { rows } = rowsOf(view(<LogoV2 {...baseProps} brand="codex" />))
  check('codex 档：CODEX / HARNESS 两行上屏（含中间空行）', screenHasBlock(rows, expectedTitleRows('CODEX', 'HARNESS')))
  check('codex 档：不画 DEEPSEEK', !screenHasBlock(rows, expectedTitleRows('DEEPSEEK', 'HARNESS')))
  check('codex 档欢迎语换成品牌 slogan（用 Codex 构建一切）',
    rows.some(line => line.includes('用 Codex 构建一切')) && !rows.some(line => line.includes('探索未至之境')))
}
{
  // 彩蛋日 + codex 品牌：上排钉品牌词 CODEX，下排换彩蛋词。
  const { rows } = rowsOf(view(<LogoV2 {...baseProps} brand="codex" egg={{ id: 'probe-christmas', top: 'DEEPSEEK', bottom: 'MERRY' }} />))
  check('codex 档彩蛋日：上排是 CODEX、下排是 MERRY', screenHasBlock(rows, expectedTitleRows('CODEX', 'MERRY')))
}
{
  // 彩蛋日 + claude 品牌：上排钉品牌词，下排换彩蛋词。
  const { rows } = rowsOf(view(<LogoV2 {...baseProps} brand="claude" egg={{ id: 'probe-christmas', top: 'DEEPSEEK', bottom: 'MERRY' }} />))
  check('claude 档彩蛋日：上排是 CLAUDE、下排是 MERRY', screenHasBlock(rows, expectedTitleRows('CLAUDE', 'MERRY')))
}
{
  // 窄终端：鲸鱼与大字都放不下 → 一行纯文字标题，品牌词换成 Claude Code。
  const narrow = 20
  const { screen, height } = renderToScreen(
    <TerminalSizeContext.Provider value={{ columns: narrow, rows: 40 }}>
      <LogoV2 {...baseProps} brand="claude" />
    </TerminalSizeContext.Provider>,
    narrow,
  )
  const rows = Array.from({ length: height }, (_, row) =>
    Array.from({ length: narrow }, (_, column) => cellChar(screen, column, row)).join('').trimEnd(),
  )
  check('claude 档窄终端：纯文字标题是 Claude Code', rows.some(line => line.includes('Claude Code') && !line.includes('DeepSeek Harness')), rows.find(line => line.includes('Claude')) ?? '')
}
{
  // 深海档窄终端回归：纯文字标题仍是 DeepSeek Harness。
  const narrow = 20
  const { screen, height } = renderToScreen(
    <TerminalSizeContext.Provider value={{ columns: narrow, rows: 40 }}>
      <LogoV2 {...baseProps} />
    </TerminalSizeContext.Provider>,
    narrow,
  )
  const rows = Array.from({ length: height }, (_, row) =>
    Array.from({ length: narrow }, (_, column) => cellChar(screen, column, row)).join('').trimEnd(),
  )
  check('deepseek 档窄终端：纯文字标题仍是 DeepSeek Harness', rows.some(line => line.includes('DeepSeek Harness')))
}

{
  // 启动页（Launchpad hero）形态：上下排布、整块居中——立绘与两行大字的
  // 墨迹中轴都必须落在终端中央（用户点名要盯的居中问题）。区分两类墨迹：
  // 大字行以 `█`（竖笔）为特征；精灵立绘是半块渲染（`▀`/`▄`，无 `█`）。
  // 判据用**块级包围盒**：逐行 bounding box 会被字形结构浮动（L 的右空腔、
  // E 竖笔靠左）带偏 ±2 列——那是字体形状不是布局；左缘严格对齐 + 块中轴
  // 才是「居中」的正解。
  const { rows, screen } = rowsOf(view(
    <LogoV2 {...baseProps} brand="claude" chrome="minimal" arrangement="column" align="center" />,
  ))
  const spanOfRow = (rowIndex: number): { first: number; last: number } => {
    let first = -1
    let last = -1
    for (let column = 0; column < WIDTH; column++) {
      if ((cellAt(screen, column, rowIndex)?.char ?? ' ') === ' ') continue
      if (first < 0) first = column
      last = column
    }
    return { first, last }
  }
  const mid = WIDTH / 2
  const titleRows = rows.flatMap((row, index) => (row.includes('█') ? [index] : []))
  // 按行号连续性分块（CLAUDE 与 CODE 两块各 5 行，中间隔空行），块左缘取
  // 段内最左墨迹：C 的顶/底行首列是半块/透明（`·▄▀▀▄▄`，圆弧收角），逐行
  // 左缘会随字形浮动 ±1 列——那是字体形状，不是布局。
  const blocks: { rows: number[]; first: number; last: number }[] = []
  for (const rowIndex of titleRows) {
    const span = spanOfRow(rowIndex)
    const prev = blocks[blocks.length - 1]
    if (prev && prev.rows[prev.rows.length - 1] === rowIndex - 1) {
      prev.rows.push(rowIndex)
      prev.first = Math.min(prev.first, span.first)
      prev.last = Math.max(prev.last, span.last)
    } else {
      blocks.push({ rows: [rowIndex], first: span.first, last: span.last })
    }
  }
  const blockCenter = (block: { first: number; last: number }): number => (block.first + block.last) / 2
  const [claudeBlock, codeBlock] = blocks
  // 品牌同字距档：居中形态窄行（CODE）补半差居中在宽行之下——CODE 左缘 =
  // CLAUDE 左缘 + (CLAUDEInk − CODEInk) / 2；两行的中轴仍都在终端中央。
  const brandFont = withTagline(splashFontById('bold'), 'CLAUDE', 'CODE', { uniform: true })
  const centeredIndent = Math.round((paintedWidth(brandFont, 'CLAUDE', brandFont.tagline.topKerning)
    - paintedWidth(brandFont, 'CODE', brandFont.tagline.bottomKerning)) / 2)
  check(
    '启动页形态：CODE 左缘 = CLAUDE + 半差（同字距居中于其下）',
    blocks.length === 2 && claudeBlock.rows.length === 5 && codeBlock.rows.length === 5
    && codeBlock.first - claudeBlock.first === centeredIndent,
    `左缘 ${blocks.map(block => block.first).join('/')} indent ${centeredIndent}（CLAUDE ${claudeBlock?.rows.length ?? '-'} 行 / CODE ${codeBlock?.rows.length ?? '-'} 行）`,
  )
  check(
    '启动页形态：CLAUDE 块与 CODE 块的中轴都在终端中央（±1.5 列）',
    blocks.length === 2
    && Math.abs(blockCenter(claudeBlock) - mid) <= 1.5 && Math.abs(blockCenter(codeBlock) - mid) <= 1.5,
    `CLAUDE ${blocks.length === 2 ? blockCenter(claudeBlock) : '-'} / CODE ${blocks.length === 2 ? blockCenter(codeBlock) : '-'} vs ${mid}`,
  )
  // 精灵立绘：全部半块格的总包围盒中心（立绘形状天然不对称，容差 ±2）。
  let spriteFirst = -1
  let spriteLast = -1
  let spriteCells = 0
  rows.forEach((row, index) => {
    if (row.includes('█')) return
    if (!/[▀▄]/.test(row)) return
    for (let column = 0; column < WIDTH; column++) {
      const char = cellAt(screen, column, index)?.char ?? ' '
      if (char !== '▀' && char !== '▄') continue
      spriteCells += 1
      if (spriteFirst < 0) spriteFirst = column
      spriteLast = column
    }
  })
  check(
    '启动页形态：立绘（Claude 娘）的中轴也在终端中央（±2 列）',
    spriteCells > 50 && Math.abs((spriteFirst + spriteLast) / 2 - mid) <= 2,
    `中心 ${(spriteFirst + spriteLast) / 2} vs ${mid}（${spriteCells} 格）`,
  )
}

// ── Codex repaint: title words + lavender ink + brand slogan; everything else parity ──
{
  const codexTitle = expectedTitleRows('CODEX', 'HARNESS')
  const blockRowsOf = (rows: string[], words: readonly string[]): Set<number> => {
    const found = new Set<number>()
    rows.forEach((_, yy) => {
      if (words.every((line, dy) => textAt(rows[yy + dy] ?? '') === line)) {
        for (let dy = 0; dy < words.length; dy++) found.add(yy + dy)
      }
    })
    return found
  }
  const pinnedTip = { id: 'brand-parity', group: 'display', zh: '固定提示', en: 'Pinned tip' } as const
  for (const props of [{}, { whaleGirl: true }] as const) {
    const before = rowsOf(view(<LogoV2 {...baseProps} {...props} tip={pinnedTip} brand="deepseek" />))
    const after = rowsOf(view(<LogoV2 {...baseProps} {...props} tip={pinnedTip} brand="codex" />))
    const changed = after.rows.some((_, y) => codexTitle.every((line, dy) => textAt(after.rows[y + dy] ?? '') === line))
    // codex 品牌有权换立绘槽（恶魔精灵，无头回落 WhaleGirlArt）——parity 收窄
    // 到**文字列**（x ≥ TEXT_LEFT）：标题两块大字与标语行之外，信息行与布局
    // 逐格一致；codex 只重画标题词（薰衣草紫墨）、品牌标语与立绘槽。
    const skip = new Set<number>([...blockRowsOf(before.rows, expectedTitleRows('DEEPSEEK', 'HARNESS')), ...blockRowsOf(after.rows, codexTitle)])
    before.rows.forEach((row, y) => {
      if (row.includes('探索未至之境') || row.includes('用 Codex 构建一切') || (after.rows[y] ?? '').includes('用 Codex 构建一切')) skip.add(y)
    })
    const sameTextColumn = before.rows.length === after.rows.length && before.rows.every((_, y) =>
      skip.has(y)
      || Array.from({ length: WIDTH - TEXT_LEFT }, (_, i) => i + TEXT_LEFT).every(x => JSON.stringify(cellAt(before.screen, x, y)) === JSON.stringify(cellAt(after.screen, x, y))))
    check('Codex repaints title+slogan (and its own art slot): ' + JSON.stringify(props), changed && sameTextColumn, 'Text-column cells (info lines, layout) must match')
  }
  // deepy/鲸娘皮肤是 DeepSeek 品牌资产：codex 档不消费——设了皮肤，屏幕与
  // 不设完全一致（皮肤不泄漏进 codex 立绘槽）。
  for (const skin of ['deepy', 'whaleGirl'] as const) {
    const plain = rowsOf(view(<LogoV2 {...baseProps} tip={pinnedTip} brand="codex" />))
    const skinned = rowsOf(view(<LogoV2 {...baseProps} tip={pinnedTip} brand="codex" companionSkin={skin} />))
    const identical = plain.rows.length === skinned.rows.length && plain.rows.every((_, y) =>
      Array.from({ length: WIDTH }, (_, x) => x).every(x => JSON.stringify(cellAt(plain.screen, x, y)) === JSON.stringify(cellAt(skinned.screen, x, y))))
    check('Codex ignores DeepSeek companion skins: ' + skin, identical)
  }
  const narrow = 20
  const { screen, height } = renderToScreen(
    <TerminalSizeContext.Provider value={{ columns: narrow, rows: 40 }}><LogoV2 {...baseProps} brand="codex" /></TerminalSizeContext.Provider>, narrow)
  const text = Array.from({ length: height }, (_, y) => Array.from({ length: narrow }, (_, x) => cellChar(screen, x, y)).join('')).join('\n')
  check('Codex narrow title is Codex, not DeepSeek', text.includes('Codex') && !text.includes('DeepSeek Harness'))
}

// ── ④b codex 立绘资产（恶魔精灵，用户素材）──────────────────────────────
{
  const { portraitAssetsOf, CODEX_GIRL_ASSETS, loadMaidPortraits } = await import('../src/components/maidPortrait.js')
  check('品牌 → 立绘资产映射（deepseek/claude/codex 各一套）',
    portraitAssetsOf('deepseek').dir === 'whale-girl' && portraitAssetsOf('claude').dir === 'claude-girl' && portraitAssetsOf('codex') === CODEX_GIRL_ASSETS)
  const portraits = await loadMaidPortraits(CODEX_GIRL_ASSETS)
  check('codex 立绘真实解码链路（两张变体、同一画布几何）',
    portraits !== undefined
    && portraits.normal.width === portraits.happy.width
    && portraits.normal.height === portraits.happy.height
    && portraits.normal.width > 0 && portraits.normal.height > 0,
    portraits === undefined ? 'load failed' : `${portraits.normal.width}x${portraits.normal.height}`)
}

// ── ⑤ bevel 静态灰阶拆除 ──────────────────────────────────────────────────
const bevel = SPLASH_FONTS.find(font => font.id === 'bevel')
check('bevel 不再带静态灰阶 palette（随主题派生）', bevel !== undefined && bevel.palette === undefined)
check('品牌镜像默认 deepseek、setActiveBrand 生效', getActiveBrand() === 'deepseek' && (setActiveBrand('claude'), getActiveBrand() === 'claude') && (setActiveBrand('deepseek'), true))

if (failed > 0) {
  console.error(`verify-splash-brand: ${failed} check(s) failed`)
  process.exit(1)
}
console.log('verify-splash-brand OK')
