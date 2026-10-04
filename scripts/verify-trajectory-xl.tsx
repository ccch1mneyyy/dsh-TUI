/**
 * Trajectory XL regression (design agent-team-panels.md §4 完整档):
 *  1. approval/question wait-segment detail — asked-time source/options
 *     survive the fold, the inspector renders response (paired ask-tool
 *     result) + source + question snapshots, a waiting row shows a LIVE
 *     elapsed, and an unreadable owning event degrades honestly;
 *  2. cross-agent drilldown — parentCallId-routed lane logs (main lane
 *     byte-identical: child traffic stays out), lane roster with tree
 *     facts, descendants merge in seq order, re-key adoption, incremental
 *     lane fold === from-scratch, and the scope filter (a key + chip) in
 *     the fullscreen scene AND the side panel: 当前 Agent / 父回合 / 全部
 *     后代 / 会话, with Esc popping the scope before closing;
 *  3. long-session virtualization — the shared ledgerWindow clamp
 *     properties, and a ~2k-row session rendering exactly one viewport's
 *     worth of rows with working G/g jumps;
 *  4. the source label — the scene states which backend feeds it.
 *
 * Run: node --import tsx/esm scripts/verify-trajectory-xl.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { TrajectoryPanel }, { TrajectoryScene }, contexts, { setLang, t }, trajApi, windowApi] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/TrajectoryPanel.js'),
  import('../src/screens/TrajectoryScene.js'),
  import('../src/components/sidePanel/SidePanelRuntimeContext.js'),
  import('../src/i18n.js'),
  import('../src/dsh-adapter/trajectory/index.js'),
  import('../src/trajectory/window.js'),
])
const { render, ThemeProvider, Box, useInput } = ui
const { SidePanelRuntimeContext, PanelContext } = contexts
const { buildTrajectory, extendTrajectory, inspectNode, createAgentTrajectorySource } = trajApi
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
const fold = (): ReturnType<typeof buildTrajectory> => buildTrajectory(source.events())
const rowsOf = (build: ReturnType<typeof buildTrajectory>, kind: string) => build.nodes.filter(node => node.kind === kind)

// ─── shared terminal harness (mirrors verify-trajectory-agent-fold) ──────────
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
/** stdin 双写合并坑：一个键写完让出一轮事件循环再写下一个。 */
const writeKey = async (stdin: PassThrough, data: string): Promise<void> => {
  stdin.write(data)
  await new Promise(resolve => setImmediate(resolve))
}

