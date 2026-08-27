/**
 * 审批面板外部来源徽标回归（伪造审批钓鱼的缓解半步）。
 *
 * approval/request 是进程内瀑布事件：任何插件都能带着真实 callId 与命令
 * 文本伪造一条请求（listener 只校验 agent.id 归属）。完整修复（调用者
 * 身份校验）需上游配合；本守卫是可落地的判别：合法审批发生在工具执行
 * 之前——会话日志里配对的 tool/call 存在、且该 callId 还没有
 * tool/result。不满足（无 callId / 无配对 call / 已有 result）即视为
 * 非活跃来源，面板数据带 external 标记并由 ApprovalPanel 醒目渲染。
 *
 * Run: node --import tsx/esm scripts/verify-approval-source-badge.tsx
 */

import assert from 'node:assert/strict'

process.env.FORCE_COLOR = '3'

const [
  { PassThrough, Writable },
  React,
  { Terminal },
  { render },
  { ApprovalPanel },
  { ApprovalStore },
  { sleep, settled },
  { setLang },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/approvals/ApprovalPanel.js'),
  import('../src/dsh-adapter/approvals.js'),
  import('./lib/term-test.mjs'),
  import('../src/i18n.js'),
])

type SessionEvent = { type: string; seq: number; time: number; data: Record<string, unknown> }

/** 构造一条配对指定 callId 的已落定 tool/result 事件。 */
function toolResult(callId: string): SessionEvent {
  return {
    type: 'tool/result',
    seq: 2,
    time: Date.now() - 1000,
    data: { turn: 1, step: 1, message: { source: { callId } } },
  }
}

/** 构造一段最小会话日志：一个工具调用 + 可选的已落定结果。 */
function events(callId: string, opts: { resolved?: boolean } = {}): SessionEvent[] {
  const seed: SessionEvent[] = [
    {
      type: 'tool/call',
      seq: 1,
      time: Date.now() - 2000,
      data: { turn: 1, step: 1, callId, name: 'Bash', arguments: JSON.stringify({ command: 'rm -rf /tmp/real-command' }) },
    },
  ]
  if (opts.resolved) seed.push(toolResult(callId))
  return seed
}

function approvalRequest(callId: string | undefined, sessionEvents: SessionEvent[]): never {
  return {
    agent: { id: 'agent-1', session: { id: 's1', seq: 2, events: sessionEvents } },
    toolName: 'Bash',
    ...(callId !== undefined ? { callId } : {}),
    reason: '需要删除临时文件',
  } as never
}

async function parkedSnapshot(request: never): Promise<ReturnType<ApprovalStore['getSnapshot']>> {
  const store = new ApprovalStore()
  void store.park(request).catch(() => 'cancelled')
  // park 同步入队并激活首条（Promise 构造器体同步执行）。
  return store.getSnapshot()
}

// ── 活跃调用：无标记，命令照常恢复 ────────────────────────────────────
const live = await parkedSnapshot(approvalRequest('call-live', events('call-live')))
assert.notEqual(live, null)
assert.equal(live!.command, 'rm -rf /tmp/real-command', 'the paired command is still recovered')
assert.equal(live!.external, undefined, 'a live unresolved tool call must NOT carry the external mark')

// ── 已落定的调用（重放钓鱼）：external 标记 + 命令仍显示（钓鱼正文）──
const replay = await parkedSnapshot(approvalRequest('call-done', events('call-done', { resolved: true })))
assert.equal(replay!.external, true, 'a callId that already has a tool/result must be marked external')
assert.equal(replay!.command, 'rm -rf /tmp/real-command')

// ── 无 callId / 未知 callId：external 标记 ────────────────────────────
const callless = await parkedSnapshot(approvalRequest(undefined, events('call-live')))
assert.equal(callless!.external, true, 'a request without a callId is not from a live tool call')
const unknown = await parkedSnapshot(approvalRequest('call-ghost', events('call-live')))
assert.equal(unknown!.external, true, 'a callId matching no tool call must be marked external')
assert.equal(unknown!.command, undefined)

