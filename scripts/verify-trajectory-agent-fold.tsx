/**
 * AgentEvent trajectory fold regression: the backend-neutral source must
 * translate the shared AgentEvent vocabulary into the raw-event envelope
 * the projection already folds, row by row per the mapping table in
 * agent-source.ts, and the
 * composition must mount it so the three-state report flips to
 * empty/supported for a session without a DSH raw history.
 *
 *  - mapping table rows: turn.start/end (+error reason), step, attempt /
 *    retry (supersede + api-retry notice, one row per failure signal),
 *    assistant.delta timing, thinking token estimate (marker row only when
 *    the settled message has no reasoning text), assistant message-level
 *    usage (first row, cache fields intact), turn-level usage backfill
 *    (ONLY when no message carried usage — never both), tool
 *    call/progress/result (progress adds no row), permission and question
 *    brackets, compaction (removed from pre/post), subagent child lane
 *    (descriptor row; child traffic excluded; subagent usage never folded),
 *    user.message human vs injected, todo.write;
 *  - observed clock: events without a timestamp take the trace clock and
 *    stamp data.observed — the inspector says so; timed events do not;
 *  - dedup: durable-seq events replayed (a reconnect) fold once;
 *  - out-of-order close: a result before its call is skipped, a late
 *    result after step boundaries still closes its bracket;
 *  - incrementality: piecewise extendTrajectory === from-scratch build,
 *    prefix identity stable (the Chat render-path contract);
 *  - composition: a real core channel reports empty → supported as events
 *    flow, and traceEvents() feeds the same fold;
 *  - surfaces: the scene renders the folded ledger at 40 columns and the
 *    side panel at 28.
 *
 * Run: node --import tsx/esm scripts/verify-trajectory-agent-fold.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { TrajectoryPanel }, { TrajectoryScene }, { createChannel }, contexts, { setLang, t }, trajApi] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/TrajectoryPanel.js'),
  import('../src/screens/TrajectoryScene.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/components/sidePanel/SidePanelRuntimeContext.js'),
  import('../src/i18n.js'),
  import('../src/dsh-adapter/trajectory/index.js'),
])
const { render, ThemeProvider, Box, useInput } = ui
const { SidePanelRuntimeContext, PanelContext } = contexts
const { buildTrajectory, extendTrajectory, aggregate, inspectNode, createAgentTrajectorySource } = trajApi
setLang('en')

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

/** Deterministic trace clock: every observed stamp advances by 10ms. */
let clockNow = 10_000
const clock = (): number => (clockNow += 10)
const source = createAgentTrajectorySource({ clock })

/** One folded stream → build (a FRESH snapshot: the published snapshot is
 *  replaced on append, so a stale capture would never see the tail — the
 *  same contract a DSH session's per-append frozen array follows). */
const fold = (): ReturnType<typeof buildTrajectory> => buildTrajectory(source.events())
/** Rows of one kind, in order. */
const rowsOf = (build: ReturnType<typeof buildTrajectory>, kind: string) => build.nodes.filter(node => node.kind === kind)

