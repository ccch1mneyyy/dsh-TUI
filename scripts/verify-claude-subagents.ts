/**
 * Claude subagents end to end, over a fake SDK (no CLI, no network):
 *
 *  - live foreground subagent (the recorded `subagent` fixture through a real
 *    Claude session and the channel core): the `Agent` call pre-creates the
 *    card, `task_started` names it (task id, kind, depth), its own Read and
 *    text arrive on its lane (card tools / waterfall, never the main
 *    transcript), `task_progress` updates its tokens, `task_notification`
 *    settles it with the report and usage; `/agents` lists it; the dashboard
 *    and detail scene render it;
 *  - stop: `subagentControl.interrupt` → `q.stopTask(taskId)` (by the task id
 *    or the delegating call once named; nothing to stop before that), the
 *    CLI's `stopped` notification settles it as cancelled;
 *  - background subagent: runs past its turn, its lane keeps streaming,
 *    `background_tasks_changed` without it → inferred `unknown`, a later
 *    notification still wins; without one it stays `unknown`; a foreground
 *    subagent moved to the background, nested spawn depth;
 *  - replay after resume: the subagent's own transcript replays on its lane
 *    after its call (cards with tools and output, `replay: true`), terminal
 *    states from the hand-back result / `<task-notification>`, `unknown`
 *    when the chain recorded neither.
 *
 * Run: node --import tsx/esm scripts/verify-claude-subagents.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-claude-subagents-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.FORCE_COLOR = '3'

const [
  { PassThrough, Writable },
  React,
  { Terminal },
  { render, AlternateScreen },
  { Chat },
  { QuestionStore },
  { openClaudeSession },
  { replayClaudeTranscript },
  { memoryClaudePrefs },
  { createChannel },
  { setLang, t },
  { settled, sleep, findText },
  fakes,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/channel/questions.js'),
  import('../src/backends/claude/session.js'),
  import('../src/backends/claude/replay.js'),
  import('../src/backends/claude/prefs.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
  import('./lib/claude-fake-sdk.js'),
])
type ChannelState = ReturnType<typeof createChannel>
type FakeQuery = ReturnType<typeof fakes.fakeClaudeSdk>['queries'][number]

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const { fakeClaudeSdk, claudeDeps, tick } = fakes
const FIXTURES = join(import.meta.dirname, 'fixtures', 'claude')
const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never
type Rec = Record<string, unknown>
type Line = { dir: string; msg?: Rec; placement?: 'turn' | 'steer' | 'followup' | 'now' }
const lines = (name: string): Line[] => readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Line)

/** A Claude session over a fake SDK, bound to a channel core. */
async function openChannel(options: { resume?: ReturnType<typeof replayClaudeTranscript>; store?: unknown } = {}): Promise<{ channel: ChannelState; query: FakeQuery; session: Awaited<ReturnType<typeof openClaudeSession>> }> {
  const fake = fakeClaudeSdk(() => ({ capabilities: ['msg_lifecycle_v1'] }), {
    stopTask: () => undefined,
    getContextUsage: () => ({ totalTokens: 1000, maxTokens: 200_000, categories: [], memoryFiles: [], mcpTools: [] }),
  })
  const session = await openClaudeSession(claudeDeps(fake.sdk, { prefs: memoryClaudePrefs(), ...(options.resume === undefined ? {} : { resume: options.resume }), ...(options.store === undefined ? {} : { store: options.store as never }) }))
  const channel = createChannel(ctx, session, {
    model: 'Claude Agent', provider: 'claude', cwd: '/fixture/project', activity: false, backendLabel: 'Claude Agent',
    ...(options.resume === undefined ? {} : { initialHistory: options.resume.events }),
  })
  return { channel, query: fake.queries[0]!, session }
}

const subagentRows = (channel: ChannelState) => channel.rows.filter(row => row.kind === 'subagent')

// ── live foreground subagent (recorded) ──────────────────────────────────
{
  const { channel, query, session } = await openChannel()
  try {
    check('the session offers /agents and /jobs', channel.backendCapabilities.subagents && channel.backendCapabilities.tasks && channel.backendCapabilities.commands.includes('agents') && channel.backendCapabilities.commands.includes('jobs'), channel.backendCapabilities.commands)
    let callChecked = false
    for (const line of lines('subagent')) {
      if (line.dir === 'in' && line.msg !== undefined) {
        const content = (line.msg.message as Rec).content
        await session.submit({ text: String(content), clientMessageId: String(line.msg.uuid) }, line.placement ?? 'turn')
        continue
      }
      if (line.dir !== 'out' || line.msg === undefined) continue
      const msg = line.msg
      query.emit(msg)
      await tick()
      const content = ((msg.message as Rec | undefined)?.content ?? []) as Rec[]
      if (!callChecked && msg.type === 'assistant' && Array.isArray(content) && content.some(block => block.name === 'Agent')) {
        callChecked = true
        const card = await settled(() => subagentRows(channel).length === 1)
        const sub = subagentRows(channel)[0]?.subagent
        check('the Agent call pre-creates the card at once (keyed by the call, running)', card && sub?.agentId === 'toolu_fixture_001' && sub.status === 'running' && sub.description === 'Read README.md first line' && sub.provider === 'general-purpose', sub)
        check('… and renders no tool card for the Agent call itself', !channel.rows.some(row => row.kind === 'tool' && row.tool?.name === 'Agent'))
      }
      if (msg.type === 'system' && msg.subtype === 'task_started') {
        await settled(() => subagentRows(channel)[0]?.subagent?.agentId === 'aedea1ecd3a81bb44')
        const sub = channel.subagents.find(item => item.agentId === 'aedea1ecd3a81bb44')
        check('task_started names it: the same card re-keyed to the task id, depth 1, foreground', subagentRows(channel).length === 1 && sub?.depth === 1 && sub.background === false && sub.status === 'running', sub)
      }
      if (msg.type === 'system' && msg.subtype === 'task_progress') {
        check('task_progress updates its tokens', await settled(() => (channel.subagents[0]?.tokens?.total ?? 0) === 13082), channel.subagents[0]?.tokens)
      }
      if (msg.type === 'assistant' && msg.parent_tool_use_id === 'toolu_fixture_001' && Array.isArray(content) && content.some(block => block.type === 'tool_use')) {
        check('its own Read is a running tool of the card (lane), not a main-transcript card', await settled(() => channel.subagents[0]?.toolCalls.some(tool => tool.name === 'Read' && tool.status === 'running') === true)
          && !channel.rows.some(row => row.kind === 'tool' && row.tool?.name === 'Read')
          && subagentRows(channel)[0]?.subagent?.toolCalls[0]?.argsPreview === 'README.md', channel.subagents[0]?.toolCalls)
      }
    }
    await settled(() => channel.subagents[0]?.status === 'completed')
    const sub = channel.subagents[0]!
    check('task_notification settles it: completed, report summary, usage total', sub.status === 'completed' && (sub.summary ?? '').includes('Fixture project') && sub.tokens?.total === 14536, sub)
    check('its text reached its waterfall, never the main transcript', sub.output.some(line => line.includes('Fixture project')) && !channel.rows.some(row => row.kind === 'assistant' && row.text.includes('The first line of the README.md file is')), sub.output)
    check('its tool settled with a preview of the result', sub.toolCalls.length === 1 && sub.toolCalls[0]!.status === 'completed' && (sub.toolCalls[0]!.resultPreview ?? '').includes('Fixture project'), sub.toolCalls)
    check('the main reply follows the card', channel.rows.findIndex(row => row.kind === 'subagent') < channel.rows.findLastIndex(row => row.kind === 'assistant'))
    const listed = await channel.listSubagents()
    check('/agents lists it (description, kind, status, id)', listed.length === 1 && listed[0]!.includes('Read README.md first line') && listed[0]!.includes('general-purpose') && listed[0]!.includes(t('subagent-status-completed')) && listed[0]!.includes('aedea1ec'), listed)

    // ── the dashboard and the detail scene render it ──────────────────
    const COLS = 110
    const ROWS = 32
    const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 400, allowProposedApi: true })
    class FakeStdout extends Writable {
      columns = COLS
      rows = ROWS
      isTTY = true
      _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) { terminal.write(String(chunk), callback) }
    }
    class FakeStdin extends PassThrough {
      isTTY = true
      setRawMode() { return this }
      ref() { return this }
      unref() { return this }
    }
    const screen = (): string => {
      const buffer = terminal.buffer.active
      return Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '').join('\n')
    }
    const stdin = new FakeStdin()
    const stdout = new FakeStdout()
    const app = await render(React.createElement(Chat, { channel, questionStore: new QuestionStore(), onExit: () => undefined, fullscreen: false, trajectorySeen: true }), {
      stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      check('render: the transcript shows the settled subagent card (kind, tools, status)', await settled(() => screen().includes(`${t('subagent-card-prefix')}Read README.md first line`) && /general-purpose.*1 tools.*completed/u.test(screen())), screen())
      // 固定窗:pacing the prompt attaches its key handler after the first frame.
      await sleep(200)
      stdin.write('\x01') // Ctrl+A: the subagent dashboard
      check('render: the dashboard lists it', await settled(() => screen().includes(t('subagent-dashboard-title').trim()) && screen().includes('Read README.md first line')), screen())
      stdin.write('\r')
      check('render: the detail scene shows its tool and conclusion', await settled(() => screen().includes('Read') && screen().includes('Fixture project')), screen())
    } finally {
      app.unmount()
      terminal.dispose()
    }
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
}

