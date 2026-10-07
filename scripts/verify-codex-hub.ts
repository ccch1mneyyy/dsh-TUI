/**
 * CodexHub against the fake app-server (docs/codex-backend-design.md §5.3,
 * §10.3): handshake parameters and opt-outs, routing by thread (a subagent
 * thread routed to its parent's sink, thread-less traffic to the global
 * listeners), server requests keyed by connection generation (redelivery
 * flagged, answers once, stale generations dropped, unrouted requests never
 * left hanging), retain / idle close, crash → restart with backoff →
 * `connectionRestored`, a permanent failure after the restart budget, a
 * first handshake that fails without restarting, and one hub per settings
 * fingerprint.
 *
 * Run: node --import tsx/esm scripts/verify-codex-hub.ts
 */
import assert from 'node:assert/strict'
import type { RpcClock } from '../src/backends/codex/rpc/client.js'
import { acquireCodexHub, closeAllCodexHubs, createCodexHub, hubFingerprint, type HubDiagnostic, type HubServerRequest, type HubSettings, type ThreadSink } from '../src/backends/codex/rpc/hub.js'
import { createFakeAppServer, FakeRpcError, NO_REPLY } from './lib/codex-fake-app-server.js'

type Rec = Record<string, unknown>
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const tick = (ms = 0): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

function manualClock(): RpcClock & { advance(ms: number): void; readonly pending: number } {
  let now = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  let next = 1
  return {
    get pending() { return timers.size },
    setTimeout: (callback, ms) => { const id = next++; timers.set(id, { at: now + ms, callback }); return id },
    clearTimeout: handle => { timers.delete(handle as number) },
    advance(ms) {
      now += ms
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (timer.at <= now) { timers.delete(id); timer.callback() }
    },
  }
}

/** A sink that records everything. */
function recorder() {
  const notes: string[] = []
  const requests: HubServerRequest[] = []
  const lost: { message: string; permanent: boolean }[] = []
  const diagnostics: HubDiagnostic[] = []
  let restored = 0
  const sink: ThreadSink = {
    notification: (method, params) => { notes.push(`${method}:${String(params.threadId ?? (params.thread as Rec | undefined)?.id ?? '')}`) },
    serverRequest: request => { requests.push(request) },
    connectionLost: (error, permanent) => { lost.push({ message: error.message, permanent }) },
    connectionRestored: () => { restored += 1 },
    diagnostic: entry => { diagnostics.push(entry) },
  }
  return { sink, notes, requests, lost, diagnostics, get restored() { return restored } }
}

const SETTINGS: HubSettings = { executable: '/opt/codex', args: ['app-server'], env: { PATH: '/bin', CODEX_HOME: '/h' }, cwd: '/tmp' }

