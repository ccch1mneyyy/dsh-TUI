/**
 * Lifecycle invariants across ALL committed DSH/Claude/Codex JSONL fixtures,
 * both live and replay paths. Reads only scrubbed repository fixtures. No
 * processes, personal transcripts, credential stores or provider requests.
 * Run: node --import tsx/esm scripts/verify-agent-event-invariants.ts
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import type { AgentEvent } from '../src/agent/events.js'
import { createDshTranslator } from '../src/dsh-adapter/backend/translate.js'
import { createClaudeTranslator } from '../src/backends/claude/translate.js'
import { replayClaudeTranscript, type ClaudeSubagentTranscript } from '../src/backends/claude/replay.js'
import { createItemContext } from '../src/backends/codex/translate/items.js'
import { createLiveTranslator } from '../src/backends/codex/translate/live.js'
import { replayTurns } from '../src/backends/codex/translate/replay.js'
import { setLang } from '../src/i18n.js'
import { agentEventInvariantViolations, assertAgentEventInvariants, type AgentEventInvariantOptions } from './lib/agent-event-invariants.js'
import { loadWire, notificationsOf, recordedTurns, turnThreads, WIRE_DIR } from './lib/codex-translate-harness.js'

setLang('en')
type Rec = Record<string, unknown>
const FIXTURES = join(import.meta.dirname, 'fixtures')
const read = (file: string): Rec[] => readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Rec)
const rec = (value: unknown): Rec => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Rec : {}
const jsonlFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? jsonlFiles(join(dir, entry.name)) : entry.name.endsWith('.jsonl') ? [join(dir, entry.name)] : []).sort()
let streams = 0
let eventCount = 0
const failures: string[] = []
const verify = (label: string, events: readonly AgentEvent[], options: AgentEventInvariantOptions = {}): void => {
  const errors = agentEventInvariantViolations(events, options)
  streams += 1
  eventCount += events.length
  if (errors.length > 0) failures.push(label + ':\n' + errors.map(error => '  ' + error.code + ' @' + error.index + ' ' + error.type + ': ' + error.detail).join('\n'))
  else console.log('PASS ' + label + ' (' + events.length + ' events)')
}
const unclosedSourceTurn = (source: readonly Rec[]): boolean => {
  const open = new Set<unknown>()
  for (const event of source) {
    if (event.type === 'turn/start') open.add(rec(event.data).turn)
    if (event.type === 'turn/end') open.delete(rec(event.data).turn)
  }
  return open.size > 0
}

// DSH's frames are the live tail following the durable seed, on both paths
// (the same order as the golden pipeline). Empty/missing frame files are fine.
for (const file of jsonlFiles(join(FIXTURES, 'dsh')).filter(file => !file.endsWith('.frames.jsonl'))) {
  const source = read(file)
  const frames = file.replace(/\.jsonl$/u, '.frames.jsonl')
  for (const replay of [false, true]) {
    const translator = createDshTranslator({ tools: () => undefined, scope: () => ({}), attachments: () => undefined })
    const log = source as unknown as Parameters<typeof translator.translateReplay>[0]
    const events = replay ? [...translator.translateReplay(log)] : log.flatMap(event => [...translator.translateEvent(event)])
    if (existsSync(frames)) for (const frame of read(frames)) events.push(...translator.translateFrame(frame as unknown as Parameters<typeof translator.translateFrame>[0]))
    verify(relative(FIXTURES, file) + (replay ? ' replay' : ' live'), events, { allowOpenLastTurn: unclosedSourceTurn(source) })
  }
}

// Every Claude format: live wire, SDK read-API main/subagent dumps, notice
// messages and the on-disk bench chain. Replays use the real replay adapter,
// not a second mapping. Input admission is indexed before its output events.
for (const file of jsonlFiles(join(FIXTURES, 'claude'))) {
  const source = read(file)
  const transcript = source.some(line => line.kind === 'main' || line.kind === 'subagent')
  const wire = source.some(line => line.dir === 'in' || line.dir === 'out')
  const main: Rec[] = []
  const child = new Map<string, Rec[]>()
  const uuids = new Set<unknown>()
  const addMain = (message: Rec): void => {
    if (message.type !== 'assistant' && message.type !== 'user') return
    if (message.uuid !== undefined && uuids.has(message.uuid)) return
    if (message.uuid !== undefined) uuids.add(message.uuid)
    main.push(message)
  }
  const translator = createClaudeTranslator({ cwd: '/fixture/project', userRows: wire ? 'lifecycle' : 'replay', now: () => 0 })
  const events: AgentEvent[] = []
  const enqueuedInputs: { id: string; beforeEvent: number }[] = []
  let recordingOpen = false
  let hasResult = false
  for (const line of source) {
    const message = rec(line.msg ?? line)
    if (transcript && line.kind === 'subagent') {
      const id = String(line.agentId)
      const messages = child.get(id) ?? []
      messages.push(message)
      child.set(id, messages)
    } else addMain(message)
    if (wire && line.dir === 'in') {
      const placement = line.placement === 'steer' || line.placement === 'followup' || line.placement === 'now' ? line.placement : 'turn'
      const id = String(message.uuid)
      const content = rec(message.message).content
      translator.registerInput(id, typeof content === 'string' ? content : '', placement)
      if (placement === 'steer' || placement === 'followup') enqueuedInputs.push({ id, beforeEvent: events.length })
      continue
    }
    if (wire && line.dir !== 'out') continue
    if (message.parent_tool_use_id === undefined || message.parent_tool_use_id === null) {
      if (message.type === 'command_lifecycle' && message.state === 'started') recordingOpen = true
      if (message.type === 'result') { recordingOpen = false; hasResult = true }
    }
    events.push(...translator.translate(message))
  }
  // A read-API dump has no result records: as a live stream it is a prefix.
  // Wire tails only get the exception when their native lifecycle is open.
  verify(relative(FIXTURES, file) + ' live', events, { enqueuedInputs, allowOpenLastTurn: wire ? recordingOpen : !hasResult })
  const recorded = join(FIXTURES, 'claude', 'transcripts', basename(file))
  if (wire && existsSync(recorded)) {
    // A wire echo lacks the read API's isQueuedCommand / compact metadata.
    // Use the actual paired dump when recorded, never infer that metadata.
    const rows = read(recorded)
    main.splice(0, main.length, ...rows.filter(line => line.kind === 'main').map(line => rec(line.msg)))
    child.clear()
    for (const line of rows) if (line.kind === 'subagent') {
      const id = String(line.agentId)
      const messages = child.get(id) ?? []
      messages.push(rec(line.msg))
      child.set(id, messages)
    }
  }
  const subagents = new Map<string, ClaudeSubagentTranscript>()
  for (const [agentId, messages] of child) {
    const parent = messages.find(message => typeof message.parent_tool_use_id === 'string')?.parent_tool_use_id
    if (typeof parent === 'string') subagents.set(parent, { agentId, messages })
  }
  verify(relative(FIXTURES, file) + ' replay', replayClaudeTranscript(main, { cwd: '/fixture/project', subagents }).events)
}

// Codex live notifications and every recorded full history of each thread.
// p1's history was read by the p2 connection (as the existing equivalence gate).
for (const file of readdirSync(WIRE_DIR).filter(file => file.endsWith('.jsonl')).sort()) {
  const name = file.slice(0, -'.jsonl'.length)
  const wire = loadWire(name)
  for (const thread of turnThreads(wire)) {
    const notifications = notificationsOf(wire, thread)
    const context = createItemContext({ cwd: '/TMP/cwd', now: () => 0 })
    const translator = createLiveTranslator(context, { model: '', effort: null, modeId: 'auto' })
    const events = notifications.flatMap(({ method, params }) => translator.notification(method, params))
    const open = new Set<unknown>()
    for (const { method, params } of notifications) {
      if (method === 'turn/started') open.add(rec(params.turn).id)
      if (method === 'turn/completed') open.delete(rec(params.turn).id)
    }
    const label = 'codex/' + name + ' thread ' + thread.slice(-6)
    verify(label + ' live', events, { allowOpenLastTurn: open.size > 0 })
    let turns = name === 's3-lifecycle-p1' ? recordedTurns(loadWire('s3-lifecycle-p2'), thread, 0) : recordedTurns(wire, thread)
    let replaySource = ' replay'
    if (turns === undefined) {
      // Some ephemeral/child threads recorded no read API response. Their
      // actual turn notifications are replayable native snapshots too, but
      // completed notifications contain summary items, not full tool history.
      const snapshots = new Map<unknown, Rec>()
      for (const { method, params } of notifications) {
        if (method === 'turn/started' || method === 'turn/completed') {
          const turn = rec(params.turn)
          snapshots.set(turn.id, turn)
        }
      }
      turns = [...snapshots.values()]
      replaySource = ' replay (native turn snapshots; no full history)'
    }
    const last = rec(turns.at(-1))
    verify(label + replaySource, replayTurns(turns, createItemContext({ cwd: '/TMP/cwd', now: () => 0 })), { allowOpenLastTurn: last.status === 'inProgress' })
  }
}

// Mutation probes: prove the checker rejects each broken invariant, rather
// than passing because a fixture never exercised that branch.
const start: AgentEvent = { type: 'turn.start', turn: 1, origin: 'user', time: 0 }
const end: AgentEvent = { type: 'turn.end', turn: 1, time: 2, reason: { kind: 'completed' } }
const attempt: AgentEvent = { type: 'assistant.attempt.start', attemptId: 'a', turn: 1, step: 1 }
const message: AgentEvent = { type: 'assistant.message', seq: 1, anchor: 'a', attemptId: 'a', turn: 1, step: 1, time: 1, blocks: [], canonical: true }
const call: AgentEvent = { type: 'tool.call', callId: 'c', name: 'fixture', seq: 2, turn: 1, step: 1, time: 1, argsJson: '{}' }
const rejects = (code: string, events: readonly AgentEvent[], options?: AgentEventInvariantOptions): void => {
  assert.ok(agentEventInvariantViolations(events, options).some(error => error.code === code), 'mutation did not fail: ' + code)
}
assertAgentEventInvariants([start, attempt, message, { type: 'assistant.attempt.end', attemptId: 'a', outcome: 'committed' }, call, end])
assertAgentEventInvariants([start, message, end, { type: 'usage', turn: 1, seq: 2, time: 3, usage: { input: 1 } }])
rejects('turn-outside', [message])
rejects('turn-overlap', [start, { ...start, turn: 2 }])
rejects('turn-unclosed', [start])
rejects('seq-order', [start, message, message, end])
rejects('attempt-unclosed', [start, attempt, end])
rejects('tool-unclosed', [{ ...call, parentCallId: 'background' }])
rejects('request-unclosed', [{ type: 'question.request', request: { requestId: 'q', questions: [] } }])
rejects('request-unclosed', [{ type: 'permission.request', request: { requestId: 'p', toolName: 'fixture', options: [] } }])
rejects('pending-unseen', [{ type: 'pending.changed', items: [], claimed: ['missing'] }])
assertAgentEventInvariants([start, attempt, call], { allowOpenLastTurn: true })
assertAgentEventInvariants([{ type: 'pending.changed', items: [{ id: 'queued', text: '', placement: 'steer' }] }, { type: 'pending.changed', items: [], claimed: ['queued'] }])

if (failures.length > 0) {
  console.error(failures.join('\n\n'))
  process.exitCode = 1
} else console.log('\nverify-agent-event-invariants OK (' + streams + ' streams, ' + eventCount + ' events; mutation probes passed)')