// ── stop via stopTask ──────────────────────────────────────────────────
{
  const { channel, query, session } = await openChannel()
  try {
    query.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', model: 'claude-haiku', usage: {} } } })
    query.emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'call-a', name: 'Agent', input: { description: 'dig', subagent_type: 'Explore', prompt: 'dig' } }] } })
    await settled(() => subagentRows(channel).length === 1)
    check('nothing to stop before task_started names the subagent (request refused, said so)', channel.subagentControl.interrupt('call-a') && await settled(() => channel.notifications.some(item => item.text === t('subagent-interrupt-failed', { id: 'call-a' }))) && !query.calls.some(call => call.method === 'stopTask'), query.calls)
    query.emit({ type: 'system', subtype: 'task_started', task_id: 'task-a', tool_use_id: 'call-a', description: 'dig', subagent_type: 'Explore', is_backgrounded: false, spawn_depth: 1, task_type: 'local_agent' })
    await settled(() => channel.subagents[0]?.agentId === 'task-a')
    check('interrupt → stopTask(task id)', channel.subagentControl.interrupt('task-a') && await settled(() => query.calls.some(call => call.method === 'stopTask' && call.args[0] === 'task-a')), query.calls)
    check('… the card stays running until the CLI reports the stop', channel.subagents[0]?.status === 'running')
    query.emit({ type: 'system', subtype: 'task_notification', task_id: 'task-a', tool_use_id: 'call-a', status: 'stopped', output_file: '', summary: 'Stopped', usage: { total_tokens: 10, tool_uses: 0, duration_ms: 5 } })
    check('the stopped notification settles it as cancelled', await settled(() => channel.subagents[0]?.status === 'cancelled' && subagentRows(channel)[0]?.subagent?.status === 'cancelled'))
    check('a settled subagent cannot be interrupted again', !channel.subagentControl.interrupt('task-a'))

    query.emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'call-b', name: 'Task', input: { description: 'second', subagent_type: 'general-purpose', prompt: 'x' } }] } })
    query.emit({ type: 'system', subtype: 'task_started', task_id: 'task-b', tool_use_id: 'call-b', description: 'second', is_backgrounded: false, spawn_depth: 2, task_type: 'local_agent' })
    await settled(() => channel.subagents.some(item => item.agentId === 'task-b'))
    const before = query.calls.filter(call => call.method === 'stopTask').length
    check('the legacy Task tool is a subagent too; its depth is kept', channel.subagents.find(item => item.agentId === 'task-b')?.depth === 2)
    check('the delegating call id maps to the task once named', channel.subagentControl.interrupt('call-b') && await settled(() => query.calls.filter(call => call.method === 'stopTask').length === before + 1 && query.calls.at(-1)?.args[0] === 'task-b'), query.calls)
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
}

// ── background subagents and the level signal ─────────────────────────
{
  const { channel, query, session } = await openChannel()
  try {
    await session.submit({ text: 'go', clientMessageId: 'u1' }, 'turn')
    query.emit({ type: 'command_lifecycle', command_uuid: 'u1', state: 'started' })
    query.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', model: 'claude-haiku', usage: {} } } })
    query.emit({ type: 'assistant', message: { id: 'm1', content: [
      { type: 'tool_use', id: 'call-bg', name: 'Agent', input: { description: 'background dig', subagent_type: 'Explore', prompt: 'dig', run_in_background: true } },
      { type: 'tool_use', id: 'call-lost', name: 'Agent', input: { description: 'lost one', subagent_type: 'Explore', prompt: 'x', run_in_background: true } },
    ] } })
    query.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-1', task_type: 'local_agent', description: 'background dig' }, { task_id: 'bg-2', task_type: 'local_agent', description: 'lost one' }] })
    query.emit({ type: 'system', subtype: 'task_started', task_id: 'bg-1', tool_use_id: 'call-bg', description: 'background dig', subagent_type: 'Explore', is_backgrounded: true, spawn_depth: 1, task_type: 'local_agent' })
    query.emit({ type: 'system', subtype: 'task_started', task_id: 'bg-2', tool_use_id: 'call-lost', description: 'lost one', subagent_type: 'Explore', is_backgrounded: true, spawn_depth: 1, task_type: 'local_agent' })
    query.emit({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call-bg', content: 'Async agent launched successfully.' },
      { type: 'tool_result', tool_use_id: 'call-lost', content: 'Async agent launched successfully.' },
    ] } })
    query.emit({ type: 'stream_event', event: { type: 'message_stop' } })
    query.emit({ type: 'result', subtype: 'success', is_error: false, result: 'launched', total_cost_usd: 0.001, modelUsage: {} })
    await settled(() => channel.rows.some(row => row.kind === 'subagent') && !channel.working)
    check('two background cards run past their turn', await settled(() => !channel.working && channel.subagents.length === 2) && channel.subagents.every(item => item.status === 'running' && item.background === true) && subagentRows(channel).length === 2, channel.subagents)
    query.emit({ type: 'assistant', parent_tool_use_id: 'call-bg', message: { id: 'sub-m1', content: [{ type: 'text', text: 'still digging\nfound it' }] } })
    check('its lane keeps streaming into the card after the turn', await settled(() => channel.subagents.find(item => item.agentId === 'bg-1')?.output.includes('found it') === true))
    // The level precedes its bookend: both vanish from the set.
    query.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
    check('absent from the level with no end of its own → unknown (inferred)', await settled(() => channel.subagents.every(item => item.status === 'unknown')), channel.subagents.map(item => item.status))
    query.emit({ type: 'system', subtype: 'task_notification', task_id: 'bg-1', tool_use_id: 'call-bg', status: 'completed', output_file: '', summary: 'Found the thing', usage: { total_tokens: 99, tool_uses: 2, duration_ms: 50 } })
    check('… a later real end still wins', await settled(() => channel.subagents.find(item => item.agentId === 'bg-1')?.status === 'completed') && channel.subagents.find(item => item.agentId === 'bg-1')?.summary === 'Found the thing')
    check('… the other stays unknown (no end ever came), its card settled', channel.subagents.find(item => item.agentId === 'bg-2')?.status === 'unknown' && subagentRows(channel).find(row => row.subagent?.agentId === 'bg-2')?.subagent?.status === 'unknown')
    check('the notification opened the CLI\'s notification turn, not a user turn', await settled(() => { query.emit({ type: 'system', subtype: 'status', status: 'requesting' }); return channel.working }) && channel.rows.some(row => row.kind === 'notice' && row.text === t('claude-notification-turn')))
    query.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.002, modelUsage: {} })
    // A foreground subagent moved to the background (Ctrl+B in the CLI).
    query.emit({ type: 'assistant', message: { id: 'm9', content: [{ type: 'tool_use', id: 'call-fg', name: 'Agent', input: { description: 'fg', prompt: 'x' } }] } })
    query.emit({ type: 'system', subtype: 'task_started', task_id: 'fg-1', tool_use_id: 'call-fg', description: 'fg', is_backgrounded: false, task_type: 'local_agent' })
    query.emit({ type: 'system', subtype: 'task_updated', task_id: 'fg-1', patch: { is_backgrounded: true } })
    check('a foreground subagent moved to the background is marked so', await settled(() => channel.subagents.find(item => item.agentId === 'fg-1')?.background === true))
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
}


