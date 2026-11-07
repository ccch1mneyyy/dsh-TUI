/**
 * verify-edit-signal — 编辑事务信号的聚焦回归（`src/dsh-adapter/edit-signal.ts`
 * 与 `ide-channel.ts` 的可选能力握手）。
 *
 * 覆盖：
 *   1. 结果载荷归一化：edit 多 hunk、write 新建（无 hunk）、apply_patch
 *      多文件 + stopped、相对路径按会话 cwd 解析；
 *   2. 丢弃面：错误结果、未登记工具、孤儿结果、重复 callId、畸形 meta、
 *      超长 hunk、超量文件、未知 capabilities；
 *   3. 生命周期：bind 重置（新会话不继承旧 callId 台账）、dispose 静默；
 *   4. 通道：hello_ack 声明的能力才发送；旧服务端（无 capabilities）连接
 *      成功但不发送；stop 清能力；未连接发送返回 false 不抛错。
 *
 * 运行：node --import tsx/esm scripts/verify-edit-signal.ts
 * （已登记进 scripts/run-ci-group.mjs 的 channel-ui 组）
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createEditSignalForwarder } from '../src/dsh-adapter/edit-signal.js'
import { IdeChannel } from '../src/dsh-adapter/ide-channel.js'
import type { EditTransactionNotification } from '../src/dsh-adapter/ide-channel.js'
import { startWsFixture } from './lib/ide-ws-fixture.js'

const sleep = async (ms: number): Promise<void> => { await delay(ms) }

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean): void => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

async function waitFor(ready: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (ready()) return true
    await sleep(20) // 固定窗:pacing 20ms 轮询采样间隔，等待外部 fixture 推帧无本地锚点可 settle
  }
  return ready()
}

/** One durable `tool/call` session event, shaped like the DSH log record. */
function toolCall(callId: string, name: string): unknown {
  return { type: 'tool/call', data: { turn: 1, step: 1, callId, name, arguments: '{}' } }
}

/** One durable `tool/result`; `meta` is the tool-private payload. */
function toolResult(callId: string, meta?: unknown, error?: unknown): unknown {
  return {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `result-${callId}`,
        role: 'tool',
        toolCallId: callId,
        isError: error !== undefined && error !== null,
        source: { kind: 'tool', callId },
        content: [],
      },
      ...(error === undefined ? {} : { error }),
      ...(meta === undefined ? {} : { meta }),
    },
  }
}

/** One durable `tool/result` whose message carries `isError` but no envelope
 *  `error` (the 0.1.7 shape; older logs wrap the flag in the first block). */
function toolResultMessageError(callId: string, meta?: unknown): unknown {
  return {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `result-${callId}`,
        role: 'tool',
        toolCallId: callId,
        isError: true,
        source: { kind: 'tool', callId },
        content: [],
      },
      ...(meta === undefined ? {} : { meta }),
    },
  }
}

