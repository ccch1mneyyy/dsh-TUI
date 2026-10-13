/**
 * 压缩 × 会话切换生命周期回归（真实 channel.compact / switchModel + 可控
 * fake compaction 服务）：
 *
 *  1. 压缩进行中 /model：只改后续请求路由，不取消压缩（摘要按已记录路由
 *     执行）；不读取 fork seed、不创建新会话，也不提示取消。
 *  2. persistence 分类——checkpoint 已提交但落盘失败（code:'persistence'）
 *     的拒绝必须与通用失败分开提示（含「压缩已生效」语义，不再裸报失败）。
 *  3. 已落定不阻塞——压缩正常完成后切换不触发取消路径。
 *  4. /fork 与逐行 rewind 也必须在快照前取消同一压缩事务。
 *  5. 压缩事务归属 live Agent：/bg 转后台与返回只换前台视图，原会话的压缩
 *     继续且可取消；切到别的会话则落定被离开会话的压缩。
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
process.env.DSH_TUI_LANG = 'zh' // 中文通知断言必须在 i18n import 前固定语言。

const [{ createChannel }, { settled }] = await Promise.all([
  import('../src/dsh-adapter/channel.js'),
  import('./lib/term-test.mjs'),
])

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
// 轮询到条件成立后返回终值（term-test 的 settled 就是这条语义）。
function settle(cond: () => boolean, ms = 3000): Promise<boolean> {
  return settled(cond, { timeoutMs: ms })
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
function makeAgent(id: string, sessionEvents: readonly unknown[] = [], onSnapshot?: () => void) {
  return {
    id,
    status: 'idle',
    session: {
      id,
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
    cancel() {},
    inbox: { remove: () => true },
  }
}

/**
 * Append events to a live stub session the way a real host would: the session's
 * exclusive seq must match its snapshot length, or the fork/rewind seed slice
 * rejects the whole log ("live Session contract violation: snapshot length N
 * does not match exclusive seq M").
 */
function appendLiveEvents(session: { events: readonly unknown[]; seq: number }, events: readonly unknown[]): void {
  const log = session.events as unknown[]
  log.push(...events)
  session.seq = log.length
}

// ---- 可控 compaction 服务：记录 abort 时机，由剧本决定落定方式 ---------------
type Script = { kind: 'hang-until-abort' } | { kind: 'reject'; code?: string; message: string } | { kind: 'resolve' }
function makeCompaction(script: Script) {
  const calls: Array<{ agentId: string; abortedAt: number | undefined; finished: boolean; finish(): void }> = []
  return {
    calls,
    async compactNow(agent: { id: string }, signal: AbortSignal): Promise<unknown> {
      let finish!: () => void
      const completion = new Promise<void>(resolve => { finish = resolve })
      const call = { agentId: agent.id, abortedAt: undefined as number | undefined, finished: false, finish }
      calls.push(call)
      if (script.kind === 'resolve') {
        await sleep(30) // 固定窗:pacing 桩内模拟压缩耗时，不是在等可观测状态
        return { shadowedSeqs: [1, 2] }
      }
      if (script.kind === 'reject') {
        await sleep(30) // 固定窗:pacing 桩内模拟压缩耗时，不是在等可观测状态
        throw Object.assign(new Error(script.message), script.code === undefined ? {} : { code: script.code })
      }
      // 慢摘要由场景显式结束，或以宿主 signal 的 abort 原因拒绝。
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          call.abortedAt = Date.now()
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
        }
        void completion.then(() => { signal.removeEventListener('abort', onAbort); resolve() })
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }).finally(() => { call.finished = true })
      return { shadowedSeqs: [1, 2] }
    },
  }
}

