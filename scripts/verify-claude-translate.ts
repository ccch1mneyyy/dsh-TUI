/**
 * Claude translator gate: every redacted SDK recording in
 * scripts/fixtures/claude/*.jsonl runs through `createClaudeTranslator` and
 * then the one shared projector, and the result (the event-type sequence,
 * the transcript rows and the status-relevant channel state) must equal the
 * committed `<fixture>.golden.json`. Targeted assertions on top of the
 * goldens pin individual behaviours: interrupts, compaction, parallel tools,
 * subagents, task kinds.
 *
 * The fixtures are recorded by scripts/probes/claude-sdk-record.mjs and
 * redacted by scripts/fixtures/claude/redact.mjs (no network here).
 *
 * Run:    node --import tsx/esm scripts/verify-claude-translate.ts
 * Update: node --import tsx/esm scripts/verify-claude-translate.ts --update
 *         (review the golden diff: it is the behaviour change)
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from '../src/agent/events.js'
import { claudeEmits, createClaudeTranslator } from '../src/backends/claude/translate.js'
import { getLang, setLang } from '../src/i18n.js'
import { installClaudeLocale } from '../src/backends/claude/text.js'
import { createProjectorHarness } from './lib/projector-harness.js'

// The translator is driven directly here (no session), so the backend's copy
// takes its language straight from the host, exactly as `open()` wires it.
installClaudeLocale(getLang)
setLang('en')
const FIXTURES = join(import.meta.dirname, 'fixtures', 'claude')
const UPDATE = process.argv.includes('--update')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

type Line = { t: number; dir: 'in' | 'out' | 'ctl' | 'perm'; msg?: Record<string, unknown>; placement?: 'turn' | 'steer' | 'followup' | 'now' }
const readLines = (name: string): Line[] => readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8')
  .split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Line)

interface Run {
  readonly events: AgentEvent[]
  readonly harness: ReturnType<typeof createProjectorHarness>
}

/** Replay one fixture through translator + projector (stepping clock). */
function run(name: string): Run {
  let clock = Date.UTC(2026, 9, 1, 12, 0, 0)
  const now = (): number => (clock += 7)
  const translator = createClaudeTranslator({ cwd: '/fixture/project', userRows: 'lifecycle', now })
  // As the channel core projects a non-DSH session: subagents and jobs too.
  const harness = createProjectorHarness({ model: '', activity: true, now })
  const events: AgentEvent[] = []
  const realNow = Date.now
  // The projector reads the wall clock for row timing; pin it too.
  Date.now = now
  try {
    for (const line of readLines(name)) {
      if (line.dir === 'in' && line.msg !== undefined) {
        const body = line.msg.message as { content?: unknown } | undefined
        const text = typeof body?.content === 'string' ? body.content : ''
        translator.registerInput(String(line.msg.uuid), text, line.placement ?? 'turn')
        continue
      }
      if (line.dir !== 'out') continue
      const batch = translator.translate(line.msg)
      events.push(...batch)
      harness.apply(batch)
    }
    harness.projector.settleStreaming()
  } finally {
    Date.now = realNow
  }
  return { events, harness }
}

