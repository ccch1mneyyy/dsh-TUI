/**
 * Deterministic generator for the DSH projection fixtures the projection
 * goldens replay. Every `<name>.jsonl` holds one durable `SessionEvent` per
 * line (the persisted log a resume replays); the optional
 * `<name>.frames.jsonl` holds the transient `agent/assistant-stream` frames a
 * client receives after that log (an in-flight attempt), one
 * `AssistantStreamFrame` per line.
 *
 * Together the fixtures cover every DSH event family the translator
 * (src/dsh-adapter/backend/translate.ts) handles. Shapes
 * follow the installed declarations (`@deepseek-ai/dsh-session` SessionEventMap,
 * `@deepseek-ai/dsh-llm` messages/streams, `@deepseek-ai/dsh-agent`
 * AssistantStreamFrame, plugin augmentations for todo/write, agent-preset/
 * selected and session/title) plus the real payloads of the compaction and goal
 * producers. All text is synthetic. Ids, times and order are fixed, so a re-run
 * is byte-identical; `--check` fails instead of writing when a committed file
 * drifted from this generator.
 *
 * Run: node --import tsx/esm scripts/fixtures/dsh/generate.ts [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

export const FIXTURE_DIR = import.meta.dirname

/** Monday 09:30 in UTC+8: inside the DeepSeek peak window (cost buckets). */
const PEAK = Date.UTC(2026, 0, 5, 1, 30, 0)
/** Monday 21:00 in UTC+8: outside it. */
const IDLE = Date.UTC(2026, 0, 5, 13, 0, 0)

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json | undefined }
type FixtureEvent = { readonly type: string; readonly seq: number; readonly time: number; readonly data: Json } & Record<string, Json>
type FixtureFrame = Record<string, Json>

export interface Fixture {
  readonly name: string
  readonly description: string
  readonly events: readonly FixtureEvent[]
  readonly frames: readonly FixtureFrame[]
}

/** Appends events with contiguous seqs and a controllable clock. */
class SessionLog {
  readonly events: FixtureEvent[] = []
  private clock: number
  constructor(start: number) {
    this.clock = start
  }

  at(time: number): this {
    this.clock = time
    return this
  }

  wait(ms: number): this {
    this.clock += ms
    return this
  }

  now(): number {
    return this.clock
  }

  add(type: string, data: Json, envelope: Record<string, Json> = {}): number {
    const seq = this.events.length
    this.events.push({ type, seq, time: this.clock, data, ...envelope })
    this.clock += 20
    return seq
  }

  /** A model-visible event (system/user/assistant/tool message) on the surface. */
  surface(type: string, data: Json, surfaceOp: Json = 'append', sourceEventSeqs?: number[]): number {
    return this.add(type, data, { surfaceOp, ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }) })
  }
}

const text = (value: string): Json => ({ type: 'text', text: value })
const reasoning = (value: string): Json => ({ type: 'reasoning', text: value })
const toolCallBlock = (id: string, name: string, args: string): Json => ({ type: 'tool-call', id, name, arguments: args })

const userMessage = (id: string, content: readonly Json[], source: Json): Json => ({ id, role: 'user', content, source })
const systemMessage = (id: string, body: string): Json => ({ id, role: 'system', content: [text(body)], source: { kind: 'system-prompt' } })
const assistantMessage = (id: string, model: string, content: readonly Json[]): Json => ({
  id,
  role: 'assistant',
  content,
  source: { kind: 'model', provider: 'fixture', model },
})
/** 0.1.7+ tool-role result: output on the message itself. */
const toolResult = (id: string, callId: string, content: readonly Json[], isError = false): Json => ({
  id,
  role: 'tool',
  content,
  source: { kind: 'tool', callId },
  toolCallId: callId,
  ...(isError ? { isError: true } : {}),
})
/** Pre-0.1.7 result: one wrapping `tool-result` block (compat/messages.ts). */
const legacyToolResult = (id: string, callId: string, content: readonly Json[], isError: boolean): Json => ({
  id,
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: callId, content, isError }],
  source: { kind: 'tool', callId },
  toolCallId: callId,
})

