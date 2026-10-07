/**
 * Codex live ≡ replay gate (docs/codex-backend-design.md §10.4): for every
 * thread of every wire fixture that also recorded the thread's full history,
 * (a) the live notifications and (b) the recorded turns run through the
 * shared item mapping into the shared projector, and the two transcripts
 * must agree row for row (ids, times and the smooth-reveal flag ignored).
 *
 * The only registered differences, each asserted to really occur so the
 * comparison never passes vacuously:
 *  - interrupted tool cards: an item interrupted mid-run never completes and
 *    never reaches history (F11), so live keeps an "interrupted" card that
 *    replay cannot have;
 *  - turn summaries and token counts: history records no per-call usage, so
 *    only live books it;
 *  - notices of the live stream (warnings, retries, status) and the todo
 *    panel of `turn/plan/updated`: not part of a thread's history.
 * Question answers are not transcript rows on this backend (F23), so there
 * is nothing to exempt for them.
 *
 * Run: node --import tsx/esm scripts/verify-codex-live-replay.ts
 */
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { setLang, t } from '../src/i18n.js'
import { assertAgentEventInvariants } from './lib/agent-event-invariants.js'
import { liveRun, loadWire, notificationsOf, recordedTurns, replayRun, turnThreads, WIRE_DIR, type TranslateRun } from './lib/codex-translate-harness.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 1)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

/** A transcript row as both paths must agree on it. */
function comparable(run: TranslateRun, side: 'live' | 'replay'): { rows: string[]; exempt: { interrupted: number; summaries: number; notices: number } } {
  const exempt = { interrupted: 0, summaries: 0, notices: 0 }
  const rows: string[] = []
  for (const row of run.harness.state.rows) {
    if (row.kind === 'turn-summary') { exempt.summaries += 1; continue }
    if (side === 'live' && row.kind === 'tool' && row.tool?.status === 'error' && row.tool.errorText === t('codex-interrupted')) { exempt.interrupted += 1; continue }
    if (side === 'live' && row.kind === 'notice' && run.liveOnlyNotices.has(row.text)) { exempt.notices += 1; continue }
    const tool = row.tool === undefined ? undefined : {
      name: row.tool.name,
      status: row.tool.status,
      args: row.tool.argsText,
      call: row.tool.callView,
      result: row.tool.resultView,
      resultText: row.tool.resultText ?? null,
      errorText: row.tool.errorText ?? null,
    }
    rows.push(JSON.stringify({ kind: row.kind, text: row.text, anchor: row.anchor ?? null, ...(tool === undefined ? {} : { tool }) }))
  }
  return { rows, exempt }
}

/** Fixtures whose history was recorded by a second connection. */
const HISTORY_FROM: Readonly<Record<string, { readonly fixture: string; readonly which: 'last' | number }>> = {
  // p1 runs the turns; p2 reads them back before it reverts and compacts.
  's3-lifecycle-p1': { fixture: 's3-lifecycle-p2', which: 0 },
}

/** Fixtures whose live part has no recorded history to compare with. */
const NO_HISTORY: Readonly<Record<string, string>> = {
  // A second connection resumes, reverts and then compacts: its only live
  // turn (the compaction) happens after the last recorded read.
  's3-lifecycle-p2': 'the compaction turn ran after the last recorded read',
}

const fixtures = readdirSync(WIRE_DIR).filter(file => file.endsWith('.jsonl')).map(file => file.slice(0, -'.jsonl'.length)).sort()
let compared = 0
let interruptedSeen = 0
for (const name of fixtures) {
  const wire = loadWire(name)
  if (NO_HISTORY[name] !== undefined) {
    console.log(`SKIP ${name} (${NO_HISTORY[name]})`)
    continue
  }
  for (const thread of turnThreads(wire)) {
    const source = HISTORY_FROM[name]
    const turns = source === undefined ? recordedTurns(wire, thread) : recordedTurns(loadWire(source.fixture), thread, source.which)
    if (turns === undefined) {
      console.log(`SKIP ${name} ${thread.slice(-6)} (no recorded history of this thread)`)
      continue
    }
    const liveSource = liveRun(notificationsOf(wire, thread))
    const replaySource = replayRun(turns)
    const allowOpenLastTurn = name === 's1-approvals' && thread === turnThreads(wire)[0]
    assertAgentEventInvariants(liveSource.events, { allowOpenLastTurn })
    assertAgentEventInvariants(replaySource.events, { allowOpenLastTurn })
    const live = comparable(liveSource, 'live')
    const replayed = comparable(replaySource, 'replay')
    const label = `${name} ${thread.slice(-6)}`
    const diff = live.rows.flatMap((row, index) => row === replayed.rows[index] ? [] : [{ index, live: row, replay: replayed.rows[index] ?? null }])
    check(`${label}: live and replay transcripts agree (${live.rows.length} rows)`, live.rows.length === replayed.rows.length && diff.length === 0,
      { liveRows: live.rows.length, replayRows: replayed.rows.length, first: diff[0] ?? replayed.rows[live.rows.length] })
    check(`${label}: replay produced no exempt rows of its own`, replayed.exempt.interrupted === 0 && replayed.exempt.notices === 0 && replayed.exempt.summaries === 0, replayed.exempt)
    check(`${label}: replay never manufactures billing or occupancy measurements`, replaySource.events.every(event => event.type !== 'usage' && event.type !== 'context.usage'))
    const attempts = (run: TranslateRun): number => run.events.filter(event => event.type === 'assistant.attempt.end').length
    check(`${label}: live and replay explicitly close the same attempts`, attempts(liveSource) === attempts(replaySource), { live: attempts(liveSource), replay: attempts(replaySource) })
    interruptedSeen += live.exempt.interrupted
    compared += 1
  }
}
check('every fixture with recorded history was compared (≥ 9 threads)', compared >= 9, compared)
check('the interrupted-card exemption really occurs (s2, c0 approval/interrupt)', interruptedSeen === 2, interruptedSeen)

// Numbering continues across replay → live (§7.6).
{
  const wire = loadWire('s2-steer-interrupt-diff')
  const thread = turnThreads(wire)[0]!
  const replay = replayRun(recordedTurns(wire, thread)!)
  check('replay advances the shared context (turns, seq) for the live half', replay.ctx.turn === 3 && replay.ctx.seq > 0 && !replay.ctx.turnOpen)
}

console.log(`\nverify-codex-live-replay OK (${passed} checks)`)