/** The golden view of one run: compact, deterministic, review-friendly. */
function golden(result: Run): unknown {
  const state = result.harness.state
  return {
    events: result.events.map(event => event.type === 'assistant.delta' ? `delta:${event.delta.kind}` : event.type),
    rows: state.rows.map(row => ({
      kind: row.kind,
      text: row.text.length > 160 ? `${row.text.slice(0, 160)}…` : row.text,
      ...(row.streaming === true ? { streaming: true } : {}),
      ...(row.reasoningTokens === undefined ? {} : { reasoningTokens: row.reasoningTokens }),
      ...(row.tool === undefined ? {} : {
        tool: {
          name: row.tool.name,
          status: row.tool.status,
          call: row.tool.callView === undefined ? null : { card: row.tool.callView.card, displayKey: row.tool.callView.displayKey ?? null, category: row.tool.callView.category ?? null },
          result: row.tool.resultView === undefined ? null : { card: row.tool.resultView.card, ...('shape' in row.tool.resultView ? { shape: row.tool.resultView.shape } : {}) },
          ...(row.tool.errorText === undefined ? {} : { errorText: row.tool.errorText.slice(0, 120) }),
          ...(row.tool.resultText === undefined ? {} : { resultText: row.tool.resultText.slice(0, 120) }),
        },
      }),
      ...(row.subagent === undefined ? {} : {
        subagent: {
          agentId: row.subagent.agentId,
          status: row.subagent.status,
          kind: row.subagent.provider ?? null,
          background: row.subagent.background ?? false,
          tools: row.subagent.toolCalls.map(tool => `${tool.name}:${tool.status}`),
          outputLines: row.subagent.outputLines,
          tokens: row.subagent.tokens?.total ?? null,
          summary: row.subagent.summary === undefined ? null : row.subagent.summary.slice(0, 120),
        },
      }),
      ...(row.job === undefined ? {} : {
        job: { id: row.job.id, kind: row.job.kind, label: row.job.label, status: row.job.status, detail: row.job.detail ?? null },
      }),
    })),
    state: {
      working: state.working,
      model: state.model,
      costReport: state.costReport ?? null,
      contextWindow: state.contextWindow ?? null,
      tokens: { input: state.tokens.input, output: state.tokens.output, cacheRead: state.tokens.cacheRead, cacheWrite: state.tokens.cacheWrite },
      todos: state.todos,
      compaction: state.compaction ?? null,
      notices: result.harness.notices,
      subagents: state.subagents.map(sub => ({ agentId: sub.agentId, status: sub.status, depth: sub.depth ?? null, output: sub.output.length })),
      jobs: state.backgroundJobs.map(job => ({ id: job.id, status: job.status, command: job.command ?? null, outputFile: job.outputFile ?? null })),
    },
  }
}

const names = readdirSync(FIXTURES).filter(file => file.endsWith('.jsonl')).map(file => file.slice(0, -'.jsonl'.length)).sort()
check('fixtures cover the §8.3 scenarios', ['simple-text', 'partial-text', 'thinking-tokens', 'tool-read', 'parallel-tool', 'write-edit', 'bash', 'interrupt-now', 'interrupt-cancel', 'fold-in-next', 'compaction', 'permission-allow', 'permission-deny', 'subagent', 'background-bash'].every(name => names.includes(name)), names)

const runs = new Map<string, Run>()
for (const name of names) {
  const result = run(name)
  runs.set(name, result)
  const path = join(FIXTURES, `${name}.golden.json`)
  const actual = JSON.stringify(golden(result), null, 2) + '\n'
  if (UPDATE) {
    writeFileSync(path, actual)
    console.log(`updated ${name}.golden.json`)
    continue
  }
  check(`${name}: golden exists`, existsSync(path))
  check(`${name}: matches golden`, readFileSync(path, 'utf8') === actual, `run with --update and review the diff for ${name}`)
}
if (UPDATE) process.exit(0)

const of = <T extends AgentEvent['type']>(events: readonly AgentEvent[], type: T) =>
  events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type)
const get = (name: string): Run => runs.get(name)!

// ── vocabulary ────────────────────────────────────────────────────────
for (const [name, result] of runs) {
  const undeclared = [...new Set(result.events.map(event => event.type))].filter(type => !claudeEmits(type))
  check(`${name}: only declared event types`, undeclared.length === 0, undeclared)
  // Every delta of an attempt follows that attempt's start (the projector
  // drops deltas of an attempt it never saw open).
  const started = new Set<string>()
  const orphan = result.events.find(event => {
    if (event.type === 'assistant.attempt.start') started.add(event.attemptId)
    return event.type === 'assistant.delta' && !started.has(event.attemptId)
  })
  check(`${name}: attempt.start precedes its deltas`, orphan === undefined, orphan)
  check(`${name}: one session.ready despite per-turn init`, of(result.events, 'session.ready').length === 1)
  check(`${name}: every turn closes`, of(result.events, 'turn.start').length === of(result.events, 'turn.end').length && !result.harness.state.working)
}

