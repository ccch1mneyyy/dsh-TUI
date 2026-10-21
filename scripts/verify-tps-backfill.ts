/**
 * Late-usage TPS backfill (channel projection): a backend that meters usage
 * SEPARATELY from the reply (Codex reports thread/tokenUsage/updated after
 * the message settles, before turn completion) must have its real output
 * token count retroactively replace the settle's stream-character estimate,
 * so the live tps and the turn-end sample read real tokens.
 *
 * Also locks the script-weighted live estimate (CJK ~1.4 chars/token, not
 * chars/4) and that a second usage report for the same step never applies
 * twice, nor one for a different step corrupts the fold.
 *
 * Run: node --import tsx/esm scripts/verify-tps-backfill.ts
 */
import type { AgentEvent } from '../src/agent/events.js'
import { createProjectorHarness } from './lib/projector-harness.js'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`)
  if (!ok) failed += 1
}
const near = (actual: unknown, expected: number, epsilon = 1e-6): boolean =>
  typeof actual === 'number' && Math.abs(actual - expected) <= epsilon

const B = 1_700_000_000_000
const harness = createProjectorHarness()
let seq = 0
const nextSeq = (): number => ++seq
const events = (...batch: AgentEvent[]): void => harness.apply(batch)
const delta = (attemptId: string, time: number, text: string): AgentEvent => ({
  type: 'assistant.delta', attemptId, index: 0, time, delta: { kind: 'text', text },
} as AgentEvent)
const settle = (attemptId: string, turn: number, step: number, time: number, usage?: { output: number }): AgentEvent => ({
  type: 'assistant.message', seq: nextSeq(), anchor: 'm1', attemptId, turn, step, time,
  blocks: [{ type: 'text', text: 'settled' }], canonical: true,
  ...(usage === undefined ? {} : { usage: { input: 10, ...usage } }),
} as AgentEvent)

// ── Turn 1: CJK live estimate, estimate settle, then the LATE real usage. ──
events(
  { type: 'turn.start', turn: 1, origin: 'user', time: B },
  { type: 'step.start', turn: 1, step: 1 },
  { type: 'assistant.attempt.start', attemptId: 'a1', turn: 1, step: 1 },
)
events(delta('a1', B + 1_000, '中'.repeat(278)))
events(delta('a1', B + 2_000, '！'))
check('live estimate is script-weighted (279 dense chars ≈ 200 tokens over 1s)', near(harness.state.tps, 200), String(harness.state.tps))
events(settle('a1', 1, 1, B + 3_000))
check('estimate settle keeps the weighted estimate (200 tok / 2s decode)', near(harness.state.tps, 100), String(harness.state.tps))
events({ type: 'usage', seq: nextSeq(), turn: 1, step: 1, time: B + 3_100, usage: { input: 1_000, output: 500 } })
check('late real usage backfills the step (500 tok / 2s decode)', near(harness.state.tps, 250), String(harness.state.tps))
events({ type: 'usage', seq: nextSeq(), turn: 1, step: 1, time: B + 3_150, usage: { input: 1_000, output: 999 } })
check('a second usage for the same step never applies twice', near(harness.state.tps, 250), String(harness.state.tps))
events({ type: 'usage', seq: nextSeq(), turn: 1, step: 7, time: B + 3_200, usage: { input: 1_000, output: 9_999 } })
check('a usage for another step leaves the fold alone', near(harness.state.tps, 250), String(harness.state.tps))
events({ type: 'step.end', turn: 1, step: 1 }, { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: B + 3_300 })
check('turn-end sample carries the backfilled rate', harness.state.tpsSamples.length === 1 && near(harness.state.tpsSamples[0]?.tps, 250), JSON.stringify(harness.state.tpsSamples))

// ── Turn 2: usage embedded in the settle is authoritative already; a later
// duplicate-ish usage for the same step must not double-count. ─────────────
events(
  { type: 'turn.start', turn: 2, origin: 'user', time: B + 10_000 },
  { type: 'step.start', turn: 2, step: 1 },
  { type: 'assistant.attempt.start', attemptId: 'a2', turn: 2, step: 1 },
)
events(delta('a2', B + 11_000, 'plain ascii reply'))
events(settle('a2', 2, 1, B + 12_000, { output: 120 }))
check('embedded usage settles the step at real tokens (120 / 1s)', near(harness.state.tps, 120), String(harness.state.tps))
events({ type: 'usage', seq: nextSeq(), turn: 2, step: 1, time: B + 12_100, usage: { input: 1_000, output: 400 } })
check('later usage for a real-token step does not re-apply', near(harness.state.tps, 120), String(harness.state.tps))
events({ type: 'step.end', turn: 2, step: 1 }, { type: 'turn.end', turn: 2, reason: { kind: 'completed' }, time: B + 12_200 })
check('second turn samples at the settled rate', harness.state.tpsSamples.length === 2 && near(harness.state.tpsSamples[1]?.tps, 120), JSON.stringify(harness.state.tpsSamples))

// ── Turn 3: the straggler arrives AFTER turn.end — the readout and the
// pushed sample are still corrected in place (Codex can meter past
// turn/completed; the closed turn's fold is kept one turn longer). ──────
events(
  { type: 'turn.start', turn: 3, origin: 'user', time: B + 20_000 },
  { type: 'step.start', turn: 3, step: 1 },
  { type: 'assistant.attempt.start', attemptId: 'a3', turn: 3, step: 1 },
)
events(delta('a3', B + 21_000, '中文回复'))
events(settle('a3', 3, 1, B + 22_000))
events({ type: 'step.end', turn: 3, step: 1 }, { type: 'turn.end', turn: 3, reason: { kind: 'completed' }, time: B + 22_100 })
const sampleAtEnd = harness.state.tpsSamples.at(-1)
check('turn-3 sample exists before the straggler', sampleAtEnd !== undefined && sampleAtEnd.tps > 0, JSON.stringify(harness.state.tpsSamples.at(-1)))
events({ type: 'usage', seq: nextSeq(), turn: 3, step: 1, time: B + 22_400, usage: { input: 1_000, output: 400 } })
check('post-end usage corrects the readout (400 tok / 1s decode)', near(harness.state.tps, 400), String(harness.state.tps))
check('post-end usage patches the pushed sample in place', harness.state.tpsSamples.at(-1) === sampleAtEnd && near(sampleAtEnd?.tps, 400), JSON.stringify(harness.state.tpsSamples.at(-1)))
events(
  { type: 'turn.start', turn: 4, origin: 'user', time: B + 30_000 },
  { type: 'step.start', turn: 4, step: 1 },
  { type: 'turn.end', turn: 4, reason: { kind: 'completed' }, time: B + 30_100 },
)
events({ type: 'usage', seq: nextSeq(), turn: 3, step: 1, time: B + 30_200, usage: { input: 1_000, output: 9_999 } })
check('a straggler older than the last ended turn no longer patches', near(harness.state.tps, 400), String(harness.state.tps))

// The live, settled and late-usage paths share one strict 500ms boundary.
for (const duration of [0, 1, 499, 500, 501]) {
  for (const metering of ['embedded', 'before-end', 'after-end'] as const) {
    const run = createProjectorHarness()
    const apply = (...batch: AgentEvent[]): void => run.apply(batch)
    const measured = duration > 500
    apply(
      { type: 'turn.start', turn: 1, origin: 'user', time: B },
      { type: 'step.start', turn: 1, step: 1 },
      { type: 'assistant.attempt.start', attemptId: 'boundary', turn: 1, step: 1 },
      delta('boundary', B + 1_000, 'x'.repeat(400)),
      delta('boundary', B + 1_000 + duration, 'y'.repeat(400)),
    )
    check(`${duration}ms ${metering}: live boundary`, measured
      ? near(run.state.tps, 200 / (duration / 1000)) : run.state.tps === undefined)
    const message = settle('boundary', 1, 1, B + 1_000 + duration,
      metering === 'embedded' ? { output: 500 } : undefined)
    apply(message, message)
    check(`${duration}ms ${metering}: settled boundary`, measured
      ? near(run.state.tps, (metering === 'embedded' ? 500 : 200) / (duration / 1000))
      : run.state.tps === undefined)
    const usage: AgentEvent = {
      type: 'usage', seq: nextSeq(), turn: 1, step: 1,
      time: B + 2_000, usage: { input: 10, output: 500 },
    }
    if (metering === 'before-end') apply(usage, usage)
    const end: AgentEvent = { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: B + 3_000 }
    apply(end, end)
    if (metering === 'after-end') apply(usage, usage)
    check(`${duration}ms ${metering}: billed tokens stay complete and idempotent`, run.state.tokens.output === 500)
    check(`${duration}ms ${metering}: final rate and sample boundary`, measured
      ? near(run.state.tps, 500 / (duration / 1000)) && run.state.tpsSamples.length === 1
      : run.state.tps === undefined && run.state.tpsSamples.length === 0)
  }
}

if (failed > 0) {
  console.error(`verify-tps-backfill: ${failed} check(s) failed`)
  process.exit(1)
}
console.log('verify-tps-backfill OK')