try {
  // ── 1a. wait-segment detail over DSH-shaped raw events (the inspector is
  //        payload-agnostic: whatever the asked event carried renders) ─────
  {
    let rawSeq = 0
    const T0 = 1_700_000_000_000
    const ev = (type: string, data: Record<string, unknown>): Record<string, unknown> =>
      ({ type, seq: ++rawSeq, time: T0 + rawSeq * 250, data })
    const events: Record<string, unknown>[] = [
      ev('turn/start', { turn: 1 }),
      ev('approval/asked', {
        id: 'r1', toolName: 'Write', callId: 'cw', reason: 'outside sandbox', ask: 'permission',
        agentId: 'sa9', title: 'Write outside the sandbox', command: 'rm -rf build', blockedPath: '../outside',
        options: ['allow-once', 'No, and tell it why'],
      }),
      ev('approval/decided', { id: 'r1', outcome: 'rejected' }),
      ev('approval/asked', {
        id: 'q1', toolName: 'question', callId: 'q9', reason: 'Which mode?', ask: 'question', agentId: 'sa8',
        questions: [
          { header: 'Mode', question: 'Which mode?', options: ['Fast', 'Slow'] },
          { question: 'Any extras?', options: ['None'] },
        ],
      }),
      ev('approval/decided', { id: 'q1', outcome: 'settled' }),
      ev('tool/result', { message: { source: { callId: 'q9' }, content: [{ type: 'text', text: 'Fast; None' }] } }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    const build = buildTrajectory(events as never)
    const approvals = rowsOf(build, 'approval')
    check('wait/raw: asked/decided brackets fold with their own durations',
      approvals.length === 2 && approvals[0]!.durationMs === 250 && approvals[0]!.status === 'error'
        && approvals[1]!.status === 'ok')
    const detail = inspectNode(approvals[0]!, events as never)
    const sourceBody = detail.sections.find(section => section.title === 'source')?.body ?? ''
    check('wait/raw: ask-time source identity renders (agent/command/blocked/options)',
      sourceBody.includes('sa9') && sourceBody.includes('rm -rf build') && sourceBody.includes('../outside')
        && sourceBody.includes('allow-once') && sourceBody.includes('No, and tell it why'),
      sourceBody.replace(/\s+/g, ' ').slice(0, 90))
    check('wait/raw: settled denial keeps the outcome section',
      detail.sections.some(section => section.title === 'outcome' && section.body === 'rejected'))
    check('wait/raw: a settled permission reports no fabricated response body',
      detail.sections.every(section => section.title !== 'response'))
    const q = inspectNode(approvals[1]!, events as never)
    const questions = q.sections.find(section => section.title === 'questions')?.body ?? ''
    check('wait/raw: question snapshot renders headers + option labels',
      questions.includes('[Mode] Which mode?') && questions.includes('Fast | Slow') && questions.includes('Any extras?'),
      questions.replace(/\s+/g, ' ').slice(0, 80))
    const response = q.sections.find(section => section.title === 'response')?.body
    check('wait/raw: settled answer recovered from the paired ask-tool result', response === 'Fast; None', String(response))
    check('wait/raw: the paired result adds no orphan tool row', rowsOf(build, 'tool').length === 0)
    // An unreadable owning event degrades honestly instead of silently
    // showing nothing (design §4 i18n trajectory-inspect-unavailable).
    const toolEvents: Record<string, unknown>[] = [
      ev('tool/call', { turn: 1, step: 1, callId: 'cx', name: 'Read', arguments: '{}' }),
    ]
    const toolRow = rowsOf(buildTrajectory(toolEvents as never), 'tool')[0]!
    check('wait/raw: missing owning event marks the detail unresolved',
      inspectNode(toolRow, [] as never).unresolved === true)
    check('wait/raw: resolvable rows are not marked', inspectNode(toolRow, toolEvents as never).unresolved !== true)
  }

  // ── 1b. the neutral AgentEvent source carries the same fields ─────────────
  {
    // W1: permission ask carries source identity + offered options through
    // the fold; the settled outcome pairs by requestId.
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'step.start', turn: 1, step: 1 }, false)
    source.observe({
      type: 'permission.request',
      request: {
        requestId: 'r1', toolName: 'Write', callId: 'cw', agentId: 'sa9',
        title: 'Write outside the sandbox', command: 'rm -rf build', blockedPath: '../outside',
        reason: 'outside sandbox',
        options: [{ id: 'a', kind: 'allow-once' }, { id: 'd', kind: 'reject', label: 'No, and tell it why' }],
      },
    }, false)
    let build = fold()
    let approval = rowsOf(build, 'approval')[0]!
    check('wait: asked row is a running approval bracket', approval.status === 'running' && approval.label === 'Write')
    let detail = inspectNode(approval, source.events())
    const sourceBody = detail.sections.find(section => section.title === 'source')?.body ?? ''
    check('wait: ask-time source identity survives (agent/command/blocked/options)',
      sourceBody.includes('sa9') && sourceBody.includes('rm -rf build') && sourceBody.includes('../outside')
        && sourceBody.includes('allow-once') && sourceBody.includes('No, and tell it why'),
      sourceBody.replace(/\s+/g, ' ').slice(0, 90))
    check('wait: permission carries no question snapshot', detail.sections.every(section => section.title !== 'questions'))
    source.observe({ type: 'permission.settled', requestId: 'r1', outcome: 'rejected' }, false)
    build = fold()
    approval = rowsOf(build, 'approval')[0]!
    detail = inspectNode(approval, source.events())
    check('wait: settled denial closes with the outcome + own duration',
      approval.status === 'error' && approval.durationMs === 10 && approval.outcome === 'rejected'
        && detail.sections.some(section => section.title === 'outcome' && section.body === 'rejected'))
    check('wait: a settled permission reports no fabricated response body',
      detail.sections.every(section => section.title !== 'response'))
    source.reset()
  }
  {
    // W2: a questionnaire snapshot folds bounded questions; the ANSWER is
    // recovered from the ask tool's paired result (callId lookup).
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({
      type: 'question.request',
      request: {
        requestId: 'q1', callId: 'q9', agentId: 'sa8',
        questions: [
          { header: 'Mode', question: 'Which mode?', options: [{ label: 'Fast' }, { label: 'Slow' }] },
          { question: 'Any extras?', options: [{ label: 'None' }] },
        ],
      },
    }, false)
    let approval = rowsOf(fold(), 'approval')[0]!
    let detail = inspectNode(approval, source.events())
    const questions = detail.sections.find(section => section.title === 'questions')?.body ?? ''
    check('wait: question snapshot renders headers + option labels',
      questions.includes('[Mode] Which mode?') && questions.includes('Fast | Slow') && questions.includes('Any extras?'),
      questions.replace(/\s+/g, ' ').slice(0, 80))
    check('wait: waiting question has no response yet', detail.sections.every(section => section.title !== 'response'))
    source.observe({ type: 'question.settled', requestId: 'q1' }, false)
    source.observe({
      type: 'tool.result', seq: 42, turn: 1, step: 1, callId: 'q9', isError: false, time: 2_000,
      content: [{ type: 'text', text: 'Fast; None' }], text: 'Fast; None',
    }, false)
    approval = rowsOf(fold(), 'approval')[0]!
    detail = inspectNode(approval, source.events())
    const response = detail.sections.find(section => section.title === 'response')?.body
    check('wait: settled answer recovered from the paired ask-tool result', response === 'Fast; None', String(response))
    // The paired result folds no orphan tool row (no tool.call for q9).
    check('wait: the paired result adds no orphan tool row', rowsOf(fold(), 'tool').length === 0)
    source.reset()
  }
  {
    // W3: an unreadable owning event degrades honestly instead of silently
    // showing nothing (design §4 i18n trajectory-inspect-unavailable).
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'step.start', turn: 1, step: 1 }, false)
    source.observe({ type: 'tool.call', seq: 3, anchor: 'cx', turn: 1, step: 1, callId: 'cx', name: 'Read', argsJson: '{}', time: 1_100 }, false)
    const whole = fold()
    const toolRow = rowsOf(whole, 'tool')[0]!
    const truncated = source.events().slice(0, 2)
    const detail = inspectNode(toolRow, truncated)
    check('wait: missing owning event marks the detail unresolved', detail.unresolved === true)
    check('wait: resolvable rows are not marked', inspectNode(toolRow, source.events()).unresolved !== true)
    source.reset()
  }

  // ── 2. cross-agent drilldown: lanes ───────────────────────────────────────
  {
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'step.start', turn: 1, step: 1 }, false)
    source.observe({ type: 'tool.call', seq: 3, anchor: 't1', turn: 1, step: 1, callId: 't1', name: 'Task', argsJson: '{}', time: 1_100 }, false)
    source.observe({ type: 'subagent.start', agentId: 'sa1', parentCallId: 't1', description: 'scan the repo', model: 'gpt-5.6-sol', background: false, time: 1_150 }, false)
    source.observe({ type: 'tool.call', seq: 8, anchor: 'cc1', turn: 1, step: 1, callId: 'cc1', name: 'childtool', argsJson: '{}', time: 1_200, parentCallId: 't1' }, false)
    source.observe({ type: 'tool.result', seq: 9, turn: 1, step: 1, callId: 'cc1', isError: false, time: 1_240, content: [{ type: 'text', text: 'child out' }], text: 'child out', parentCallId: 't1' }, false)
    source.observe({ type: 'assistant.message', seq: 10, anchor: 'cm1', turn: 1, step: 1, attemptId: 'ca1', time: 1_250, blocks: [{ type: 'text', text: 'child says' }], canonical: true, parentCallId: 't1' }, false)
    // A grandchild: the child's own Task call (inside lane sa1) spawns sa2.
    source.observe({ type: 'tool.call', seq: 11, anchor: 'g0', turn: 1, step: 1, callId: 'g0', name: 'grandtask', argsJson: '{}', time: 1_260, parentCallId: 't1' }, false)
    source.observe({ type: 'subagent.start', agentId: 'sa2', parentCallId: 'g0', description: 'grand scan', background: false, time: 1_270 }, false)
    source.observe({ type: 'tool.call', seq: 12, anchor: 'gc1', turn: 1, step: 1, callId: 'gc1', name: 'grandtool', argsJson: '{}', time: 1_280, parentCallId: 'g0' }, false)
    source.observe({ type: 'subagent.end', agentId: 'sa1', status: 'completed', usage: { total: 999 }, time: 1_400 }, false)

    const build = fold()
    check('lane: main ledger keeps child traffic out (R14 parity)',
      rowsOf(build, 'tool').every(node => node.callId !== 'cc1') && rowsOf(build, 'assistant').every(node => node.detail !== 'child says'))
    const descriptor = rowsOf(build, 'context').find(node => node.label === 'subagent')!
    check('lane: descriptor row carries the drilldown anchor', descriptor.agentId === 'sa1')
    const lanes = source.lanes()
    check('lane: roster registers both lanes with tree facts',
      lanes.length === 2 && lanes[0]!.agentId === 'sa1' && lanes[0]!.callId === 't1' && lanes[0]!.label === 'scan the repo'
        && lanes[1]!.agentId === 'sa2' && lanes[1]!.parentAgentId === 'sa1' && lanes[1]!.depth === 2,
      JSON.stringify(lanes.map(lane => [lane.agentId, lane.parentAgentId, lane.depth])))
    const laneBuild = buildTrajectory(source.laneEvents('sa1'))
    check('lane: lane log folds the child stream (own calls included, grandchild lane excluded)',
      laneBuild.nodes.some(node => node.label === 'childtool') && laneBuild.nodes.some(node => node.detail === 'child says')
        && laneBuild.nodes.some(node => node.label === 'grandtask')
        && laneBuild.nodes.every(node => node.label !== 'grandtool'))
    const grandBuild = buildTrajectory(source.laneEvents('sa2'))
    check('lane: grandchild lane holds its own call', grandBuild.nodes.some(node => node.label === 'grandtool'))
    const merged = source.descendantEvents('sa1')
    const seqs = merged.map(event => event.seq)
    check('lane: descendants merge is seq-sorted and covers both lanes',
      seqs.length === 5 && seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!)
        && merged.some(event => (event.data as Record<string, unknown>).name === 'grandtool'))
    // Incremental lane fold === from-scratch (prefix identity contract).
    let piecewise: ReturnType<typeof buildTrajectory> | null = null
    const stages = [3, 5].map(count => Object.freeze([...merged.slice(0, count)]))
    for (const stage of stages) piecewise = extendTrajectory(piecewise, stage)
    const wholeLane = buildTrajectory(merged)
    const pick = (nodes: readonly { kind: string; label: string; seq: number }[]) => nodes.map(node => node.kind + node.label + node.seq).join(';')
    check('lane: incremental fold === from-scratch', pick(piecewise!.nodes) === pick(wholeLane.nodes))
    // Re-key: a second start for the same anchor adopts the earlier events.
    source.observe({ type: 'subagent.start', agentId: 'sa1-named', parentCallId: 't1', description: 'scan the repo', background: false, time: 1_500 }, false)
    const rekeyed = source.lanes()
    check('lane: re-key replaces the roster entry',
      rekeyed.length === 2 && rekeyed.some(lane => lane.agentId === 'sa1-named') && !rekeyed.some(lane => lane.agentId === 'sa1'))
    const adopted = buildTrajectory(source.laneEvents('sa1-named'))
    check('lane: re-keyed lane adopts the earlier events', adopted.nodes.some(node => node.label === 'childtool'))
    check('lane: the old id resolves through the alias', buildTrajectory(source.laneEvents('sa1')).nodes.length === adopted.nodes.length)
    source.reset()
  }

  // ── 3. scope filter in the fullscreen scene (a key + chip + Esc) ─────────
  // (chip assertions match the glyph prefix: a chip label like 'agent x' is
  // always a substring of the descriptor row's 'subagent x', so the text
  // alone cannot distinguish chip from row.)
  {
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'step.start', turn: 1, step: 1 }, false)
    source.observe({ type: 'tool.call', seq: 3, anchor: 't1', turn: 1, step: 1, callId: 't1', name: 'Task', argsJson: '{}', time: 1_100 }, false)
    source.observe({ type: 'subagent.start', agentId: 'sa1', parentCallId: 't1', description: 'scan the repo', background: false, time: 1_150 }, false)
    source.observe({ type: 'tool.call', seq: 8, anchor: 'cc1', turn: 1, step: 1, callId: 'cc1', name: 'childtool', argsJson: '{}', time: 1_200, parentCallId: 't1' }, false)
    source.observe({ type: 'assistant.message', seq: 10, anchor: 'cm1', turn: 1, step: 1, attemptId: 'ca1', time: 1_250, blocks: [{ type: 'text', text: 'child says' }], canonical: true, parentCallId: 't1' }, false)
    const build = fold()
    const channel = {
      sessionTitle: 'xl probe', cwd: 'C:/code/demo',
      traceEvents: () => source.events(),
      trajectorySource: () => 'supported',
      trajectoryLanes: () => source.lanes(),
      trajectoryLaneEvents: (agentId: string, descendants?: boolean) =>
        (descendants === true ? source.descendantEvents(agentId) : source.laneEvents(agentId)),
      trajectoryBackendLabel: () => t('trajectory-backend-agent-events'),
      subscribe: () => () => {},
    }
    let closed = 0
    const h = makeTerminalHarness(140, 24)
    const app = await render(
      <ThemeProvider theme="dark">
        <TrajectoryScene channel={channel as never} build={build} onClose={() => { closed += 1 }} />
      </ThemeProvider>,
      { stdout: h.stdout as unknown as NodeJS.WriteStream, stdin: h.stdin as unknown as NodeJS.ReadStream, stderr: h.stderr as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false },
    )
    // The descriptor row is the session ledger's last row; arrival pins the
    // cursor to the tail, so 'a' drills straight into it.
    check('scope/scene: drill hint appears once lanes exist', await settled(() => h.screen().includes(t('trajectory-drill-hint'))))
    check('scope/scene: source label names the mounted fold (header)', await settled(() => h.screen().includes(t('trajectory-backend-agent-events'))))
    await writeKey(h.stdin, 'a')
    check('scope/scene: agent scope chip + lane rows render', await settled(() => h.screen().includes('\u25c6 agent') && h.screen().includes('childtool')))
    await writeKey(h.stdin, 'a')
    check('scope/scene: parent-turn scope shows the delegating turn only',
      await settled(() => h.screen().includes('\u25c6 parent turn 1') && h.screen().includes('Task') && !h.screen().includes('childtool')))
    await writeKey(h.stdin, 'a')
    check('scope/scene: descendants scope renders the subtree lane',
      await settled(() => h.screen().includes('\u25c6 descendants') && h.screen().includes('childtool')))
    await writeKey(h.stdin, 'a')
    check('scope/scene: cycle returns to the session scope', await settled(() => !h.screen().includes('\u25c6 ') && h.screen().includes('Task')))
    // Esc layering: scope first, scene close second.
    await writeKey(h.stdin, '\u001b[B'); await writeKey(h.stdin, '\u001b[B'); await writeKey(h.stdin, '\u001b[B')
    await writeKey(h.stdin, 'a')
    check('scope/scene: re-drill from the descriptor row', await settled(() => h.screen().includes('\u25c6 agent')))
    await writeKey(h.stdin, '\u001b')
    check('scope/scene: Esc pops the scope, not the scene', (await settled(() => !h.screen().includes('\u25c6 '))) && closed === 0)
    await writeKey(h.stdin, '\u001b')
    check('scope/scene: a second Esc leaves the scene', await settled(() => closed === 1))
    await app.unmount(); h.term.dispose()
    source.reset()
  }

  // ── 4. scope filter in the side panel (a key + chip; Esc stays host's) ────
  {
    source.observe({ type: 'turn.start', turn: 1, origin: 'user', time: 1_000 }, false)
    source.observe({ type: 'tool.call', seq: 3, anchor: 't1', turn: 1, step: 1, callId: 't1', name: 'Task', argsJson: '{}', time: 1_100 }, false)
    source.observe({ type: 'subagent.start', agentId: 'sa1', parentCallId: 't1', description: 'scan the repo', background: false, time: 1_150 }, false)
    source.observe({ type: 'tool.call', seq: 8, anchor: 'cc1', turn: 1, step: 1, callId: 'cc1', name: 'childtool', argsJson: '{}', time: 1_200, parentCallId: 't1' }, false)
    const build = fold()
    const channel = {
      sessionTitle: 'panel probe', cwd: 'C:/code/demo',
      traceEvents: () => source.events(),
      trajectorySource: () => 'supported',
      trajectoryLanes: () => source.lanes(),
      trajectoryLaneEvents: (agentId: string, descendants?: boolean) =>
        (descendants === true ? source.descendantEvents(agentId) : source.laneEvents(agentId)),
      subscribe: () => () => {},
    }
    const registered = new Map<string, { handler: (input: string, key: Record<string, boolean | undefined>) => boolean | void; enabled: boolean }>()
    const panelRuntime = {
      registerInput(id: string, handler: (input: string, key: Record<string, boolean | undefined>) => boolean | void, enabled: boolean) {
        registered.set(id, { handler, enabled })
        return () => { registered.delete(id) }
      },
    }
    function PanelHarness(): React.ReactNode {
      useInput(() => {}, { isActive: true })
      return (
        <SidePanelRuntimeContext.Provider value={{ runtime: panelRuntime as never, channel: channel as never, trajectory: build }}>
          <PanelContext.Provider value={{ panelId: 'trajectory' }}>
            <Box width={60} height={18}>
              <TrajectoryPanel width={60} height={18} focused visible mode="split" />
            </Box>
          </PanelContext.Provider>
        </SidePanelRuntimeContext.Provider>
      )
    }
    const h = makeTerminalHarness(64, 20)
    const app = await render(<ThemeProvider theme="dark"><PanelHarness /></ThemeProvider>, {
      stdout: h.stdout as unknown as NodeJS.WriteStream, stdin: h.stdin as unknown as NodeJS.ReadStream, stderr: h.stderr as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false,
    })
    // (the panel hint truncates the drill teaching at real panel widths —
    // truncateWidth is the intended behavior; the scene covers the hint.)
    check('scope/panel: session rows render with lanes available', await settled(() => h.screen().includes('Task')))
    const handler = Array.from(registered.values())[0]!.handler
    await new Promise(resolve => setImmediate(resolve))
    // The descriptor is the tail row; arrival pins the panel cursor there.
    check('scope/panel: a key drills and is consumed', handler('a', {}) === true)
    check('scope/panel: chip + lane rows render', await settled(() => h.screen().includes('\u25c6 agent') && h.screen().includes('childtool')))
    check('scope/panel: scope hint names the cycle key', await settled(() => h.screen().includes('a cycle scope')))
    check('scope/panel: Esc stays unconsumed (host owns it)', handler('', { escape: true }) === false)
    // agent → parent-turn → descendants → session: three cycles home.
    check('scope/panel: a cycles through the scopes', handler('a', {}) === true && handler('a', {}) === true && handler('a', {}) === true)
    check('scope/panel: session scope restored', await settled(() => !h.screen().includes('\u25c6 ') && h.screen().includes('Task')))
    await app.unmount(); h.term.dispose()
    source.reset()
  }

  // ── 5. long-session virtualization ────────────────────────────────────────
  {
    const { ledgerWindow } = windowApi
    const head = ledgerWindow(100, 0, 10)
    const mid = ledgerWindow(100, 50, 10)
    const tail = ledgerWindow(100, 99, 10)
    check('window: head pins to 0', head.start === 0 && head.end === 10)
    check('window: cursor stays inside, centered while room allows', mid.start === 45 && mid.end === 55 && 50 >= mid.start && 50 < mid.end)
    check('window: tail shows the last full page', tail.start === 90 && tail.end === 100)
    check('window: short list windows from 0', ledgerWindow(4, 3, 10).start === 0 && ledgerWindow(4, 3, 10).end === 10)
    check('window: empty list windows to (0, rows)', ledgerWindow(0, 7, 10).start === 0 && ledgerWindow(0, 7, 10).end === 10)
    check('window: stale cursor past the end is clamped', ledgerWindow(30, 999, 10).start === 20)

    // A ~2k-row session renders exactly one viewport of rows; G/g still jump.
    const events: Record<string, unknown>[] = []
    let seq = 0
    const T0 = 1_700_000_000_000
    const ev = (type: string, data: Record<string, unknown>): void => {
      seq += 1
      events.push({ type, seq, time: T0 + seq * 7, data })
    }
    for (let index = 0; index < 1000; index++) {
      const name = 'zq' + String(index).padStart(4, '0')
      ev('tool/call', { turn: 1, step: 1, callId: 'c' + index, name, arguments: '{}' })
      ev('tool/result', { turn: 1, step: 1, message: { source: { callId: 'c' + index }, content: [{ type: 'text', text: 'o' }] } })
    }
    const long = buildTrajectory(events as never)
    check('window: synthetic long session folds 1k rows', long.nodes.length === 1000, String(long.nodes.length))
    const channel = {
      sessionTitle: 'long probe', cwd: 'C:/code/demo',
      traceEvents: () => events as never,
      trajectorySource: () => 'supported',
      trajectoryLanes: () => [],
      trajectoryLaneEvents: () => [],
      trajectoryBackendLabel: () => t('trajectory-backend-agent-events'),
      subscribe: () => () => {},
    }
    const startedAt = Date.now()
    const h = makeTerminalHarness(100, 24)
    const app = await render(
      <ThemeProvider theme="dark">
        <TrajectoryScene channel={channel as never} build={long} onClose={() => {}} />
      </ThemeProvider>,
      { stdout: h.stdout as unknown as NodeJS.WriteStream, stdin: h.stdin as unknown as NodeJS.ReadStream, stderr: h.stderr as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false },
    )
    check('window: tail window renders after arrival', await settled(() => h.screen().includes('zq0999')))
    check('window: rows above the window stay unpainted', await settled(() => !h.screen().includes('zq0005')))
    await writeKey(h.stdin, 'g')
    check('window: g jumps to the head window', await settled(() => h.screen().includes('zq0000') && !h.screen().includes('zq0999')))
    await writeKey(h.stdin, 'G')
    check('window: G jumps back to the tail window', await settled(() => h.screen().includes('zq0999') && !h.screen().includes('zq0000')))
    const elapsed = Date.now() - startedAt
    check('window: the long-session round trip stays within budget', elapsed < 15_000, elapsed + 'ms')
    await app.unmount(); h.term.dispose()
  }
} finally {
  // (each section resets the shared source)
}

if (failed > 0) {
  console.error('FAILED: ' + failed + ' check(s).')
  process.exit(1)
}
console.log('OK: trajectory xl all checks passed.')
process.exit(0)
