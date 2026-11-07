/**
 * Agent Teams in the agents dashboard (issue #1241, phase 2): the roster
 * joined with the subagent rows (src/components/teamRoster.ts) and the team
 * mode of SubagentDashboard — member names and states, the Lead line, the
 * other subagents, the read-only task board and the failure banner — in the
 * full-screen and panel forms, at a normal and a narrow width, with a
 * wide-character member name. A roster-only member is not a detail target.
 * Without a team the dashboard keeps its subagent form (byte-for-byte
 * coverage of that form stays with verify-agent-view-ui / verify-agent-workbench).
 *
 * Run: node --import tsx/esm scripts/verify-team-dashboard.tsx
 */
process.env.FORCE_COLOR = '0'
process.env.DSH_TUI_LANG = 'en'
const [{ mkdtempSync, rmSync }, { tmpdir }, { join }] = await Promise.all([
  import('node:fs'),
  import('node:os'),
  import('node:path'),
])
const dataDir = mkdtempSync(join(tmpdir(), 'verify-team-dashboard-data-'))
process.env.HOME = dataDir
process.env.USERPROFILE = dataDir

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, termTest, dashboard, roster, width] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('./lib/term-test.mjs'),
  import('../src/components/SubagentDashboard.js'),
  import('../src/components/teamRoster.js'),
  import('../src/ink/stringWidth.js'),
])
const { settled, viewportLines } = termTest
const { render } = ui
const { SubagentDashboard } = dashboard
const { teamDashboardModel, teamMemberCounts, teamMemberStatus, teamTaskProgress } = roster
type SubagentState = import('../src/dsh-adapter/subagents.js').SubagentState
type TeamView = import('../src/adapter/ports/channel-view.js').TeamView

let failed = 0
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}
/** Language-independent probe: the banner glyph plus the provider name, so the
 *  assertion does not depend on which dictionary the test process picked. */
const bannered = (screen: string, provider: string): boolean =>
  screen.split('\n').some(line => line.includes('⚠') && line.includes(provider))

const NOW = Date.now()
const LEAD = 'lead-1'
const row = (agentId: string, over: Partial<SubagentState> = {}): SubagentState => ({
  agentId, description: `desc of ${agentId}`, status: 'completed', startedAt: NOW - 60_000, completedAt: NOW - 10_000,
  mode: 'continuable', output: [], outputEvents: [], toolCalls: [], ...over,
})
const task = (id: string, over: Partial<TeamView['tasks'][number]> = {}): TeamView['tasks'][number] => ({
  id, revision: 1, subject: `subject ${id}`, description: '', status: 'pending', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [], ...over,
})
const team: TeamView = {
  leadSessionId: LEAD,
  members: [
    { id: LEAD, name: 'lead', role: 'lead', phase: 'active' },
    { id: 'mate-run', name: 'builder', role: 'teammate', phase: 'active' },
    { id: 'mate-done', name: 'reviewer', role: 'teammate', phase: 'active' },
    { id: 'mate-new', name: 'planner', role: 'teammate', phase: 'provisioning' },
    { id: 'mate-bad', name: 'tester', role: 'teammate', phase: 'failed', error: 'spawn refused' },
  ],
  tasks: [
    task('t1', { status: 'completed', subject: 'Draft the plan', ownerName: 'planner' }),
    task('t2', { status: 'in_progress', subject: 'Build it', ownerName: 'builder', writeScopeWarnings: ['src overlaps'] }),
    task('t3', { subject: 'Review it', blockedBy: ['t2'], ready: false }),
  ],
}
const subagents: SubagentState[] = [
  row('mate-run', { status: 'running', completedAt: undefined }),
  row('mate-done', { status: 'failed', error: 'model overloaded' }),
  row('mate-bad', { status: 'completed' }),
  row('workflow-1', { description: 'workflow step', mode: 'one-shot' }),
]

