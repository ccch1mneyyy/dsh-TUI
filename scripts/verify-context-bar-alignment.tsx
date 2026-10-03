/**
 * 上下文进度条右对齐回归——进度条右端必须与状态行右端（内容区右缘）对齐。
 *
 * #922：页脚根 Box 是 `paddingX={1} width={columns}`，内容区实宽 `columns - 2`；
 * 进度条却按 `columns - 4` 取宽——v0.8.0 起 9af217dd 把根 Box 的 paddingX 从 2
 * 收到 1 时没有同步 barWidth，右端恒定短 2 列，与下方状态行不再对齐。
 *
 * oracle：把 StatusLine 用真实渲染器画进 xterm 缓冲，逐格测量。
 * bar 行是页脚里唯一带背景填充的行（段填充是纯 backgroundColor Box），
 * 它最右侧带背景色的格就是 bar 的右缘；其下一行的最右非空格是状态行的
 * 右缘。两者都必须落在内容区右缘（第 `columns - 2` 格，0 起）。
 * 宽度扫描与终端宽度无关地断言等号——这正是 #922 报告里失配的形状。
 *
 * Run: node --import tsx/esm scripts/verify-context-bar-alignment.tsx
 */
process.env.FORCE_COLOR = '3'

import type { Terminal } from '@xterm/headless'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, ThemeProvider }, { StatusLine }, { settled }] =
  await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/screens/StatusLine.js'),
    import('./lib/term-test.mjs'),
  ])
const instances = (await import('../src/ink/instances.js')).default

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

/** StatusLine 读到的 channel 投影子集，取值沿用 verify-resize-reflow 的桩。 */
function makeChannel(): Record<string, unknown> {
  return {
    version: 0,
    status: 'idle',
    sessionTitle: '对齐回归',
    agentId: 'probe',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    tokens: { input: 600, output: 120 },
    cwd: 'C:/code/orca',
    displayCwd: 'C:/code/orca',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'idle',
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    turnStart: 0,
    pending: [],
    notifications: [],
    contextBarEnabled: true,
    lastUsage: { input: 99_700, cacheRead: 40_300, cacheWrite: 0, output: 120 },
    contextWindow: 1_000_000,
    contextSegments: { system: 42_000, prompt: 18_000, assistant: 26_000, thinking: 21_000, tools: 17_000 },
    tpsSamples: [],
    reasoningEffort: 'high',
  }
}

function makeHarness(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      term.write(String(chunk), callback)
    }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  const stdout = new FakeStdout()
  return { term, stdout, stdin: new FakeStdin() }
}

