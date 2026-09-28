/**
 * Subagent dashboard sync regression (issue #966).
 *
 * The Ctrl+A panel must mirror EVERY child the session dispatched, live and
 * after resume. Drives a real channel over a real cordis Context with a
 * mutable fake agents registry and asserts on the two projection surfaces:
 * `channel.subagents` (dashboard source) and `channel.rows` (transcript
 * cards, live discovery only).
 *
 * Contracts under test:
 *   A. durable discovery — a `subagent/catalog` parent event alone births a
 *      dashboard row (issue H1: rows used to exist only off `subagent/start`);
 *   B. re-dispatch — a continuable epoch's fresh runId resets the row to a
 *      new run (status/startedAt/output), and the previous epoch's LATE
 *      `subagent/end` (documented host ordering: it can trail the next
 *      epoch's start) must not settle the new run (H3);
 *   C. resume bootstrap — catalog + workflow member events folded from the
 *      session log repopulate the dashboard after a restart; historical
 *      children stay out of the replayed transcript; a child still live in
 *      the registry shows running;
 *   D. late session binding — a child whose start-time lookup failed gets its
 *      session link healed through the registry when its events arrive (H2),
 *      while a PEER top-level session in the same registry never becomes a
 *      dashboard row;
 *   E. workflow members — `tool-workflow/agent-start|end` parent events drive
 *      member rows (they never emit subagent edges) and settle by outcome.
 *   F. parked live session — restoring the same child run keeps its clock,
 *      tools, clickable card and event link; a new run still resets them;
 *   G. list labels — an in-flight child is not reported as archived when the
 *      service activity lags, and an idle/unknown child is not mislabeled.
 *
 * Run: node --import tsx/esm scripts/verify-subagent-panel-sync.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

// Home isolation: channel construction touches the user directory.
const { mkdtempSync, mkdirSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join: joinPath } = await import('node:path')
const isolatedHome = mkdtempSync(joinPath(tmpdir(), 'dshtui-subagent-sync-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
mkdirSync(joinPath(isolatedHome, '.dsh-tui'), { recursive: true })

const [{ Context }, { createChannel }, { createScope, scopeTarget }, { settled, sleep }] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('../src/dsh-adapter/channel.js'),
  import('@deepseek-ai/dsh-scope'),
  import('./lib/term-test.mjs'),
])

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

interface FakeChild { status?: string; session: { id: string; seq: number; events: unknown[]; header: Record<string, unknown> }; options?: { provider?: string; model?: string } }

function makeHarness(seedEvents: unknown[] = [], warmRegistry?: (registry: Map<string, FakeChild>) => void) {
  const registry = new Map<string, FakeChild>()
  const ctx = new Context()
  ;(ctx as unknown as { provide(name: string, value: unknown): () => void }).provide('agents', {
    get(id: string) { return registry.get(id) },
  })
  // Warm the registry BEFORE the channel exists: production adoption paths
  // (switching to a session that already runs in this process) fold the log
  // with the registry already holding that session's live children.
  warmRegistry?.(registry)
  const parentSession = { id: 'parent-session', seq: 0, events: [...seedEvents], header: {} }
  const parent = {
    id: 'parent-agent',
    status: 'idle',
    options: {},
    ctx,
    session: parentSession,
    followup() {},
    steer() {},
    inbox: { remove() {} },
  }
  parent.ctx = createScope(ctx, parent).ctx
  const channel = createChannel(ctx as never, parent as never, {
    model: 'model-00', cwd: '/tmp/demo', provider: 'fake-provider', activity: false,
  })
  const emit = (name: string, ...args: unknown[]) =>
    (ctx as unknown as { emit(...args: unknown[]): void }).emit(scopeTarget({}, parent), name, ...args)
  return {
    ctx, registry, channel, emit,
    parentEvent: (event: unknown) => emit('session/event', parentSession, event),
    childEvent: (child: FakeChild, event: unknown) => emit('session/event', child.session, event),
    row: (agentId: string) => channel.rows.find(r => r.kind === 'subagent' && r.subagent?.agentId === agentId)?.subagent,
    panel: (agentId: string) => channel.subagents.find(s => s.agentId === agentId),
  }
}

const catalog = (childId: string, label: string, at: number) =>
  ({ type: 'subagent/catalog', seq: 0, time: at, data: { version: 0, childId, childCreatedAt: at, mode: 'continuable', label } })

// The list service's activity can lag the live agent registry. A value other
// than `running` must not be presented as proof that a child was archived.
{
  const h = makeHarness([catalog('list-child', '列表任务', Date.now() - 60_000)], registry => {
    registry.set('list-child', { status: 'running', session: { id: 'list-child', seq: 0, events: [], header: {} } })
  })
  ;(h.ctx as unknown as { provide(name: string, value: unknown): void }).provide('subagents', {
    listChildren: async () => [{ id: 'list-child', mode: 'continuable', activity: 'archived' }],
  })
  const liveLine = (await h.channel.listSubagents())[0] ?? ''
  check('G1 列表以当前运行投影为准，不把在跑的子代理写成已归档',
    liveLine.includes('运行中') && !liveLine.includes('已归档'), liveLine)

  const unknown = makeHarness([catalog('idle-child-list', '历史任务', Date.now() - 60_000)])
  ;(unknown.ctx as unknown as { provide(name: string, value: unknown): void }).provide('subagents', {
    listChildren: async () => [{ id: 'idle-child-list', mode: 'continuable', activity: 'idle' }],
  })
  const unknownLine = (await unknown.channel.listSubagents())[0] ?? ''
  check('G2 未知或空闲状态不误报已归档', unknownLine.includes('状态未知'), unknownLine)
}

// ── A + B: live lifecycle — catalog birth, epoch reset, late-end immunity ──
{
  const h = makeHarness()
  const child: FakeChild = { status: 'running', session: { id: 'cat-child', seq: 0, events: [], header: {} }, options: { provider: 'fake-provider', model: 'model-00' } }
  h.registry.set('cat-child', child)

  h.parentEvent(catalog('cat-child', '检索索引结构', 1_000))
  check('A1 catalog 事件单独出生面板行（registry live → running）',
    h.panel('cat-child')?.status === 'running' && h.panel('cat-child')?.description === '检索索引结构',
    JSON.stringify(h.channel.subagents.map(s => [s.agentId, s.status])))

  h.emit('subagent/start', { id: 'cat-child', runId: 'run-1', provider: 'fake-provider' })
  h.childEvent(child, { type: 'tool/call', data: { callId: 't1', name: 'Grep', arguments: '{}' } })
  h.childEvent(child, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '第一轮输出' } } })
  await sleep(60) // 固定窗:探针 等 16ms 流 flush 落定后读投影
  check('A2 start 后会话事件归属正确（工具 + 输出可见）',
    h.panel('cat-child')?.toolCalls.length === 1 && (h.panel('cat-child')?.output.join('') ?? '').includes('第一轮输出'),
    `tools=${String(h.panel('cat-child')?.toolCalls.length)} out=${h.panel('cat-child')?.output.join('') ?? ''}`)
  h.emit('subagent/end', { id: 'cat-child', runId: 'run-1', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '结论一' }] })
  check('A3 end 落地 completed', h.panel('cat-child')?.status === 'completed' && h.panel('cat-child')?.summary === '结论一',
    `status=${String(h.panel('cat-child')?.status)}`)

  // B: re-dispatch — same id, NEW runId.
  const before = h.panel('cat-child')?.startedAt ?? 0
  await sleep(20) // 固定窗:墙钟 分隔两次 startedAt，重派刷新才可严格观测
  h.emit('subagent/start', { id: 'cat-child', runId: 'run-2', provider: 'fake-provider' })
  const re = h.panel('cat-child')
  check('B1 重派（新 runId）状态回 running、startedAt 刷新、输出清空',
    re?.status === 'running' && (re?.startedAt ?? 0) > before && (re?.output.length ?? 1) === 0 && (re?.toolCalls.length ?? 1) === 0,
    `status=${String(re?.status)} out=${String(re?.output.length)} tools=${String(re?.toolCalls.length)}`)
  // Host ordering: the previous epoch's end may trail the next start.
  h.emit('subagent/end', { id: 'cat-child', runId: 'run-1', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '迟到结论' }] })
  check('B2 上一 epoch 的迟到 end 不得错杀新一轮',
    h.panel('cat-child')?.status === 'running' && h.panel('cat-child')?.summary === undefined,
    `status=${String(h.panel('cat-child')?.status)} summary=${String(h.panel('cat-child')?.summary)}`)
  h.emit('subagent/end', { id: 'cat-child', runId: 'run-2', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '结论二' }] })
  check('B3 本 epoch 的 end 正常落地', h.panel('cat-child')?.status === 'completed' && h.panel('cat-child')?.summary === '结论二')
}

// ── C: resume bootstrap — durable events folded from the log ──
{
  const t0 = Date.now() - 3_600_000
  const seed = [
    catalog('old-child', '历史子任务', t0),
    catalog('idle-child', '驻留子任务', t0),
    { type: 'tool-workflow/run-start', seq: 1, time: t0, data: { runId: 'wr-1', name: 'audit' } },
    { type: 'tool-workflow/agent-start', seq: 2, time: t0, data: { runId: 'wr-1', seq: 0, label: '审计甲', childId: 'wf-old' } },
    { type: 'tool-workflow/agent-start', seq: 3, time: t0, data: { runId: 'wr-1', seq: 1, label: '审计乙', childId: 'wf-gone' } },
    { type: 'tool-workflow/agent-end', seq: 4, time: t0 + 5000, data: { runId: 'wr-1', seq: 0, outcome: 'failed' } },
  ]
  const h = makeHarness(seed, registry => {
    // One catalog child is STILL live mid-run in this process (adoption of a
    // running session): registered before the fold runs. Another stays
    // REGISTERED BUT IDLE — a continuable child parked between epochs must
    // not count as live (no fake running row, no replay card).
    registry.set('old-child', { status: 'running', session: { id: 'old-child', seq: 0, events: [], header: {} }, options: { provider: 'fake-provider' } })
    registry.set('idle-child', { status: 'idle', session: { id: 'idle-child', seq: 0, events: [], header: {} } })
  })

  const panelIds = h.channel.subagents.map(s => s.agentId).sort()
  check('C1 bootstrap 重建面板：catalog 历史 + workflow 成员齐全',
    JSON.stringify(panelIds) === JSON.stringify(['idle-child', 'old-child', 'wf-gone', 'wf-old']),
    JSON.stringify(h.channel.subagents.map(s => [s.agentId, s.status])))
  check('C2 registry 仍在运行的子代理显示 running',
    h.panel('old-child')?.status === 'running', `status=${String(h.panel('old-child')?.status)}`)
  check('C2b 注册但 idle 的 continuable 子代理不算 live（unknown、不出卡）',
    h.panel('idle-child')?.status === 'unknown' && h.row('idle-child') === undefined,
    `status=${String(h.panel('idle-child')?.status)} card=${String(h.row('idle-child') !== undefined)}`)
  check('C3 历史 catalog 子代理显示 unknown、startedAt 用日志时间',
    h.panel('wf-gone')?.status === 'unknown' && h.panel('wf-gone')?.startedAt === t0,
    `status=${String(h.panel('wf-gone')?.status)} at=${String(h.panel('wf-gone')?.startedAt)}`)
  check('C4 workflow 成员按 agent-end 落地终态（failed）',
    h.panel('wf-old')?.status === 'failed' && h.panel('wf-old')?.description === '审计甲',
    `status=${String(h.panel('wf-old')?.status)} desc=${String(h.panel('wf-old')?.description)}`)
  check('C4b 结算用持久 end 事件的墙钟（completedAt=事件时间，非 fold 时刻）',
    h.panel('wf-old')?.completedAt === t0 + 5000,
    `completedAt=${String(h.panel('wf-old')?.completedAt)} expect=${t0 + 5000}`)
  const transcriptOld = h.channel.rows.some(r => r.kind === 'subagent' && r.subagent?.agentId === 'wf-gone')
  check('C5 历史行不进转录（卡片只属于 live 发现）', transcriptOld === false,
    `rows=${JSON.stringify(h.channel.rows.filter(r => r.kind === 'subagent').map(r => r.subagent?.agentId))}`)
}

// ── D: late binding heal + peer-session non-pollution ──
{
  const h = makeHarness()
  // Start arrives while the registry does NOT yet know the child.
  h.emit('subagent/start', { id: 'late-child', runId: 'run-l', provider: 'fake-provider' })
  const child: FakeChild = { status: 'running', session: { id: 'late-child', seq: 0, events: [], header: {} } }
  h.childEvent(child, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '孤儿输出' } } })
  await sleep(40) // 固定窗:探针 等 flush 落定后确认输出仍未归属
  check('D1 未绑定会话事件不产生输出', (h.panel('late-child')?.output.join('') ?? '') === '')
  // The registry catches up (service mounted / child registered late).
  h.registry.set('late-child', child)
  h.childEvent(child, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '愈合输出' } } })
  await sleep(60) // 固定窗:探针 等 16ms flush 后读愈合归属的输出
  check('D2 registry 补齐后事件归属愈合（H2 延迟绑定）',
    (h.panel('late-child')?.output.join('') ?? '').includes('愈合输出'),
    `out=${h.panel('late-child')?.output.join('') ?? ''}`)
  // A peer top-level session (parked /bg agent) also lives in the registry.
  const peer: FakeChild = { session: { id: 'peer-session', seq: 0, events: [], header: {} } }
  h.registry.set('peer-session', peer)
  h.childEvent(peer, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'peer' } } })
  check('D3 peer 顶层会话不进子代理面板', h.panel('peer-session') === undefined,
    JSON.stringify(h.channel.subagents.map(s => s.agentId)))
}

// ── E: live workflow member lifecycle ──
{
  const h = makeHarness()
  const member: FakeChild = { status: 'running', session: { id: 'wf-live', seq: 0, events: [], header: {} } }
  // Registration races the member edge: agent-start lands FIRST, the registry
  // catches up only when the child starts streaming.
  h.parentEvent({ type: 'tool-workflow/agent-start', seq: 9, time: Date.now(), data: { runId: 'wr-2', seq: 3, label: '并行审计', childId: 'wf-live' } })
  check('E1 workflow 成员出生（未注册 → unknown，不出卡）',
    h.panel('wf-live')?.status === 'unknown' && h.row('wf-live') === undefined && h.panel('wf-live')?.description === '并行审计',
    `status=${String(h.panel('wf-live')?.status)} card=${String(h.row('wf-live') !== undefined)}`)
  h.registry.set('wf-live', member)
  h.childEvent(member, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '成员输出' } } })
  await sleep(60) // 固定窗:探针 等 16ms flush 后读成员输出投影
  check('E2 注册补齐后升级 running、出卡、输出实时归属',
    h.panel('wf-live')?.status === 'running' && h.row('wf-live') !== undefined && (h.panel('wf-live')?.output.join('') ?? '').includes('成员输出'),
    `status=${String(h.panel('wf-live')?.status)} out=${h.panel('wf-live')?.output.join('') ?? ''}`)
  h.parentEvent({ type: 'tool-workflow/agent-end', seq: 10, time: Date.now(), data: { runId: 'wr-2', seq: 3, outcome: 'cancelled' } })
  check('E3 agent-end 按成员 seq 落地（cancelled）', h.panel('wf-live')?.status === 'cancelled',
    `status=${String(h.panel('wf-live')?.status)}`)
}

// ── F: production Channel switches and real Cordis scoped delivery (#1019) ──
function makeSwitchHarness() {
  const ctx = new Context()
  type TestAgent = ReturnType<typeof makeAgent>
  const registry = new Map<string, TestAgent>()
  const scopes: Array<ReturnType<typeof createScope>> = []
  const emit = (subject: object, event: string, ...args: unknown[]) =>
    (ctx as unknown as { emit(...args: unknown[]): void }).emit(scopeTarget({}, subject), event, ...args)
  function makeAgent(id: string, parent?: { session: { id: string } }, registered = true) {
    const agent = {
      id, status: 'running', options: { provider: 'fake-provider', model: 'model-00' }, ctx,
      session: { id, seq: 0, events: [] as unknown[], header: {
        createdAt: Date.now(), cwd: '/tmp/demo',
        ...(parent ? { origin: 'subagent', parentSession: parent.session.id } : {}),
      } },
      followup() {}, steer() {}, cancel() {}, whenIdle: async () => {}, inbox: { remove: () => true },
    }
    const scope = createScope(ctx, agent, parent ? { parent } : undefined)
    scopes.push(scope)
    agent.ctx = scope.ctx
    if (registered) registry.set(id, agent)
    return agent
  }
  const handle = (agent: TestAgent) => ({ agent, async dispose() {
    registry.delete(agent.id)
    agent.status = 'disposed'
    emit(agent, 'agent/disposed', { agent })
  } })
  const a = makeAgent('switch-a')
  const b = makeAgent('switch-b')
  const disk = makeAgent('switch-disk', undefined, false)
  ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide('agents', {
    get: (id: string) => registry.get(id), list: () => [...registry.values()],
    create: async ({ sessionId }: { sessionId: string }) => handle(makeAgent(sessionId)),
    resume: async ({ resumeSessionId }: { resumeSessionId: string }) => {
      if (resumeSessionId !== disk.id) throw new Error('unexpected disk resume')
      registry.set(disk.id, disk)
      return handle(disk)
    },
  })
  const channel = createChannel(ctx, a as never, {
    model: 'model-00', provider: 'fake-provider', cwd: '/tmp/demo', activity: false, handle: handle(a) as never,
  })
  const event = (agent: TestAgent, input: { type: string; data: unknown; time?: number }) => {
    const value = { time: Date.now(), ...input, seq: agent.session.seq++ }
    agent.session.events.push(value)
    emit(agent, 'session/event', agent.session, value)
    return value
  }
  const start = (parent: TestAgent, id: string, runId: string, local = true) =>
    emit(parent, 'subagent/start', { id, runId, provider: 'worker', local })
  const end = (parent: TestAgent, id: string, runId: string) =>
    emit(parent, 'subagent/end', { id, runId, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'done' }] })
  const child = (parent: TestAgent, id: string) => {
    const result = makeAgent(id, parent)
    event(parent, catalog(id, id, Date.now() - 65_000))
    return result
  }
  const panel = (id: string) => channel.subagents.find(value => value.agentId === id)
  const tool = (agent: TestAgent, id: string) => event(agent, { type: 'tool/call', data: { callId: id, name: 'Read', arguments: '{}' } })
  const result = (agent: TestAgent, id: string) => event(agent, { type: 'tool/result', data: { message: { source: { callId: id }, content: [{ type: 'text', text: 'done' }] } } })
  const frame = (agent: TestAgent, value: object) => emit(agent, 'agent/assistant-stream', { agent, frame: value })
  return { ctx, a, b, disk, registry, makeAgent, channel, emit, event, start, end, child, panel, tool, result, frame,
    async close() { channel.releaseContributions(); for (const scope of scopes) await scope.dispose() },
  }
}

for (const route of ['background', 'live', 'disk'] as const) {
  const h = makeSwitchHarness()
  try {
    const child = h.child(h.a, `same-${route}`)
    const clock = Date.now
    Date.now = () => clock() - 65_000
    try { h.start(h.a, child.id, 'R1') } finally { Date.now = clock }
    h.tool(child, 'before')
    const startedAt = h.panel(child.id)?.startedAt
    const switchResult = route === 'background' ? await h.channel.backgroundCurrent()
      : await h.channel.attachToAgent(route === 'live' ? h.b.id : h.disk.id)
    check(`F-${route}-1 实际切换成功且前台没有后台子卡`, switchResult.ok && h.channel.subagents.length === 0)
    const rows = h.channel.rows
    const version = h.channel.version
    h.result(child, 'before')
    h.tool(child, 'while-away')
    h.result(child, 'while-away')
    check(`F-${route}-2 后台工具事件不修改前台投影或version`, h.channel.rows === rows && h.channel.version === version && h.channel.subagents.length === 0)
    check(`F-${route}-3 返回成功`, (await h.channel.attachToAgent(h.a.id)).ok)
    check(`F-${route}-4 同run保留时钟及后台工具结算`, h.panel(child.id)?.startedAt === startedAt
      && h.panel(child.id)?.runId === 'R1' && h.panel(child.id)?.toolCalls.length === 2
      && h.panel(child.id)?.toolCalls.every(tool => tool.status === 'completed') === true)
    check(`F-${route}-5 恢复一张对应仪表盘的卡片`, h.channel.rows.filter(row => row.kind === 'subagent' && row.subagent?.agentId === child.id).length === 1)
    h.tool(child, 'after')
    check(`F-${route}-6 恢复后事件仍更新同一子代理`, h.panel(child.id)?.toolCalls.length === 3)
  } finally { await h.close() }
}

{
  const h = makeSwitchHarness()
  try {
    const child = h.child(h.a, 'epochs')
    h.start(h.a, child.id, 'R1')
    h.tool(child, 'old-tool')
    await h.channel.attachToAgent(h.b.id)
    h.start(h.a, child.id, 'R2')
    h.end(h.a, child.id, 'R1') // delayed old end must not settle the new epoch
    h.tool(child, 'new-tool')
    await h.channel.attachToAgent(h.a.id)
    check('H1 后台新run覆盖R1且迟到end无效', h.panel(child.id)?.runId === 'R2' && h.panel(child.id)?.status === 'running'
      && h.panel(child.id)?.toolCalls.length === 1 && h.panel(child.id)?.toolCalls[0]?.id === 'new-tool')
    // Leave again via /bg so the second round is also parked with a handle.
    await h.channel.backgroundCurrent()
    h.result(child, 'new-tool')
    child.status = 'idle'
    h.end(h.a, child.id, 'R2')
    await h.channel.attachToAgent(h.a.id)
    check('H2 后台整轮完成不被恢复成running或unknown', h.panel(child.id)?.status === 'completed'
      && h.panel(child.id)?.toolCalls[0]?.status === 'completed' && h.panel(child.id)?.summary === 'done')
  } finally { await h.close() }
}

for (const settlementWhileAway of [false, true]) {
  const h = makeSwitchHarness()
  try {
    const child = h.child(h.a, `stream-${settlementWhileAway}`)
    h.start(h.a, child.id, 'R1')
    h.frame(child, { type: 'start', revision: 1, attemptId: 'A1', turn: 1, step: 1 })
    h.frame(child, { type: 'chunk', revision: 2, attemptId: 'A1', chunk: { type: 'text-delta', text: 'hello' } })
    await h.channel.attachToAgent(h.b.id)
    if (!settlementWhileAway) await h.channel.attachToAgent(h.a.id)
    const message = h.event(child, { type: 'assistant/message', data: { turn: 1, step: 1, stream: [], message: { content: [{ type: 'text', text: 'hello world' }] } } })
    h.emit(child, 'session/event', child.session, message)
    h.frame(child, { type: 'end', revision: 3, attemptId: 'A1', outcome: { kind: 'committed', eventType: 'assistant/message', seq: message.seq } })
    if (settlementWhileAway) await h.channel.attachToAgent(h.a.id)
    check(`I1-${settlementWhileAway} 流式settlement及重复事件仅保留一次持久结果`, JSON.stringify(h.panel(child.id)?.output) === JSON.stringify(['hello world']))
    h.frame(child, { type: 'start', revision: 4, attemptId: 'A2', turn: 1, step: 2 })
    h.frame(child, { type: 'chunk', revision: 5, attemptId: 'A2', chunk: { type: 'text-delta', text: 'discard me' } })
    await h.channel.backgroundCurrent()
    h.event(child, { type: 'assistant/attempt', data: { turn: 1, step: 2, stream: [] } })
    h.frame(child, { type: 'end', revision: 6, attemptId: 'A2', outcome: { kind: 'abandoned' } })
    await h.channel.attachToAgent(h.a.id)
    check(`I2-${settlementWhileAway} 后台撤销attempt不残留临时输出`, JSON.stringify(h.panel(child.id)?.output) === JSON.stringify(['hello world']))
  } finally { await h.close() }
}

{
  const h = makeSwitchHarness()
  try {
    const historical = h.child(h.a, 'workflow-reused')
    h.event(h.a, { type: 'tool-workflow/agent-start', data: { childId: historical.id, runId: 'old-workflow', seq: 0 } })
    h.event(h.a, { type: 'tool-workflow/agent-end', data: { runId: 'old-workflow', seq: 0, outcome: 'completed' } })
    h.start(h.a, historical.id, 'fresh-run')
    await h.channel.attachToAgent(h.b.id)
    const version = h.channel.version
    h.event(h.a, { type: 'tool/call', data: { callId: 'task', name: 'task', arguments: '{"description":"后台任务描述"}' } })
    h.start(h.a, 'external', 'remote-run', false) // no registry entry or catalog
    h.start(h.a, 'not-registered-yet', 'delayed-run')
    h.start(h.b, 'foreground-external', 'front-run', false)
    check('J1 两个真实父scope的外部子代理分离', h.channel.subagents.length === 1 && h.panel('foreground-external')?.runId === 'front-run' && h.panel('external') === undefined)
    const afterForeground = h.channel.version
    const late = h.child(h.a, 'late-background')
    h.start(h.a, late.id, 'late-run')
    h.tool(late, 'late-tool')
    const workflow = h.makeAgent('new-workflow', h.a)
    h.event(h.a, { type: 'tool-workflow/agent-start', data: { childId: workflow.id, runId: 'wf', seq: 0, label: '后台工作流' } })
    h.event(h.a, { type: 'tool-workflow/agent-end', data: { runId: 'wf', seq: 0, outcome: 'failed' } })
    const stranger = h.makeAgent('unviewed-peer')
    h.start(stranger, 'unknown-external', 'stranger-run', false)
    check('J2 后台新增child/workflow和未知peer不触发前台emit', h.channel.version === afterForeground && h.panel('late-background') === undefined && h.panel('unknown-external') === undefined && afterForeground > version)
    await h.channel.attachToAgent(h.a.id)
    check('J3 后台新增子代理/描述/工作流均恢复', h.panel('external')?.description === '后台任务描述'
      && h.panel('not-registered-yet')?.runId === 'delayed-run'
      && h.panel(late.id)?.toolCalls.length === 1 && h.panel(workflow.id)?.status === 'failed')
    check('J4 历史workflow结算不覆盖新的实时run', h.panel(historical.id)?.runId === 'fresh-run' && h.panel(historical.id)?.status === 'running')
    const completedAt = h.panel(workflow.id)?.completedAt
    await h.channel.backgroundCurrent()
    await h.channel.attachToAgent(h.a.id)
    check('J5 多次恢复不会再次fold历史workflow', h.panel(workflow.id)?.completedAt === completedAt)
  } finally { await h.close() }
}

{
  const h = makeSwitchHarness()
  try {
    const child = h.child(h.a, 'viewed-child')
    h.start(h.a, child.id, 'child-run')
    h.tool(child, 'nested-tool')
    await h.channel.attachToAgent(child.id)
    h.start(child, 'nested-remote', 'nested-run', false)
    check('K1 嵌套scope的外部子代理归直接父而非祖先', h.panel('nested-remote')?.runId === 'nested-run')
    h.result(child, 'nested-tool')
    h.frame(child, { type: 'start', revision: 1, attemptId: 'nested-attempt', turn: 1, step: 1 })
    h.frame(child, { type: 'chunk', revision: 2, attemptId: 'nested-attempt', chunk: { type: 'text-delta', text: 'preview' } })
    h.event(child, { type: 'assistant/message', data: { turn: 1, step: 1, stream: [], message: { content: [{ type: 'text', text: 'nested answer' }] } } })
    await h.channel.attachToAgent(h.a.id)
    check('K2 前台父/后台child双身份同时消费且不重复', h.panel(child.id)?.toolCalls[0]?.status === 'completed'
      && JSON.stringify(h.panel(child.id)?.output) === JSON.stringify(['nested answer']) && h.panel('nested-remote') === undefined)
  } finally { await h.close() }
}

{
  const h = makeSwitchHarness()
  const child = h.child(h.a, 'dispose-child')
  h.start(h.a, child.id, 'R1')
  await h.channel.backgroundCurrent()
  h.emit(h.a, 'agent/disposed', { agent: h.a })
  h.registry.delete(h.a.id)
  const before = h.channel.version
  h.start(h.a, 'post-dispose-remote', 'R2', false)
  h.tool(child, 'post-dispose')
  check('L1 已释放后台父的事件不流入前台', h.channel.version === before && h.channel.subagents.length === 0)
  await h.close()
  const disposedVersion = h.channel.version
  h.start(h.b, 'after-owner-dispose', 'R3', false)
  h.tool(child, 'after-owner-dispose')
  check('L2 owner释放后订阅全部失效', h.channel.version === disposedVersion)
}

// A registry-attached child has no Channel-owned handle: its upstream parent
// still owns its lifetime. Its own child reducer must survive a full round trip.
for (const route of ['live', 'background', 'disk'] as const) {
  const h = makeSwitchHarness()
  try {
    const child = h.child(h.a, `unowned-${route}`)
    h.start(h.a, child.id, 'child-run')
    await h.channel.attachToAgent(child.id)
    const grandchild = h.child(child, `grandchild-${route}`)
    h.start(child, grandchild.id, 'grandchild-run')
    h.start(child, 'external-grandchild', 'external-run', false)
    h.tool(grandchild, 'grandchild-tool')
    const startedAt = h.panel(grandchild.id)?.startedAt
    const result = route === 'background' ? await h.channel.backgroundCurrent()
      : await h.channel.attachToAgent(route === 'disk' ? h.disk.id : h.a.id)
    check(`M-${route}-1 无自有handle的子会话可以离开`, result.ok)
    if (route !== 'live') await h.channel.attachToAgent(h.a.id)
    h.result(grandchild, 'grandchild-tool')
    h.end(child, 'external-grandchild', 'external-run')
    await h.channel.attachToAgent(child.id)
    check(`M-${route}-2 完整A→子→离开→A→子保留孙任务及后台结算`,
      h.panel(grandchild.id)?.runId === 'grandchild-run'
      && h.panel(grandchild.id)?.startedAt === startedAt
      && h.panel(grandchild.id)?.toolCalls[0]?.status === 'completed'
      && h.panel('external-grandchild')?.status === 'completed')
  } finally { await h.close() }
}

{
  const h = makeSwitchHarness()
  try {
    const unviewedChild = h.child(h.a, 'never-viewed')
    h.start(h.a, unviewedChild.id, 'child-run')
    const version = h.channel.version
    h.start(unviewedChild, 'unviewed-external-grandchild', 'external-run', false)
    h.end(unviewedChild, 'unviewed-external-grandchild', 'external-run')
    check('N1 从未查看子会话的外部孙任务不能被唯一祖先scope认领',
      h.channel.subagents.length === 1 && h.panel('unviewed-external-grandchild') === undefined
      && h.channel.version === version)
  } finally { await h.close() }
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
