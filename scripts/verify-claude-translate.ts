/**
 * Claude translator gate (docs/agent-backend-design.md §5.1, §8.3): every
 * redacted SDK recording in scripts/fixtures/claude/*.jsonl runs through
 * `createClaudeTranslator` and then the ONE shared projector, and the result
 * — the event-type sequence, the transcript rows and the status-relevant
 * channel state — must equal the committed `<fixture>.golden.json`.
 * Targeted assertions pin each Phase 0 correction on top of the goldens.
 *
 * The fixtures are recorded by scripts/probes/claude-sdk-record.mjs and
 * redacted by scripts/fixtures/claude/redact.mjs (no network here).
 *
 * Run:    node --import tsx/esm scripts/verify-claude-translate.ts
 * Update: node --import tsx/esm scripts/verify-claude-translate.ts --update
 *         (review the golden diff: it IS the behaviour change)
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from '../src/agent/events.js'
import { claudeEmits, createClaudeTranslator } from '../src/backends/claude/translate.js'
import { setLang } from '../src/i18n.js'
import { createProjectorHarness } from './lib/projector-harness.js'

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
  const harness = createProjectorHarness({ model: '' })
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
    },
  }
}

const names = readdirSync(FIXTURES).filter(file => file.endsWith('.jsonl')).map(file => file.slice(0, -'.jsonl'.length)).sort()
check('fixtures cover the Phase 2 scenarios', ['simple-text', 'thinking-tokens', 'tool-read', 'write-edit', 'bash', 'interrupt-now', 'interrupt-cancel', 'fold-in-next', 'compaction', 'permission-deny', 'background-bash'].every(name => names.includes(name)), names)

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

// ── interrupts (Phase 0 corrections) ──────────────────────────────────
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
  const deny = get('permission-deny')
  check('denied permission: the tool card errors with the deny message', deny.harness.state.rows.some(row => row.kind === 'tool' && row.tool?.status === 'error' && (row.tool.errorText ?? '').includes('interactive approvals arrive in the next phase')))
  const background = get('background-bash')
  check('background Bash: a background shell task starts', of(background.events, 'task.start').some(event => event.background && event.kind === 'shell'))
  check('background Bash: the notification turn is not a user turn', of(background.events, 'turn.start').some(event => event.origin === 'notification') && background.harness.state.rows.some(row => row.kind === 'notice'))
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
