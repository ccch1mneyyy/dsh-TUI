/**
 * `/model` 切换 scrollback 重复沉积回归（真机取证：每次切换 scrollback 多一份
 * splash 拷贝，+18 行/次）。真实 channel（createChannel）+ 最小 fake agent /
 * sessions / agents 服务，逐键走完整 UI 路径（输入 /model → 补全浮层 → picker
 * → fork+replay）；xterm-headless 开 2000 行 scrollback 重建终端视角，断言
 * splash/历史等唯一 UI 文本在 scrollback + 视口中恰好一份、缓冲区零增长。
 *
 * 根因：补全/picker 等瞬态面板 in-flow 挂载使帧高涨落，帧顶行被滚进
 * scrollback 后遭关闭重绘二次写入。修复：瞬态面板改 OverlayAbove 零高度浮层。
 *
 * 运行：node --import tsx/esm scripts/repro-model-switch-scrollback.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'  // DEC-2026 同步输出路径
process.env.DSH_TUI_THEME = 'dark'     // 跳过 OSC 11 探测，保持确定性
process.env.DSH_TUI_LANG = 'zh'        // 固定中文 UI（splash 标语断言）

// 隔离 HOME：switchModel 会把 picker 选择写进 ~/.dsh-tui/model.json
// （modelPrefs.PREFS_DIR 在模块加载时按 homedir() 解析），不隔离会把
// fake-provider 写进真机配置——真机下一次启动所有回合报
// "no adapter registered for provider fake-provider"。必须在 import src 之前。
const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join: joinPath } = await import('node:path')
process.env.HOME = mkdtempSync(joinPath(tmpdir(), 'dshtui-repro-home-'))

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }, { createChannel }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/channel.js'),
])

const COLS = 100
const ROWS = 30
const SCROLLBACK = 2000
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK, allowProposedApi: true })

const rawChunks: string[] = []
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) {
    const str = String(chunk)
    rawChunks.push(str)
    term.write(str, () => cb())
  }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function fullBufferLines(): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < buf.length; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '')
  return out
}

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

/** 唯一标记在 scrollback+视口中的出现次数（逐行包含匹配）。 */
function countMarker(marker: string): number {
  return fullBufferLines().filter(l => l.includes(marker)).length
}

// ---- SessionEvent 预制：2 轮历史（user + reasoning + 长 assistant） ----------
let seq = 0
let now = Date.now()
function ev(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return { seq: seq++, time: (now += 5), type, data }
}
function userEvent(text: string) {
  return ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] })
}
function assistantEvent(text: string, turn: number) {
  return ev('assistant/message', {
    turn, step: 0,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: { inputTokens: 100, outputTokens: 50 },
  })
}
const events: Array<Record<string, unknown>> = []
for (let turn = 0; turn < 2; turn++) {
  events.push(ev('turn/start', { turn }))
  events.push(userEvent(`历史问题 ${turn}：检查一下构建配置`))
  const body = Array.from(
    { length: 12 },
    (_, i) => `- 第 ${turn}-${i} 条历史回答要点：装配、主题、同步与加密打包`,
  ).join('\n')
  events.push(assistantEvent(`历史回答 ${turn}：\n\n${body}`, turn))
  events.push(ev('turn/end', { turn, reason: { kind: 'completed' } }))
}

