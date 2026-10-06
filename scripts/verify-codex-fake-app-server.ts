/**
 * Self-test of the fake Codex app-server (scripts/lib/codex-fake-app-server.ts,
 * docs/codex-backend-design.md §10.1) through a minimal JSON-RPC client
 * written here, independent of the backend's own rpc layer: scripted
 * answers, errors, deferred replies, server requests waiting for the
 * client, crash reporting, and the replay of a recorded wire fixture
 * (id mapping, thread remapping, approvals waiting for the client's answer,
 * two interleaved replays keeping their own order).
 *
 * Run: node --import tsx/esm scripts/verify-codex-fake-app-server.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TransportExit } from '../src/backends/codex/rpc/transport.js'
import { createFakeAppServer, FakeRpcError, NO_REPLY, parseWire } from './lib/codex-fake-app-server.js'

type Rec = Record<string, unknown>
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

/** A tiny client: requests by id, notifications and server requests logged. */
function client(fake: ReturnType<typeof createFakeAppServer>, onServerRequest?: (message: Rec) => unknown) {
  const pending = new Map<number, (message: Rec) => void>()
  const inbox: Rec[] = []
  const exits: TransportExit[] = []
  let nextId = 1
  const transport = fake.transportFactory({
    executable: 'codex',
    args: ['app-server'],
    env: {},
    cwd: '/TMP/cwd',
    onLine: line => {
      let message: Rec
      try {
        message = JSON.parse(line) as Rec
      } catch {
        inbox.push({ raw: line })
        return
      }
      if (message.method === undefined && typeof message.id === 'number') {
        pending.get(message.id)?.(message)
        pending.delete(message.id)
        return
      }
      inbox.push(message)
      if (message.id !== undefined && onServerRequest !== undefined) {
        void Promise.resolve(onServerRequest(message)).then(result => {
          if (result !== undefined) transport.write(JSON.stringify({ id: message.id, result }))
        })
      }
    },
    onStderr: line => inbox.push({ stderr: line }),
    onExit: info => exits.push(info),
  })
  return {
    transport,
    inbox,
    exits,
    call(method: string, params: Rec = {}): Promise<Rec> {
      const id = nextId++
      return new Promise(resolve => {
        pending.set(id, resolve)
        transport.write(JSON.stringify({ id, method, params }))
      })
    },
    notify(method: string): void { transport.write(JSON.stringify({ method })) },
  }
}

const tick = (ms = 5): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

// ── scripted answers ─────────────────────────────────────────────────────
{
  const fake = createFakeAppServer()
  const c = client(fake)
  const init = await c.call('initialize', { clientInfo: { name: 'x', title: null, version: '0' } })
  check('initialize: default answer', (init.result as Rec | undefined)?.platformOs === 'linux', init)
  c.notify('initialized')
  await tick()
  check('client notifications are recorded', fake.notifications.some(note => note.method === 'initialized'))
  fake.on('model/list', () => ({ data: [{ id: 'gpt-x' }] }))
  const models = await c.call('model/list', { includeHidden: false })
  check('scripted handler answers with its result', JSON.stringify(models.result) === JSON.stringify({ data: [{ id: 'gpt-x' }] }))
  check('requests are recorded with params and generation', fake.requests.some(request => request.method === 'model/list' && request.params.includeHidden === false && request.generation === 1))
  fake.on('thread/start', () => { throw new FakeRpcError(-32602, 'bad params', { field: 'cwd' }) })
  const failed = await c.call('thread/start', {})
  check('a thrown FakeRpcError is a JSON-RPC error', (failed.error as Rec | undefined)?.code === -32602 && ((failed.error as Rec).data as Rec).field === 'cwd', failed)
  const unknown = await c.call('nope/never', {})
  check('an unhandled method answers -32601', (unknown.error as Rec | undefined)?.code === -32601, unknown)
  fake.on('turn/start', (_params, request) => {
    setTimeout(() => fake.reply(request.id, { turn: { id: 't1' } }), 10)
    return NO_REPLY
  })
  const deferred = await c.call('turn/start', {})
  check('NO_REPLY defers the answer to reply()', ((deferred.result as Rec | undefined)?.turn as Rec | undefined)?.id === 't1', deferred)
  const waited = fake.waitForRequest('turn/start')
  check('waitForRequest finds an already-seen request', (await waited).method === 'turn/start')
}

