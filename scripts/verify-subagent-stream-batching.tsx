/**
 * Subagent stream projection batching regression（外部审计 P0-C）。
 *
 * 真实 cordis Context + 真实 createChannel + 假 agents 服务。向一个
 * 已链接的 subagent session 连发 N 个 assistant/chunk（text-delta），
 * 统计 SubagentActivityStore.snapshot 的调用次数（投影次数的精确代理：
 * 每次 snapshot 都伴随一次全量深拷贝 + SubagentRow 重建路径）。
 *
 * 契约：
 *   1. chunk 风暴期间投影数远小于 chunk 数（按 16ms 帧对齐合并）；
 *   2. 风暴结束后最终 output 内容与逐 chunk 拼接完全一致（不丢字）；
 *   3. 非 chunk 事件（tool/call、subagent/end）立即投影：end 后状态
 *      同步可见（completed），不等下一个 16ms 帧；
 *   4. chunk 之后紧接 end（16ms 内）：end 的立即投影包含 chunk 数据
 *      （被取代的延迟 flush 不产生多余重复投影）。
 *
 * 运行：node --import tsx/esm scripts/verify-subagent-stream-batching.tsx
 */
process.env.FORCE_COLOR = '3'
// 断言文案与 locale 无关
process.env.DSH_TUI_LANG = 'zh'

// 家目录隔离：channel 构造路径会 touch 用户目录，先切临时目录再 import。
const { mkdtempSync, mkdirSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join: joinPath } = await import('node:path')
const isolatedHome = mkdtempSync(joinPath(tmpdir(), 'dshtui-subagent-batch-'))
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
mkdirSync(joinPath(isolatedHome, '.dsh-tui'), { recursive: true })

const [{ Context }, { createChannel }, { SubagentActivityStore }, { settle }] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/subagents.js'),
  import('./lib/term-test.mjs'),
])

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ── snapshot 计数插桩：包一层原方法 ──
let snapshotCalls = 0
const originalSnapshot = SubagentActivityStore.prototype.snapshot
SubagentActivityStore.prototype.snapshot = function (...args: []) {
  snapshotCalls += 1
  return (originalSnapshot as (...a: []) => unknown).apply(this, args)
} as typeof SubagentActivityStore.prototype.snapshot

// ── harness：真实 cordis root + 假 agents 服务（含 get） ──
const childSession = { id: 'child-session', seq: 0, events: [], header: {} }
const ctx = new Context()
;(ctx as unknown as { provide(name: string, value: unknown): () => void }).provide('agents', {
  get(id: string) {
    return id === 'child-agent'
      ? { session: childSession, options: { provider: 'fake-provider', model: 'model-00' } }
      : undefined
  },
})

const parent = {
  id: 'parent-agent',
  status: 'idle',
  options: {},
  ctx,
  session: { id: 'parent-session', seq: 0, events: [], header: {} },
  followup() {},
  steer() {},
  inbox: { remove() {} },
} as never

const channel = createChannel(ctx as never, parent, {
  model: 'model-00', cwd: '/tmp/demo', provider: 'fake-provider', activity: false,
})
const emitSessionEvent = (event: unknown) =>
  (ctx as unknown as { emit(event: string, ...args: unknown[]): void }).emit('session/event', childSession, event)

const chunk = (text: string) => ({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text } } })

// ── subagent/start：真实事件路径建立 agentId↔session 链接 ──
;(ctx as unknown as { emit(event: string, ...args: unknown[]): void }).emit('subagent/start', {
  id: 'child-agent', runId: 'run-1', provider: 'fake-provider',
})
await settle(() => channel.subagents.length === 1 && channel.subagents[0]?.agentId === 'child-agent')
const linked = channel.subagents.length === 1 && channel.subagents[0]!.agentId === 'child-agent'
check('subagent/start 建立 tracked subagent', linked, JSON.stringify(channel.subagents.map(s => s.agentId)))

// ── 1. chunk 风暴：200 个 delta 同步连发（事件循环同一 tick 内）──
const BURST = 200
let expected = ''
snapshotCalls = 0
for (let i = 0; i < BURST; i++) {
  const piece = `段${i}…`
  expected += piece
  emitSessionEvent(chunk(piece))
}
// 同 tick 发完：此时投影应远少于 chunk 数（仅 start 路径与 store 内部，
// channel 层的投影最多 0 次——全部延迟到 16ms flush）
const syncProjections = snapshotCalls
// 固定窗口保留：下方「flush 后投影次数受帧数约束」是不得超额的稳定性探针，
// settle 会在首次 flush（内容齐了）就返回，错过窗口后段的多余投影。
await sleep(120) // 等 16ms flush 落定
const subRow = channel.rows.find(r => r.kind === 'subagent')
const projected = (subRow?.subagent?.outputLines ?? []).join('')
check('chunk 风暴同步投影被延迟（远少于 chunk 数）', syncProjections <= 2, `syncProjections=${syncProjections}/${BURST}`)
check('chunk 内容完整投影（不丢字）', projected === expected, `len=${projected.length}/${expected.length}`)
check('flush 后投影次数受帧数约束', snapshotCalls - syncProjections <= 3, `flushProjections=${snapshotCalls - syncProjections}`)

// ── 2. 非 chunk 事件立即投影 ──
snapshotCalls = 0
emitSessionEvent({ type: 'tool/call', data: { callId: 'c1', name: 'Grep', arguments: '{}' } })
const toolVisible = channel.rows.find(r => r.kind === 'subagent')?.subagent?.toolCalls.some(t => t.name === 'Grep')
check('tool/call 立即投影（不等帧）', toolVisible === true, 'toolCalls=' + JSON.stringify(channel.rows.find(r => r.kind === 'subagent')?.subagent?.toolCalls.map(t => t.name)))

// ── 3. chunk 后 16ms 内 end：最终状态同步可见且包含 chunk 数据 ──
emitSessionEvent(chunk('尾巴'))
expected += '尾巴'
;(ctx as unknown as { emit(event: string, ...args: unknown[]): void }).emit('subagent/end', {
  id: 'child-agent', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '最终结论' }],
})
const endedRow = channel.rows.find(r => r.kind === 'subagent')
check('subagent/end 状态同步可见（completed）', endedRow?.subagent?.status === 'completed', 'status=' + String(endedRow?.subagent?.status))
check('end 前最后一帧 chunk 已含在投影中', (endedRow?.subagent?.outputLines ?? []).join('') === expected, 'len=' + (endedRow?.subagent?.outputLines ?? []).length)
check('final summary 不被延迟覆盖', endedRow?.subagent?.summary === '最终结论', 'summary=' + String(endedRow?.subagent?.summary))
// 被取代的延迟 flush 不再重复投影。固定窗口保留：这是「不得发生」的稳定
// 性探针，对已成立条件轮询会立即返回，等于没测。
const afterEnd = snapshotCalls
await sleep(80)
check('被取代的延迟 flush 无多余投影', snapshotCalls - afterEnd <= 1, `extra=${snapshotCalls - afterEnd}`)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
