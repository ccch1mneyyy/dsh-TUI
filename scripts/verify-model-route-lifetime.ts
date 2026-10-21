/** Model routes survive live-session parking; legacy delegation fails closed.
 * Run: node --import tsx/esm scripts/verify-model-route-lifetime.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testHome = mkdtempSync(join(tmpdir(), 'dshtui-route-lifetime-'))
process.env.HOME = testHome
process.env.USERPROFILE = testHome
process.env.DSH_TUI_LANG = 'en'
const { createChannel } = await import('../src/dsh-adapter/channel.js')
const { createModelSwitchAction } = await import('../src/dsh-adapter/channel/model-switch.js')
const { readModelPref } = await import('../src/modelPrefs.js')
const { readEffortPref, writeEffortPref } = await import('../src/effortPrefs.js')

type Route = { provider: string; model: string; reasoningEffort?: string }
type Assembly = { variables: Route }
type Hook = (...args: unknown[]) => Promise<unknown>
const invoke = async <T>(hook: Hook | undefined, ...args: unknown[]): Promise<T> => {
  assert.ok(hook, 'routing listener remains installed')
  return await hook(...args) as T
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const makeAgent = (id: string, provider: string, model: string) => {
  let config: Route = { provider, model }
  const hooks = new Map<string, Hook>()
  let installs = 0
  const events = [
    { seq: 0, time: 1, type: 'request/header', data: { header: { config } } },
    { seq: 1, time: 2, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, time: 3, type: 'user/message', data: { id: `${id}-prompt`, source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
    { seq: 3, time: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  return {
    id, status: 'idle', options: { provider, model }, hooks,
    get installs() { return installs },
    session: { id, header: { id, cwd: '/tmp/demo' }, events, get seq() { return events.length }, requestHeader: () => ({ config }) },
    ctx: { on(name: string, hook: Hook) {
      installs++
      hooks.set(name, hook)
      return () => { if (hooks.get(name) === hook) hooks.delete(name) }
    } },
    record(route: Route) {
      config = route
      events.push({ seq: events.length, time: 5, type: 'request/header', data: { header: { config } } })
    },
    followup() {}, steer() {}, inbox: { remove: () => true },
  }
}

if (!process.argv.includes('--legacy-only')) for (const persisted of [true, false]) {
  const original = makeAgent('original', 'p', 'a')
  const other = makeAgent('other', 'q', 'c')
  const registry = new Map([original, other].map(agent => [agent.id, agent]))
  const ctx = { on: () => () => {}, logger: { warn() {} }, get(name: string) {
    if (name === 'agents') return { get: (id: string) => registry.get(id), list: () => [...registry.values()] }
    if (name === 'llm') return {
      listProviders: () => [{ id: 'p' }, { id: 'q' }],
      listModels: async () => ['a', 'b', 'c'].map(id => ({ id })),
      resolveModelInfo: async () => ({ reasoning: false }),
    }
  } }
  const channel = createChannel(ctx as never, original as never, { provider: 'p', model: 'a', cwd: '/tmp/demo', activity: false })
  try {
    const contextGate = deferred<Assembly>()
    const oldContext = invoke<Assembly>(original.hooks.get('system-prompt/assemble'), {}, {}, () => contextGate.promise)
    assert.equal(await channel.switchModel('p', 'b'), true)
    const gate = deferred<Assembly>()
    const assemblyHook = original.hooks.get('system-prompt/assemble')
    const assembly = invoke<Assembly>(assemblyHook, {}, {}, () => gate.promise)
    if (persisted) {
      gate.resolve({ variables: original.options })
      assert.equal((await assembly).variables.model, 'b')
      contextGate.resolve({ variables: original.options })
      await oldContext
      const request = await invoke<Route>(original.hooks.get('agent/request'), {}, async () => original.session.requestHeader().config)
      assert.equal(request.model, 'b', 'a late context inspection cannot overwrite a newer request selection')
      original.record(request)
    }
    assert.deepEqual(await channel.resumeTo(other.id), { ok: true })
    assert.equal(channel.model, 'c')
    if (!persisted) {
      assert.deepEqual(await channel.resumeTo(original.id), { ok: true })
      assert.equal(channel.model, 'b', 'live selection outranks an older header before request admission')
      assert.deepEqual(await channel.resumeTo(other.id), { ok: true })
      gate.resolve({ variables: original.options })
    }
    contextGate.resolve({ variables: original.options })
    await oldContext
    const parkedAssembly = persisted
      ? await invoke<Assembly>(original.hooks.get('system-prompt/assemble'), {}, {}, async () => ({ variables: original.options }))
      : await assembly
    assert.deepEqual(parkedAssembly.variables, { provider: 'p', model: 'b' }, 'parked prompt keeps its own selected route')
    const parkedRequest = await invoke<Route>(original.hooks.get('agent/request'), {}, async () => original.session.requestHeader().config)
    assert.deepEqual(parkedRequest, { provider: 'p', model: 'b' }, 'parked request cannot borrow the foreground route')
    original.record(parkedRequest)
    assert.equal(channel.model, 'c', 'background routing never changes the foreground projection')
    assert.deepEqual(await channel.resumeTo(original.id), { ok: true })
    assert.equal(channel.model, 'b')
    const restored = await invoke<Assembly>(original.hooks.get('system-prompt/assemble'), {}, {}, async () => ({ variables: original.options }))
    assert.deepEqual(restored.variables, parkedRequest, 'reattachment preserves prompt/request agreement without effort support')
    assert.equal(original.installs, 3, 'reattachment reuses one routing listener set')
  } finally {
    channel.releaseContributions()
  }
  assert.equal(original.hooks.size, 0, 'owner release removes parked routing listeners too')
  assert.equal(other.hooks.size, 0)
}

if (!process.argv.includes('--legacy-only')) {
  const original = makeAgent('effort-original', 'p', 'a')
  original.record({ provider: 'p', model: 'a', reasoningEffort: 'high' })
  const fresh = makeAgent('effort-fresh', 'p', 'a')
  fresh.session.events.length = 0
  fresh.session.requestHeader = () => undefined as never
  const unpinned = makeAgent('effort-unpinned', 'p', 'a')
  const registry = new Map([original, fresh, unpinned].map(agent => [agent.id, agent]))
  writeEffortPref('low')
  const channel = createChannel({ on: () => () => {}, logger: { warn() {} }, get(name: string) {
    if (name === 'agents') return { get: (id: string) => registry.get(id), list: () => [...registry.values()] }
    if (name === 'llm') return {
      listProviders: () => [{ id: 'p' }], listModels: async () => [{ id: 'a' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: ['low', 'high'].map(id => ({ id, name: id })) } }),
    }
  } } as never, original as never, { provider: 'p', model: 'a', cwd: '/tmp/demo', activity: false })
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const requestOf = async (agent: ReturnType<typeof makeAgent>) => {
    await invoke<Assembly>(agent.hooks.get('system-prompt/assemble'), {}, {}, async () => ({ variables: agent.options }))
    return invoke<Route>(agent.hooks.get('agent/request'), {}, async () => agent.options)
  }
  try {
    await settle()
    assert.equal(channel.reasoningEffort, 'high', 'boot restores the durable effort above a global default')
    assert.equal((await requestOf(original)).reasoningEffort, 'high', 'the next request restores the same durable effort')
    assert.deepEqual(await channel.resumeTo(fresh.id), { ok: true })
    await settle()
    assert.equal(channel.reasoningEffort, 'low', 'an untouched session seeds the global effort')
    assert.equal((await requestOf(fresh)).reasoningEffort, 'low')
    assert.deepEqual(await channel.resumeTo(original.id), { ok: true })
    await settle()
    assert.equal(channel.reasoningEffort, 'high', 'passive resume cannot overwrite the durable pin')
    assert.equal((await requestOf(original)).reasoningEffort, 'high')
    assert.equal(readEffortPref(), 'low', 'resume never rewrites the global preference')
    assert.deepEqual(await channel.resumeTo(unpinned.id), { ok: true })
    await settle()
    assert.equal(channel.reasoningEffort, undefined, 'a recorded header without effort owns its unpinned state')
    assert.equal((await requestOf(unpinned)).reasoningEffort, undefined, 'a recorded unpinned request cannot borrow the global low')
    assert.deepEqual(await channel.resumeTo(original.id), { ok: true })
    await settle()
    channel.setDefaultEffort('off')
    await settle()
    assert.equal((await requestOf(original)).reasoningEffort, undefined, 'an unsupported explicit preference clears the live pin')
    assert.deepEqual(await channel.resumeTo(unpinned.id), { ok: true })
    assert.deepEqual(await channel.resumeTo(original.id), { ok: true })
    await settle()
    assert.equal(channel.reasoningEffort, undefined, 'reattachment cannot revive an older high header over a cleared live pin')
    assert.equal((await requestOf(original)).reasoningEffort, undefined)

    channel.setDefaultEffort('high')
    await settle()
    channel.setDefaultEffort('low')
    await settle()
    assert.equal((await requestOf(original)).reasoningEffort, 'low', 'an explicit settings change still updates the next request')
    assert.equal(await channel.setEffort('high'), true)
    assert.equal((await requestOf(original)).reasoningEffort, 'high', 'an explicit effort choice still updates the next request')
  } finally { channel.releaseContributions() }
}

if (!process.argv.includes('--legacy-only')) {
  const child = makeAgent('seeded-child', 'p', 'b')
  child.record({ provider: 'p', model: 'a' })
  const channel = createChannel({ on: () => () => {}, get: () => undefined, logger: { warn() {} } } as never,
    child as never, { provider: 'p', model: 'b', cwd: '/tmp/demo', activity: false })
  try {
    const assembly = await invoke<Assembly>(child.hooks.get('system-prompt/assemble'), {}, {}, async () => ({ variables: child.options }))
    const request = await invoke<Route>(child.hooks.get('agent/request'), {}, async () => child.options)
    assert.deepEqual(assembly.variables, { provider: 'p', model: 'b' })
    assert.deepEqual(request, assembly.variables, 'a seeded child keeps its explicitly selected route over inherited headers')
  } finally { channel.releaseContributions() }
}

{
  const state = { provider: 'p', model: 'a', working: false, emit() {} }
  const selection = { current: undefined, assembled: undefined }
  const before = readModelPref()
  let sideEffects = 0
  const notices: string[] = []
  const switchModel = createModelSwitchAction({ get: () => { sideEffects++; return undefined } } as never, state, {
    owner: { current: () => true },
    binding: { capture: () => ({}), isCurrent: () => true } as never,
    selection, supportsRouteSwitch: false,
    async applyPreferredEffort() { sideEffects++ },
    dropModelCompletion() { sideEffects++ }, seedUpstreamRetry() { sideEffects++ },
    notify(text) { notices.push(text); return () => {} },
  })
  assert.equal(await switchModel('p', 'b'), false, 'legacy delegation cannot silently continue on the old model')
  assert.equal(await switchModel('p', 'a'), true, 'an unchanged route remains a harmless no-op')
  assert.equal(state.model, 'a')
  assert.equal(selection.current, undefined)
  assert.deepEqual(readModelPref(), before, 'refusal cannot change the global model default')
  assert.equal(sideEffects, 0, 'refusal precedes catalog, effort and retry writes')
  assert.equal(notices.length, 1)
}
console.log('verify-model-route-lifetime: OK (parked requests, reattachment, cleanup, legacy refusal)')
