/**
 * Settled-subagent idle render regression（外部审计报告 P0-A/P0-4）。
 *
 * SubagentMessage 曾无条件 `useAnimationFrame(120)` 且丢弃 viewportRef：
 * settled 卡片永远保持 animation clock 订阅（keepAlive），空闲会话以
 * ~120ms/卡片 持续产生 React commit + 帧；waterfall key 还含 time，
 * running 时每 tick 强制 remount。N 张相位错开的卡片 → ~30ms 均匀帧
 * cadence（#433 的形态）。
 *
 * 断言：
 *   1) 控制组：存在 running 卡片时空闲窗口内确实有帧（动画没被误杀）；
 *   2) 全部 settled 后空闲 1s 帧数 = 0（clock 完全退出）。
 * 运行：node --import tsx/esm scripts/verify-subagent-settle.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'kitty'
process.env.DSH_TUI_THEME = 'dark'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { Chat }, { QuestionStore }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
])

const COLS = 100
const ROWS = 32
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }
const stdout = new FakeStdout() as any
const stderr = new FakeStderr() as any
const stdin = new FakeStdin() as any

/** 帧计数器：onFrame 每 paint 一次 +1，窗口内增量即空闲渲染压力。 */
let frameCount = 0

function subagentCard(id: number, agentId: string, status: 'running' | 'completed'): any {
  const startedAt = Date.now() - 120_000
  return {
    id,
    kind: 'subagent',
    text: '子任务 ' + agentId + '：检索并归纳结论',
    subagent: {
      agentId,
      runId: agentId,
      description: '子任务 ' + agentId + '：检索并归纳结论',
      provider: 'dsh', model: 'deepseek-v4-flash', effort: 'medium',
      status,
      startedAt,
      completedAt: status === 'completed' ? startedAt + 60_000 : undefined,
      durationMs: status === 'completed' ? 60_000 : undefined,
      outputLines: status === 'running' ? ['正在读取 src/index.ts', '正在匹配 pattern', '第三行占位输出'] : [],
      toolCalls: [{ id: agentId + '-c1', name: 'Grep', status: 'ok', startedAt }],
      tokens: { total: 2048 },
      stopReason: status === 'completed' ? 'completed' : undefined,
    },
  }
}

const listeners = new Set<() => void>()
const makeRows = (statuses: Array<'running' | 'completed'>) => {
  const rows: any[] = [{ id: 0, kind: 'user', text: '开始并行子任务分析' }]
  statuses.forEach((s, i) => rows.push(subagentCard(i + 1, 'sa-' + i, s)))
  rows.push({ id: 90, kind: 'assistant', text: '汇总完成。', streaming: false })
  return rows
}
let channelRows = makeRows(['running', 'running'])
const channel: any = {
  version: 0, rows: channelRows, status: 'idle', sessionTitle: 'subagent-idle', agentId: 'x',
  model: 'deepseek-v4-flash', reasoningEffort: 'max',
  tokens: { input: 100, output: 40 }, cwd: '/tmp/demo', displayCwd: '/tmp/demo',
  gitBranch: 'main', working: false, spinnerMode: 'requesting', responseChars: 0,
  activeToolCount: 0, turnStart: 0, lastUserText: '开始并行子任务分析',
  pending: [], commandList: [], notifications: [],
  mode: { plan: false }, effortLevels: undefined,
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {}, cancel: () => {}, clear: () => {}, notify: () => {},
  listModels: () => Promise.resolve([]), listSessions: () => [],
  setResumeTarget: () => {}, loadOlder: () => {}, mcpStatus: () => [],
}
const bump = () => { channel.version++; for (const cb of listeners) (cb as () => void)() }

/** 固定窗口刻意保留（不换 settle）：帧计数窗口本身就是被测对象——
 *  「settled 后空闲帧数 = 0」是不得发生渲染的稳定性探针，对已成立
 *  条件轮询会立即返回，等于没测。 */
async function countIdleFrames(windowMs: number): Promise<number> {
  await sleep(300)
  const before = frameCount
  await sleep(windowMs)
  return frameCount - before
}

await render(
  <AlternateScreen>
    <Chat channel={channel} questionStore={new QuestionStore()} />
  </AlternateScreen>,
  { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false, onFrame: () => { frameCount++ } },
)

// 开机动画（LogoV2 splash）落定后再测
await sleep(1800)

// ---- 控制组：2 张 running 卡片 → 空闲窗口内必须有帧 ----
const runningFrames = await countIdleFrames(1000)
check('running 卡片驱动空闲帧（动画存在）', runningFrames >= 4, 'frames=' + runningFrames)

// ---- 全部 settle：running → completed（走真实高度变化路径）----
channelRows.forEach(row => {
  if (row.kind !== 'subagent' || !row.subagent) return
  const sub = row.subagent
  sub.status = 'completed'
  sub.completedAt = sub.startedAt + 60_000
  sub.durationMs = 60_000
  sub.outputLines = []
  sub.stopReason = 'completed'
})
bump()
await sleep(300)

const settledFrames = await countIdleFrames(1000)
check('settled 后空闲帧归零（clock 完全退出）', settledFrames === 0, 'frames=' + settledFrames)

console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' 项失败')
process.exit(failed === 0 ? 0 : 1)
