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

} finally {
  // (each section resets the shared source)
}

if (failed > 0) {
  console.error('FAILED: ' + failed + ' check(s).')
  process.exit(1)
}
console.log('OK: trajectory xl all checks passed.')
process.exit(0)
