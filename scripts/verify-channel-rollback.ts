/**
 * Channel construction is one owner transaction: a throw anywhere while the
 * core is built, while the DSH extensions attach, or while the composed
 * channel starts must release everything acquired so far:
 *
 *  - every host listener (`ctx.on`) and every listener on the DSH agent's
 *    own context;
 *  - the decision dispatch-topology marker;
 *  - the IDE selection link (a real loopback socket to an in-process IDE
 *    fixture: its server side must see the socket close);
 *  - timers (no `Timeout` resource outlives the failed construction);
 *  - a session that owns its own lifetime (a non-DSH fake session) is
 *    disposed; a DSH session's handle is not (its owner is the host).
 *
 * Run: node --import tsx/esm scripts/verify-channel-rollback.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AgentEventMeta } from '../src/agent/events.js'
import type { AgentSession } from '../src/agent/session.js'
import { createChannel } from '../src/dsh-adapter/channel.js'
import { decisionDispatchEventNames } from '../src/dsh-adapter/decision-guard.js'
import { setLang } from '../src/i18n.js'
import { startWsFixture } from './lib/ide-ws-fixture.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const timeouts = (): number => process.getActiveResourcesInfo().filter(kind => kind === 'Timeout').length

type Listener = (...args: unknown[]) => unknown
/** A host context whose `on` can be made to throw for one event name. */
function fakeHost(throwOn?: string) {
  const listeners = new Map<string, Set<Listener>>()
  const ctx = {
    on(name: string, listener: Listener) {
      if (name === throwOn) throw new Error(`injected failure registering ${name}`)
      const set = listeners.get(name) ?? new Set<Listener>()
      set.add(listener)
      listeners.set(name, set)
      return () => { set.delete(listener) }
    },
    get: () => undefined,
    logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
  }
  // The default-deny decision gate (`internal/*` listeners) is installed
  // once per composition root and deliberately outlives any one channel
  // (decision-guard.ts: idempotent per root); everything else is the
  // channel's and must be gone.
  const owned = (): [string, Set<Listener>][] => [...listeners.entries()].filter(([name, set]) => !name.startsWith('internal/') && set.size > 0)
  const count = (): number => owned().reduce((sum, [, set]) => sum + set.size, 0)
  const guards = (): number => [...listeners.entries()].filter(([name]) => name.startsWith('internal/')).reduce((sum, [, set]) => sum + set.size, 0)
  return { ctx, count, guards, names: () => owned().map(([name]) => name) }
}

/** A raw DSH agent whose own context counts its listeners. */
function fakeAgent(id: string) {
  let agentListeners = 0
  const agent = {
    id, status: 'idle', session: { id, seq: 0, events: [] as unknown[] },
    ctx: { on: () => { agentListeners += 1; return () => { agentListeners -= 1 } } },
    followup: () => undefined, steer: () => undefined, inbox: { remove: () => true },
  }
  return { agent, listeners: () => agentListeners }
}

/** A non-DSH session that owns its lifetime. */
function fakeSession(sessionId: string, subscribeThrows = false) {
  let disposed = 0
  let subscribed = 0
  const session: AgentSession = {
    ref: { backendId: 'fake', sessionId },
    cwd: '/fixture',
    status: 'idle',
    capabilities: { native: {} },
    history: () => Promise.resolve([]),
    subscribe(_listener: (batch: readonly AgentEvent[], meta: AgentEventMeta) => void) {
      if (subscribeThrows) throw new Error('injected failure subscribing')
      subscribed += 1
      return () => { subscribed -= 1 }
    },
    submit: () => Promise.resolve({ accepted: true }),
    removePending: () => false,
    cancel: () => Promise.resolve({ stillQueued: [] }),
    dispose() { disposed += 1; return Promise.resolve() },
  }
  return { session, disposed: () => disposed, subscribed: () => subscribed }
}

const workdir = mkdtempSync(join(tmpdir(), 'dsh-tui-channel-rollback-'))
const options = { model: 'm', provider: 'p', cwd: workdir, activity: false }