// ── pure join ────────────────────────────────────────────────────────────
{
  const model = teamDashboardModel(team, subagents)
  check('model: Lead taken from the roster', model.lead?.name === 'lead')
  check('model: teammates in roster order', model.teammates.map(r => r.member.name).join() === 'builder,reviewer,planner,tester')
  check('model: statuses are synthesized, not copied',
    model.teammates.map(r => r.status).join() === 'running,idle,provisioning,failed', model.teammates.map(r => r.status).join())
  check('model: a provisioning member has no row yet', model.teammates[2]?.subagent === undefined)
  check('model: non-members stay as other subagents', model.others.map(r => r.agentId).join() === 'workflow-1')
  const active = team.members[2]!
  check('status: a completed run is idle, never done', teamMemberStatus(active, row('x')) === 'idle')
  check('status: a failed run of an active member is idle', teamMemberStatus(active, row('x', { status: 'failed' })) === 'idle')
  check('status: no row reads idle', teamMemberStatus(active, undefined) === 'idle')
  check('status: starting reads running', teamMemberStatus(active, row('x', { status: 'starting' })) === 'running')
  check('status: a failed phase wins over a running row', teamMemberStatus(team.members[4]!, row('x', { status: 'running' })) === 'failed')
  // Inside a teammate its rows are its own children: never joined, no run known.
  const peer = teamDashboardModel(team, [row('mate-run', { status: 'running' }), row('child-1')], 'mate-done')
  check('teammate view: not from the Lead', !peer.viewedFromLead && model.viewedFromLead)
  check('teammate view: active members read active, durable phases kept',
    peer.teammates.map(r => r.status).join() === 'active,active,provisioning,failed', peer.teammates.map(r => r.status).join())
  check('teammate view: no row is joined to a member', peer.teammates.every(r => r.subagent === undefined))
  check('teammate view: its own rows stay other subagents', peer.others.map(r => r.agentId).join() === 'mate-run,child-1')
  check('status: an unknown run of an active member reads active', teamMemberStatus(active, row('x', { status: 'running' }), false) === 'active')
  check('counts: from the Lead, running and provisioning members are active, none unseen',
    JSON.stringify(teamMemberCounts(team, subagents, LEAD)) === '{"total":4,"active":2,"unseen":0}', JSON.stringify(teamMemberCounts(team, subagents, LEAD)))
  check('counts: inside a teammate, a sibling\'s run is unseen, provisioning stays known, the teammate itself counts in neither',
    JSON.stringify(teamMemberCounts(team, [], 'mate-done')) === '{"total":4,"active":1,"unseen":1}', JSON.stringify(teamMemberCounts(team, [], 'mate-done')))
  check('tasks: progress counts completed', JSON.stringify(teamTaskProgress(team.tasks)) === '{"completed":1,"total":3}')
}

// ── rendering ────────────────────────────────────────────────────────────
interface Frame { lines: string[]; stdin: PassThrough; unmount(): void; read(): string[]; rerender(props: Record<string, unknown>): void }

