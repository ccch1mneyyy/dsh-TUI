/**
 * Claude resume replay (docs/agent-backend-design.md §4.11, Phase 4b): every
 * read-API transcript in scripts/fixtures/claude/transcripts/ (the
 * `getSessionMessages(…, {includeSystemMessages:true})` + subagent dumps of
 * recorded sessions, redacted together with their stream recordings so ids
 * line up) runs through `replayClaudeTranscript` and the shared projector,
 * and must equal its committed `transcripts/<name>.golden.json`. Targeted
 * assertions pin what the replay promises on top:
 *
 *  - turns segmented by real prompts, rows anchored at the message uuids
 *    (the ones the live session pushed: a live row and its replay rewind
 *    the same way);
 *  - a queued prompt joins its turn; `[Request interrupted …]` closes the
 *    turn as aborted; a task notification opens the notification turn;
 *    local-command echoes, `/compact` and meta texts never become bubbles;
 *  - the compact summary renders the compaction rows; tool results pair by
 *    `tool_use_id`; empty thinking replays the API's own count row;
 *  - subagent traffic stays off the main transcript, its start / end follow
 *    the parent `Agent` call and result;
 *  - replay and live agree on the transcript of the same recorded session;
 *  - live events after a resume continue the numbering (no reused turn or
 *    seq: the projector would bind or deduplicate them onto history);
 *  - the rewind cut point and the browser preview.
 *
 * Run:    node --import tsx/esm scripts/verify-claude-replay.ts
 * Update: node --import tsx/esm scripts/verify-claude-replay.ts --update
 *         (review the golden diff: it IS the behaviour change)
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, AgentEventOf } from '../src/agent/events.js'
import { previewEntries, replayClaudeTranscript, rewindCutPoint, type ClaudeReplay, type ClaudeSubagentTranscript } from '../src/backends/claude/replay.js'
import { createClaudeTranslator } from '../src/backends/claude/translate.js'
import { setLang, t } from '../src/i18n.js'
import { createProjectorHarness } from './lib/projector-harness.js'

setLang('en')
const FIXTURES = join(import.meta.dirname, 'fixtures', 'claude')
const TRANSCRIPTS = join(FIXTURES, 'transcripts')
const UPDATE = process.argv.includes('--update')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

type Rec = Record<string, unknown>
interface Transcript {
  readonly main: Rec[]
  readonly subagents: Map<string, ClaudeSubagentTranscript>
}

/** One redacted read-API dump (main chain + subagents keyed by parent call). */
function readTranscript(name: string): Transcript {
  const lines = readFileSync(join(TRANSCRIPTS, `${name}.jsonl`), 'utf8').split('\n').filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as { kind: 'main' | 'subagent'; agentId?: string; msg: Rec })
  const main = lines.filter(line => line.kind === 'main').map(line => line.msg)
  const byAgent = new Map<string, Rec[]>()
  for (const line of lines) {
    if (line.kind !== 'subagent' || line.agentId === undefined) continue
    byAgent.set(line.agentId, [...byAgent.get(line.agentId) ?? [], line.msg])
  }
  const subagents = new Map<string, ClaudeSubagentTranscript>()
  for (const [agentId, messages] of byAgent) {
    const parent = messages.find(message => typeof message.parent_tool_use_id === 'string')?.parent_tool_use_id
    if (typeof parent === 'string') subagents.set(parent, { agentId, messages })
  }
  return { main, subagents }
}

interface Projected {
  readonly replay: ClaudeReplay
  readonly harness: ReturnType<typeof createProjectorHarness>
}

/** Replay one transcript through the shared projector. */
function project(name: string, title?: string): Projected {
  const { main, subagents } = readTranscript(name)
  const replay = replayClaudeTranscript(main, { cwd: '/fixture/project', subagents, ...(title === undefined ? {} : { title }) })
  const harness = createProjectorHarness({ model: '' })
  harness.apply(replay.events, true)
  harness.projector.settleStreaming()
  return { replay, harness }
}

