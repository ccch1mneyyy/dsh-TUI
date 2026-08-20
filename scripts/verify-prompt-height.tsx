/**
 * 输入框高度回归（feat/prompt-max-10）：可视行预算从常量 5 升为
 * min(10, terminalRows - 10) 的终端钳制预算后，锁定三条不变量：
 *   1. 高度 = min(视觉行数, 预算) + 2 边框，逐行单调、无相邻帧震荡
 *   2. 超预算后高度封顶恒定（30 行终端 = 12），窗口随光标平移不跳变
 *   3. 小终端钳制生效：16 行终端预算 6（封顶 8）、13 行终端预算 3
 * 运行：node --import tsx/esm scripts/verify-prompt-height.tsx
 */
export {} // 模块边界：避免顶层 await/全局名与其他 verify 脚本冲突

process.env.FORCE_COLOR = '3'

const [{ Writable, PassThrough }, React, { Terminal: XTerm }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
])
const { render, Box, Text } = await import('../src/ui.js')
const { PromptInput } = await import('../src/components/PromptInput.js')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function makeHarness(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: Buffer.Encoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  return {
    term,
    stdout: new FakeStdout() as never,
    stdin: new FakeStdin() as never,
  }
}

const channel = {
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  commandList: [],
  commandCompletions: () => [],
  notifications: [],
  pending: [],
  working: false,
  notify() {},
  submit() {},
  steer() {},
  interruptAndDeliver() {},
  removePending() {},
  stageImage() {},
  listFiles: async () => [],
}

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) process.stdout.write(`PASS  ${name}\n`)
  else { failures++; process.stdout.write(`FAIL  ${name} — ${detail}\n`) }
}

/** 挂载 FILLER 转录 + PromptInput + 状态行，返回帧指标采集器。 */
async function mount(cols: number, rows: number) {
  const { term, stdout, stdin } = makeHarness(cols, rows)
  const App = () =>
    React.createElement(Box, { flexDirection: 'column', height: rows, width: '100%' },
      React.createElement(Box, { flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden' },
        ...Array.from({ length: rows }, (_, i) =>
          React.createElement(Text, { key: `f${i}` }, `FILLER-${String(i).padStart(2, '0')} ${'x'.repeat(30)}`))),
      React.createElement(Box, { flexDirection: 'column', flexShrink: 0 },
        React.createElement(PromptInput, {
          channel, helpOpen: false, onToggleHelp() {}, onRunCommand: () => false, selectionActive: false,
        }),
        React.createElement(Text, null, 'STATUSLINE')))
  const instance = await render(React.createElement(App), {
    stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false,
  })
  await sleep(500)
  const frame = () => {
    const lines = Array.from({ length: rows }, (_, y) =>
      term.buffer.active.getLine(y)?.translateToString(true) ?? '')
    const top = lines.findIndex(l => l.includes('╭'))
    const bottom = lines.findIndex(l => l.includes('╰'))
    const firstInput = lines.find(l => /L\d\d/.test(l))?.match(/L\d\d/)?.[0] ?? '-'
    return { height: top >= 0 && bottom >= 0 ? bottom - top + 1 : -1, firstInput }
  }
  const feed = async (seq: string) => { stdin.write(seq); await sleep(130) }
  return { frame, feed, unmount: async () => { instance.unmount(); await sleep(150) } }
}

// ── 场景 1：30 行终端逐行 1→12，单调爬升后封顶恒 12，窗口从第 11 行起滚 ──
{
  const m = await mount(100, 30)
  const heights: number[] = []
  await m.feed('L01 ')
  heights.push(m.frame().height)
  for (let n = 2; n <= 12; n++) {
    await m.feed('\n')
    await m.feed(`L${String(n).padStart(2, '0')} `)
    heights.push(m.frame().height)
  }
  // 预算 10：高度应为 3,4,...,12（12 个值）再恒 12
  const expected = Array.from({ length: 11 }, (_, i) => Math.min(i + 1, 10) + 2).concat([12])
  check('30 行终端：逐行高度单调且等于 min(行数,10)+2',
    JSON.stringify(heights) === JSON.stringify(expected), JSON.stringify(heights))
  let monotonic = true
  for (let i = 1; i < heights.length; i++) if (heights[i]! - heights[i - 1]! < 0) monotonic = false
  check('逐行输入全程无高度回落（相邻帧不震荡）', monotonic, JSON.stringify(heights))
  check('12 行文本窗口 [2,12)（首行 L03，光标贴底）', m.frame().firstInput === 'L03', m.frame().firstInput)

  // 光标顶/底往返：高度恒 12
  for (let i = 0; i < 11; i++) await m.feed('\x1b[A')
  const atTop = m.frame()
  for (let i = 0; i < 11; i++) await m.feed('\x1b[B')
  const atBottom = m.frame()
  check('光标顶/底往返高度恒定（封顶 12）',
    atTop.height === 12 && atBottom.height === 12, `${atTop.height}/${atBottom.height}`)
  await m.unmount()
}

// ── 场景 2：16 行终端钳制预算 6（封顶高 8）──
{
  const m = await mount(100, 16)
  for (let n = 1; n <= 8; n++) {
    if (n > 1) await m.feed('\n')
    await m.feed(`L${String(n).padStart(2, '0')} `)
  }
  check('16 行终端：8 行文本钳制在预算 6（封顶高 8）', m.frame().height === 8, String(m.frame().height))
  await m.unmount()
}

// ── 场景 3：13 行终端钳制预算 3（封顶高 5）──
{
  const m = await mount(100, 13)
  for (let n = 1; n <= 5; n++) {
    if (n > 1) await m.feed('\n')
    await m.feed(`L${String(n).padStart(2, '0')} `)
  }
  check('13 行终端：5 行文本钳制在预算 3（封顶高 5）', m.frame().height === 5, String(m.frame().height))
  await m.unmount()
}

if (failures > 0) {
  process.stdout.write(`verify-prompt-height: ${failures} assertion(s) failed\n`)
  process.exit(1)
}
process.stdout.write('verify-prompt-height OK\n')
