/**
 * 后台任务（ctx.jobs）UI 投影回归：/jobs 面板、转录任务卡、状态栏角标、完成 toast。
 *
 * Group A — BackgroundJobStore 单元（无渲染）：
 *   注册/转换/消失合成 killed、onSettled 恰好一次、输出镜像过滤与有界、时长格式化。
 * Group B — channel 集成（真实 cordis Context + 假 agents/jobs 服务）：
 *   任务注册建卡、job_output 结果镜像进瀑布、落定 toast、存活任务消失冻结、
 *   jobControl.kill 权限传递、无 jobs 服务降级、/new 重置投影。
 * Group C — 渲染冒烟（headless xterm）：
 *   JobCard 运行态三行瀑布（有输出时）/仅头行（无输出时）、settled 折叠、JobsPanel 标题/行/提示。
 *
 * 运行：node --import tsx/esm scripts/verify-jobs-panel.tsx
 */
process.env.DSH_TUI_LANG = 'en'
process.env.FORCE_COLOR = '3'

// 家目录隔离：channel 构造路径会 touch 用户目录，先切临时目录再 import。
const { mkdtempSync, mkdirSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join: joinPath } = await import('node:path')
const isolatedHome = mkdtempSync(joinPath(tmpdir(), 'dshtui-jobs-panel-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
mkdirSync(joinPath(isolatedHome, '.dsh-tui'), { recursive: true })

const [
  { Context },
  { createChannel },
  { BackgroundJobStore, formatJobDuration, JOBS_MAX_TRACKED, JOBS_MAX_OUTPUT_LINES },
  { settled, sleep },
  React,
  { render },
  { JobCard },
  { JobsPanel },
] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/jobs.js'),
  import('./lib/term-test.mjs'),
  import('react'),
  import('../src/ui.js'),
  import('../src/components/Chat/JobCard.js'),
  import('../src/components/JobsPanel.js'),
])
const { Writable, PassThrough } = await import('node:stream')
const { Terminal: XTerm } = (await import('@xterm/headless')) as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal
}

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// ---------------------------------------------------------------------------
// Group A — BackgroundJobStore 单元
// ---------------------------------------------------------------------------
console.log('--- A: BackgroundJobStore units ---')
{
  const settledJobs: string[] = []
  let changes = 0
  const store = new BackgroundJobStore({
    onSettled: job => settledJobs.push(`${job.id}:${job.status}`),
    onChanged: () => { changes += 1 },
  })
  const snap = (id: string, status: 'running' | 'completed', extra: Record<string, unknown> = {}) =>
    ({ id, kind: 'pwsh', label: `cmd ${id}`, status, startedAt: 1000, ...extra })

  store.replace([snap('pwsh-1', 'running'), snap('pwsh-2', 'running')])
  check('A1 注册两个任务', store.snapshot().length === 2 && changes === 1)
  const changesAfterNoop = changes
  store.replace([snap('pwsh-1', 'running'), snap('pwsh-2', 'running')])
  check('A1 无变化 replace 不触发事件', changes === changesAfterNoop)

  store.replace([snap('pwsh-1', 'completed', { detail: 'exit code: 0', finishedAt: 5000 }), snap('pwsh-2', 'running')])
  check('A2 running→completed 触发一次 onSettled', settledJobs.join(',') === 'pwsh-1:completed', settledJobs.join(','))
  store.replace([snap('pwsh-1', 'completed', { detail: 'exit code: 0', finishedAt: 5000 }), snap('pwsh-2', 'running')])
  check('A2 重复终态不重复触发', settledJobs.length === 1)

  // 存活任务从 list 消失（owner 处置/会话切换）→ 冻结为 killed 并保留为历史。
  store.replace([snap('pwsh-1', 'completed', { detail: 'exit code: 0', finishedAt: 5000 })])
  check('A3 存活任务消失合成 killed', settledJobs.join(',') === 'pwsh-1:completed,pwsh-2:killed', settledJobs.join(','))
  check('A3 消失任务冻结保留在快照', store.get('pwsh-2')?.status === 'killed')

  store.onOutputSeen('pwsh-1', 'line A\n\nline B  \n[status: completed, exit code: 0]')
  const job1 = store.get('pwsh-1')
  check(
    'A4 镜像输出去空行 + 去 [status:] 尾缀',
    job1?.outputLines.join('|') === 'line A|line B',
    JSON.stringify(job1?.outputLines),
  )
  store.onOutputSeen('pwsh-1', Array.from({ length: 40 }, (_, i) => `tail ${i}`).join('\n'))
  check(
    'A4 输出尾部有界',
    job1?.outputLines.length === JOBS_MAX_OUTPUT_LINES && job1?.outputLines.at(-1) === 'tail 39',
    `len=${job1?.outputLines.length}`,
  )
  store.onOutputSeen('unknown-job', 'x')
  check('A4 未知任务镜像被忽略', store.get('unknown-job') === undefined)

  const big = new BackgroundJobStore()
  big.replace(
    Array.from({ length: JOBS_MAX_TRACKED + 10 }, (_, i) => ({
      id: `bash-${i}`, kind: 'bash', label: 'x', status: i < 5 ? 'running' as const : 'completed' as const, startedAt: i, finishedAt: i + 1,
    })),
  )
  const remaining = big.snapshot()
  check(
    'A5 终态有界且存活全保留',
    remaining.length <= JOBS_MAX_TRACKED && remaining.filter(job => job.status === 'running').length === 5,
    `len=${remaining.length}`,
  )

  check(
    'A6 时长格式化',
    formatJobDuration({ startedAt: 0, finishedAt: 3000 }) === '3s'
      && formatJobDuration({ startedAt: 0, finishedAt: 192_000 }) === '3m12s'
      && formatJobDuration({ startedAt: 0, finishedAt: 3_720_000 }) === '1h02m',
    `${formatJobDuration({ startedAt: 0, finishedAt: 192_000 })}`,
  )
}