/** The compact, deterministic view a golden stores. */
function golden(result: Projected): unknown {
  const state = result.harness.state
  return {
    start: result.replay.start,
    events: result.replay.events.map(event => event.type === 'assistant.delta' ? `delta:${event.delta.kind}` : event.type === 'turn.end' ? `turn.end:${event.reason.kind}` : event.type === 'turn.start' ? `turn.start:${event.origin}` : event.type),
    rows: state.rows.map(row => ({
      kind: row.kind,
      text: row.text.length > 160 ? `${row.text.slice(0, 160)}…` : row.text,
      ...(row.anchor === undefined ? {} : { anchor: row.anchor }),
      ...(row.streaming === true ? { streaming: true } : {}),
      ...(row.reasoningTokens === undefined ? {} : { reasoningTokens: row.reasoningTokens }),
      ...(row.tool === undefined ? {} : {
        tool: {
          name: row.tool.name,
          status: row.tool.status,
          result: row.tool.resultView === undefined ? null : row.tool.resultView.card,
          ...(row.tool.errorText === undefined ? {} : { errorText: row.tool.errorText.slice(0, 120) }),
          ...(row.tool.resultText === undefined ? {} : { resultText: row.tool.resultText.slice(0, 120) }),
        },
      }),
    })),
    state: {
      working: state.working,
      model: state.model,
      sessionTitle: state.sessionTitle,
      tokens: { input: state.tokens.input, output: state.tokens.output, cacheRead: state.tokens.cacheRead, cacheWrite: state.tokens.cacheWrite },
      compaction: state.compaction ?? null,
      notices: result.harness.notices,
    },
  }
}

const names = readdirSync(TRANSCRIPTS).filter(file => file.endsWith('.jsonl')).map(file => file.slice(0, -'.jsonl'.length)).sort()
check('transcripts cover tool calls, compaction, subagents, interrupts, fold-ins and notifications', ['tool-read', 'parallel-tool', 'compaction', 'subagent', 'interrupt-cancel', 'interrupt-now', 'fold-in-next', 'background-bash', 'resume-replay'].every(name => names.includes(name)), names)

const runs = new Map<string, Projected>()
for (const name of names) {
  const result = project(name)
  runs.set(name, result)
  const path = join(TRANSCRIPTS, `${name}.golden.json`)
  const actual = `${JSON.stringify(golden(result), null, 2)}\n`
  if (UPDATE) {
    writeFileSync(path, actual)
    console.log(`updated transcripts/${name}.golden.json`)
    continue
  }
  check(`${name}: golden exists`, existsSync(path))
  check(`${name}: matches golden`, readFileSync(path, 'utf8') === actual, `run with --update and review the diff for ${name}`)
}

const run = (name: string): Projected => runs.get(name)!
const ofType = <T extends AgentEvent['type']>(events: readonly AgentEvent[], type: T): AgentEventOf<T>[] => events.filter((event): event is AgentEventOf<T> => event.type === type)
const userRows = (name: string) => run(name).harness.state.rows.filter(row => row.kind === 'user')

// ── turns and anchors ──────────────────────────────────────────────────
{
  const { main } = readTranscript('tool-read')
  const prompt = main.find(message => message.type === 'user' && typeof (message.message as Rec).content === 'string')!
  const rows = userRows('tool-read')
  check('a prompt is a user row anchored at its message uuid', rows.length === 1 && rows[0]!.anchor === prompt.uuid, rows)
  const events = run('tool-read').replay.events
  check('one turn per prompt, closed as completed', ofType(events, 'turn.start').length === 1 && ofType(events, 'turn.end').every(event => event.reason.kind === 'completed'))
  const calls = ofType(events, 'tool.call')
  const results = ofType(events, 'tool.result')
  check('tool results pair with their calls by tool_use_id', calls.length > 0 && calls.every(call => results.some(result => result.callId === call.callId)))
  check('… and settle the card', run('tool-read').harness.state.rows.filter(row => row.kind === 'tool').every(row => row.tool?.status !== 'running'))
  check('the replayed history leaves no open turn', !run('tool-read').harness.state.working)
}
{
  const events = run('parallel-tool').replay.events
  check('parallel calls in one message settle both cards', ofType(events, 'tool.call').length === 2 && ofType(events, 'tool.result').length === 2)
}

