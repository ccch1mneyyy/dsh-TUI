/** Historical JSONL -> V3 tree -> real fork-constructor coordinate regression.
 * Run: node --import tsx/esm scripts/verify-session-tree-generations.ts
 * Uses disposable histories only; no model requests or local profile writes.
 */
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset, interruptedTurnClosers, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Session as LegacySession } from '../vendor/sqlite-island/index.js'
import { settled } from './lib/term-test.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-tree-generations-'))
process.env.HOME = root
process.env.USERPROFILE = root
process.env.DSH_HOME = join(root, 'home')
const { createSessionTreeReader } = await import('../src/dsh-adapter/channel/session-tree.js')
const { createTreeRewindAction } = await import('../src/dsh-adapter/channel/session-tree-actions.js')
const { createChannelOwner } = await import('../src/dsh-adapter/channel/owner.js')
const { flattenTree } = await import('../src/dsh-adapter/sessionTree.js')
const { readPersistedSession } = await import('../src/dsh-adapter/compat/persistence.js')

const ctx = new Context()
const plugin = ctx.plugin(Jsonl, { root: join(root, 'store'), compression: 'none' })
const owner = createChannelOwner()
const noop = () => undefined
try {
  assert.ok(await settled(() => ctx.get('sessionPersistence') !== undefined))
  const legacy = LegacySession.create('legacy', [], { id: 'legacy', version: 0, createdAt: 1, cwd: root, delegationDepth: 0 })
  for (const turn of [1, 2]) {
    legacy.append('turn/start', { turn })
    legacy.append('step/start', { turn, step: 1 })
    legacy.append('user/message', { id: `u${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `prompt${turn}` }] }, { surfaceOp: 'append' })
    const chunk = legacy.append('assistant/chunk', { turn, step: 1, chunk: { type: 'text-delta', index: 0, text: `answer${turn}` } })
    legacy.append('assistant/message', { turn, step: 1, message: {
      id: `a${turn}`, role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'model' },
      content: [{ type: 'text', text: `answer${turn}` }],
    } }, { surfaceOp: 'append', sourceEventSeqs: [chunk.seq] })
    legacy.append('step/end', { turn, step: 1 })
    legacy.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const prefix = legacy.events.slice(0, legacy.events.findIndex(event => event.type === 'turn/start' && event.data.turn === 2))
  const branch = LegacySession.create('legacy-branch', prefix, {
    ...legacy.header, id: 'legacy-branch', parentSession: legacy.id, seedLength: prefix.length,
  })
  const sourceFiles: { path: string; bytes: Buffer }[] = []
  for (const stored of [legacy, branch]) {
    const location = (ctx.sessionPersistence as unknown as { locate(meta: unknown): { path: string } }).locate(stored.header)
    mkdirSync(dirname(location.path), { recursive: true })
    const path = join(dirname(location.path), 'session.jsonl')
    const bytes = Buffer.from([{ type: 'session', ...stored.header }, ...stored.events].map(record => JSON.stringify(record)).join('\n') + '\n')
    writeFileSync(path, bytes)
    sourceFiles.push({ path, bytes })
  }
  const restored = await readPersistedSession(ctx.sessionPersistence, SessionId('legacy-branch'))
  const live = Session.create(SessionId('current'), restored.events, {
    ...restored.meta, id: SessionId('current'), parentSession: SessionId('legacy-branch'), isSeeded: true,
  }, SessionLogOffset(restored.events.length))
  const agent = { id: live.id, session: live, status: 'idle' }
  const tree = await createSessionTreeReader(ctx, { agent } as never, () => root, noop, owner)()
  assert.ok(tree)
  const entries = flattenTree(tree.roots, tree.activeLeafId).flatMap(row => row.node.entry ? [row.node.entry] : [])
  const selected = entries.find(entry => entry.text === 'prompt1')!
  assert.ok(selected)
  const loaded = await readPersistedSession(ctx.sessionPersistence, SessionId('legacy'))
  const rawPrompt = legacy.events.find(event => event.type === 'user/message')!
  assert.notEqual(selected.seq, rawPrompt.seq, 'fixture must cross a sequence-changing migration')
  assert.equal(loaded.events[selected.seq]?.type, 'user/message', 'tree selection and handle read share canonical coordinates')
  assert.equal(entries.filter(entry => entry.text === 'prompt1').length, 1, 'mixed-generation family deduplicates inherited messages')
  assert.equal(entries.filter(entry => entry.text === 'answer1').length, 1)

  let created: Session | undefined
  let replayed: readonly SessionEvent[] = []
  const capture = { agent, generation: 1 }
  const agents = { create: async (options: CreateAgentOptions) => {
    const child = Session.create(options.sessionId, options.seed, {
      version: 3, id: options.sessionId, createdAt: 1, isSeeded: options.meta?.isSeeded ?? false, ...options.meta,
    }, options.inheritedEventCount)
    const childAgent = { id: child.id, session: child, status: 'idle' }
    const setup = await options.setup?.(ctx, childAgent as never)
    setup?.commit()
    created = child
    return { agent: childAgent, dispose: async () => {} }
  } }
  const action = createTreeRewindAction({ get: (key: string) => key === 'agents' ? agents : ctx.get(key) } as never,
    { working: false, cwd: root, provider: 'deepseek', model: 'model' }, {
      owner, binding: { agent, capture: () => capture, isCurrent: () => true, prepare: (_capture: unknown, create: () => unknown) => create(), abandon: async () => {} } as never,
      settleCompaction: async () => {}, notify: noop,
      adoptForkedAgent: (_handle, _capture, seed) => { replayed = seed; return 'legacy' }, notifySessionSwitched: noop,
    })
  assert.equal(await action(selected.sessionId, selected.seq, 'fork'), '')
  assert.ok(created, 'real V3 constructor accepts a partial-turn fork')
  assert.equal(created.inheritedEventCount, selected.seq + 1, 'fork cut remains the exact inherited prefix')
  assert.deepEqual(created.deriveMessages().filter(message => message.role !== 'system').map(message => message.content[0]), [
    { type: 'text', text: 'prompt1' },
  ], 'forking a user entry must not keep its answer')
  assert.deepEqual(created.ownEvents().map(event => event.type), ['session/end-seed', 'step/end', 'turn/end'])
  assert.equal(interruptedTurnClosers(created.snapshotEvents()).length, 0, 'child is balanced before publication')
  assert.deepEqual(replayed, created.snapshotEvents(), 'adoption replays the actual child-owned closure events')
  const secondPrompt = entries.find(entry => entry.text === 'prompt2')!
  assert.equal(await action(secondPrompt.sessionId, secondPrompt.seq, 'rewind'), 'prompt2')
  assert.deepEqual(created.deriveMessages().filter(message => message.role !== 'system').map(message => message.content[0]), [
    { type: 'text', text: 'prompt1' }, { type: 'text', text: 'answer1' },
  ], 'rewind drops the selected user turn in canonical coordinates')
  for (const { path, bytes } of sourceFiles) assert.deepEqual(readFileSync(path), bytes, 'tree browsing and forking never rewrite old source logs')
  console.log('PASS mixed-generation tree anchors, inherited cuts, real V3 fork closure and rewind')

  const limitedPath = join(root, 'limited.jsonl')
  const limitedHeader = { type: 'session', version: 0, id: 'limited', createdAt: 1, cwd: root }
  const limitedLive = Session.create(SessionId('limited-child'), [], {
    ...live.header, id: SessionId('limited-child'), parentSession: SessionId('limited'), isSeeded: true,
  }, SessionLogOffset(0))
  let opened = 0
  let closed = 0
  const boundedSource = {
    list: async () => [{ header: { ...limitedHeader, version: 3 } }],
    locate: () => ({ kind: 'jsonl', path: limitedPath }),
    open: async () => {
      opened++
      return { header: { ...limitedHeader, version: 3 }, inheritedEventCount: 0,
        read: async () => { throw new Error('unsupported historical type') }, close: async () => { closed++ } }
    },
  }
  const limitedReader = createSessionTreeReader({ get: () => boundedSource } as never,
    { agent: { session: limitedLive } } as never, () => root, noop, owner)
  writeFileSync(limitedPath, JSON.stringify(limitedHeader) + '\n{broken}\n')
  const corruptTree = await limitedReader()
  assert.equal(opened, 0, 'corrupt raw logs must not escalate to a full handle parse')
  assert.equal(corruptTree?.sessions.get('limited')?.unreadable, true)
  writeFileSync(limitedPath, JSON.stringify(limitedHeader) + '\n')
  const limitedTree = await limitedReader()
  assert.equal(opened, 1)
  assert.equal(closed, 1, 'failed historical handle reads close their handle')
  assert.equal(limitedTree?.sessions.get('limited')?.unreadable, true)
  assert.ok(flattenTree(limitedTree!.roots, limitedTree!.activeLeafId).every(row => row.node.sessionId !== 'limited' || row.node.entry === null))

  let batch = ''
  for (let seq = 0; seq <= 200_000; seq++) {
    batch += JSON.stringify({ type: 'session/title', seq, time: 1, data: { title: 'budget' } }) + '\n'
    if (seq % 1000 === 999 || seq === 200_000) { appendFileSync(limitedPath, batch); batch = '' }
  }
  const overBudget = await limitedReader()
  assert.equal(opened, 1, 'truncated historical logs must not escalate to a full handle parse')
  assert.equal(overBudget?.truncated, true)
  assert.equal(overBudget?.sessions.get('limited')?.unreadable, true)
  console.log('PASS corrupt, unsupported and over-budget historical trees stay non-actionable without unbounded retry')
} finally {
  owner.dispose()
  await plugin.dispose()
  rmSync(root, { recursive: true, force: true })
}
