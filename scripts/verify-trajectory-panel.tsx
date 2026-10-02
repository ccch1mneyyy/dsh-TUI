/**
 * Trajectory side-panel regression: mounts TrajectoryPanel in a headless
 * XTerm (AlternateScreen, panel contexts wired through the REAL runtime
 * contract — PanelContext + SidePanelRuntimeContext with a stub dispatcher)
 * and locks the migrated behavior:
 *  - empty state copy (t('panel-trajectory-empty')) when the session has no
 *    trajectory yet;
 *  - with data: the wake band and ledger rows render inside the panel;
 *  - ↑/↓ move the selection through the dispatcher (usePanelInput);
 *  - Tab and → switch timeline ↔ hotspot (tab row flips its ● marker);
 *  - Enter expands the inspector in place (body lines grow);
 *  - Esc is NOT consumed (the host owns the return-to-chat key);
 *  - a real SGR mouse click on a ledger row moves the cursor there;
 *  - visible=false stops the animation clock (zero writes) while visible=true
 *    keeps ticking (live edge breathes);
 *  - narrow panels (28 / 40 columns) never overflow: tabs stay on row 0, the
 *    hint stays on the last row, the frame does not scroll.
 * Run: node --import tsx/esm scripts/verify-trajectory-panel.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { TrajectoryPanel }, contexts, trajApi, termTest] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/TrajectoryPanel.js'),
  import('../src/components/sidePanel/SidePanelRuntimeContext.js'),
  import('../src/dsh-adapter/trajectory/index.js'),
  import('./lib/term-test.mjs'),
])
const { render, ThemeProvider, AlternateScreen, Box, useInput } = ui
const { SidePanelRuntimeContext, PanelContext } = contexts
const { buildTrajectory } = trajApi
const { settled, sleep } = termTest

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

// ─── session fixture (a trimmed form of verify-trace-scene's sample) ─────────
const T0 = 1_700_000_000_000
let seq = 0
const ev = (type: string, data: unknown): Record<string, unknown> =>
  ({ type, seq: ++seq, time: T0 + ++seq * 250, data })
function sampleEvents(): Record<string, unknown>[] {
  seq = 0
  const out: Record<string, unknown>[] = []
  for (let turn = 1; turn <= 3; turn++) {
    out.push(ev('turn/start', { turn }))
    out.push(ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'prompt ' + turn }] }))
    out.push(ev('step/start', { turn, step: 1 }))
    out.push(ev('assistant/chunk', { turn, step: 1, chunk: {} }))
    out.push(ev('assistant/message', {
      turn, step: 1,
      message: { content: [{ type: 'text', text: 'reply about turn ' + turn }] },
      usage: { input: 200, output: 40, cacheRead: 10, cacheWrite: 0 },
    }))
    for (const name of ['read_file', 'grep_repo']) {
      const callId = 'c' + turn + '-' + name
      out.push(ev('tool/call', { turn, step: 1, callId, name, arguments: '{"path":"src/x.ts"}' }))
      out.push(ev('tool/result', {
        turn, step: 1,
        message: { source: { callId }, content: [{ type: 'text', text: name + ' produced output' }] },
        ...(turn === 2 && name === 'grep_repo' ? { error: { name: 'E', code: 'ENOENT' } } : {}),
      }))
    }
    out.push(ev('step/end', { turn, step: 1 }))
    out.push(ev('turn/end', { turn, reason: { kind: 'completed' } }))
  }
  return out
}
const EVENTS = sampleEvents()
/** Same session plus one tool still in flight: the wake gains a live edge
 * (▶) whose breath animation proves the motion clock is running. */
const LIVE_EVENTS = [
  ...EVENTS,
  { type: 'turn/start', seq: 9000, time: T0 + 9_000_000, data: { turn: 4 } },
  { type: 'step/start', seq: 9001, time: T0 + 9_000_100, data: { turn: 4, step: 1 } },
  { type: 'tool/call', seq: 9002, time: T0 + 9_000_200, data: { turn: 4, step: 1, callId: 'live', name: 'long_task', arguments: '{}' } },
]