// ── what never becomes a bubble ─────────────────────────────────────────
{
  const rows = run('compaction').harness.state.rows
  check('/compact shows no user row of its own', !rows.some(row => row.kind === 'user'))
  check('local-command echoes and stdout are hidden', !rows.some(row => row.text.includes('<local-command') || row.text.includes('<command-name>')))
  const compactAt = rows.findIndex(row => row.kind === 'compact')
  check('the compact summary renders the compaction rows', compactAt > 0 && rows[compactAt - 1]!.kind === 'notice' && rows[compactAt - 1]!.text === t('compact-done') && rows[compactAt]!.text.includes('pineapple'))
  check('… the preserved tail follows the summary (the model-visible chain)', rows.slice(compactAt + 1).some(row => row.kind === 'assistant' && row.text === 'ok'))
  const events = run('compaction').replay.events
  check('… and the boundary is a settled compaction end', ofType(events, 'compaction.end').length === 1 && ofType(events, 'compaction.end')[0]!.ok && run('compaction').harness.state.compaction === undefined)
}
{
  const events = run('fold-in-next').replay.events
  const rows = userRows('fold-in-next')
  check('a queued prompt joins the running turn (one turn, two user rows)', ofType(events, 'turn.start').length === 1 && rows.length === 2 && rows[1]!.text.includes('NEXT-OK'))
}
{
  const events = run('interrupt-cancel').replay.events
  check('[Request interrupted …] closes the turn as aborted, never a bubble', ofType(events, 'turn.end').at(-1)?.reason.kind === 'aborted' && !userRows('interrupt-cancel').some(row => row.text.includes('Request interrupted')))
  check('… the interrupt row renders', run('interrupt-cancel').harness.state.rows.some(row => row.kind === 'interrupt'))
}
{
  const events = run('background-bash').replay.events
  const starts = ofType(events, 'turn.start')
  check('a task notification opens the notification turn', starts.length === 2 && starts[1]!.origin === 'notification')
  check('… with its notice, and the notification text is no bubble', events.some(event => event.type === 'notice' && event.text === t('claude-notification-turn')) && !userRows('background-bash').some(row => row.text.includes('task-notification')))
}

// ── thinking ───────────────────────────────────────────────────────────
{
  const rows = run('tool-read').harness.state.rows.filter(row => row.kind === 'reasoning')
  check('empty thinking replays the API\'s own count as the one-line row', rows.length > 0 && rows.every(row => row.text === '' && typeof row.reasoningTokens === 'number' && row.reasoningTokens > 0), rows)
}

// ── subagents ──────────────────────────────────────────────────────────
{
  const events = run('subagent').replay.events
  const call = ofType(events, 'tool.call').find(event => event.name === 'Agent')!
  const start = ofType(events, 'subagent.start')[0]
  const end = ofType(events, 'subagent.end')[0]
  const callAt = events.indexOf(call)
  const resultAt = events.findIndex(event => event.type === 'tool.result' && event.callId === call.callId)
  check('the subagent starts right after its Agent call', start !== undefined && start.parentCallId === call.callId && events.indexOf(start) > callAt && events.indexOf(start) < resultAt)
  check('… and ends after the call\'s result, its state from the transcript tail', end !== undefined && events.indexOf(end) > resultAt && end.status === 'completed' && (end.summary ?? '').length > 0)
  const { subagents } = readTranscript('subagent')
  const subTexts = [...subagents.values()].flatMap(agent => agent.messages).flatMap(message => {
    const content = (message.message as Rec | undefined)?.content
    return Array.isArray(content) ? content.flatMap(block => (block as Rec).type === 'text' ? [String((block as Rec).text)] : []) : []
  })
  check('subagent messages stay off the main transcript', subTexts.length > 0 && !run('subagent').harness.state.rows.some(row => subTexts.some(text => text !== '' && row.text === text)))
}

// ── replay = live for the same recorded session ─────────────────────────
type Line = { dir: string; msg?: Rec; placement?: 'turn' | 'steer' | 'followup' | 'now' }
const liveRows = (name: string) => {
  const translator = createClaudeTranslator({ cwd: '/fixture/project', userRows: 'lifecycle', now: () => 0 })
  const harness = createProjectorHarness({ model: '' })
  const lines = readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Line)
  for (const line of lines) {
    if (line.dir === 'in' && line.msg !== undefined) {
      const body = line.msg.message as { content?: unknown } | undefined
      translator.registerInput(String(line.msg.uuid), typeof body?.content === 'string' ? body.content : '', line.placement ?? 'turn')
      continue
    }
    if (line.dir === 'out') harness.apply(translator.translate(line.msg))
  }
  harness.projector.settleStreaming()
  return harness.state.rows
}
const shape = (rows: readonly { kind: string; text: string; anchor?: string; tool?: { name: string } }[]): string[] =>
  rows.filter(row => row.kind === 'user' || row.kind === 'assistant' || row.kind === 'tool' || row.kind === 'interrupt')
    .map(row => `${row.kind}:${row.kind === 'tool' ? row.tool?.name : row.text.trim()}${row.anchor === undefined ? '' : `@${row.anchor}`}`)
for (const name of ['tool-read', 'parallel-tool', 'fold-in-next', 'subagent', 'interrupt-cancel']) {
  const live = shape(liveRows(name))
  const replayed = shape(run(name).harness.state.rows)
  check(`${name}: the replay paints what live painted (rows, order, anchors)`, JSON.stringify(live) === JSON.stringify(replayed), { live, replayed })
}