// ---- 组装 ctx：source snapshot / agents.create 记录调用顺序 -----------------
function assemble(script: Script) {
  // Each assembly is an independent session: restart the event sequence so the
  // log's `seq` stays index-aligned (makeAgent publishes `seq: events.length`)
  // and rewind boundaries computed from a row's `seq` resolve inside it.
  seq = 0
  const order: string[] = []
  const stamps = new Map<string, number>()
  const mark = (name: string) => {
    order.push(name)
    if (!stamps.has(name)) stamps.set(name, Date.now())
  }
  const compaction = makeCompaction(script)
  type Handler = (...args: unknown[]) => unknown
  const handlers = new Map<string, Set<Handler>>()
  const emit = (event: string, ...args: unknown[]): void => {
    for (const handler of [...handlers.get(event) ?? []]) handler(...args)
  }
  const live = new Map<string, ReturnType<typeof makeAgent>>()
  const handleFor = (agent: ReturnType<typeof makeAgent>) => ({
    agent,
    dispose: async () => { live.delete(agent.session.id); emit('agent/disposed', { agent }) },
  })
  const services: Record<string, unknown> = {
    agents: {
      get: (id: string) => live.get(id),
      list: () => [...new Set(live.values())],
      async create(options: { sessionId: string; seed: readonly unknown[] }) {
        mark('create')
        const created = makeAgent(options.sessionId, options.seed)
        live.set(String(created.session.id), created)
        return handleFor(created)
      },
    },
    llm: {
      listProviders: () => [{ id: 'fake-provider' }],
      listModels: async () => [{ provider: 'fake-provider', id: 'model-b', name: 'Model B' }],
    },
    compaction,
  }
  const ctx = {
    on(event: string, handler: Handler) {
      const entries = handlers.get(event) ?? new Set<Handler>()
      handlers.set(event, entries)
      entries.add(handler)
      return () => entries.delete(handler)
    },
    get(name: string) {
      return services[name]
    },
    logger: { warn() {} },
  }
  const agent = makeAgent('a1', makeEvents(), () => mark('snapshot'))
  live.set(String(agent.session.id), agent)
  const channel = createChannel(ctx as never, agent as never, {
    model: 'model-a',
    cwd: '/tmp/demo',
    provider: 'fake-provider',
    activity: false,
    handle: handleFor(agent) as never,
  })
  const stream = (sessionId: string) => {
    const source = async function* () {
      yield { type: 'text-delta', text: 'abc' }
      yield { type: 'reasoning-delta', text: 'de' }
      yield { type: 'text-delta', text: 'fgh' }
    }
    const next = [...handlers.get('llm/stream') ?? []].reduceRight<() => AsyncIterable<unknown>>(
      (next, handler) => () => handler({ purpose: 'compaction', sessionId }, next) as AsyncIterable<unknown>,
      source,
    )
    return next()[Symbol.asyncIterator]()
  }
  return { order, stamps, compaction, channel, agent, handlers, emit, stream, live }
}
const toasts = (channel: { notifications: readonly { text: string }[] }) =>
  channel.notifications.map(item => item.text).join('\n')

// ==== 场景 1：压缩进行中 /model —— 只换路由，不取消压缩 =====================
{
  const { order, stamps, compaction, channel } = assemble({ kind: 'hang-until-abort' })
  channel.compact()
  const started = await settle(() => compaction.calls.length === 1)
  check('scene1: compactNow invoked', started)

  // createChannel 的启动回放也读取一次日志；只观测本次 switchModel。
  stamps.delete('snapshot')
  const switchResult = await channel.switchModel('fake-provider', 'model-b')
  check('scene1: switch succeeds', switchResult === true, JSON.stringify(order))
  check('scene1: route adopted', channel.model === 'model-b', channel.model)
  check('scene1: compaction keeps running', compaction.calls[0]?.abortedAt === undefined)
  check('scene1: route adoption does not snapshot or create a session',
    !stamps.has('snapshot') && !order.includes('create'), JSON.stringify(order))
  await sleep(150) // 固定窗:探针 观察窗内不得出现取消提示
  const text = toasts(channel)
  check('scene1: no cancel toast', !text.includes('已取消并切换会话'), text)
  channel.releaseContributions()
}

// ==== 场景 2：/fork —— 取消必须先于快照 ======================================
{
  const { order, stamps, compaction, channel } = assemble({ kind: 'hang-until-abort' })
  channel.compact()
  const started = await settle(() => compaction.calls.length === 1)
  check('scene2: compactNow invoked before /fork', started)
  // createChannel 的启动回放也读取一次日志；只观测本次 /fork 的 source
  // snapshot，且保留该窗口内第一次读取的时间戳。
  stamps.delete('snapshot')
  const forked = await channel.forkSession()
  check('scene2: /fork succeeds', forked === true, JSON.stringify(order))
  const abortedAt = compaction.calls[0]?.abortedAt
  const snapshotAt = stamps.get('snapshot')
  check(
    'scene2: /fork abort strictly precedes snapshot',
    abortedAt !== undefined && snapshotAt !== undefined && abortedAt <= snapshotAt,
    `abortedAt=${String(abortedAt)} snapshotAt=${String(snapshotAt)}`,
  )
}

