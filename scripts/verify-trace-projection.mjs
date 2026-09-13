/**
 * Trajectory projection regression (issue #80 evolution).
 *
 * Six properties, each guarding a distinct class of failure:
 *
 * 1. **Incremental === from-scratch.** A mechanical oracle rather than an
 *    eyeballed expectation: the same synthetic log is folded in one pass and
 *    again through every possible split point, and the two node lists must be
 *    field-for-field identical. Any drift in the incremental path — a
 *    bracket map not carried, a burst run frozen at an append boundary —
 *    shows up here as a diff, not as a rendering oddity weeks later.
 * 2. **Bracket pairing.** Durations and outcomes land on the row that opened
 *    the bracket, across all six pairing keys; orphan closers are ignored.
 * 3. **Guard totality.** Every high-value payload is fuzzed — each key deleted
 *    and each key type-swapped — and the fold must neither throw nor emit a
 *    half-populated row. An upstream payload rename degrades one row kind.
 * 4. **Forward compatibility.** Event types outside the known vocabulary are
 *    skipped silently.
 * 5. **Burst folding.** Two calls do not fold, three do, an interleaved call
 *    breaks the run, and a run that spans an incremental boundary keeps
 *    growing (the bug that motivated sharing `runMembers` across clones).
 * 6. **No fabricated timing.** A step that streamed contributes a real TTFT;
 *    a step that never streamed contributes no sample at all, rather than a
 *    zero that would drag the average down.
 *
 * Fixture payloads reproduce shapes decoded out of real session logs, never
 * copies of real content.
 *
 * Run with plain node against the compiled lib:
 *   `node scripts/verify-trace-projection.mjs`
 */
import {
  aggregate,
  buildTrajectory,
  columnOfIndex,
  dominantChannel,
  extendTrajectory,
  previewText,
  projectWave,
} from '../lib/types/dsh-adapter/trajectory/index.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const T0 = 1_700_000_000_000
let seq = 0
/** Build one event with a monotonic seq and a caller-controlled offset. */
const ev = (type, data, dtMs = 1) => ({ type, seq: ++seq, time: T0 + (seq * 10) + dtMs, data })

// ───────────────────────── 1 · incremental === from-scratch ─────────────────

/**
 * A synthetic session exercising every folded event kind, including a burst
 * run, a retry sequence, an approval, a compaction and seed history.
 */