// ─── fake channel + runtime dispatcher (the v2.1 panel contract) ─────────────
const channel = {
  sessionTitle: 'probe',
  cwd: 'C:/code/demo',
  traceEvents: () => LIVE_EVENTS,
  subscribe: () => () => {},
} as never

const registered = new Map<string, { h: (input: string, key: Record<string, boolean | undefined>) => boolean | void; enabled: boolean }>()
const runtime = {
  registerInput: (id: string, handler: never, enabled: boolean) => {
    registered.set(id, { h: handler, enabled })
    return () => { registered.delete(id) }
  },
  dispatchKey: (id: string, input: string, key: Record<string, boolean | undefined>): boolean => {
    const entry = registered.get(id)
    if (entry === undefined || !entry.enabled) return false
    return entry.h(input, key) === true
  },
}

// Mutable harness state (props/context) so sections can flip them + bump.
const props = { width: 44, height: 24, focused: true, visible: true, trajectory: undefined as undefined | ReturnType<typeof buildTrajectory> }
let lastConsumed: boolean | undefined

function Harness(): React.ReactNode {
  const [, bump] = React.useState(0)
  React.useEffect(() => { const id = setInterval(() => bump(p => p + 1), 1_000_000); return () => clearInterval(id) }, [])
  useInput((input: string, key: Record<string, boolean | undefined>) => {
    lastConsumed = runtime.dispatchKey('trajectory', input, { ...key, return_: key.return } as never)
    bump(p => p + 1)
  })
  return (
    <SidePanelRuntimeContext.Provider value={{ runtime: runtime as never, channel, trajectory: props.trajectory }}>
      <PanelContext.Provider value={{ panelId: 'trajectory' }}>
        <Box width={props.width} height={props.height}>
          <TrajectoryPanel width={props.width} height={props.height} focused={props.focused} visible={props.visible} mode="split" />
        </Box>
      </PanelContext.Provider>
    </SidePanelRuntimeContext.Provider>
  )
}

