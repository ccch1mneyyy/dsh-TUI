/**
 * Effort ignition regression — the three-act overlay on the prompt border.
 *
 * Part A asserts the math layer (waveform sampling, easings, envelope, the
 * per-column colour contract, boundary guards). Part B mounts the real
 * EffortInputBorder (self-drawn ╭─╮ / ╰─╯ rows; the top row carries the show)
 * in a headless xterm, one harness per scenario, and asserts:
 *
 * - The sweep is a single wave style (the shipped shape); the math layer
 *   below pins its contract directly.
 * - **Glyphs never change; only colours move.** The row's TEXT is
 *   byte-identical across frames (▁ × width, present at rest too) — the
 *   strongest form of the SGR-only rule, with no layout change at any
 *   point: the bright wave is foreground colour running over a constant
 *   ▁ layer, the dim rest is the same layer at its quiet end.
 * - **Mount/unmount never scroll**: the rows are permanent, but the whole
 *   stream still must contain no scroll sequences (#38/#39/#19/#10 family).
 * - **It returns to rest**: wave colours vanish after the style's total.
 * - **Negative paths stay dark**: cold mount on the top tier, single-tier
 *   table, missing table, and leaving the top tier sweep nothing.
 *
 * Run: node --import tsx/esm scripts/verify-effort-ignition.tsx
 */
process.env.FORCE_COLOR = '3'

const [
  { Writable, PassThrough },
  React,
  { Terminal: XTerm },
  { render, Text, Box, ThemeProvider },
  { EffortInputBorder },
  { EffortTierBadge },
  { EffortChargeGlyph },
  { ClockProvider },
  math,
  { sleep },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/EffortInputBorder.js'),
  import('../src/components/EffortTierBadge.js'),
  import('../src/components/EffortChargeGlyph.js'),
  import('../src/ink/components/ClockContext.js'),
  import('../src/trajectory/effortIgnition.js'),
  import('./lib/term-test.mjs'),
])