function forwarderChecks(cwd: string): void {
  const a = join(cwd, 'a.ts')
  const b = join(cwd, 'b.ts')
  const sent: EditTransactionNotification[] = []
  const forwarder = createEditSignalForwarder(notification => {
    sent.push(notification)
    return true
  })
  const before = (): number => sent.length
  forwarder.bind({ sessionId: 'session-1', cwd })

  // ── 1. edit：一次成功结果 → 一条通知，多 hunk 合并在同一文件下 ────────────
  forwarder.onSessionEvent(toolCall('call-1', 'edit'))
  forwarder.onSessionEvent(toolResult('call-1', {
    path: a,
    diffs: [
      { path: a, oldText: 'old-1', newText: 'new-1' },
      { path: a, oldText: 'old-2', newText: 'new-2' },
    ],
  }))
  const first = sent[0]
  check('edit：成功结果 → 恰好一条通知', before() === 1)
  check('edit：会话/调用/工具归属正确',
    first?.sessionId === 'session-1' && first.callId === 'call-1' && first.tool === 'edit')
  check('edit：同文件两条 hunk 合并为一个文件条目',
    first?.files.length === 1 && first.files[0].diffs.length === 2)
  check('edit：hunk 原文逐字透传',
    first?.files[0].diffs[0].oldText === 'old-1' && first.files[0].diffs[0].newText === 'new-1'
    && first.files[0].diffs[1].oldText === 'old-2' && first.files[0].diffs[1].newText === 'new-2')

  // ── 2. 相对路径按会话 cwd 解析为绝对路径 ────────────────────────────────
  forwarder.onSessionEvent(toolCall('call-relative', 'edit'))
  forwarder.onSessionEvent(toolResult('call-relative', {
    path: 'src/rel.ts',
    diffs: [{ path: 'src/rel.ts', oldText: 'r', newText: 's' }],
  }))
  check('路径：相对路径按会话 cwd 解析为绝对路径',
    sent[before() - 1]?.files[0].path === resolve(cwd, 'src/rel.ts'))

  // ── 3. write 新建：无 hunk 仍是可审阅事务 ───────────────────────────────
  const created = join(cwd, 'created.ts')
  forwarder.onSessionEvent(toolCall('call-create', 'write'))
  forwarder.onSessionEvent(toolResult('call-create', { operation: 'create', path: created, diffs: [] }))
  const createNotification = sent[before() - 1]
  check('write 新建：仍产生通知（operation=create，无 hunk）',
    createNotification?.files.length === 1
    && createNotification.files[0].path === created
    && createNotification.files[0].operation === 'create'
    && createNotification.files[0].diffs.length === 0)

  // ── 3b. write 覆盖已有文件：operation=update 透传 ───────────────────────
  forwarder.onSessionEvent(toolCall('call-update', 'write'))
  forwarder.onSessionEvent(toolResult('call-update', {
    operation: 'update',
    path: a,
    diffs: [{ path: a, oldText: 'u1', newText: 'u2' }],
  }))
  check('write 覆盖：operation=update 透传到文件条目',
    sent[before() - 1]?.files[0].operation === 'update')

  // ── 3c. write 新建的另一种日志形状：带空 oldText 的 hunk（含大文件）──────
  const bigCreated = join(cwd, 'big-created.ts')
  forwarder.onSessionEvent(toolCall('call-create-hunk', 'write'))
  forwarder.onSessionEvent(toolResult('call-create-hunk', {
    operation: 'create',
    path: bigCreated,
    diffs: [{ path: bigCreated, oldText: '', newText: 'x'.repeat(100 * 1024) }],
  }))
  const hunkCreate = sent[before() - 1]
  check('write 新建（带 hunk 形状）：仍为 create 且 hunk 不占包体',
    hunkCreate?.files.length === 1
    && hunkCreate.files[0].operation === 'create'
    && hunkCreate.files[0].diffs.length === 0)

  // ── 3d. error:null 是成功形状，不应被吞 ─────────────────────────────────
  forwarder.onSessionEvent(toolCall('call-null-error', 'edit'))
  forwarder.onSessionEvent(toolResult(
    'call-null-error',
    { path: a, diffs: [{ path: a, oldText: 'ne1', newText: 'ne2' }] },
    null,
  ))
  check('error:null 的成功结果仍发送',
    sent[before() - 1]?.files[0].diffs[0].newText === 'ne2')

  // ── 3e. apply_patch 部分失败：error + stopped + 已完成 hunk 仍要进账 ─────
  forwarder.onSessionEvent(toolCall('call-partial', 'apply_patch'))
  forwarder.onSessionEvent(toolResult(
    'call-partial',
    {
      diffs: [{ path: a, oldText: 'p-old', newText: 'p-new' }],
      stopped: true,
    },
    { name: 'PatchError', code: 'PATCH_FAILED' },
  ))
  check('apply_patch 部分失败：带 stopped 的已完成 hunk 发送',
    sent[before() - 1]?.stopped === true
    && sent[before() - 1]?.files.length === 1)

  // ── 4. apply_patch：多文件 + stopped 透传 ───────────────────────────────
  forwarder.onSessionEvent(toolCall('call-patch', 'apply_patch'))
  forwarder.onSessionEvent(toolResult('call-patch', {
    diffs: [
      { path: a, oldText: 'p1', newText: 'q1' },
      { path: b, oldText: 'p2', newText: 'q2' },
    ],
    stopped: true,
  }))
  const patchNotification = sent[before() - 1]
  check('apply_patch：多文件拆成两个文件条目', patchNotification?.files.length === 2)
  check('apply_patch：stopped 透传', patchNotification?.stopped === true)

  // apply_patch 纯新建：日志 meta 没有旧文本可对照（diffs 为空）→ 不产生通知。
  const beforePatchCreate = before()
  forwarder.onSessionEvent(toolCall('call-patch-create', 'apply_patch'))
  forwarder.onSessionEvent(toolResult('call-patch-create', { diffs: [], stopped: false }))
  check('apply_patch 纯新建：无 hunk 不产生通知', before() === beforePatchCreate)

  // ── 5. 丢弃面 ────────────────────────────────────────────────────────────
  const baseline = before()
  forwarder.onSessionEvent(toolCall('call-error', 'edit'))
  forwarder.onSessionEvent(toolResult('call-error', { path: a, diffs: [{ path: a, oldText: 'x', newText: 'y' }] }, { name: 'ToolError', code: 'FAIL' }))
  check('丢弃：失败结果不发送', before() === baseline)

  forwarder.onSessionEvent(toolCall('call-message-error', 'edit'))
  forwarder.onSessionEvent(toolResultMessageError('call-message-error', {
    path: a,
    diffs: [{ path: a, oldText: 'mx', newText: 'my' }],
  }))
  check('丢弃：仅 message.isError 的失败结果不发送（仓库统一口径）', before() === baseline)

  forwarder.onSessionEvent(toolCall('call-bash', 'bash'))
  forwarder.onSessionEvent(toolResult('call-bash', { path: a, diffs: [{ path: a, oldText: 'x', newText: 'y' }] }))
  check('丢弃：未登记的工具不发送', before() === baseline)

  forwarder.onSessionEvent(toolResult('call-orphan', { path: a, diffs: [{ path: a, oldText: 'x', newText: 'y' }] }))
  check('丢弃：没有配对 tool/call 的结果不发送', before() === baseline)

  forwarder.onSessionEvent(toolCall('call-malformed', 'edit'))
  forwarder.onSessionEvent(toolResult('call-malformed', { path: a, diffs: 'not-an-array' }))
  forwarder.onSessionEvent(toolCall('call-malformed-2', 'edit'))
  forwarder.onSessionEvent(toolResult('call-malformed-2', { path: a, diffs: [{ path: a, oldText: 42, newText: 'y' }] }))
  check('丢弃：畸形 diffs 不发送', before() === baseline)

  forwarder.onSessionEvent(toolCall('call-no-meta', 'edit'))
  forwarder.onSessionEvent(toolResult('call-no-meta'))
  check('丢弃：无 meta 不发送', before() === baseline)

  forwarder.onSessionEvent(toolCall('call-huge', 'edit'))
  forwarder.onSessionEvent(toolResult('call-huge', {
    path: a,
    diffs: [{ path: a, oldText: 'x'.repeat(64 * 1024 + 1), newText: '' }],
  }))
  check('丢弃：单 hunk 超限整条丢弃', before() === baseline)

  forwarder.onSessionEvent(toolCall('call-payload', 'edit'))
  forwarder.onSessionEvent(toolResult('call-payload', {
    path: a,
    diffs: Array.from({ length: 5 }, (_, index) => ({
      path: join(cwd, `payload-${index}.ts`),
      oldText: 'o'.repeat(60 * 1024),
      newText: 'n'.repeat(60 * 1024),
    })),
  }))
  check('丢弃：整包文本累计超限整条丢弃', before() === baseline)

  forwarder.onSessionEvent(toolCall('call-many-files', 'apply_patch'))
  forwarder.onSessionEvent(toolResult('call-many-files', {
    diffs: Array.from({ length: 65 }, (_, index) => ({
      path: join(cwd, `many-${index}.ts`),
      oldText: 'o',
      newText: 'n',
    })),
  }))
  check('丢弃：文件数超限整条丢弃', before() === baseline)

  // ── 6. 重复结果只记一次；重新登记 callId 也不再发 ───────────────────────
  const beforeDuplicate = before()
  forwarder.onSessionEvent(toolCall('call-dup', 'edit'))
  forwarder.onSessionEvent(toolResult('call-dup', { path: a, diffs: [{ path: a, oldText: 'd1', newText: 'd2' }] }))
  forwarder.onSessionEvent(toolCall('call-dup', 'edit'))
  forwarder.onSessionEvent(toolResult('call-dup', { path: a, diffs: [{ path: a, oldText: 'd1', newText: 'd2' }] }))
  check('去重：同一 callId 的重复结果只发送一次', before() - beforeDuplicate === 1)

  // ── 6b. surface replace/repair 不是新编辑（只认 append）─────────────────
  const beforeSurface = before()
  forwarder.onSessionEvent(toolCall('call-surface', 'edit'))
  forwarder.onSessionEvent({
    ...(toolResult('call-surface', { path: a, diffs: [{ path: a, oldText: 's1', newText: 's2' }] }) as Record<string, unknown>),
    surfaceOp: 'replace',
  })
  check('surface：replace 重写不产生新通知', before() === beforeSurface)

  const beforeSurfaceObject = before()
  forwarder.onSessionEvent(toolCall('call-surface-object', 'edit'))
  forwarder.onSessionEvent({
    ...(toolResult('call-surface-object', { path: a, diffs: [{ path: a, oldText: 'o1', newText: 'o2' }] }) as Record<string, unknown>),
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
  })
  check('surface：对象形态 replace 不产生新通知', before() === beforeSurfaceObject)

  const beforeAppend = before()
  forwarder.onSessionEvent(toolCall('call-append', 'edit'))
  forwarder.onSessionEvent({
    ...(toolResult('call-append', { path: a, diffs: [{ path: a, oldText: 'ap1', newText: 'ap2' }] }) as Record<string, unknown>),
    surfaceOp: 'append',
  })
  check('surface：append 正常发送', before() - beforeAppend === 1)

  // ── 6c. 无 cwd 时只接受绝对路径 ──────────────────────────────────────────
  const noCwdSent: EditTransactionNotification[] = []
  const noCwdForwarder = createEditSignalForwarder(notification => {
    noCwdSent.push(notification)
    return true
  })
  noCwdForwarder.bind({ sessionId: 'session-no-cwd', cwd: '' })
  noCwdForwarder.onSessionEvent(toolCall('call-nocwd-relative', 'edit'))
  noCwdForwarder.onSessionEvent(toolResult('call-nocwd-relative', {
    path: 'relative.ts',
    diffs: [{ path: 'relative.ts', oldText: 'r1', newText: 'r2' }],
  }))
  check('路径：无 cwd 的相对路径不发送', noCwdSent.length === 0)
  noCwdForwarder.onSessionEvent(toolCall('call-nocwd-absolute', 'edit'))
  noCwdForwarder.onSessionEvent(toolResult('call-nocwd-absolute', {
    path: a,
    diffs: [{ path: a, oldText: 'r3', newText: 'r4' }],
  }))
  check('路径：无 cwd 的绝对路径仍可发送', noCwdSent.length === 1)

  // ── 7. bind 重置：新会话不继承旧台账，同 callId 可再次发送 ──────────────
  forwarder.bind({ sessionId: 'session-2', cwd })
  forwarder.onSessionEvent(toolCall('call-1', 'edit'))
  forwarder.onSessionEvent(toolResult('call-1', { path: a, diffs: [{ path: a, oldText: 'n1', newText: 'n2' }] }))
  check('bind：新会话重置台账且重新归属 sessionId', sent[before() - 1]?.sessionId === 'session-2')

  // ── 8. dispose 后静默 ───────────────────────────────────────────────────
  const beforeDispose = before()
  forwarder.dispose()
  forwarder.onSessionEvent(toolCall('call-after-dispose', 'edit'))
  forwarder.onSessionEvent(toolResult('call-after-dispose', { path: a, diffs: [{ path: a, oldText: 'z', newText: 'w' }] }))
  check('dispose：后续事件被忽略', before() === beforeDispose)

  // ── 9. 同会话 reattach 保留在途调用；跨会话不串扰 ───────────────────────
  const reattachSent: EditTransactionNotification[] = []
  const reattach = createEditSignalForwarder(notification => {
    reattachSent.push(notification)
    return true
  })
  reattach.bind({ sessionId: 'session-reattach', cwd })
  reattach.onSessionEvent(toolCall('reattach-call', 'edit'))
  reattach.bind({ sessionId: 'session-reattach', cwd })
  reattach.onSessionEvent(toolResult('reattach-call', { path: a, diffs: [{ path: a, oldText: 'r1', newText: 'r2' }] }))
  check('reattach：同会话 rebind 不丢在途事务', reattachSent.length === 1)
  reattach.bind({ sessionId: 'session-other', cwd })
  reattach.onSessionEvent(toolCall('reattach-call-2', 'edit'))
  reattach.bind({ sessionId: 'session-other-2', cwd })
  reattach.onSessionEvent(toolResult('reattach-call-2', { path: a, diffs: [{ path: a, oldText: 'r3', newText: 'r4' }] }))
  check('reattach：跨会话 rebind 丢弃在途事务', reattachSent.length === 1)

  const cwdChangedSent: EditTransactionNotification[] = []
  const cwdChanged = createEditSignalForwarder(notification => {
    cwdChangedSent.push(notification)
    return true
  })
  cwdChanged.bind({ sessionId: 'session-cwd', cwd })
  cwdChanged.onSessionEvent(toolCall('cwd-call', 'edit'))
  cwdChanged.bind({ sessionId: 'session-cwd', cwd: join(cwd, 'sub') })
  cwdChanged.onSessionEvent(toolResult('cwd-call', { path: a, diffs: [{ path: a, oldText: 'c1', newText: 'c2' }] }))
  check('reattach：同会话 cwd 变化丢弃在途调用（防错路径）', cwdChangedSent.length === 0)

  // ── 10. 发送失败不永久封死 callId（后续重复结果可重试）──────────────────
  let accept = false
  const retrySent: EditTransactionNotification[] = []
  const retry = createEditSignalForwarder(notification => {
    retrySent.push(notification)
    return accept
  })
  retry.bind({ sessionId: 'session-retry', cwd })
  retry.onSessionEvent(toolCall('retry-call', 'edit'))
  retry.onSessionEvent(toolResult('retry-call', { path: a, diffs: [{ path: a, oldText: 't1', newText: 't2' }] }))
  accept = true
  retry.onSessionEvent(toolCall('retry-call', 'edit'))
  retry.onSessionEvent(toolResult('retry-call', { path: a, diffs: [{ path: a, oldText: 't1', newText: 't2' }] }))
  check('发送失败不永久封死 callId（重复结果可重试）', retrySent.length === 2)

  // ── 11. 跟踪表上限：最早的在途调用被淘汰，最新调用仍可发送 ───────────────
  const evictSent: EditTransactionNotification[] = []
  const evict = createEditSignalForwarder(notification => {
    evictSent.push(notification)
    return true
  })
  evict.bind({ sessionId: 'session-evict', cwd })
  for (let index = 0; index < 129; index++) evict.onSessionEvent(toolCall(`evict-${index}`, 'edit'))
  evict.onSessionEvent(toolResult('evict-0', { path: a, diffs: [{ path: a, oldText: 'e0', newText: 'e1' }] }))
  check('上限：超出跟踪上限的最早调用被淘汰', evictSent.length === 0)
  evict.onSessionEvent(toolResult('evict-128', { path: a, diffs: [{ path: a, oldText: 'e2', newText: 'e3' }] }))
  check('上限：淘汰后最新的调用仍可发送', evictSent.length === 1)
}