// ── a finished subagent resumes under the same id: a new run ───────────
{
  const { channel, query, session } = await openChannel()
  try {
    await session.submit({ text: 'dig twice', clientMessageId: 'u1' }, 'turn')
    query.emit({ type: 'command_lifecycle', command_uuid: 'u1', state: 'started' })
    query.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', model: 'claude-haiku', usage: {} } } })
    query.emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'call-r', name: 'Agent', input: { description: 'resumable dig', subagent_type: 'Explore', prompt: 'x', run_in_background: true } }] } })
    query.emit({ type: 'system', subtype: 'task_started', task_id: 'rs-1', tool_use_id: 'call-r', description: 'resumable dig', is_backgrounded: true, spawn_depth: 1, task_type: 'local_agent' })
    query.emit({ type: 'assistant', parent_tool_use_id: 'call-r', message: { id: 'sub-1', content: [{ type: 'tool_use', id: 'lane-1', name: 'Read', input: { file_path: '/fixture/project/README.md' } }] } })
    query.emit({ type: 'user', parent_tool_use_id: 'call-r', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'lane-1', content: 'first line' }] } })
    query.emit({ type: 'assistant', parent_tool_use_id: 'call-r', message: { id: 'sub-2', content: [{ type: 'text', text: 'run one finding' }] } })
    // The backend's own reports: a repeated progress does not double-count;
    // a lone last_tool_name updates only the last tool; the notification's
    // usage is the final word.
    query.emit({ type: 'system', subtype: 'task_progress', task_id: 'rs-1', summary: 'reading', last_tool_name: 'Read', usage: { total_tokens: 90, tool_uses: 1, duration_ms: 800 } })
    query.emit({ type: 'system', subtype: 'task_progress', task_id: 'rs-1', summary: 'reading', last_tool_name: 'Read', usage: { total_tokens: 90, tool_uses: 1, duration_ms: 800 } })
    query.emit({ type: 'system', subtype: 'task_progress', task_id: 'rs-1', last_tool_name: 'Grep' })
    query.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-r', content: 'Async agent launched successfully.' }] } })
    query.emit({ type: 'result', subtype: 'success', is_error: false, result: 'launched', total_cost_usd: 0.001, modelUsage: {} })
    query.emit({ type: 'system', subtype: 'task_notification', task_id: 'rs-1', status: 'completed', summary: 'first run done', usage: { total_tokens: 100, tool_uses: 1, duration_ms: 900 } })
    check('first run: settles completed with its report', await settled(() => { const s = channel.subagents.find(item => item.agentId === 'rs-1'); return s?.status === 'completed' && s.summary === 'first run done' }))
    const first = channel.subagents.find(item => item.agentId === 'rs-1')!
    check('first run: the backend-reported tool count / duration / last tool are kept (reports overwrite, never add)', first.reportedToolUses === 1 && first.reportedDurationMs === 900 && first.lastTool === 'Grep' && first.tokens?.total === 100, first)

    // SendMessage wakes the finished agent: the same task id starts a new run.
    query.emit({ type: 'system', subtype: 'task_started', task_id: 'rs-1', tool_use_id: 'call-r', description: 'resumable dig', is_backgrounded: true, spawn_depth: 1, task_type: 'local_agent' })
    check('resume: the same id runs again (a new epoch, not a dead card)', await settled(() => channel.subagents.some(item => item.agentId === 'rs-1' && item.status === 'running')), channel.subagents.map(item => item.status))
    const resumed = channel.subagents.find(item => item.agentId === 'rs-1')!
    check('resume: the first run\'s summary and terminal fields go', resumed !== undefined && resumed.summary === undefined && resumed.completedAt === undefined && resumed.endedAt === undefined && resumed.stopReason === undefined && resumed.error === undefined, resumed)
    check('resume: the first run\'s per-run reports go with them (tokens stay cumulative)', resumed.reportedToolUses === undefined && resumed.reportedDurationMs === undefined && resumed.lastTool === undefined && resumed.tokens?.total === 100, resumed)
    check('resume: its transcript, tool records and cumulative tokens stay (not blindly cleared)', resumed !== undefined && resumed.toolCalls.length === 1 && (resumed.toolCalls[0]?.resultPreview ?? '').includes('first line') && resumed.tokens?.total === 100 && resumed.output.includes('run one finding'), resumed && { tools: resumed.toolCalls.length, tokens: resumed.tokens, output: resumed.output })
    check('resume: the run clock starts fresh', (resumed?.startedAt ?? 0) > (first?.startedAt ?? Infinity), [first?.startedAt, resumed?.startedAt])

    // A duplicate start while it runs (moved to the background) is the same
    // run: the clock is not reset.
    const clock = resumed?.startedAt
    query.emit({ type: 'system', subtype: 'task_updated', task_id: 'rs-1', patch: { is_backgrounded: true } })
    check('resume: backgrounding the running agent keeps its run clock (same epoch)', await settled(() => { const s = channel.subagents.find(item => item.agentId === 'rs-1'); return s?.background === true && s?.startedAt === clock }))

    // The second run fails: the new outcome must win over the first success.
    query.emit({ type: 'system', subtype: 'task_notification', task_id: 'rs-1', status: 'failed', summary: 'second run broke', usage: { total_tokens: 160, tool_uses: 2, duration_ms: 400 } })
    check('resume: the second run\'s failure wins (not shadowed by the first run\'s success)', await settled(() => { const s = channel.subagents.find(item => item.agentId === 'rs-1'); return s?.status === 'failed' && s.summary === 'second run broke' }))
    const second = channel.subagents.find(item => item.agentId === 'rs-1')!
    check('resume: tokens stay cumulative across runs', second?.tokens?.total === 160, second?.tokens)
    check('resume: the second run\'s reports replace the first\'s', second?.reportedToolUses === 2 && second?.reportedDurationMs === 400, second)
    // A re-delivered end of the settled run does not overwrite the outcome.
    query.emit({ type: 'system', subtype: 'task_notification', task_id: 'rs-1', status: 'completed', summary: 'stale duplicate', usage: { total_tokens: 160, tool_uses: 2, duration_ms: 400 } })
    check('resume: a re-delivered end of the settled run does not overwrite it', await settled(() => { const s = channel.subagents.find(item => item.agentId === 'rs-1'); return s?.status === 'failed' && s.summary === 'second run broke' }))
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
}


// ── reported tool stats render when the lane frames are gone ───────────
{
  const [{ SubagentCard }, { SubagentDetailScene }] = await Promise.all([
    import('../src/components/SubagentCard.js'),
    import('../src/components/SubagentDetailScene.js'),
  ])
  const NOW = Date.now()
  const reported = {
    agentId: 'probe-agent-0001', description: 'Explore deep', status: 'completed' as const,
    startedAt: NOW - 1500, completedAt: NOW, output: [], outputEvents: [], toolCalls: [],
    tokens: { total: 10 }, reportedToolUses: 3, reportedDurationMs: 1500, lastTool: 'Read',
  }
  const COLS = 96
  const ROWS = 24
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) { terminal.write(String(chunk), callback) }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const screen = (): string => {
    const buffer = terminal.buffer.active
    return Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '').join('\n')
  }
  const stdin = new FakeStdin()
  const stdout = new FakeStdout()
  const app = await render(React.createElement(SubagentCard, { subagent: reported as never }), {
    stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false,
  })
  try {
    check('render: the card shows the reported tool count and duration (no fabricated records)', await settled(() => screen().includes('3 tools') && screen().includes('10 tok')), screen())
  } finally {
    app.unmount()
  }
  const terminal2 = new Terminal({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true })
  class FakeStdout2 extends Writable {
    columns = COLS
    rows = ROWS
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) { terminal2.write(String(chunk), callback) }
  }
  const stdin2 = new FakeStdin()
  const stdout2 = new FakeStdout2()
  const screen2 = (): string => {
    const buffer = terminal2.buffer.active
    return Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '').join('\n')
  }
  const app2 = await render(React.createElement(SubagentDetailScene, { subagent: reported as never, onBack: () => undefined }), {
    stdout: stdout2 as never, stdin: stdin2 as never, stderr: stdout2 as never, exitOnCtrlC: false, patchConsole: false,
  })
  try {
    // 固定窗:pacing the scene attaches its key handler after the first frame.
    await sleep(200)
    check('render: the detail summary prefers the reported stats and names the last tool', await settled(() => {
      const text = screen2()
      return text.includes('3') && text.includes('1.5s') && text.includes('Read')
    }), screen2())
    // 固定窗:pacing one key per frame — a same-tick double arrow is parsed
    // as one chunk by the input layer.
    stdin2.write('\x1b[C') // → output
    // 固定窗:pacing 第二枚方向键与首枚分帧送达。
    await sleep(200)
    stdin2.write('\x1b[C') // → tools
    // 固定窗:pacing 翻页渲染落帧后再断言。
    await sleep(200)
    check('render: the tools page marks how many records were kept, fabricating none', await settled(() => screen2().includes(t('subagent-tools-kept', { kept: 0, reported: 3 }))), screen2())
  } finally {
    app2.unmount()
    terminal.dispose()
    terminal2.dispose()
  }
}