// ── handshake, routing, server requests ─────────────────────────────────
{
  const fake = createFakeAppServer()
  fake.on('thread/read', () => ({ thread: { parentThreadId: null } }))
  const clock = manualClock()
  const debug: string[] = []
  const hub = createCodexHub(SETTINGS, { transportFactory: fake.transportFactory, clock, debug: line => debug.push(line), clientVersion: '9.9.9' })
  const info = await hub.ready
  const init = fake.requests.find(request => request.method === 'initialize')!
  const caps = init.params.capabilities as Rec
  check('handshake: clientInfo names dsh-tui with the package version', (init.params.clientInfo as Rec).name === 'dsh-tui' && (init.params.clientInfo as Rec).version === '9.9.9')
  check('handshake: experimental API on, attestation off', caps.experimentalApi === true && caps.requestAttestation === false)
  const optOut = caps.optOutNotificationMethods as string[]
  check('handshake: high-rate notifications opted out', ['rawResponseItem/completed', 'fs/changed', 'thread/realtime/started', 'app/list/updated'].every(name => optOut.includes(name)))
  await tick()
  check('handshake: `initialized` follows the answer', fake.notifications.some(note => note.method === 'initialized'))
  check('ready resolves with the server info and generation 1', info.codexHome === '/TMP/home' && info.generation === 1 && hub.state === 'ready')
  check('the spawn uses the settings (executable, args, cwd)', fake.spawns[0]!.executable === '/opt/codex' && fake.spawns[0]!.args.join(' ') === 'app-server' && fake.spawns[0]!.cwd === '/tmp')

  const parent = recorder()
  const other = recorder()
  hub.attach('T1', parent.sink)
  const detachOther = hub.attach('T2', other.sink)
  const unroute = hub.route('CHILD', 'T1')
  const globals: string[] = []
  hub.onGlobal(method => globals.push(method))
  fake.notify('turn/started', { threadId: 'T1', turn: { id: 'a' } })
  fake.notify('thread/started', { thread: { id: 'T2' } })
  fake.notify('item/started', { threadId: 'CHILD', item: { type: 'agentMessage' } })
  fake.notify('item/started', { threadId: 'NOBODY', item: {} })
  fake.notify('account/rateLimits/updated', { rateLimits: {} })
  fake.notify('configWarning', { summary: 'x' })
  await tick()
  check('routing: by params.threadId and by params.thread.id', parent.notes[0] === 'turn/started:T1' && other.notes[0] === 'thread/started:T2')
  check('routing: a routed child thread reaches its parent sink', parent.notes[1] === 'item/started:CHILD')
  check('routing: an unattached thread is dropped (debug)', debug.some(line => line.includes('unattached thread NOBODY')))
  check('routing: thread-less notifications go to global listeners', globals.join(',') === 'account/rateLimits/updated,configWarning')
  unroute()
  detachOther()
  fake.notify('item/started', { threadId: 'CHILD', item: {} })
  fake.notify('turn/started', { threadId: 'T2', turn: { id: 'b' } })
  await tick()
  check('routing: unroute / detach stop delivery', parent.notes.length === 2 && other.notes.length === 1)

  const approval = fake.request('item/commandExecution/requestApproval', { threadId: 'T1', itemId: 'exec-1' })
  await tick()
  const request = parent.requests[0]!
  check('server request: routed to the thread sink with a generation key', request.key === 'codex:1:0' && request.method === 'item/commandExecution/requestApproval' && !request.redelivered && request.live())
  // The server re-sends the same pending id (a rejoin, C0 V5).
  fake.raw(JSON.stringify({ method: 'item/commandExecution/requestApproval', id: 0, params: { threadId: 'T1', itemId: 'exec-1' } }))
  await tick()
  check('server request: a re-sent pending id arrives flagged redelivered', parent.requests[1]?.redelivered === true && parent.requests[1]?.key === 'codex:1:0')
  request.respond({ decision: 'accept' })
  request.respond({ decision: 'decline' })
  parent.requests[1]!.respond({ decision: 'decline' })
  const answer = await approval
  check('server request: the first answer wins, a second is ignored', (answer.result as Rec).decision === 'accept' && [...fake.responses.values()].length === 1)
  fake.notify('serverRequest/resolved', { threadId: 'T1', requestId: 0 })
  await tick()
  const again = fake.request('item/fileChange/requestApproval', { threadId: 'T1', itemId: 'p' })
  await tick()
  check('server request: after resolution a new request is not a redelivery', parent.requests.at(-1)?.redelivered === false && parent.requests.at(-1)?.key === 'codex:1:1')
  parent.requests.at(-1)!.respond({ decision: 'decline' })
  await again
  const orphan = await fake.request('item/commandExecution/requestApproval', { threadId: 'NOBODY', itemId: 'x' })
  check('server request: an unrouted thread request is answered with an error', (orphan.error as Rec | undefined)?.code === -32603)
  const time = await fake.request('currentTime/read', { threadId: 'NOBODY-ELSE' })
  check('server request: currentTime/read is answered with the time', typeof (time.result as Rec | undefined)?.currentTimeAt === 'number')
  const unknown = await fake.request('attestation/generate', {})
  check('server request: an unknown thread-less request answers -32601', (unknown.error as Rec | undefined)?.code === -32601)
  const refreshes: HubServerRequest[] = []
  hub.onGlobalRequest('account/chatgptAuthTokens/refresh', req => { refreshes.push(req); req.respond({ accessToken: 'x' }) })
  const refreshed = await fake.request('account/chatgptAuthTokens/refresh', { reason: 'unauthorized' })
  check('server request: a global request handler answers thread-less requests', refreshes.length === 1 && (refreshed.result as Rec).accessToken === 'x')

  // Calls go through the live connection.
  fake.on('model/list', () => ({ data: [] }))
  check('call: a request on the live connection', JSON.stringify(await hub.call('model/list', {})) === '{"data":[]}')

  // ── retain / idle close ────────────────────────────────────────────────
  const releaseA = hub.retain()
  const releaseB = hub.retain()
  releaseA()
  releaseA()
  clock.advance(60_000)
  check('retain: one user left keeps the hub (double release counts once)', hub.state === 'ready')
  releaseB()
  clock.advance(29_000)
  const releaseC = hub.retain()
  clock.advance(5_000)
  check('retain: a new user during the idle wait cancels the close', hub.state === 'ready')
  releaseC()
  clock.advance(30_000)
  await tick()
  check('idle: 30 s after the last release the hub closes its child', hub.state === 'closed' && fake.closed)
  check('closed: calls reject', (await hub.call('model/list', {}).catch((error: unknown) => error)) instanceof Error)
}

