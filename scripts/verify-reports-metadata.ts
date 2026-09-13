/** L4-4d lifecycle proof: report/metadata/file modules own effects and fence late work. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createChannelOwner } from '../src/dsh-adapter/channel/owner.js'
import { createFileActions } from '../src/dsh-adapter/channel/file-actions.js'
import { createSessionMetadataActions } from '../src/dsh-adapter/channel/session-metadata.js'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolveInner => { resolve = resolveInner })
  return { promise, resolve }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

// Source gate: root is wiring only; implementations stay in dedicated owners.
const root = readFileSync(new URL('../src/dsh-adapter/channel.ts', import.meta.url), 'utf8')
for (const factory of ['createReportActions(', 'createSessionMetadataActions(', 'createFileActions(']) {
  assert.match(root, new RegExp(factory.replace(/[()]/g, '\\$&'), 'u'))
}
for (const leaked of ['async recapRecent(', 'async sideQuestion(', 'async listFileCandidates(', 'async renameSessionTo(', 'doctorInfo() {\n      const lines']) {
  assert.equal(root.includes(leaked), false, `root must not retain ${leaked}`)
}

const oldAgent = {
  id: 'old',
  session: {
    id: 'old', events: [] as never[], requestHeader: () => undefined,
    deriveMessages: () => [], append: () => undefined,
  },
}
const newAgent = { ...oldAgent, id: 'new', session: { ...oldAgent.session, id: 'new' } }
let agent = oldAgent
let generation = 1
const owner = createChannelOwner()
const binding = {
  get agent() { return agent },
  capture: () => ({ agent, generation }),
  isCurrent: (capture: { agent: unknown; generation: number }) => owner.current() && capture.agent === agent && capture.generation === generation,
}
const streamGate = deferred<void>()
let streamSignal: AbortSignal | undefined
const ctx = {
  get(name: string) {
    if (name === 'llm') return {
      stream: async function * (options: { signal?: AbortSignal }) {
        streamSignal = options.signal
        await streamGate.promise
        yield { type: 'text-delta', index: 0, text: 'late' }
        yield { type: 'step-end', reason: 'stop' }
      },
    }
    return undefined
  },
}
const visible: string[] = []
const metadata = createSessionMetadataActions(ctx as never, {
  owner, binding: binding as never,
  provider: () => 'deepseek', model: () => 'model', emit: () => undefined,
  sessionTitle: () => '', setSessionTitle: () => undefined, setSessionColor: () => undefined,
  forgetAgentView: () => undefined, setPersistedSessions: () => undefined,
  skillRegistryFor: () => undefined, skillViewOptions: () => ({ scope: agent as never, cwd: '/repo' }),
})

// Switching the attached session while /btw is in flight must suppress both
// streamed presentation and its completed answer.
const question = metadata.sideQuestion('does this leak?', { onText: text => visible.push(text) })
await tick()
agent = newAgent
 generation += 1
streamGate.resolve()
assert.deepEqual(await question, { answer: null }, 'late side question cannot return against replacement session')
assert.deepEqual(visible, [], 'late side question cannot append streamed UI text')

// Owner disposal aborts a pending recap/side-question request even if the
// caller provided no AbortSignal; this is the run-to-completion cancellation
// fence used by Chat unmount/session replacement.
const owner2 = createChannelOwner()
let owner2Agent = oldAgent
let owner2Generation = 1
const binding2 = {
  get agent() { return owner2Agent },
  capture: () => ({ agent: owner2Agent, generation: owner2Generation }),
  isCurrent: (capture: { agent: unknown; generation: number }) => owner2.current() && capture.agent === owner2Agent && capture.generation === owner2Generation,
}
const stalled = deferred<void>()
let abortSeen = false
const cancellationCtx = {
  get(name: string) {
    if (name === 'llm') return { stream: async function * (options: { signal?: AbortSignal }) {
      options.signal?.addEventListener('abort', () => { abortSeen = true; stalled.resolve() }, { once: true })
      await stalled.promise
      throw new Error('aborted')
    } }
    return undefined
  },
}
const cancellationMetadata = createSessionMetadataActions(cancellationCtx as never, {
  owner: owner2, binding: binding2 as never,
  provider: () => 'deepseek', model: () => 'model', emit: () => undefined,
  sessionTitle: () => '', setSessionTitle: () => undefined, setSessionColor: () => undefined,
  forgetAgentView: () => undefined, setPersistedSessions: () => undefined,
  skillRegistryFor: () => undefined, skillViewOptions: () => ({ scope: owner2Agent as never, cwd: '/repo' }),
})
const cancelled = cancellationMetadata.sideQuestion('cancel me')
await tick()
owner2.dispose()
assert.deepEqual(await cancelled, { answer: null }, 'disposed owner returns no stale answer')
assert.equal(abortSeen, true, 'owner disposal reaches the captured LLM signal')
assert.ok(streamSignal !== undefined, 'side-question request receives a signal')

// The same owner + binding fence governs /recap: no late streamed text or
// summary may surface after the session has changed.
const recapGate = deferred<void>()
let recapAgent = { ...oldAgent, session: {
  ...oldAgent.session,
  events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'recap source' }] } }] as never[],
} }
let recapGeneration = 1
const recapOwner = createChannelOwner()
const recapBinding = {
  get agent() { return recapAgent },
  capture: () => ({ agent: recapAgent, generation: recapGeneration }),
  isCurrent: (capture: { agent: unknown; generation: number }) => recapOwner.current() && capture.agent === recapAgent && capture.generation === recapGeneration,
}
const recapVisible: string[] = []
const recapMetadata = createSessionMetadataActions({ get: (name: string) => name === 'llm' ? {
  stream: async function * () { await recapGate.promise; yield { type: 'text-delta', index: 0, text: '{\"summary\":\"late\"}' }; yield { type: 'step-end', reason: 'stop' } },
} : undefined } as never, {
  owner: recapOwner, binding: recapBinding as never,
  provider: () => 'deepseek', model: () => 'model', emit: () => undefined,
  sessionTitle: () => '', setSessionTitle: () => undefined, setSessionColor: () => undefined,
  forgetAgentView: () => undefined, setPersistedSessions: () => undefined,
  skillRegistryFor: () => undefined, skillViewOptions: () => ({ scope: recapAgent as never, cwd: '/repo' }),
})
const recap = recapMetadata.recapRecent({ onText: text => recapVisible.push(text) })
await tick()
recapAgent = { ...newAgent, session: { ...newAgent.session, events: [] as never[] } }
recapGeneration += 1
recapGate.resolve()
assert.deepEqual(await recap, { summary: null }, 'late recap cannot return against replacement session')
assert.deepEqual(recapVisible, [], 'late recap cannot append streamed UI text')

// A file scan begun in an old cwd cannot surface candidates after a binding
// replacement; cache data remains private to its captured cwd.
let cwd = '/old'
let active = true
const fileGate = deferred<Array<{ name: string; type: 'file' }>>()
const fileOwner = new AbortController()
const files = createFileActions({
  owner: { current: () => active, signal: fileOwner.signal },
  capture: () => ({ cwd }), current: capture => active && (capture as { cwd: string }).cwd === cwd,
  cwd: () => cwd,
  fs: () => ({
    resolve: async (path: string) => ({ displayPath: path }),
    stat: async () => undefined,
    readText: async () => '',
    listDir: async () => fileGate.promise,
  }),
})
const staleFiles = files.listFileCandidates('read')
await tick()
cwd = '/new'
fileGate.resolve([{ name: 'readme.md', type: 'file' }])
assert.deepEqual(await staleFiles, [], 'late file candidates cannot belong to replacement cwd/session')

// A deep scan is owned by its Channel/CWD cache entry. Cancelling the first
// waiter must only suppress that waiter's result, not cancel the scan reused
// by a second, live waiter in the same cwd.
const sharedOwner = new AbortController()
const firstWaiter = new AbortController()
const sharedGate = deferred<Array<{ name: string; type: 'file' }>>()
const sharedFiles = createFileActions({
  owner: { current: () => !sharedOwner.signal.aborted, signal: sharedOwner.signal },
  capture: () => 'shared', current: capture => capture === 'shared',
  cwd: () => '/shared',
  fs: () => ({
    resolve: async (path: string) => ({ displayPath: path }),
    stat: async () => undefined,
    readText: async () => '',
    listDir: async () => sharedGate.promise,
  }),
})
const cancelledWaiter = sharedFiles.listFileCandidates('beta', { signal: firstWaiter.signal })
await tick()
firstWaiter.abort()
const liveWaiter = sharedFiles.listFileCandidates('beta')
sharedGate.resolve([{ name: 'beta.ts', type: 'file' }])
assert.deepEqual(await cancelledWaiter, [], 'cancelled scan waiter returns no candidates')
assert.deepEqual((await liveWaiter).map(candidate => candidate.path), ['beta.ts'],
  'live waiter receives the shared CWD scan after another waiter cancels')

// A live credentials service rejection remains a read failure; only an absent
// service or a stale binding may resolve as undefined.
const metadataOwner = createChannelOwner()
const metadataBinding = {
  capture: () => ({ agent: oldAgent, generation: 1 }),
  isCurrent: () => true,
}
const persistedSnapshots: Array<readonly unknown[]> = []
const metadataErrors = createSessionMetadataActions({
  get(name: string) {
    if (name === 'credentials') return { describe: async () => { throw new Error('credential store unreadable') } }
    return undefined
  },
} as never, {
  owner: metadataOwner, binding: metadataBinding as never,
  provider: () => 'deepseek', model: () => 'model', emit: () => undefined,
  sessionTitle: () => '', setSessionTitle: () => undefined, setSessionColor: () => undefined,
  forgetAgentView: () => undefined, setPersistedSessions: rows => { persistedSnapshots.push(rows) },
  skillRegistryFor: () => undefined, skillViewOptions: () => ({ scope: oldAgent as never, cwd: '/repo' }),
})
await assert.rejects(metadataErrors.describeCredential('DEEPSEEK_API_KEY'), /credential store unreadable/)
const noCredentials = createSessionMetadataActions({ get: () => undefined } as never, {
  owner: metadataOwner, binding: metadataBinding as never,
  provider: () => 'deepseek', model: () => 'model', emit: () => undefined,
  sessionTitle: () => '', setSessionTitle: () => undefined, setSessionColor: () => undefined,
  forgetAgentView: () => undefined, setPersistedSessions: rows => { persistedSnapshots.push(rows) },
  skillRegistryFor: () => undefined, skillViewOptions: () => ({ scope: oldAgent as never, cwd: '/repo' }),
})
assert.equal(await noCredentials.describeCredential('DEEPSEEK_API_KEY'), undefined,
  'an absent credentials service is the only live undefined credential result')

// Losing the optional persistence service is itself a current observation and
// clears a previously projected agent-view snapshot.
const noPersistence = createSessionMetadataActions({ get: () => undefined } as never, {
  owner: metadataOwner, binding: metadataBinding as never,
  provider: () => 'deepseek', model: () => 'model', emit: () => undefined,
  sessionTitle: () => '', setSessionTitle: () => undefined, setSessionColor: () => undefined,
  forgetAgentView: () => undefined, setPersistedSessions: rows => { persistedSnapshots.push(rows) },
  skillRegistryFor: () => undefined, skillViewOptions: () => ({ scope: oldAgent as never, cwd: '/repo' }),
})
assert.deepEqual(await noPersistence.listSessions(), [])
assert.deepEqual(persistedSnapshots, [[]], 'missing persistence clears the current persisted-session snapshot')

console.log('verify-reports-metadata: OK')