// ── the Agent-Transcript page: capability seam + scene rendering ────────
{
  const [{ SubagentDetailScene }] = await Promise.all([import('../src/components/SubagentDetailScene.js')])
  const NOW = Date.now()
  const at = (n: number): string => `2026-10-02T13:00:0${n}.000Z`
  // The child's on-disk transcript (parent_agent_id null = a depth-1 child):
  // real thinking, one tool round-trip, a signature/count-only thinking
  // entry, the answer text, and the initial prompt the translator hides.
  const childMessages: Rec[] = [
    { type: 'user', uuid: 'c-u0', parent_tool_use_id: 'call-tx', parent_agent_id: null, message: { role: 'user', content: 'explore the fixture secret prompt' }, timestamp: at(0) },
    { type: 'assistant', uuid: 'c-a1', parent_tool_use_id: 'call-tx', parent_agent_id: null, message: { id: 'msg_t1', content: [{ type: 'thinking', thinking: 'planning the read', signature: 'x' }], usage: {} }, timestamp: at(1) },
    { type: 'assistant', uuid: 'c-a2', parent_tool_use_id: 'call-tx', parent_agent_id: null, message: { id: 'msg_t1', content: [{ type: 'tool_use', id: 'call-read-1', name: 'Read', input: { file_path: '/fixture/project/README.md' } }] }, timestamp: at(2) },
    { type: 'user', uuid: 'c-u1', parent_tool_use_id: 'call-tx', parent_agent_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-read-1', content: 'fixture body' }] }, timestamp: at(3) },
    { type: 'assistant', uuid: 'c-a3', parent_tool_use_id: 'call-tx', parent_agent_id: null, message: { id: 'msg_t2', content: [{ type: 'thinking', thinking: '', signature: 'REDACTED' }], usage: { output_tokens_details: { thinking_tokens: 4321 } } }, timestamp: at(4) },
    { type: 'assistant', uuid: 'c-a4', parent_tool_use_id: 'call-tx', parent_agent_id: null, message: { id: 'msg_t3', content: [{ type: 'text', text: 'The fixture answer.' }], usage: {} }, timestamp: at(5) },
  ]
  const chain: Rec[] = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'delegate transcript' }, timestamp: at(0) },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'tool_use', id: 'call-tx', name: 'Agent', input: { description: 'transcript probe', prompt: 'x' } }] }, timestamp: at(1) },
    { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-tx', content: 'The report follows:\n  done well' }] }, timestamp: at(6) },
  ]
  const store = {
    getSessionMessages: () => Promise.resolve([]),
    forkSession: () => Promise.reject(new Error('unused')) as never,
    getSubagentMessages: (_sid: string, agentId: string, _options?: unknown) => Promise.resolve(agentId === 'agent-tx' ? childMessages : []) as never,
  }
  const replay = replayClaudeTranscript(chain, { cwd: '/fixture/project', subagents: new Map([['call-tx', { agentId: 'agent-tx', messages: childMessages }]]) })
  const { channel, session } = await openChannel({ resume: replay, store })
  try {
    check('transcript: the channel exposes the subagent transcript capability', typeof channel.subagentControl.history === 'function')
    const page = await channel.subagentControl.history?.('agent-tx')
    const kinds = (page?.events ?? []).map(event => event.type).join()
    check('transcript: the page replays the child lane (assistant blocks + tool call/result), never the initial prompt', page !== null && kinds.includes('assistant.message') && kinds.includes('tool.call') && kinds.includes('tool.result') && !JSON.stringify(page.events).includes('secret prompt'), kinds)
    check('transcript: a signature/count-only thinking entry carries the honest unavailable marker', JSON.stringify(page?.events).includes('reasoning-tokens') && JSON.stringify(page?.events).includes('4321'))
    check('transcript: parent_agent_id rides the page (null = depth-1)', page?.parentAgentId === null && page?.hasOlder === false && page?.skippedFromStart === 0)

    // The scene: the page renders through the shared leaves, deduped
    // against the live tail, capability-gated.
    const COLS = 110
    const ROWS = 30
    const mk = (): { terminal: Terminal; stdin: InstanceType<typeof PassThrough>; stdout: never; screen(): string } => {
      const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 400, allowProposedApi: true })
      class Out extends Writable {
        columns = COLS; rows = ROWS; isTTY = true
        _write(chunk: unknown, _enc: BufferEncoding, cb: () => void) { terminal.write(String(chunk), cb) }
      }
      class In extends PassThrough { isTTY = true; setRawMode() { return this } ref() { return this } unref() { return this } }
      const stdin = new In()
      const screen = (): string => {
        const buffer = terminal.buffer.active
        return Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '').join('\n')
      }
      return { terminal, stdin, stdout: new Out() as never, screen }
    }
    const h = mk()
    const subagent = channel.subagents.find(item => item.agentId === 'agent-tx')!
    const app = await render(React.createElement(SubagentDetailScene, { subagent: subagent as never, onBack: () => undefined, loadTranscript: channel.subagentControl.history }), {
      stdout: h.stdout, stdin: h.stdin as never, stderr: h.stdout, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      // 固定窗:pacing the scene attaches its key handler after the first frame.
      await sleep(200)
      check('transcript render: the Transcript tab appears when the capability exists', await settled(() => h.screen().includes('Transcript')), h.screen())
      h.stdin.write('\x1b[C') // → output
      // 固定窗:pacing 第二枚方向键与首枚分帧送达。
      await sleep(200)
      h.stdin.write('\x1b[C') // → transcript
      // 固定窗:pacing 翻页渲染与异步转录读取落帧后再断言。
      await sleep(300)
      await settled(() => h.screen().includes('history · read-only'))
      const body = h.screen()
      check('transcript render: the page lands on the history view with its honest range line', body.includes('history') && body.includes('read-only'), body)
      check('transcript render: the count-only thinking degrades to body-unavailable, not fabricated prose', body.includes('Thinking body unavailable') && body.includes('4321'), body)
      check('transcript render: the tool card renders (presented title + result)', body.includes('README.md') && body.includes('fixture body'), body)
      check('transcript render: the answer text renders as markdown', body.includes('The fixture answer.'), body)
      check('transcript render: the hidden initial prompt stays hidden', !body.includes('secret prompt'), body)
    } finally {
      app.unmount()
      h.terminal.dispose()
    }

    // Live dedup: a running child's settled tail line the history already
    // shows must not double; the live section only keeps what is new.
    const h2 = mk()
    const liveState = {
      agentId: 'agent-live', description: 'live tail probe', status: 'running' as const, startedAt: NOW,
      output: ['settled line one', 'fresh streaming line'],
      outputEvents: [
        { kind: 'text', text: 'settled line one', at: NOW, settled: true },
        { kind: 'text', text: 'fresh streaming line', at: NOW, settled: false },
      ], toolCalls: [] as never[],
    }
    const livePage = {
      events: [{ type: 'assistant.message', seq: 1, anchor: 'msg_l1', attemptId: 'msg_l1', time: NOW, blocks: [{ type: 'text', text: 'settled line one' }], canonical: true, parentCallId: 'agent-live' }],
      parentAgentId: null, uuids: ['l-u1'], hasOlder: false, skippedFromStart: 0,
    }
    const app2 = await render(React.createElement(SubagentDetailScene, { subagent: liveState as never, onBack: () => undefined, loadTranscript: async () => livePage as never }), {
      stdout: h2.stdout, stdin: h2.stdin as never, stderr: h2.stdout, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      // 固定窗:pacing the key handler attaches after the first frame.
      await sleep(200)
      h2.stdin.write('\x1b[C')
      // 固定窗:pacing 分帧送达第二枚方向键。
      await sleep(200)
      h2.stdin.write('\x1b[C')
      // 固定窗:探针 分页页窗 翻页与异步读取落帧。
      await sleep(300)
      await settled(() => h2.screen().includes('settled line one'))
      const liveBody = h2.screen()
      check('transcript live: the settled tail the history shows is suppressed (no double row)', liveBody.split('settled line one').length - 1 === 1, liveBody)
      check('transcript live: the still-streaming line stays visible under the live marker', liveBody.includes('fresh streaming line') && liveBody.includes('── live ──'), liveBody)
    } finally {
      app2.unmount()
      h2.terminal.dispose()
    }

    // Degradation: a backend with no transcript source (DSH) renders no
    // Transcript tab and annotates the retained tail window instead.
    const h3 = mk()
    const capless = {
      agentId: 'agent-dsh', description: 'no transcript plane', status: 'completed' as const, startedAt: NOW - 1000, completedAt: NOW,
      output: [],
      outputEvents: Array.from({ length: 160 }, (_, i) => ({ kind: 'text', text: `retained line ${i}`, at: NOW, settled: true })),
      toolCalls: [] as never[],
    }
    const app3 = await render(React.createElement(SubagentDetailScene, { subagent: capless as never, onBack: () => undefined }), {
      stdout: h3.stdout, stdin: h3.stdin as never, stderr: h3.stdout, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      // 固定窗:pacing the key handler attaches after the first frame.
      await sleep(200)
      check('degradation: no transcript tab without a transcript source', !h3.screen().includes('Transcript'), h3.screen())
      h3.stdin.write('\x1b[C') // → output
      // 固定窗:pacing 翻页渲染落帧后再断言。
      await sleep(300)
      check('degradation: the capped tail states its retained range honestly', await settled(() => h3.screen().includes(t('subagent-transcript-retained', { count: 160 }))), h3.screen())
    } finally {
      app3.unmount()
      h3.terminal.dispose()
    }

    // Page-boundary split of one API message: the store splits a message
    // into per-block entries sharing the anchor, and a load-older window
    // boundary between two such entries must merge the compatible
    // text/thinking parts, never swallow the older part whole.
    const h4 = mk()
    const splitState = {
      agentId: 'agent-split', description: 'page boundary probe', status: 'completed' as const, startedAt: NOW - 2000, completedAt: NOW,
      output: [], outputEvents: [], toolCalls: [] as never[],
    }
    const splitMessage = (anchor: string, text: string) => ({ type: 'assistant.message', seq: 1, anchor, attemptId: anchor, time: NOW, blocks: [{ type: 'text', text }], canonical: true, parentCallId: 'agent-split' })
    const olderWindows = new Map([
      ['2', { events: [splitMessage('msg_split', 'seg middle')], parentAgentId: null, uuids: ['u-m'], hasOlder: true, skippedFromStart: 1 }],
      ['1', { events: [splitMessage('msg_split', 'seg head')], parentAgentId: null, uuids: ['u-h'], hasOlder: false, skippedFromStart: 0 }],
    ])
    const splitLoad = async (_agentId: string, window?: { count: number; skipFromStart: number }) => {
      if (window === undefined) return { events: [splitMessage('msg_split', 'seg tail')], parentAgentId: null, uuids: ['u-t'], hasOlder: true, skippedFromStart: 2 } as never
      return (olderWindows.get(String(window.skipFromStart)) ?? { events: [], parentAgentId: null, uuids: [], hasOlder: false, skippedFromStart: 0 }) as never
    }
    const app4 = await render(React.createElement(AlternateScreen, null, React.createElement(SubagentDetailScene, { subagent: splitState as never, onBack: () => undefined, loadTranscript: splitLoad })), {
      stdout: h4.stdout, stdin: h4.stdin as never, stderr: h4.stdout, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      // 固定窗:pacing the key handler attaches after the first frame.
      await sleep(200)
      h4.stdin.write('\x1b[C')
      // 固定窗:pacing 分帧送达第二枚方向键。
      await sleep(200)
      h4.stdin.write('\x1b[C')
      // 固定窗:探针 分页页窗 翻页与异步转录读取落帧。
      await sleep(300)
      await settled(() => h4.screen().includes('seg tail') && h4.screen().includes('Load 2 older'))
      const clickRow = async (label: string): Promise<void> => {
        const hit = findText(h4.terminal, label) as { col: number; row: number } | null
        if (hit === null) return
        const seq = (final: string): string => `\x1b[<0;${hit.col + 1};${hit.row + 1}${final}`
        h4.stdin.write(seq('M'))
        // 固定窗:pacing 鼠标 press→release 步间。
        await sleep(30)
        h4.stdin.write(seq('m'))
      }
      await clickRow('Load 2 older')
      await settled(() => h4.screen().includes('Load 1 older'))
      const twoParts = h4.screen()
      check('transcript paging: a same-anchor part from the older page survives (merged, not swallowed)', twoParts.includes('seg middle') && twoParts.includes('seg tail'), twoParts)
      check('transcript paging: … the older part precedes the newer one, exactly once each', twoParts.indexOf('seg middle') < twoParts.indexOf('seg tail') && twoParts.split('seg tail').length - 1 === 1 && twoParts.split('seg middle').length - 1 === 1, twoParts)
      // 固定窗:墙钟 第二击必须落在 500ms 多击窗之外——同格快二连会被
      // App 的双击分类器收走（词选择），load-older 的 onClick 不发。
      await sleep(600)
      await clickRow('Load 1 older')
      await settled(() => h4.screen().includes('seg head'))
      const threeParts = h4.screen()
      check('transcript paging: three same-anchor parts across three pages all survive in order', threeParts.includes('seg head') && threeParts.indexOf('seg head') < threeParts.indexOf('seg middle') && threeParts.indexOf('seg middle') < threeParts.indexOf('seg tail'), threeParts)
    } finally {
      app4.unmount()
      h4.terminal.dispose()
    }

    // Heterogeneous same-anchor split: one API message with a reasoning and
    // a text block, paginated per block. The older page's reasoning part
    // must survive (a taken key is never a drop reason) and stay ahead of
    // the answer text.
    const h5 = mk()
    const mixedState = {
      agentId: 'agent-mix', description: 'heterogeneous probe', status: 'completed' as const, startedAt: NOW - 3000, completedAt: NOW,
      output: [], outputEvents: [], toolCalls: [] as never[],
    }
    const mixedMessage = (block: Record<string, unknown>) => ({ type: 'assistant.message', seq: 1, anchor: 'msg_mix', attemptId: 'msg_mix', time: NOW, blocks: [block], canonical: true, parentCallId: 'agent-mix' })
    const mixedLoad = async (_agentId: string, window?: { count: number; skipFromStart: number }) => {
      if (window === undefined) return { events: [mixedMessage({ type: 'text', text: 'the answer text' })], parentAgentId: null, uuids: ['u-t'], hasOlder: true, skippedFromStart: 1 } as never
      return { events: [mixedMessage({ type: 'reasoning', text: 'the reasoning head' })], parentAgentId: null, uuids: ['u-r'], hasOlder: false, skippedFromStart: 0 } as never
    }
    const app5 = await render(React.createElement(AlternateScreen, null, React.createElement(SubagentDetailScene, { subagent: mixedState as never, onBack: () => undefined, loadTranscript: mixedLoad })), {
      stdout: h5.stdout, stdin: h5.stdin as never, stderr: h5.stdout, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      // 固定窗:pacing the key handler attaches after the first frame.
      await sleep(200)
      h5.stdin.write('\x1b[C')
      // 固定窗:pacing 分帧送达第二枚方向键。
      await sleep(200)
      h5.stdin.write('\x1b[C')
      // 固定窗:探针 分页页窗 翻页与异步转录读取落帧。
      await sleep(300)
      await settled(() => h5.screen().includes('the answer text') && h5.screen().includes('Load 1 older'))
      const clickMixed = async (): Promise<void> => {
        const hit = findText(h5.terminal, 'Load 1 older') as { col: number; row: number } | null
        if (hit === null) return
        const seq = (final: string): string => `\x1b[<0;${hit.col + 1};${hit.row + 1}${final}`
        h5.stdin.write(seq('M'))
        // 固定窗:pacing 鼠标 press→release 步间。
        await sleep(30)
        h5.stdin.write(seq('m'))
      }
      await clickMixed()
      const headerShown = await settled(() => h5.screen().includes('Thinking'))
      if (headerShown) {
        h5.stdin.write('\r')
        // 固定窗:pacing Enter 展开思考落帧。
        await sleep(250)
      }
      const mixed = h5.screen()
      check('transcript paging: a reasoning part under a taken text key survives (never dropped)', mixed.includes('the reasoning head') && mixed.includes('the answer text'), mixed)
      check('transcript paging: … the reasoning precedes the answer of the same message', mixed.indexOf('the reasoning head') < mixed.indexOf('the answer text'), mixed)
    } finally {
      app5.unmount()
      h5.terminal.dispose()
    }

    // Interleaved split: text, tool, text of one message across the page
    // boundary. The tool card must stay between the two text parts, not
    // hoisted ahead of the merged row.
    const h6 = mk()
    const interState = {
      agentId: 'agent-inter', description: 'interleave probe', status: 'completed' as const, startedAt: NOW - 3000, completedAt: NOW,
      output: [], outputEvents: [], toolCalls: [] as never[],
    }
    const interText = (text: string) => ({ type: 'assistant.message', seq: 1, anchor: 'msg_tool', attemptId: 'msg_tool', time: NOW, blocks: [{ type: 'text', text }], canonical: true, parentCallId: 'agent-inter' })
    const interLoad = async (_agentId: string, window?: { count: number; skipFromStart: number }) => {
      if (window === undefined) return { events: [interText('seg after tool')], parentAgentId: null, uuids: ['u-a'], hasOlder: true, skippedFromStart: 2 } as never
      return {
        events: [
          interText('seg before tool'),
          { type: 'tool.call', seq: 2, anchor: 'call-mid', turn: 0, step: 0, callId: 'call-mid', name: 'Read', argsJson: JSON.stringify({ file_path: '/fixture/project/NEEDLE.md' }), parentCallId: 'agent-inter', time: NOW },
        ],
        parentAgentId: null, uuids: ['u-b'], hasOlder: false, skippedFromStart: 0,
      } as never
    }
    const app6 = await render(React.createElement(AlternateScreen, null, React.createElement(SubagentDetailScene, { subagent: interState as never, onBack: () => undefined, loadTranscript: interLoad })), {
      stdout: h6.stdout, stdin: h6.stdin as never, stderr: h6.stdout, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      // 固定窗:pacing the key handler attaches after the first frame.
      await sleep(200)
      h6.stdin.write('\x1b[C')
      // 固定窗:pacing 分帧送达第二枚方向键。
      await sleep(200)
      h6.stdin.write('\x1b[C')
      // 固定窗:探针 分页页窗 翻页与异步转录读取落帧。
      await sleep(300)
      await settled(() => h6.screen().includes('seg after tool') && h6.screen().includes('Load 2 older'))
      const hitInter = findText(h6.terminal, 'Load 2 older') as { col: number; row: number } | null
      if (hitInter !== null) {
        const seqI = (final: string): string => `\x1b[<0;${hitInter.col + 1};${hitInter.row + 1}${final}`
        h6.stdin.write(seqI('M'))
        // 固定窗:pacing 鼠标 press→release 步间。
        await sleep(30)
        h6.stdin.write(seqI('m'))
      }
      await settled(() => h6.screen().includes('NEEDLE.md'))
      const interleaved = h6.screen()
      const before = interleaved.indexOf('seg before tool')
      const tool = interleaved.indexOf('NEEDLE.md')
      const after = interleaved.indexOf('seg after tool')
      check('transcript paging: a tool between two same-anchor text parts stays between them (no hoisting)', before !== -1 && tool !== -1 && after !== -1 && before < tool && tool < after, interleaved)
    } finally {
      app6.unmount()
      h6.terminal.dispose()
    }
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
}
// ── replay after resume ───────────────────────────────────────────────
{
  const transcript = readFileSync(join(FIXTURES, 'transcripts', 'subagent.jsonl'), 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as { kind: string; agentId?: string; msg: Rec })
  const main = transcript.filter(line => line.kind === 'main').map(line => line.msg)
  const own = transcript.filter(line => line.kind === 'subagent').map(line => line.msg)
  const replay = replayClaudeTranscript(main, { cwd: '/fixture/project', subagents: new Map([['toolu_fixture_001', { agentId: 'aedea1ecd3a81bb44', messages: own }]]) })
  const { channel, query, session } = await openChannel({ resume: replay })
  try {
    const card = subagentRows(channel)
    check('resume: the replayed card sits after the call, settled, with its replayed tool and output', card.length === 1 && card[0]!.subagent?.agentId === 'aedea1ecd3a81bb44' && card[0]!.subagent.status === 'completed'
      && card[0]!.subagent.toolCalls.map(tool => `${tool.name}:${tool.status}`).join() === 'Read:completed' && card[0]!.subagent.outputLines.some(line => line.includes('Fixture project')), card[0]?.subagent)
    check('resume: the dashboard roster has it (detail: output events, summary from the hand-back)', channel.subagents.length === 1 && channel.subagents[0]!.outputEvents.length > 0 && (channel.subagents[0]!.summary ?? '').includes('Fixture project') && !(channel.subagents[0]!.summary ?? '').includes('hand-back'))
    check('resume: the context window is asked for once, before any live result', await settled(() => channel.contextWindow === 200_000) && query.calls.filter(call => call.method === 'getContextUsage').length >= 1, query.calls.map(call => call.method))
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }

  // Terminal states from the main chain (or none at all).
  const at = (n: number): string => `2026-10-02T10:00:0${n}.000Z`
  const chain: Rec[] = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'delegate three' }, timestamp: at(0) },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [
      { type: 'tool_use', id: 'c-fg', name: 'Agent', input: { description: 'fails', prompt: 'x' } },
      { type: 'tool_use', id: 'c-bg', name: 'Agent', input: { description: 'bg done', prompt: 'y', run_in_background: true } },
      { type: 'tool_use', id: 'c-open', name: 'Agent', input: { description: 'never ended', prompt: 'z', run_in_background: true } },
      { type: 'tool_use', id: 'c-int', name: 'Agent', input: { description: 'interrupted', prompt: 'w' } },
    ] }, timestamp: at(1) },
    { type: 'user', uuid: 'r1', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'c-fg', content: 'Agent crashed', is_error: true },
      { type: 'tool_result', tool_use_id: 'c-bg', content: 'Async agent launched successfully.' },
      { type: 'tool_result', tool_use_id: 'c-open', content: 'Async agent launched successfully.' },
      { type: 'tool_result', tool_use_id: 'c-int', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
    ] }, timestamp: at(2) },
    { type: 'assistant', uuid: 'a2', message: { id: 'm2', content: [{ type: 'text', text: 'launched' }] }, timestamp: at(3) },
    { type: 'user', uuid: 'n1', message: { role: 'user', content: '<task-notification>\n<task-id>t-bg</task-id>\n<tool-use-id>c-bg</tool-use-id>\n<status>completed</status>\n<summary>bg finished well</summary>\n</task-notification>' }, timestamp: at(4) },
    { type: 'assistant', uuid: 'a3', message: { id: 'm3', content: [{ type: 'text', text: 'noted' }] }, timestamp: at(5) },
  ]
  const states = replayClaudeTranscript(chain, { cwd: '/fixture/project' })
  const ends = new Map(states.events.flatMap(event => event.type === 'subagent.end' ? [[event.agentId, event] as const] : []))
  check('replay: an error result → failed, its text the summary', ends.get('c-fg')?.status === 'failed' && ends.get('c-fg')?.summary === 'Agent crashed', ends.get('c-fg'))
  check('replay: an interrupted result → cancelled', ends.get('c-int')?.status === 'cancelled')
  check('replay: a background launch ends at its <task-notification>, with its summary', ends.get('c-bg')?.status === 'completed' && ends.get('c-bg')?.summary === 'bg finished well'
    && states.events.indexOf(ends.get('c-bg')!) > states.events.findIndex(event => event.type === 'tool.result' && event.callId === 'c-bg'))
  check('replay: no recorded end → unknown', ends.get('c-open')?.status === 'unknown')
  const harnessed = await openChannel({ resume: states })
  try {
    const cards = subagentRows(harnessed.channel).map(row => `${row.subagent?.description}:${row.subagent?.status}`)
    check('replay: four settled cards, none left running', JSON.stringify(cards) === JSON.stringify(['fails:failed', 'bg done:completed', 'never ended:unknown', 'interrupted:cancelled']), cards)
  } finally {
    harnessed.channel.releaseContributions()
    await harnessed.session.dispose()
  }
}

