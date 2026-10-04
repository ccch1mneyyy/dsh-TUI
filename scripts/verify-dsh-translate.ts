/**
 * DSH translator coverage: runs the DSH projection fixtures
 * (scripts/fixtures/dsh/) through `createDshTranslator` (live per event,
 * replay via `translateReplay`, plus the stream frames) and asserts that
 * every DSH event family produces its Agent Domain event with the identity
 * fields the shared projector relies on. The
 * projected outcome itself is pinned by verify-projection-golden; this gate
 * pins the vocabulary in between, so a translator change that happens to
 * cancel out in the projection still fails here.
 *
 * Run: node --import tsx/esm scripts/verify-dsh-translate.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from '../src/agent/events.js'
import { prependHistoryRows, projectHistorySlice } from '../src/channel/history-restore.js'
import { createDshTranslator, dshPricingWindow } from '../src/dsh-adapter/backend/translate.js'
import { FIXTURE_DIR, buildFixtures } from './fixtures/dsh/generate.js'
import { createProjectorHarness } from './lib/projector-harness.js'

type Translator = ReturnType<typeof createDshTranslator>
const readJsonl = (path: string): unknown[] => {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return [] }
  return raw.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as unknown)
}

const live: AgentEvent[] = []
const replay: AgentEvent[] = []
let scopeReads = 0
for (const fixture of buildFixtures()) {
  const events = readJsonl(join(FIXTURE_DIR, `${fixture.name}.jsonl`)) as Parameters<Translator['translateReplay']>[0]
  const frames = readJsonl(join(FIXTURE_DIR, `${fixture.name}.frames.jsonl`)) as Parameters<Translator['translateFrame']>[0][]
  const deps = { tools: () => undefined, scope: () => { scopeReads += 1; return {} }, attachments: () => undefined }
  const liveTranslator = createDshTranslator(deps)
  for (const event of events) live.push(...liveTranslator.translateEvent(event))
  for (const frame of frames) live.push(...liveTranslator.translateFrame(frame))
  const replayTranslator = createDshTranslator(deps)
  replay.push(...replayTranslator.translateReplay(events))
  for (const frame of frames) replay.push(...replayTranslator.translateFrame(frame))
}
const of = <T extends AgentEvent['type']>(events: readonly AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)
const check = (label: string, ok: boolean): void => {
  assert.ok(ok, label)
  console.log(`PASS ${label}`)
}

// turn/step boundaries
check('turn/start → turn.start{origin:user}', of(live, 'turn.start').every(event => event.origin === 'user' && Number.isInteger(event.turn)))
const reasons = new Set(of(live, 'turn.end').map(event => event.reason.kind === 'other' ? `other:${event.reason.label}` : event.reason.kind))
for (const reason of ['completed', 'aborted', 'error', 'blocked', 'interrupted', 'other:max-tokens']) check(`turn/end reason ${reason}`, reasons.has(reason))
check('turn/end error keeps the raw message', of(live, 'turn.end').some(event => event.reason.kind === 'error' && event.reason.message.includes('\n')))
check('step/start|end → step.start|end', of(live, 'step.start').length > 0 && of(live, 'step.end').length > 0)

// user side
const users = of(live, 'user.message')
check('user/message{user} → user.message{user, first text, seq anchor}', users.some(event => event.source === 'user' && event.text === 'Summarize the fixture readme.' && event.anchor === String(event.seq) && event.blocks.length === 2))
check('compaction checkpoint → user.message{compaction, summary}', users.filter(event => event.source === 'compaction').length === 2 && users.some(event => event.source === 'compaction' && event.text.includes('<compacted-summary>')))
check('injected context → user.message{injected}', users.some(event => event.source === 'injected'))
check('goal-sourced user/message never becomes a bubble', !users.some(event => event.id === 'msg-g0' || event.id === 'msg-g2'))
const goals = of(live, 'goal.change')
check('goal round > 0 → goal.change{round}', goals.some(event => event.operation === 'round' && event.round === 2))
check('goal round 0 snapshot + top-level goal/change → goal.change', goals.some(event => event.operation === 'edit') && goals.some(event => event.operation === 'clear') && goals.some(event => event.operation === 'block' && event.goal?.blockedReason !== undefined))

// assistant stream
check('stream start frame → assistant.attempt.start', of(live, 'assistant.attempt.start').some(event => event.attemptId === 'attempt-b' && event.turn === 5 && event.step === 1))
const ends = of(live, 'assistant.attempt.end')
check('abandoned end frame → attempt.end{abandoned}', ends.some(event => event.attemptId === 'attempt-a' && event.outcome === 'abandoned' && event.turn === undefined))
check('committed-as-attempt end frame → attempt.end{abandoned}', ends.some(event => event.attemptId === 'attempt-b' && event.outcome === 'abandoned'))
check('durable assistant/attempt → positioned attempt.end', ends.some(event => event.turn === 4 && event.step === 1 && event.outcome === 'abandoned'))
const deltas = of(live, 'assistant.delta')
check('frame deltas carry kind text/reasoning/tool-args', ['text', 'reasoning', 'tool-args'].every(kind => deltas.some(event => event.seq === undefined && event.delta.kind === kind)))
check('replayed frame revision is fenced', deltas.filter(event => event.delta.kind === 'text' && event.delta.text === 'Each frame has').length === 1)
check('legacy assistant/chunk → positioned delta (seq, turn, step)', deltas.some(event => event.seq !== undefined && event.turn === 1 && event.step === 1))
check('replay drops settled legacy chunks, keeps the orphan tail', of(replay, 'assistant.delta').filter(event => event.seq !== undefined).every(event => event.turn === 4))
const messages = of(live, 'assistant.message')
check('assistant/message → assistant.message{canonical, usage}', messages.some(event => event.canonical && event.usage?.input === 1200 && event.usage.cacheRead === 800))
check('pre-V3 settlement is non-canonical', messages.some(event => !event.canonical))
check('interrupted settlement keeps interrupted:true', messages.some(event => event.interrupted === true))
check('usage keeps unknown counts unknown', messages.some(event => event.usage !== undefined && event.usage.cacheWrite === undefined))

// tools
const calls = of(live, 'tool.call')
check('ask_user_question → presentation.card question', calls.filter(event => event.presentation?.card === 'question').length === 2)
check('subagent tool → presentation.card subagent', calls.some(event => event.name === 'task' && event.presentation?.card === 'subagent'))
check('ordinary tool call keeps raw args', calls.some(event => event.callId === 'call_read_1' && event.argsJson === '{"path":"docs/guide.md"}' && event.presentation === undefined))
const results = of(live, 'tool.result')
check('error result → isError + errorText with failure identity', results.some(event => event.callId === 'call_bash_1' && event.isError && event.errorText?.startsWith('ToolError: NONZERO_EXIT') === true))
check('pre-0.1.7 wrapped results unwrap', results.some(event => event.callId === 'call_legacy_1' && !event.isError && event.text === 'legacy ok') && results.some(event => event.callId === 'call_legacy_2' && event.isError))
check('ask result text reaches the projector', results.some(event => event.callId === 'call_ask_1' && event.text.startsWith('{"answers"')))
check('harness goal/todo results carry a presentation', results.some(event => event.callId === 'call_goal_1' && event.presentation?.card === 'generic') && results.some(event => event.callId === 'call_todo_1' && event.presentation?.card === 'generic'))
check('job_output read → task.output', of(live, 'task.output').some(event => event.taskId === 'job-7' && event.callId === 'call_job_1'))
check('background start ack → task.start with full command', of(live, 'task.start').some(event => event.taskId === 'job-7' && event.command === 'npm run build' && event.callId === 'call_bash_2'))

// request/context, header, system, session metadata, plugin events
check('request/context → context.capacity', of(live, 'context.capacity').some(event => event.contextWindow === 64000))
const headers = of(live, 'request.header')
check('request/header → request.header{model, effort}', headers.some(event => event.model === 'fixture-model-b' && event.effort === 'high'))
check('request/header without effort leaves effort unset', headers.some(event => event.effort === undefined))
check('system/message + legacy header system → system.prompt', of(live, 'system.prompt').some(event => event.text.startsWith('You are the fixture agent')) && of(live, 'system.prompt').some(event => event.text.startsWith('Legacy system prompt')))
check('session/title → session.title{user|auto}', of(live, 'session.title').some(event => event.source === 'auto') && of(live, 'session.title').some(event => event.source === 'user'))
check('session/color → session.color (\'\' clears)', of(live, 'session.color').some(event => event.color === ''))
check('valid todo/write → todo.write; malformed dropped', of(live, 'todo.write').length === 2)
check('agent-preset/selected → preset.selected with aliases', of(live, 'preset.selected').some(event => event.preset === 'code' && event.aliases?.includes('ptc') === true))
check('compaction bracket → compaction.start/end', of(live, 'compaction.start').length === 2 && of(live, 'compaction.end').length === 1)
// Untrusted preset names must not resolve through Object.prototype: a
// `constructor` marker gets no aliases and still projects as a notice row.
{
  const translator = createDshTranslator({ tools: () => undefined, scope: () => ({}), attachments: () => undefined })
  const marker = { type: 'agent-preset/selected', seq: 9001, time: 0, data: { agentPreset: 'constructor' } } as unknown as Parameters<Translator['translateEvent']>[0]
  const [selected] = translator.translateEvent(marker)
  check('prototype-key preset → preset.selected without aliases', selected?.type === 'preset.selected' && selected.preset === 'constructor' && selected.aliases === undefined)
  const harness = createProjectorHarness({ agentPreset: 'ptc' })
  harness.apply(translator.translateEvent(marker))
  harness.apply([{ type: 'preset.selected', preset: 'code', aliases: 'ptc' as unknown as readonly string[] }])
  check('prototype-key preset projects without throwing', harness.state.rows.filter(row => row.kind === 'notice').length === 2)
}
// A card the window cap folded while it ran keeps only its preview when the
// result lands: the full payload and the presentation view are not
// re-attached past the fold line, or the fold would no longer bound memory.
{
  const harness = createProjectorHarness()
  harness.apply([
    { type: 'turn.start', turn: 1, origin: 'user', time: 0 },
    { type: 'tool.call', seq: 1, turn: 1, step: 1, callId: 'fold-1', name: 'Bash', argsJson: '{"command":"ls"}', time: 0 },
  ])
  const card = harness.state.rows.find(row => row.kind === 'tool')!
  card.folded = true
  harness.apply([{
    type: 'tool.result', seq: 2, turn: 1, step: 1, callId: 'fold-1', isError: false, time: 0,
    content: [{ type: 'text', text: 'listing' }], text: 'listing',
    presentation: { card: 'terminal', output: 'listing', exitCode: 0 },
  }])
  check('folded running card: the result keeps the preview, no full payload or view', card.tool?.status === 'ok' && card.tool.resultText === 'listing' && card.tool.resultFull === undefined && card.tool.resultView === undefined)
}
// The projector's reset forgets every per-session ledger: replaying a second
// session through a reused projector paints what a fresh one paints.
{
  const history: AgentEvent[] = [
    { type: 'turn.start', turn: 1, origin: 'user', time: 1 },
    { type: 'user.message', id: 'u1', anchor: '1', seq: 1, turn: 1, time: 1, source: 'user', text: 'hi', blocks: [{ type: 'text', text: 'hi' }] },
    { type: 'step.start', turn: 1, step: 1 },
    { type: 'assistant.message', seq: 2, anchor: '2', turn: 1, step: 1, attemptId: 'seq:2', time: 2, model: 'model-a', canonical: true, blocks: [{ type: 'text', text: 'hello' }], usage: { input: 10, output: 5 } },
    { type: 'step.end', turn: 1, step: 1 },
    { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 3 },
  ]
  const shape = (rows: readonly { kind: string; text: string; turnUsage?: unknown }[]): string => JSON.stringify(rows.map(row => [row.kind, row.text, row.turnUsage ?? null]))
  const fresh = createProjectorHarness()
  fresh.apply(history, true)
  const reused = createProjectorHarness()
  reused.apply(history, true)
  reused.apply([{ type: 'tool.call', seq: 3, turn: 2, step: 1, callId: 'todo-1', name: 'TodoWrite', argsJson: '{}', presentation: { card: 'todo' }, time: 4 }])
  reused.projector.reset()
  reused.state.rows.length = 0
  reused.apply(history, true)
  check('reset + replay paints what a fresh projector paints (the turn summary names its model)', shape(reused.state.rows) === shape(fresh.state.rows) && fresh.state.rows.some(row => row.turnUsage?.noteModel === true))
  reused.apply([{ type: 'tool.result', seq: 4, turn: 2, step: 1, callId: 'todo-1', isError: true, time: 5, content: [], text: '', errorText: 'stale' }])
  check('reset forgets the suppressed todo calls of the previous session', !reused.state.rows.some(row => row.kind === 'tool'))
}
// Seq lookups only match rows the projector itself painted.
{
  const harness = createProjectorHarness()
  harness.apply([
    { type: 'turn.start', turn: 1, origin: 'user', time: 1 },
    { type: 'step.start', turn: 1, step: 1 },
    { type: 'assistant.delta', attemptId: 'seq:3', index: 0, time: 2, turn: 1, step: 1, seq: 3, delta: { kind: 'text', text: 'chunked' } },
    { type: 'assistant.message', seq: 4, anchor: '4', turn: 1, step: 1, attemptId: 'seq:4', time: 3, canonical: false, blocks: [{ type: 'text', text: 'chunked' }] },
    { type: 'step.end', turn: 1, step: 1 },
    { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 4 },
  ])
  // A reconnect re-delivers the durable chunk: it lands on the row it opened.
  harness.apply([{ type: 'assistant.delta', attemptId: 'seq:3', index: 0, time: 2, turn: 1, step: 1, seq: 3, delta: { kind: 'text', text: 'chunked' } }], true)
  harness.projector.settleStreaming()
  check('a re-delivered chunk reuses the row it opened', harness.state.rows.filter(row => row.kind === 'assistant').length === 1)
  // "Load earlier" prepends rows from a separate projection whose seqs can
  // collide with live ones; a live settlement must never land on them.
  const older = projectHistorySlice([
    { type: 'assistant.message', seq: 7, anchor: 'older-7', turn: 1, step: 1, attemptId: 'older-7', time: 1, canonical: true, blocks: [{ type: 'text', text: 'older answer' }] },
  ], 'preview')
  prependHistoryRows(harness.state.rows, older)
  harness.apply([{ type: 'assistant.message', seq: 7, anchor: 'live-7', attemptId: 'live-7', time: 9, canonical: true, blocks: [{ type: 'text', text: 'live answer' }] }])
  const assistants = harness.state.rows.filter(row => row.kind === 'assistant')
  check('a live settlement never overwrites a restored row with the same seq', assistants[0]?.text === 'older answer' && assistants.at(-1)?.text === 'live answer')
}
const customs = of(live, 'custom').map(event => event.nativeType)
check('unknown plugin events → custom', customs.includes('fixture-plugin/note') && customs.includes('other-plugin/ping') && customs.includes('developer/message'))

// replay = live vocabulary
const types = (events: readonly AgentEvent[]) => [...new Set(events.map(event => event.type))].sort().join(',')
check('replay and live share one vocabulary', types(replay) === types(live))
check('no presenter scope read without a tools registry', scopeReads === 0)
check('DeepSeek pricing window buckets peak/idle', dshPricingWindow(Date.UTC(2026, 0, 5, 1, 30)) === 'peak' && dshPricingWindow(Date.UTC(2026, 0, 5, 13, 0)) === 'idle')
console.log(`verify-dsh-translate OK (${live.length} live / ${replay.length} replay events)`)