// ── P-4：callId 复用窗口——同 callId 第二条在第一条落定后必须复查 ──────
// 红队场景：合法请求（callId=X 无 result）挂起期间，伪造者用同 callId
// 二次注入——入队时 X 尚未落定，两条都判 live 无徽标；用户允许第一条 →
// 工具执行、X 落定 tool/result → 伪造请求成为当前面板。external 若只在
// park() 入队时定型，弹出/渲染永不复查 → 伪造请求无徽标 → 误确认。
{
  // 时序 1（真实顺序）：twin 先被弹出成为当前面板，tool/result 后落地
  // ——徽标只能靠「读取当前条时」的重查补上。
  const store = new ApprovalStore()
  const log = events('call-twin')
  const first = store.park(approvalRequest('call-twin', log))
  const second = store.park(approvalRequest('call-twin', log))
  assert.equal(store.getSnapshot()!.external, undefined,
    'the twin is genuinely live while its callId is unresolved — no badge yet')
  store.decide('allowed-once') // 第一条落定，twin 立即成为当前面板
  assert.equal(await first, 'allowed-once')
  log.push(toolResult('call-twin')) // 工具执行，X 落定
  assert.equal(store.getSnapshot()!.external, true,
    'P-4: once the twin surfaces and its callId settles, the badge must appear (read-time recheck)')
  store.settleAll('cancelled')
  assert.equal(await second, 'cancelled')
}
{
  // 时序 2：tool/result 先落地、twin 后被弹出——徽标靠「弹出下一条时」
  // 的重查补上。
  const store = new ApprovalStore()
  const log = [...events('call-a'), ...events('call-b')]
  const first = store.park(approvalRequest('call-a', log))
  const second = store.park(approvalRequest('call-b', log)) // 伪造孪生，排队
  assert.equal(store.getSnapshot()!.external, undefined,
    'the active call-a is still unresolved — no badge for it')
  log.push(toolResult('call-b')) // call-b 在第一条还挂着时落定
  store.decide('allowed-once') // 弹出 twin——复查必须发现 call-b 已落定
  assert.equal(store.getSnapshot()!.external, true,
    'P-4: a twin promoted after its callId settled must carry the badge (promotion-time recheck)')
  store.settleAll('cancelled')
  assert.equal(await first, 'allowed-once')
  assert.equal(await second, 'cancelled')
}
{
  // 时序 3（review 竞态，队内去重）：真实审批（callId=X 无 result）挂起 →
  // 恶意插件用同 callId=X 塞入孪生（入队时 X 未落定，两条都判 live）→
  // 用户允许第一条 → decide 同步晋升孪生，而真实工具仍在执行、
  // tool/result 尚未落盘——晋升时复查看不到 result，徽标必须来自
  // 「一个 callId 只该有一次合法审批请求」的确定性判定，不依赖
  // tool/result 落盘时序。
  const store = new ApprovalStore()
  const log = events('call-race') // 只有 tool/call，全程不写 result
  const first = store.park(approvalRequest('call-race', log))
  const second = store.park(approvalRequest('call-race', log)) // 同 callId 孪生
  store.decide('allowed-once') // 允许第一条；真实工具还在执行，log 不动
  assert.equal(store.getSnapshot()!.external, true,
    'P-4: a twin whose callId is ALREADY in flight must carry the badge at promotion (in-flight dedup) — the result may not land for a while')
  store.settleAll('cancelled')
  assert.equal(await first, 'allowed-once')
  assert.equal(await second, 'cancelled')
}
{
  // 时序 4（事件驱动主动刷新，CodeRabbit）：徽标翻转此前只发生在
  // getSnapshot 被再次读取时——React 不知道会话日志变了。若渲染静默
  // （无流式 spinner 等触发重读），已显示的面板不会补上徽标。store 必
  // 须提供会话事件通知入口：tool/result 落地时主动重查 active 并通过
  // emit 通知订阅者（useSyncExternalStore 重新读取快照）。
  const store = new ApprovalStore()
  const log = events('call-push') // 只有 tool/call，active 判 live
  const ask = store.park(approvalRequest('call-push', log))
  assert.equal(store.getSnapshot()!.external, undefined,
    'the panel shows a genuinely live ask — no badge yet')
  let notifies = 0
  store.subscribe(() => { notifies += 1 }) // 探针：面板的 re-render 通道
  log.push(toolResult('call-push')) // tool/result 落地——不再调用 getSnapshot
  store.noteSessionEvent(toolResult('call-push')) // 会话事件回调直达 store
  await sleep(30) // scheduleNotify 走微任务
  assert.ok(notifies >= 1,
    'P-4: a settled tool/result must emit so a silent render loop re-reads the flipped snapshot')
  assert.equal(store.getSnapshot()!.external, true,
    'P-4: the event-driven recheck must flip the badge without a prior getSnapshot')
  store.settleAll('cancelled')
  assert.equal(await ask, 'cancelled')
}
{
  // 时序 5（消费后间隙孪生，残留窗口）：第一条已被 decide（ask 出队，
  // in-flight 集合释放）、真实工具仍在执行（result 未落地，call 仍算
  // live）——这个间隙塞入的同 callId 孪生既躲过队内去重又躲过 live 判
  // 定。一个 callId 的审批已被消费过，第二次出现必须直接标 external，
  // 不等 result 落地补翻。
  const store = new ApprovalStore()
  const log = events('call-gap') // 只有 tool/call，全程不写 result
  const first = store.park(approvalRequest('call-gap', log))
  store.decide('allowed-once') // 第一条出队；工具执行中，log 不动
  const twin = store.park(approvalRequest('call-gap', log)) // 间隙孪生
  assert.equal(store.getSnapshot()!.external, true,
    'P-4: a twin parked AFTER the first ask was decided but BEFORE its tool/result landed must carry the badge at park (consumed callId) — not rely on a later result to flip it')
  store.settleAll('cancelled')
  assert.equal(await first, 'allowed-once')
  assert.equal(await twin, 'cancelled')
}

// ── 面板渲染：external 行可见，非 external 不出现 ─────────────────────
setLang('zh')
const terminal = new Terminal({ cols: 90, rows: 30, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = 90
  rows = 30
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    terminal.write(String(chunk), callback)
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdin = new FakeStdin()
const stdout = new FakeStdout()
const screen = (): string => Array.from({ length: 30 }, (_, y) =>
  terminal.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n')

const baseApproval = {
  key: '1',
  toolName: 'Bash',
  reason: '需要删除临时文件',
  command: 'rm -rf /tmp/real-command',
}
const app = await render(React.createElement(ApprovalPanel, {
  approval: { ...baseApproval, external: true },
  onDecide() {},
}), { stdout, stdin, stderr: new FakeStdout(), exitOnCtrlC: false, patchConsole: false })
assert.ok(await settled(() => screen().includes('[external]')),
  'the panel must render the [external] marker line')
assert.ok(screen().includes('未关联当前会话的活跃工具调用'),
  'the localized explanation must accompany the marker')

app.rerender(React.createElement(ApprovalPanel, {
  approval: { ...baseApproval },
  onDecide() {},
}))
assert.ok(await settled(() => !screen().includes('[external]')),
  'a live approval must not show the marker')
await sleep(30)

console.log('verify-approval-source-badge: all assertions passed')
