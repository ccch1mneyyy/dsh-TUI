/** V3 adapter regressions against real Session, JSONL and CommandRuntime APIs.
 * Run: node --import tsx/esm scripts/verify-session-v3.ts
 * All files and preferences are isolated under a disposable temporary root.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createSystemMessage, createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { settled } from './lib/term-test.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-v3-'))
process.env.HOME = root
process.env.USERPROFILE = root
process.env.DSH_HOME = join(root, 'home')
process.env.DSH_TUI_SESSION_ROOT = join(root, 'fallback')
const cwd = join(root, 'project')
const noop = () => undefined
const { createChannelProjection } = await import('../src/dsh-adapter/channel/projection.js')
const { createInitialChannelView } = await import('../src/dsh-adapter/channel/state.js')
const { createSessionMetadataActions } = await import('../src/dsh-adapter/channel/session-metadata.js')
const { createSessionTreeReader } = await import('../src/dsh-adapter/channel/session-tree.js')
const { createTreeRewindAction } = await import('../src/dsh-adapter/channel/session-tree-actions.js')
const { createExternalCommandInvoker } = await import('../src/dsh-adapter/channel/external-commands.js')
const { createChannelOwner } = await import('../src/dsh-adapter/channel/owner.js')
const { foldRows, foldBack } = await import('../src/dsh-adapter/channel/transcript.js')
const { readPersistedSession } = await import('../src/dsh-adapter/compat/persistence.js')
const { readPhysicalHeaderSeedLength } = await import('../src/dsh-adapter/compat/sessionLog.js')
const { resolvePersistedPreset, resolvePersistedRoute } = await import('../src/dsh-adapter/presets.js')
const { enumerateSessions, locateSession } = await import('../src/dsh-adapter/sessions/list.js')
const { flattenTree } = await import('../src/dsh-adapter/sessionTree.js')
const { SubagentActivityStore } = await import('../src/dsh-adapter/subagents.js')

function session(id: string, parent?: Session) {
  const seed = parent?.snapshotEvents() ?? []
  return Session.create(SessionId(id), seed, {
    version: 3, id: SessionId(id), createdAt: 1, cwd, agentPreset: 'liangshen', isSeeded: parent !== undefined,
    ...(parent === undefined ? {} : { parentSession: parent.id, isSeeded: true }),
  }, SessionLogOffset(seed.length))
}
function prompt(s: Session, text = 'question') {
  return s.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}
function answer(s: Session, text: string, reasoning = '', step = 1) {
  return s.append('assistant/message', {
    turn: 1, step, stream: [],
    message: createAssistantMessage({ provider: 'deepseek', model: 'model', content: [
      ...(reasoning ? [{ type: 'reasoning' as const, text: reasoning }] : []),
      ...(text ? [{ type: 'text' as const, text }] : []),
    ] }),
  }, { surfaceOp: 'append' })
}
function projection(s: Session) {
  const state = { ...createInitialChannelView({ model: 'model', provider: 'deepseek', cwd }, {
    agentId: String(s.id), mode: { id: 'normal', name: 'Normal' } as never, cwdDescription: cwd,
  }), emit: noop }
  const projector = createChannelProjection(state, {
    agent: () => ({ session: s }) as never, rowIds: { value: 0 }, resetContextWarning: noop,
    pendingTaskDescriptions: [], jobs: { onOutputSeen: noop, onStarted: noop },
    inputConvergence: { cancelInFlight: false }, checkContextWarning: noop, notify: noop,
    attachments: noop,
  })
  let revision = 0
  let index = 0
  const start = (attemptId = 'attempt') => {
    index = 0
    projector.renderStreamFrame({ type: 'start', attemptId, turn: 1, step: 1, revision: ++revision } as never)
  }
  const chunk = (type: 'text-delta' | 'reasoning-delta', text: string, attemptId = 'attempt') =>
    projector.renderStreamFrame({ type: 'chunk', attemptId, revision: ++revision, index: index++, time: 1000 + revision,
      chunk: { type, text, index: 0 } } as never)
  const end = (outcome: unknown, attemptId = 'attempt') =>
    projector.renderStreamFrame({ type: 'end', attemptId, revision: ++revision, index, outcome } as never)
  return { state, projector, start, chunk, end }
}

try {
  for (const kind of ['text-delta', 'reasoning-delta'] as const) {
    const p = projection(session(`repeated-${kind}`))
    p.start()
    const deltas = ['ha', 'ha', ' ', ' ', 'echo', 'echo again', '\n', '\n']
    for (const delta of deltas) p.chunk(kind, delta)
    assert.equal(p.state.rows[0]?.text, deltas.join(''), 'distinct V3 frames preserve repeated tokens and whitespace')
    const duplicate = { type: 'chunk', attemptId: 'attempt', revision: 20, index: 10, time: 2000,
      chunk: { type: kind, text: 'tail', index: 0 } } as never
    p.projector.renderStreamFrame(duplicate)
    p.projector.renderStreamFrame(duplicate)
    assert.equal(p.state.rows[0]?.text, deltas.join('') + 'tail', 'duplicate V3 frames deduplicate by revision, not text')
  }
  for (const thinkingFold of ['preview', 'full'] as const) {
    const s = session(`anchors-${thinkingFold}`)
    const p = projection(s)
    p.state.thinkingFold = thinkingFold
    p.start()
    p.chunk('reasoning-delta', 'R'.repeat(450))
    p.chunk('text-delta', 'A'.repeat(450))
    const event = answer(s, 'A'.repeat(450), 'R'.repeat(450))
    p.projector.renderEvent(event)
    p.end({ kind: 'committed', eventType: 'assistant/message', seq: event.seq })
    p.projector.settleStreaming()
    assert.equal(p.state.rows.length, 2)
    assert.ok(p.state.rows.every(row => row.seq === event.seq), 'all live rows gain durable anchors')
    foldRows(p.state.rows, 0)
    assert.equal(p.state.rows[0]!.text.length, 201)
    assert.equal(foldBack(p.state.rows, s.snapshotEvents()), 2)
    assert.ok(p.state.rows.every(row => row.text.length === 450), 'both folded bodies restore fully')
  }
  {
    const s = session('canonical-empty')
    const p = projection(s)
    p.start()
    p.chunk('reasoning-delta', 'provisional thinking')
    p.chunk('text-delta', 'provisional text')
    p.projector.renderEvent(answer(s, ''))
    assert.equal(p.state.rows.length, 0, 'V3 settlement removes provisional content omitted from the canonical message')
  }
  for (const abandonment of [false, true]) {
    const s = session(`failure-${abandonment}`)
    const p = projection(s)
    p.start('failed')
    p.chunk('reasoning-delta', 'failed thinking', 'failed')
    p.chunk('text-delta', 'failed text', 'failed')
    if (abandonment) p.end({ kind: 'abandoned' }, 'failed')
    else {
      const event = s.append('assistant/attempt', { turn: 1, step: 1, stream: [] })
      p.projector.renderEvent(event)
      p.end({ kind: 'committed', eventType: 'assistant/attempt', seq: event.seq }, 'failed')
    }
    assert.equal(p.state.rows.length, 0, 'failed and abandoned attempts leave no transcript facts')
    p.start('retry')
    const event = s.append('assistant/message', { turn: 1, step: 1, stream: [],
      message: createAssistantMessage({ provider: 'deepseek', model: 'model', content: [
        { type: 'tool-call', id: 'call' as never, name: 'read', arguments: '{}' },
      ] }),
    }, { surfaceOp: 'append' })
    p.projector.renderEvent(event)
    assert.equal(p.state.rows.length, 0, 'tool-only retry cannot retain prior text')
    const replay = projection(s)
    replay.projector.replayEvents(s.snapshotEvents())
    assert.deepEqual(p.state.rows, replay.state.rows)
  }
  {
    const s = session('reattach')
    s.append('turn/start', { turn: 1 })
    s.append('step/start', { turn: 1, step: 1 })
    const p = projection(s)
    p.start()
    p.chunk('reasoning-delta', 'before detach')
    p.projector.reset()
    p.state.rows = []
    p.projector.replayEvents(s.snapshotEvents())
    p.projector.settleStreaming()
    p.chunk('text-delta', 'after attach')
    assert.equal(p.state.rows[0]?.text, 'after attach', 'open replay step accepts chunks without a start frame')
    const event = answer(s, 'complete answer after attach', 'complete thinking')
    p.projector.renderEvent(event)
    assert.deepEqual(p.state.rows.map(row => [row.kind, row.text, row.seq]), [
      ['reasoning', 'complete thinking', event.seq], ['assistant', 'complete answer after attach', event.seq],
    ])
  }
  console.log('PASS V3 anchors, failed attempts, reattachment and canonical settlement')

  {
    const s = session('child-stream')
    const store = new SubagentActivityStore()
    const id = 'child'
    store.onSpawned(id)
    store.appendOutput(id, 'previous output')
    store.flushOutput(id)
    let revision = 0
    const start = (attemptId: string) => store.onStreamFrame(id, { type: 'start', attemptId, revision: ++revision, turn: 1, step: 1 } as never)
    const chunk = (attemptId: string, text: string) => {
      const frame = { type: 'chunk', attemptId, revision: ++revision, index: revision, time: revision, chunk: { type: 'text-delta', text, index: 0 } } as never
      store.onStreamFrame(id, frame)
      return frame
    }
    start('failed')
    for (let i = 0; i < 170; i++) chunk('failed', `failed-${i}\n`)
    store.onSessionEvent(id, s.append('assistant/attempt', { turn: 1, step: 1, stream: [] }))
    assert.deepEqual(store.get(id)?.output, ['previous output'], 'failed child attempt restores the bounded pre-attempt tail')
    start('retry')
    const delta = chunk('retry', 'partial')
    store.onStreamFrame(id, delta)
    assert.deepEqual(store.get(id)?.output, ['previous output', 'partial'], 'child frame revision rejects redelivery')
    store.onSessionEvent(id, answer(s, 'canonical child reply', 'canonical child thinking'))
    const settledOutput = ['previous output', 'canonical child thinking', 'canonical child reply']
    assert.deepEqual(store.get(id)?.output, settledOutput, 'child settlement replaces provisional output with canonical blocks')
    start('abandoned')
    chunk('abandoned', 'abandoned output')
    store.onStreamFrame(id, { type: 'end', attemptId: 'abandoned', revision: ++revision, index: 1, outcome: { kind: 'abandoned' } } as never)
    assert.deepEqual(store.get(id)?.output, settledOutput)
    assert.ok(store.get(id)?.outputEvents.every(line => line.settled), 'child attempts do not merge across settlements')
    start('cancelled')
    chunk('cancelled', 'uncommitted')
    store.onCancelled(id)
    assert.deepEqual(store.get(id)?.output, settledOutput)
    store.reset()
    store.onSpawned(id)
    store.onStreamFrame(id, { type: 'chunk', attemptId: 'new', revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', text: 'new session', index: 0 } } as never)
    assert.deepEqual(store.get(id)?.output, ['new session'], 'child reset clears attempt revisions')
  }
  console.log('PASS child V3 failed attempts, canonical settlement, redelivery and lifecycle cleanup')

  const ctx = new Context()
  const plugin = ctx.plugin(JsonlSessionPersistence, { root: join(root, 'jsonl'), compression: 'none' })
  try {
    assert.ok(await settled(() => ctx.get('sessionPersistence') !== undefined))
    const store = ctx.sessionPersistence
    const parent = session('parent')
    prompt(parent, 'parent prompt')
    const child = session('child', parent)
    prompt(child, 'child prompt')
    const grandchild = session('grandchild', child)
    prompt(grandchild, 'grandchild prompt')
    grandchild.append('request/header', { reason: 'initial', header: { config: { provider: 'deepseek', model: 'saved-model' } } })
    for (const s of [parent, child, grandchild]) {
      const writer = await store.create(s.header, { inheritedEventCount: s.inheritedEventCount })
      try { await writer.append(s.snapshotEvents()); await writer.flush() }
      finally { await writer.close() }
    }
    assert.equal(await resolvePersistedPreset(ctx, grandchild.id), 'liangshen')
    assert.deepEqual(await resolvePersistedRoute(ctx, grandchild.id), { provider: 'deepseek', model: 'saved-model' })
    const grandchildPath = await locateSession(store as never, String(grandchild.id))
    assert.ok(grandchildPath)
    assert.equal(readPhysicalHeaderSeedLength(grandchildPath), child.seq, 'last inherited marker owns the fork cut')
    const owner = createChannelOwner()
    const agent = { id: grandchild.id, session: grandchild, status: 'idle' }
    const tree = await createSessionTreeReader(ctx, { agent } as never, () => cwd, noop, owner)()
    assert.ok(tree)
    const texts = flattenTree(tree.roots, tree.activeLeafId).map(row => row.node.entry?.text)
    for (const text of ['parent prompt', 'child prompt', 'grandchild prompt']) {
      assert.equal(texts.filter(value => value === text).length, 1, `snapshot listing keeps ${text} exactly once`)
    }
    let closed = 0
    for (const fail of [false, true]) {
      const read = readPersistedSession({ open: async (_id, access) => {
        assert.equal(access, 'read')
        return { header: parent.header, read: async () => {
          if (fail) throw new Error('read failed')
          return { events: parent.snapshotEvents() }
        }, close: async () => { closed++ } }
      } }, parent.id)
      if (fail) await assert.rejects(read, /read failed/)
      else assert.equal((await read).meta.agentPreset, 'liangshen')
    }
    assert.equal(closed, 2, 'handles close on success and failure')
    assert.equal((await readPersistedSession({ load: async () => ({ meta: parent.header, events: parent.snapshotEvents() }) }, parent.id)).meta.id, parent.id)
    for (const raw of [parent.header, { header: parent.header, revision: 'r', sizeBytes: 1 }]) {
      assert.equal((await enumerateSessions({ list: async () => [raw] }))[0]?.header.id, parent.id)
    }

    // Exercise the foreign-session tree action against the real handle backend.
    let prepared = false
    const capture = { agent, generation: 1 }
    const rewind = createTreeRewindAction({ get: (key: string) => key === 'sessionPersistence' ? store : key === 'agents' ? {
      create: async () => { throw new Error('unused by binding fixture') },
    } : undefined } as never, { working: false, cwd, provider: 'deepseek', model: 'model' }, {
      owner, binding: { agent, capture: () => capture, isCurrent: () => true,
        prepare: async (_capture: unknown, _create: unknown) => { prepared = true; return { agent } }, abandon: async () => {} } as never,
      settleCompaction: async () => {}, notify: noop, adoptForkedAgent: () => 'child', notifySessionSwitched: noop,
    })
    assert.equal(await rewind(String(child.id), child.seq - 1, 'fork'), '')
    assert.equal(prepared, true, 'cross-session fork reads through handle API')
    owner.dispose()
  } finally { await plugin.dispose() }

  {
    const dir = join(root, 'custom', 'ws', 'legacy')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, JSON.stringify({ type: 'session', version: 0, id: 'legacy', createdAt: 1 }) + '\n')
    const source = { list: async () => [{ header: { id: 'legacy', version: 0, createdAt: 1 } }],
      locate: () => ({ path: join(dir, 'session.v3.jsonl') }) }
    assert.equal(await locateSession(source, 'legacy'), path, 'generation fallback stays inside custom locate directory')
    source.locate = () => ({ path: join(root, 'missing', 'session.v3.jsonl') })
    const alternate = join(process.env.DSH_TUI_SESSION_ROOT!, 'ws', 'legacy')
    mkdirSync(alternate, { recursive: true })
    writeFileSync(join(alternate, 'session.jsonl.zstd'), 'not authoritative')
    assert.equal(await locateSession(source, 'legacy'), undefined, 'missing authoritative path never falls through to duplicate IDs')
  }
  console.log('PASS handle reads, session tree, repeated forks, custom roots and legacy list shapes')

  {
    const s = session('system')
    const head = s.append('system/message', { turn: 1, step: 1, message: createSystemMessage('ORIGINAL_SYSTEM', 'fixture') }, { surfaceOp: 'append' })
    prompt(s)
    const requests: { system?: string; messages: Message[] }[] = []
    const owner = createChannelOwner()
    const agent = { session: s }
    const actions = createSessionMetadataActions({ get: () => ({ stream: async function * (request: typeof requests[number]) {
      requests.push(request)
      yield { type: 'text-delta', index: 0, text: '{"summary":"summary"}' }
      yield { type: 'step-end', reason: 'stop' }
    } }) } as never, {
      owner, binding: { agent, capture: () => ({ agent, generation: 1 }), isCurrent: () => true } as never,
      provider: () => 'deepseek', model: () => 'model', emit: noop, sessionTitle: () => '',
      setSessionTitle: noop, setSessionColor: noop, forgetAgentView: noop, setPersistedSessions: noop,
      skillRegistryFor: noop, skillViewOptions: () => ({ scope: agent, cwd }) as never,
    })
    await actions.sideQuestion('question')
    assert.equal(requests.at(-1)?.system, undefined)
    assert.equal(requests.at(-1)?.messages.filter(message => message.role === 'system').length, 1)
    await actions.recapRecent()
    assert.equal(requests.at(-1)?.system, 'ORIGINAL_SYSTEM')
    s.append('system/message', { turn: 1, step: 1, message: createSystemMessage('', 'fixture') }, {
      surfaceOp: { op: 'replace', startSeq: head.seq, endSeq: head.seq },
      sourceEventSeqs: [head.seq],
    })
    await actions.sideQuestion('after clear')
    assert.equal(requests.at(-1)?.system, undefined)
    assert.equal(requests.at(-1)?.messages.filter(message => message.role === 'system').length, 0)
    await actions.recapRecent()
    assert.equal(requests.at(-1)?.system, undefined, 'recap must not revive replaced system text')
    s.append('system/message', { turn: 1, step: 2, message: createSystemMessage('NEW_SYSTEM', 'fixture') }, { surfaceOp: 'append' })
    s.append('system/message', { turn: 1, step: 3, message: createSystemMessage('LATEST_SYSTEM', 'fixture') }, { surfaceOp: 'append' })
    await actions.recapRecent()
    assert.equal(requests.at(-1)?.system, 'LATEST_SYSTEM', 'recap uses the latest effective system node, not concatenated prompt history')
    owner.dispose()
  }
  console.log('PASS system prompt deduplication and surface clearing')

  {
    const ctx = new Context()
    const commands = new CommandRuntime(ctx)
    const s = session('command')
    const agent = { id: s.id, session: s, ctx }
    const ref = { id: 'image', mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 'image.png' }
    const store = { imageLimits: { maxImageBytes: 1024, maxMessageImageBytes: 1024, maxImagesPerMessage: 4, mediaTypes: ['image/png'] },
      readImage: async () => ({ data: new Uint8Array([1]) }), saveImages: async () => [ref] }
    ctx.provide('attachments', store)
    let received: readonly unknown[] = []
    const dispose = commands.register({ name: 'photo', description: 'Photo', input: { hint: 'image', attachments: true },
      handler: ({ attachments }) => { received = attachments; return { kind: 'success' } },
    })
    const invoker = createExternalCommandInvoker(ctx, {
      commandService: commands, runtime: { mode: 'legacy', slices: [] }, agent: () => agent as never,
      capture: () => 1, bindingCurrent: () => true, allows: () => true, notify: noop,
      composer: { snapshot: () => new Map([['stage', ref]]), includeLegacyImageRefs: (_text: string, images: unknown) => images } as never,
      attachments: () => store as never,
    })
    const result = await invoker.invoke('photo', ' [Image #1]', [{ token: '[Image #1]', stageId: 'stage' }])
    assert.equal(result?.kind, 'success', result?.text)
    assert.deepEqual(received, [{ type: 'image', attachment: ref }])
    dispose()
  }
  console.log('PASS real CommandRuntime image submission')
} finally {
  rmSync(root, { recursive: true, force: true })
}
