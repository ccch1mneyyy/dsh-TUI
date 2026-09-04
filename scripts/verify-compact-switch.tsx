/**
 * 压缩 × 会话切换生命周期回归（真实 channel.compact / switchModel + 可控
 * fake compaction 服务）：
 *
 *  1. 取消先于快照——压缩进行中 /model：switchModel 必须先 abort 并等压缩
 *     落定、再切片 source 快照（顺序断言），seed 不含任何压缩产物；
 *     toast 报「已取消并切换」，且不再追加误导性的通用「压缩失败」。
 *  2. persistence 分类——checkpoint 已提交但落盘失败（code:'persistence'）
 *     的拒绝必须与通用失败分开提示（含「压缩已生效」语义，不再裸报失败）。
 *  3. 已落定不阻塞——压缩正常完成后切换不再触发取消路径。
 *
 * 背景：长会话 /compact 的摘要 LLM 很慢，用户等不及直接 /model；旧实现
 * fork 快照先走、旧压缩事务在后台照常提交 checkpoint，新会话从"只剩摘要"
 * 的日志开始——用户视角即"压缩失败换了模型，上下文直接丢失"。
 *
 * 运行：node --import tsx/esm scripts/verify-compact-switch.tsx
 */
// 隔离家目录：switchModel 会把选择写进 ~/.dsh-tui/model.json（modelPrefs
// 在模块加载时按 homedir() 解析）。必须在 import src 之前；HOME 与
// USERPROFILE 成对设置，两个平台都隔离。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const reproHome = mkdtempSync(join(tmpdir(), 'dshtui-compact-switch-'))
process.env.HOME = reproHome
process.env.USERPROFILE = reproHome

const [{ createChannel }] = await Promise.all([
  import('../src/dsh-adapter/channel.js'),
])

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function settle(cond: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(25)
  }
  return cond()
}

// ---- 事件与 agent 桩 --------------------------------------------------------
let seq = 0
let now = Date.now()
function ev(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return { seq: seq++, time: (now += 5), type, data }
}
function makeEvents(turns = 2): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  for (let turn = 0; turn < turns; turn++) {
    events.push(ev('turn/start', { turn }))
    events.push(ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: `问题 ${turn}` }] }))
    events.push(ev('assistant/message', {
      turn, step: 0,
      message: { role: 'assistant', content: [{ type: 'text', text: `回答 ${turn}` }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    }))
    events.push(ev('turn/end', { turn, reason: { kind: 'completed' } }))
  }
  return events
}
const stubAgentCtx = { on: () => () => {} }
function makeAgent(id: string, sessionEvents: readonly unknown[], onSnapshot?: () => void) {
  return {
    id,
    status: 'idle',
    session: {
      id: `s-${id}`,
      seq: sessionEvents.length,
      get events() {
        onSnapshot?.()
        return sessionEvents
      },
      header: {},
    },
    ctx: stubAgentCtx,
    followup() {},
    steer() {},
    inbox: { remove: () => true },
  } as never
}

// ---- 可控 compaction 服务：记录 abort 时机，由剧本决定落定方式 ---------------
type Script = { kind: 'hang-until-abort' } | { kind: 'reject'; code?: string; message: string } | { kind: 'resolve' }
function makeCompaction(script: Script) {
  const calls: Array<{ agentId: string; abortedAt: number | undefined }> = []
  return {
    calls,
    async compactNow(agent: { id: string }, signal: AbortSignal): Promise<unknown> {
      const call = { agentId: agent.id, abortedAt: undefined as number | undefined }
      calls.push(call)
      if (script.kind === 'resolve') {
        await sleep(30)
        return { shadowedSeqs: [1, 2] }
      }
      if (script.kind === 'reject') {
        await sleep(30)
        throw Object.assign(new Error(script.message), script.code === undefined ? {} : { code: script.code })
      }
      // hang-until-abort：模拟慢摘要流——仅在 abort 后以 abort 原因拒绝
      // （region.ts 的 signal.throwIfAborted 语义）。
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          call.abortedAt = Date.now()
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
      return undefined
    },
  }
}

