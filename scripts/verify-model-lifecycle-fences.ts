/**
 * Deferred interleavings for the model/preset/workspace action factories.
 *
 * This exercises actual action closures, rather than source tokens: a stale
 * completion must not change a replacement binding's selection, session facts,
 * preferences, or published workspace breadcrumb.
 */
import assert from 'node:assert/strict'
import { createModelActions } from '../src/dsh-adapter/channel/model-actions.js'
import { createWorkspaceActions } from '../src/dsh-adapter/channel/workspace-actions.js'

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolveInner, rejectInner) => { resolve = resolveInner; reject = rejectInner })
  return { promise, resolve, reject }
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

const oldAgent = { ctx: { tag: 'old' }, session: { events: [], append: () => { throw new Error('old fact should not be appended') } } }
const newFacts: unknown[] = []
const newAgent = { ctx: { tag: 'new' }, session: { events: [], append: (type: string, data: unknown) => newFacts.push([type, data]) } }
let agent = oldAgent
let bindingGeneration = 1
let ownerActive = true
const binding = {
  capture: () => ({ agent, generation: bindingGeneration }),
  isCurrent: (capture: { agent: unknown; generation: number }) => ownerActive && capture.agent === agent && capture.generation === bindingGeneration,
}
const selection: { current?: unknown; assembled?: unknown } = {}
const state = {
  provider: 'p', model: 'old', reasoningEffort: undefined as string | undefined,
  effortLevels: undefined as string[] | undefined, agentPreset: undefined as string | undefined,
  working: false, emit: () => undefined, notify: () => undefined,
}
const routeLoads = new Map<string, Deferred<{ reasoning: { efforts: { id: string; name: string }[] } }>>()
const infoFor = (provider: string, model: string) => {
  const gate = deferred<{ reasoning: { efforts: { id: string; name: string }[] } }>()
  routeLoads.set(`${provider}/${model}`, gate)
  return gate.promise
}
let recomposeGate = deferred<{ id: string; trust: 'system' | 'user' }>()
const presets = {
  defaultId: 'base',
  list: async () => [],
  resolve: async (id: string) => ({ id, trust: 'system' as const }),
  recompose: (_ctx: unknown, _id: string) => recomposeGate.promise,
}
const ctx = {
  get: (name: string) => name === 'llm'
    ? { resolveModelInfo: infoFor, listProviders: () => [], listModels: async () => [] }
    : name === 'agentPresets' ? presets : undefined,
}
const actions = createModelActions(ctx as never, state as never, {
  owner: { current: () => ownerActive }, binding: binding as never, selection: selection as never,
  initialEffort: 'high', agent: () => agent as never, notify: state.notify as never,
})

// Old preferred-effort metadata resolves after a new route has won. The old
// completion must not replace the new route's tiers or request selection.
const oldPreferred = actions.applyPreferredEffort()
await tick()
state.provider = 'p'
state.model = 'new'
actions.refreshEffortLevels()
await tick()
routeLoads.get('p/new')!.resolve({ reasoning: { efforts: [{ id: 'low', name: 'Low' }] } })
await tick()
assert.deepEqual(state.effortLevels, ['low'])
selection.current = { provider: 'p', model: 'new', reasoningEffort: 'low' }
routeLoads.get('p/old')!.resolve({ reasoning: { efforts: [{ id: 'high', name: 'High' }] } })
await oldPreferred
assert.deepEqual(state.effortLevels, ['low'], 'old metadata cannot overwrite replacement tiers')
assert.deepEqual(selection.current, { provider: 'p', model: 'new', reasoningEffort: 'low' }, 'old metadata cannot overwrite replacement selection')

// The slider path has the same fence: a deferred validation cannot persist or
// select a tier after its captured route has been superseded.
const staleSet = actions.setEffort('low')
await tick()
state.model = 'newer'
routeLoads.get('p/new')!.resolve({ reasoning: { efforts: [{ id: 'low', name: 'Low' }] } })
assert.equal(await staleSet, false)
assert.deepEqual(selection.current, { provider: 'p', model: 'new', reasoningEffort: 'low' }, 'stale slider validation cannot write selection')

