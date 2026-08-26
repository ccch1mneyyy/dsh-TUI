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
  if (opts.resolved) {
    seed.push({
      type: 'tool/result',
      seq: 2,
      time: Date.now() - 1000,
      data: { turn: 1, step: 1, message: { source: { callId } } },
    })
  }
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