async function makeApp(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  const writes: string[] = []
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void { writes.push(String(chunk)); term.write(String(chunk), cb) }
  }
  class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
  class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this } ref() { return this } unref() { return this } }
  const stdin = new FakeStdin()
  const app = await render(
    <AlternateScreen mouseTracking={true}>
      <ThemeProvider theme="dark">
        <Harness />
      </ThemeProvider>
    </AlternateScreen>,
    {
      stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  const lines = (): string[] => {
    const buf = term.buffer.active
    return Array.from({ length: rows }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(false) ?? '')
  }
  return { term, writes, stdin, app, lines }
}

/** stdin 双写合并坑：一个键写完让出一轮事件循环再写下一个。 */
const writeKey = async (stdin: PassThrough, data: string): Promise<void> => {
  stdin.write(data)
  await new Promise(resolve => setImmediate(resolve))
}
const pointerRow = (lines: string[]): string => (lines.find(l => l.includes('▸')) ?? '').trim()

async function fresh(cols: number, rows: number, withData: boolean): Promise<ReturnType<typeof makeApp>> {
  props.width = cols
  props.height = rows
  props.focused = true
  props.visible = true
  props.trajectory = withData ? buildTrajectory(LIVE_EVENTS as never) : undefined
  return makeApp(cols, rows)
}

try {
  // ── 1. empty state ────────────────────────────────────────────────────────
  {
    const m = await fresh(44, 24, false)
    await settled(() => m.lines().some(l => l.includes('No trajectory yet')))
    const ls = m.lines()
    check('empty: panel-trajectory-empty copy renders', ls.some(l => l.includes('No trajectory yet')))
    check('empty: hint line renders', ls.some(l => l.includes('↑/↓')), (ls.find(l => l.includes('↑/↓')) ?? '').trim())
    await m.app.unmount()
    m.term.dispose()
  }

  // ── 2. data: wake band + ledger rows ──────────────────────────────────────
  const m = await fresh(44, 24, true)
  await settled(() => m.lines().some(l => l.includes('read_file')) && m.lines().some(l => l.includes('▸')))
  {
    const ls = m.lines()
    check('data: ledger rows render in the panel', ls.some(l => l.includes('read_file')) && ls.some(l => l.includes('grep_repo')))
    check('data: tabs row shows both views', ls[0]!.includes('Timeline') && ls[0]!.includes('Hotspot'), ls[0]!.trim())
    // The wake: block/idle glyphs plus the live edge ▶ on row 1.
    check('data: the wake band renders (glyphs + live edge)', /['_·░▁▂▃▄▅▆▇█]/.test(ls[1] ?? '') && (ls[1] ?? '').includes('▶'), (ls[1] ?? '').trim())
  }

  // ── 3. ↑/↓ move the selection (dispatcher path) ───────────────────────────
  const before = pointerRow(m.lines())
  await writeKey(m.stdin, '\u001b[A')
  await settled(() => pointerRow(m.lines()) !== before, { timeout: 3000 })
  const after = pointerRow(m.lines())
  check('keys: upArrow moves the selection (usePanelInput dispatch)', after !== '' && after !== before, before + ' → ' + after)
  await writeKey(m.stdin, '\u001b[B')
  await settled(() => pointerRow(m.lines()) === before, { timeout: 3000 })
  check('keys: downArrow moves it back', pointerRow(m.lines()) === before, pointerRow(m.lines()))

  // ── 4. Tab switches views; ←/→ stay the host's panel-cycling keys ────────
  await writeKey(m.stdin, '\t')
  await settled(() => m.lines()[0]!.includes('● Hotspot') && m.lines().some(l => l.includes('Tools')), { timeout: 3000 })
  check('keys: Tab switches to the hotspot view (tab marker flips)', m.lines()[0]!.includes('● Hotspot') && m.lines().some(l => l.includes('Tools')), m.lines()[0]!.trim())
  check('view: hotspot sections render', m.lines().some(l => l.includes('Model')) && m.lines().some(l => l.includes('Turns')))
  await writeKey(m.stdin, '\t')
  await settled(() => m.lines()[0]!.includes('● Timeline'), { timeout: 3000 })
  check('keys: Tab toggles back to the timeline', m.lines()[0]!.includes('● Timeline') && m.lines()[0]!.includes('○ Hotspot'), m.lines()[0]!.trim())
  // ←/→ 归宿主（切面板）：面板不得消费（用户实测诉求，v2.1 键盘契约）。
  lastConsumed = undefined
  await writeKey(m.stdin, '\u001b[C')
  await sleep(50) // 固定窗:pacing 按键分发后需要一个渲染帧让 dispatchKey 落账
  check('keys: rightArrow is yielded to the host (panel cycling)', lastConsumed === false, String(lastConsumed))

  // ── 5. Enter expands the inspector in place ───────────────────────────────
  // 检视器头（▎）钉在「hint 上方 inspectorRows 行」处：展开时 ledger 让位、
  // 头上移——用头所在行号判定比数缩进行稳（空行填充会稀释缩进计数）。
  const headerRow = (): number => m.lines().findIndex(l => l.includes('▎'))
  const collapsedRow = headerRow()
  await writeKey(m.stdin, '\r')
  await settled(() => headerRow() < collapsedRow, { timeout: 3000 })
  check('keys: Enter expands the inspector (header moves up)', headerRow() < collapsedRow, collapsedRow + ' → ' + headerRow())
  check('expanded: inspector body fills the freed rows', m.lines().slice(headerRow() + 1, collapsedRow).some(l => l.trim() !== ''), 'rows ' + (headerRow() + 1) + '..' + collapsedRow)
  await writeKey(m.stdin, '\r')
  await settled(() => headerRow() === collapsedRow, { timeout: 3000 })
  check('keys: Enter again collapses it', headerRow() === collapsedRow, String(headerRow()))

  // ── 6. Esc is NOT consumed ────────────────────────────────────────────────
  lastConsumed = undefined
  await writeKey(m.stdin, '\u001b')
  await sleep(50) // 固定窗:pacing Esc 归一后需要一个渲染帧让 dispatchKey 落账
  check('keys: Esc is yielded to the host (not consumed)', lastConsumed === false, String(lastConsumed))

  // ── 7. SGR mouse click on a ledger row moves the cursor ───────────────────
  const findCell = (needle: string): { col: number; row: number } | null => {
    const ls = m.lines()
    for (let y = 0; y < ls.length; y++) {
      const col = ls[y]!.indexOf(needle)
      if (col >= 0) return { col, row: y }
    }
    return null
  }
  const cell = findCell('grep_repo')
  check('click: target ledger row on screen', cell !== null)
  if (cell !== null) {
    await writeKey(m.stdin, '\u001b[<0;' + (cell.col + 1) + ';' + (cell.row + 1) + 'M')
    await writeKey(m.stdin, '\u001b[<0;' + (cell.col + 1) + ';' + (cell.row + 1) + 'm')
    await settled(() => pointerRow(m.lines()).includes('grep_repo'), { timeout: 3000 })
    check('click: SGR press on a ledger row focuses it', pointerRow(m.lines()).includes('grep_repo'), pointerRow(m.lines()))
  }

  // ── 8. visible=true keeps the motion clock ticking ────────────────────────
  await settled(() => m.writes.length > 0)
  const tickStart = m.writes.length
  await sleep(500) // 固定窗:探针 采样两个以上 MOTION_TICK(100ms)的写流增量
  check('motion: visible=true keeps ticking (live edge breathes)', m.writes.length > tickStart, (m.writes.length - tickStart) + ' writes')

  // ── 9. visible=false stops the clock (zero writes) ────────────────────────
  props.visible = false
  // 触发一次重渲染（写一个 host 键，harness bump 即重挂 props）。
  await writeKey(m.stdin, 'z')
  await sleep(150) // 固定窗:pacing 让 visible=false 的重渲染落定后再开始零写采样
  const frozenAt = m.writes.length
  await sleep(450) // 固定窗:探针 足够 4 个 MOTION_TICK——任何残留订阅都会在这里写出
  check('motion: visible=false writes nothing (animation stopped)', m.writes.length === frozenAt, (m.writes.length - frozenAt) + ' writes')
  check('motion: content still rendered while invisible (state kept)', m.lines().some(l => l.includes('read_file')))
  await m.app.unmount()
  m.term.dispose()

  // ── 10. narrow widths never overflow ─────────────────────────────────────
  for (const cols of [28, 40]) {
    const n = await fresh(cols, 20, true)
    await settled(() => n.lines().some(l => l.includes('read_file')) && (n.lines()[19] ?? '').includes('↑/↓'), { timeout: 4000 })
    const ls = n.lines()
    const baseY = n.term.buffer.active.baseY
    check('narrow ' + cols + ': tabs stay on row 0', /^[●○]/.test(ls[0]!.trimStart()), ls[0]!.trim())
    check('narrow ' + cols + ': hint stays pinned to the last row', (ls[19] ?? '').includes('↑/↓'), (ls[19] ?? '').trim())
    check('narrow ' + cols + ': frame does not scroll (no wrapped overflow)', baseY === 0, 'baseY=' + baseY)
    check('narrow ' + cols + ': wake band renders', /['_·░▁▂▃▄▅▆▇█▶]/.test(ls[1] ?? ''), (ls[1] ?? '').trim())
    await n.app.unmount()
    n.term.dispose()
  }
} finally {
  if (failed > 0) {
    // 最后一帧打给 stderr，CI 日志里能直接看到断言看到的那一屏。
  }
  // (每个用例段自己 unmount；这里没有共享 app。)
}

if (failed > 0) {
  console.error('FAILED: ' + failed + ' check(s).')
  process.exit(1)
}
console.log('OK: trajectory panel all checks passed.')
process.exit(0)