/** Run one failing construction with a live IDE link; report what remained. */
async function failingConstruction(label: string, build: () => unknown): Promise<{ ideClosed: boolean }> {
  const fixture = await startWsFixture('tok-rollback', [workdir], { clearSelectionAfterMs: null })
  process.env.DSH_TUI_IDE_PORT = String(fixture.port)
  process.env.DSH_TUI_IDE_TOKEN = 'tok-rollback'
  try {
    let threw: unknown
    try { build() } catch (error) { threw = error }
    check(`${label}: the construction failure reaches the caller`, threw instanceof Error && /injected failure/u.test(threw.message), String(threw))
    // The IDE dial started before the failure; the rollback must cancel it
    // (a late hello must not revive the link).
    const hello = await Promise.race([fixture.helloPromise.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 300))])
    return { ideClosed: !hello }
  } finally {
    delete process.env.DSH_TUI_IDE_PORT
    delete process.env.DSH_TUI_IDE_TOKEN
    fixture.close()
  }
}

try {
  const baseline = timeouts()

  // ── 1. inside core construction (the input pipeline's listener) ──────
  {
    const host = fakeHost('agent/pre-step')
    const { agent, listeners } = fakeAgent('dsh-core-fail')
    const result = await failingConstruction('core construction (DSH)', () => createChannel(host.ctx as never, agent as never, options))
    await tick()
    check('core construction (DSH): every host listener is released', host.count() === 0, host.names())
    check('core construction (DSH): no listener on the agent context', listeners() === 0)
    check('core construction (DSH): the dispatch-topology marker is released', decisionDispatchEventNames(host.ctx as never).length === 0, decisionDispatchEventNames(host.ctx as never))
    check('core construction (DSH): the IDE link never completes its handshake', result.ideClosed)
    const guards = host.guards()
    await failingConstruction('core construction (DSH, again)', () => createChannel(host.ctx as never, fakeAgent('dsh-core-fail-2').agent as never, options))
    check('core construction (DSH): the root decision gate is installed once, not per attempt', host.guards() === guards && host.count() === 0, { before: guards, after: host.guards() })
  }
  {
    const host = fakeHost('agent/pre-step')
    const fake = fakeSession('11111111-1111-4111-8111-111111111111')
    await failingConstruction('core construction (non-DSH)', () => createChannel(host.ctx as never, fake.session, options))
    await tick()
    check('core construction (non-DSH): every host listener is released', host.count() === 0, host.names())
    check('core construction (non-DSH): the session that owns its lifetime is disposed', fake.disposed() === 1)
  }

  // ── 2. inside the DSH extension attach (its child-route listener) ────
  {
    const host = fakeHost('agent/request')
    const { agent, listeners } = fakeAgent('dsh-attach-fail')
    const result = await failingConstruction('DSH extension attach', () => createChannel(host.ctx as never, agent as never, options))
    await tick()
    check('DSH extension attach: every host listener is released', host.count() === 0, host.names())
    check('DSH extension attach: no listener on the agent context', listeners() === 0)
    check('DSH extension attach: the dispatch-topology marker is released', decisionDispatchEventNames(host.ctx as never).length === 0)
    check('DSH extension attach: the IDE link never completes its handshake', result.ideClosed)
  }

  // ── 3. while the composed channel starts (the first bind) ────────────
  {
    const host = fakeHost('llm/stream')
    const { agent, listeners } = fakeAgent('dsh-start-fail')
    await failingConstruction('start (DSH bind)', () => createChannel(host.ctx as never, agent as never, options))
    await tick()
    check('start (DSH bind): every host listener is released, owner-level and per-binding', host.count() === 0, host.names())
    check('start (DSH bind): the model-selection waterfalls on the agent context are released', listeners() === 0)
  }
  {
    const host = fakeHost()
    const fake = fakeSession('22222222-2222-4222-8222-222222222222', true)
    await failingConstruction('start (non-DSH bind)', () => createChannel(host.ctx as never, fake.session, options))
    await tick()
    check('start (non-DSH bind): every host listener is released', host.count() === 0, host.names())
    check('start (non-DSH bind): the session is disposed, nothing stays subscribed', fake.disposed() === 1 && fake.subscribed() === 0)
  }

  for (let i = 0; i < 5; i += 1) await tick()
  check('no timer outlives the failed constructions', timeouts() <= baseline, { baseline, now: timeouts() })
} finally {
  rmSync(workdir, { recursive: true, force: true })
}

console.log(`\nverify-channel-rollback OK (${passed} checks)`)
process.exit(0)