async function channelChecks(tmpRoot: string): Promise<void> {
  const token = 'tok-edit-signal'
  const folders = ['/repo']
  const capabilityAck = await startWsFixture(token, folders, {
    clearSelectionAfterMs: null,
    capabilities: { editTransaction: true },
  })
  const channel = new IdeChannel()
  await channel.start(
    { DSH_TUI_IDE_PORT: String(capabilityAck.port), DSH_TUI_IDE_TOKEN: token },
    join(tmpRoot, 'locks-capable'),
    '/repo',
  )
  check('通道：声明能力的服务端 → 已连接且支持编辑事务',
    channel.connected && channel.supportsEditTransaction)

  const forwarder = createEditSignalForwarder(notification => channel.sendEditTransaction(notification))
  forwarder.bind({ sessionId: 'session-wire', cwd: '/repo' })
  forwarder.onSessionEvent(toolCall('wire-1', 'edit'))
  forwarder.onSessionEvent(toolResult('wire-1', {
    path: '/repo/a.ts',
    diffs: [{ path: '/repo/a.ts', oldText: 'before', newText: 'after' }],
  }))
  const arrived = await waitFor(() => capabilityAck.received.length > 0, 3000)
  check('通道：通知送达 loopback 服务端', arrived)
  const frame = capabilityAck.received[0]
  check('通道：帧方法为 edit_transaction', frame?.method === 'edit_transaction')
  const params = frame?.params as EditTransactionNotification | undefined
  check('通道：帧载荷与发送通知一致',
    params?.callId === 'wire-1' && params.sessionId === 'session-wire')
  check('通道：帧内 hunk 原文一致',
    params?.files[0]?.diffs[0]?.oldText === 'before' && params.files[0].diffs[0].newText === 'after')

  channel.stop()
  check('通道：stop 后能力清零', channel.supportsEditTransaction === false)
  capabilityAck.close()

  // 作用域：只发送落在已连接工作区内的文件（扩展无法映射工作区外路径）。
  const scopedAck = await startWsFixture(token, folders, {
    clearSelectionAfterMs: null,
    capabilities: { editTransaction: true },
  })
  const scopedChannel = new IdeChannel()
  await scopedChannel.start(
    { DSH_TUI_IDE_PORT: String(scopedAck.port), DSH_TUI_IDE_TOKEN: token },
    join(tmpRoot, 'locks-scoped'),
    '/repo',
  )
  const mixedSent = scopedChannel.sendEditTransaction({
    sessionId: 'session-scoped',
    callId: 'scoped-mixed',
    tool: 'edit',
    files: [
      { path: '/repo/a.ts', diffs: [{ oldText: 'a', newText: 'b' }] },
      { path: '/outside/b.ts', diffs: [{ oldText: 'c', newText: 'd' }] },
    ],
  })
  await waitFor(() => scopedAck.received.length > 0, 3000)
  const scopedParams = scopedAck.received[0]?.params as EditTransactionNotification | undefined
  check('作用域：混合通知只保留工作区内文件',
    mixedSent && scopedParams?.files.length === 1 && scopedParams.files[0].path === '/repo/a.ts')
  const outsideSent = scopedChannel.sendEditTransaction({
    sessionId: 'session-scoped',
    callId: 'scoped-outside',
    tool: 'edit',
    files: [{ path: '/outside/c.ts', diffs: [{ oldText: 'e', newText: 'f' }] }],
  })
  check('作用域：全部在工作区外 → 不发送',
    outsideSent === false && scopedAck.received.length === 1)
  scopedChannel.stop()
  scopedAck.close()

  // 空工作区根：窗口没有声明任何可映射的 workspace → 一条也不发。
  const noRootsAck = await startWsFixture(token, [], {
    clearSelectionAfterMs: null,
    capabilities: { editTransaction: true },
  })
  const noRootsChannel = new IdeChannel()
  await noRootsChannel.start(
    { DSH_TUI_IDE_PORT: String(noRootsAck.port), DSH_TUI_IDE_TOKEN: token },
    join(tmpRoot, 'locks-no-roots'),
    '/repo',
  )
  const noRootsSent = noRootsChannel.sendEditTransaction({
    sessionId: 'session-no-roots',
    callId: 'no-roots',
    tool: 'edit',
    files: [{ path: '/repo/a.ts', diffs: [{ oldText: 'a', newText: 'b' }] }],
  })
  await sleep(100) // 固定窗:pacing 确认「无帧到达」的观测窗，无本地锚点可 settle
  check('作用域：无工作区根 → 不发送',
    noRootsSent === false && noRootsAck.received.length === 0)
  noRootsChannel.stop()
  noRootsAck.close()

  // 旧服务端：无 capabilities 字段，连接照旧但整条信号关闭。
  const plainAck = await startWsFixture(token, folders, { clearSelectionAfterMs: null })
  const plainChannel = new IdeChannel()
  await plainChannel.start(
    { DSH_TUI_IDE_PORT: String(plainAck.port), DSH_TUI_IDE_TOKEN: token },
    join(tmpRoot, 'locks-plain'),
    '/repo',
  )
  check('通道：旧服务端 → 仍连接成功（选区通道不受影响）',
    plainChannel.connected && plainChannel.supportsEditTransaction === false)
  const plainForwarder = createEditSignalForwarder(notification => plainChannel.sendEditTransaction(notification))
  plainForwarder.bind({ sessionId: 'session-plain', cwd: '/repo' })
  plainForwarder.onSessionEvent(toolCall('plain-1', 'edit'))
  plainForwarder.onSessionEvent(toolResult('plain-1', {
    path: '/repo/a.ts',
    diffs: [{ path: '/repo/a.ts', oldText: 'x', newText: 'y' }],
  }))
  await sleep(150) // 固定窗:pacing 确认「无帧到达」的观测窗，无本地锚点可 settle
  check('通道：旧服务端 → 不发送任何通知', plainAck.received.length === 0)
  check('通道：旧服务端 → 直接发送返回 false',
    plainChannel.sendEditTransaction({
      sessionId: 's',
      callId: 'c',
      tool: 'edit',
      files: [],
    }) === false)
  plainChannel.stop()
  plainAck.close()

  const offline = new IdeChannel()
  let offlineThrew: unknown
  let offlineResult: unknown
  try {
    offlineResult = offline.sendEditTransaction({
      sessionId: 's',
      callId: 'c',
      tool: 'edit',
      files: [],
    })
  } catch (error) {
    offlineThrew = error
  }
  check('通道：未连接时发送不抛错且返回 false', offlineThrew === undefined && offlineResult === false)
}

async function main(): Promise<void> {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'verify-edit-signal-'))
  const cwd = join(tmpRoot, 'workspace')
  mkdirSync(cwd, { recursive: true })
  try {
    forwarderChecks(cwd)
    await channelChecks(tmpRoot)
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
  console.log(results.join('\n'))
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall edit-signal checks passed')
}

await main()