// ==== 场景 3：逐行 rewind —— 取消必须先于快照 ================================
{
  const { order, stamps, compaction, channel } = assemble({ kind: 'hang-until-abort' })
  channel.compact()
  const started = await settle(() => compaction.calls.length === 1)
  check('scene3: compactNow invoked before row rewind', started)
  // 同上：只观测本次逐行 rewind 的 source snapshot。
  stamps.delete('snapshot')
  const restored = await channel.rewindTo({ seq: 5, text: '回答 1' })
  check('scene3: row rewind succeeds', restored === '回答 1', JSON.stringify(order))
  const abortedAt = compaction.calls[0]?.abortedAt
  const snapshotAt = stamps.get('snapshot')
  check(
    'scene3: row rewind abort strictly precedes snapshot',
    abortedAt !== undefined && snapshotAt !== undefined && abortedAt <= snapshotAt,
    `abortedAt=${String(abortedAt)} snapshotAt=${String(snapshotAt)}`,
  )
}

// ==== 场景 4：persistence 分类提示 ============================================
{
  const { channel } = assemble({ kind: 'reject', code: 'persistence', message: 'flush io error' })
  channel.compact()
  await settle(() => channel.notifications.length >= 2)
  await sleep(150) // 固定窗:探针 抑制闩：观察窗内不得再追加通用「压缩失败」提示
  const text = toasts(channel)
  check('scene4: flush-failed toast distinguishes committed state', text.includes('压缩已生效') && text.includes('落盘'), text)
  check('scene4: not the generic failure line', !/压缩失败 ·/.test(text), text)
}

// ==== 场景 5：通用失败仍走原提示 ==============================================
{
  const { channel } = assemble({ kind: 'reject', message: 'Codex error: usage limit' })
  channel.compact()
  await settle(() => channel.notifications.length >= 2)
  await sleep(150) // 固定窗:探针 观察窗内提示不得被后续通用失败覆盖
  const text = toasts(channel)
  check('scene5: generic failure toast keeps the error', /压缩失败 ·.*usage limit/.test(text), text)
}

// ==== 场景 6：owner 回收中止压缩，晚完成不通知 =================================
{
  const { compaction, channel } = assemble({ kind: 'hang-until-abort' })
  channel.compact()
  const started = await settle(() => compaction.calls.length === 1)
  check('scene6: compactNow invoked before owner disposal', started)
  channel.releaseContributions()
  const afterDispose = channel.notifications.length
  const aborted = await settle(() => compaction.calls[0]?.abortedAt !== undefined)
  check('scene6: owner disposal aborts in-flight compaction', aborted)
  await sleep(100) // 固定窗:探针 抑制闩：观察窗内不得再追加通知
  check('scene6: aborted completion adds no notification', channel.notifications.length === afterDispose, toasts(channel))
}

// ==== 场景 7：压缩已落定后切换不触发取消 ======================================
{
  const { order, compaction, channel } = assemble({ kind: 'resolve' })
  channel.compact()
  const done = await settle(() => channel.notifications.some(item => item.text.includes('已压缩')))
  check('scene7: compaction completed', done, toasts(channel))
  const switchResult = await channel.switchModel('fake-provider', 'model-b')
  check('scene7: switch succeeds', switchResult === true, JSON.stringify(order))
  const text = toasts(channel)
  check('scene7: no cancel toast for a settled compaction', !text.includes('已取消并切换会话'), text)
  check('scene7: compaction ran exactly once', compaction.calls.length === 1, String(compaction.calls.length))
}