// ── simple text / thinking counts ─────────────────────────────────────
{
  const { harness } = get('simple-text')
  check('simple-text: the confirmed user bubble and the reply', harness.state.rows.some(row => row.kind === 'user' && row.text === 'Reply with exactly: hello fixture') && harness.state.rows.some(row => row.kind === 'assistant' && row.text === 'hello fixture'))
  check('simple-text: model from init, cost from result', harness.state.model !== '' && harness.state.costReport?.currency === 'USD' && harness.state.costReport.source === 'backend' && harness.state.costReport.amount > 0)
  check('simple-text: context window from modelUsage', (harness.state.contextWindow ?? 0) >= 100_000)
  const { harness: thinking } = get('thinking-tokens')
  const row = thinking.state.rows.find(candidate => candidate.kind === 'reasoning')
  check('thinking-tokens: a count-only thinking row survives settlement', row !== undefined && row.text === '' && (row.reasoningTokens ?? 0) > 0 && row.streaming !== true, row)
}

// ── tools ─────────────────────────────────────────────────────────────
{
  const read = get('tool-read').harness.state.rows.find(row => row.kind === 'tool')
  check('Read: read card with display key', read?.tool?.resultView?.card === 'read' && read.tool.callView?.displayKey === 'tool-name-read' && read.tool.status === 'ok', read?.tool)
  const writeEdit = get('write-edit').harness.state.rows.filter(row => row.kind === 'tool')
  check('Write: diff card, mutate category', writeEdit.some(row => row.tool?.name === 'Write' && row.tool.resultView?.card === 'diff' && row.tool.callView?.category === 'mutate'))
  check('Edit: diff card from the original file', writeEdit.some(row => row.tool?.name === 'Edit' && row.tool.resultView?.card === 'diff' && row.tool.resultView.diffs[0]?.oldText !== null))
  const bash = get('bash')
  const results = of(bash.events, 'tool.result')
  check('Bash success: tool.result text filled', results.some(event => !event.isError && event.text.includes('fixture-ok')))
  check('Bash failure: errorText filled, text empty', results.some(event => event.isError && (event.errorText ?? '').includes('Exit code') && event.text === ''))
  check('Bash: terminal cards, exec category', bash.harness.state.rows.filter(row => row.kind === 'tool').every(row => row.tool?.callView?.card === 'terminal' && row.tool.callView.category === 'exec'))
}

// ── interrupts ────────────────────────────────────────────────────────
{
  const now = get('interrupt-now')
  const ends = of(now.events, 'turn.end')
  check('now: success + aborted_streaming closes as aborted (terminal_reason first)', ends[0]?.reason.kind === 'aborted', ends.map(event => event.reason))
  check('now: the follow-up turn completes', ends[1]?.reason.kind === 'completed')
  check('now: the aborted prefix stays in the transcript', now.harness.state.rows.some(row => row.kind === 'assistant' && row.text.startsWith('1\n2')))
  check('now: an interrupt row marks the abort', now.harness.state.rows.some(row => row.kind === 'interrupt'))
  const cancel = get('interrupt-cancel')
  check('interrupt(): error_during_execution + aborted_streaming is aborted, not an error', of(cancel.events, 'turn.end')[0]?.reason.kind === 'aborted')
  check('interrupt(): [ede_diagnostic] is never shown', !cancel.harness.state.rows.some(row => row.text.includes('ede_diagnostic')) && !cancel.harness.notices.some(text => text.includes('ede_diagnostic')))
  check('interrupt(): "[Request interrupted by user]" is not a user bubble', !cancel.harness.state.rows.some(row => row.kind === 'user' && row.text.startsWith('[Request interrupted')))
}

