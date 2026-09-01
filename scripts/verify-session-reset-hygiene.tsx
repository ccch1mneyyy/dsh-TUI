/**
 * 会话切换/清屏卫生回归（审计 M4/M5/M6/L1/N1 修复）。
 *
 * 真实 cordis Context + 真实 createChannel + 假 agents/sessions/attachments 服务：
 *   1. 会话切换（/new）重置子代理投影——快照清空、行 map 清空，重复 agentId 重建卡片而非孤儿更新；
 *   2. 排队的任务描述不跨会话泄漏到新会话第一张卡；
 *   3. /clear 只清行 map——同会话在途子代理的下一个事件重建卡片，仪表盘继续跟踪；
 *   4. staged image token 是会话作用域——switchModel 后不随旧 token 附图发送；
 *   5. resumeTo 的竞争切换守卫——await 期间被 /new 抢先提交时，恢复放弃且不动新会话；
 *   6. `@` 展开期间切换会话——旧输入不得投递到旧/新任一 agent；
 *   7. staged image 按 token 文本顺序附图，重复 token 只附一次；
 *   8. 图片 capability 防 ABA——新会话重用 `[Image #1]` 时，旧裸文本不绑定新图；
 *   9. recap 预算从新到旧收容——超长旧消息不再饿死最新交互（collectRecentActivity 单元断言）。
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

  const staged = await channel.stageImage(
    { data: new Uint8Array([1]), mediaType: 'image/png' },
    channel.stagedImageGeneration(),
  )
  const token = '[Image #1]'
  const refs = [{ token, stageId: staged.stageId }]
  check('4a. stageImage 签发 opaque capability', typeof staged.stageId === 'string' && staged.stageId !== '', staged.stageId)
  channel.submit(`see ${token}`, refs)
  check('4b. 切换前发送附带图片块', await settled(() => sent.length === 1
    && (sent[0] as Array<{ type: string }>).filter(block => block.type === 'image').length === 1))
  check('4c. switchModel 成功', (await channel.switchModel('p0', 'm1')) === true)
  channel.submit(`see ${token}`, refs)
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

// ── 场景 6：`@` 展开期间 /new 不得把旧输入投递到任何 agent ───────────────
{
  const ctx = new Context()
  const provide = (ctx as unknown as { provide(name: string, value: unknown): void }).provide.bind(ctx)
  const initial = makeAgent('agent-f', 'sess-f')
  const switched = makeAgent('agent-f2', 'sess-f2')
  const oldInbox: unknown[] = []
  const newInbox: unknown[] = []
  initial.followup = message => oldInbox.push(message)
  switched.followup = message => newInbox.push(message)

  let resolveRead!: (body: string) => void
  let readStarted = false
  provide('fs', {
    resolve: (path: string) => Promise.resolve({ displayPath: path }),
    stat: () => Promise.resolve({ type: 'file' as const }),
    readText: () => new Promise<string>(resolve => {
      readStarted = true
      resolveRead = resolve
    }),
    listDir: () => Promise.resolve([]),
  })
  provide('agents', { create: () => Promise.resolve(makeHandle(switched)) })
  const channel = createChannel(ctx as never, initial as never, {
    model: 'm0', cwd: '/tmp/demo', provider: 'p0', activity: false,
  })

  channel.submit('inspect @slow.txt')
  check('6a. 旧输入已停在 @ 文件读取', await settled(() => readStarted))
  check('6b. @ 展开未完成时 /new 成功', (await channel.newSession()) === true)
  channel.submit('fresh session input')
  check('6c. 新会话输入不被旧会话的慢读取阻塞',
    await settled(() => newInbox.length === 1), `sent=${newInbox.length}`)
  resolveRead('old session file contents')
  // Cross one event-loop turn after releasing the exact barrier: all promise
  // continuations from expand → deliver have either sent or stale-dropped.
  await new Promise<void>(resolve => setImmediate(resolve))
  check('6d. 旧输入没有回投旧 agent', oldInbox.length === 0, `sent=${oldInbox.length}`)
  check('6e. 旧输入没有错投新 agent', newInbox.length === 1, `sent=${newInbox.length}`)
}

// ── 场景 7：staged image 按占位符文本顺序附图，重复引用去重 ─────────────
{
  const ctx = new Context()
  const provide = (ctx as unknown as { provide(name: string, value: unknown): void }).provide.bind(ctx)
  const initial = makeAgent('agent-g', 'sess-g')
  const sent: unknown[][] = []
  initial.followup = message => sent.push((message as { content: unknown[] }).content)
  provide('attachments', {
    imageLimits: {
      maxImageBytes: 1_000_000,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 4_000_000,
      mediaTypes: ['image/png'],
    },
    saveImage: (input: { data: Uint8Array }) => Promise.resolve({
      ref: `img-${input.data[0]}`,
      mediaType: 'image/png',
      bytes: input.data.byteLength,
    }),
  })
  const channel = createChannel(ctx as never, initial as never, {
    model: 'm0', cwd: '/tmp/demo', provider: 'p0', activity: false,
  })

  const first = await channel.stageImage(
    { data: new Uint8Array([1]), mediaType: 'image/png' },
    channel.stagedImageGeneration(),
  )
  const second = await channel.stageImage(
    { data: new Uint8Array([2]), mediaType: 'image/png' },
    channel.stagedImageGeneration(),
  )
  const firstToken = '[Image #1]'
  const secondToken = '[Image #2]'
  channel.submit(`${secondToken} before ${firstToken}; ${secondToken} repeated`, [
    { token: firstToken, stageId: first.stageId },
    { token: secondToken, stageId: second.stageId },
  ])
  check('7a. staged image 消息已投递', await settled(() => sent.length === 1))
  const images = (sent[0] as Array<{ type: string; attachment?: { ref?: string } }>)
    .filter(block => block.type === 'image')
  check('7b. staged image 按 token 文本出现顺序附加',
    images.map(block => block.attachment?.ref).join(',') === 'img-2,img-1',
    images.map(block => block.attachment?.ref).join(','))
  check('7c. 重复 token 只附同一张图一次', images.length === 2, `count=${images.length}`)
}

// ── 场景 8：图片 capability 防止跨会话 token ABA ───────────────────────
{
  const ctx = new Context()
  const provide = (ctx as unknown as { provide(name: string, value: unknown): void }).provide.bind(ctx)
  const initial = makeAgent('agent-h', 'sess-h')
  const switched = makeAgent('agent-h2', 'sess-h2')
  const sent: unknown[][] = []
  switched.followup = message => sent.push((message as { content: unknown[] }).content)
  provide('agents', { create: () => Promise.resolve(makeHandle(switched)) })
  provide('attachments', {
    imageLimits: {
      maxImageBytes: 1_000_000,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 4_000_000,
      mediaTypes: ['image/png'],
    },
    saveImage: (input: { data: Uint8Array }) => Promise.resolve({
      ref: `img-${input.data[0]}`,
      mediaType: 'image/png',
      bytes: input.data.byteLength,
    }),
  })
  const channel = createChannel(ctx as never, initial as never, {
    model: 'm0', cwd: '/tmp/demo', provider: 'p0', activity: false,
  })

  await channel.stageImage(
    { data: new Uint8Array([1]), mediaType: 'image/png' },
    channel.stagedImageGeneration(),
  )
  check('8a. /new 清除旧会话 capability', (await channel.newSession()) === true)
  const fresh = await channel.stageImage(
    { data: new Uint8Array([2]), mediaType: 'image/png' },
    channel.stagedImageGeneration(),
  )
  const reusedToken = '[Image #1]'

  // 模拟历史/rewind 只恢复可见文本：没有 capability，绝不能因新草稿
  // 恰好也编号 #1 而错绑到新会话图片。
  channel.submit(`restored ${reusedToken}`)
  check('8b. 裸历史 token 已作为纯文本投递', await settled(() => sent.length === 1))
  const bareImages = (sent[0] as Array<{ type: string }>).filter(block => block.type === 'image')
  check('8c. 裸历史 token 不绑定新会话同号图片', bareImages.length === 0, `count=${bareImages.length}`)

  channel.submit(`live ${reusedToken}`, [{ token: reusedToken, stageId: fresh.stageId }])
  check('8d. 显式 capability 的当前草稿已投递', await settled(() => sent.length === 2))
  const liveRefs = (sent[1] as Array<{ type: string; attachment?: { ref?: string } }>)
    .filter(block => block.type === 'image')
    .map(block => block.attachment?.ref)
  check('8e. 显式 capability 正确绑定当前图片', liveRefs.join(',') === 'img-2', liveRefs.join(','))
}

// ── 场景 9：recap 预算从新到旧收容（N1 单元断言） ────────────────────────
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
  check('9a. 最新交互进入 payload', payload.includes('msg6-'), `len=${payload.length}`)
  check('9b. 吞预算的旧消息不再独占 payload', !payload.includes('msg1-'), payload.slice(0, 40))
  const mixed = [
    message('user', 'old-short'),
    message('assistant', 'x'.repeat(5800)),
    message('user', 'newest-question'),
  ]
  const mixedPayload = collectRecentActivity(mixed as never, 6000)
  check('9c. 混合预算下最新短消息完整保留', mixedPayload.includes('newest-question'))
  check('9d. 输出保持时间顺序（旧→新）', mixedPayload.indexOf('x'.repeat(20)) < mixedPayload.indexOf('newest-question'))
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
