/**
 * yoga calculateLayout 帧耗时基准（_scratchGen 守卫的代价量化）。
 *
 * 场景与 verify-resize-temporal 相同的挂载方式，三个负载：
 *   steady  —— 纯流式追加 150 次 bump，无 resize（守卫应零开销）；
 *   storm   —— 40 次 88↔132 交替 resize，每次夹一个 bump（测量级联帧，
 *              守卫在这里付费）；
 *   final   —— 失败用例的完整回放（流式 + 周期 resize + finalize）。
 *
 * 每次 React commit 的 calculateLayout 通过包装 rootNode.onComputeLayout
 * 采样 ink.lastYogaCounters（ms / visited / cacheHits）。
 *
 * 运行：node --import tsx/esm scripts/bench-yoga.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'kitty'
process.env.DSH_TUI_THEME = 'dark'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }, { default: instances }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/ink/instances.js'),
])

const BASE_COLS = 108
const ROWS = 34
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function makeTerminal() {
  const term = new XTerm({ cols: BASE_COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  let lastFlushed: Promise<void> = Promise.resolve()
  class FakeStdout extends Writable {
    columns = BASE_COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
      lastFlushed = new Promise<void>(res => term.write(String(chunk), () => { cb(); res() }))
    }
  }
  const stdout = new FakeStdout() as any
  const stderr = (new (class extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } })()) as any
  const stdin = (new (class extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } })()) as any
  return { term, stdout, stderr, stdin, flush: () => lastFlushed }
}

function makeRows(): any[] {
  const rows: any[] = []
  let id = 0
  for (let t = 0; t < 40; t++) {
    rows.push({ id: id++, kind: 'user', text: '问题 ' + t + '：分析模块 ' + t + ' 的边界条件与失败模式' })
    rows.push({ id: id++, kind: 'assistant', text: '回答 ' + t + '：\n\n- 条件成立\n- 边界已覆盖\n- 结论稳定', streaming: false })
  }
  return rows
}

type Sample = { ms: number; visited: number; cacheHits: number; measured: number }

async function mountChat(rows: any[]) {
  const listeners = new Set<() => void>()
  const channel: any = {
    version: 0, rows, status: 'idle', sessionTitle: 'bench', agentId: 'x',
    model: 'deepseek-v4-flash', reasoningEffort: 'max',
    tokens: { input: 100, output: 40 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo',
    gitBranch: 'main', working: false, spinnerMode: 'requesting', responseChars: 0,
    activeToolCount: 0, turnStart: 0, lastUserText: rows[0].text,
    pending: [], commandList: [], notifications: [],
    mode: { plan: false }, effortLevels: undefined,
    subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
    submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
    listModels: () => Promise.resolve([]), listSessions: () => [],
    setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [],
  }
  const t = makeTerminal()
  await render(
    <AlternateScreen>
      <Chat channel={channel} questionStore={new QuestionStore()} />
    </AlternateScreen>,
    { stdout: t.stdout, stdin: t.stdin, stderr: t.stderr, exitOnCtrlC: false, patchConsole: false },
  )
  const ink: any = instances.get(t.stdout)
  if (!ink) throw new Error('Ink instance not found')
  ink.setAltScreenActive(true, true)
  const samples: Sample[] = []
  const orig = ink.rootNode.onComputeLayout
  ink.rootNode.onComputeLayout = () => {
    orig()
    const c = ink.lastYogaCounters
    if (c) samples.push({ ms: c.ms, visited: c.visited, cacheHits: c.cacheHits, measured: c.measured })
  }
  return {
    ...t,
    samples,
    bump: () => { channel.version++; for (const cb of listeners) (cb as () => void)() },
    unmount: () => ink.unmount(),
  }
}

function doResize(app: { stdout: any; term: typeof XTerm.prototype }, w: number, h: number) {
  app.stdout.columns = w
  app.stdout.rows = h
  app.term.resize(w, h)
  app.stdout.emit('resize')
}

function report(name: string, samples: Sample[]) {
  const ms = samples.map(s => s.ms).sort((a, b) => a - b)
  const sum = ms.reduce((a, b) => a + b, 0)
  const visited = samples.reduce((a, s) => a + s.visited, 0)
  const hits = samples.reduce((a, s) => a + s.cacheHits, 0)
  const measured = samples.reduce((a, s) => a + s.measured, 0)
  const pct = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))]!.toFixed(2)
  console.log(
    `${name}: frames=${samples.length} totalYoga=${sum.toFixed(1)}ms mean=${(sum / ms.length).toFixed(2)}ms ` +
    `p50=${pct(0.5)} p95=${pct(0.95)} max=${ms[ms.length - 1]!.toFixed(2)} ` +
    `visited=${visited} cacheHits=${hits} measured=${measured}`,
  )
}

// ---- steady：纯流式追加，无 resize ----
{
  const rows = makeRows()
  const streamRow: any = { id: 9999, kind: 'assistant', text: '', streaming: true }
  rows.push(streamRow)
  const app = await mountChat(rows)
  await sleep(1200); await app.flush()
  app.samples.length = 0
  for (let i = 0; i < 150; i++) {
    streamRow.text += '流式追加的内容片段，模拟正常输出。'
    app.bump()
    await sleep(8)
    await app.flush()
  }
  report('steady', app.samples)
  app.unmount()
  await sleep(120)
}

// ---- storm：交替 resize + bump ----
{
  const rows = makeRows()
  const streamRow: any = { id: 9999, kind: 'assistant', text: '一段初始内容。', streaming: true }
  rows.push(streamRow)
  const app = await mountChat(rows)
  await sleep(1200); await app.flush()
  app.samples.length = 0
  for (let i = 0; i < 40; i++) {
    doResize(app, i % 2 === 0 ? 88 : 132, ROWS)
    streamRow.text += '宽度变化下的追加。'
    app.bump()
    await sleep(25)
    await app.flush()
  }
  doResize(app, BASE_COLS, ROWS)
  await sleep(300); await app.flush()
  report('storm', app.samples)
  app.unmount()
  await sleep(120)
}

// ---- final：失败用例回放 ----
{
  const rows = makeRows()
  const streamRow: any = { id: 9999, kind: 'assistant', text: '', streaming: true }
  rows.push(streamRow)
  const app = await mountChat(rows)
  await sleep(1200); await app.flush()
  const STREAM_TEXT = '流式内容：第一段论述比较长，用来触发宽度变化下的重排。'.repeat(8) + '\n\n- 要点甲\n- 要点乙\n- 结论 TAILMARK-终'
  app.samples.length = 0
  for (let i = 0; i < 10; i++) {
    streamRow.text = STREAM_TEXT.slice(0, Math.floor((STREAM_TEXT.length * (i + 1)) / 10))
    app.bump()
    await sleep(40)
    if (i % 3 === 0) doResize(app, i % 2 === 0 ? 88 : 132, ROWS)
    await app.flush()
  }
  streamRow.text = STREAM_TEXT
  streamRow.streaming = false
  doResize(app, BASE_COLS, ROWS)
  app.bump()
  await sleep(600); await app.flush()
  report('final', app.samples)
  app.unmount()
}
process.exit(0)
