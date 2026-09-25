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

const [{ Context }, { createChannel }, { settled, sleep }] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('../src/dsh-adapter/channel.js'),
  import('./lib/term-test.mjs'),
])

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

interface FakeChild { session: { id: string; seq: number; events: unknown[]; header: Record<string, unknown> }; options?: { provider?: string; model?: string } }

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
  } as never
  const channel = createChannel(ctx as never, parent, {
    model: 'model-00', cwd: '/tmp/demo', provider: 'fake-provider', activity: false,
  })
  const emit = (name: string, ...args: unknown[]) =>
    (ctx as unknown as { emit(event: string, ...a: unknown[]): void }).emit(name, ...args)
  return {
    registry, channel, emit,
    parentEvent: (event: unknown) => emit('session/event', parentSession, event),
    childEvent: (child: FakeChild, event: unknown) => emit('session/event', child.session, event),
    row: (agentId: string) => channel.rows.find(r => r.kind === 'subagent' && r.subagent?.agentId === agentId)?.subagent,
    panel: (agentId: string) => channel.subagents.find(s => s.agentId === agentId),
  }
}

const catalog = (childId: string, label: string, at: number) =>
  ({ type: 'subagent/catalog', seq: 0, time: at, data: { version: 0, childId, childCreatedAt: at, mode: 'continuable', label } })

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

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
