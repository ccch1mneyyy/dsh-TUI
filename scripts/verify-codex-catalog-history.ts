/** C3 catalog + synchronous prefetch against the real Codex hub/replay.
 * No personal logs, native processes or network.
 * Run: node --import tsx/esm scripts/verify-codex-catalog-history.ts */
import './lib/default-lang-zh.mjs'
import assert from 'node:assert/strict'
import type { AgentEvent } from '../src/agent/events.js'
import { codexSessionSummary, createCodexCatalog } from '../src/backends/codex/catalog.js'
import { createCodexTranscriptHistory } from '../src/backends/codex/session/history.js'
import { createCodexHub, type HubSettings } from '../src/backends/codex/rpc/hub.js'
import { createItemContext } from '../src/backends/codex/translate/items.js'
import { createFakeAppServer, FakeRpcError, NO_REPLY } from './lib/codex-fake-app-server.js'
import { manualClock } from './lib/codex-session-harness.js'

let passed = 0
const check = (label: string, ok: boolean): void => { assert.ok(ok, label); passed += 1; console.log('PASS ' + label) }
const tick = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })
const SETTINGS: HubSettings = { executable: '/fake/codex', args: ['app-server'], env: {}, cwd: '/TMP/project' }
const turn = (id: string) => ({ id, status: 'completed', startedAt: 100, completedAt: 101, items: [{ type: 'userMessage', id: 'user-' + id, clientId: null, content: [{ type: 'text', text: 'prompt-' + id }] }, { type: 'agentMessage', id: 'reply-' + id, text: 'answer-' + id, phase: 'final_answer' }] })
const userTexts = (events: readonly AgentEvent[]) => events.filter(event => event.type === 'user.message').map(event => event.text)
const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, cwd: SETTINGS.cwd, createdAt: 10, updatedAt: 20, preview: 'first prompt', model: 'gpt-fixture', ...extra })