function synthesize() {
  seq = 0
  const out = []
  out.push(ev('turn/start', { turn: 0 }))
  out.push(ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'seeded prompt' }] }))
  out.push(ev('turn/end', { turn: 0, reason: { kind: 'completed' } }))
  out.push(ev('session/end-seed', {}))

  for (let turn = 1; turn <= 4; turn++) {
    out.push(ev('turn/start', { turn }))
    out.push(ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: `prompt ${turn}` }] }))
    out.push(ev('user/message', { source: { kind: 'skill', name: 'review' }, content: [{ type: 'text', text: 'injected' }] }))
    for (let step = 1; step <= 3; step++) {
      out.push(ev('step/start', { turn, step }))
      out.push(ev('assistant/chunk', { turn, step, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } }))
      out.push(ev('assistant/chunk', { turn, step, chunk: { type: 'delta', text: 'x' } }))
      out.push(ev('assistant/message', {
        turn,
        step,
        message: { content: [{ type: 'reasoning', text: `thinking ${turn}.${step}` }, { type: 'text', text: `reply ${turn}.${step}` }] },
        usage: { input: 100, output: 20, think: 5, cacheRead: 50, cacheWrite: 10 },
      }))
      // A burst run of five identical calls, plus two distinct calls.
      const names = step === 2 ? ['web_search', 'web_search', 'web_search', 'web_search', 'web_search'] : ['read', 'edit']
      names.forEach((name, i) => {
        const callId = `c${turn}.${step}.${i}`
        out.push(ev('tool/call', { turn, step, callId, name, arguments: `{"q":"${name}-${i}"}` }))
        out.push(ev('tool/result', {
          turn,
          step,
          message: { source: { callId }, content: [{ type: 'text', text: `result ${i}` }] },
          ...(turn === 3 && i === 0 ? { error: { name: 'E', code: 'ENOENT' } } : {}),
        }))
      })
      // Nested code-runner sub-calls.
      const subCallId = `c${turn}.${step}.sub`
      out.push(ev('tool/code-dispatch-start', { rootCallId: 'root', parentCallId: 'root', subCallId, name: 'todo_write', arguments: { todos: [] } }))
      out.push(ev('tool/code-dispatch', { rootCallId: 'root', parentCallId: 'root', subCallId, name: 'todo_write', arguments: { todos: [] } }))
      out.push(ev('step/end', { turn, step }))
    }
    if (turn === 2) {
      out.push(ev('llm/retry', { retryId: 'r1', turn, step: 1, provider: 'deepseek-official', retry: 1, maxRetries: 2, delayMs: 500, failure: { message: 'boom', code: 'RATE_LIMIT' } }))
      out.push(ev('llm/retry', { retryId: 'r1', turn, step: 1, provider: 'deepseek-official', retry: 2, maxRetries: 2, delayMs: 1000, failure: { message: 'boom', code: 'RATE_LIMIT' } }))
      out.push(ev('llm/retry-started', { retryId: 'r1', turn, step: 1, retry: 2 }))
      out.push(ev('approval/asked', { id: 'a1', toolName: 'bash', callId: 'c2', reason: 'writes outside workspace' }))
      out.push(ev('approval/decided', { id: 'a1', outcome: 'denied' }))
    }
    if (turn === 3) {
      out.push(ev('compaction/start', { reason: 'threshold' }))
      out.push(ev('compaction/end', { removed: 42 }))
      out.push(ev('todo/write', { todos: [{ status: 'completed', content: 'a' }, { status: 'in_progress', content: 'b' }] }))
      out.push(ev('sandbox/mode', { mode: 'danger-full-access' }))
      out.push(ev('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4', reasoningEffort: 'max' } }, reason: 'change' }))
      out.push(ev('subagent/descriptor', { version: 2, mode: 'continuable', label: 'child', agentModel: 'deepseek-v4-flash' }))
      out.push(ev('command/run', { commandId: 'x', name: 'permission', args: ' danger-full-access', source: { kind: 'user' } }))
    }
    out.push(ev('turn/end', { turn, reason: { kind: turn === 4 ? 'cancelled' : 'completed' } }))
  }
  return out
}

/** Structural deep-equality with a readable first-difference path. */
function diff(a, b, path = '') {
  if (a === b) return null
  if (typeof a !== typeof b) return `${path}: ${typeof a} vs ${typeof b}`
  if (a === null || b === null || typeof a !== 'object') return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs non-array`
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}.length: ${a.length} vs ${b.length}`
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], b[i], `${path}[${i}]`)
      if (d) return d
    }
    return null
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    const d = diff(a[key], b[key], `${path}.${key}`)
    if (d) return d
  }
  return null
}

const events = synthesize()
const whole = buildTrajectory(events)
check('fixture folds to a non-trivial ledger', whole.nodes.length > 40, `${whole.nodes.length} rows from ${events.length} events`)

{
  // Every split point, not a sampled few: the boundary bugs this catches are
  // exactly the ones that hide at an unlucky index.
  let worst = null
  for (let split = 0; split <= events.length; split++) {
    const first = buildTrajectory(events.slice(0, split))
    const stepwise = extendTrajectory(first, events)
    const d = diff(stepwise.nodes, whole.nodes)
    if (d) { worst = `split ${split}: ${d}`; break }
  }
  check('incremental fold equals from-scratch at every split point', worst === null, worst ?? `${events.length + 1} splits`)
}

{
  // One-event-at-a-time replay — the live streaming path.
  let build = null
  for (let i = 1; i <= events.length; i++) build = extendTrajectory(build, events.slice(0, i))
  check('one-event-at-a-time replay equals from-scratch', diff(build.nodes, whole.nodes) === null, diff(build.nodes, whole.nodes) ?? '')
  check('unchanged snapshot returns the same build object', extendTrajectory(build, build.source) === build)
}

// ───────────────────────── 2 · bracket pairing ──────────────────────────────