// ---------------------------------------------------------------------------
// Group B — channel 集成
// ---------------------------------------------------------------------------
console.log('--- B: channel integration ---')
interface FakeAgent {
  id: string
  status: string
  options: Record<string, unknown>
  ctx: unknown
  session: { id: string; seq: number; events: unknown[]; header: Record<string, unknown> }
  steered: string[]
  followup(message: unknown): void
  steer(message: unknown): void
  inbox: { remove(): boolean }
  cancel(): void
  whenIdle(): Promise<void>
}
function makeAgent(id: string, sessionId: string): FakeAgent {
  const steered: string[] = []
  return {
    id,
    status: 'idle',
    options: {},
    ctx: { on: () => () => {} },
    session: { id: sessionId, seq: 0, events: [], header: {} },
    steered,
    followup() {},
    steer(message) { steered.push(JSON.stringify((message as { content?: unknown }).content)) },
    inbox: { remove: () => true },
    cancel() {},
    whenIdle: () => Promise.resolve(),
  } as FakeAgent
}
const makeHandle = (agent: FakeAgent) => ({ agent, dispose: () => Promise.resolve() })

function makeFakeJobs(): {
  runtime: Record<string, unknown>
  register(snap: Record<string, unknown>): void
  update(snap: Record<string, unknown>): void
  remove(id: string): void
  kills: string[]
} {
  const snapshots = new Map<string, Record<string, unknown>>()
  const changed = new Set<(owner: unknown) => void>()
  const done = new Set<(snap: unknown, owner: unknown) => void>()
  const kills: string[] = []
  const fire = (): void => { for (const listener of changed) listener(undefined) }
  return {
    kills,
    runtime: {
      list: () => [...snapshots.values()],
      kill: (id: string) => { kills.push(id); return 'requested' },
      onJobsChanged: (listener: (owner: unknown) => void) => { changed.add(listener); return () => changed.delete(listener) },
      onJobDone: (listener: (snap: unknown, owner: unknown) => void) => { done.add(listener); return () => done.delete(listener) },
    },
    register(snap) { snapshots.set(snap.id as string, snap); fire() },
    update(snap) { snapshots.set(snap.id as string, snap); fire() },
    remove(id) { snapshots.delete(id); fire() },
  }
}

const jobRows = (channel: { rows: Array<{ kind: string }> }) => channel.rows.filter(row => row.kind === 'job')
const NOW = Date.now()