{
  const summary = codexSessionSummary(row('root', { name: 'Named', recencyAt: 30, gitInfo: { branch: 'feature' } }), { root: 40_000 })!
  check('catalog summary: native id/backend/model/title/provenance map to browser shape', summary.id === 'root' && summary.backendId === 'codex' && summary.title.text === 'Named' && summary.title.source === 'auto' && summary.model === 'gpt-fixture')
  check('catalog summary: seconds convert to ms and local last-use is a lower bound', summary.createdAt === 10_000 && summary.updatedAt === 40_000 && summary.branch === 'feature')
  check('catalog summary: missing byte statistics are honestly undefined', summary.bytes === undefined && summary.hasPrompt)
  check('catalog summary: fork and nested subagent metadata remain distinct', codexSessionSummary(row('fork', { forkedFromId: 'parent' }))?.kind.kind === 'fork' && codexSessionSummary(row('child', { parentThreadId: 'parent', source: { subAgent: { thread_spawn: { depth: 3 } } } }))?.kind.kind === 'subagent')
  check('catalog summary: ephemeral threads do not invent persistent rows', codexSessionSummary(row('ephemeral', { ephemeral: true })) === undefined)
}
{
  const fake = createFakeAppServer()
  fake.on('thread/list', params => params.useStateDbOnly === true
    ? { data: [row('A')], nextCursor: null }
    : params.cursor === 'next' ? { data: [row('B', { updatedAt: 30 })], nextCursor: null } : { data: [row('A'), row('child', { parentThreadId: 'A' })], nextCursor: 'next' })
  fake.on('thread/read', params => { if (params.threadId === 'absent') throw new FakeRpcError(-32600, 'thread not found'); return { thread: row(String(params.threadId)) } })
  fake.on('thread/turns/list', () => ({ data: [turn('newer'), turn('older')], nextCursor: null }))
  fake.on('thread/name/set', () => ({}))
  fake.on('thread/archive', params => { if (params.threadId === 'worker') throw new FakeRpcError(-32600, 'thread has an active internal worker'); return {} })
  const hub = createCodexHub(SETTINGS, { transportFactory: fake.transportFactory })
  await hub.ready
  let releases = 0
  let preferenceReads = 0
  const catalog = createCodexCatalog({ acquire: async () => ({ hub, release: () => { releases += 1 } }), cwd: () => SETTINGS.cwd, lastUsed: () => { preferenceReads += 1; return {} } })
  const batches: string[][] = []
  const rows = await catalog.list({}, rows => { batches.push(rows.map(row => row.id)) })
  check('catalog list: preferences are read once across all pages', preferenceReads === 1)
  check('catalog list: the state DB and regular pages publish before the full result', JSON.stringify(batches) === JSON.stringify([['A'], ['A'], ['B', 'A']]))
  check('catalog list: native paging/scoped cwd/all provider filter excludes children', rows.map(row => row.id).join(',') === 'B,A' && fake.requests.filter(request => request.method === 'thread/list').length === 3 && fake.requests.find(request => request.method === 'thread/list')?.params.cwd === SETTINGS.cwd && JSON.stringify(fake.requests.find(request => request.method === 'thread/list')?.params.modelProviders) === '[]')
  await catalog.list({ allProjects: true })
  check('catalog list: all-projects omits cwd, archived threads stay excluded', fake.requests.filter(request => request.method === 'thread/list').at(-1)?.params.cwd === undefined && fake.requests.filter(request => request.method === 'thread/list').at(-1)?.params.archived === false)
  check('catalog info: uses thread/read metadata without full turns', (await catalog.info!('A'))?.id === 'A' && fake.requests.find(request => request.method === 'thread/read')?.params.includeTurns === false)
  check('catalog info: native not-found returns undefined without creating a thread', await catalog.info!('absent') === undefined && !fake.requests.some(request => request.method === 'thread/start'))
  const preview = await catalog.preview!('A', { limit: 3 })
  check('catalog preview: bounded summary rows are chronological and retain role/time', preview.map(row => row.role).join(',') === 'assistant,user,assistant' && preview[0]?.text === 'answer-older' && preview[0]?.at === 100_000 && fake.requests.find(request => request.method === 'thread/turns/list')?.params.itemsView === 'summary')
  await catalog.rename!('A', 'New name')
  await catalog.delete!('A')
  check('catalog mutations: rename uses native name/set; delete only archives', fake.requests.some(request => request.method === 'thread/name/set' && request.params.name === 'New name') && fake.requests.some(request => request.method === 'thread/archive' && request.params.threadId === 'A'))
  let failed = false
  try { await catalog.delete!('worker') } catch (error) { failed = error instanceof Error && !error.message.includes('active internal worker') }
  check('catalog: active worker archive refusal is localized', failed)
  check('catalog: every success/failure releases its borrowed runtime', releases === 8)
  await hub.close()
}
{
  const fake = createFakeAppServer()
  fake.on('thread/list', params => params.useStateDbOnly === true
    ? { data: [row('first', { name: 'Old title' }), row('stale'), row('child', { parentThreadId: 'first' }), row('ephemeral', { ephemeral: true })], nextCursor: null }
    : NO_REPLY)
  const hub = createCodexHub(SETTINGS, { transportFactory: fake.transportFactory })
  await hub.ready
  const batches: string[][] = []
  const titles: (string | undefined)[] = []
  let done = false
  const catalog = createCodexCatalog({ acquire: async () => ({ hub, release: () => {} }), cwd: () => SETTINGS.cwd })
  const listing = catalog.list({}, rows => {
    batches.push(rows.map(row => row.id))
    titles.push(rows.find(row => row.id === 'first')?.title.text)
  }).then(rows => { done = true; return rows })
  const first = await fake.waitForRequest('thread/list')
  const regular = await fake.waitForRequest('thread/list', { after: fake.requests.indexOf(first) + 1 })
  check('catalog cold load: bounded DB rows arrive while the rollout repair scan is pending', !done && first.params.useStateDbOnly === true && first.params.limit === 32 && JSON.stringify(batches) === JSON.stringify([['first', 'stale']]))
  fake.reply(regular.id, { data: [row('first', { name: 'Repaired title' })], nextCursor: 'slow-page' })
  const request = await fake.waitForRequest('thread/list', { after: fake.requests.indexOf(regular) + 1 })
  check('catalog cold load: progress keeps all announced DB rows while the next page is pending', !done && JSON.stringify(batches) === JSON.stringify([['first', 'stale'], ['first', 'stale']]) && regular.params.useStateDbOnly === undefined && regular.params.cursor === undefined)
  check('catalog cold load: repair updates metadata without withdrawing other announced rows', titles[0] === 'Old title' && titles[1] === 'Repaired title')
  fake.reply(request.id, { data: [row('second')], nextCursor: null })
  const complete = await listing
  check('catalog cold load: every progress batch retains initial IDs through the last page', batches.every(batch => batch.includes('first') && batch.includes('stale')) && batches.at(-1)?.includes('second') === true)
  check('catalog cold load: completion retains both repaired pages and drops DB-only rows', complete.map(row => row.id).sort().join(',') === 'first,second' && complete.find(row => row.id === 'first')?.title.text === 'Repaired title')
  await hub.close()
}
for (const unavailable of ['empty', 'unsupported', 'timeout']) {
  const fake = createFakeAppServer()
  fake.on('thread/list', params => {
    if (params.useStateDbOnly !== true) return { data: [row('repaired')], nextCursor: null }
    if (unavailable === 'unsupported') throw new FakeRpcError(-32602, 'unknown field useStateDbOnly')
    if (unavailable === 'timeout') return NO_REPLY
    return { data: [], nextCursor: null }
  })
  const clock = manualClock()
  const hub = createCodexHub(SETTINGS, { transportFactory: fake.transportFactory, clock })
  await hub.ready
  let released = false
  const catalog = createCodexCatalog({ acquire: async () => ({ hub, release: () => { released = true } }), cwd: () => SETTINGS.cwd })
  const batches: string[][] = []
  const listing = catalog.list({ allProjects: true }, rows => { batches.push(rows.map(row => row.id)) })
  if (unavailable === 'timeout') {
    await fake.waitForRequest('thread/list')
    clock.advance(1000)
  }
  const complete = await listing
  check(`catalog cold load: ${unavailable} DB falls back to repaired all-projects rows`, complete[0]?.id === 'repaired' && JSON.stringify(batches) === JSON.stringify([['repaired']]) && fake.requests.filter(request => request.method === 'thread/list').every(request => request.params.cwd === undefined) && released)
  await hub.close()
}
{
  const fake = createFakeAppServer()
  fake.on('thread/turns/list', () => NO_REPLY)
  const hub = createCodexHub(SETTINGS, { transportFactory: fake.transportFactory })
  await hub.ready
  const ctx = createItemContext({ cwd: SETTINGS.cwd, now: () => 100_000 })
  const history = createCodexTranscriptHistory({ hub, threadId: 'T', cwd: SETTINGS.cwd, ctx, response: { initialTurnsPage: { data: [turn('3'), turn('2')], nextCursor: 'older' } } })
  const initial = history.takeInitial()
  const seq = ctx.seq
  check('history seed: newest page replays oldest first and is consumed once', userTexts(initial).join(',') === 'prompt-2,prompt-3' && history.takeInitial().length === 0 && ctx.turn === 2)
  check('history prefetch: empty cache returns immediately without hiding older entry', history.capability.older().length === 0 && history.capability.hasOlder())
  const request = await fake.waitForRequest('thread/turns/list')
  check('history prefetch: full items and backwards cursor are requested', request.params.itemsView === 'full' && request.params.cursor === 'older' && request.params.sortDirection === 'desc')
  fake.reply(request.id, { data: [turn('2'), turn('1')], nextCursor: null })
  await tick()
  check('history turns: prefetched predecessor is available before display for rewind', history.turns.map(turn => turn.id).join(',') === '1,2,3' && history.previousTurnId('user-2') === '1')
  check('history record: still contains loaded turns only, not pending older display', userTexts(history.capability.record()!).join(',') === 'prompt-2,prompt-3')
  const older = history.capability.older()
  check('history older: a ready page is synchronous and overlap is deduplicated', userTexts(older).join(',') === 'prompt-1' && !history.capability.hasOlder() && history.capability.older().length === 0)
  check('history record: loaded events are chronological and do not alter live sequence', userTexts(history.capability.record()!).join(',') === 'prompt-1,prompt-2,prompt-3' && ctx.seq === seq)
  history.notification('turn/started', { threadId: 'T', turn: { id: '4', status: 'inProgress', startedAt: 102, items: [] } })
  history.notification('item/completed', { threadId: 'T', turnId: '4', item: { type: 'commandExecution', id: 'cmd-4', command: 'echo hi', status: 'completed', aggregatedOutput: 'full output', exitCode: 0, durationMs: 12, cwd: SETTINGS.cwd } })
  history.notification('turn/completed', { threadId: 'T', turn: { id: '4', status: 'completed', completedAt: 103, items: [{ type: 'commandExecution', id: 'cmd-4', aggregatedOutput: null }, { type: 'agentMessage', id: 'reply-4', text: 'finished', phase: 'final_answer' }] } })
  const result = history.capability.record()!.find(event => event.type === 'tool.result' && event.callId === 'cmd-4')
  check('history live: completed summary cannot erase full tool output', result?.type === 'tool.result' && result.text === 'full output' && history.turns.at(-1)?.status === 'completed')
  history.notification('item/started', { threadId: 'T', turnId: '4', item: { type: 'commandExecution', id: 'unsaved' } })
  history.notification('turn/completed', { threadId: 'child', turn: turn('foreign') })
  check('history live: transient/unrelated child facts do not enter durable record', !history.turns.some(turn => turn.id === 'foreign') && !history.capability.record()!.some(event => event.type === 'tool.call' && event.callId === 'unsaved'))
  history.reset({ initialTurnsPage: { data: [turn('replacement')], nextCursor: null } })
  check('history reset: paging/record reset without advancing live translator counters', userTexts(history.takeInitial()).join(',') === 'prompt-replacement' && userTexts(history.capability.record()!).join(',') === 'prompt-replacement' && ctx.seq === seq)
  history.close()
  check('history close: record/cache are invalidated and future older calls stay empty', history.capability.record() === undefined && !history.capability.hasOlder() && history.capability.older().length === 0)
  await hub.close()
}
{
  const fake = createFakeAppServer()
  fake.on('thread/turns/list', () => { throw new FakeRpcError(-32603, 'fixture unavailable') })
  const hub = createCodexHub(SETTINGS, { transportFactory: fake.transportFactory })
  await hub.ready
  const notices: AgentEvent[] = []
  const history = createCodexTranscriptHistory({ hub, threadId: 'T', cwd: SETTINGS.cwd, ctx: createItemContext({ cwd: SETTINGS.cwd }), response: { initialTurnsPage: { data: [turn('2')], nextCursor: 'older' } }, notice: event => notices.push(event) })
  await tick()
  check('history failure: first prefetch failure preserves the entry and cursor', history.capability.hasOlder())
  history.capability.older()
  await tick()
  history.capability.older()
  await tick()
  check('history failure: three attempts stop prefetch with one actionable notice', !history.capability.hasOlder() && notices.length === 1 && fake.requests.filter(request => request.method === 'thread/turns/list').length === 3)
  history.close()
  await hub.close()
}
{
  const fake = createFakeAppServer()
  fake.on('thread/turns/list', () => NO_REPLY)
  const hub = createCodexHub(SETTINGS, { transportFactory: fake.transportFactory })
  await hub.ready
  const history = createCodexTranscriptHistory({ hub, threadId: 'T', cwd: SETTINGS.cwd, ctx: createItemContext({ cwd: SETTINGS.cwd }), response: { initialTurnsPage: { data: [turn('old')], nextCursor: 'old-page' } } })
  const read = await fake.waitForRequest('thread/turns/list')
  history.reset({ initialTurnsPage: { data: [turn('new')], nextCursor: null } })
  fake.reply(read.id, { data: [turn('stale')], nextCursor: 'stale-page' })
  await tick()
  check('history reset: stale in-flight page cannot attach to the new record', history.turns.length === 1 && history.turns[0]?.id === 'new' && !history.capability.hasOlder())
  history.close()
  await hub.close()
}
console.log('\nverify-codex-catalog-history OK (' + passed + ' checks)')