{
  const tool = whole.nodes.find(n => n.kind === 'tool' && n.label === 'read')
  check('tool row pairs with its result', tool?.status === 'ok' && typeof tool.durationMs === 'number' && tool.endSeq > tool.seq)
  check('tool row keeps its raw arguments unflattened', typeof tool?.detail === 'string' && tool.detail.startsWith('{"q"'))
  check('tool row carries the result preview source', typeof tool?.outcome === 'string' && tool.outcome.startsWith('result'))

  const failedTool = whole.nodes.find(n => n.kind === 'tool' && n.status === 'error')
  check('failed tool carries its error code', failedTool?.errorCode === 'ENOENT')

  const sub = whole.nodes.find(n => n.kind === 'subtool')
  check('code-dispatch pairs by subCallId', sub?.status === 'ok' && typeof sub.durationMs === 'number')

  const retry = whole.nodes.find(n => n.kind === 'retry')
  check('retry sequence folds to one row', whole.nodes.filter(n => n.kind === 'retry').length === 1)
  check('retry accumulates attempts and backoff', retry?.attempts === 2 && retry.durationMs === 1500, `${retry?.attempts} attempts / ${retry?.durationMs}ms`)
  check('retry closes without overwriting its backoff', retry?.status === 'ok' && retry.endSeq > retry.seq)
  check('retry carries the failure classifier', retry?.errorCode === 'RATE_LIMIT')

  const approval = whole.nodes.find(n => n.kind === 'approval')
  check('denied approval renders as an error', approval?.status === 'error' && approval.outcome === 'denied')

  const compaction = whole.nodes.find(n => n.kind === 'compaction')
  check('compaction pairs by nesting and reports removals', compaction?.status === 'ok' && compaction.outcome === '-42')

  const cancelled = whole.nodes.filter(n => n.kind === 'turn').at(-1)
  check('cancelled turn closes as an error', cancelled?.status === 'error' && cancelled.errorCode === 'cancelled')

  const seeded = whole.nodes.filter(n => n.seed === true)
  check('seed history is marked by session/end-seed', seeded.length === 2 && seeded.every(n => n.turn === 0), `${seeded.length} seed rows`)

  // Injected context is labelled by its producer NAME when it has one, so the
  // row says which skill spoke rather than merely that a skill did.
  const context = whole.nodes.find(n => n.kind === 'context' && n.label === 'review')
  check('non-human user-role messages become context rows', context !== undefined)
  check('human prompts stay USER rows', whole.nodes.some(n => n.kind === 'user' && n.label === ''))

  const system = whole.nodes.filter(n => n.kind === 'system').map(n => n.label)
  check('mode/route/command changes become system rows', system.includes('mode') && system.includes('deepseek-v4') && system.includes('/permission'), system.join(','))
}

{
  // Orphan closers: a result whose call never appeared, and a stray step/end.
  seq = 0
  const orphans = [
    ev('tool/result', { turn: 1, step: 1, message: { source: { callId: 'nope' }, content: [] } }),
    ev('step/end', { turn: 9, step: 9 }),
    ev('llm/retry-started', { retryId: 'ghost' }),
    ev('approval/decided', { id: 'ghost', outcome: 'allowed' }),
    ev('compaction/end', { removed: 1 }),
    ev('tool/code-dispatch', { rootCallId: 'r', parentCallId: 'r', subCallId: 'ghost', name: 'x', arguments: {} }),
  ]
  let threw = null
  let nodes = []
  try { nodes = buildTrajectory(orphans).nodes } catch (error) { threw = error }
  check('orphan closers neither throw nor create rows', threw === null && nodes.length === 0, threw?.message ?? `${nodes.length} rows`)
}

// ───────────────────────── 3 · guard totality (fuzz) ────────────────────────