async function mount(cols: number, rows: number, props: Record<string, unknown>, anchor: string): Promise<Frame> {
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  class Sink extends Writable {
    isTTY = true
    _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new FakeStdin()
  const instance = await render(
    <SubagentDashboard subagents={subagents} {...props} />,
    { stdout: new FakeStdout(), stdin, stderr: new Sink(), exitOnCtrlC: false, patchConsole: false },
  )
  const read = () => viewportLines(term, rows).map((line: string) => line.trimEnd())
  await settled(() => read().some((line: string) => line.includes(anchor)))
  const rerender = (next: Record<string, unknown>): void => { instance.rerender(<SubagentDashboard subagents={subagents} {...next} />) }
  return { lines: read(), stdin, unmount: () => instance.unmount(), read, rerender }
}

try {
  {
    const selected: string[] = []
    const f = await mount(100, 40, { team, onSelect: (id: string) => selected.push(id), onClose: () => {} }, 'Tasks')
    const screen = f.lines.join('\n')
    check('full: team title', screen.includes('Agent Team'), f.lines[0])
    check('full: member counts (provisioning included) and task progress in the header',
      /1 running\s+1 idle\s+1 provisioning\s+1 failed\s+tasks 1\/3/.test(screen), f.lines.slice(0, 4).join('|'))
    check('full: the Lead line', screen.includes('◆ lead · this session'))
    check('full: a teammate card shows its name, not its description',
      f.lines.some(line => line.includes('builder') && line.includes('running')) && !screen.includes('desc of mate-run'))
    check('full: a teammate whose run failed reads idle', f.lines.some(line => line.includes('reviewer') && line.includes('idle')))
    check('full: its failed last run is shown under the card', screen.includes('│ last run failed model overloaded'))
    check('full: no continuable badge on a teammate', !f.lines.some(line => line.includes('reviewer') && line.includes('continuable')))
    check('full: a provisioning member is listed', f.lines.some(line => line.includes('planner') && line.includes('provisioning')))
    check('full: a failed member shows its error', f.lines.some(line => line.includes('tester') && line.includes('failed')) && screen.includes('│ spawn refused'))
    check('full: other subagents keep their own card', screen.includes('Other subagents') && screen.includes('Subagent: workflow step'))
    check('full: task board lines', screen.includes('● Draft the plan') && screen.includes('◐ Build it') && screen.includes('○ Review it'))
    check('full: owner, blocked and scope-warning marks',
      f.lines.some(line => line.includes('Build it') && line.includes('@builder') && line.includes('⚠1'))
      && f.lines.some(line => line.includes('Review it') && line.includes('blocked')))

    // Focus order: builder, reviewer, planner (roster-only), tester, workflow.
    f.stdin.write('\r')
    check('keys: Enter on a member opens its subagent detail', await settled(() => selected.join() === 'mate-run'), selected.join())
    const press = async (keys: string): Promise<void> => {
      f.stdin.write(keys)
      await termTest.sleep(30) // 固定窗:pacing 焦点移动重渲染
    }
    await press('\u001B[B')
    await press('\u001B[B')
    await press('\r')
    // 固定窗:探针 a roster-only member must not become a detail target
    await termTest.sleep(150)
    check('keys: Enter on a roster-only member does nothing', selected.join() === 'mate-run', selected.join())
    await press('\u001B[B')
    await press('\u001B[B')
    f.stdin.write('\r')
    check('keys: focus reaches the other subagents', await settled(() => selected.join() === 'mate-run,workflow-1'), selected.join())
    f.unmount()
  }

  {
    // Focus follows the row, not its index: the team view reorders the rows,
    // and a shrinking roster clamps the focus back onto a row.
    const selected: string[] = []
    const props = { onSelect: (id: string) => selected.push(id), onClose: () => {} }
    const f = await mount(100, 40, props, 'workflow step')
    for (let i = 0; i < 3; i++) {
      f.stdin.write('\u001B[B')
      await termTest.sleep(30) // 固定窗:pacing 焦点移动重渲染
    }
    f.rerender({ ...props, team })
    await settled(() => f.read().some(line => line.includes('Tasks')))
    f.stdin.write('\r')
    check('keys: focus stays on its agent when the team view reorders the rows', await settled(() => selected.join() === 'workflow-1'), selected.join())
    f.rerender({ ...props, subagents: [row('solo', { description: 'solo row' })] })
    await settled(() => f.read().some(line => line.includes('solo row')))
    f.stdin.write('\r')
    check('keys: a shrinking roster clamps the focus onto a row', await settled(() => selected.join() === 'workflow-1,solo'), selected.join())
    f.unmount()
  }

  {
    // The same team seen from the reviewer's own session.
    const f = await mount(100, 40, { team, sessionId: 'mate-done', subagents: [row('child-1', { description: 'own child' })] }, 'Tasks')
    const screen = f.lines.join('\n')
    check('teammate view: the Lead line names no session', screen.includes('◆ lead') && !screen.includes('lead · this session'))
    check('teammate view: active count in the header', /2 active/.test(screen), f.lines.slice(0, 4).join('|'))
    check('teammate view: this session is marked on its own row', f.lines.some(line => line.includes('reviewer · this session') && line.includes('active')))
    check('teammate view: a sibling reads active, not idle', f.lines.some(line => line.includes('builder') && line.includes('active')))
    check('teammate view: its own child is another subagent', screen.includes('Other subagents') && screen.includes('Subagent: own child'))
    f.unmount()
  }

  {
    const f = await mount(80, 20, { team: { ...team, failure: 'bad record at seq 9' } }, 'rejected')
    check('failure: banner shown', f.lines.some(line => line.includes('⚠ Team record rejected: bad record at seq 9')))
    f.unmount()
  }

  {
    const wide: TeamView = {
      ...team,
      members: team.members.map(m => (m.id === 'mate-done' ? { ...m, name: '代码审查员' } : m)),
      tasks: team.tasks.map(item => ({ ...item, subject: `${item.subject} with a subject long enough to truncate` })),
    }
    const cols = 34
    const f = await mount(cols, 40, { team: wide, variant: 'panel', focused: false }, 'Tasks')
    check('panel narrow: no row overflows', f.lines.every(line => width.stringWidth(line) <= cols), f.lines.find(line => width.stringWidth(line) > cols) ?? '')
    check('panel narrow: wide-character name shown', f.lines.some(line => line.includes('代码审查员') && line.includes('idle')))
    check('panel narrow: owner dropped, marks kept',
      !f.lines.join('\n').includes('@builder') && f.lines.some(line => line.includes('⚠1')), f.lines.join('|'))
    check('panel narrow: long subjects truncate', f.lines.some(line => line.includes('Build it') && line.includes('…')))
    f.unmount()
  }

  {
    const f = await mount(100, 30, {}, 'Subagent Dashboard')
    const screen = f.lines.join('\n')
    check('no team: subagent title and cards', screen.includes('Subagent: desc of mate-run') && !screen.includes('Agent Team'))
    check('no team: no team sections', !screen.includes('Members') && !screen.includes('Tasks ·'))
    f.unmount()
  }

  {
    // #1791: a switchable product route failing most of its runs earns one
    // line above the list — the case a single red card cannot express.
    const failing: SubagentState[] = [
      row('cc-1', { provider: 'claude-code', status: 'failed', error: 'error' }),
      row('cc-2', { provider: 'claude-code', status: 'failed', error: 'error' }),
    ]
    const f = await mount(100, 40, { subagents: failing }, 'claude-code')
    check('channel banner: a failing product route is surfaced', bannered(f.lines.join('\n'), 'claude-code'), f.lines.slice(0, 7).join('|'))
    f.unmount()
  }

  {
    // One failure is ordinary, and none of these buckets is a switchable route.
    const quiet: SubagentState[] = [
      row('cc-1', { provider: 'claude-code', status: 'failed', error: 'error' }),
      row('sub-1', { provider: 'subagent', status: 'failed', error: 'error' }),
      row('sub-2', { provider: 'subagent', status: 'failed', error: 'error' }),
      row('wf-1', { provider: 'workflow', status: 'failed', error: 'error' }),
      row('wf-2', { provider: 'workflow', status: 'failed', error: 'error' }),
      row('ex-1', { provider: 'Explore', status: 'failed', error: 'error' }),
      row('ex-2', { provider: 'Explore', status: 'failed', error: 'error' }),
    ]
    const f = await mount(100, 40, { subagents: quiet }, 'failed')
    const quietScreen = f.lines.join('\n')
    check('channel banner: one failure stays quiet', !bannered(quietScreen, 'claude-code'))
    check('channel banner: non-switchable buckets stay quiet',
      !bannered(quietScreen, 'subagent') && !bannered(quietScreen, 'workflow') && !bannered(quietScreen, 'Explore'))
    f.unmount()
  }

  {
    // Panel + narrow: the banner must not push the hint or the last card out.
    const cols = 34
    const many: SubagentState[] = [
      row('cc-1', { provider: 'claude-code', status: 'failed', error: 'error', description: '失败的执行卡一号' }),
      row('cc-2', { provider: 'claude-code', status: 'failed', error: 'error', description: '失败的执行卡二号' }),
      row('ok-1', { provider: 'spawn', status: 'completed', description: '成功卡' }),
    ]
    const f = await mount(cols, 30, { subagents: many, variant: 'panel', focused: false }, 'claude-code')
    // Panel mode renders no footer hint (the host draws it), so the invariant
    // here is that the last card survives the banner.
    check('channel banner: panel narrow keeps the last card', f.lines.some(line => line.includes('成功卡')), f.lines.join('|'))
    // The viewport wraps at `cols`, so every physical line fits by
    // construction and a width check could never fail. The real risk is a
    // truncated logical line, which drops the banner's tail instead of
    // wrapping it — assert the whole sentence survives instead.
    const logical = f.lines.join(' ').replace(/\s+/g, ' ')
    check('channel banner: panel narrow keeps the banner sentence intact',
      logical.includes('channel claude-code: 2 of 2 settled runs failed')
      && logical.includes('try another delegation provider'), logical)
    f.unmount()
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}
if (failed > 0) {
  console.log(`${failed} FAILED`)
  process.exit(1)
}
console.log('ALL PASS')
process.exit(0)
