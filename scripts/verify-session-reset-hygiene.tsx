/**
 * 会话切换/清屏卫生回归（审计 M4/M5/M6/L1/N1 修复）。
 *
 * 真实 cordis Context + 真实 createChannel + 假 agents/sessions/attachments 服务：
 *   1. 会话切换（/new）重置子代理投影——快照清空、行 map 清空，重复 agentId 重建卡片而非孤儿更新；
 *   2. 排队的任务描述不跨会话泄漏到新会话第一张卡；
 *   3. /clear 只清行 map——同会话在途子代理的下一个事件重建卡片，仪表盘继续跟踪；
 *   4. staged image token 是会话作用域——switchModel 后不随旧 token 附图发送；
 *   5. resumeTo 的竞争切换守卫——await 期间被 /new 抢先提交时，恢复放弃且不动新会话；
 *   6. recap 预算从新到旧收容——超长旧消息不再饿死最新交互（collectRecentActivity 单元断言）。
 *
 * 运行：node --import tsx/esm scripts/verify-session-reset-hygiene.tsx
 */
process.env.FORCE_COLOR = '3'

// 家目录隔离：channel 构造路径会 touch 用户目录，先切临时目录再 import。
const { mkdtempSync, mkdirSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join: joinPath } = await import('node:path')
const isolatedHome = mkdtempSync(joinPath(tmpdir(), 'dshtui-reset-hygiene-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
mkdirSync(joinPath(isolatedHome, '.dsh-tui'), { recursive: true })

const [{ Context }, { createChannel }, { collectRecentActivity }, { settled, sleep }] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/recap.js'),
  import('./lib/term-test.mjs'),
])

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

interface FakeAgent {
  id: string
  status: string
  options: Record<string, unknown>
  ctx: unknown
  session: { id: string; seq: number; events: unknown[]; header: Record<string, unknown> }
  followup(message: unknown): void
  steer(message: unknown): void
  inbox: { remove(): boolean }
  cancel(): void
  whenIdle(): Promise<void>
}

function makeAgent(id: string, sessionId: string): FakeAgent {
  const session = { id: sessionId, seq: 0, events: [], header: {} }
  return {
    id,
    status: 'idle',
    options: {},
    ctx: { on: () => () => {} },
    session,
    followup() {},
    steer() {},
    inbox: { remove: () => true },
    cancel() {},
    whenIdle: () => Promise.resolve(),
  } as FakeAgent
}
const makeHandle = (agent: FakeAgent) => ({ agent, dispose: () => Promise.resolve() })

const subagentRows = (channel: { rows: Array<{ kind: string }> }) => channel.rows.filter(row => row.kind === 'subagent')

