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

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { StatusLine }, { settled }] =
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

console.log(failed === 0 ? '\nAll context bar alignment checks passed.' : `\n${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