// ── nested delegations end on replay ───────────────────────────────────
{
  const at = (n: number): string => `2026-10-02T11:00:0${n}.000Z`
  const chain: Rec[] = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'delegate deep' }, timestamp: at(0) },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'tool_use', id: 'c-outer', name: 'Agent', input: { description: 'outer', prompt: 'x' } }] }, timestamp: at(1) },
    { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c-outer', content: 'The report follows:\n  outer done' }] }, timestamp: at(5) },
  ]
  const outer: Rec[] = [
    { type: 'user', message: { role: 'user', content: 'outer prompt' }, timestamp: at(1) },
    { type: 'assistant', message: { id: 'o1', content: [
      { type: 'tool_use', id: 'c-inner-done', name: 'Agent', input: { description: 'inner done', prompt: 'y' } },
      { type: 'tool_use', id: 'c-inner-lost', name: 'Agent', input: { description: 'inner lost', prompt: 'z' } },
    ] }, timestamp: at(2) },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c-inner-done', content: 'The report follows:\n  inner finished' }] }, timestamp: at(3) },
    { type: 'assistant', message: { id: 'o2', content: [{ type: 'text', text: 'outer wraps up' }] }, timestamp: at(4) },
  ]
  const inner: Rec[] = [
    { type: 'user', message: { role: 'user', content: 'inner prompt' }, timestamp: at(2) },
    { type: 'assistant', message: { id: 'i1', content: [{ type: 'text', text: 'inner works' }] }, timestamp: at(3) },
  ]
  const replay = replayClaudeTranscript(chain, { cwd: '/fixture/project', subagents: new Map([
    ['c-outer', { agentId: 'agent-outer', messages: outer }],
    ['c-inner-done', { agentId: 'agent-inner', messages: inner }],
  ]) })
  const ends = new Map(replay.events.flatMap(event => event.type === 'subagent.end' ? [[event.agentId, event] as const] : []))
  check('replay: a nested delegation ends from the result in its parent\'s transcript', ends.get('agent-inner')?.status === 'completed' && (ends.get('agent-inner')?.summary ?? '').includes('inner finished'), ends.get('agent-inner'))
  check('replay: … its own transcript replays on its own lane', replay.events.some(event => event.type === 'assistant.message' && event.parentCallId === 'c-inner-done'))
  check('replay: a nested delegation with no recorded end → unknown at the end of the replay', ends.get('c-inner-lost')?.status === 'unknown')
  const { channel, session } = await openChannel({ resume: replay })
  try {
    check('replay: no nested card is left running', channel.subagents.length === 3 && channel.subagents.every(item => item.status !== 'running' && item.status !== 'starting'), channel.subagents.map(item => `${item.description}:${item.status}`))
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
}