const usage = (value: TokenUsage): Json => ({ ...value })
const header = (model: string, reasoningEffort?: string, tools?: readonly string[]): Json => ({
  config: { provider: 'fixture', model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
  ...(tools === undefined ? {} : { tools: tools.map(name => ({ name, description: `Fixture tool ${name}`, parameters: { type: 'object' } })) }),
})

/**
 * Compact V3 attempt stream (`AssistantStreamRecord[]`): raw block-start/
 * block-end chunks around packed delta runs, then usage and finish. The
 * projection only reads whether `stream` is an array (canonical settlement);
 * the records still mirror what the accumulator persists.
 */
function attemptStream(time0: number, blocks: readonly ({ kind: 'text' | 'reasoning'; parts: readonly string[] } | { kind: 'tool'; id: string; name: string; args: string })[], tokens?: TokenUsage, finish: Json = { kind: 'stop' }): Json[] {
  const records: Json[] = []
  let time = time0
  blocks.forEach((block, index) => {
    if (block.kind === 'tool') {
      records.push({ type: 'chunk', time, chunk: { type: 'block-start', index, blockType: 'tool-call' } })
      records.push({ type: 'tool-call-chunks', time0: time, index, dt: [0, 3], id: block.id, name: block.name, args: [block.args.slice(0, 4), block.args.slice(4)] })
      time += 6
      records.push({ type: 'chunk', time, chunk: { type: 'block-end', index, block: toolCallBlock(block.id, block.name, block.args) } })
      return
    }
    const blockType = block.kind === 'text' ? 'text' : 'reasoning'
    records.push({ type: 'chunk', time, chunk: { type: 'block-start', index, blockType } })
    records.push({ type: `${blockType}-chunks`, time0: time, index, dt: block.parts.map((_, i) => (i === 0 ? 0 : 7)), texts: [...block.parts] })
    time += 7 * block.parts.length
    records.push({ type: 'chunk', time, chunk: { type: 'block-end', index, block: { type: blockType, text: block.parts.join('') } } })
  })
  if (tokens !== undefined) records.push({ type: 'chunk', time, chunk: { type: 'usage', usage: usage(tokens) } })
  records.push({ type: 'chunk', time, chunk: { type: 'finish', reason: finish } })
  return records
}

/** Legacy `assistant/chunk` payload; only text/reasoning deltas were logged this way. */
const chunkData = (turn: number, step: number, chunk: Extract<StreamChunk, { type: 'text-delta' | 'reasoning-delta' }>): Json =>
  ({ turn, step, chunk: { type: chunk.type, index: chunk.index, text: chunk.text } })

/**
 * V3 core: turn/step boundaries, user prompt with an `@`-mention block,
 * request/context + request/header (model and effort changes), system/message,
 * canonical assistant/message with stream + usage + reasoning (peak and idle
 * buckets), a reasoning/tool-only step, an interrupted message closed by
 * turn/end aborted, a discarded assistant/attempt closed by turn/end error,
 * session/title + session/color, and an open fifth turn whose live attempts
 * arrive as frames (abandoned, committed-as-attempt, revision replay, unknown
 * attempt, then one left streaming).
 */
function v3Turns(): Fixture {
  const log = new SessionLog(PEAK)
  log.add('turn/start', { turn: 1 })
  log.surface('user/message', userMessage('msg-u1', [
    text('Summarize the fixture readme.'),
    text('<attached-file path="README.md">\n# Fixture\nSynthetic content for the projection golden.\n</attached-file>'),
  ], { kind: 'user' }))
  log.add('step/start', { turn: 1, step: 1 })
  log.add('request/context', { provider: 'fixture', model: 'fixture-model-a', contextWindow: 128000 })
  log.surface('system/message', { turn: 1, step: 1, message: systemMessage('msg-s1', 'You are the fixture agent. Answer briefly and cite file names.') })
  log.add('request/header', { header: header('fixture-model-a', 'medium'), reason: 'initial' })
  log.wait(900)
  const tokens1: TokenUsage = { inputTokens: 1200, outputTokens: 40, cacheReadTokens: 800, cacheWriteTokens: 64, totalTokens: 2104, reasoningTokens: 12 }
  log.surface('assistant/message', {
    turn: 1,
    step: 1,
    message: assistantMessage('msg-a1', 'fixture-model-a', [reasoning('The user wants a short summary.'), text('The readme describes a synthetic fixture.')]),
    stream: attemptStream(log.now() - 600, [{ kind: 'reasoning', parts: ['The user wants ', 'a short summary.'] }, { kind: 'text', parts: ['The readme describes ', 'a synthetic fixture.'] }], tokens1),
    usage: usage(tokens1),
  })
  log.add('step/end', { turn: 1, step: 1 })
  log.add('turn/end', { turn: 1, reason: { kind: 'completed' } })
  log.add('session/title', { title: 'Fixture summary', messageSeqs: [1], source: { kind: 'provider', provider: 'fixture', model: 'fixture-model-a' } })
  log.add('session/color', { color: 'cyan' }, { ignorable: true })

  log.wait(60_000)
  log.add('turn/start', { turn: 2 })
  log.surface('user/message', userMessage('msg-u2', [text('List the fixture directory, then read one file.')], { kind: 'user' }))
  log.add('step/start', { turn: 2, step: 1 })
  log.add('request/header', { header: header('fixture-model-a', 'medium', ['list_dir']), reason: 'change' })
  const tokens2: TokenUsage = { inputTokens: 300, outputTokens: 25, cacheReadTokens: 1900 }
  log.surface('assistant/message', {
    turn: 2,
    step: 1,
    message: assistantMessage('msg-a2', 'fixture-model-a', [reasoning('List the directory first.'), toolCallBlock('call_list_1', 'list_dir', '{"path":"."}')]),
    stream: attemptStream(log.now() - 400, [{ kind: 'reasoning', parts: ['List the directory first.'] }, { kind: 'tool', id: 'call_list_1', name: 'list_dir', args: '{"path":"."}' }], tokens2, { kind: 'tool-calls' }),
    usage: usage(tokens2),
  })
  log.add('tool/call', { turn: 2, step: 1, callId: 'call_list_1', name: 'list_dir', arguments: '{"path":"."}' })
  log.wait(150)
  log.surface('tool/result', { turn: 2, step: 1, message: toolResult('msg-t1', 'call_list_1', [text('README.md\nsrc/\npackage.json')]) })
  log.add('step/end', { turn: 2, step: 1 })
  log.add('step/start', { turn: 2, step: 2 })
  log.add('request/header', { header: header('fixture-model-a', 'medium', ['list_dir']), reason: 'series' })
  const tokens3: TokenUsage = { inputTokens: 90, outputTokens: 30, cacheReadTokens: 2200 }
  log.surface('assistant/message', {
    turn: 2,
    step: 2,
    message: assistantMessage('msg-a3', 'fixture-model-a', [text('The directory holds README.md, src/ and package.json.')]),
    stream: attemptStream(log.now() - 300, [{ kind: 'text', parts: ['The directory holds ', 'README.md, src/ and package.json.'] }], tokens3),
    usage: usage(tokens3),
  })
  log.add('step/end', { turn: 2, step: 2 })
  log.add('turn/end', { turn: 2, reason: { kind: 'completed' } })

  log.at(IDLE)
  log.add('request/context', { provider: 'fixture', model: 'fixture-model-b', contextWindow: 64000 })
  log.add('turn/start', { turn: 3 })
  log.surface('user/message', userMessage('msg-u3', [text('Write a long essay about fixtures.')], { kind: 'user' }))
  log.add('step/start', { turn: 3, step: 1 })
  log.add('request/header', { header: header('fixture-model-b', 'high'), reason: 'change' })
  const tokens4: TokenUsage = { inputTokens: 500, outputTokens: 8 }
  log.surface('assistant/message', {
    turn: 3,
    step: 1,
    message: assistantMessage('msg-a4', 'fixture-model-b', [reasoning('Plan the essay.'), text('Fixtures are')]),
    stream: attemptStream(log.now() - 200, [{ kind: 'reasoning', parts: ['Plan the essay.'] }, { kind: 'text', parts: ['Fixtures ', 'are'] }], tokens4, { kind: 'aborted', failure: { message: 'cancelled by user', code: 'ABORTED' } }),
    usage: usage(tokens4),
    interrupted: true,
  })
  log.add('step/end', { turn: 3, step: 1 })
  log.add('turn/end', { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } })

  log.wait(30_000)
  log.add('turn/start', { turn: 4 })
  log.surface('user/message', userMessage('msg-u4', [text('Try again.')], { kind: 'user' }))
  log.add('step/start', { turn: 4, step: 1 })
  log.add('request/header', { header: header('fixture-model-b', 'high'), reason: 'series' })
  log.add('assistant/attempt', {
    turn: 4,
    step: 1,
    stream: attemptStream(log.now() - 100, [{ kind: 'text', parts: ['Partial answer that ', 'never settled'] }], undefined, { kind: 'error', failure: { message: 'upstream unavailable', code: 'SERVER_ERROR', status: 503 } }),
  })
  log.add('turn/end', { turn: 4, reason: { kind: 'error', error: { message: 'upstream unavailable\nretry later', code: 'SERVER_ERROR', status: 503 } } })

  log.wait(30_000)
  log.add('turn/start', { turn: 5 })
  log.surface('user/message', userMessage('msg-u5', [text('Explain the frame protocol.')], { kind: 'user' }))
  log.add('step/start', { turn: 5, step: 1 })
  log.add('request/header', { header: header('fixture-model-b', 'high'), reason: 'series' })

  const t = log.now() + 500
  const frames: FixtureFrame[] = [
    { type: 'start', attemptId: 'attempt-a', revision: 1, turn: 5, step: 1 },
    { type: 'chunk', attemptId: 'attempt-a', revision: 2, index: 0, time: t, chunk: { type: 'reasoning-delta', index: 0, text: 'Considering frames' } },
    { type: 'chunk', attemptId: 'attempt-a', revision: 3, index: 1, time: t + 40, chunk: { type: 'text-delta', index: 1, text: 'Draft that will be abandoned' } },
    { type: 'end', attemptId: 'attempt-a', revision: 4, index: 2, outcome: { kind: 'abandoned' } },
    { type: 'start', attemptId: 'attempt-b', revision: 5, turn: 5, step: 1 },
    { type: 'chunk', attemptId: 'attempt-b', revision: 6, index: 0, time: t + 200, chunk: { type: 'text-delta', index: 0, text: 'Retry text recorded as an attempt' } },
    { type: 'end', attemptId: 'attempt-b', revision: 7, index: 1, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: log.events.length } },
    { type: 'start', attemptId: 'attempt-c', revision: 8, turn: 5, step: 1 },
    { type: 'chunk', attemptId: 'attempt-c', revision: 9, index: 0, time: t + 400, chunk: { type: 'reasoning-delta', index: 0, text: 'Frames carry revisions.' } },
    { type: 'chunk', attemptId: 'attempt-c', revision: 10, index: 1, time: t + 500, chunk: { type: 'text-delta', index: 1, text: 'Each frame has' } },
    // Replayed revision: dropped by the revision fence.
    { type: 'chunk', attemptId: 'attempt-c', revision: 10, index: 1, time: t + 500, chunk: { type: 'text-delta', index: 1, text: 'Each frame has' } },
    // A frame for an attempt nobody opened: ignored.
    { type: 'chunk', attemptId: 'attempt-x', revision: 11, index: 0, time: t + 550, chunk: { type: 'text-delta', index: 0, text: 'stray' } },
    { type: 'chunk', attemptId: 'attempt-c', revision: 12, index: 2, time: t + 1300, chunk: { type: 'text-delta', index: 1, text: ' a revision.' } },
    { type: 'chunk', attemptId: 'attempt-c', revision: 13, index: 3, time: t + 1400, chunk: { type: 'tool-call-delta', index: 2, id: 'call_frame_1', name: 'read_file', argumentsDelta: '{"path":' } },
  ]
  return {
    name: 'v3-turns',
    description: 'V3 turn/step/user/assistant/request/system/session families; aborted + error turns; open turn fed by live frames',
    events: log.events,
    frames,
  }
}