// ── crash, restart, permanent failure ───────────────────────────────────
{
  const fake = createFakeAppServer()
  const clock = manualClock()
  const hub = createCodexHub(SETTINGS, { transportFactory: fake.transportFactory, clock })
  await hub.ready
  const sink = recorder()
  hub.attach('T1', sink.sink)
  const stale = fake.request('item/commandExecution/requestApproval', { threadId: 'T1', itemId: 'e' })
  void stale
  await tick()
  const staleRequest = sink.requests[0]!
  fake.on('thread/read', () => new Promise(() => undefined))
  const hanging = hub.call('thread/read', {}).catch((error: unknown) => error as Error)
  await tick()
  fake.crash({ code: 101 })
  await tick()
  check('crash: every sink hears connectionLost (not permanent)', sink.lost.length === 1 && !sink.lost[0]!.permanent && /exited/u.test(sink.lost[0]!.message))
  check('crash: pending calls reject', /exited/u.test((await hanging).message))
  check('crash: the hub is restarting', hub.state === 'restarting')
  clock.advance(499)
  check('restart: waits for the first backoff (500 ms)', fake.spawns.length === 1)
  clock.advance(1)
  await tick()
  await hub.ready
  await tick()
  check('restart: a new child, handshaken, generation 2, sinks told to resubscribe', fake.spawns.length === 2 && hub.generation === 2 && hub.info?.generation === 2 && sink.restored === 1)
  staleRequest.respond({ decision: 'accept' })
  check('restart: an answer to the old generation is dropped', !staleRequest.live() && ![...fake.responses.keys()].length)
  void fake.request('item/commandExecution/requestApproval', { threadId: 'T1', itemId: 'f' })
  await tick()
  check('restart: request ids restart, keys carry the new generation', sink.requests.at(-1)?.key === 'codex:2:0')

  // Every restart fails its handshake: three attempts, then permanent.
  fake.on('initialize', () => { throw new FakeRpcError(-32603, 'broken') })
  fake.crash({ code: 1 })
  await tick()
  for (const delay of [500, 2000, 5000]) {
    clock.advance(delay)
    await tick()
    await tick()
  }
  await tick()
  check('restart budget: three failed restarts end permanently', hub.state === 'failed' && sink.lost.at(-1)?.permanent === true && fake.spawns.length === 5, { state: hub.state, spawns: fake.spawns.length, lost: sink.lost })
  await hub.close()
}

// ── first handshake fails ───────────────────────────────────────────────
{
  const fake = createFakeAppServer({ initialize: false })
  fake.on('initialize', () => { throw new FakeRpcError(-32603, 'cannot start') })
  const hub = createCodexHub(SETTINGS, { transportFactory: fake.transportFactory, clock: manualClock() })
  const error = await hub.ready.catch((caught: unknown) => caught as Error)
  check('first handshake failure: ready rejects, no restart', error instanceof Error && error.message === 'cannot start' && fake.spawns.length === 1)
  await hub.close()
}