// ── 场景 1+2：/new 重置子代理投影、任务描述队列 ──────────────────────────
{
  const ctx = new Context()
  const provide = (ctx as unknown as { provide(name: string, value: unknown): void }).provide.bind(ctx)
  const emit = (event: string, ...args: unknown[]) =>
    (ctx as unknown as { emit(event: string, ...args: unknown[]): void }).emit(event, ...args)
  const initial = makeAgent('agent-a', 'sess-a')
  provide('agents', {
    get: (id: string) => (id === 'sub-1' ? { session: { id: 'child-sess' }, options: {} } : undefined),
    create: () => Promise.resolve(makeHandle(makeAgent('agent-b', 'sess-b'))),
  })
  const channel = createChannel(ctx as never, initial as never, {
    model: 'm0', cwd: '/tmp/demo', provider: 'p0', activity: false,
  })

  // 排队一条任务描述（旧会话的 Task 工具调用，尚未被 subagent/start 消费）。
  emit('session/event', initial.session, {
    type: 'tool/call',
    data: { callId: 'c0', name: 'task', arguments: JSON.stringify({ description: 'stale task' }) },
  })
  emit('subagent/start', { id: 'sub-1', runId: 'r1', provider: 'p0' })
  check('1a. subagent/start 建卡 + 快照跟踪', await settled(() => channel.subagents.length === 1 && subagentRows(channel).length === 1))
  check('1b. 排队描述被本会话消费（卡片显示 stale task）', subagentRows(channel)[0]?.subagent?.description === 'stale task', String(subagentRows(channel)[0]?.subagent?.description))

  check('1c. /new 成功', (await channel.newSession()) === true)
  check('1d. 仪表盘快照随切换清空', channel.subagents.length === 0, JSON.stringify(channel.subagents.map(s => s.agentId)))
  check('1e. 行 map 清空（无孤儿可更新）', subagentRows(channel).length === 0)

  // 旧会话的 child 事件不得再被路由（session 链接已断）。
  emit('session/event', { id: 'child-sess' }, { type: 'tool/call', data: { callId: 'cx', name: 'Grep', arguments: '{}' } })
  check('1f. 旧 child 会话事件不再入投影', subagentRows(channel).length === 0)

  // 场景 2：切换后再排一条描述，不得泄漏到新会话的第一张卡。
  emit('session/event', (channel as unknown as { agentId: string }).agentId === 'agent-b' ? initial.session : initial.session, {
    type: 'tool/call',
    data: { callId: 'c1', name: 'task', arguments: JSON.stringify({ description: 'pre-switch task' }) },
  })
  await channel.newSession()
  emit('subagent/start', { id: 'sub-2', runId: 'r2', provider: 'p0' })
  check('2. 新会话首卡不吃旧队列描述（默认标签）', await settled(() => {
    const row = subagentRows(channel)[0]
    return row !== undefined && row.subagent?.description === 'p0 task'
  }), String(subagentRows(channel)[0]?.subagent?.description))

  // 重复 agentId：map 已清 → 必须重建为新行（修复前是孤儿更新，卡片永不回屏）。
  emit('subagent/start', { id: 'sub-2', runId: 'r2b', provider: 'p0' })
  check('1g. 重复 agentId 重建卡片（非孤儿更新）', subagentRows(channel).length === 1)
}

// ── 场景 3：/clear 后在途子代理卡片可回现 ───────────────────────────────
{
  const ctx = new Context()
  const provide = (ctx as unknown as { provide(name: string, value: unknown): void }).provide.bind(ctx)
  const emit = (event: string, ...args: unknown[]) =>
    (ctx as unknown as { emit(event: string, ...args: unknown[]): void }).emit(event, ...args)
  const initial = makeAgent('agent-c', 'sess-c')
  const childSession = { id: 'child-c' }
  provide('agents', {
    get: (id: string) => (id === 'sub-c' ? { session: childSession, options: {} } : undefined),
  })
  const channel = createChannel(ctx as never, initial as never, {
    model: 'm0', cwd: '/tmp/demo', provider: 'p0', activity: false,
  })

  emit('subagent/start', { id: 'sub-c', runId: 'r3', provider: 'p0' })
  check('3a. 子代理卡建立', await settled(() => subagentRows(channel).length === 1))

  channel.clear()
  check('3b. /clear 清走卡片', subagentRows(channel).length === 0)
  check('3c. 仪表盘继续跟踪（同会话在途）', channel.subagents.length === 1)

  emit('session/event', childSession, { type: 'tool/call', data: { callId: 'cc', name: 'Grep', arguments: '{}' } })
  check('3d. 在途子代理下一个事件重建卡片', subagentRows(channel).length === 1)
}