// ── parent_agent_id passthrough: nesting heals by agent id ──────────────
{
  const at = (n: number): string => `2026-10-02T12:00:0${n}.000Z`
  const chain: Rec[] = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'delegate deep' }, timestamp: at(0) },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'tool_use', id: 'c-outer', name: 'Agent', input: { description: 'outer', prompt: 'x' } }] }, timestamp: at(1) },
    { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c-outer', content: 'The report follows:\n  outer done' }] }, timestamp: at(5) },
  ]
  const outer: Rec[] = [
    { type: 'user', message: { role: 'user', content: 'outer prompt' }, timestamp: at(1) },
    { type: 'assistant', message: { id: 'o1', content: [{ type: 'tool_use', id: 'c-heal', name: 'Agent', input: { description: 'healed child', prompt: 'y' } }] }, timestamp: at(2) },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c-heal', content: 'The report follows:\n  healed finished' }] }, timestamp: at(3) },
    { type: 'assistant', message: { id: 'o2', content: [{ type: 'text', text: 'outer wraps up' }] }, timestamp: at(4) },
  ]
  const healed: Rec[] = [
    // Old-format store: the child's messages never recorded the delegating
    // call id, but parent_agent_id still names its true parent agent.
    { type: 'user', message: { role: 'user', content: 'healed prompt' }, timestamp: at(2) },
    { type: 'assistant', message: { id: 'h1', content: [{ type: 'text', text: 'healed works' }] }, timestamp: at(3) },
  ]
  const depth1: Rec[] = [
    // A depth-1 child of the main loop whose call attribution is likewise
    // missing: parent_agent_id reports null.
    { type: 'user', message: { role: 'user', content: 'depth1 prompt' }, timestamp: at(1) },
    { type: 'assistant', message: { id: 'd1', content: [{ type: 'text', text: 'depth1 works' }] }, timestamp: at(2) },
  ]
  const chainDepth1: Rec[] = [
    ...chain.slice(0, 2),
    { type: 'assistant', uuid: 'a2', message: { id: 'm2', content: [{ type: 'tool_use', id: 'c-d1', name: 'Agent', input: { description: 'depth one', prompt: 'z' } }] }, timestamp: at(2) },
    { type: 'user', uuid: 'r2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c-d1', content: 'The report follows:\n  depth1 done' }] }, timestamp: at(3) },
  ]
  const replay = replayClaudeTranscript(chain, { cwd: '/fixture/project', subagents: new Map([
    ['c-outer', { agentId: 'agent-outer', messages: outer }],
    // Not keyed by the call: reachable only through its own agent id +
    // parentAgentId healing.
    ['agent-healed', { agentId: 'agent-healed', messages: healed, parentAgentId: 'agent-outer' }],
  ]) })
  check('parent_agent_id: a nested transcript with no call attribution heals onto its true parent', replay.events.some(event => event.type === 'subagent.start' && event.agentId === 'agent-healed' && event.parentCallId === 'c-heal'), replay.events.filter(event => event.type === 'subagent.start'))
  check('parent_agent_id: … its messages replay on the delegating call lane', replay.events.some(event => event.type === 'assistant.message' && event.parentCallId === 'c-heal' && JSON.stringify((event as { blocks?: { text?: string }[] }).blocks).includes('healed works')))
  check('parent_agent_id: … and it ends from the result in its parent transcript', replay.events.some(event => event.type === 'subagent.end' && event.agentId === 'agent-healed' && event.status === 'completed'))

  // parent_agent_id null = a depth-1 child (or old metadata): the data
  // cannot say which main-loop call launched it, so the deterministic rule
  // attaches it to the first main-loop call whose own transcript is
  // missing. The child stays visible as a depth-1 spawn, never an orphan.
  const depth1Replay = replayClaudeTranscript(chainDepth1, { cwd: '/fixture/project', subagents: new Map([
    ['c-outer', { agentId: 'agent-outer', messages: outer }],
    ['agent-d1', { agentId: 'agent-d1', messages: depth1 }],
  ]) })
  check('parent_agent_id: a null parent (depth-1 / old format) heals onto the first transcript-less main-loop call', depth1Replay.events.some(event => event.type === 'subagent.start' && event.agentId === 'agent-d1' && event.parentCallId === 'c-d1'), depth1Replay.events.filter(event => event.type === 'subagent.start'))
  check('parent_agent_id: … its lane replays (no invisible child)', depth1Replay.events.some(event => event.type === 'assistant.message' && event.parentCallId === 'c-d1'))

  const phantomReplay = replayClaudeTranscript(chain, { cwd: '/fixture/project', subagents: new Map([
    ['c-outer', { agentId: 'agent-outer', messages: outer }],
    // Names a parent agent this chain never held: stays unattached, with no
    // fabricated parent and no orphan card.
    ['agent-phantom', { agentId: 'agent-phantom', messages: healed, parentAgentId: 'agent-nowhere' }],
  ]) })
  check('parent_agent_id: a transcript naming an unknown parent stays unattached (no fabricated nesting)', !phantomReplay.events.some(event => (event.type === 'subagent.start' || event.type === 'subagent.end') && event.agentId === 'agent-phantom') && !phantomReplay.events.some(event => 'blocks' in event && JSON.stringify(event).includes('healed works')))
}

