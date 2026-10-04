/**
 * Jobs progress-detail + bounded-timeline regression (info-display design
 * §D): the store's own increments on top of the existing mirror —
 *
 *  - the producer's LAST progress line survives settle (with observation
 *    time; source = the producer kind the row already names), while the
 *    live roster chip keeps its existing clear-at-settle contract;
 *  - a bounded observation ring records started/progress/output-drain/gap/
 *    stopping/settled in arrival order, caps at JOBS_MAX_TIMELINE by
 *    dropping the OLDEST entries, and counts gaps (never estimating the
 *    bytes behind one);
 *  - no second reader exists: output events come from the SAME readAt
 *    drains the mirror already performs (plus the job_output fallback
 *    feed) — nothing polls.
 *
 * Store-level (the production BackgroundJobStore) plus a panel render pass
 * proving the focused detail actually paints the progress meta, the
 * retained-tail note and the timeline slice. Exits non-zero on failure.
 */
import assert from 'node:assert/strict'

const [{ BackgroundJobStore }, { default: React }, { render }, { Writable, PassThrough }, { Terminal: XTerm }, { JobsPanel }, { setLang }, { settled }] = await Promise.all([
  import('../src/dsh-adapter/jobs.js'),
  import('react'),
  import('../src/ui.js'),
  import('node:stream'),
  import('@xterm/headless'),
  import('../src/components/JobsPanel.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
])

/** JobsPanel registers useInput — a raw-mode stdin stub is part of the
 * mount contract (same shape verify-jobs-panel uses). */
class Input extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

process.env.DSH_TUI_LANG = 'zh'
setLang('zh')

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

const snap = (over: Record<string, unknown> = {}) => ({
  id: 'pwsh-1', kind: 'pwsh', label: 'build', status: 'running', startedAt: 1000, ...over,
})

// ── 1. Progress retention across settle ──────────────────────────────────
{
  const store = new BackgroundJobStore()
  store.replace([snap()])
  store.replace([snap({ progress: '3/10' })])
  store.replace([snap({ progress: 'phase two' })])
  const job = store.get('pwsh-1')!
  check('1a. 最近进度保留', job.lastProgress === 'phase two')
  check('1b. 观测时间已记', typeof job.lastProgressAt === 'number')
  store.replace([snap({ status: 'completed', finishedAt: 9000, detail: 'exit code: 0' })])
  const settled = store.get('pwsh-1')!
  check('1c. settle 后最近进度仍在（live 契约不变：progress 清空）', settled.lastProgress === 'phase two' && settled.progress === undefined)
  const kinds = settled.timeline?.map(event => event.kind)
  check('1d. 时间线含 started→progress→progress→settled', JSON.stringify(kinds) === JSON.stringify(['started', 'progress', 'progress', 'settled']))
  check('1e. settled 事件带终态 detail', settled.timeline?.[3]?.text === 'exit code: 0')
}

// ── 2. Output drains + gaps from the readAt path (no second reader) ──────
{
  const store = new BackgroundJobStore()
  store.replace([snap({ output: { total: 0, earliest: 0 } })])
  store.onKernelOutput('pwsh-1', { chunks: [{ at: 0, text: 'hello\n' }], next: 6 }, 2000)
  store.onKernelOutput('pwsh-1', { chunks: [{ at: 6, text: 'world\n', channel: 'stderr' }], next: 12 }, 3000)
  store.onKernelOutput('pwsh-1', { chunks: [{ at: 100, text: 'after\n', gapBefore: true }], next: 106, lossy: true }, 4000)
  const job = store.get('pwsh-1')!
  const outputs = job.timeline?.filter(event => event.kind === 'output') ?? []
  check('2a. 每次 drain 一条 output 事件（字节推进）', outputs.length === 3 && outputs[0]?.bytes === 6 && outputs[1]?.bytes === 6)
  check('2b. 带 channel 的 drain 记 channel', outputs[1]?.channel === 'stderr')
  check('2c. 缺口计数（不估字节）', job.gapCount === 1)
  const kinds = job.timeline?.map(event => event.kind)
  check('2d. 缺口事件落在输出流位置上', JSON.stringify(kinds) === JSON.stringify(['started', 'output', 'output', 'gap', 'output']))
}

// ── 3. job_output fallback feed also records ─────────────────────────────
{
  const store = new BackgroundJobStore()
  store.replace([snap()])
  store.onOutputSeen('pwsh-1', 'line1\nline2', 2500)
  const job = store.get('pwsh-1')!
  const outputs = job.timeline?.filter(event => event.kind === 'output') ?? []
  check('3. job_output 镜像也进时间线（字节=文本长度）', outputs.length === 1 && outputs[0]?.bytes === 11)
}

// ── 4. Ring bound: oldest dropped, never grows unbounded ─────────────────
{
  const store = new BackgroundJobStore()
  store.replace([snap()])
  for (let index = 0; index < 60; index++) {
    store.replace([snap({ progress: `step-${index}` })])
  }
  const job = store.get('pwsh-1')!
  check('4a. 时间线封顶 40', (job.timeline?.length ?? 0) === 40)
  check('4b. 丢的是最旧事件', job.timeline?.[0]?.text === 'step-20')
}

// ── 5. Vanished-while-live keeps a settled observation ───────────────────
{
  const store = new BackgroundJobStore()
  store.replace([snap()])
  store.replace([])
  const job = store.get('pwsh-1')!
  check('5. 消失的存活任务记 killed 收尾', job.status === 'killed' && job.timeline?.[job.timeline.length - 1]?.kind === 'settled')
}

// ── 6. Panel detail renders the increments ───────────────────────────────
{
  // Tall viewport: the focused detail renders the whole retained tail (30
  // lines) plus the timeline — a 40-row screen would push the timeline below
  // the fold and the assertion would test the scroll, not the render.
  const cols = 90
  const rows = 80
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  const store = new BackgroundJobStore()
  store.replace([snap({ output: { total: 0, earliest: 0 } })])
  store.replace([snap({ progress: '7/20', output: { total: 0, earliest: 0 } })])
  store.onKernelOutput('pwsh-1', { chunks: [{ at: 0, text: 'building…\n' }], next: 11 }, 2500)
  const lines = Array.from({ length: 30 }, (_, i) => ({ text: `out-${i}` }))
  const job = store.get('pwsh-1')!
  const capped = { ...job, outputLines: lines, outputTotalBytes: 11 }
  const app = await render(
    React.createElement(JobsPanel, {
      jobs: [capped],
      onKill: () => undefined,
      initialFocusId: 'pwsh-1',
    }),
    { stdout: new FakeStdout(), stdin: new Input() as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false },
  )
  const ok = await settled((): boolean => {
    const buf = term.buffer.active
    const screen: string[] = []
    for (let y = 0; y < buf.length; y++) screen.push(buf.getLine(y)?.translateToString(true) ?? '')
    return screen.some(line => line.includes('时间线'))
  })
  const buf = term.buffer.active
  const screen: string[] = []
  for (let y = 0; y < buf.length; y++) screen.push(buf.getLine(y)?.translateToString(true) ?? '')
  const text = screen.join('\n')
  check('6a. 详情渲染最近进度行', ok && text.includes('7/20') && text.includes('更新') && text.includes('来源 pwsh'))
  check('6b. 保留尾巴如实标注', text.includes('仅保留最近 30 行'))
  check('6c. 时间线上屏（含启动与输出增量）', text.includes('启动') && text.includes('+11 B'))
  check('6d. 时间线标题带「最近」限定', text.includes('时间线（最近）'))
  app.unmount()
}

// ── 7. Empty timeline renders the honest unavailable note, not fiction ───
{
  const cols = 90
  const rows = 30
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  // A roster entry the store never observed live (resumed session shape):
  // constructed directly, no timeline field.
  const resumed = {
    id: 'bash-9', kind: 'bash', label: 'old job', status: 'completed', startedAt: 1,
    finishedAt: 2, outputLines: [{ text: 'tail' }],
  }
  const app = await render(
    React.createElement(JobsPanel, { jobs: [resumed], onKill: () => undefined, initialFocusId: 'bash-9' }),
    { stdout: new FakeStdout(), stdin: new Input() as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false },
  )
  const ok = await settled((): boolean => {
    const buf = term.buffer.active
    for (let y = 0; y < buf.length; y++) {
      if ((buf.getLine(y)?.translateToString(true) ?? '').includes('时间线不可用')) return true
    }
    return false
  })
  check('7. 无观测历史的任务标注时间线不可用', ok)
  app.unmount()
}

console.log(results.join('\n'))
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exitCode = failures === 0 ? 0 : 1