// ── fold-in / compaction / permissions / background ───────────────────
{
  const fold = get('fold-in-next')
  check('fold-in: the steered input joins the open turn', of(fold.events, 'turn.start').length === 1 && of(fold.events, 'user.message').length === 2)
  check('fold-in: the steer preview is claimed', of(fold.events, 'pending.changed').some(event => event.claimed?.length === 1))
  check('fold-in: a foreground Bash task_started makes no task card', of(fold.events, 'task.start').length === 0)
  const compaction = get('compaction')
  check('compaction: manual start, committed end', of(compaction.events, 'compaction.start').some(event => event.trigger === 'manual') && of(compaction.events, 'compaction.end').some(event => event.ok && (event.preTokens ?? 0) > 0))
  check('compaction: summary row, no /compact bubble, no local-command echo', compaction.harness.state.rows.some(row => row.kind === 'compact') && !compaction.harness.state.rows.some(row => row.kind === 'user' && (row.text === '/compact' || row.text.includes('local-command'))))
  // The summary does not rewrite the occupancy sample or the cumulative
  // input with a chars/4 estimate; the CLI-measured
  // `compact_boundary.post_tokens` re-seeds the sample instead (a compaction
  // turn makes no request of its own).
  {
    const boundary = compaction.events.findIndex(event => event.type === 'compaction.end' && event.ok)
    const summary = compaction.events.findIndex(event => event.type === 'user.message' && event.source === 'compaction')
    const end = compaction.events[boundary]
    const postTokens = end?.type === 'compaction.end' ? end.postTokens : undefined
    const cut = createProjectorHarness({ model: '', activity: true, now: () => 0 })
    cut.apply(compaction.events.slice(0, boundary + 1))
    const inputAtBoundary = cut.state.tokens.input
    check('compaction: post_tokens re-seeds the occupancy sample', postTokens !== undefined && cut.state.lastUsage?.input === postTokens && cut.state.lastUsage.cacheRead === 0, cut.state.lastUsage)
    cut.apply(compaction.events.slice(boundary + 1, summary + 1))
    check('compaction: the summary rewrites neither the sample nor the cumulative input', summary > boundary && cut.state.lastUsage?.input === postTokens && cut.state.tokens.input === inputAtBoundary, { lastUsage: cut.state.lastUsage, input: cut.state.tokens.input, inputAtBoundary })
  }
  const deny = get('permission-deny')
  check('denied permission: the tool card errors with the deny message', deny.harness.state.rows.some(row => row.kind === 'tool' && row.tool?.status === 'error' && (row.tool.errorText ?? '').includes('interactive approvals arrive in the next phase')))
  const background = get('background-bash')
  check('background Bash: a background shell task starts', of(background.events, 'task.start').some(event => event.background && event.kind === 'shell'))
  check('background Bash: the notification turn is not a user turn', of(background.events, 'turn.start').some(event => event.origin === 'notification') && background.harness.state.rows.some(row => row.kind === 'notice'))
  const jobs = background.harness.state.rows.filter(row => row.kind === 'job')
  check('background Bash: one job card after its Bash card, completed', jobs.length === 1 && jobs[0]!.job?.status === 'completed' && background.harness.state.rows.indexOf(jobs[0]!) === background.harness.state.rows.findIndex(row => row.kind === 'tool') + 1, background.harness.state.rows.map(row => row.kind))
  const job = background.harness.state.backgroundJobs[0]
  check('background Bash: the job knows its command and the output file the CLI named', job?.command === 'sleep 3; echo bg-done' && job.outputFile?.endsWith(`/tasks/${job.id}.output`) === true, job)
  check('background Bash: the output file comes from the acknowledgement, before the end', of(background.events, 'task.update').some(event => event.patch.outputFile !== undefined) && background.events.findIndex(event => event.type === 'task.update') < background.events.findIndex(event => event.type === 'task.end'))
}

