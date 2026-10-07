/** Focused Codex subagent lane, ownership and opaque history cursor gate. */
import assert from 'node:assert/strict'
import { createItemContext } from '../src/backends/codex/translate/items.js'
import { createLiveTranslator } from '../src/backends/codex/translate/live.js'
import { replayTurns } from '../src/backends/codex/translate/replay.js'
import { createProjectorHarness } from './lib/projector-harness.js'
import { loadWire, recordedTurns, turnThreads } from './lib/codex-translate-harness.js'
import type { AgentEvent } from '../src/agent/events.js'
import { createCodexSubagents } from '../src/backends/codex/session/subagents.js'
import { CLIENT, NOTIFY } from '../src/backends/codex/protocol/index.js'
import { setLang } from '../src/i18n.js'

setLang('en')
let passed = 0
const check = (label: string, value: unknown): void => { assert.ok(value, label); passed += 1; console.log('PASS ' + label) }
const parent = 'parent'
const child = 'child'
const lane = 'spawn-call'
const calls: { method: string; params: Record<string, unknown> }[] = []
const events: AgentEvent[] = []
const turns = [{ id: 'turn-1', status: 'completed', startedAt: 1, completedAt: 2, items: [
  { type: 'userMessage', id: 'u1', clientId: 'c1', content: [{ type: 'text', text: 'child prompt' }] },
  { type: 'agentMessage', id: 'a1', text: 'child-ok', phase: 'final_answer', status: 'completed' },
] }]
const hub = {
  async call<R = unknown>(method: string, params: unknown = {}): Promise<R> {
    calls.push({ method, params: params as Record<string, unknown> })
    if (method === CLIENT.threadRead) return { thread: { id: child, parentThreadId: parent, cwd: '/TMP/cwd', source: { subAgent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } } } } as R
    if (method === CLIENT.threadTurnsList) return { data: turns, nextCursor: (params as Record<string, unknown>).cursor === 'older' ? null : 'older', backwardsCursor: null } as R
    if (method === CLIENT.turnInterrupt) return {} as R
    throw new Error('unexpected ' + method)
  },
}
const api = createCodexSubagents({ hub, cwd: '/TMP/cwd', threadId: () => parent, nextSeq: (() => { let n = 100; return () => ++n })(), emit: batch => events.push(...batch), now: () => 1 })
api.notification(NOTIFY.itemStarted, { threadId: child, item: { type: 'agentMessage', id: 'a1', text: 'live child' } })
await new Promise(resolve => setImmediate(resolve))
check('child traffic is consumed and metadata is validated before delivery', calls.some(call => call.method === CLIENT.threadRead))
const start = events.find(event => event.type === 'subagent.start')
check('unknown child gets a stable subagent start after ownership validation', start?.type === 'subagent.start' && start.agentId === child)
const page = await api.capability.history!(child, { count: 20, skipFromStart: 0 })
check('history uses one bounded full-items page and an opaque cursor', calls.some(call => call.method === CLIENT.threadTurnsList && call.params.itemsView === 'full') && page.events.some(event => event.type === 'assistant.message') && page.skippedFromStart === 0 && page.sourceCursor === 'older' && page.hasOlder)
const older = await api.capability.history!(child, { count: 20, skipFromStart: 0, sourceCursor: page.sourceCursor })
check('older history passes the exact native cursor without scanning intervening records', calls.at(-1)?.params.cursor === 'older' && older.hasOlder === false)
check('history carries the parent relationship and real leaf anchor', page.parentAgentId === null && page.uuids.includes('a1'))
check('child lane leaves carry stable parentCallId', page.events.every(event => 'parentCallId' in event && event.parentCallId === (start?.type === 'subagent.start' ? start.parentCallId : undefined)))
api.notification(NOTIFY.turnStarted, { threadId: child, turn: { id: 'turn-active' } })
check('interrupt uses native child turn id', await api.capability.interrupt(child) && calls.some(call => call.method === CLIENT.turnInterrupt && call.params.threadId === child && call.params.turnId === 'turn-active'))
const before = events.length
check('parent traffic is observed by caller and not consumed as child traffic', api.notification(NOTIFY.itemStarted, { threadId: parent, item: { type: 'subAgentActivity', id: lane, kind: 'started', agentThreadId: child, agentPath: '/root/child' } }) === false && events.length === before)
api.close()
await assert.rejects(() => api.capability.history!(child))
check('close refuses old history and interrupt operations', await api.capability.interrupt(child) === false)
// A complete recorded parent+child scenario through the production translators
// and shared projector. Child traffic never becomes the parent's reply/tool row.
{
  const wire = loadWire('s5-subagent')
  const [parent, child] = turnThreads(wire)
  assert.ok(parent && child)
  const context = createItemContext({ cwd: '/TMP/cwd', now: () => 0 })
  const live = createLiveTranslator(context, { model: '', effort: null, modeId: 'auto' })
  const projected = createProjectorHarness({ activity: true, now: () => 0 })
  const events: AgentEvent[] = []
  const publish = (batch: readonly AgentEvent[]): void => { events.push(...batch); projected.apply(batch) }
  const hub = { async call<R = unknown>(method: string, params: unknown = {}): Promise<R> {
    const id = (params as Record<string, unknown>).threadId as string
    if (method === CLIENT.threadRead) return { thread: { id, cwd: '/TMP/cwd', parentThreadId: id === child ? parent : null } } as R
    if (method === CLIENT.threadTurnsList) return { data: recordedTurns(wire, id) ?? [], nextCursor: null } as R
    throw new Error('unexpected ' + method)
  } }
  const api = createCodexSubagents({ hub, cwd: '/TMP/cwd', threadId: () => parent, nextSeq: context.nextSeq, emit: publish, now: () => 0 })
  try {
    for (const record of wire) {
      const message = record.msg
      if (record.dir !== 'in' || typeof message.method !== 'string' || message.id !== undefined) continue
      const params = message.params as Record<string, unknown>
      if (params === undefined || typeof params.threadId !== 'string') continue
      if (api.notification(message.method, params)) continue
      if (params.threadId === parent) publish(api.decorate(live.notification(message.method, params)))
    }
    await new Promise(resolve => setImmediate(resolve))
    check('recorded s5 has exactly one subagent card keyed by its child thread', projected.state.rows.filter(row => row.kind === 'subagent').length === 1 && projected.activity?.subagent(child)?.agentId === child)
    check('recorded child transcript stays on the child lane', projected.activity?.subagent(child)?.output.some(text => text.includes('child-ok')) && !projected.state.rows.some(row => row.kind === 'assistant' && row.text.includes('child-ok')))
    check('recorded collab wait tool is suppressed rather than a duplicate tool card', !projected.state.rows.some(row => row.tool?.name === 'collab_agent'))
    const end = events.find(event => event.type === 'subagent.end')
    check('only parent activity ends the child with its last final answer', end?.type === 'subagent.end' && end.status === 'completed' && end.summary === 'child-ok')
    const numbered = events.flatMap(event => 'seq' in event && event.seq !== undefined ? [event.seq] : [])
    check('recorded parent and child leaf sequence shares one monotonic counter', numbered.every((seq, index) => index === 0 || seq > numbered[index - 1]!))
    const replay = replayTurns(recordedTurns(wire, parent)!, createItemContext({ cwd: '/TMP/cwd', now: () => 0 }))
    check('the same item mapping replays the same subagent lifecycle', replay.filter(event => event.type.startsWith('subagent.')).map(event => event.type).join(',') === events.filter(event => event.type === 'subagent.start' || event.type === 'subagent.end').map(event => event.type).join(','))
    const seed = createCodexSubagents({ hub, cwd: '/TMP/cwd', threadId: () => parent, nextSeq: () => 1, emit: () => undefined })
    try {
      seed.seed(replay)
      const page = await seed.capability.history!(child)
      check('replayed parent metadata permits lazy child-history access', page.events.some(event => event.type === 'assistant.message' && event.blocks.some(block => block.text === 'child-ok')))
    } finally { seed.close() }
  } finally { api.close() }
}