/**
 * Tool families: generic ok result (long, preview-clipped), error result with
 * failure identity, pre-0.1.7 wrapped results (ok + error), answered and
 * failed ask_user_question (card suppressed, record rows), subagent `task`
 * (card suppressed), background job start ack + job_output feed, harness goal
 * and todo result views, a call still running at turn end, and a reattached
 * attempt with no start frame that binds to the open step.
 */
function toolsJobs(): Fixture {
  const log = new SessionLog(IDLE)
  log.add('request/context', { provider: 'fixture', model: 'fixture-model-a', contextWindow: 128000 })
  log.add('turn/start', { turn: 1 })
  log.surface('user/message', userMessage('msg-u1', [text('Run the fixture tool tour.')], { kind: 'user' }))
  log.add('step/start', { turn: 1, step: 1 })
  log.add('request/header', { header: header('fixture-model-a', undefined, ['read_file', 'bash', 'legacy_tool']), reason: 'initial' })
  const calls1 = [
    ['call_read_1', 'read_file', '{"path":"docs/guide.md"}'],
    ['call_bash_1', 'bash', '{"command":"exit 2"}'],
    ['call_legacy_1', 'legacy_tool', '{"query":"ok"}'],
    ['call_legacy_2', 'legacy_tool', '{"query":"fail"}'],
  ] as const
  const tokens1: TokenUsage = { inputTokens: 700, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 700 }
  log.surface('assistant/message', {
    turn: 1,
    step: 1,
    message: assistantMessage('msg-a1', 'fixture-model-a', [text('Starting the tour.'), ...calls1.map(([id, name, args]) => toolCallBlock(id, name, args))]),
    stream: attemptStream(log.now() - 300, [{ kind: 'text', parts: ['Starting the tour.'] }, ...calls1.map(([id, name, args]) => ({ kind: 'tool' as const, id, name, args }))], tokens1, { kind: 'tool-calls' }),
    usage: usage(tokens1),
  })
  for (const [callId, name, args] of calls1) log.add('tool/call', { turn: 1, step: 1, callId, name, arguments: args })
  const guide = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}: the fixture guide explains one synthetic step in a deliberately long sentence.`).join('\n')
  log.surface('tool/result', { turn: 1, step: 1, message: toolResult('msg-t1', 'call_read_1', [text(guide)]) })
  log.surface('tool/result', {
    turn: 1,
    step: 1,
    message: toolResult('msg-t2', 'call_bash_1', [text('command failed with exit status 2')], true),
    error: { name: 'ToolError', code: 'NONZERO_EXIT', reason: 'exit status 2' },
  })
  log.surface('tool/result', { turn: 1, step: 1, message: legacyToolResult('msg-t3', 'call_legacy_1', [text('legacy ok')], false) })
  log.surface('tool/result', { turn: 1, step: 1, message: legacyToolResult('msg-t4', 'call_legacy_2', [text('legacy failure text')], true) })
  log.add('step/end', { turn: 1, step: 1 })

  log.add('step/start', { turn: 1, step: 2 })
  const askArgs = JSON.stringify({
    questions: [
      { question: 'Which palette?', header: 'Palette', options: [{ label: 'Warm', description: 'Reds' }, { label: 'Cool', description: 'Blues' }], multiSelect: false },
      { question: 'Any notes?', header: 'Notes', options: [{ label: 'None', description: 'Nothing to add' }], multiSelect: true },
    ],
  })
  const askArgs2 = JSON.stringify({ questions: [{ question: 'Proceed?', header: 'Go', options: [{ label: 'Yes', description: 'Continue' }], multiSelect: false }] })
  const taskArgs = JSON.stringify({ description: 'Survey the fixture tree', prompt: 'List the files and report.', subagent_type: 'explore' })
  const calls2 = [
    ['call_ask_1', 'ask_user_question', askArgs],
    ['call_task_1', 'task', taskArgs],
    ['call_ask_2', 'ask_user_question', askArgs2],
  ] as const
  log.surface('assistant/message', {
    turn: 1,
    step: 2,
    message: assistantMessage('msg-a2', 'fixture-model-a', calls2.map(([id, name, args]) => toolCallBlock(id, name, args))),
    stream: attemptStream(log.now() - 300, calls2.map(([id, name, args]) => ({ kind: 'tool' as const, id, name, args })), { inputTokens: 80, outputTokens: 70, cacheReadTokens: 1400 }, { kind: 'tool-calls' }),
    usage: usage({ inputTokens: 80, outputTokens: 70, cacheReadTokens: 1400 }),
  })
  for (const [callId, name, args] of calls2) log.add('tool/call', { turn: 1, step: 2, callId, name, arguments: args })
  log.wait(4000)
  log.surface('tool/result', { turn: 1, step: 2, message: toolResult('msg-t5', 'call_ask_1', [text('{"answers":[{"selected":["Cool"]},{"selected":[],"custom":"Keep it short"}]}')]) })
  log.surface('tool/result', { turn: 1, step: 2, message: toolResult('msg-t6', 'call_task_1', [text('Subagent finished: 3 files listed.')]) })
  log.surface('tool/result', {
    turn: 1,
    step: 2,
    message: toolResult('msg-t7', 'call_ask_2', [text('The user dismissed the question.')], true),
    error: { name: 'UserQuestionError', code: 'CANCELLED', reason: 'dismissed' },
  })
  log.add('step/end', { turn: 1, step: 2 })

  log.add('step/start', { turn: 1, step: 3 })
  const calls3 = [
    ['call_bash_2', 'bash', '{"command":"npm run build","run_in_background":true,"description":"Build"}'],
    ['call_job_1', 'job_output', '{"job_id":"job-7"}'],
    ['call_goal_1', 'goal_status', '{}'],
    ['call_todo_1', 'todo_write', '{"todos":[]}'],
    ['call_bash_3', 'bash', '{"command":"sleep 60"}'],
  ] as const
  log.surface('assistant/message', {
    turn: 1,
    step: 3,
    message: assistantMessage('msg-a3', 'fixture-model-a', calls3.map(([id, name, args]) => toolCallBlock(id, name, args))),
    stream: attemptStream(log.now() - 300, calls3.map(([id, name, args]) => ({ kind: 'tool' as const, id, name, args })), { inputTokens: 50, outputTokens: 90, cacheReadTokens: 1600 }, { kind: 'tool-calls' }),
    usage: usage({ inputTokens: 50, outputTokens: 90, cacheReadTokens: 1600 }),
  })
  for (const [callId, name, args] of calls3) log.add('tool/call', { turn: 1, step: 3, callId, name, arguments: args })
  log.surface('tool/result', { turn: 1, step: 3, message: toolResult('msg-t8', 'call_bash_2', [text('started background job job-7 (Build)')]) })
  log.wait(3000)
  log.surface('tool/result', { turn: 1, step: 3, message: toolResult('msg-t9', 'call_job_1', [text('compiling fixtures...\ndone in 3s')]) })
  log.surface('tool/result', { turn: 1, step: 3, message: toolResult('msg-t10', 'call_goal_1', [text('{"goal":{"objective":"Ship the fixtures","phase":"active","roundsStarted":1,"maxGoalRounds":3},"activation":"resumed"}')]) })
  log.surface('tool/result', { turn: 1, step: 3, message: toolResult('msg-t11', 'call_todo_1', [text('{"todos":[{"content":"Write generator","status":"completed"},{"content":"Capture goldens","status":"in_progress"},{"content":"Wire CI","status":"pending"}]}')]) })
  log.add('step/end', { turn: 1, step: 3 })
  log.add('turn/end', { turn: 1, reason: { kind: 'completed' } })

  log.wait(10_000)
  log.add('turn/start', { turn: 2 })
  log.surface('user/message', userMessage('msg-u2', [text('Continue after reconnect.')], { kind: 'user' }))
  log.add('step/start', { turn: 2, step: 1 })
  const t = log.now() + 300
  const frames: FixtureFrame[] = [
    // Reattach: no start frame; the open durable step adopts the attempt.
    { type: 'chunk', attemptId: 'attempt-reattach', revision: 1, index: 4, time: t, chunk: { type: 'tool-call-delta', index: 0, id: 'call_live_1', name: 'read_file', argumentsDelta: '{"path":"a.md"}' } },
    { type: 'chunk', attemptId: 'attempt-reattach', revision: 2, index: 5, time: t + 50, chunk: { type: 'text-delta', index: 1, text: 'Reading a.md next.' } },
    { type: 'end', attemptId: 'attempt-reattach', revision: 3, index: 6, outcome: { kind: 'abandoned' } },
  ]
  return {
    name: 'tools-jobs',
    description: 'tool/call + tool/result families, ask_user_question records, subagent task, background job ack + job_output, harness goal/todo views, reattached attempt',
    events: log.events,
    frames,
  }
}

/**
 * Plugin domain events: agent-preset/selected (including the code↔ptc
 * rename), top-level goal/change (create/pause/clear/block), goal-sourced
 * user/message round 0 with an inline change snapshot and round > 0
 * continuations, injected (skill-sourced) context, todo/write (valid and
 * malformed), session/title by the user, session/color set then cleared.
 */
function goalTodoPreset(): Fixture {
  const log = new SessionLog(PEAK + 3_600_000)
  const goal1 = { id: 'goal-1', objective: 'Draft the fixture plan', maxGoalRounds: 4 }
  const created = log.now()
  log.add('agent-preset/selected', { agentPreset: 'liangshen' })
  log.add('agent-preset/selected', { agentPreset: 'code' })
  log.add('goal/change', { kind: 'goal/change', version: 1, operation: 'create', goal: { ...goal1, revision: 1, phase: 'active' }, roundsStarted: 0, createdAt: created, updatedAt: created }, { ignorable: true })
  log.add('turn/start', { turn: 1 })
  log.surface('user/message', userMessage('msg-g0', [text('Goal updated: draft and review the fixture plan.')], {
    kind: 'goal',
    goalId: 'goal-1',
    revision: 2,
    round: 0,
    change: { kind: 'goal/change', version: 1, operation: 'edit', goal: { ...goal1, objective: 'Draft and review the fixture plan', revision: 2, phase: 'active' }, roundsStarted: 0, createdAt: created, updatedAt: log.now() },
  }))
  log.surface('user/message', userMessage('msg-i1', [text('<skill name="fixture-skill">Follow the fixture conventions.</skill>')], { kind: 'skill', name: 'fixture-skill', form: 'instructions' }))
  log.surface('user/message', userMessage('msg-u1', [text('Start with the outline.')], { kind: 'user' }))
  log.add('step/start', { turn: 1, step: 1 })
  log.add('request/header', { header: header('fixture-model-a', 'low'), reason: 'initial' })
  log.surface('assistant/message', {
    turn: 1,
    step: 1,
    message: assistantMessage('msg-a1', 'fixture-model-a', [text('Outline: scope, fixtures, goldens.')]),
    stream: attemptStream(log.now() - 200, [{ kind: 'text', parts: ['Outline: ', 'scope, fixtures, goldens.'] }], { inputTokens: 400, outputTokens: 12 }),
    usage: usage({ inputTokens: 400, outputTokens: 12 }),
  })
  log.add('step/end', { turn: 1, step: 1 })
  log.add('todo/write', { todos: [{ content: 'Outline', status: 'in_progress' }, { content: 'Review', status: 'pending' }] })
  log.add('turn/end', { turn: 1, reason: { kind: 'completed' } })

  log.add('turn/start', { turn: 2 })
  log.surface('user/message', userMessage('msg-g2', [text('Continue the goal (round 2).')], { kind: 'goal', goalId: 'goal-1', revision: 2, round: 2 }))
  log.add('step/start', { turn: 2, step: 1 })
  log.surface('assistant/message', {
    turn: 2,
    step: 1,
    message: assistantMessage('msg-a2', 'fixture-model-a', [text('Outline done; review next.')]),
    stream: attemptStream(log.now() - 200, [{ kind: 'text', parts: ['Outline done; ', 'review next.'] }], { inputTokens: 120, outputTokens: 9, cacheReadTokens: 400 }),
    usage: usage({ inputTokens: 120, outputTokens: 9, cacheReadTokens: 400 }),
  })
  log.add('step/end', { turn: 2, step: 1 })
  log.add('todo/write', { todos: [{ content: 'Malformed entry', status: 'unknown' }] })
  log.add('todo/write', { todos: [{ content: 'Outline', status: 'completed' }, { content: 'Review', status: 'in_progress' }] })
  log.add('goal/change', { kind: 'goal/change', version: 1, operation: 'pause', goal: { ...goal1, objective: 'Draft and review the fixture plan', revision: 3, phase: 'paused' }, roundsStarted: 2, createdAt: created, updatedAt: log.now() }, { ignorable: true })
  log.add('turn/end', { turn: 2, reason: { kind: 'completed' } })

  log.add('goal/change', { kind: 'goal/change', version: 1, operation: 'clear', roundsStarted: 2 }, { ignorable: true })
  const created2 = log.now()
  const goal2 = { id: 'goal-2', objective: 'Polish the goldens', maxGoalRounds: 2 }
  log.add('goal/change', { kind: 'goal/change', version: 1, operation: 'create', goal: { ...goal2, revision: 1, phase: 'active' }, roundsStarted: 0, createdAt: created2, updatedAt: created2 }, { ignorable: true })
  log.add('turn/start', { turn: 3 })
  log.surface('user/message', userMessage('msg-g3', [text('Continue the goal (round 1).')], { kind: 'goal', goalId: 'goal-2', revision: 1, round: 1 }))
  log.add('turn/end', { turn: 3, reason: { kind: 'completed' } })
  log.add('goal/change', { kind: 'goal/change', version: 1, operation: 'block', goal: { ...goal2, revision: 2, phase: 'blocked', blockedReason: { code: 'NEEDS_INPUT', message: 'Waiting for review' } }, roundsStarted: 1, createdAt: created2, updatedAt: log.now() }, { ignorable: true })
  log.add('session/title', { title: 'Goal fixture', messageSeqs: [], source: { kind: 'user' } })
  log.add('session/color', { color: 'magenta' }, { ignorable: true })
  log.add('session/color', { color: '' }, { ignorable: true })
  return {
    name: 'goal-todo-preset',
    description: 'agent-preset/selected, goal/change + goal-sourced user/message rounds, injected context, todo/write, session title/color',
    events: log.events,
    frames: [],
  }
}

/**
 * Pre-V3 and compaction history: legacy `system` header text, legacy
 * assistant/chunk deltas (cumulative prefix, overlap, repeat) settled by a
 * non-canonical assistant/message, a compaction bracket around a V4
 * checkpoint (`compact-checkpoint` source, surface replace) and a legacy
 * plugin checkpoint, developer/message, turn/end max-tokens + blocked, plugin
 * events with and without a renderer, and a crash-orphaned tail (chunks after
 * the last message, an unmatched compaction/start, turn/end interrupted).
 */
function compactionLegacy(): Fixture {
  const log = new SessionLog(PEAK + 7_200_000)
  const headerSeq = log.add('request/header', { header: { config: { provider: 'fixture', model: 'fixture-legacy' }, system: 'Legacy system prompt carried in the header.' }, reason: 'initial' })
  log.add('turn/start', { turn: 1 })
  const firstPrompt = log.surface('user/message', userMessage('msg-u1', [text('Say hello.')], { kind: 'user' }))
  log.add('step/start', { turn: 1, step: 1 })
  const t1 = log.now()
  log.at(t1).add('assistant/chunk', chunkData(1, 1, { type: 'reasoning-delta', index: 0, text: 'Greeting ' }))
  log.at(t1 + 50).add('assistant/chunk', chunkData(1, 1, { type: 'reasoning-delta', index: 0, text: 'the user.' }))
  log.at(t1 + 100).add('assistant/chunk', chunkData(1, 1, { type: 'text-delta', index: 1, text: 'Hello' }))
  // A reconnecting proxy re-sent the cumulative prefix, then an overlapping
  // tail, then the same tail again.
  log.at(t1 + 200).add('assistant/chunk', chunkData(1, 1, { type: 'text-delta', index: 1, text: 'Hello, wor' }))
  log.at(t1 + 700).add('assistant/chunk', chunkData(1, 1, { type: 'text-delta', index: 1, text: 'world!' }))
  log.at(t1 + 750).add('assistant/chunk', chunkData(1, 1, { type: 'text-delta', index: 1, text: 'world!' }))
  const firstAnswer = log.at(t1 + 800).surface('assistant/message', {
    turn: 1,
    step: 1,
    message: assistantMessage('msg-a1', 'fixture-legacy', [reasoning('Greeting the user.'), text('Hello, world!')]),
    usage: usage({ inputTokens: 100, outputTokens: 5 }),
  })
  log.add('step/end', { turn: 1, step: 1 })
  log.add('turn/end', { turn: 1, reason: { kind: 'completed' } })

  log.add('turn/start', { turn: 2 })
  const compactRequest = log.surface('user/message', userMessage('msg-u2', [text('Compact the history now.')], { kind: 'user' }))
  const start = log.add('compaction/start', { compactionId: 'compact-1', turn: 2 })
  const summary = log.add('compaction/summary', {
    compactionId: 'compact-1',
    summary: [text('The user greeted the agent; the agent said hello.')],
    shadowedRange: { start: firstPrompt, end: firstAnswer },
    shadowedSeqs: [firstPrompt, firstAnswer],
    shadowedTokenCount: 420,
    provider: 'fixture',
    model: 'fixture-legacy',
  }, { ignorable: true })
  log.surface('user/message', userMessage('msg-c1', [
    text('This is an automatically generated checkpoint condensing an earlier span of the conversation.\n\n<compacted-summary>'),
    text('The user greeted the agent; the agent said hello.'),
    text('</compacted-summary>'),
  ], { kind: 'compact-checkpoint', compactionId: 'compact-1' }), { op: 'replace', startSeq: firstPrompt, endSeq: firstAnswer }, [start, summary, firstPrompt, firstAnswer])
  log.add('compaction/end', { compactionId: 'compact-1', turn: 2 })
  log.add('turn/end', { turn: 2, reason: { kind: 'max-tokens' } })
  log.surface('user/message', userMessage('msg-c2', [text('Legacy checkpoint summary text.')], { kind: 'plugin', plugin: 'compact' }), { op: 'replace', startSeq: compactRequest, endSeq: compactRequest }, [compactRequest])
  log.add('fixture-plugin/note', { title: 'Fixture note', lines: ['first plugin line', 'second plugin line'] }, { ignorable: true })
  log.add('other-plugin/ping', { at: 1 }, { ignorable: true })

  log.add('turn/start', { turn: 3 })
  log.surface('user/message', userMessage('msg-u3', [text('Continue.')], { kind: 'user' }))
  log.add('step/start', { turn: 3, step: 1 })
  log.surface('developer/message', { turn: 3, step: 1, message: { id: 'msg-d1', role: 'developer', content: [{ type: 'tool-addition', toolName: 'read_file' }], source: { kind: 'tools' } }, headerSeq })
  log.surface('assistant/message', {
    turn: 3,
    step: 1,
    message: assistantMessage('msg-a3', 'fixture-legacy', [text('Continuing.')]),
    usage: usage({ inputTokens: 60, outputTokens: 3, cacheReadTokens: 30 }),
  })
  log.add('step/end', { turn: 3, step: 1 })
  log.add('turn/end', { turn: 3, reason: { kind: 'blocked' } })

  log.add('turn/start', { turn: 4 })
  log.surface('user/message', userMessage('msg-u4', [text('One more thing.')], { kind: 'user' }))
  log.add('step/start', { turn: 4, step: 1 })
  log.add('assistant/chunk', chunkData(4, 1, { type: 'reasoning-delta', index: 0, text: 'Thinking about the tail' }))
  log.add('assistant/chunk', chunkData(4, 1, { type: 'text-delta', index: 1, text: 'Partial tail' }))
  log.add('compaction/start', { compactionId: 'compact-2', turn: 4 })
  log.add('turn/end', { turn: 4, reason: { kind: 'interrupted' } })
  return {
    name: 'compaction-legacy',
    description: 'legacy header/system + assistant/chunk + non-canonical messages, compaction bracket with V4 and legacy checkpoints, developer/message, other turn/end reasons, plugin events, crash-orphaned tail',
    events: log.events,
    frames: [],
  }
}

export function buildFixtures(): Fixture[] {
  return [v3Turns(), toolsJobs(), goalTodoPreset(), compactionLegacy()]
}

const toJsonl = (rows: readonly unknown[]): string => rows.map(row => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '')

/** Files this generator owns, keyed by path, with their exact contents. */
export function fixtureFiles(fixtures: readonly Fixture[] = buildFixtures()): Map<string, string> {
  const files = new Map<string, string>()
  for (const fixture of fixtures) {
    files.set(join(FIXTURE_DIR, `${fixture.name}.jsonl`), toJsonl(fixture.events))
    if (fixture.frames.length > 0) files.set(join(FIXTURE_DIR, `${fixture.name}.frames.jsonl`), toJsonl(fixture.frames))
  }
  return files
}

const readOrUndefined = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Paths whose committed content differs from what the generator produces. */
export function staleFixtureFiles(): string[] {
  return [...fixtureFiles()].filter(([path, content]) => readOrUndefined(path) !== content).map(([path]) => path)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const stale = staleFixtureFiles()
    if (stale.length > 0) {
      console.error('DSH fixtures drifted from scripts/fixtures/dsh/generate.ts; re-run it:')
      for (const path of stale) console.error(`  - ${path}`)
      process.exit(1)
    }
    console.log('DSH fixtures match the generator')
  } else {
    for (const [path, content] of fixtureFiles()) writeFileSync(path, content)
    console.log(`wrote ${fixtureFiles().size} fixture files to ${FIXTURE_DIR}`)
  }
}
