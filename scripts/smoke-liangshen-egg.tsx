/**
 * 彩蛋全屏渲染冒烟：headless 渲染 LiangshenEasterEgg（替换树模式）。
 *
 * 关键场景：模拟真实环境的共享动画时钟——先跑 5 秒预热动画让时钟累计，
 * 再挂载彩蛋，验证入场时钟以挂载时刻为基准（elapsed 从 0 开始），否则
 * 入场会被跳过、直接进入滚动（issue：用户看到"从下往上"）。
 *
 * 运行：pnpm smoke:easter-egg
 */
process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, ui, { LiangshenEasterEgg }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/ui.js'),
  import('../src/components/LiangshenEasterEgg.js'),
])
const { Box, Text, useAnimationFrame } = ui
const { stringWidth } = await import('../src/ink/stringWidth.js')

const COLS = 60
const ROWS = 20
/** 预热时长：远超入场总时长 ((rows-1)×80 + 520 ≈ 2040ms)，复现时钟早已运行。 */
const PREWARM_MS = 5000

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdout = new FakeStdout()

const screen = (): string[] =>
  Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '')

/** 预热动画：订阅共享时钟，让 clock.now() 累计到远超入场的值。 */
function Prewarm() {
  useAnimationFrame(16)
  return React.createElement(Text, null, 'warming up the shared clock')
}

/** 先预热，5 秒后挂载彩蛋（同 App、同共享时钟，复现真实场景）。 */
function Harness() {
  const [showEgg, setShowEgg] = React.useState(false)
  React.useEffect(() => {
    const timer = setTimeout(() => setShowEgg(true), PREWARM_MS)
    return () => clearTimeout(timer)
  }, [])
  return showEgg
    ? React.createElement(LiangshenEasterEgg, { onDone: () => {} })
    : React.createElement(Prewarm)
}

const instance = await render(
  React.createElement(Box, null, React.createElement(Harness)),
  { stdout, stdin: new FakeStdin(), stderr: stdout, exitOnCtrlC: false, patchConsole: false },
)

const dump: string[] = []
let failures = 0

// 挂载后 400ms（总时长 PREWARM+400）：逐行错峰入场应正在进行——
// 顶行已从左滑入，底行还没开始。若入场被跳过（bug），顶行早已全宽且滚动中。
await new Promise(r => setTimeout(r, PREWARM_MS + 400))
const lines = screen()
dump.push('--- screen dump (t=PREWARM+400ms) ---')
for (let y = 0; y < 8 && y < lines.length; y++) dump.push(`${y} ${JSON.stringify(lines[y].slice(0, 50))}`)
const top = stringWidth(lines[0].trimEnd())
const bottom = stringWidth(lines[ROWS - 2].trimEnd())
if (top >= Math.round(COLS * 0.5)) dump.push(`PASS  entry after prewarm: top row ${top} cols wide`)
else { failures++; dump.push(`FAIL  entry after prewarm: top row only ${top} cols`) }
if (bottom < top) dump.push(`PASS  entry after prewarm: bottom row (${bottom} cols) lags the top (${top})`)
else { failures++; dump.push(`FAIL  entry after prewarm: bottom row (${bottom}) not lagging top (${top}) — entry was skipped`) }

// 错峰全部完成后应全宽铺满：等完整入场再加余量。
await new Promise(r => setTimeout(r, 2300))
const full = screen()
let wide = 0
for (let y = 0; y < ROWS - 1; y++) {
  const w = stringWidth(full[y].trimEnd())
  if (w >= Math.round(COLS * 0.8)) wide++
}
if (wide >= ROWS - 2) dump.push(`PASS  full width: ${wide}/${ROWS - 1} rows ≥80% of ${COLS} cols`)
else { failures++; dump.push(`FAIL  full width: only ${wide}/${ROWS - 1} rows wide`) }

// 滚动：入场完成后两帧之间整屏内容应变化（靠词/夸赞行位移体现）。
const firstFrame = full.join('\n')
await new Promise(r => setTimeout(r, 300))
const laterFrame = screen().join('\n')
if (laterFrame !== firstFrame) dump.push('PASS  scrolling: screen changed between frames')
else { failures++; dump.push('FAIL  scrolling: screen did not change between frames') }

instance.unmount()
if (failures > 0) process.stderr.write(dump.join('\n') + '\n')
process.stderr.write(failures === 0 ? 'SMOKE PASS\n' : `SMOKE FAIL (${failures})\n`)
process.exit(failures === 0 ? 0 : 1)