// ── parallel tools / subagent channel / allowed permission / partials ──
{
  // The CLI drains the first result while the same API message still
  // streams the second call; the attempt stays open.
  const parallel = get('parallel-tool')
  const cards = parallel.harness.state.rows.filter(row => row.kind === 'tool')
  check('parallel: both Read calls get a card', cards.length === 2 && cards.every(row => row.tool?.name === 'Read'), cards.map(row => row.tool?.name))
  check('parallel: both results land on their cards', cards.every(row => row.tool?.status === 'ok' && row.tool.resultView?.card === 'read'), cards.map(row => row.tool?.status))
  const calls = of(parallel.events, 'tool.call').map(event => event.callId)
  check('parallel: every result pairs with a call', of(parallel.events, 'tool.result').every(event => calls.includes(event.callId)) && calls.length === 2)
  const firstMessage = of(parallel.events, 'assistant.message')[0]
  check('parallel: the first message settles after its second call, with its output usage', firstMessage !== undefined && (firstMessage.usage?.output ?? 0) > 0
    && parallel.events.indexOf(firstMessage) > parallel.events.indexOf(of(parallel.events, 'tool.call')[1]!), firstMessage?.usage)
  check('parallel: no late-block drop', parallel.harness.state.rows.some(row => row.kind === 'assistant' && row.text.trim() !== ''))
  const bash = get('bash').harness.state.rows.filter(row => row.kind === 'tool')
  check('bash: both calls of the one message get cards', bash.length === 2, bash.length)

  const sub = get('subagent')
  check('subagent: subagent channel messages stay off the main transcript', sub.harness.state.rows.filter(row => row.kind === 'user').length === 1 && sub.harness.state.rows.filter(row => row.kind === 'tool').length === 0 && sub.harness.state.rows.filter(row => row.kind === 'assistant').length === 1, sub.harness.state.rows.map(row => row.kind))
  // The `Agent` call pre-creates the subagent, `task_started` completes it
  // on the same lane: one subagent, one card, no task card.
  const starts = of(sub.events, 'subagent.start')
  check('subagent: the call pre-creates it, task_started completes it on the same lane', starts.length === 2 && starts[0]!.agentId === starts[0]!.parentCallId && starts[1]!.parentCallId === starts[0]!.parentCallId && starts[1]!.agentId !== starts[0]!.agentId && starts[1]!.depth === 1, starts)
  check('subagent: one subagent ends, no task card', of(sub.events, 'subagent.end').length === 1 && of(sub.events, 'task.end').length === 0 && sub.harness.state.rows.filter(row => row.kind === 'job').length === 0)
  const card = sub.harness.state.rows.filter(row => row.kind === 'subagent')
  check('subagent: one card, keyed by the task id, completed with its tool and report', card.length === 1 && card[0]!.subagent?.agentId === starts[1]!.agentId && card[0]!.subagent.status === 'completed'
    && card[0]!.subagent.toolCalls.length === 1 && card[0]!.subagent.toolCalls[0]!.name === 'Read' && card[0]!.subagent.toolCalls[0]!.status === 'completed'
    && (card[0]!.subagent.summary ?? '').includes('Fixture project') && (card[0]!.subagent.tokens?.total ?? 0) > 0, card[0]?.subagent)
  const lane = sub.events.filter(event => (event.type === 'tool.call' || event.type === 'tool.result' || event.type === 'assistant.message') && event.parentCallId !== undefined)
  check('subagent: its own Read and text arrive on its lane (parentCallId)', lane.some(event => event.type === 'tool.call' && event.name === 'Read') && lane.some(event => event.type === 'tool.result') && lane.some(event => event.type === 'assistant.message'), lane.map(event => event.type))
  check('subagent: the card sits where the Agent call was (before the reply)', sub.harness.state.rows.findIndex(row => row.kind === 'subagent') < sub.harness.state.rows.findIndex(row => row.kind === 'assistant'), sub.harness.state.rows.map(row => row.kind))
  check('subagent: the main reply survives', sub.harness.state.rows.some(row => row.kind === 'assistant' && row.text.trim() !== ''))

  const allow = get('permission-allow')
  check('allowed permission: the Write card succeeds', allow.harness.state.rows.some(row => row.kind === 'tool' && row.tool?.name === 'Write' && row.tool.status === 'ok'))
  const partial = get('partial-text')
  const textDeltas = of(partial.events, 'assistant.delta').filter(event => event.delta.kind === 'text').length
  const reply = partial.harness.state.rows.find(row => row.kind === 'assistant')
  check('partial text: many deltas settle into one complete reply', textDeltas > 1 && reply !== undefined && reply.text.split('\n').filter(line => line.trim() !== '').length >= 5 && reply.streaming !== true, { textDeltas, text: reply?.text })
}