{
  const ctx = new Context()
  const provide = (ctx as unknown as { provide(name: string, value: unknown): void }).provide.bind(ctx)
  const emit = (event: string, ...args: unknown[]) =>
    (ctx as unknown as { emit(event: string, ...args: unknown[]): void }).emit(event, ...args)
  const initial = makeAgent('agent-a', 'sess-a')
  provide('agents', {
    get: () => undefined,
    create: () => Promise.resolve(makeHandle(makeAgent('agent-b', 'sess-b'))),
  })
  const fake = makeFakeJobs()
  provide('jobs', fake.runtime)
  const channel = createChannel(ctx as never, initial as never, {
    model: 'm0', cwd: '/tmp/demo', provider: 'p0', activity: false,
  })

  fake.register({ id: 'pwsh-1', kind: 'pwsh', label: 'gh run watch 42', status: 'running', startedAt: NOW - 3000 })
  check('B1 任务注册进快照', await settled(() => channel.backgroundJobs.length === 1))
  check('B1 转录出现任务卡行', await settled(() => jobRows(channel).length === 1))
  check('B1 卡行初态 running', jobRows(channel)[0]?.job?.status === 'running', String(jobRows(channel)[0]?.job?.status))

  // job_output 工具结果流经事件流 → 镜像进瀑布（去掉 [status:] 尾缀）。
  emit('session/event', initial.session, {
    type: 'tool/call',
    data: { callId: 'cj1', name: 'job_output', arguments: JSON.stringify({ job_id: 'pwsh-1' }) },
  })
  emit('session/event', initial.session, {
    type: 'tool/result',
    data: {
      message: {
        source: { callId: 'cj1' },
        content: [{ type: 'tool-result', content: [{ type: 'text', text: 'build step 1 ok\nbuild step 2 ok\n[status: running]' }] }],
      },
    },
  })
  check(
    'B2 job_output 结果镜像进卡行',
    await settled(() => jobRows(channel)[0]?.job?.outputLines.join('|') === 'build step 1 ok|build step 2 ok'),
    JSON.stringify(jobRows(channel)[0]?.job?.outputLines),
  )
  check(
    'B2 镜像记录输出更新时间',
    await settled(() => typeof channel.backgroundJobs[0]?.lastOutputAt === 'number'),
    String(channel.backgroundJobs[0]?.lastOutputAt),
  )

  const noticesBefore = channel.notifications.length
  fake.update({ id: 'pwsh-1', kind: 'pwsh', label: 'gh run watch 42', status: 'completed', detail: 'exit code: 0', startedAt: NOW - 3000, finishedAt: NOW })
  check('B3 落定后卡行 completed + exit detail', await settled(() =>
    jobRows(channel)[0]?.job?.status === 'completed' && jobRows(channel)[0]?.job?.detail === 'exit code: 0',
  ))
  check(
    'B3 完成 toast 送达（含任务 id）',
    await settled(() => channel.notifications.length > noticesBefore
      && channel.notifications.some(item => item.text.includes('pwsh-1'))),
    JSON.stringify(channel.notifications.map(item => item.text)),
  )

  // 第二个任务：存活中消失（owner 处置）→ 卡行冻结为 killed，随后移出面板。
  fake.register({ id: 'bash-2', kind: 'bash', label: 'sleep 99', status: 'running', startedAt: NOW })
  check('B4 第二个任务注册', await settled(() => channel.backgroundJobs.length === 2))
  fake.remove('bash-2')
  check('B4 存活任务消失→卡行冻结 killed', await settled(() => {
    const row = jobRows(channel).find(r => r.job?.id === 'bash-2')
    return row?.job?.status === 'killed'
  }), String(jobRows(channel).find(r => r.job?.id === 'bash-2')?.job?.status))
  check('B4 面板快照冻结为 killed 保留', await settled(() =>
    channel.backgroundJobs.find(job => job.id === 'bash-2')?.status === 'killed',
  ))

  check('B5 jobControl.kill 调用注册表并带 owner', channel.jobControl.kill('pwsh-1') === true && fake.kills.join(',') === 'pwsh-1', fake.kills.join(','))
  await sleep(150)
  check('B5 终态任务 kill 不触发 steer', initial.steered.length === 0, initial.steered.join('|'))

  // 存活任务被用户 kill → steer 通知模型（kill 会抑制 harness 完成通知）。
  fake.register({ id: 'bash-3', kind: 'bash', label: 'sleep 100', status: 'running', startedAt: NOW })
  check('B8 存活任务注册', await settled(() => channel.backgroundJobs.some(job => job.id === 'bash-3')))
  check('B8 存活 kill 返回 true', channel.jobControl.kill('bash-3') === true)
  check(
    'B8 kill 后 steer 送达模型（含任务 id）',
    await settled(() => initial.steered.some(text => text.includes('bash-3'))),
    initial.steered.join('|'),
  )

  // 启动 ack（started background job <id>）先于注册到达：命令暂存，注册后挂上。
  emit('session/event', initial.session, {
    type: 'tool/call',
    data: { callId: 'cj9', name: 'pwsh', arguments: JSON.stringify({ command: 'gh pr checks --watch 42', description: 'watch ci' }) },
  })
  emit('session/event', initial.session, {
    type: 'tool/result',
    data: {
      message: {
        source: { callId: 'cj9' },
        content: [{ type: 'tool-result', content: [{ type: 'text', text: 'started background job pwsh-9' }] }],
      },
    },
  })
  fake.register({ id: 'pwsh-9', kind: 'pwsh', label: 'watch ci', status: 'running', startedAt: NOW })
  check(
    'B9 启动 ack 捕获完整命令（注册后挂上）',
    await settled(() => channel.backgroundJobs.find(job => job.id === 'pwsh-9')?.command === 'gh pr checks --watch 42'),
    String(channel.backgroundJobs.find(job => job.id === 'pwsh-9')?.command),
  )

  check('B6 /new 成功', (await channel.newSession()) === true)
  check('B6 切换后面板快照清空', channel.backgroundJobs.length === 0)
  check('B6 切换后任务卡行清空', jobRows(channel).length === 0)
}