// ==== 场景 8：/bg 后 Esc 返回的 resumeTo 不得中止原会话压缩 =================
{
  const { channel, agent, compaction, stream } = assemble({ kind: 'hang-until-abort' })
  channel.compact()
  check('scene8: manual compaction started', await settle(() => compaction.calls.length === 1))
  const startedAt = channel.compaction?.startedAt
  const summary = stream(agent.session.id)
  await summary.next()
  check('scene8: foreground summary chars are counted once', channel.compaction?.outputChars === 3)
  const backgrounded = await channel.backgroundCurrent()
  check('scene8: /bg parks the originating session', backgrounded.ok && backgrounded.backgroundedSessionId === agent.session.id)
  check('scene8: /bg does not abort the summarizer', compaction.calls[0]?.abortedAt === undefined)
  check('scene8: the fresh foreground has no old progress row', channel.compaction === undefined)
  await summary.next()
  check('scene8: background summary does not paint the fresh foreground', channel.compaction === undefined)
  const returned = await channel.resumeTo(agent.session.id)
  check('scene8: return reattaches the original live agent', returned.ok && channel.agentId === agent.id)
  check('scene8: return does not abort the summarizer', compaction.calls[0]?.abortedAt === undefined)
  check('scene8: return restores the original cancellable row', channel.compaction?.cancellable === true && channel.compaction.startedAt === startedAt)
  check('scene8: return includes progress produced in the background', channel.compaction?.phase === 'summary' && channel.compaction.outputChars === 5)
  await summary.next()
  check('scene8: the original stream keeps updating after return', channel.compaction?.outputChars === 8)
  channel.cancelCompact()
  check('scene8: explicit cancellation after return reaches the original request', await settle(() => compaction.calls[0]?.abortedAt !== undefined))
  check('scene8: explicit cancellation clears the restored row', await settle(() => channel.compaction === undefined))
  channel.releaseContributions()
}

// ==== 场景 9：后台完成不得清掉另一个会话的新压缩 ============================
{
  const { channel, agent, compaction } = assemble({ kind: 'hang-until-abort' })
  channel.compact()
  await settle(() => compaction.calls.length === 1)
  await channel.backgroundCurrent()
  channel.cancelCompact()
  check('scene9: cancelling an idle foreground leaves the background request alone', compaction.calls[0]?.abortedAt === undefined)
  channel.compact()
  check('scene9: another live agent can compact independently', await settle(() => compaction.calls.length === 2))
  const foregroundRow = channel.compaction
  const notices = channel.notifications.length
  compaction.calls[0].finish()
  await settle(() => compaction.calls[0].finished)
  check('scene9: background completion does not clear foreground progress', channel.compaction === foregroundRow && foregroundRow !== undefined)
  check('scene9: background completion does not announce success for the foreground', channel.notifications.length === notices)
  channel.cancelCompact()
  check('scene9: explicit cancel targets the foreground request', await settle(() => compaction.calls[1]?.abortedAt !== undefined))
  check('scene9: the background request completed without cancellation', compaction.calls[0].abortedAt === undefined)
  await channel.resumeTo(agent.session.id)
  check('scene9: a finished background compaction is not resurrected on return', channel.compaction === undefined)
  channel.releaseContributions()
}

// ==== 场景 10：离开压缩中的会话落定它，回到它则保留 =========================
{
  const { channel, agent, compaction, handlers, live } = assemble({ kind: 'hang-until-abort' })
  channel.compact()
  await settle(() => compaction.calls.length === 1)
  await channel.backgroundCurrent()
  // A real compaction has conversation content to summarize; empty fresh
  // sessions are intentionally retired by live adoption instead of parked.
  const freshId = channel.agentId
  appendLiveEvents(live.get(freshId)!.session, makeEvents())
  channel.compact()
  await settle(() => compaction.calls.length === 2)
  // Returning to the compacting session: what settles is the transaction of
  // the session being LEFT (the fresh foreground), never the target's.
  const returned = await channel.resumeTo(agent.session.id)
  check('scene10: returning to the compacting session keeps its own transaction',
    returned.ok && compaction.calls[0]?.abortedAt === undefined)
  check('scene10: returning settles the compaction of the session left behind',
    await settle(() => compaction.calls[1]?.abortedAt !== undefined))
  check('scene10: the settle is announced as a switch cancellation',
    toasts(channel).includes('已取消并切换会话'))
  // Leaving it again for the other session settles the compaction it holds.
  await channel.resumeTo(freshId)
  check('scene10: switching away settles the compaction of the session left behind',
    await settle(() => compaction.calls[0]?.abortedAt !== undefined))
  check('scene10: the settled session publishes no progress row', channel.compaction === undefined)
  // Both requests above are already settled by the switches, so disposal would
  // have nothing left to abort. Park a NEW one and let disposal be the only
  // thing that can end it.
  await channel.resumeTo(agent.session.id)
  channel.compact()
  await settle(() => compaction.calls.length === 3)
  await channel.backgroundCurrent()
  check('scene10: the parked request is still running before disposal',
    compaction.calls[2]?.abortedAt === undefined)
  channel.releaseContributions()
  check('scene10: owner disposal aborts parked compactions too',
    await settle(() => compaction.calls[2]?.abortedAt !== undefined))
  check('scene10: owner disposal removes compaction and session listeners', await settle(() =>
    ['llm/stream', 'session/event', 'agent/disposed'].every(name => (handlers.get(name)?.size ?? 0) === 0)))
}