// ─── shared terminal harness (mirrors verify-trajectory-source-states) ──────
function makeTerminalHarness(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void { term.write(String(chunk), cb) }
  }
  class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void): void { cb() } }
  class FakeStdin extends PassThrough {
    isTTY = true
    isRaw = false
    setRawMode(next: boolean) { this.isRaw = next; return this }
    setEncoding() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new FakeStdin()
  const lines = (): string[] => {
    const buf = term.buffer.active
    return Array.from({ length: rows }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(false) ?? '')
  }
  const screen = (): string => lines().join('\n')
  return { term, stdin, lines, screen, stdout: new FakeStdout(), stderr: new FakeStderr() }
}
const settled = async (probe: () => boolean): Promise<boolean> => {
  for (let i = 0; i < 80; i++) {
    if (probe()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return probe()
}

try {
  // ── 1. mapping table, row by row ─────────────────────────────────────────
  {
    // turn.start/end: bracket, duration, outcome (ok + error).
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 1_400 }, false)
    let turns = rowsOf(fold(), 'turn')
    check('turn: start/end bracket row', turns.length === 1 && turns[0]!.label === 'turn 1')
    check('turn: completed closes ok with own duration', turns[0]!.status === 'ok' && turns[0]!.durationMs === 400)
    source.reset()
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'turn.end', turn: 1, reason: { kind: 'error', message: 'boom' }, time: 1_100 }, false)
    turns = rowsOf(fold(), 'turn')
    check('turn: error reason marks the row failed', turns.length === 1 && turns[0]!.status === 'error' && turns[0]!.errorCode === 'error')
    source.reset()
  }
  {
    // step: bracket + timing slot; no timestamps → observed clock.
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'step.start', turn: 1, step: 1 }, false)
    const stamped = source.events().find(event => event.type === 'step/start')!
    check('step: no timestamp → trace clock + observed stamp', stamped.data.observed === true)
    source.observe({ type: 'step.end', turn: 1, step: 1 }, false)
    const build = fold()
    const steps = rowsOf(build, 'step')
    check('step: bracket row with clock duration', steps.length === 1 && steps[0]!.status === 'ok' && steps[0]!.durationMs === 10)
    check('step: timing slot seeded for TTFT', build.timing.get('1:1')?.startTime === stamped.time)
    check('step: timed rows carry no observed stamp', source.events().find(event => event.type === 'turn/start')!.data.observed !== true)
    source.reset()
  }
  {
    // attempt/retry: one api-retry notice + supersede = ONE row; an
    // abandoned end that no notice announced adds its own.
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'assistant.attempt.start', attemptId: 'a1', turn: 1, step: 1 }, false)
    source.observe({ type: 'notice', level: 'notice', key: 'api-retry', text: 'retrying (1/3)' }, false)
    source.observe({ type: 'assistant.attempt.start', attemptId: 'a2', turn: 1, step: 1 }, false)
    let retries = rowsOf(fold(), 'retry')
    check('retry: notice + supersede fold to one row', retries.length === 1, 'got ' + retries.length)
    check('retry: row closed by the replacement attempt', retries[0]!.status === 'ok' && retries[0]!.attempts === 1)
    source.observe({ type: 'assistant.attempt.end', attemptId: 'a2', outcome: 'abandoned' }, false)
    retries = rowsOf(fold(), 'retry')
    check('retry: unannounced abandoned end adds its own row', retries.length === 2 && retries[1]!.status === 'running')
    check('retry: errors/retries counters', fold().counts.retries === 2 && fold().counts.errors === 2)
    source.reset()
  }
  {
    // assistant.delta: chunk timing only (text, reasoning, tool-args).
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'step.start', turn: 1, step: 1 }, false)
    source.observe({ type: 'assistant.attempt.start', attemptId: 'a1', turn: 1, step: 1 }, false)
    source.observe({ type: 'assistant.delta', attemptId: 'a1', index: 0, time: 1_050, delta: { kind: 'reasoning', text: 'hmm' } }, false)
    const firstSnapshot = source.events()
    source.observe({ type: 'assistant.delta', attemptId: 'a1', index: 1, time: 1_080, delta: { kind: 'text', text: 'he' } }, false)
    const secondSnapshot = source.events()
    source.observe({ type: 'assistant.delta', attemptId: 'a1', index: 2, time: 1_120, delta: { kind: 'tool-args', callId: 'c1', partialJson: '{' } }, false)
    const timing = fold().timing.get('1:1')!
    check('delta: first/last chunk timing (reasoning+text+args)', timing.firstChunk === 1_050 && timing.lastChunk === 1_120)
    const chunks = source.events().filter(event => event.type === 'assistant/chunk')
    check('delta: one raw chunk per attempt boundary', chunks.length === 2)
    check('delta: replacing the tail preserves earlier snapshots',
      firstSnapshot.filter(event => event.type === 'assistant/chunk').length === 1
        && secondSnapshot.filter(event => event.type === 'assistant/chunk').length === 2
        && secondSnapshot.filter(event => event.type === 'assistant/chunk')[1]!.time === 1_080)
    check('delta: the attempt tail carries its latest timestamp', chunks[1]!.time === 1_120)
    source.reset()
    source.observe({ type: 'assistant.delta', attemptId: 'no-start', index: 0, turn: 1, step: 1, time: 2_000, delta: { kind: 'text', text: 'a' } }, false)
    source.observe({ type: 'assistant.delta', attemptId: 'no-start', index: 1, turn: 1, step: 1, time: 2_020, delta: { kind: 'text', text: 'b' } }, false)
    source.observe({ type: 'assistant.delta', attemptId: 'no-start', index: 2, turn: 1, step: 1, time: 2_040, delta: { kind: 'text', text: 'c' } }, false)
    check('delta: an attempt without an explicit start still retains first and tail', source.events().filter(event => event.type === 'assistant/chunk').length === 2)
    source.reset()
  }
  {
    // Thinking estimate: marker row only without reasoning text.
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'step.start', turn: 1, step: 1 }, false)
    source.observe({ type: 'assistant.attempt.start', attemptId: 'a1', turn: 1, step: 1 }, false)
    source.observe({ type: 'assistant.delta', attemptId: 'a1', index: 0, time: 1_050, delta: { kind: 'reasoning-tokens', estimated: 100 } }, false)
    source.observe({ type: 'assistant.delta', attemptId: 'a1', index: 1, time: 1_060, delta: { kind: 'reasoning-tokens', estimated: 50 } }, false)
    source.observe({ type: 'assistant.message', seq: 2, anchor: 'm1', turn: 1, step: 1, attemptId: 'a1', time: 1_100, blocks: [{ type: 'text', text: 'done' }], canonical: true }, false)
    let thinking = rowsOf(fold(), 'thinking')
    check('thinking: estimate becomes a marker row (no reasoning text)', thinking.length === 1 && thinking[0]!.detail === '≈ 150 tokens')
    check('thinking: estimate rides the message usage think field', thinking[0]!.tokens?.think === 150)
    source.reset()
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'step.start', turn: 1, step: 1 }, false)
    source.observe({ type: 'assistant.attempt.start', attemptId: 'a1', turn: 1, step: 1 }, false)
    source.observe({ type: 'assistant.delta', attemptId: 'a1', index: 0, time: 1_050, delta: { kind: 'reasoning-tokens', estimated: 100 } }, false)
    source.observe({ type: 'assistant.message', seq: 2, anchor: 'm1', turn: 1, step: 1, attemptId: 'a1', time: 1_100, blocks: [{ type: 'reasoning', text: 'real thinking' }, { type: 'text', text: 'done' }], canonical: true }, false)
    thinking = rowsOf(fold(), 'thinking')
    check('thinking: real reasoning text wins, no marker row', thinking.length === 1 && thinking[0]!.detail === 'real thinking')
    check('thinking: estimate still lands in usage.think', thinking[0]!.tokens?.think === 100)
    source.reset()
  }
  {
    // assistant usage: message-level attaches to the first row once.
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'step.start', turn: 1, step: 1 }, false)
    source.observe({ type: 'assistant.message', seq: 2, anchor: 'm1', turn: 1, step: 1, attemptId: 'a1', time: 1_100, blocks: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 7 }, canonical: true }, false)
    const build = fold()
    const withTokens = build.nodes.filter(node => node.tokens !== undefined)
    check('usage: message-level on the first row exactly once', withTokens.length === 1 && withTokens[0]!.detail === 'one')
    check('usage: cache fields survive the fold', withTokens[0]!.tokens!.cacheRead === 100 && withTokens[0]!.tokens!.cacheWrite === 7)
    check('usage: totals count it once', aggregate(build).totals.tokens.input === 10)
    source.reset()
  }
  {
    // turn-level usage: backfill only when no message carried usage.
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 1_500, usage: { input: 7, output: 3 } }, false)
    const turns1 = rowsOf(fold(), 'turn')
    check('usage/turn: backfills a turn with no message usage', turns1[0]!.tokens?.input === 7 && turns1[0]!.tokens?.output === 3)
    source.reset()
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'step.start', turn: 1, step: 1 }, false)
    source.observe({ type: 'assistant.message', seq: 2, anchor: 'm1', turn: 1, step: 1, attemptId: 'a1', time: 1_100, blocks: [{ type: 'text', text: 'one' }], usage: { input: 10, output: 5 }, canonical: true }, false)
    source.observe({ type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 1_500, usage: { input: 10, output: 5 } }, false)
    const turns2 = rowsOf(fold(), 'turn')
    const totals = aggregate(fold()).totals.tokens
    check('usage/turn: never double counts with message-level', turns2[0]!.tokens === undefined && totals.input === 10 && totals.output === 5)
    source.reset()
    // A tool-only message parks its usage on the open step row.
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'step.start', turn: 1, step: 1 }, false)
    source.observe({ type: 'assistant.message', seq: 2, anchor: 'm1', turn: 1, step: 1, attemptId: 'a1', time: 1_100, blocks: [], usage: { input: 4, output: 2 }, canonical: true }, false)
    const steps = rowsOf(fold(), 'step')
    check('usage/tool-only: parks on the open step row', steps[0]!.tokens?.input === 4 && aggregate(fold()).totals.tokens.output === 2)
    source.reset()
  }
  {
    // tool call/progress/result (ok + error).
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'step.start', turn: 1, step: 1 }, false)
    source.observe({ type: 'tool.call', seq: 3, anchor: 'c1', turn: 1, step: 1, callId: 'c1', name: 'Read', argsJson: '{"path":"a.ts"}', time: 1_300 }, false)
    source.observe({ type: 'tool.progress', callId: 'c1', elapsedMs: 50 }, false)
    source.observe({ type: 'tool.result', seq: 4, turn: 1, step: 1, callId: 'c1', isError: false, time: 1_500, content: [{ type: 'text', text: 'data' }], text: 'data' }, false)
    let tools = rowsOf(fold(), 'tool')
    check('tool: call/result pair with own duration', tools.length === 1 && tools[0]!.label === 'Read' && tools[0]!.durationMs === 200 && tools[0]!.status === 'ok')
    check('tool: args and outcome stay references (inspect re-reads)', tools[0]!.detail === '{"path":"a.ts"}' && tools[0]!.outcome === 'data')
    check('tool: progress adds no row', rowsOf(fold(), 'tool').length === 1)
    source.observe({ type: 'tool.call', seq: 5, anchor: 'c2', turn: 1, step: 1, callId: 'c2', name: 'Bash', argsJson: '{"command":"ls"}', time: 1_600 }, false)
    source.observe({ type: 'tool.result', seq: 6, turn: 1, step: 1, callId: 'c2', isError: true, time: 1_700, content: [{ type: 'text', text: 'nope' }], text: 'nope', errorText: 'denied' }, false)
    tools = rowsOf(fold(), 'tool')
    check('tool: error result marks the row failed', tools[1]!.status === 'error' && tools[1]!.outcome === 'denied')
    source.reset()
  }
  {
    // permission + question brackets.
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'permission.request', request: { requestId: 'r1', toolName: 'Write', callId: 'c1', reason: 'outside sandbox', options: [{ id: 'a', kind: 'allow-once' }, { id: 'd', kind: 'reject' }] } }, false)
    source.observe({ type: 'permission.settled', requestId: 'r1', outcome: 'rejected' }, false)
    let approvals = rowsOf(fold(), 'approval')
    check('permission: asked/decided bracket, denial = error', approvals.length === 1 && approvals[0]!.label === 'Write' && approvals[0]!.status === 'error' && approvals[0]!.outcome === 'rejected')
    source.observe({ type: 'question.request', request: { requestId: 'q1', callId: 'c9', questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] } }, false)
    source.observe({ type: 'question.settled', requestId: 'q1' }, false)
    approvals = rowsOf(fold(), 'approval')
    check('question: folds onto the approval bracket, settled = ok', approvals[1]!.label === 'question' && approvals[1]!.status === 'ok' && approvals[1]!.detail === 'Which?')
    source.reset()
  }
  {
    // compaction with pre/post tokens.
    source.observe({ type: 'compaction.start', trigger: 'auto', cancellable: false, time: 1_000 }, false)
    source.observe({ type: 'compaction.end', ok: true, preTokens: 1_200, postTokens: 700, time: 1_300 }, false)
    const compactions = rowsOf(fold(), 'compaction')
    check('compaction: bracket + removed from pre/post', compactions.length === 1 && compactions[0]!.status === 'ok' && compactions[0]!.outcome === '-500')
    source.reset()
  }
  {
    // subagent child lane: descriptor row, child traffic excluded,
    // subagent usage never folded into the parent totals.
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'tool.call', seq: 3, anchor: 't1', turn: 1, step: 1, callId: 't1', name: 'Task', argsJson: '{}', time: 1_100 }, false)
    source.observe({ type: 'subagent.start', agentId: 'sa1', parentCallId: 't1', description: 'scan the repo', model: 'gpt-5.6-sol', background: false, time: 1_150 }, false)
    source.observe({ type: 'tool.call', seq: 8, anchor: 'cc1', turn: 1, step: 1, callId: 'cc1', name: 'Read', argsJson: '{}', time: 1_200, parentCallId: 't1' }, false)
    source.observe({ type: 'assistant.message', seq: 9, anchor: 'cm1', turn: 1, step: 1, attemptId: 'ca1', time: 1_250, blocks: [{ type: 'text', text: 'child says' }], canonical: true, parentCallId: 't1' }, false)
    source.observe({ type: 'subagent.end', agentId: 'sa1', status: 'completed', usage: { total: 999, durationMs: 400 }, time: 1_400 }, false)
    const build = fold()
    const contexts = rowsOf(build, 'context')
    check('subagent: start maps to a descriptor row', contexts.length === 1 && contexts[0]!.label === 'subagent' && contexts[0]!.detail === 'scan the repo · gpt-5.6-sol')
    check('subagent: child-lane tool/assistant traffic stays out', rowsOf(build, 'tool').every(node => node.callId !== 'cc1') && rowsOf(build, 'assistant').every(node => node.detail !== 'child says'))
    check('subagent: usage never enters the parent totals', aggregate(build).totals.tokens.input === 0 && aggregate(build).totals.tokens.output === 0)
    source.reset()
  }
  {
    // user.message + todo.write.
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'user.message', id: 'u1', anchor: 'u1', seq: 1, turn: 1, time: 1_010, source: 'user', text: 'hello there', blocks: [{ type: 'text', text: 'hello there' }] }, false)
    source.observe({ type: 'user.message', id: 'u2', anchor: 'u2', seq: 2, time: 1_020, source: 'injected', text: '<skill body>', label: 'skill', blocks: [{ type: 'text', text: '<skill body>' }] }, false)
    source.observe({ type: 'todo.write', items: [{ content: 'first', status: 'completed' }, { content: 'second', status: 'in_progress' }] }, false)
    const build = fold()
    check('user: human prompt is a user row', rowsOf(build, 'user').length === 1 && rowsOf(build, 'user')[0]!.detail === 'hello there')
    check('user: injected context is a labeled context row', rowsOf(build, 'context')[0]!.label === 'skill')
    check('todo: snapshot row with counters', rowsOf(build, 'todo')[0]!.label === '1/2' && rowsOf(build, 'todo')[0]!.detail === 'second')
    source.reset()
  }

  // ── 2. observed-clock marking surfaces in the inspector ─────────────────
  {
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'step.start', turn: 1, step: 1 }, false)
    source.observe({ type: 'step.end', turn: 1, step: 1 }, false)
    const stepRow = rowsOf(fold(), 'step')[0]!
    const detail = inspectNode(stepRow, source.events())
    check('observed: inspector fact marks the trace clock', detail.facts.includes(t('trajectory-time-observed')))
    const turnRow = rowsOf(fold(), 'turn')[0]!
    check('observed: timed rows carry no marker', !inspectNode(turnRow, source.events()).facts.includes(t('trajectory-time-observed')))
    source.reset()
  }

  // ── 3. dedup: durable replay folds once ─────────────────────────────────
  {
    const batch = [
      { type: 'turn.start', turn: 1, origin: 'user', time: 1_000 },
      { type: 'user.message', id: 'u1', anchor: 'u1', seq: 1, turn: 1, time: 1_010, source: 'user', text: 'hi', blocks: [{ type: 'text', text: 'hi' }] },
      { type: 'tool.call', seq: 3, anchor: 'c1', turn: 1, step: 1, callId: 'c1', name: 'Read', argsJson: '{}', time: 1_100 },
      { type: 'tool.result', seq: 4, turn: 1, step: 1, callId: 'c1', isError: false, time: 1_200, content: [{ type: 'text', text: 'x' }], text: 'x' },
      { type: 'assistant.message', seq: 5, anchor: 'm1', turn: 1, step: 1, attemptId: 'a1', time: 1_300, blocks: [{ type: 'text', text: 'reply' }], usage: { input: 9 }, canonical: true },
      { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 1_400 },
    ] as never as readonly import('../src/agent/events.js').AgentEvent[]
    for (const event of batch) source.observe(event, false)
    const before = fold()
    const totalsBefore = aggregate(before).totals
    for (const event of batch) source.observe(event, true)
    const after = fold()
    check('dedup: replayed durable events add no rows', after.nodes.length === before.nodes.length, before.nodes.length + ' → ' + after.nodes.length)
    check('dedup: replayed usage adds no tokens', aggregate(after).totals.tokens.input === totalsBefore.tokens.input)
    source.reset()
  }

  // ── 4. out-of-order close ────────────────────────────────────────────────
  {
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'step.start', turn: 1, step: 1 }, false)
    // Result BEFORE its call: the fold skips it (no open bracket), the
    // later call stays running — same semantics a DSH log would get.
    source.observe({ type: 'tool.result', seq: 4, turn: 1, step: 1, callId: 'cX', isError: false, time: 1_050, content: [{ type: 'text', text: 'early' }], text: 'early' }, false)
    source.observe({ type: 'tool.call', seq: 3, anchor: 'cX', turn: 1, step: 1, callId: 'cX', name: 'Grep', argsJson: '{}', time: 1_100 }, false)
    let tools = rowsOf(fold(), 'tool')
    check('order: result before call is skipped, row stays running', tools.length === 1 && tools[0]!.status === 'running' && tools[0]!.outcome === undefined)
    // Late close after the step boundary: map pairing still closes it.
    source.observe({ type: 'step.end', turn: 1, step: 1 }, false)
    source.observe({ type: 'tool.result', seq: 5, turn: 1, step: 1, callId: 'cX', isError: false, time: 1_400, content: [{ type: 'text', text: 'late' }], text: 'late' }, false)
    tools = rowsOf(fold(), 'tool')
    check('order: late result still closes its bracket', tools[0]!.status === 'ok' && tools[0]!.durationMs === 300 && tools[0]!.outcome === 'late')
    source.reset()
  }

  // ── 5. incrementality + prefix identity (the Chat render path) ──────────
  {
    const stream = [
      { type: 'turn.start', turn: 1, origin: 'user', time: 1_000 },
      { type: 'user.message', id: 'u1', anchor: 'u1', seq: 1, turn: 1, time: 1_010, source: 'user', text: 'q', blocks: [{ type: 'text', text: 'q' }] },
      { type: 'step.start', turn: 1, step: 1 },
      { type: 'tool.call', seq: 3, anchor: 'c1', turn: 1, step: 1, callId: 'c1', name: 'Read', argsJson: '{"p":1}', time: 1_100 },
      { type: 'tool.result', seq: 4, turn: 1, step: 1, callId: 'c1', isError: false, time: 1_150, content: [{ type: 'text', text: 'z' }], text: 'z' },
      { type: 'assistant.message', seq: 5, anchor: 'm1', turn: 1, step: 1, attemptId: 'a1', time: 1_200, blocks: [{ type: 'text', text: 'r' }], usage: { input: 3, output: 4 }, canonical: true },
      { type: 'step.end', turn: 1, step: 1 },
      { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 1_300 },
    ] as never as readonly import('../src/agent/events.js').AgentEvent[]
    const incremental = createAgentTrajectorySource({ clock })
    let build: ReturnType<typeof buildTrajectory> | null = null
    const snapshots: number[] = []
    let prefixStable = true
    let previousIds: readonly unknown[] = []
    for (const event of stream) {
      source.observe(event, false)
      incremental.observe(event, false)
      const ids: readonly unknown[] = incremental.events()
      if (!previousIds.every((entry, index) => ids[index] === entry)) prefixStable = false
      previousIds = ids
      build = extendTrajectory(build, incremental.events())
      snapshots.push(build.nodes.length)
    }
    const whole = buildTrajectory(incremental.events())
    const pick = (nodes: readonly { kind: string; label: string; status?: string; seq: number; endSeq?: number; tokens?: unknown }[]) =>
      nodes.map(node => [node.kind, node.label, node.status ?? '', node.seq, node.endSeq ?? '', JSON.stringify(node.tokens ?? null)].join('|')).join(';')
    check('incremental: piecewise fold === from-scratch build', pick(build!.nodes) === pick(whole.nodes), build!.nodes.length + ' vs ' + whole.nodes.length)
    check('incremental: prefix identity stable across appends', prefixStable)
    check('incremental: rows grow monotonically', snapshots.every((count, index) => index === 0 || count >= snapshots[index - 1]!))
    source.reset()
  }

  // ── 6. composition: the core mounts the fold (three-state flip) ─────────
  {
    const ctx = {
      on: () => () => undefined,
      effect: () => () => undefined,
      get: () => undefined,
      logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
    } as never
    const listeners = new Set<(batch: readonly unknown[], meta: unknown) => void>()
    const session = {
      ref: { backendId: 'claude', sessionId: '77777777-7777-4777-8777-777777777777' },
      cwd: process.cwd(),
      status: 'idle' as const,
      capabilities: { native: {} },
      history: () => Promise.resolve([]),
      subscribe(listener: (batch: readonly unknown[], meta: unknown) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
      submit: () => Promise.resolve({ accepted: true }),

      cancel: () => Promise.resolve({ stillQueued: [] }),
      dispose: () => Promise.resolve(),
    }
    const channel = createChannel(ctx, session as never, { model: 'm', provider: '', cwd: process.cwd(), activity: false, backendLabel: 'Claude' })
    check('compose: core reports empty before events (fold mounted)', channel.trajectorySource() === 'empty')
    for (const listener of listeners) {
      listener([
        { type: 'turn.start', turn: 1, origin: 'user', time: 1_000 },
        { type: 'step.start', turn: 1, step: 1 },
        { type: 'tool.call', seq: 3, anchor: 'c1', turn: 1, step: 1, callId: 'c1', name: 'Grep', argsJson: '{"q":"x"}', time: 1_100 },
        { type: 'tool.result', seq: 4, turn: 1, step: 1, callId: 'c1', isError: false, time: 1_200, content: [{ type: 'text', text: 'hit' }], text: 'hit' },
        { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 1_300 },
      ], { replay: false })
    }
    check('compose: fold reports supported once events flow', channel.trajectorySource() === 'supported')
    const folded = buildTrajectory(channel.traceEvents() as never)
    check('compose: traceEvents feeds the shared fold', folded.nodes.some(node => node.label === 'Grep') && folded.counts.rows > 0, 'rows=' + folded.counts.rows)
    channel.releaseContributions()
  }

  // ── 7. surfaces: scene at 40 cols, panel at 28 ───────────────────────────
  {
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'step.start', turn: 1, step: 1 }, false)
    source.observe({ type: 'tool.call', seq: 3, anchor: 'c1', turn: 1, step: 1, callId: 'c1', name: 'Grep', argsJson: '{"q":"fold"}', time: 1_100 }, false)
    source.observe({ type: 'tool.result', seq: 4, turn: 1, step: 1, callId: 'c1', isError: false, time: 1_200, content: [{ type: 'text', text: 'hit' }], text: 'hit' }, false)
    source.observe({ type: 'assistant.message', seq: 5, anchor: 'm1', turn: 1, step: 1, attemptId: 'a1', time: 1_300, blocks: [{ type: 'text', text: 'folded reply' }], usage: { input: 5, output: 6 }, canonical: true }, false)
    source.observe({ type: 'step.end', turn: 1, step: 1 }, false)
    source.observe({ type: 'turn.end', turn: 1, reason: { kind: 'completed' }, time: 1_400 }, false)
    const build = fold()
    const channel = { sessionTitle: 'fold probe', cwd: 'C:/code/demo', traceEvents: () => source.events(), trajectorySource: () => 'supported', subscribe: () => () => {} }
    {
      const h = makeTerminalHarness(40, 24)
      const app = await render(
        <ThemeProvider theme="dark">
          <TrajectoryScene channel={channel as never} build={build} onClose={() => {}} />
        </ThemeProvider>,
        { stdout: h.stdout as unknown as NodeJS.WriteStream, stdin: h.stdin as unknown as NodeJS.ReadStream, stderr: h.stderr as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false },
      )
      check('scene/40col: folded ledger renders (tool + reply)', await settled(() => h.screen().includes('Grep') && h.screen().includes('folded reply')))
      await app.unmount(); h.term.dispose()
    }
    {
      const panelRuntime = {
        registerInput() { return () => undefined },
      }
      function PanelHarness(): React.ReactNode {
        useInput(() => {}, { isActive: true })
        return (
          <SidePanelRuntimeContext.Provider value={{ runtime: panelRuntime as never, channel: channel as never, trajectory: build }}>
            <PanelContext.Provider value={{ panelId: 'trajectory' }}>
              <Box width={28} height={16}>
                <TrajectoryPanel width={28} height={16} focused visible mode="split" />
              </Box>
            </PanelContext.Provider>
          </SidePanelRuntimeContext.Provider>
        )
      }
      const h = makeTerminalHarness(30, 18)
      const app = await render(<ThemeProvider theme="dark"><PanelHarness /></ThemeProvider>, {
        stdout: h.stdout as unknown as NodeJS.WriteStream, stdin: h.stdin as unknown as NodeJS.ReadStream, stderr: h.stderr as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false,
      })
      check('panel/28col: narrow panel renders folded rows', await settled(() => h.screen().includes('Grep')), h.lines().slice(0, 8).join(' / '))
      await app.unmount(); h.term.dispose()
    }
    source.reset()
  }
} finally {
  // (each section resets the shared source)
}

if (failed > 0) {
  console.error('FAILED: ' + failed + ' check(s).')
  process.exit(1)
}
console.log('OK: agent trajectory fold all checks passed.')
process.exit(0)