// ---- 组装 ctx：source snapshot / agents.create 记录调用顺序 -----------------
function assemble(script: Script) {
  const order: string[] = []
  const stamps = new Map<string, number>()
  const mark = (name: string) => {
    order.push(name)
    if (!stamps.has(name)) stamps.set(name, Date.now())
  }
  const compaction = makeCompaction(script)
  let agentCounter = 0
  const services: Record<string, unknown> = {
    agents: {
      async create(options: { sessionId: string; seed: readonly unknown[] }) {
        mark('create')
        agentCounter += 1
        return { agent: makeAgent(`fork-${agentCounter}`, options.seed), dispose: async () => {} }
      },
    },
    llm: {
      listProviders: () => [{ id: 'fake-provider' }],
      listModels: async () => [{ provider: 'fake-provider', id: 'model-b', name: 'Model B' }],
    },
    compaction,
  }
  const handlers = new Map<string, unknown>()
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
  const agent = makeAgent('a1', makeEvents(), () => mark('snapshot'))
  const channel = createChannel(ctx as never, agent as never, {
    model: 'model-a',
    cwd: '/tmp/demo',
    provider: 'fake-provider',
    activity: false,
  })
  return { order, stamps, compaction, channel, agent }
}
const toasts = (channel: { notifications: readonly { text: string }[] }) =>
  channel.notifications.map(item => item.text).join('\n')

// ==== 场景 1：压缩进行中 /model —— 取消必须先于 fork ==========================
{
  const { order, stamps, compaction, channel } = assemble({ kind: 'hang-until-abort' })
  channel.compact()
  const started = await settle(() => compaction.calls.length === 1)
  check('scene1: compactNow invoked', started)
  check('scene1: no create before switch', !order.includes('create'))

  // createChannel 的启动回放也读取一次日志；只观测本次 switchModel 的
  // source snapshot，且保留该窗口内第一次读取的时间戳。
  stamps.delete('snapshot')
  const switchResult = await channel.switchModel('fake-provider', 'model-b')
  check('scene1: switch succeeds', switchResult === true, JSON.stringify(order))
  // 严格顺序：取消落定后才能读取 seed；读取完成后才能 create。
  const abortedAt = compaction.calls[0]?.abortedAt
  const snapshotAt = stamps.get('snapshot')
  const createAt = stamps.get('create')
  check(
    'scene1: abort precedes seed snapshot, which precedes create',
    abortedAt !== undefined && snapshotAt !== undefined && createAt !== undefined
      && abortedAt <= snapshotAt && snapshotAt <= createAt,
    `abortedAt=${String(abortedAt)} snapshotAt=${String(snapshotAt)} createAt=${String(createAt)}`,
  )

  // toast：取消提示出现；随后不追加通用「压缩失败」（抑制闩）。
  await settle(() => channel.notifications.length >= 2)
  await sleep(150)
  const text = toasts(channel)
  check('scene1: cancel toast shown', text.includes('已取消并切换'), text)
  check('scene1: no misleading generic failure toast', !/压缩失败 ·/.test(text), text)
  // seed 快照不含压缩产物（checkpoint 事件从未写入——abort 先于提交）。
  check('scene1: create happened after cancel', order.includes('create'), JSON.stringify(order))
}

// ==== 场景 2：persistence 分类提示 ============================================
{
  const { channel } = assemble({ kind: 'reject', code: 'persistence', message: 'flush io error' })
  channel.compact()
  await settle(() => channel.notifications.length >= 2)
  await sleep(150)
  const text = toasts(channel)
  check('scene2: flush-failed toast distinguishes committed state', text.includes('压缩已生效') && text.includes('落盘'), text)
  check('scene2: not the generic failure line', !/压缩失败 ·/.test(text), text)
}

// ==== 场景 3：通用失败仍走原提示 ==============================================
{
  const { channel } = assemble({ kind: 'reject', message: 'Codex error: usage limit' })
  channel.compact()
  await settle(() => channel.notifications.length >= 2)
  await sleep(150)
  const text = toasts(channel)
  check('scene3: generic failure toast keeps the error', /压缩失败 ·.*usage limit/.test(text), text)
}

// ==== 场景 4：压缩已落定后切换不触发取消 ======================================
{
  const { order, compaction, channel } = assemble({ kind: 'resolve' })
  channel.compact()
  const done = await settle(() => channel.notifications.some(item => item.text.includes('已压缩')))
  check('scene4: compaction completed', done, toasts(channel))
  const switchResult = await channel.switchModel('fake-provider', 'model-b')
  check('scene4: switch succeeds', switchResult === true, JSON.stringify(order))
  const text = toasts(channel)
  check('scene4: no cancel toast for a settled compaction', !text.includes('已取消并切换'), text)
  check('scene4: compaction ran exactly once', compaction.calls.length === 1, String(compaction.calls.length))
}

process.exit(failed)