// ── hub diagnostics fan out, including startup replay ──────────────────
{
  const fake = createFakeAppServer()
  const hub = createCodexHub(SETTINGS, { transportFactory: fake.transportFactory })
  fake.stderr('bubblewrap is missing')
  await hub.ready
  const first = recorder()
  const second = recorder()
  hub.attach('FIRST', first.sink)
  const detach = hub.attach('SECOND', second.sink)
  check('diagnostics: startup stderr replays to every attach', first.diagnostics[0]?.message === 'bubblewrap is missing' && second.diagnostics[0]?.message === 'bubblewrap is missing')
  fake.raw('not-json')
  fake.stderr('later stderr')
  check('diagnostics: debug and stderr broadcast to all attached sessions', first.diagnostics.some(entry => entry.kind === 'debug' && entry.message.includes('not JSON')) && JSON.stringify(first.diagnostics) === JSON.stringify(second.diagnostics))
  detach()
  const detachedCount = second.diagnostics.length
  fake.stderr('after detach')
  check('diagnostics: detach stops future broadcasts', second.diagnostics.length === detachedCount && first.diagnostics.at(-1)?.message === 'after detach')
  for (let i = 0; i < 205; i += 1) fake.stderr('bounded-' + i)
  check('diagnostics: hub history is bounded at 200 entries', hub.diagnostics.length === 200 && hub.diagnostics[0]?.message === 'bounded-5')
  const third = recorder()
  hub.attach('THIRD', { ...third.sink, diagnostic: () => { throw new Error('listener failed') } })
  fake.stderr('survives listener failure')
  check('diagnostics: one failing sink does not prevent another', first.diagnostics.at(-1)?.message === 'survives listener failure')
  await hub.close()
}

// ── unknown subagent traffic resolves a cached multilevel parent chain ──
{
  const fake = createFakeAppServer()
  fake.on('thread/read', params => params.threadId === 'CHILD' ? NO_REPLY : { thread: { parentThreadId: 'ROOT' } })
  const hub = createCodexHub(SETTINGS, { transportFactory: fake.transportFactory })
  await hub.ready
  const root = recorder()
  const order: string[] = []
  hub.attach('ROOT', {
    ...root.sink,
    notification: (method, params) => { order.push('note:' + String(params.ordinal)); root.sink.notification(method, params) },
    serverRequest: request => { order.push('approval'); root.sink.serverRequest(request) },
  })
  fake.notify('item/started', { threadId: 'CHILD', ordinal: 1 })
  const answer = fake.request('item/commandExecution/requestApproval', { threadId: 'CHILD', itemId: 'exec' })
  fake.notify('item/completed', { threadId: 'CHILD', ordinal: 2 })
  const read = await fake.waitForRequest('thread/read')
  check('fallback: lookup excludes turns and deduplicates concurrent child traffic', read.params.includeTurns === false && fake.requests.filter(entry => entry.method === 'thread/read').length === 1)
  check('fallback: notifications and approval stay buffered during lookup', root.notes.length === 0 && root.requests.length === 0 && fake.responses.size === 0)
  fake.reply(read.id, { thread: { parentThreadId: 'MIDDLE' } })
  await tick()
  check('fallback: child-first traffic reaches its attached root in arrival order', order.join(',') === 'note:1,approval,note:2')
  check('fallback: a two-level parent chain is resolved without activity notifications', fake.requests.filter(entry => entry.method === 'thread/read').map(entry => entry.params.threadId).join(',') === 'CHILD,MIDDLE')
  root.requests[0]!.respond({ decision: 'accept' })
  check('fallback: buffered approval is answered by the root session', (await answer).result !== undefined)
  fake.notify('item/completed', { threadId: 'CHILD', ordinal: 3 })
  check('fallback: later child traffic reuses cached parents', order.at(-1) === 'note:3' && fake.requests.filter(entry => entry.method === 'thread/read').length === 2)
  await hub.close()
}