// ---- 最小 fake agent / sessions / agents --------------------------------------
const stubAgentCtx = { on: () => () => {} }
function makeAgent(id: string, sessionEvents: readonly unknown[]) {
  return {
    id,
    status: 'idle',
    session: { id: `s-${id}`, seq: sessionEvents.length, events: sessionEvents, header: {} },
    ctx: stubAgentCtx,
    followup() {},
    steer() {},
    inbox: { remove: () => true },
  }
}
let agentCounter = 0
const handlers = new Map<string, unknown>()
const services: Record<string, unknown> = {
  sessions: {
    fork(session: { events: readonly unknown[] }) {
      return { events: session.events }
    },
  },
  agents: {
    async create(options: { sessionId: string; seed: readonly unknown[] }) {
      agentCounter += 1
      const agent = makeAgent(`fork-${agentCounter}`, options.seed)
      return { agent, dispose: async () => {} }
    },
  },
  llm: {
    listProviders: () => [{ id: 'fake-provider' }],
    listModels: async () => [
      { provider: 'fake-provider', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { provider: 'fake-provider', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ],
  },
}
const ctx = {
  on(event: string, handler: unknown) {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  get(name: string) {
    return services[name]
  },
  logger: { warn() {} },
}

// ---- 真实 channel + 真实 Chat ---------------------------------------------------
const channel = createChannel(ctx as never, makeAgent('a1', events) as never, {
  model: 'deepseek-v4-flash',
  cwd: '/tmp/demo',
  provider: 'fake-provider',
  activity: false,
})

const stdoutObj = new FakeStdout()
const stdin = new FakeStdin()
const instance = await render(
  <Chat channel={channel as never} questionStore={new QuestionStore()} onExit={() => {}} />,
  { stdout: stdoutObj, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)
await sleep(1200)

const SPLASH = '探索未至之境'
const HIST0 = '历史问题 0：检查一下构建配置'
const HIST1 = '历史回答 1：'

console.log(`boot: buffer=${term.buffer.active.length} 行 (视口 ${ROWS})`)
check('boot 后 splash 恰好一份', countMarker(SPLASH) === 1, `实际 ${countMarker(SPLASH)}`)
check('boot 后历史行恰好一份', countMarker(HIST0) === 1 && countMarker(HIST1) === 1,
  `问题=${countMarker(HIST0)} 回答=${countMarker(HIST1)}`)

// ---- 走真实 UI 路径：输入 /model → 回车开 picker → ↓ → 回车切换 ----------------
// 与真机操作逐键一致：补全面板、picker、notify、fork+replay 全部经过。
const bufLen = (tag: string) =>
  console.log(`  [${tag}] buffer=${term.buffer.active.length} scrollback=${term.buffer.active.baseY}`)
const typeKeys = async (keys: string) => {
  for (const ch of keys) {
    stdin.write(ch)
    await sleep(40)
  }
}
bufLen('boot')
await typeKeys('/model')
await sleep(200)
bufLen('typed /model')
stdin.write('\r')            // 打开 picker（slash 命令派发）
await sleep(600)
bufLen('picker open')
stdin.write('\x1b[B')        // ↓ 选中下一个模型
await sleep(200)
stdin.write('\r')            // 确认 → fork + replay
await sleep(1500)
bufLen('switched')

check('切换后模型名生效', channel.model === 'deepseek-v4-pro', `实际 ${channel.model}`)
check('切换后 splash 恰好一份', countMarker(SPLASH) === 1, `实际 ${countMarker(SPLASH)}`)
check('切换后历史行恰好一份', countMarker(HIST0) === 1 && countMarker(HIST1) === 1,
  `问题=${countMarker(HIST0)} 回答=${countMarker(HIST1)}`)
check('历史问题 1 恰好一份', countMarker('历史问题 1：检查一下构建配置') === 1,
  `实际 ${countMarker('历史问题 1：检查一下构建配置')}`)
check('历史片段 0-8 恰好一份', countMarker('第 0-8 条历史回答要点') === 1,
  `实际 ${countMarker('第 0-8 条历史回答要点')}`)

// ---- 再切一次：确认沉积随切换次数线性增长 --------------------------------------
await typeKeys('/model')
await sleep(200)
stdin.write('\r')
await sleep(600)
stdin.write('\x1b[B')
await sleep(200)
stdin.write('\r')
await sleep(1500)
check('二次切换后 splash 恰好一份', countMarker(SPLASH) === 1, `实际 ${countMarker(SPLASH)}`)

// ---- Esc 只关不切换：浮层整体条件挂载的回归场景 -----------------------------
// 关键前置：等 splash 动画彻底稳定（不再有新帧）。动画每 tick 会把 ScrollBox
// 标脏、强制全量重绘，掩盖"关闭浮层后被覆盖行留空"的缺陷（条件挂载缺失时，
// 干净 ScrollBox 的 blit 会跳过 absoluteClear 覆盖行——真实终端上动画停止
// 后这些行永久空白）。覆盖区内的历史尾行没有动画治疗，是最敏感的探针。
const waitQuiet = async () => {
  const deadline = Date.now() + 20_000
  let last = rawChunks.length
  while (Date.now() < deadline) {
    await sleep(600)
    if (rawChunks.length === last) return
    last = rawChunks.length
  }
  console.log('  [warn] 动画 20s 未稳定，继续执行（历史行断言不受影响）')
}
await waitQuiet()
const modelBeforeEsc = channel.model
const bufBeforeEsc = term.buffer.active.length
await typeKeys('/model')
await sleep(200)
stdin.write('\r')            // 打开 picker
await sleep(600)
stdin.write('\x1b')          // Esc：只关闭，不切换
await sleep(600)
check('Esc 不改动模型', channel.model === modelBeforeEsc, `实际 ${channel.model}`)
check('Esc 关闭后被覆盖历史行仍在',
  countMarker('第 1-8 条历史回答要点') === 1 && countMarker('第 1-11 条历史回答要点') === 1,
  `1-8=${countMarker('第 1-8 条历史回答要点')} 1-11=${countMarker('第 1-11 条历史回答要点')}`)
check('Esc 开关周期缓冲区零增长', term.buffer.active.length === bufBeforeEsc,
  `${bufBeforeEsc} → ${term.buffer.active.length}`)

console.log(`final: buffer=${term.buffer.active.length} 行 (视口 ${ROWS}, scrollback ${term.buffer.active.length - ROWS})`)
const fullResets = rawChunks.join('').match(/\x1b\[10000S/g)?.length ?? 0
check('全程无 full-reset (CSI 10000S)', fullResets === 0, `实际 ${fullResets}`)

if (process.env.DUMP === '1') {
  const buf = term.buffer.active
  console.log('---- scrollback 内容 ----')
  for (let y = 0; y < buf.baseY; y++) {
    const l = buf.getLine(y)?.translateToString(true) ?? ''
    if (l.trim()) console.log(String(y).padStart(3), l.slice(0, 90))
  }
}

instance.unmount()
if (failed > 0) {
  console.log(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
process.exit(0)
