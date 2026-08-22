/**
 * Channel session-mutation serialization: the session-replacing entries
 * (newSession/resumeTo/rewindTo/switchModel/switchWorkspace) run one at a
 * time in arrival order through the channel's mutation queue, a parked
 * replacement never gates the turn paths (submit/steer), and the
 * non-replacing writes (setEffort/switchPreset) drop their live-state
 * mutation when sessionEpoch moved under their in-flight await.
 *
 * Bare Node test runner (`node --import tsx/esm --test`), REAL channel via
 * createChannel against a minimal fake ctx/agent — same harness style as
 * scripts/verify-submit.mjs / scripts/verify-effort-mode.mjs: the services
 * the replacement paths touch (agents, agentPresets, llm) are stubbed down
 * to gated observables.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ChannelState } from '../../src/dsh-adapter/channel.js'

// sessionHistory/*Prefs resolve the data dir at module load — redirect HOME
// (USERPROFILE on Windows) into a throwaway dir BEFORE the channel import so
// no preference/last-used file in the real profile is touched.
const sandboxHome = mkdtempSync(join(tmpdir(), 'dsh-tui-mutation-home-'))
process.env.HOME = sandboxHome
process.env.USERPROFILE = sandboxHome
process.env.DSH_TUI_SESSION_ROOT = mkdtempSync(join(tmpdir(), 'dsh-tui-mutation-sessions-'))

const { createChannel } = await import('../../src/dsh-adapter/channel.js')

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** One macrotask: flushes every pending microtask hop of the async bodies. */
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
/** The send chain (expandMentions + decision + deliver) is microtask-level. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20))

/** Deadlock tripwire: node:test has no per-test timeout, so a queued
 *  replacement that never settles must FAIL instead of hanging the runner. */