// Native spawn metadata enriches one existing card; a nested spawn records
// its actual immediate parent, while model-less metadata stays model-less.
{
  type Spawn = Extract<import('../src/backends/codex/protocol/index.js').ThreadItem, { type: 'collabAgentToolCall' }>
  const direct = 'spawned-child'
  const nested = 'nested-child'
  const requested = 'requested-model'
  const prompt = 'Inspect the source files'
  const root = 'spawn-parent'
  const roots: Record<string, string> = { [direct]: root, [nested]: direct }
  const reads: string[] = []
  const projector = createProjectorHarness({ activity: true, now: () => 0 })
  const events: AgentEvent[] = []
  let seq = 0
  const publish = (batch: readonly AgentEvent[]): void => { events.push(...batch); projector.apply(batch) }
  const hub = { async call<R = unknown>(method: string, params: unknown = {}): Promise<R> {
    const id = (params as Record<string, unknown>).threadId as string
    if (method === CLIENT.threadRead) {
      reads.push(id)
      return { thread: { id, parentThreadId: null, cwd: '/TMP/cwd', model: id === direct ? 'configured-model' : null,
        agentNickname: id === direct ? 'Iris' : 'Lynx',
        source: { subAgent: { thread_spawn: { parent_thread_id: roots[id], depth: id === direct ? 1 : 2 } } },
      } } as R
    }
    if (method === CLIENT.threadTurnsList) return { data: [], nextCursor: null } as R
    throw new Error('unexpected ' + method)
  } }
  const api = createCodexSubagents({ hub, cwd: '/TMP/cwd', threadId: () => root, nextSeq: () => ++seq, emit: publish, now: () => 0 })
  const initial: AgentEvent = { type: 'subagent.start', agentId: direct, parentCallId: 'direct-lane', description: 'child', background: false, depth: 1, time: 0 }
  publish(api.decorate([initial]))
  const rowId = projector.state.rows[0]!.id
  const spawn: Spawn = { type: 'collabAgentToolCall', id: 'spawn-item', tool: 'spawnAgent', status: 'completed', senderThreadId: root,
    receiverThreadIds: [direct], prompt, model: requested, reasoningEffort: null, agentsStates: {},
  }
  try {
    check('root spawn is observed without consuming the parent item', api.notification(NOTIFY.itemCompleted, { threadId: root, item: spawn }) === false)
    await new Promise(resolve => setImmediate(resolve))
    const state = projector.activity!.subagent(direct)!
    check('requested model and native nickname/prompt update the same child card', state.model === requested && state.description === 'Iris: ' + prompt && projector.state.rows.filter(row => row.kind === 'subagent').length === 1 && projector.state.rows[0]!.id === rowId)
    check('spawn metadata keeps the original lane and is not actual-model telemetry', events.filter(event => event.type === 'subagent.start').every(event => event.parentCallId === 'direct-lane') && state.model !== 'configured-model')
    publish(api.decorate([initial]))
    check('later activity snapshots preserve the enriched description and model', projector.activity!.subagent(direct)?.description === 'Iris: ' + prompt && projector.activity!.subagent(direct)?.model === requested)
    const deep: Spawn = { ...spawn, id: 'deep-spawn', senderThreadId: direct, receiverThreadIds: [nested], prompt: 'Check imports', model: null }
    api.notification(NOTIFY.itemCompleted, { threadId: direct, turnId: 'child-turn', item: deep })
    await new Promise(resolve => setImmediate(resolve))
    check('nested spawn uses its immediate parent and truthful model absence', projector.activity!.subagent(nested)?.parentAgentId === direct && projector.activity!.subagent(nested)?.depth === 2 && projector.activity!.subagent(nested)?.model === undefined)
    const beforeHistory = reads.length
    const page = await api.capability.history!(nested)
    check('nested history validates the complete metadata parent chain', page.parentAgentId === direct && reads.slice(beforeHistory).join(',') === nested + ',' + direct)
    publish(api.decorate([{ type: 'subagent.end', agentId: direct, status: 'completed', time: 1 }]))
    api.notification(NOTIFY.itemCompleted, { threadId: root, item: { ...spawn, id: 'late-metadata', prompt: 'late prompt' } })
    await new Promise(resolve => setImmediate(resolve))
    check('late spawn metadata cannot revive an ended child', projector.activity!.subagent(direct)?.status === 'completed')
  } finally { api.close() }
}

console.log('\nverify-codex-subagents OK (' + passed + ' checks)')