// 无 jobs 服务：功能静默降级，kill 返回 false。
{
  const ctx = new Context()
  const provide = (ctx as unknown as { provide(name: string, value: unknown): void }).provide.bind(ctx)
  provide('agents', {
    get: () => undefined,
    create: () => Promise.resolve(makeHandle(makeAgent('agent-b', 'sess-b'))),
  })
  const channel = createChannel(ctx as never, makeAgent('agent-a', 'sess-a') as never, {
    model: 'm0', cwd: '/tmp/demo', provider: 'p0', activity: false,
  })
  await sleep(50)
  check('B7 无 jobs 服务：快照为空', channel.backgroundJobs.length === 0)
  check('B7 无 jobs 服务：kill 安全返回 false', channel.jobControl.kill('pwsh-9') === false)
}

// ---------------------------------------------------------------------------
// Group C — 渲染冒烟
// ---------------------------------------------------------------------------
console.log('--- C: render smoke ---')
const COLS = 70
const ROWS = 24
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  constructor(private term: InstanceType<typeof XTerm>) { super() }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.term.write(String(chunk), callback)
  }
}
class Input extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}
async function withTerminal(
  make: () => React.ReactNode,
  run: (screen: () => string, rerender: (node: React.ReactNode) => void) => Promise<void>,
): Promise<void> {
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term) as unknown as NodeJS.WriteStream
  const instance = await render(make(), {
    stdout,
    stdin: new Input() as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  const screen = (): string =>
    Array.from({ length: ROWS }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n')
  try {
    await run(screen, node => instance.rerender(node))
  } finally {
    await instance.unmount()
    term.dispose()
  }
}

const runningJob = {
  id: 'pwsh-1', kind: 'pwsh', label: 'gh run watch 42', status: 'running' as const,
  command: 'gh pr checks --watch 42',
  startedAt: Date.now() - 65_000, outputLines: ['build step 1 ok', 'build step 2 ok'],
}
await withTerminal(
  () => React.createElement(JobCard, { job: runningJob, addMargin: false }),
  async screen => {
    await sleep(150)
    const text = screen()
    check('C1 运行卡头含 id/label', text.includes('pwsh-1') && text.includes('gh run watch 42'))
    check('C1 瀑布呈现镜像输出', text.includes('build step 1 ok') && text.includes('build step 2 ok'))
  },
)
await withTerminal(
  () => React.createElement(JobCard, {
    job: { ...runningJob, outputLines: [] },
    addMargin: false,
  }),
  async screen => {
    await sleep(150)
    const text = screen()
    check(
      'C1 无输出时卡片仅头行（无空瀑布 gutter）',
      text.includes('gh run watch 42') && !text.includes('│'),
      text.split('\n').slice(0, 3).join('|'),
    )
  },
)
await withTerminal(
  () => React.createElement(JobCard, {
    job: { ...runningJob, status: 'completed' as const, detail: 'exit code: 0', finishedAt: Date.now() },
    addMargin: false,
  }),
  async screen => {
    await sleep(150)
    const text = screen()
    check('C2 落定卡折叠（无瀑布行）', !text.includes('│ build step 1 ok'))
    check('C2 落定卡头含 exit detail', text.includes('exit code: 0'))
  },
)
await withTerminal(
  () => React.createElement(JobsPanel, {
    jobs: [
      runningJob,
      { id: 'bash-2', kind: 'bash', label: 'pnpm build', status: 'completed' as const, detail: 'exit code: 0', startedAt: NOW - 90_000, finishedAt: NOW - 1000, outputLines: [] },
    ],
    onClose: () => {},
    onKill: () => {},
  }),
  async screen => {
    await sleep(150)
    const text = screen()
    check('C3 面板标题与两行任务', text.includes('Background Jobs') && text.includes('pwsh-1') && text.includes('bash-2'))
    check('C3 面板含操作提示', text.includes('kill focused job'), text.split('\n').at(-3) ?? '')
    // 聚焦第一行（默认）→ 详情块展开：完整任务名 + 开始时间 + 输出尾巴。
    check('C3 聚焦行详情含完整任务名与开始时间', text.includes('gh run watch 42') && text.includes('started'), text.split('\n').slice(0, 8).join('|'))
    check('C3 聚焦行详情含完整命令', text.includes('command') && text.includes('gh pr checks --watch 42'), text.split('\n').slice(0, 8).join('|'))
    check('C3 聚焦行详情含镜像输出尾巴', text.includes('build step 1 ok') && text.includes('build step 2 ok'))
    // 非聚焦行不展开详情（bash-2 无输出 → 其无输出提示也不应出现）。
    check('C3 非聚焦行无详情块', !text.includes('no mirrored output yet'))
  },
)

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nALL PASS')
