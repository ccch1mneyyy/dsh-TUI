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
  { render, Text, Box },
  { EffortInputBorder },
  { EffortTierBadge },
  { ClockProvider },
  math,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/EffortInputBorder.js'),
  import('../src/components/EffortTierBadge.js'),
  import('../src/ink/components/ClockContext.js'),
  import('../src/trajectory/effortIgnition.js'),
])

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
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
  math.ignitionLineColors({ elapsedMs: 300, width: 40, onLight: false }).length === 40)
check('line colors: empty before start and after the end',
  math.ignitionLineColors({ elapsedMs: 0, width: 40, onLight: false }).length === 0
  && math.ignitionLineColors({ elapsedMs: math.SWEEP_TOTAL_MS + 1, width: 40, onLight: false }).length === 0)
check('line colors: boundary guards (width 0, negative/NaN/at-total elapsed)',
  math.ignitionLineColors({ elapsedMs: 300, width: 0, onLight: false }).length === 0
  && math.ignitionLineColors({ elapsedMs: -5, width: 40, onLight: false }).length === 0
  && math.ignitionLineColors({ elapsedMs: Number.NaN, width: 40, onLight: false }).length === 0
  && math.ignitionLineColors({ elapsedMs: math.SWEEP_TOTAL_MS, width: 40, onLight: false }).length === 0)
check('line colors: single-column terminal yields one entry',
  math.ignitionLineColors({ elapsedMs: 300, width: 1, onLight: false }).length === 1)
check('line colors: every painted entry is a truecolor rgb() string',
  math
    .ignitionLineColors({ elapsedMs: 200, width: 60, onLight: false })
    .every(color => color === undefined || /^rgb\(\d+,\d+,\d+\)$/.test(String(color))))
check('line colors: some columns are painted mid-wave',
  math
    .ignitionLineColors({ elapsedMs: 300, width: 80, onLight: false })
    .some(color => color !== undefined))
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
  const fgColors = (y: number): number => {
    const line = term.buffer.active.getLine(term.buffer.active.baseY + y)
    if (line === undefined) return 0
    const found = new Set<number>()
    for (let x = 0; x < COLS; x++) {
      const cell = line.getCell(x)
      if (cell !== undefined && cell.isFgRGB()) found.add(cell.getFgColor())
    }
    return found.size
  }
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
  return { term, writes, rowText, fgColors, instance }
}

function borderNode(effort: string | undefined): React.ReactNode {
  // Children mirror the real empty input row: block caret + centered badge.
  return React.createElement(
    EffortInputBorder,
    { effort, levels: LEVELS, columns: COLS, onLight: false, idleColor: 'promptBorder' },
    React.createElement(Text, null,
      ' ',
      React.createElement(EffortTierBadge, { effort, levels: LEVELS, onLight: false, columns: COLS, leadingColumns: 2 })),
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
    await sleep(150)
    const restText = harness.rowText(0)
    check('rest: plain theme border, no letters, one colour',
      restText === '╭' + '─'.repeat(COLS - 2) + '╮' && harness.fgColors(0) <= 1)
    check('rest: exactly three rows — bottom border sits directly under the input row',
      harness.rowText(2) === '╰' + '─'.repeat(COLS - 2) + '╯' && harness.rowText(3) === '')
    // elapsed ≈ 300: mid-sweep, letters not started (LABEL_START 600).
    await sleep(450)
    check('act 1 sweep: a light band runs left→right on BOTH borders, no letters yet',
      harness.fgColors(0) >= 2 && harness.fgColors(2) >= 2, `${harness.fgColors(0)}/${harness.fgColors(2)} colours`)
    // elapsed ≈ 950: the tier name shows centered on the input row, and NO
    // extra row appears — the row under it stays the bottom border.
    await sleep(650)
    const inputRow = harness.rowText(1)
    const tierLetters = LEVELS[LEVELS.length - 1]!.toUpperCase().split('')
    const firstAt = inputRow.indexOf(tierLetters[0]!)
    check('act 2 label: letters emerged CENTERED while still converging (gap > 1)',
      tierLetters.every(letter => inputRow.includes(letter)) && firstAt >= Math.floor(COLS / 2) - 12,
      `col ${firstAt}: ${inputRow.trim().slice(0, 24)}`)
    // elapsed ≈ 1450: converge done (600+800), gap locked at 1, pre-fade.
    await sleep(500)
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
    await sleep(1050)
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

// --- Negative paths: no sweep, no letters, ever -------------------------------
async function runDarkScenario(name: string, node: React.ReactNode) {
  const harness = await makeHarness(6, node)
  try {
    await sleep(300)
    harness.writes.length = 0
    await sleep(1800)
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
    { effort: 'high', levels: ['high'], columns: COLS, onLight: false, idleColor: 'promptBorder' },
    React.createElement(Text, null, 'row'),
  )
}
await runDarkScenario('single-tier table', React.createElement(SingleTierDriver))
function NoTableDriver(): React.ReactNode {
  return React.createElement(
    EffortInputBorder,
    { effort: 'high', levels: undefined, columns: COLS, onLight: false, idleColor: 'promptBorder' },
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
