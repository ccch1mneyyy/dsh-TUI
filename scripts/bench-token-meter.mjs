/**
 * Measure dsh-token-meter `measure(session)` cost vs session size — the
 * per-Enter (per agent/pre-step) pressure check run by compaction-basic.
 *
 * Run: node scripts/bench-token-meter.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'

const ctx = new Context()
const meter = new TokenMeter(ctx)

function makeSession(turns) {
  const session = Session.create('bench-session')
  session.append('request/header', {
    header: {
      config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    },
    reason: 'initial',
  })
  for (let t = 1; t <= turns; t++) {
    session.append('turn/start', { turn: t })
    session.append('user/message', {
      content: [{ type: 'text', text: `user question number ${t}: how do I fix the resume prompt in the TUI? `.repeat(3) }],
    }, { surfaceOp: 'append' })
    session.append('step/start', { turn: t, step: 1 })
    session.append('assistant/message', {
      turn: t,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `assistant answer number ${t}: you need to parse the cmdline args and wire the initial prompt through channel.submit. `.repeat(8) }],
      },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: t, step: 1 })
    session.append('turn/end', { turn: t, reason: { kind: 'completed' } })
  }
  return session
}

for (const turns of [20, 100, 300, 800, 1500]) {
  const session = makeSession(turns)
  // warm: sync the projection once
  meter.measure(session)
  const runs = 5

  const t0 = performance.now()
  for (let i = 0; i < runs; i++) meter.measure(session)
  const dtMeasure = (performance.now() - t0) / runs

  const t1 = performance.now()
  let msgs
  for (let i = 0; i < runs; i++) msgs = session.deriveMessages()
  const dtDerive = (performance.now() - t1) / runs

  const t2 = performance.now()
  for (let i = 0; i < runs; i++) structuredClone(msgs)
  const dtClone = (performance.now() - t2) / runs

  const t3 = performance.now()
  for (let i = 0; i < runs; i++) JSON.stringify(msgs)
  const dtJson = (performance.now() - t3) / runs

  const m = meter.measure(session)
  console.log(
    `turns=${String(turns).padStart(4)}  surfaceTokens=${String(m.surfaceTokens).padStart(7)}  ` +
    `measure=${dtMeasure.toFixed(1)}ms  derive=${dtDerive.toFixed(1)}ms  clone=${dtClone.toFixed(1)}ms  json=${dtJson.toFixed(1)}ms  msgs=${msgs.length}`,
  )
}
process.exit(0)