// ── task kinds / origins / message-level structured result ────────────
{
  const background = get('background-bash')
  check('background Bash: a job ends as a task, never as a subagent', of(background.events, 'task.end').length === 1 && of(background.events, 'subagent.end').length === 0)
  check('fold-in: a foreground Bash report ends nothing', of(get('fold-in-next').events, 'task.end').length === 0 && of(get('fold-in-next').events, 'subagent.end').length === 0)
  const translator = createClaudeTranslator({ cwd: '/fixture/project', userRows: 'lifecycle' })
  const unknown = translator.translate({ type: 'command_lifecycle', command_uuid: 'not-ours', state: 'started' })
  check('a started frame for an unknown uuid opens a system turn', of(unknown, 'turn.start')[0]?.origin === 'system' && of(unknown, 'user.message').length === 0, unknown)
  const replay = createClaudeTranslator({ cwd: '/fixture/project', userRows: 'replay' })
  replay.registerInput('mine', 'hello', 'turn')
  const started = replay.translate({ type: 'command_lifecycle', command_uuid: 'mine', state: 'started' })
  check('echo fallback: started for our input opens a user turn', of(started, 'turn.start')[0]?.origin === 'user' && of(started, 'turn.start')[0]?.userMessageId === 'mine', started)
  const echoed = replay.translate({ type: 'user', isReplay: true, uuid: 'mine', message: { role: 'user', content: 'hello' } })
  check('echo fallback: the echo brings the row into the same turn', of(echoed, 'user.message').length === 1 && of(echoed, 'turn.start').length === 0)
  const two = createClaudeTranslator({ cwd: '/fixture/project', userRows: 'lifecycle' })
  two.translate({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', model: 'x', usage: {} } } })
  two.translate({ type: 'assistant', message: { id: 'm1', content: [
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/fixture/project/a' } },
    { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/fixture/project/b' } },
  ] } })
  const results = two.translate({ type: 'user', tool_use_result: { file: { filePath: '/fixture/project/a', content: 'A' } }, message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't1', content: 'A' },
    { type: 'tool_result', tool_use_id: 't2', content: 'B' },
  ] } })
  check('a message-level tool_use_result is not applied to several result blocks', of(results, 'tool.result').length === 2 && of(results, 'tool.result').every(event => event.structured === undefined))
}

// ── robustness ────────────────────────────────────────────────────────
{
  const translator = createClaudeTranslator({ cwd: '/fixture/project', userRows: 'lifecycle' })
  check('unknown message types are ignored', translator.translate({ type: 'totally_new_kind', data: 1 }).length === 0)
  check('unknown system subtypes are ignored', translator.translate({ type: 'system', subtype: 'brand_new_subtype' }).length === 0)
  check('non-objects are ignored', translator.translate(null).length === 0 && translator.translate('text').length === 0 && translator.translate([1]).length === 0)
  check('a forced close without a turn is a no-op', translator.forceCloseTurn({ kind: 'aborted' }).length === 0)
}

console.log(`\nverify-claude-translate OK (${passed} checks, ${names.length} fixtures)`)
