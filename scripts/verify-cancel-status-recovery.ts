/**
 * Lost terminal-status notifications after cancel, using the real channel core.
 * Backend status is authoritative; time alone never ends a running turn.
 * Run: node --import tsx/esm scripts/verify-cancel-status-recovery.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { AgentSession } from '../src/agent/session.js'
import type { AgentEvent, AgentEventMeta } from '../src/agent/events.js'

const temporaryParent = resolve(tmpdir())
const home = mkdtempSync(join(temporaryParent, 'cancel-status-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = join(home, 'dsh')
process.env.DSH_TUI_LANG = 'en'

const [{ createCoreChannel }, { cordisChannelHost }, { createChannelOwner }] = await Promise.all([
  import('../src/dsh-adapter/channel/core/compose.js'),
  import('../src/dsh-adapter/channel/cordis-host.js'),
  import('../src/dsh-adapter/channel/owner.js'),
])
const delay = (milliseconds: number) => new Promise<void>(done => setTimeout(done, milliseconds))
const settled = async (predicate: () => boolean): Promise<boolean> => {
  const deadline = Date.now() + 2500
  // 固定窗:pacing 条件轮询让出事件循环，谓词成立即结束等待。
  while (!predicate() && Date.now() < deadline) await delay(20)
  return predicate()
}
const META: AgentEventMeta = { replay: false, wake: 'sync' }
type Listener = (batch: readonly AgentEvent[], meta: AgentEventMeta) => void

function fakeSession(id: string) {
  let status: AgentSession['status'] = 'idle'
  let statusReads = 0
  let onRead: (() => void) | undefined
  const listeners = new Set<Listener>()
  const retained: Listener[] = []
  const submissions: string[] = []
  const session: AgentSession = {
    ref: { backendId: 'cancel-test', sessionId: id },
    cwd: home,
    get status() { statusReads += 1; onRead?.(); return status },
    capabilities: { native: {} },
    history: async () => [],
    subscribe(listener) {
      listeners.add(listener)
      retained.push(listener)
      return () => { listeners.delete(listener) }
    },
    submit: async input => {
      if (status === 'disposed') return { accepted: false, reason: 'disposed', dropped: true }
      submissions.push(input.text)
      return { accepted: true }
    },
    cancel: async () => ({ outcome: 'confirmed', stillQueued: [] }),
    dispose: async () => {},
  }
  return {
    session, submissions, listeners,
    get reads() { return statusReads },
    silentStatus(next: AgentSession['status']) { status = next },
    onStatusRead(callback: (() => void) | undefined) { onRead = callback },
    emit(batch: readonly AgentEvent[]) {
      for (const event of batch) {
        if (event.type === 'turn.start') status = 'running'
        if (event.type === 'turn.end') status = 'idle'
        if (event.type === 'session.status') status = event.status
      }
      for (const listener of [...listeners]) listener(batch, META)
    },
    late(batch: readonly AgentEvent[]) { retained[0]?.(batch, META) },
  }
}
let identity = 0
function fixture() {
  const source = fakeSession('cancel-source-' + identity++)
  const warnings: string[] = []
  const context = { on: () => () => {}, get: () => undefined, logger: { warn(message: string) { warnings.push(message) }, info() {}, debug() {} } }
  const owner = createChannelOwner()
  const core = createCoreChannel(cordisChannelHost(context as never), source.session, {
    model: 'cancel-test', provider: '', cwd: home, activity: false, backendLabel: 'Cancel test',
  }, owner)
  const channel = core.start()
  return {
    source, channel, core, warnings,
    begin(turn = 1) { source.emit([{ type: 'turn.start', turn, origin: 'user', time: turn }]); assert.equal(channel.working, true) },
    adopt(next: ReturnType<typeof fakeSession>) {
      core.binding.switchTo(next.session, (_previous, disposition) => {
        disposition('park')
        core.feed.resetProjection()
        channel.rows = []
        channel.agentId = next.session.ref.sessionId
        channel.sessionId = next.session.ref.sessionId
        channel.working = false
        channel.cancelPending = false
        core.feed.bind([])
      })
    },
    close() { owner.dispose(); assert.equal(source.listeners.size, 0) },
  }
}
let failures = 0
async function test(name: string, run: () => Promise<void>) {
  try { await run(); console.log('PASS ' + name) }
  catch (error) { failures += 1; console.error('FAIL ' + name, error) }
}
try {
  for (const action of ['cancel', 'dock', 'deliver'] as const) {
    for (const status of ['idle', 'disposed'] as const) {
      await test(`${action} recovers from authoritative ${status} without a terminal notification`, async () => {
        const f = fixture()
        try {
          f.begin()
          if (action === 'cancel') f.channel.cancel()
          else if (action === 'dock') f.channel.interruptAndDock()
          else f.channel.interruptAndDeliver(['follow-up after interrupt'])
          assert.equal(f.channel.cancelPending, true)
          f.source.silentStatus(status)
          assert.equal(await settled(() => !f.channel.working && !f.channel.cancelPending), true)
          assert.equal(f.channel.status, status)
        } finally { f.close() }
      })
    }
  }
  for (const status of ['running', 'requires-action'] as const) {
    await test(`a genuinely ${status} backend remains busy without extra channel emissions`, async () => {
      const f = fixture()
      try {
        f.begin()
        f.source.silentStatus(status)
        f.channel.cancel()
        let emissions = 0
        const unsubscribe = f.channel.subscribe(() => { emissions += 1 })
        const reads = f.source.reads
        // 固定窗:探针 验证两个观察周期内仍在运行的后端不会因等待时间被结束或重绘。
        await delay(2200)
        assert.equal(f.channel.working, true)
        assert.equal(f.channel.cancelPending, true)
        assert.ok(f.source.reads > reads, 'the recovery observation actually ran')
        assert.equal(emissions, 0, 'status observation alone does not emit frames')
        unsubscribe()
      } finally { f.close() }
    })
  }
  await test('an already idle session cannot retain a cancellation gate without an open turn', async () => {
    const f = fixture()
    try {
      assert.equal(f.channel.working, false)
      f.channel.cancel()
      assert.equal(await settled(() => !f.channel.cancelPending && !f.core.inputConvergence.cancelInFlight), true)
    } finally { f.close() }
  })
  await test('a normal terminal event stops observation before another status read', async () => {
    const f = fixture()
    try {
      f.begin()
      f.channel.cancel()
      f.source.emit([{ type: 'turn.end', turn: 1, reason: { kind: 'aborted' }, time: 2 }])
      const reads = f.source.reads
      // 固定窗:探针 已送达终结事件后不再读取状态或重开取消门闩。
      await delay(1200)
      assert.equal(f.source.reads, reads)
      assert.equal(f.channel.working, false)
      assert.equal(f.channel.cancelPending, false)
    } finally { f.close() }
  })
  await test('there is no status polling before cancellation or after owner release', async () => {
    const f = fixture()
    try {
      f.begin()
      const before = f.source.reads
      // 固定窗:探针 无取消时不创建后台状态轮询。
      await delay(1200)
      assert.equal(f.source.reads, before)
      f.channel.cancel()
      f.close()
      const released = f.source.reads
      // 固定窗:探针 释放 Channel 后旧观察不再读取后端。
      await delay(1200)
      assert.equal(f.source.reads, released)
    } finally { f.close() }
  })
  await test('a disposed session holds accepted pending text and never resubmits it', async () => {
    const f = fixture()
    try {
      f.begin()
      f.channel.submit('keep this queued text')
      assert.equal(await settled(() => f.source.submissions.length === 1 && f.channel.pending.length === 1), true)
      f.channel.cancel()
      f.source.silentStatus('disposed')
      assert.equal(await settled(() => !f.channel.working && !f.channel.cancelPending), true)
      assert.equal(f.channel.pending.length, 1)
      assert.equal(f.channel.pending[0]?.text, 'keep this queued text')
      assert.equal(f.channel.pending[0]?.orphaned, true)
      assert.equal(f.channel.pending[0]?.docked, true)
      assert.equal(f.source.submissions.length, 1)
    } finally { f.close() }
  })
  await test('rebind and A-B-A generations fence old observations and retained events', async () => {
    const f = fixture()
    const next = fakeSession('cancel-next-' + identity++)
    try {
      f.begin()
      f.channel.cancel()
      f.adopt(next)
      next.emit([{ type: 'turn.start', turn: 1, origin: 'user', time: 2 }])
      f.channel.cancel()
      const oldReads = f.source.reads
      f.source.silentStatus('disposed')
      // 固定窗:探针 新会话仍在运行，旧会话的取消观察必须已退休。
      await delay(1200)
      assert.equal(f.source.reads, oldReads)
      assert.equal(f.channel.working, true)
      assert.equal(f.channel.cancelPending, true)
      f.source.silentStatus('idle')
      f.adopt(f.source)
      f.begin(2)
      f.channel.cancel()
      f.source.late([{ type: 'session.status', status: 'disposed' }])
      assert.equal(f.channel.working, true)
      assert.equal(f.channel.cancelPending, true)
      f.source.silentStatus('idle')
      assert.equal(await settled(() => !f.channel.working && !f.channel.cancelPending), true)
    } finally { f.close(); assert.equal(next.listeners.size, 0) }
  })
  await test('a status getter that rebinds cannot retire the replacement session', async () => {
    const f = fixture()
    const next = fakeSession('cancel-getter-next-' + identity++)
    try {
      f.begin()
      f.channel.cancel()
      f.source.silentStatus('idle')
      let rebound = false
      f.source.onStatusRead(() => {
        f.source.onStatusRead(undefined)
        rebound = true
        f.adopt(next)
        next.emit([{ type: 'turn.start', turn: 1, origin: 'user', time: 3 }])
        f.channel.cancel()
      })
      assert.equal(await settled(() => rebound), true)
      assert.equal(f.channel.working, true)
      assert.equal(f.channel.cancelPending, true)
      next.silentStatus('idle')
      assert.equal(await settled(() => !f.channel.working && !f.channel.cancelPending), true)
    } finally { f.source.onStatusRead(undefined); f.close(); assert.equal(next.listeners.size, 0) }
  })
  await test('a failed status read stops observation without crashing or ending a running turn', async () => {
    const f = fixture()
    try {
      f.begin()
      f.channel.cancel()
      f.warnings.length = 0
      f.source.onStatusRead(() => { throw new Error('controlled backend read failure') })
      assert.equal(await settled(() => f.warnings.length === 1), true)
      const reads = f.source.reads
      // 固定窗:探针 读取失败后不反复轮询或反复报警，仍等后端真实终结。
      await delay(1200)
      assert.equal(f.source.reads, reads)
      assert.equal(f.warnings.length, 1)
      assert.equal(f.channel.working, true)
      assert.equal(f.channel.cancelPending, true)
    } finally { f.source.onStatusRead(undefined); f.close() }
  })
} finally {
  assert.equal(dirname(resolve(home)), temporaryParent)
  rmSync(home, { recursive: true, force: true })
}
assert.equal(failures, 0, `${failures} cancellation recovery cases failed`)