// ── 场景 4：staged image 不跨 switchModel 泄漏 ──────────────────────────
{
  const ctx = new Context()
  const provide = (ctx as unknown as { provide(name: string, value: unknown): void }).provide.bind(ctx)
  const initial = makeAgent('agent-d', 'sess-d')
  const switched = makeAgent('agent-d2', 'sess-d2')
  const sent: unknown[][] = []
  initial.followup = message => sent.push((message as { content: unknown[] }).content)
  switched.followup = message => sent.push((message as { content: unknown[] }).content)
  provide('agents', { create: () => Promise.resolve(makeHandle(switched)) })
  provide('sessions', { fork: () => ({ events: [] }) })
  provide('attachments', {
    imageLimits: {
      maxImageBytes: 1_000_000,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 4_000_000,
      mediaTypes: ['image/png'],
    },
    saveImage: () => Promise.resolve({ ref: 'img-1', mediaType: 'image/png', bytes: 8 }),
  })
  const channel = createChannel(ctx as never, initial as never, {
    model: 'm0', cwd: '/tmp/demo', provider: 'p0', activity: false,
  })

  const token = await channel.stageImage({ data: new Uint8Array([1]), mediaType: 'image/png' })
  check('4a. stageImage 签发 token', token === '[Image #1]', token)
  channel.submit(`see ${token}`)
  check('4b. 切换前发送附带图片块', await settled(() => sent.length === 1
    && (sent[0] as Array<{ type: string }>).filter(block => block.type === 'image').length === 1))
  check('4c. switchModel 成功', (await channel.switchModel('p0', 'm1')) === true)
  channel.submit(`see ${token}`)
  check('4d. 切换后同 token 不再附图（会话作用域）', await settled(() => sent.length === 2
    && (sent[1] as Array<{ type: string }>).filter(block => block.type === 'image').length === 0))
}

// ── 场景 5：resumeTo 竞争切换守卫 ────────────────────────────────────────
{
  const ctx = new Context()
  const provide = (ctx as unknown as { provide(name: string, value: unknown): void }).provide.bind(ctx)
  const initial = makeAgent('agent-e', 'sess-e')
  const resumed = makeAgent('agent-e2', 'sess-target')
  let resolveResume!: (handle: unknown) => void
  provide('agents', {
    create: () => Promise.resolve(makeHandle(makeAgent('agent-e3', 'sess-e3'))),
    resume: () => new Promise(resolve => { resolveResume = resolve }),
  })
  const channel = createChannel(ctx as never, initial as never, {
    model: 'm0', cwd: '/tmp/demo', provider: 'p0', activity: false,
  })

  const pending = channel.resumeTo('sess-target')
  await sleep(30) // resume 体停在 agents.resume
  check('5a. /new 在 resume 的 await 窗口内抢先提交', (await channel.newSession()) === true)
  check('5b. 此刻活跃会话是 /new 的', (channel as unknown as { agentId: string }).agentId === 'agent-e3')
  resolveResume(makeHandle(resumed))
  const result = await pending
  check('5c. 竞争后 resume 放弃（ok=false）', result.ok === false, JSON.stringify(result))
  check('5d. 新会话未被踩踏（agentId 不变）', (channel as unknown as { agentId: string }).agentId === 'agent-e3')
}

// ── 场景 6：recap 预算从新到旧收容（N1 单元断言） ────────────────────────
{
  const message = (role: 'user' | 'assistant', text: string) => ({
    type: role === 'user' ? 'user/message' : 'assistant/message',
    seq: 0,
    time: 0,
    data: role === 'user'
      ? { content: [{ type: 'text', text }] }
      : { message: { content: [{ type: 'text', text }] } },
  })
  const events = [1, 2, 3, 4, 5, 6].map(n => message(n % 2 === 0 ? 'assistant' : 'user', `msg${n}-`.repeat(1500)))
  const payload = collectRecentActivity(events as never, 6000)
  check('6a. 最新交互进入 payload', payload.includes('msg6-'), `len=${payload.length}`)
  check('6b. 吞预算的旧消息不再独占 payload', !payload.includes('msg1-'), payload.slice(0, 40))
  const mixed = [
    message('user', 'old-short'),
    message('assistant', 'x'.repeat(5800)),
    message('user', 'newest-question'),
  ]
  const mixedPayload = collectRecentActivity(mixed as never, 6000)
  check('6c. 混合预算下最新短消息完整保留', mixedPayload.includes('newest-question'))
  check('6d. 输出保持时间顺序（旧→新）', mixedPayload.indexOf('x'.repeat(20)) < mixedPayload.indexOf('newest-question'))
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
