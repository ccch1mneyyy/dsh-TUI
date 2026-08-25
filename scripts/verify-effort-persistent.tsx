/**
 * Persistent effort-label regression.
 *
 * Mounts the real status-line label on a deterministic shared clock. The checks
 * pin max/ultra motion, high/xhigh static behavior, hidden/unmount cleanup,
 * fixed cell width, and the absence of terminal scrolling while frames change.
 *
 * Run: node --import tsx/esm scripts/verify-effort-persistent.tsx
 */
process.env.FORCE_COLOR = '3'

const [
  { readFile },
  { Writable, PassThrough },
  React,
  { Terminal: XTerm },
  { render, ThemeProvider },
  { ClockContext },
  { PersistentEffortLabel },
  { StatusLine },
] = await Promise.all([
  import('node:fs/promises'),
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/ink/components/ClockContext.js'),
  import('../src/components/PersistentEffortLabel.js'),
  import('../src/screens/StatusLine.js'),
])

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail === '' ? '' : ` (${detail})`}`)
  if (!ok) failures++
}

const COLS = 24
const ROWS = 3

const source = await readFile(new URL('../src/components/PersistentEffortLabel.tsx', import.meta.url), 'utf8')
const frameMatch = /const FRAME_MS = (\d+)/u.exec(source)
const frameMs = Number(frameMatch?.[1])
check('source: persistent animation gates React frames to 100–125ms',
  Number.isFinite(frameMs) && frameMs >= 100 && frameMs <= 125, `FRAME_MS=${String(frameMs)}`)
check('source: persistent label never mutates the shared clock or owns an interval',
  !source.includes('setTickInterval') && !source.includes('setInterval('))

type ManualClock = {
  now: () => number
  subscribe: (fn: () => void, keepAlive: boolean) => () => void
  setTickInterval: (_ms: number) => void
  advance: (ms: number) => void
  subscriptions: () => number
}
function createManualClock(): ManualClock {
  let now = 0
  const listeners = new Set<() => void>()
  return {
    now: () => now,
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    setTickInterval() {},
    advance(ms) {
      now += ms
      for (const listener of [...listeners]) listener()
    },
    subscriptions: () => listeners.size,
  }
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 100, allowProposedApi: true })
const writes: string[] = []
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    const text = String(chunk)
    writes.push(text)
    term.write(text, callback)
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

const clock = createManualClock()
let setEffort: React.Dispatch<React.SetStateAction<string>> = () => {}
let setVisible: React.Dispatch<React.SetStateAction<boolean>> = () => {}
function Driver(): React.ReactNode {
  const [effort, updateEffort] = React.useState('high')
  const [visible, updateVisible] = React.useState(true)
  setEffort = updateEffort
  setVisible = updateVisible
  return (
    <ThemeProvider theme="dark">
      <ClockContext.Provider value={clock}>
        {visible ? <PersistentEffortLabel effort={effort} /> : null}
      </ClockContext.Provider>
    </ThemeProvider>
  )
}

const instance = await render(<Driver />, {
  stdout: new FakeStdout() as never,
  stdin: new FakeStdin() as never,
  stderr: new FakeStdout() as never,
  exitOnCtrlC: false,
  patchConsole: false,
})
const settle = async (): Promise<void> => { await sleep(45) }
const set = async (effort: string): Promise<void> => {
  setEffort(effort)
  await settle()
}
const show = async (visible: boolean): Promise<void> => {
  setVisible(visible)
  await settle()
}
const advance = async (ms: number): Promise<void> => {
  clock.advance(ms)
  await settle()
}
const line = (): string =>
  term.buffer.active.getLine(term.buffer.active.baseY)?.translateToString(true) ?? ''
const colors = (): string[] => {
  const row = term.buffer.active.getLine(term.buffer.active.baseY)
  if (row === undefined) return []
  return Array.from({ length: line().trimEnd().length }, (_, x) => {
    const cell = row.getCell(x)
    if (cell?.isFgRGB()) return `rgb:${cell.getFgColor()}`
    if (cell?.isFgPalette()) return `ansi:${cell.getFgColor()}`
    return 'default'
  })
}
const stable = (effort: string, baseY: number): boolean =>
  line().trimEnd() === effort && effort.length === Array.from(effort).length && term.buffer.active.baseY === baseY
const hasScroll = (stream: string): boolean =>
  /\x1b\[\d*[ST]/u.test(stream)
  || /\x1b\[(?:\d+;)?\d*[rLM]/u.test(stream)

try {
  await settle()
  const startBaseY = term.buffer.active.baseY
  const high = colors()
  check('high: steady label is static and owns no shared-clock subscription',
    line().trimEnd() === 'high' && high.length === 4 && clock.subscriptions() === 0)
  writes.length = 0
  await advance(1440)
  check('high: advancing the shared clock does not repaint the static tier',
    colors().join(',') === high.join(',') && writes.length === 0 && stable('high', startBaseY))

  await set('xhigh')
  const xhigh = colors()
  check('xhigh: steady label is static and owns no shared-clock subscription',
    line().trimEnd() === 'xhigh' && xhigh.length === 5 && clock.subscriptions() === 0)
  writes.length = 0
  await advance(1440)
  check('xhigh: advancing the shared clock leaves color and width unchanged',
    colors().join(',') === xhigh.join(',') && writes.length === 0 && stable('xhigh', startBaseY))

  await set('max')
  const max0 = colors()
  check('max: visible label owns exactly one shared-clock subscription',
    line().trimEnd() === 'max' && max0.length === 3 && new Set(max0).size > 1 && clock.subscriptions() === 1,
    `${JSON.stringify(line())} colors=${max0.join(',')} subscriptions=${clock.subscriptions()}`)
  writes.length = 0
  const maxFrames: string[][] = [max0]
  for (let index = 0; index < 16 && maxFrames.at(-1)?.join(',') === max0.join(','); index++) {
    await advance(frameMs)
    maxFrames.push(colors())
  }
  const max1 = maxFrames.at(-1) ?? []
  check('max: shared-clock progress moves the gated shimmer without changing geometry',
    max1.join(',') !== max0.join(',') && stable('max', startBaseY),
    `${max0.join(',')}→${max1.join(',')} across ${maxFrames.length - 1} gated frame(s)`)
  check('max frames: steady shimmer emits no terminal scroll controls', !hasScroll(writes.join('')))

  await set('ultra')
  const ultra0 = colors()
  check('ultra: switching animated tiers keeps a single shared-clock owner',
    line().trimEnd() === 'ultra' && ultra0.length === 5 && new Set(ultra0).size > 2 && clock.subscriptions() === 1)
  writes.length = 0
  await advance(frameMs)
  const ultra1 = colors()
  check('ultra: shared-clock progress rotates the rainbow without changing width',
    ultra1.join(',') !== ultra0.join(',') && stable('ultra', startBaseY))
  check('frames: max/ultra animation emits no terminal scroll controls', !hasScroll(writes.join('')))

  await show(false)
  check('hidden: removing the status label cancels its clock subscription',
    clock.subscriptions() === 0 && line().trim() === '',
    `line=${JSON.stringify(line())} subscriptions=${clock.subscriptions()}`)
  writes.length = 0
  await advance(840)
  check('hidden: shared-clock progress produces no hidden repaint or scroll',
    writes.length === 0 && !hasScroll(writes.join('')))

  await show(true)
  check('reshow: animated status label reacquires one subscription at stable width',
    clock.subscriptions() === 1 && stable('ultra', startBaseY),
    `line=${JSON.stringify(line())} baseY=${term.buffer.active.baseY} subscriptions=${clock.subscriptions()}`)
} finally {
  instance.unmount()
  await settle()
  check('cleanup: unmount releases the persistent shared-clock subscription', clock.subscriptions() === 0)
  term.dispose()
}

{
  const screen = new XTerm({ cols: 60, rows: 5, scrollback: 100, allowProposedApi: true })
  const output: string[] = []
  class StatusOutput extends Writable {
    columns = 60
    rows = 5
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      const text = String(chunk)
      output.push(text)
      screen.write(text, callback)
    }
  }
  const statusClock = createManualClock()
  let setThinking: React.Dispatch<React.SetStateAction<boolean>> = () => {}
  const statusBar = {
    compact: true,
    model: false,
    thinking: true,
    cwd: false,
    contextUsage: false,
    cache: false,
    tokens: false,
    tps: false,
    gitBranch: false,
    sessionTitle: false,
    sessionId: false,
    goal: false,
    mode: false,
    contextBar: false,
    activity: false,
    trajectory: false,
    shortcutHint: false,
  }
  const channel = {
    minimal: false,
    statusBar,
    reasoningEffort: 'ultra',
    lastUsage: undefined,
    contextWindow: undefined,
    modeIndex: 0,
    mode: { id: 'default', plan: false },
    model: 'probe',
    tokens: { input: 0, output: 0 },
    tps: undefined,
    tpsSamples: [],
    working: false,
    gitBranch: '',
    displayCwd: '',
    sessionTitle: '',
    agentId: 'persistent-probe',
    goal: undefined,
    workingActivity: undefined,
    activityFrames: [],
    contextBarEnabled: false,
    contextSegments: {},
  }
  function StatusDriver(): React.ReactNode {
    const [thinking, update] = React.useState(true)
    setThinking = update
    return (
      <ThemeProvider theme="dark">
        <ClockContext.Provider value={statusClock}>
          <StatusLine channel={{ ...channel, statusBar: { ...statusBar, thinking } } as never} />
        </ClockContext.Provider>
      </ThemeProvider>
    )
  }
  const status = await render(<StatusDriver />, {
    stdout: new StatusOutput() as never,
    stdin: new FakeStdin() as never,
    stderr: new StatusOutput() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  try {
    await settle()
    check('StatusLine: visible max/ultra effort field owns one shared-clock subscription',
      statusClock.subscriptions() === 1)
    setThinking(false)
    await settle()
    check('StatusLine: hiding the thinking field cancels the persistent subscription',
      statusClock.subscriptions() === 0)
    output.length = 0
    statusClock.advance(840)
    await settle()
    check('StatusLine: a hidden effort field cannot repaint or scroll',
      output.length === 0 && !hasScroll(output.join('')))
  } finally {
    status.unmount()
    await settle()
    check('StatusLine cleanup: unmount leaves no persistent clock owner', statusClock.subscriptions() === 0)
    screen.dispose()
  }
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