{
  const samples = [
    ['llm/retry', { retryId: 'r', turn: 1, step: 1, provider: 'p', retry: 1, maxRetries: 2, delayMs: 5, failure: { message: 'm', code: 'C' } }],
    ['llm/retry-started', { retryId: 'r', turn: 1, step: 1, retry: 1 }],
    ['tool/code-dispatch-start', { rootCallId: 'r', parentCallId: 'r', subCallId: 's', name: 'n', arguments: { a: 1 } }],
    ['tool/code-dispatch', { rootCallId: 'r', parentCallId: 'r', subCallId: 's', name: 'n', arguments: { a: 1 } }],
    ['request/header', { header: { config: { provider: 'p', model: 'm', reasoningEffort: 'max' } }, reason: 'change' }],
    ['subagent/descriptor', { version: 2, mode: 'continuable', label: 'l', agentModel: 'm' }],
    ['approval/asked', { id: 'a', toolName: 't', callId: 'c', reason: 'r' }],
    ['approval/decided', { id: 'a', outcome: 'allowed' }],
    ['hook/invoked', { id: 'h', name: 'n', event: 'e' }],
    ['hook/result', { id: 'h', name: 'n' }],
    ['compaction/start', { reason: 'threshold' }],
    ['compaction/end', { removed: 3 }],
    ['todo/write', { todos: [{ status: 'completed', content: 'a' }] }],
    ['sandbox/mode', { mode: 'x' }],
    ['command/run', { commandId: 'i', name: 'n', args: 'a', source: { kind: 'user' } }],
    ['tool/call', { turn: 1, step: 1, callId: 'c', name: 'n', arguments: '{}' }],
    ['tool/result', { turn: 1, step: 1, message: { source: { callId: 'c' }, content: [] } }],
    ['assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 't' }] }, usage: { input: 1 } }],
    ['user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 't' }] }],
    ['turn/start', { turn: 1 }],
    ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
    ['step/start', { turn: 1, step: 1 }],
    ['step/end', { turn: 1, step: 1 }],
    ['assistant/chunk', { turn: 1, step: 1, chunk: { type: 'delta' } }],
  ]
  /** Every degradation a renamed / retyped upstream field can produce. */
  const mutate = (value) => {
    const out = []
    out.push(undefined, null, 0, '', [], {})
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        const dropped = { ...value }
        delete dropped[key]
        out.push(dropped)
        out.push({ ...value, [key]: null })
        out.push({ ...value, [key]: 42 })
        out.push({ ...value, [key]: 'wrong' })
        out.push({ ...value, [key]: {} })
        out.push({ ...value, [key]: [] })
      }
    }
    return out
  }
  let threw = null
  let halfRow = null
  let cases = 0
  for (const [type, payload] of samples) {
    for (const variant of mutate(payload)) {
      cases += 1
      try {
        seq = 0
        const build = buildTrajectory([ev(type, variant)])
        for (const node of build.nodes) {
          if (typeof node.seq !== 'number' || typeof node.time !== 'number' ||
              typeof node.kind !== 'string' || typeof node.label !== 'string' ||
              typeof node.turn !== 'number') {
            halfRow ??= `${type}: ${JSON.stringify(node).slice(0, 120)}`
          }
        }
      } catch (error) {
        threw ??= `${type} / ${JSON.stringify(variant).slice(0, 80)}: ${error.message}`
      }
    }
  }
  check('guards never throw on a malformed payload', threw === null, threw ?? `${cases} fuzz cases`)
  check('guards never emit a half-populated row', halfRow === null, halfRow ?? '')
}

// ───────────────────────── 4 · forward compatibility ────────────────────────