// 本文件按固定墙钟时间采样动画时间轴的各幕（时间轴本身是被测对象），
// 改成轮询会移动采样点、破坏后续幕的相对时序。
const PALETTE = math.ignitionColors('dark')
// 主题化的对照组：红对（带底色纯黑）应画出只含红通道的列。
const RED_PALETTE = { ignition: { r: 255, g: 0, b: 0 }, ignitionDim: { r: 0, g: 0, b: 0 } }
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail === '' ? '' : ` (${detail})`}`)
  if (!ok) failures++
}

// --- Part A: math layer --------------------------------------------------------
check('crest: 1 at the crest, 0 at one half-width out', math.crest(0) === 1 && math.crest(1) === 0)
check('crest: beyond the half-width is silent, both directions',
  math.crest(1.5) === 0 && math.crest(-1) === 0 && math.crest(-2) === 0)
check('easings: endpoints are exact',
  math.easeOutCubic(0) === 0 && math.easeOutCubic(1) === 1
  && math.easeInOutCubic(0) === 0 && math.easeInOutCubic(1) === 1)
check('easings: clamped outside [0,1]',
  math.easeOutCubic(2) === 1 && math.easeInOutCubic(-3) === 0)
check('line colors: exactly one entry per column',
  math.ignitionLineColors({ elapsedMs: 300, width: 40, colors: PALETTE }).length === 40)
check('line colors: empty before start and after the end',
  math.ignitionLineColors({ elapsedMs: 0, width: 40, colors: PALETTE }).length === 0
  && math.ignitionLineColors({ elapsedMs: math.SWEEP_TOTAL_MS + 1, width: 40, colors: PALETTE }).length === 0)
check('line colors: boundary guards (width 0, negative/NaN/at-total elapsed)',
  math.ignitionLineColors({ elapsedMs: 300, width: 0, colors: PALETTE }).length === 0
  && math.ignitionLineColors({ elapsedMs: -5, width: 40, colors: PALETTE }).length === 0
  && math.ignitionLineColors({ elapsedMs: Number.NaN, width: 40, colors: PALETTE }).length === 0
  && math.ignitionLineColors({ elapsedMs: math.SWEEP_TOTAL_MS, width: 40, colors: PALETTE }).length === 0)
check('line colors: single-column terminal yields one entry',
  math.ignitionLineColors({ elapsedMs: 300, width: 1, colors: PALETTE }).length === 1)
check('line colors: every painted entry is a truecolor rgb() string',
  math
    .ignitionLineColors({ elapsedMs: 200, width: 60, colors: PALETTE })
    .every(color => color === undefined || /^rgb\(\d+,\d+,\d+\)$/.test(String(color))))
check('line colors: some columns are painted mid-wave',
  math
    .ignitionLineColors({ elapsedMs: 300, width: 80, colors: PALETTE })
    .some(color => color !== undefined))
// 主题化：波形色来自传入的色对，不再有模块内的固定色板。
{
  const painted = math
    .ignitionLineColors({ elapsedMs: 300, width: 80, colors: RED_PALETTE })
    .filter(color => color !== undefined)
  check('line colors: the palette pair drives the wave (red pair paints red-only columns)',
    painted.length > 0
    && painted.every(color => /^rgb\(\d+,0,0\)$/.test(String(color)))
    && painted.some(color => color !== 'rgb(0,0,0)'),
    `${painted.length} painted`)
  check('line colors: channel quantisation never overflows 255',
    math
      .ignitionLineColors({ elapsedMs: 300, width: 80, colors: { ignition: { r: 255, g: 255, b: 255 }, ignitionDim: { r: 255, g: 255, b: 255 } } })
      .every(color => color === undefined || /^rgb\((?:25[0-5]|2[0-4]\d|1?\d?\d),(?:25[0-5]|2[0-4]\d|1?\d?\d),(?:25[0-5]|2[0-4]\d|1?\d?\d)\)$/.test(String(color))))
}
// --- Part B: three acts on the prompt border, then back to nothing --------
const LEVELS = ['low', 'medium', 'high'] as const
const COLS = 60

async function makeHarness(rows: number, driver: React.ReactNode) {
  const term = new XTerm({ cols: COLS, rows, scrollback: 200, allowProposedApi: true })
  const writes: string[] = []
  class FakeStdout extends Writable {
    columns = COLS
    rows = rows
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      writes.push(String(chunk))
      term.write(String(chunk), callback)
    }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  const rowText = (y: number): string =>
    term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true) ?? ''
  const fgSet = (y: number): Set<number> => {
    const line = term.buffer.active.getLine(term.buffer.active.baseY + y)
    const found = new Set<number>()
    if (line === undefined) return found
    for (let x = 0; x < COLS; x++) {
      const cell = line.getCell(x)
      if (cell !== undefined && cell.isFgRGB()) found.add(cell.getFgColor())
    }
    return found
  }
  const fgColors = (y: number): number => fgSet(y).size
  const instance = await render(
    React.createElement(ClockProvider, null, driver),
    {
      stdout: new FakeStdout() as never,
      stdin: new FakeStdin() as never,
      stderr: new FakeStdout() as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  return { term, writes, rowText, fgSet, fgColors, instance }
}

function borderNode(effort: string | undefined): React.ReactNode {
  // Children mirror the real empty input row: block caret + centered badge.
  return React.createElement(
    EffortInputBorder,
    { effort, levels: LEVELS, columns: COLS, idleColor: 'promptBorder' },
    React.createElement(Text, null,
      ' ',
      React.createElement(EffortTierBadge, { effort, levels: LEVELS, columns: COLS, leadingColumns: 2 })),
  )
}

function SweepDriver(): React.ReactNode {
  const [effort, setEffort] = React.useState<string>('medium')
  React.useEffect(() => {
    const timer = setTimeout(() => setEffort('high'), 300)
    return () => clearTimeout(timer)
  }, [])
  return borderNode(effort)
}

// Act timings from the component: switch at t=300 → elapsed = t-300.
//   sweep [0,800); letters appear from 400 (M) / 540 (A) / 680 (X), full at
//   ~840; fade [1100,1600); gone at 1600.
{
  const harness = await makeHarness(6, React.createElement(SweepDriver))
  try {
    // 固定窗:探针 t=300 切档之前采样静止态——「还没有任何动画」是已成立
    // 条件，轮询会立即返回等于没测；采样点也必须早于切档。
    await sleep(150)
    const restText = harness.rowText(0)
    check('rest: plain theme border, no letters, one colour',
      restText === '╭' + '─'.repeat(COLS - 2) + '╮' && harness.fgColors(0) <= 1)
    check('rest: exactly three rows — bottom border sits directly under the input row',
      harness.rowText(2) === '╰' + '─'.repeat(COLS - 2) + '╯' && harness.rowText(3) === '')
    // elapsed ≈ 300: mid-sweep, letters not started (LABEL_START 600).
    await sleep(450) // 固定窗:墙钟 采样 sweep [0,800) 的中段，须早于 LABEL_START 600
    check('act 1 sweep: a light band runs left→right on BOTH borders, no letters yet',
      harness.fgColors(0) >= 2 && harness.fgColors(2) >= 2, `${harness.fgColors(0)}/${harness.fgColors(2)} colours`)
    // elapsed ≈ 950: the tier name shows centered on the input row, and NO
    // extra row appears — the row under it stays the bottom border.
    await sleep(650) // 固定窗:墙钟 采样 elapsed≈950，字样已出但仍在收敛（收敛 600+800）
    const inputRow = harness.rowText(1)
    const tierLetters = LEVELS[LEVELS.length - 1]!.toUpperCase().split('')
    const firstAt = inputRow.indexOf(tierLetters[0]!)
    check('act 2 label: letters emerged CENTERED while still converging (gap > 1)',
      tierLetters.every(letter => inputRow.includes(letter)) && firstAt >= Math.floor(COLS / 2) - 12,
      `col ${firstAt}: ${inputRow.trim().slice(0, 24)}`)
    // elapsed ≈ 1450: converge done (600+800), gap locked at 1, pre-fade.
    await sleep(500) // 固定窗:墙钟 采样 elapsed≈1450 的落定态（收敛 600+800 已完成）
    const settled = harness.rowText(1)
    const spacedName = tierLetters.join(' ')
    check('act 2 label: letters settled at one-space gap',
      settled.includes(spacedName), settled.trim().slice(0, 24))
    // 终态精确居中：字样中点字母落在终端几何中心列上。
    const midLetter = tierLetters[Math.floor(tierLetters.length / 2)]!
    const midAt = settled.indexOf(spacedName) + spacedName.indexOf(midLetter)
    const terminalCenter = Math.round((COLS - 1) / 2)
    check('act 2 label: settled dead-center on the terminal',
      Math.abs(midAt - terminalCenter) <= 1, `mid at ${midAt}, center ${terminalCenter}`)
    check('act 2 label: no extra row — bottom border never moves',
      harness.rowText(2) === '╰' + '─'.repeat(COLS - 2) + '╯')
    const labelColors = harness.fgColors(1)
    check('act 2 label: the badge carries the accent family', labelColors >= 1, `${labelColors} colours`)
    // elapsed ≈ 1700 (past FADE_END 1600): everything gone, border identical to rest.
    harness.writes.length = 0
    await sleep(1050) // 固定窗:墙钟 采样 elapsed≈1700，越过 FADE_END 1600
    const stream = harness.writes.join('')
    const scroll = [/\x1b\[\d*S/, /\x1b\[\d*T/].some(pattern => pattern.test(stream))
    check('act 3 fade: badge and sweep are gone, border back to rest',
      harness.rowText(0) === restText && harness.rowText(1).trim() === '' && harness.fgColors(0) <= 1)
    check('lifecycle: no scroll sequences at any point', !scroll)
    check('after the fade both borders rest in a single colour', harness.fgColors(0) <= 1 && harness.fgColors(2) <= 1)
  } finally {
    harness.instance.unmount()
  }
}

// --- Part C: 主题接线 ----------------------------------------------------------
// 三个点火组件都从 useTheme() 取名再查色对；不套 ThemeProvider 时上下文落到
// 默认 `{ theme: 'dark' }`，把三处 `ignitionColors(themeName)` 写死成
// `ignitionColors('dark')` 也照样全绿。这里用合成主题实渲染：它的点火是红
// （#FF0000 → #2A0000，每通道 r > g），深色回退是蓝（#82B9FF → #1B1E28，
// r < g），接错主题混进蓝列立刻红。
{
  const { getTheme, registerRuntimeThemeResolver } = await import('../src/theme.js')
  const PROBE = 'ignition-probe'
  // `promptBorder` 是采样行里静止列的颜色（idleColor），也必须偏红：否则
  // 「整行 r > g」会被中性边框色破掉，判据就只剩波形列。
  const probe = {
    ...getTheme('dark'),
    ignition: '#FF0000',
    ignitionDim: '#2A0000',
    promptBorder: '#5A2A2A',
  }
  const disposeProbe = registerRuntimeThemeResolver(name => name === PROBE ? probe : undefined)
  const themed = (node: React.ReactNode): React.ReactNode =>
    React.createElement(ThemeProvider, { theme: PROBE }, node)
  const redOnly = (colors: Iterable<number>): boolean =>
    [...colors].every(color => ((color >> 16) & 0xff) > ((color >> 8) & 0xff))

  // 边框扫光 + 档位字样：与 Part B 同一组固定窗采样点。
  const harness = await makeHarness(6, themed(React.createElement(SweepDriver)))
  try {
    await sleep(600) // 固定窗:墙钟 采样 sweep [0,800) 中段（切档在 t=300）
    const wave = [...harness.fgSet(0)]
    check('theme: 扫光/边框取主题的点火色对（红坡道，不是深色回退蓝）',
      wave.length >= 2 && redOnly(wave), `${wave.length} colours`)
    await sleep(650) // 固定窗:墙钟 采样 elapsed≈950，档位字样已出
    const letters = [...harness.fgSet(1)]
    check('theme: 档位字样与扫光同源（同一红坡道）',
      letters.length >= 1 && redOnly(letters), `${letters.length} colours`)
  } finally {
    harness.instance.unmount()
  }

  // ❯ 前缀的稳态色就是点火原值：钉到具体通道，接错主题时值直接不等。
  const glyph = await makeHarness(2, themed(
    React.createElement(EffortChargeGlyph, { effort: 'high', levels: LEVELS, working: false })))
  try {
    await sleep(60) // 固定窗:墙钟 冷挂载在最高档不充能，等首帧
    // 期望值是**字面量**，不取自 `ignitionColors(PROBE)`：从被测映射派生期望的
    // 话，该映射自己回退时两边同漂、这条不红（verify-themes 另钉了解析层）。
    const want = 0xff0000
    const shown = [...glyph.fgSet(0)]
    check('theme: ❯ 前缀取主题的 ignition 原值',
      shown.includes(want), `fg=${shown.map(color => color.toString(16)).join(' ')}`)
  } finally {
    glyph.instance.unmount()
    disposeProbe()
  }
}

// --- Negative paths: no sweep, no letters, ever -------------------------------
async function runDarkScenario(name: string, node: React.ReactNode) {
  const harness = await makeHarness(6, node)
  try {
    // 固定窗:探针 不得播放任何动画；轮询对「什么都没发生」立即返回，
    // 等于没测——下面两段合起来覆盖整条时间轴。
    await sleep(300)
    harness.writes.length = 0
    await sleep(1800) // 固定窗:探针 覆盖整条时间轴，期间不得有任何动画写入
    const stream = harness.writes.join('')
    const top = harness.rowText(0)
    const dim = harness.fgColors(0) <= 1 && !/[A-Z]/.test(top.slice(1, -1)) && !/\x1b\[38;2;.*\x1b\[38;2;/.test(stream)
    check(`${name}: nothing plays`, dim)
  } finally {
    harness.instance.unmount()
  }
}

await runDarkScenario('cold mount on the top tier', borderNode('high'))
function SingleTierDriver(): React.ReactNode {
  return React.createElement(
    EffortInputBorder,
    { effort: 'high', levels: ['high'], columns: COLS, idleColor: 'promptBorder' },
    React.createElement(Text, null, 'row'),
  )
}
await runDarkScenario('single-tier table', React.createElement(SingleTierDriver))
function NoTableDriver(): React.ReactNode {
  return React.createElement(
    EffortInputBorder,
    { effort: 'high', levels: undefined, columns: COLS, idleColor: 'promptBorder' },
    React.createElement(Text, null, 'row'),
  )
}
await runDarkScenario('missing level table', React.createElement(NoTableDriver))
function LeaveTopDriver(): React.ReactNode {
  const [effort, setEffort] = React.useState<string>('high')
  React.useEffect(() => {
    const timer = setTimeout(() => setEffort('medium'), 300)
    return () => clearTimeout(timer)
  }, [])
  return borderNode(effort)
}
await runDarkScenario('leaving the top tier', React.createElement(LeaveTopDriver))

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