function withTimeout<T>(pending: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    pending,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not settle — session-mutation queue deadlock?`)), 5000)
    }),
  ]).finally(() => clearTimeout(timer))
}

type Handler = (...args: never[]) => void

function makeCtx(services: Record<string, unknown>): {
  ctx: {
    on(event: string, handler: Handler): () => void
    get(name: string): unknown
    logger: { warn(): void }
  }
} {
  // Multi-listener per event, like the cordis bus the channel binds against.
  const handlers = new Map<string, Handler[]>()
  return {
    ctx: {
      on(event, handler) {
        const list = handlers.get(event) ?? []
        list.push(handler)
        handlers.set(event, list)
        return () => {
          const index = list.indexOf(handler)
          if (index >= 0) list.splice(index, 1)
        }
      },
      get(name) {
        return services[name]
      },
      logger: { warn() {} },
    },
  }
}

interface FakeAgent {
  id: string
  status: string
  options: Record<string, unknown>
  session: {
    id: string
    seq: number
    events: unknown[]
    header: Record<string, unknown>
    append(type: string, data: unknown): void
  }
  ctx: { on(): () => void }
  followup(message: unknown): void
  steer(message: unknown): void
  inbox: { remove(): boolean }
  cancel(): void
  whenIdle(): Promise<void>
}

function makeAgent(id: string, sessionId: string, events: unknown[] = []): FakeAgent {
  const session: FakeAgent['session'] = {
    id: sessionId,
    seq: 0,
    events,
    header: {},
    append(type, data) {
      session.events.push({ type, seq: session.events.length, time: Date.now(), data })
    },
  }
  return {
    id,
    status: 'idle',
    options: {},
    session,
    // bindAgent hangs dsh-agent's installModelSelection on agent.ctx: the
    // minimal surface is "subscribable, returns an unsubscribe".
    ctx: { on: () => () => {} },
    followup() {},
    steer() {},
    inbox: { remove: () => true },
    cancel() {},
    whenIdle: () => Promise.resolve(),
  }
}

function makeHandle(agent: FakeAgent): { agent: FakeAgent; dispose(): Promise<void> } {
  return { agent, dispose: () => Promise.resolve() }
}

function makeChannel(services: Record<string, unknown>, initial: FakeAgent): ChannelState {
  const { ctx } = makeCtx(services)
  return createChannel(ctx as never, initial as never, {
    model: 'test-model',
    cwd: '/tmp',
    provider: 'test',
    activity: false,
  })
}

const userMessage = (text: string): unknown => ({
  type: 'user/message',
  seq: 0,
  time: 1,
  data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
})

test('concurrent replacements serialize: resume starts only after the in-flight /new commits', async () => {
  const services: Record<string, unknown> = {}
  const channel = makeChannel(services, makeAgent('agent-initial', 's-initial'))
  const createGate = deferred<ReturnType<typeof makeHandle>>()
  const createCalls: unknown[] = []
  const observed = { agentIdAtResumeStart: '', epochAtResumeStart: -1 }
  const newAgent = makeAgent('agent-new', 's-new')
  const resumedAgent = makeAgent('agent-resumed', 's-resumed', [userMessage('from the resumed log')])
  services.agents = {
    create: (options: unknown) => {
      createCalls.push(options)
      return createGate.promise
    },
    resume: () => {
      // Strict-ordering probe: if the queue works, /new's commit is already
      // visible in channel state when the resume body reaches this point.
      observed.agentIdAtResumeStart = channel.agentId
      observed.epochAtResumeStart = channel.sessionEpoch
      return Promise.resolve(makeHandle(resumedAgent))
    },
  }

  const epochBefore = channel.sessionEpoch
  const pendingNew = withTimeout(channel.newSession(), '/new')
  await tick()
  assert.equal(createCalls.length, 1, '/new reached agents.create')

  const pendingResume = withTimeout(channel.resumeTo('s-resumed'), 'resume')
  // Without serialization the resume body would reach agents.resume within
  // these ticks while /new is still parked.
  await tick()
  await tick()
  assert.equal(observed.epochAtResumeStart, -1, 'resume body must not start while /new is in flight')

  createGate.resolve(makeHandle(newAgent))
  assert.equal(await pendingNew, true)
  assert.equal(channel.agentId, 'agent-new')

  assert.deepEqual(await pendingResume, { ok: true })
  assert.equal(observed.agentIdAtResumeStart, 'agent-new', 'resume started only after /new committed')
  assert.equal(observed.epochAtResumeStart, epochBefore + 1, 'resume observed exactly the /new bump')
  assert.equal(channel.agentId, 'agent-resumed')
  assert.equal(channel.sessionEpoch, epochBefore + 2, 'one epoch bump per committed replacement')
  // The final state is the resume's alone: the transcript is exactly the
  // resumed log's replay, no residue from either prior session.
  const userRows = channel.rows.filter(row => row.kind === 'user')
  assert.deepEqual(userRows.map(row => row.text), ['from the resumed log'])
})

test('a failed replacement never blocks the queue; switchWorkspace delegates without re-entering it', async () => {
  let createCalls = 0
  const agents = {
    create: () => {
      createCalls += 1
      if (createCalls === 1) return Promise.reject(new Error('create exploded'))
      return Promise.resolve(makeHandle(makeAgent(`agent-${createCalls}`, `s-${createCalls}`)))
    },
  }
  const channel = makeChannel({ agents }, makeAgent('agent-initial', 's-initial'))
  // Toast expiry timers (4–8s) would hold the test process open after the
  // assertions finish; shrink them — orthogonal to the mechanism under test.
  const notify = channel.notify.bind(channel)
  channel.notify = (text, options) => notify(text, { ...options, timeoutMs: 1 })

  const pendingNew = withTimeout(channel.newSession(), '/new')
  const pendingWorkspace = withTimeout(
    channel.switchWorkspace({ kind: 'local', uri: sandboxHome, cwd: sandboxHome, label: 'sandbox', badge: '' }),
    'switchWorkspace',
  )
  assert.equal(await pendingNew, false, 'the failed create reports false')
  assert.equal(await pendingWorkspace, true, 'the queued workspace switch runs after the failure')
  assert.equal(channel.cwd, sandboxHome, 'the delegated /new committed with the workspace cwd')
  assert.equal(createCalls, 2, 'both replacements reached agents.create, in arrival order')
})

test('setEffort captured before a swap drops its mutation once the epoch moves mid-flight', async () => {
  const effortInfo = {
    reasoning: {
      efforts: [
        { id: 'high', name: 'High' },
        { id: 'max', name: 'Max' },
      ],
      defaultEffort: 'high',
    },
  }
  const resolveGate = deferred<typeof effortInfo>()
  let resolveCalls = 0
  const llm = {
    resolveModelInfo: () => {
      resolveCalls += 1
      // The setEffort lookup parks; later lookups (the swap's own
      // refreshEffortLevels) resolve immediately.
      return resolveCalls === 1 ? resolveGate.promise : Promise.resolve(effortInfo)
    },
    listModels: () => Promise.resolve([]),
  }
  const agents = {
    create: () => Promise.resolve(makeHandle(makeAgent('agent-new', 's-new'))),
  }
  const channel = makeChannel({ llm, agents }, makeAgent('agent-initial', 's-initial'))

  const pending = channel.setEffort('max')
  await tick()
  assert.equal(resolveCalls, 1, 'setEffort is parked in the route-metadata lookup')
  // A session replacement commits while the lookup is in flight.
  assert.equal(await withTimeout(channel.newSession(), '/new'), true)
  const epochAfterSwap = channel.sessionEpoch
  resolveGate.resolve(effortInfo)
  assert.equal(await pending, false, 'the stale setEffort reports the neutral shape')
  assert.notEqual(channel.reasoningEffort, 'max', 'no effort pinned onto the new session')
  assert.equal(channel.sessionEpoch, epochAfterSwap, 'a dropped write bumps nothing')
})

test('switchPreset captured before a swap drops its recompose once the epoch moves mid-flight', async () => {
  const recomposeGate = deferred<{ id: string }>()
  const recomposeCalls: string[] = []
  const roster = {
    defaultId: 'default-preset',
    list: () => Promise.resolve([]),
    resolve: (id?: string) => Promise.resolve({ id: id ?? 'default-preset', name: id ?? 'default-preset' }),
    recompose: (_agentCtx: unknown, id: string) => {
      recomposeCalls.push(id)
      return recomposeGate.promise
    },
  }
  const newAgent = makeAgent('agent-new', 's-new')
  const agents = { create: () => Promise.resolve(makeHandle(newAgent)) }
  const channel = makeChannel({ agentPresets: roster, agents }, makeAgent('agent-initial', 's-initial'))

  const pending = channel.switchPreset('other-preset')
  await tick()
  assert.deepEqual(recomposeCalls, ['other-preset'], 'blank session proceeds to recompose')
  // A session replacement commits while the roster recompose is in flight.
  assert.equal(await withTimeout(channel.newSession(), '/new'), true)
  assert.equal(channel.agentPreset, 'default-preset', 'the /new session composed the roster default')
  recomposeGate.resolve({ id: 'other-preset' })
  assert.equal(await pending, false, 'the stale switch reports the neutral shape')
  assert.equal(channel.agentPreset, 'default-preset', 'the new session keeps its own composition')
  assert.equal(
    newAgent.session.events.filter(event => (event as { type: string }).type === 'agent-preset/selected').length,
    0,
    'no composition event appended to the new session log',
  )
})

test('a parked replacement never gates submit/steer — turn paths stay out of the queue', async () => {
  const createGate = deferred<ReturnType<typeof makeHandle>>()
  const followups: string[] = []
  const steers: string[] = []
  const initial = makeAgent('agent-initial', 's-initial')
  initial.followup = message => {
    followups.push((message as { content: [{ text: string }] }).content[0].text)
  }
  initial.steer = message => {
    steers.push((message as { content: [{ text: string }] }).content[0].text)
  }
  const agents = { create: () => createGate.promise }
  const channel = makeChannel({ agents }, initial)

  const pending = withTimeout(channel.newSession(), '/new')
  await tick()
  // The replacement is parked inside agents.create; typed input must still
  // flow to the live (old) agent.
  channel.submit('queued while replacing')
  channel.steer('steered while replacing')
  await settle()
  assert.deepEqual(followups, ['queued while replacing'])
  assert.deepEqual(steers, ['steered while replacing'])
  createGate.resolve(makeHandle(makeAgent('agent-new', 's-new')))
  assert.equal(await pending, true)
})