// ==== 场景 11：停止后台 Agent 会中止它的手动压缩 =============================
{
  const { channel, agent, compaction } = assemble({ kind: 'hang-until-abort' })
  channel.compact()
  await settle(() => compaction.calls.length === 1)
  await channel.backgroundCurrent()
  check('scene11: background stop succeeds', await channel.stopBackgroundAgent(agent.session.id))
  check('scene11: disposed background agent cannot keep compacting', await settle(() => compaction.calls[0]?.abortedAt !== undefined))
  check('scene11: disposal does not publish a cancellation for another session', !toasts(channel).includes('压缩已取消'))
  channel.releaseContributions()
}

// ==== 场景 12：自动压缩没有手动事务，仍由回合与宿主事件管理 =================
{
  const { channel, agent, compaction, emit, stream } = assemble({ kind: 'hang-until-abort' })
  emit('session/event', agent.session, ev('compaction/start', {}))
  check('scene12: automatic compaction stays non-cancellable', channel.compaction?.cancellable === false)
  const summary = stream(agent.session.id)
  await summary.next()
  check('scene12: automatic progress still uses the normal projector', channel.compaction?.outputChars === 3)
  channel.cancelCompact()
  check('scene12: explicit manual cancellation cannot stop an automatic compaction', channel.compaction?.cancellable === false && compaction.calls.length === 0)
  emit('session/event', agent.session, ev('compaction/end', {}))
  check('scene12: host completion clears automatic progress', channel.compaction === undefined)
  channel.releaseContributions()
}

// ==== 场景 13：/fork 只落定来源会话的压缩 ===================================
{
  const { channel, compaction, live } = assemble({ kind: 'hang-until-abort' })
  channel.compact()
  await settle(() => compaction.calls.length === 1)
  await channel.backgroundCurrent()
  appendLiveEvents(live.get(channel.agentId)!.session, makeEvents())
  channel.compact()
  await settle(() => compaction.calls.length === 2)
  const forked = await channel.forkSession()
  check('scene13: /fork succeeds', forked === true, toasts(channel))
  check('scene13: /fork cancels the source session compaction',
    await settle(() => compaction.calls[1]?.abortedAt !== undefined))
  check('scene13: /fork leaves a parked session compaction alone',
    compaction.calls[0]?.abortedAt === undefined)
  channel.releaseContributions()
}

// ==== 场景 14：宿主只发出 legacy compaction/end 时也要清掉手动行 ===========
{
  const { channel, agent, compaction, handlers } = assemble({ kind: 'hang-until-abort' })
  channel.compact()
  await settle(() => compaction.calls.length === 1)
  check('scene14: the manual row is open', await settle(() => channel.compaction?.cancellable === true))
  // On a host whose translator accepts the bracket the projector folds the
  // event too; one that drops it leaves the transaction listener as the only
  // consumer. Drive that listener alone so the assertion covers that host.
  const listeners = [...(handlers.get('session/event') ?? [])]
  check('scene14: the transaction listener is the newest session subscriber', listeners.length >= 2)
  listeners[listeners.length - 1]!(agent.session, ev('compaction/end', {}))
  check('scene14: the legacy end bracket clears the manual row', await settle(() => channel.compaction === undefined))
  check('scene14: the bracket does not cancel the request', compaction.calls[0]?.abortedAt === undefined)
  channel.releaseContributions()
}

process.exit(failed)