// ── explicit routes can win a lookup; overflow sheds only notifications ─
{
  const fake = createFakeAppServer()
  fake.on('thread/read', () => NO_REPLY)
  const hub = createCodexHub(SETTINGS, { transportFactory: fake.transportFactory })
  await hub.ready
  const root = recorder()
  const order: (number | string)[] = []
  hub.attach('ROOT', {
    ...root.sink,
    notification: (_method, params) => { order.push(Number(params.ordinal)) },
    serverRequest: request => { order.push('approval'); root.sink.serverRequest(request) },
  })
  fake.notify('item/started', { threadId: 'CHILD', ordinal: 0 })
  const answer = fake.request('item/commandExecution/requestApproval', { threadId: 'CHILD', itemId: 'exec' })
  for (let ordinal = 1; ordinal <= 1001; ordinal += 1) fake.notify('item/completed', { threadId: 'CHILD', ordinal })
  const read = await fake.waitForRequest('thread/read')
  check('buffer: overflow never rejects a pending approval', fake.responses.size === 0 && hub.diagnostics.some(entry => entry.message.includes('buffer overflow')))
  hub.route('CHILD', 'ROOT')
  check('buffer: explicit parent registration flushes without waiting for read', order.length === 1000 && order[0] === 'approval' && order[1] === 3 && order.at(-1) === 1001)
  root.requests[0]!.respond({ decision: 'accept' })
  await answer
  fake.reply(read.id, { thread: { parentThreadId: null } })
  await tick()
  check('buffer: a late lookup does not replay already-flushed traffic', order.length === 1000)
  await hub.close()
}

// ── true orphans, cyclic ancestry, and lookup timeout ───────────────────
{
  const fake = createFakeAppServer()
  const clock = manualClock()
  fake.on('thread/read', params => params.threadId === 'SLOW' ? NO_REPLY : { thread: { parentThreadId: params.threadId === 'A' ? 'B' : 'A' } })
  const hub = createCodexHub(SETTINGS, { transportFactory: fake.transportFactory, clock })
  await hub.ready
  const warnings: string[] = []
  hub.onGlobal((method, params) => { if (method === 'warning') warnings.push(String(params.message)) })
  const orphan = await fake.request('item/commandExecution/requestApproval', { threadId: 'A', itemId: 'orphan' })
  check('fallback: cyclic ancestry terminates with -32603 and a warning', orphan.error?.code === -32603 && warnings.length === 1)
  const slow = fake.request('item/fileChange/requestApproval', { threadId: 'SLOW', itemId: 'slow' })
  await tick()
  const responses = fake.responses.size
  clock.advance(4999)
  await tick()
  check('fallback: unknown approvals are not immediately refused', fake.responses.size === responses)
  clock.advance(1)
  await tick()
  check('fallback: a hung parent read settles within its bounded budget', (await slow).error?.code === -32603 && warnings.length === 2)
  await hub.close()
}

// ── fingerprint registry ────────────────────────────────────────────────
{
  const fake = createFakeAppServer()
  const deps = { transportFactory: fake.transportFactory, clock: manualClock() }
  const a = acquireCodexHub(SETTINGS, deps)
  const b = acquireCodexHub({ ...SETTINGS, env: { ...SETTINGS.env, PATH: '/other' } }, deps)
  const c = acquireCodexHub({ ...SETTINGS, env: { ...SETTINGS.env, CODEX_HOME: '/elsewhere' } }, deps)
  check('fingerprint: an irrelevant env change shares the hub', a === b)
  check('fingerprint: a Codex-relevant env change gets its own hub', a !== c && hubFingerprint(SETTINGS) !== hubFingerprint({ ...SETTINGS, args: ['app-server', '-c', 'x=1'] }))
  check('fingerprint: credential modes and injected private env do not collide', hubFingerprint(SETTINGS) !== hubFingerprint({ ...SETTINGS, credentialMode: 'external' }) && hubFingerprint({ ...SETTINGS, injectedEnvKeys: ['CUSTOM_HEADER'], env: { CUSTOM_HEADER: 'a' } }) !== hubFingerprint({ ...SETTINGS, injectedEnvKeys: ['CUSTOM_HEADER'], env: { CUSTOM_HEADER: 'b' } }))
  await a.close()
  const d = acquireCodexHub(SETTINGS, deps)
  check('fingerprint: a closed hub is replaced', d !== a && d.state !== 'closed')
  await closeAllCodexHubs()
  check('closeAllCodexHubs closes every hub', d.state === 'closed' && c.state === 'closed')
}

console.log(`\nverify-codex-hub OK (${passed} checks)`)