// ── server requests and crash ────────────────────────────────────────────
{
  const fake = createFakeAppServer()
  const c = client(fake, message => message.method === 'item/commandExecution/requestApproval' ? { decision: 'accept' } : undefined)
  await c.call('initialize')
  const answer = await fake.request('item/commandExecution/requestApproval', { itemId: 'exec-1' })
  check('a server request resolves with the client answer', (answer.result as Rec | undefined)?.decision === 'accept', answer)
  check('the answer is recorded by server request id', (fake.responses.get(0)?.result as Rec | undefined)?.decision === 'accept')
  fake.notify('warning', { message: 'w' })
  fake.stderr('noise line')
  fake.raw('{not json')
  await tick()
  check('notify / stderr / raw reach the client', c.inbox.some(m => m.method === 'warning') && c.inbox.some(m => m.stderr === 'noise line') && c.inbox.some(m => m.raw === '{not json'))
  fake.crash({ code: 3 })
  await tick()
  check('crash reports an exit and disconnects', c.exits.length === 1 && c.exits[0]!.code === 3 && !fake.connected, c.exits)
  const again = client(fake)
  await again.call('initialize')
  check('a restart creates a second transport generation', fake.spawns.length === 2 && fake.requests.at(-1)?.generation === 2)
  await again.transport.close()
  await tick()
  check('close() ends the transport and reports exit 0', fake.closed && again.exits[0]?.code === 0)
}

// ── replay of a recorded fixture ─────────────────────────────────────────
{
  const wire = parseWire(readFileSync(join(import.meta.dirname, 'fixtures', 'codex', 'wire', 's1b-command-approval.jsonl'), 'utf8'))
  const recordedThread = (wire.find(entry => entry.dir === 'out' && entry.msg.method === 'turn/start')!.msg.params as Rec).threadId as string
  const fake = createFakeAppServer({ initialize: false })
  let approvals = 0
  const c = client(fake, message => {
    if (message.method !== 'item/commandExecution/requestApproval') return undefined
    approvals += 1
    return new Promise(resolve => setTimeout(() => resolve({ decision: 'accept' }), 20))
  })
  const replaying = fake.replay(wire, { threadMap: { [recordedThread]: 'thread-live' }, until: entry => entry.dir === 'out' && entry.msg.method === 'thread/read' })
  const init = await c.call('initialize', {})
  check('replay: the recorded initialize response answers the live id', typeof (init.result as Rec | undefined)?.userAgent === 'string')
  c.notify('initialized')
  const started = await c.call('thread/start', { cwd: '/TMP/cwd' })
  check('replay: thread ids are remapped', ((started.result as Rec).thread as Rec).id === 'thread-live', started)
  const turn = await c.call('turn/start', { threadId: 'thread-live', input: [] })
  check('replay: turn/start answered', (turn.result as Rec | undefined)?.turn !== undefined)
  await replaying
  const methods = c.inbox.flatMap(message => typeof message.method === 'string' ? [message.method] : [])
  check('replay: the approval was asked once and answered before the item completed', approvals === 1 &&
    methods.indexOf('item/commandExecution/requestApproval') < methods.indexOf('serverRequest/resolved'), methods)
  check('replay: the recorded order is kept', methods.indexOf('turn/started') < methods.lastIndexOf('item/completed') && methods.at(-1) === 'turn/completed', methods)
  check('replay: every replayed thread id is the live one', c.inbox.every(message => {
    const params = message.params as Rec | undefined
    return params?.threadId === undefined || params.threadId === 'thread-live'
  }))
}

// ── two replays on different threads interleave ─────────────────────────
{
  const wire = parseWire(readFileSync(join(import.meta.dirname, 'fixtures', 'codex', 'wire', 's3-lifecycle-p1.jsonl'), 'utf8'))
  const turnOnly = wire.filter(entry => entry.dir === 'in' && typeof entry.msg.method === 'string' && entry.msg.id === undefined && (entry.msg.params as Rec | undefined)?.threadId !== undefined)
  const recorded = (turnOnly[0]!.msg.params as Rec).threadId as string
  const fake = createFakeAppServer()
  const c = client(fake)
  await c.call('initialize')
  await Promise.all([
    fake.replay(turnOnly, { threadMap: { [recorded]: 'A' }, delayMs: 1 }),
    fake.replay(turnOnly, { threadMap: { [recorded]: 'B' }, delayMs: 1 }),
  ])
  const order = c.inbox.flatMap(message => {
    const params = message.params as Rec | undefined
    return typeof params?.threadId === 'string' ? [`${params.threadId}:${String(message.method)}`] : []
  })
  const of = (thread: string): string[] => order.filter(entry => entry.startsWith(`${thread}:`)).map(entry => entry.slice(2))
  const expected = turnOnly.map(entry => String(entry.msg.method))
  check('interleave: each thread keeps its own order', JSON.stringify(of('A')) === JSON.stringify(expected) && JSON.stringify(of('B')) === JSON.stringify(expected))
  const switches = order.slice(1).filter((entry, index) => entry[0] !== order[index]![0]).length
  check('interleave: the two threads actually interleave', switches > 2, switches)
}

console.log(`\nverify-codex-fake-app-server OK (${passed} checks)`)