{
  seq = 0
  const unknown = [
    ev('turn/start', { turn: 1 }),
    ev('future/event-kind', { anything: true }),
    ev('web/deepseek-search-llm-request', { q: 1 }),
    ev('agent/inbox/spliced', {}),
    ev('session/title', { title: 't' }),
    ev('request/context', { provider: 'p' }),
    ev('command/done', { commandId: 'x' }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  const nodes = buildTrajectory(unknown).nodes
  check('unknown and log-only events add no rows', nodes.length === 1 && nodes[0].kind === 'turn', `${nodes.length} rows`)
}

// ───────────────────────── 5 · burst folding ────────────────────────────────

function burstEvents(count, { interleave = -1 } = {}) {
  seq = 0
  const out = [ev('turn/start', { turn: 1 }), ev('step/start', { turn: 1, step: 1 })]
  for (let i = 0; i < count; i++) {
    if (i === interleave) {
      out.push(ev('tool/call', { turn: 1, step: 1, callId: `x${i}`, name: 'other', arguments: '{}' }))
      out.push(ev('tool/result', { turn: 1, step: 1, message: { source: { callId: `x${i}` }, content: [] } }))
    }
    const callId = `b${i}`
    out.push(ev('tool/call', { turn: 1, step: 1, callId, name: 'grep', arguments: `{"i":${i}}` }))
    out.push(ev('tool/result', { turn: 1, step: 1, message: { source: { callId }, content: [] } }))
  }
  return out
}

{
  const two = buildTrajectory(burstEvents(2)).nodes.filter(n => n.kind === 'tool')
  check('two same-name calls do not fold', two.length === 2 && two.every(n => n.burst === undefined))

  const three = buildTrajectory(burstEvents(3)).nodes.filter(n => n.kind === 'tool')
  check('three same-name calls fold to one row', three.length === 1 && three[0].burst?.members.length === 3)

  const five = buildTrajectory(burstEvents(5)).nodes.filter(n => n.kind === 'tool')
  check('a longer run keeps folding into the same row', five.length === 1 && five[0].burst?.members.length === 5)
  check('folded members keep their own durations', five[0].burst.members.every(m => typeof m.durationMs === 'number'))

  // Six calls split 3 + 3 by an intruder: two runs that each reach the fold
  // threshold on their own, proving the run is broken rather than bridged.
  const split = buildTrajectory(burstEvents(6, { interleave: 3 })).nodes.filter(n => n.kind === 'tool')
  const shape = split.map(n => `${n.label}x${n.burst?.members.length ?? 1}`).join(' ')
  check('an interleaved call breaks the run into two', shape === 'grepx3 otherx1 grepx3', shape)

  // Four calls split 2 + 2: neither side reaches the threshold, so none folds.
  const tooShort = buildTrajectory(burstEvents(4, { interleave: 2 })).nodes.filter(n => n.kind === 'tool')
  check('runs shortened by an intruder do not fold', tooShort.length === 5 && tooShort.every(n => n.burst === undefined), `${tooShort.length} rows`)

  // The clone-sharing bug: a run that starts before an append and continues
  // after it must keep growing the array the burst node already holds.
  const seven = burstEvents(7)
  for (let split = 1; split < seven.length; split++) {
    const partial = buildTrajectory(seven.slice(0, split))
    const grown = extendTrajectory(partial, seven)
    const folded = grown.nodes.filter(n => n.kind === 'tool')
    if (folded.length !== 1 || folded[0].burst?.members.length !== 7) {
      check('a run spanning an incremental boundary keeps growing', false, `split ${split}: ${folded.length} rows / ${folded[0]?.burst?.members.length} members`)
      break
    }
    if (split === seven.length - 1) check('a run spanning an incremental boundary keeps growing', true, `${seven.length - 1} splits`)
  }
}

// ───────────────────────── 6 · timing, aggregate, wave ──────────────────────

{
  seq = 0
  const streamed = [
    ev('turn/start', { turn: 1 }),
    ev('step/start', { turn: 1, step: 1 }),
    ev('assistant/chunk', { turn: 1, step: 1, chunk: {} }),
    ev('assistant/chunk', { turn: 1, step: 1, chunk: {} }),
    ev('step/end', { turn: 1, step: 1 }),
    // A step that never streamed: request failed before first token.
    ev('step/start', { turn: 1, step: 2 }),
    ev('step/end', { turn: 1, step: 2 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  const totals = aggregate(buildTrajectory(streamed)).totals
  check('a streamed step contributes exactly one TTFT sample', totals.ttftSamples === 1, `${totals.ttftSamples}`)
  check('a step without chunks fabricates no timing', totals.ttftMs > 0 && totals.decodeMs > 0)
}

{
  const agg = aggregate(whole)
  const search = agg.tools.find(r => r.label === 'web_search')
  check('burst members expand in the aggregate call count', search?.count === 20, `${search?.count} calls`)
  check('tool rows rank by total duration', agg.tools.every((row, i) => i === 0 || agg.tools[i - 1].totalMs >= row.totalMs))
  check('model section separates decode, ttft and retry', agg.model.map(r => r.label).sort().join(',') === 'decode,retry,ttft', agg.model.map(r => r.label).join(','))
  check('retry backoff is counted once', agg.totals.retryMs === 1500 && agg.totals.retries === 2)
  check('turn rows exist for every turn', agg.turns.length === 5, `${agg.turns.length}`)
  check('token accounting is attached once per step', agg.totals.tokens.input === 100 * 12, `${agg.totals.tokens.input}`)
  check('error count includes tool, approval and retry failures', agg.totals.errors >= 3, `${agg.totals.errors}`)

  const bySort = aggregate(whole, 'count').tools
  check('sorting by count reorders the tool section', bySort.every((row, i) => i === 0 || bySort[i - 1].count >= row.count))
}

{
  for (const projection of ['sequence', 'time', 'compressed']) {
    for (const width of [1, 7, 40, 200, whole.nodes.length * 3]) {
      const band = projectWave(whole.nodes, width, projection)
      const okWidth = band.buckets.length === width
      const okPeak = band.peak > 0
      const okSeek = band.buckets.every(b => b.firstIndex >= 0 && b.firstIndex < whole.nodes.length)
      // Conservation: every row's cost lands in exactly one column. Cost is
      // wall-clock (own duration plus a nominal floor so a message still
      // registers), and structural rows contribute nothing because their span
      // is the sum of their children's — counting both would double it.
      const total = band.buckets.reduce((sum, b) => sum + b.weight, 0)
      const expected = whole.nodes.reduce((sum, n) => {
        if (n.kind === 'turn' || n.kind === 'step') return sum
        if (n.burst) return sum + n.burst.members.reduce((inner, m) => inner + (m.durationMs ?? 0) + 120, 0)
        return sum + (n.durationMs ?? 0) + 120
      }, 0)
      const okTotal = Math.abs(total - expected) < 1e-6
      if (!(okWidth && okPeak && okSeek && okTotal)) {
        check(`wave ${projection}@${width} is well formed`, false, `w=${okWidth} p=${okPeak} s=${okSeek} t=${okTotal}`)
      }
    }
  }
  check('wave is well formed across projections and widths', true, '3 projections x 5 widths')

  const band = projectWave(whole.nodes, 60)
  const nonEmpty = band.buckets.filter(b => b.weight > 0).map(b => b.weight).sort((a, b) => a - b)
  check('wave floor is the smallest non-empty column', band.floor === nonEmpty[0], `${band.floor} vs ${nonEmpty[0]}`)
  check('wave peak is the p95 column, not the maximum',
    band.peak === nonEmpty[Math.min(nonEmpty.length - 1, Math.floor(nonEmpty.length * 0.95))] &&
    band.peak <= nonEmpty[nonEmpty.length - 1],
    `${band.peak} <= ${nonEmpty[nonEmpty.length - 1]}`)
  check('wave surfaces the error column', band.buckets.some(b => b.error))
  check('wave surfaces the retry column', band.buckets.some(b => b.retry))
  check('wave records turn boundaries', band.turns.length === 5, `${band.turns.length}`)
  check('dominant channel is defined for non-empty columns', band.buckets.filter(b => b.weight > 0).every(b => dominantChannel(b) !== undefined))
  check('columnOfIndex is monotonic', [0, 10, 30, whole.nodes.length - 1].every((i, n, arr) => n === 0 || columnOfIndex(band, arr[n - 1]) <= columnOfIndex(band, i)))
  check('empty ledger yields an empty band', projectWave([], 40).buckets.length === 0)
}

// ───────────────────────── 7 · preview bounding ─────────────────────────────

{
  const long = 'a'.repeat(500_000)
  const started = process.hrtime.bigint()
  const preview = previewText(long, 40)
  const micros = Number(process.hrtime.bigint() - started) / 1000
  check('preview is capped', preview.length === 41 && preview.endsWith('…'), `${preview.length} chars`)
  check('preview cost is bounded, not proportional to the source', micros < 5000, `${micros.toFixed(0)}us on 500KB`)
  check('preview collapses whitespace', previewText('  a\n\n\tb  ', 40) === 'a b')
  check('preview marks truncation of a long whitespace-heavy source', previewText(`${' '.repeat(400)}tail`, 10).endsWith('…'))
  check('preview of a short source is exact', previewText('short', 40) === 'short')
  check('preview handles a zero budget', previewText('x', 0) === '')
}

// ───────────────────────── 8 · degenerate inputs ────────────────────────────

{
  check('empty log folds to an empty ledger', buildTrajectory([]).nodes.length === 0)
  const totals = aggregate(buildTrajectory([])).totals
  check('empty log aggregates to zeroes', totals.rows === 0 && totals.spanMs === 0 && totals.calls === 0)
  seq = 0
  const noTurn = buildTrajectory([ev('tool/call', { callId: 'c', name: 'x', arguments: '{}' })]).nodes
  check('events before the first turn fold under turn 0', noTurn.length === 1 && noTurn[0].turn === 0)
}

// ───────────────────────── 9 · 0.1.5 generation: V3 streams + PTC rename ────
//
// 0.1.5 retires per-token `assistant/chunk` events: settlement events embed
// the compact `AssistantStreamRecord[]` instead (`assistant/message.stream`,
// `assistant/attempt.stream` for failed/retried/cancelled attempts), and the
// code-runner dispatch bracket is renamed `tool/ptc-dispatch(-start)`.

{
  seq = 0
  const stepStart = T0 + (2 * 10) + 1 // ev() time of the step/start below (seq 2)
  const attemptT0 = T0 + 100
  const commitT0 = T0 + 200
  const v3 = [
    ev('turn/start', { turn: 1 }),
    ev('step/start', { turn: 1, step: 1 }),
    // A failed first attempt: embedded stream, no surface message, no row —
    // but its decode time still feeds the step's timing slots.
    ev('assistant/attempt', {
      turn: 1, step: 1,
      stream: [{ type: 'text-chunks', time0: attemptT0, index: 0, dt: [30], texts: ['par', 'tial'] }],
    }),
    // The renamed dispatch bracket pairs exactly like the old spelling.
    ev('tool/ptc-dispatch-start', { rootCallId: 'root', parentCallId: 'root', subCallId: 'p1', name: 'run_js', arguments: { code: '1' } }),
    ev('tool/ptc-dispatch', { rootCallId: 'root', parentCallId: 'root', subCallId: 'p1', name: 'run_js', arguments: { code: '1' } }),
    // The committed retry's message carries its own stream; firstChunk stays
    // anchored to the attempt (first-wins), lastChunk tracks the latest.
    ev('assistant/message', {
      turn: 1, step: 1,
      message: { content: [{ type: 'text', text: 'final answer' }] },
      stream: [{ type: 'text-chunks', time0: commitT0, index: 0, dt: [40], texts: ['final', ' answer'] }],
    }),
    // New 0.1.5 vocabulary stays silent rather than erroring.
    ev('system/message', { turn: 1, step: 1, message: { content: 'sys' } }),
    ev('deliverables/presented', { turn: 1, step: 1 }),
    ev('subagent/catalog', { agents: [] }),
    ev('step/end', { turn: 1, step: 1 }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  const build = buildTrajectory(v3)
  const ptc = build.nodes.find(n => n.kind === 'subtool')
  check('ptc-dispatch pairs by subCallId under the renamed bracket', ptc?.label === 'run_js' && ptc.status === 'ok' && typeof ptc.durationMs === 'number')
  const assistantRows = build.nodes.filter(n => n.kind === 'assistant')
  check('committed message folds its content row', assistantRows.length === 1 && assistantRows[0].detail === 'final answer')
  check('abandoned attempt adds no ledger row', !build.nodes.some(n => n.detail === 'partial' || n.detail === 'par'))
  check('system/message, deliverables and catalog stay silent', build.nodes.filter(n => n.kind === 'system').length === 0)
  const slot = build.timing.get('1:1')
  check('V3 stream feeds the step timing slots', slot?.firstChunk === attemptT0 && slot?.lastChunk === commitT0 + 40, JSON.stringify(slot))
  const v3Totals = aggregate(build).totals
  check('TTFT anchors to the first attempt, decode spans the retry', v3Totals.ttftSamples === 1 && v3Totals.ttftMs === attemptT0 - stepStart && v3Totals.decodeMs === (commitT0 + 40) - attemptT0, `ttft=${v3Totals.ttftMs} decode=${v3Totals.decodeMs}`)
  // A malformed embedded stream degrades to no timing, never a throw.
  seq = 0
  const malformed = buildTrajectory([
    ev('step/start', { turn: 1, step: 1 }),
    ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'x' }] }, stream: [{ type: 'text-chunks', time0: -5, index: 0, dt: [1], texts: ['a'] }] }),
  ])
  check('malformed stream record folds without timing and without throwing', malformed.nodes.length === 2 && malformed.timing.get('1:1')?.firstChunk === undefined)
}

console.log(failed === 0 ? '\nAll trajectory projection checks passed.' : `\n${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