async function mountAt(cols: number, rows: number) {
  const harness = makeHarness(cols, rows)
  const instance = await render(
    React.createElement(StatusLine, { channel: makeChannel() as never }),
    {
      stdout: harness.stdout as never,
      stdin: harness.stdin as never,
      stderr: harness.stdout as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  for (const value of instances.values()) instances.set(process.stdout, value)
  return { harness, instance }
}

function cellAt(term: Terminal, y: number, x: number) {
  return term.buffer.active.getLine(y)?.getCell(x)
}

/** 该格是否带背景填充（默认底色算无填充）。 */
function bgSet(term: Terminal, y: number, x: number): boolean {
  const cell = cellAt(term, y, x)
  return cell !== undefined && !cell.isBgDefault()
}

/** 该格是否有可见字符（空格与未写入格都算空）。 */
function inked(term: Terminal, y: number, x: number): boolean {
  const code = cellAt(term, y, x)?.getCode() ?? 0
  return code !== 0 && code !== 32
}

/** bar 行：带背景填充格最多的行（页脚只有 bar 画背景）。 */
function findBarRow(term: Terminal): number {
  let best = -1
  let bestCount = 0
  for (let y = 0; y < term.rows; y++) {
    let count = 0
    for (let x = 0; x < term.cols; x++) {
      if (bgSet(term, y, x)) count++
    }
    if (count > bestCount) {
      bestCount = count
      best = y
    }
  }
  return best
}

function rightmostBg(term: Terminal, y: number): number {
  for (let x = term.cols - 1; x >= 0; x--) {
    if (bgSet(term, y, x)) return x
  }
  return -1
}

function rightmostInk(term: Terminal, y: number): number {
  for (let x = term.cols - 1; x >= 0; x--) {
    if (inked(term, y, x)) return x
  }
  return -1
}

const WIDTHS = [80, 110, 156, 200]
for (const cols of WIDTHS) {
  const { harness, instance } = await mountAt(cols, 30)
  try {
    // 等到首帧把 bar 画进缓冲再断言，不用固定窗。
    const painted = await settled(() => findBarRow(harness.term) >= 0)
    const barY = findBarRow(harness.term)
    const contentRight = cols - 2
    if (!painted || barY < 0) {
      check(`columns=${cols} bar 已渲染`, false, 'no background-painted row found')
      continue
    }
    const barRight = rightmostBg(harness.term, barY)
    const statusRight = rightmostInk(harness.term, barY + 1)
    check(
      `columns=${cols} bar 右缘对齐内容区右缘`,
      barRight === contentRight,
      `barRight=${barRight} expected=${contentRight}`,
    )
    check(
      `columns=${cols} bar 右缘对齐状态行右缘`,
      barRight === statusRight,
      `barRight=${barRight} statusRight=${statusRight}`,
    )
  } finally {
    instance.unmount()
    instances.delete(process.stdout)
    harness.term.dispose()
  }
}

// ── 空余段配色：浅色判定看调色板，不看主题名 ─────────────────────────────
// 浅色主题的名字不必叫 `light`（用户主题、插件主题都可能）；按名字比较会让
// 它拿到深色空余段（#2E3440 深蓝灰），在浅色终端上是肉眼可见的瑕疵。这里用
// 一份浅色墨的运行时调色板当探针：它不是内置 `light` 的身份，只能靠亮度判定。
const DARK_FREE_FILL = (0x2e << 16) | (0x34 << 8) | 0x40
const LIGHT_FREE_FILL = (0xe8 << 16) | (0xe8 << 8) | 0xe8
const hex = (value: number): string => `#${value.toString(16).padStart(6, '0')}`

/** 该主题下 bar 行的背景填充色**段**，按列顺序、相邻同色合并。 */
async function barFills(theme: string): Promise<number[]> {
  const harness = makeHarness(120, 30)
  const instance = await render(
    React.createElement(
      ThemeProvider,
      { theme },
      React.createElement(StatusLine, { channel: makeChannel() as never }),
    ),
    {
      stdout: harness.stdout as never,
      stdin: harness.stdin as never,
      stderr: harness.stdout as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  for (const value of instances.values()) instances.set(process.stdout, value)
  try {
    await settled(() => findBarRow(harness.term) >= 0)
    const barY = findBarRow(harness.term)
    const fills: number[] = []
    if (barY >= 0) {
      for (let x = 0; x < harness.term.cols; x++) {
        const cell = cellAt(harness.term, barY, x)
        if (cell === undefined || cell.isBgDefault()) continue
        const fill = cell.getBgColor()
        // 段与段的先后就是条上的渲染顺序：只按集合比对会漏掉「两段映射颠倒」。
        if (fills[fills.length - 1] !== fill) fills.push(fill)
      }
    }
    return fills
  } finally {
    instance.unmount()
    instances.delete(process.stdout)
    harness.term.dispose()
  }
}

const fmtFills = (fills: readonly number[]): string => fills.map(hex).join(' ')

const darkFills = await barFills('dark')
check('dark 空余段用深色填充', darkFills.includes(DARK_FREE_FILL), fmtFills(darkFills))

const probeFillsForLightInk = async (): Promise<Set<number>> => {
  const { getTheme, registerRuntimeThemeResolver } = await import('../src/theme.js')
  // 另一个身份（不是内置对象）⇒ 只能走亮度分支；`text` 刻意写成 hex——校验器放行的
  // 最常见写法，判据必须读得出来（只认紧凑 `rgb()` 时下面两条会红）。
  const lightInk = { ...getTheme('light'), text: '#22262E' }
  const dispose = registerRuntimeThemeResolver(name =>
    name === 'light-ink-probe' ? lightInk : undefined)
  try {
    return await barFills('light-ink-probe')
  } finally {
    dispose()
  }
}

const lightInkFills = await probeFillsForLightInk()
check('浅色墨的运行时主题不拿深色空余段', !lightInkFills.includes(DARK_FREE_FILL), fmtFills(lightInkFills))
check('浅色墨的运行时主题退回浅色默认填充', lightInkFills.includes(LIGHT_FREE_FILL), fmtFills(lightInkFills))

const lightFills = await barFills('light')
check('light 空余段用浅色默认填充', lightFills.includes(LIGHT_FREE_FILL), fmtFills(lightFills))

// ── 段填充跟着主题走（contextBar* 键）────────────────────────────────────
// 五段色曾写死在 StatusMetrics 的 USED_SEGMENTS 里；现在由调色板的
// contextBar* 键驱动。运行时主题探针断言「键 → 屏上填充色」这条链路真的接通，
// 而不只是解析层拿到值（解析层在 verify-themes）。
const PROBE_FILLS = [0x101010, 0x202020, 0x303030, 0x404040, 0x505050]
{
  const { getTheme, registerRuntimeThemeResolver } = await import('../src/theme.js')
  const probe = {
    ...getTheme('dark'),
    contextBarSystem: '#101010',
    contextBarPrompt: '#202020',
    contextBarAssistant: '#303030',
    contextBarThinking: '#404040',
    contextBarTools: '#505050',
  }
  const dispose = registerRuntimeThemeResolver(name =>
    name === 'chrome-probe' ? probe : undefined)
  const probeFills = await barFills('chrome-probe')
  const shown = fmtFills(probeFills)
  // 按顺序逐段比对，而不是「五个色都在屏上」：只比集合时，渲染器把任意两段的
  // 颜色对调仍然全绿——段与段的先后正是本条要钉的映射；写死的深蓝坡道色不在前
  // 五段里，同样被这条排除。
  check('五段填充按上下文段顺序来自主题的 contextBar* 键',
    PROBE_FILLS.every((fill, index) => probeFills[index] === fill), shown)
  // ── 品牌优先于色板键（branding.ts）──────────────────────────────────────
  // claude 品牌在档时五段与空余段都走品牌表，连**声明了 contextBar\* 键**的调色板
  // 也让位——那是「切后端整屏换色」的语义，与 `ignitionColors` 同一规则。这里用
  // 同一条渲染链路钉优先级；解析层的纯投影由 verify-themes 钉。
  const { setActiveBrand } = await import('../src/branding.js')
  const CLAUDE_DARK_RAMP = [0x3a2720, 0x7a4a33, 0xb0623f, 0xd77757, 0xe8a183]
  setActiveBrand('claude')
  try {
    const brandFills = await barFills('chrome-probe')
    check('品牌在档：段填充走品牌表，色板声明的键让位',
      CLAUDE_DARK_RAMP.every((fill, index) => brandFills[index] === fill), fmtFills(brandFills))
  } finally {
    setActiveBrand('deepseek')
  }
  const restoredFills = await barFills('chrome-probe')
  check('品牌复位：段填充回到色板声明的键',
    PROBE_FILLS.every((fill, index) => restoredFills[index] === fill), fmtFills(restoredFills))
  dispose()
}
console.log(failed === 0 ? '\nAll context bar alignment checks passed.' : `\n${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