// ── live after a resume continues the numbering ─────────────────────────
{
  const resumed = run('tool-read')
  const harness = createProjectorHarness({ model: '' })
  harness.apply(resumed.replay.events, true)
  harness.projector.settleStreaming()
  const before = harness.state.rows.length
  const maxSeq = Math.max(...resumed.replay.events.flatMap(event => 'seq' in event && typeof event.seq === 'number' ? [event.seq] : []))
  check('the replay reports where the numbering ends', resumed.replay.start.turn === ofType(resumed.replay.events, 'turn.start').length && resumed.replay.start.seq === maxSeq && resumed.replay.start.model !== undefined)
  // The resumed session's live translator starts there; a recorded turn
  // follows (the simple-text stream, its input registered as live).
  const translator = createClaudeTranslator({ cwd: '/fixture/project', userRows: 'lifecycle', now: () => 0, start: resumed.replay.start })
  const lines = readFileSync(join(FIXTURES, 'simple-text.jsonl'), 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Line)
  const live: AgentEvent[] = []
  for (const line of lines) {
    if (line.dir === 'in' && line.msg !== undefined) {
      translator.registerInput(String(line.msg.uuid), String((line.msg.message as Rec).content), 'turn')
      continue
    }
    if (line.dir !== 'out') continue
    const batch = translator.translate(line.msg)
    live.push(...batch)
    harness.apply(batch)
  }
  harness.projector.settleStreaming()
  const turns = ofType(live, 'turn.start').map(event => event.turn)
  const seqs = live.flatMap(event => 'seq' in event && typeof event.seq === 'number' ? [event.seq] : [])
  check('live turns after a resume continue past the replayed ones', turns.length > 0 && turns.every(turn => turn > resumed.replay.start.turn), turns)
  check('… and so do sequence numbers (no seq the projector would deduplicate)', seqs.length > 0 && seqs.every(seq => seq > maxSeq), seqs)
  check('… no live model.changed for the model the replay restored', !live.some(event => event.type === 'model.changed' && event.model === resumed.replay.start.model))
  const added = harness.state.rows.slice(before)
  check('the live turn paints after the whole history, nothing dropped', harness.state.rows.slice(0, before).every((row, index) => row === resumed.harness.state.rows[index] || row.text === resumed.harness.state.rows[index]?.text)
    && added.some(row => row.kind === 'user') && added.some(row => row.kind === 'assistant' && row.text.includes('hello fixture')), added.map(row => `${row.kind}:${row.text.slice(0, 30)}`))
}

// ── the recorded resume session: tool call + subagent + compaction + a later turn ──
{
  const result = run('resume-replay')
  const events = result.replay.events
  const rows = result.harness.state.rows
  check('resume-replay: the turn after the compaction is replayed after the compaction rows', rows.findIndex(row => row.kind === 'compact') >= 0 && rows.findIndex(row => row.kind === 'compact') < rows.findLastIndex(row => row.kind === 'user'))
  check('resume-replay: a model restored for the status line', events.at(-1)?.type === 'model.changed' && result.harness.state.model.includes('haiku'))
  check('resume-replay: a subagent whose launching call was compacted away is not inserted', readTranscript('resume-replay').subagents.size === 1 && !events.some(event => event.type === 'subagent.start' || event.type === 'subagent.end'))
  const titled = project('resume-replay', 'A titled session')
  check('a catalog title replays as the session title', titled.harness.state.sessionTitle === 'A titled session')
}

// ── rewind cut point and preview ────────────────────────────────────────
{
  const { main } = readTranscript('fold-in-next')
  const first = main[0]!
  const queued = main.find(message => message.isQueuedCommand === true)!
  check('no cut before the first message (nothing to rewind to)', rewindCutPoint(main, String(first.uuid)) === undefined)
  check('the cut is the chain entry right before the picked message', rewindCutPoint(main, String(queued.uuid)) === main[main.indexOf(queued) - 1]!.uuid)
  check('an unknown anchor has no cut', rewindCutPoint(main, 'not-in-chain') === undefined)
  const preview = previewEntries(main, 2)
  check('the preview is the chain\'s tail exchanges (prompts and replies, newest last)', preview.length === 2 && preview[0]!.role === 'user' && preview[1]!.role === 'assistant' && preview[1]!.text.includes('NEXT-OK'), preview)
  const compactPreview = previewEntries(readTranscript('compaction').main, 6)
  check('… without local-command echoes or the summary', compactPreview.every(entry => !entry.text.includes('<command-name>') && !entry.text.includes('continued from a previous conversation')), compactPreview)
}

console.log(`\nverify-claude-replay OK (${passed} checks)`)
process.exit(0)