// ── fail-closed attribution: ambiguous twins never cross-wire ──────────
{
  const at = (n: number): string => `2026-10-04T09:00:0${n}.000Z`
  // Two children of one parent, both without call-id metadata (parent_agent_id
  // carries no call identity), Map insertion order reversed against the parent's
  // call order (listSubagents traversal order).
  const twinsCalls: Rec = { type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [
    { type: 'tool_use', id: 'c-A', name: 'Agent', input: { description: 'twin A', prompt: 'x' } },
    { type: 'tool_use', id: 'c-B', name: 'Agent', input: { description: 'twin B', prompt: 'y' } },
  ] }, timestamp: at(1) }
  const twinBody = (text: string): Rec[] => [
    { type: 'user', message: { role: 'user', content: `${text} prompt` }, timestamp: at(1) },
    { type: 'assistant', message: { id: `msg_${text.replace(/\s/g, '')}`, content: [{ type: 'text', text: `${text} body` }] }, timestamp: at(2) },
  ]
  // Reversed insertion order: child-b first, whatever the call order is.
  const reversedMap = () => new Map([
    ['child-b', { agentId: 'child-b', messages: twinBody('child B') }],
    ['child-a', { agentId: 'child-a', messages: twinBody('child A') }],
  ])
  const twinsChain = (named: boolean): Rec[] => [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'delegate two' }, timestamp: at(0) },
    twinsCalls,
    { type: 'user', uuid: 'r1', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'c-A', content: named ? `The report follows:\n  result A\nagentId: child-a` : 'The report follows:\n  result A' },
      { type: 'tool_result', tool_use_id: 'c-B', content: named ? `The report follows:\n  result B\nagentId: child-b` : 'The report follows:\n  result B' },
    ] }, timestamp: at(4) },
  ]

  // (a) Ambiguous: no hand-back agent id, and pairing by Map order would
  // wire child B's body onto call A's card. Fail closed: neither attaches;
  // each call's card keeps its own result as the summary.
  const ambiguous = replayClaudeTranscript(twinsChain(false), { cwd: '/fixture/project', subagents: reversedMap() })
  const starts = ambiguous.events.filter(event => event.type === 'subagent.start')
  check('attribution: ambiguous twins stay unattached (no Map-order pairing, no cross-wiring)', !starts.some(event => (event as { agentId?: string }).agentId === 'child-a' || (event as { agentId?: string }).agentId === 'child-b'), starts)
  check('attribution: … neither child body replays onto a call lane', !ambiguous.events.some(event => 'blocks' in event && JSON.stringify(event).includes('body')))
  const ends = new Map(ambiguous.events.flatMap(event => event.type === 'subagent.end' ? [[event.agentId, event] as const] : []))
  check('attribution: … each call keeps its own hand-back as the summary', ends.get('c-A')?.summary === 'result A' && ends.get('c-B')?.summary === 'result B', [...ends.entries()].map(([id, e]) => `${id}:${(e as { summary?: string }).summary}`))

  // (b) Constructive: the hand-back results name their children (`agentId:`
  // line), which attributes them exactly despite the reversed Map order.
  const named = replayClaudeTranscript(twinsChain(true), { cwd: '/fixture/project', subagents: reversedMap() })
  const namedStarts = new Map(named.events.filter(event => event.type === 'subagent.start').map(event => [(event as { agentId?: string }).agentId, event] as const))
  check('attribution: hand-back agent ids attach each twin to its OWN call', namedStarts.get('child-a')?.parentCallId === 'c-A' && namedStarts.get('child-b')?.parentCallId === 'c-B', [...namedStarts.entries()].map(([id, e]) => `${id}->${(e as { parentCallId?: string }).parentCallId}`))
  check('attribution: … each body replays on its own lane', named.events.some(event => event.type === 'assistant.message' && event.parentCallId === 'c-A' && JSON.stringify(event).includes('child A body')) && named.events.some(event => event.type === 'assistant.message' && event.parentCallId === 'c-B' && JSON.stringify(event).includes('child B body')))
  const namedEnds = new Map(named.events.flatMap(event => event.type === 'subagent.end' ? [[event.agentId, event] as const] : []))
  check('attribution: … summaries stay per-call (agentId line stripped)', namedEnds.get('child-a')?.summary === 'result A' && namedEnds.get('child-b')?.summary === 'result B', [...namedEnds.entries()].map(([id, e]) => `${id}:${(e as { summary?: string }).summary}`))
}
// ── a foreground subagent cannot outlive its turn ──────────────────────
{
  const { channel, query, session } = await openChannel()
  try {
    await session.submit({ text: 'go', clientMessageId: 'u1' }, 'turn')
    query.emit({ type: 'command_lifecycle', command_uuid: 'u1', state: 'started' })
    query.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', model: 'claude-haiku', usage: {} } } })
    query.emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'call-fg', name: 'Agent', input: { description: 'foreground', prompt: 'x' } }] } })
    query.emit({ type: 'system', subtype: 'task_started', task_id: 'fg-9', tool_use_id: 'call-fg', description: 'foreground', is_backgrounded: false, task_type: 'local_agent' })
    check('a foreground subagent runs', await settled(() => channel.subagents.find(item => item.agentId === 'fg-9')?.status === 'running'))
    // A long subagent output line is capped.
    query.emit({ type: 'assistant', parent_tool_use_id: 'call-fg', message: { id: 'sub-1', content: [{ type: 'text', text: 'x'.repeat(5000) }] } })
    check('a subagent output line is capped (400 chars + ellipsis)', await settled(() => (channel.subagents.find(item => item.agentId === 'fg-9')?.output.at(-1)?.length ?? 0) > 0) && channel.subagents.find(item => item.agentId === 'fg-9')!.output.at(-1)!.length === 401 && channel.subagents.find(item => item.agentId === 'fg-9')!.output.at(-1)!.endsWith('…'))
    // A lane result keeps a bounded payload.
    const laneEvents: import('../src/agent/events.js').AgentEvent[] = []
    session.subscribe(batch => { laneEvents.push(...batch) })
    query.emit({ type: 'assistant', parent_tool_use_id: 'call-fg', message: { id: 'sub-2', content: [{ type: 'tool_use', id: 'lane-read', name: 'Read', input: { file_path: '/fixture/project/big.txt' } }] } })
    query.emit({ type: 'user', parent_tool_use_id: 'call-fg', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'lane-read', content: 'y'.repeat(50_000) }] } })
    const laneResult = await settled(() => laneEvents.some(event => event.type === 'tool.result' && event.callId === 'lane-read'))
      ? laneEvents.find(event => event.type === 'tool.result' && event.callId === 'lane-read') as Extract<import('../src/agent/events.js').AgentEvent, { type: 'tool.result' }>
      : undefined
    check('a lane tool result carries a bounded payload', laneResult !== undefined && laneResult.text.length <= 2001 && JSON.stringify(laneResult.content).length < 3000, laneResult?.text.length)
    // The CLI exits mid-delegation: the turn is force-closed, the subagent settled.
    query.close()
    check('the process exits mid-delegation → the foreground subagent settles unknown', await settled(() => channel.subagents.find(item => item.agentId === 'fg-9')?.status === 'unknown'), channel.subagents.map(item => item.status))
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
  // turn.end with a live foreground subagent; a late real end still wins.
  const second = await openChannel()
  try {
    await second.session.submit({ text: 'go', clientMessageId: 'u2' }, 'turn')
    second.query.emit({ type: 'command_lifecycle', command_uuid: 'u2', state: 'started' })
    second.query.emit({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'call-fg2', name: 'Agent', input: { description: 'fg two', prompt: 'x' } }] } })
    second.query.emit({ type: 'system', subtype: 'task_started', task_id: 'fg-10', tool_use_id: 'call-fg2', description: 'fg two', is_backgrounded: false, task_type: 'local_agent' })
    second.query.emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.001, modelUsage: {} })
    check('turn.end settles a still-live foreground subagent as unknown', await settled(() => second.channel.subagents.find(item => item.agentId === 'fg-10')?.status === 'unknown'))
    second.query.emit({ type: 'system', subtype: 'task_notification', task_id: 'fg-10', tool_use_id: 'call-fg2', status: 'completed', output_file: '', summary: 'late report', usage: { total_tokens: 5 } })
    check('… a late real end still wins', await settled(() => second.channel.subagents.find(item => item.agentId === 'fg-10')?.status === 'completed'))
  } finally {
    second.channel.releaseContributions()
    await second.session.dispose()
  }
}

console.log(`\nverify-claude-subagents OK (${passed} checks)`)
process.exit(0)