// Preset recompose must keep the original agent/session and publish neither a
// fact nor projection change when that binding is replaced while awaiting.
state.model = 'new'
const stalePreset = actions.switchPreset('review')
await tick()
agent = newAgent
bindingGeneration += 1
recomposeGate.resolve({ id: 'review', trust: 'system' })
assert.equal(await stalePreset, false)
assert.deepEqual(newFacts, [], 'stale recompose cannot append a fact to the replacement session')
assert.equal(state.agentPreset, undefined, 'stale recompose cannot update replacement projection')

// Owner revocation is independently terminal: a still-current binding cannot
// let a late preferred-effort read alter its request selection after teardown.
ownerActive = true
state.provider = 'p'
state.model = 'owner-revoked'
const revokedPreferred = actions.applyPreferredEffort()
await tick()
ownerActive = false
routeLoads.get('p/owner-revoked')!.resolve({ reasoning: { efforts: [{ id: 'high', name: 'High' }] } })
await revokedPreferred
assert.deepEqual(selection.current, { provider: 'p', model: 'new', reasoningEffort: 'low' }, 'owner-revoked preferred effort cannot write selection')
assert.deepEqual(state.effortLevels, ['low'], 'owner-revoked preferred effort cannot replace visible tiers')

// Recompose is also forbidden after owner revoke, even though its original
// agent/session remain available. It must not append a durable fact or update
// the preferred preset.
ownerActive = true
state.model = 'new'
recomposeGate = deferred<{ id: string; trust: 'system' | 'user' }>()
const revokedPreset = actions.switchPreset('owner-revoked')
await tick()
ownerActive = false
recomposeGate.resolve({ id: 'owner-revoked', trust: 'system' })
assert.equal(await revokedPreset, false)
assert.deepEqual(newFacts, [], 'owner-revoked recompose cannot append a durable fact')
assert.equal(state.agentPreset, undefined, 'owner-revoked recompose cannot update preferred projection')
ownerActive = true

// Workspace composition keeps cwd private until its guarded new-session seam
// adopts it. A stale false/rejection therefore cannot roll back B after B wins.
const workspaceState = {
  cwd: '/original', displayCwd: '/original', working: false, emit: () => undefined,
}
const workspaceCalls: Deferred<boolean>[] = []
const workspace = createWorkspaceActions(workspaceState as never, {
  owner: { assertActive: () => undefined },
  service: { list: async () => [], resolve: async () => undefined, commands: () => [], runCommand: async () => undefined, rename: async () => { throw new Error('unused') } } as never,
  newSession: target => {
    const gate = deferred<boolean>()
    workspaceCalls.push(gate)
    gate.promise.then(ok => {
      // This is the only permitted publication point: it stands in for the
      // successful adoption tail in newSessionWithTarget.
      if (ok) {
        workspaceState.cwd = target!.cwd
        workspaceState.displayCwd = target!.displayCwd!
      }
    }).catch(() => undefined)
    return gate.promise
  },
  refreshGitBranch: () => undefined, notify: () => undefined,
})
const workspaceA = workspace.switchWorkspace({ kind: 'remote', cwd: '/A', uri: 'a:', label: 'A' } as never)
const workspaceB = workspace.switchWorkspace({ kind: 'remote', cwd: '/B', uri: 'b:', label: 'B' } as never)
assert.equal(workspaceState.cwd, '/original', 'workspace target is not speculatively shared')
workspaceCalls[1]!.resolve(true)
assert.equal(await workspaceB, true)
workspaceCalls[0]!.resolve(false)
assert.equal(await workspaceA, false)
assert.equal(workspaceState.cwd, '/B', 'late losing workspace cannot roll back later successful adoption')
const rejected = workspace.switchWorkspace({ kind: 'remote', cwd: '/reject', uri: 'reject:', label: 'reject' } as never)
workspaceCalls[2]!.reject(new Error('create failed'))
assert.equal(await rejected, false)
assert.equal(workspaceState.cwd, '/B', 'rejected workspace creation cannot publish or roll back cwd')

console.log('verify-model-lifecycle-fences: OK')
