/**
 * Claude background tasks end to end, over a fake SDK (no CLI, no network):
 *
 *  - background Bash lifecycle (the recorded `background-bash` fixture
 *    through a real Claude session and the channel core): `task_started
 *    {is_backgrounded}` → a job card after its Bash card, the output file
 *    from the command's acknowledgement, the status-line chip while it runs,
 *    `task_updated` / `task_notification` settle it once (one toast), the
 *    notification turn; a foreground Bash (`is_backgrounded:false`) stays
 *    card-only; a foreground Bash moved to the background becomes a job;
 *  - `tasks.snapshot` replace semantics: a job missing from the level is
 *    settled (inferred, no toast, "status unknown"), a later real end still
 *    wins, a job back in the level runs again;
 *  - kill: `jobControl.kill` → `q.stopTask(id)`, the CLI's `stopped` report
 *    settles it killed; a user interrupt only interrupts (never stops a
 *    task) and the job keeps running;
 *  - the output tail: read only from the path the CLI reported, validated
 *    (absolute, `<taskId>.output`, inside the CLI's directories after
 *    resolving symlinks, a regular file), the last 64 KiB only; polled at
 *    most once a second while watched, stopped when unwatched, read once
 *    more after the job settles;
 *  - render: the job card, the `/jobs` panel with the tail, the chip.
 *
 * Run: node --import tsx/esm scripts/verify-claude-tasks.ts
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-claude-tasks-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.FORCE_COLOR = '3'

const [
  { PassThrough, Writable },
  React,
  { Terminal },
  { render },
  { Chat },
  { QuestionStore },
  { openClaudeSession },
  { memoryClaudePrefs },
  { createChannel },
  { createActivityProjection, ACTIVITY_TAIL_INTERVAL_MS, ACTIVITY_TAIL_LINES },
  { readTaskOutputTail, resolveTaskOutputPath, taskOutputRoots, TASK_OUTPUT_TAIL_BYTES },
  { setLang, t },
  { settled, sleep },
  fakes,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/channel/questions.js'),
  import('../src/backends/claude/session.js'),
  import('../src/backends/claude/prefs.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/channel/activity.js'),
  import('../src/backends/claude/task-output.js'),
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

async function openChannel(env?: Record<string, string>): Promise<{ channel: ChannelState; query: FakeQuery; session: Awaited<ReturnType<typeof openClaudeSession>> }> {
  const fake = fakeClaudeSdk(() => ({ capabilities: ['msg_lifecycle_v1', 'interrupt_receipt_v1'] }), {
    stopTask: () => undefined,
    interrupt: () => ({ still_queued: [] }),
  })
  const session = await openClaudeSession(claudeDeps(fake.sdk, { prefs: memoryClaudePrefs(), ...(env === undefined ? {} : { env }) }))
  const channel = createChannel(ctx, session, { model: 'Claude Agent', provider: 'claude', cwd: '/fixture/project', activity: false, backendLabel: 'Claude Agent' })
  return { channel, query: fake.queries[0]!, session }
}
const jobRows = (channel: ChannelState) => channel.rows.filter(row => row.kind === 'job')
const live = (channel: ChannelState) => channel.backgroundJobs.filter(job => job.status === 'running' || job.status === 'stopping')

/** Feed a recorded fixture; `at` runs after each out-message. */
async function feed(name: string, session: Awaited<ReturnType<typeof openClaudeSession>>, query: FakeQuery, at: (msg: Rec) => Promise<void> = () => Promise.resolve()): Promise<void> {
  for (const line of lines(name)) {
    if (line.dir === 'in' && line.msg !== undefined) {
      await session.submit({ text: String((line.msg.message as Rec).content), clientMessageId: String(line.msg.uuid) }, line.placement ?? 'turn')
      continue
    }
    if (line.dir !== 'out' || line.msg === undefined) continue
    query.emit(line.msg)
    await tick()
    await at(line.msg)
  }
}

// ── background Bash lifecycle (recorded) ─────────────────────────────────
{
  const { channel, query, session } = await openChannel()
  try {
    let checkedStart = false
    let checkedAck = false
    let checkedLevel = false
    await feed('background-bash', session, query, async msg => {
      if (!checkedStart && msg.type === 'system' && msg.subtype === 'task_started') {
        checkedStart = true
        check('task_started{is_backgrounded} → a running job card right after its Bash card', await settled(() => jobRows(channel).length === 1) && jobRows(channel)[0]!.job?.status === 'running'
          && channel.rows.indexOf(jobRows(channel)[0]!) === channel.rows.findIndex(row => row.kind === 'tool' && row.tool?.name === 'Bash') + 1, channel.rows.map(row => row.kind))
        const job = channel.backgroundJobs[0]
        check('… labelled by its description, with the full command and kind', job?.id === 'b93f4dfp3' && job.label === 'sleep 3; echo bg-done' && job.command === 'sleep 3; echo bg-done' && job.kind === 'shell', job)
        check('… the chip counts it', live(channel).length === 1)
      }
      if (!checkedAck && msg.type === 'user' && JSON.stringify(msg).includes('Output is being written to')) {
        checkedAck = true
        check('the acknowledgement names its output file (from the CLI, not computed)', await settled(() => channel.backgroundJobs[0]?.outputFile === '/fixture/tmp/claude-1000/-fixture-project/00000000-0000-4000-8000-000000000003/tasks/b93f4dfp3.output'), channel.backgroundJobs[0])
      }
      if (!checkedLevel && msg.type === 'system' && msg.subtype === 'background_tasks_changed' && (msg.tasks as unknown[]).length === 0) {
        checkedLevel = true
        check('the level drops it before its bookend: settled at once (inferred, no toast), the chip is gone', await settled(() => live(channel).length === 0) && channel.backgroundJobs[0]!.detail === t('jobs-detail-unknown')
          && !channel.notifications.some(item => item.text.startsWith('Background job')), channel.backgroundJobs[0])
      }
    })
    check('the bookend wins over the inferred end: completed, its exit code as the (short) detail, one toast', await settled(() => channel.backgroundJobs[0]?.status === 'completed') && channel.backgroundJobs[0]!.detail === 'exit code: 0'
      && channel.notifications.filter(item => item.text.startsWith('Background job completed')).length === 1, { job: channel.backgroundJobs[0], toasts: channel.notifications.map(item => item.text) })
    check('the card settled with it', jobRows(channel)[0]?.job?.status === 'completed')
    check('the report started the CLI\'s notification turn (a notice, no user bubble)', channel.rows.some(row => row.kind === 'notice' && row.text === t('claude-notification-turn')) && channel.rows.filter(row => row.kind === 'user').length === 1)
    check('a job is never a subagent', channel.subagents.length === 0 && !channel.rows.some(row => row.kind === 'subagent'))
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
}

// ── a foreground Bash stays card-only ──────────────────────────────────
{
  const { channel, query, session } = await openChannel()
  try {
    await feed('fold-in-next', session, query)
    await settled(() => !channel.working && channel.rows.some(row => row.kind === 'tool'))
    check('a foreground Bash that ran ~3s (task_started is_backgrounded:false) makes no job and no chip', channel.backgroundJobs.length === 0 && jobRows(channel).length === 0 && channel.rows.some(row => row.kind === 'tool' && row.tool?.name === 'Bash'))
    // … unless it is moved to the background (Ctrl+B in the CLI).
    query.emit({ type: 'assistant', message: { id: 'm9', content: [{ type: 'tool_use', id: 'call-fg', name: 'Bash', input: { command: 'sleep 60', description: 'long sleep' } }] } })
    query.emit({ type: 'system', subtype: 'task_started', task_id: 'fg-bash', tool_use_id: 'call-fg', description: 'long sleep', is_backgrounded: false, task_type: 'local_bash' })
    await tick()
    check('… still no job while it runs in the foreground', channel.backgroundJobs.length === 0)
    query.emit({ type: 'system', subtype: 'task_updated', task_id: 'fg-bash', patch: { is_backgrounded: true } })
    check('a foreground Bash moved to the background becomes a job (its command kept)', await settled(() => channel.backgroundJobs.some(job => job.id === 'fg-bash' && job.status === 'running' && job.command === 'sleep 60' && job.label === 'long sleep')), channel.backgroundJobs)
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
}

// ── snapshot replace semantics, kill, interrupt ───────────────────────
{
  const { channel, query, session } = await openChannel()
  const start = (id: string, callId: string, command: string): void => {
    query.emit({ type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id: callId, name: 'Bash', input: { command, run_in_background: true } }] } })
    query.emit({ type: 'system', subtype: 'task_started', task_id: id, tool_use_id: callId, description: command, is_backgrounded: true, task_type: 'local_bash' })
  }
  try {
    await session.submit({ text: 'run three', clientMessageId: 'u1' }, 'turn')
    query.emit({ type: 'command_lifecycle', command_uuid: 'u1', state: 'started' })
    query.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'j1', task_type: 'local_bash', description: 'a' }, { task_id: 'j2', task_type: 'local_bash', description: 'b' }, { task_id: 'j3', task_type: 'local_bash', description: 'c' }] })
    start('j1', 'c1', 'sleep 100')
    start('j2', 'c2', 'sleep 200')
    start('j3', 'c3', 'sleep 300')
    check('three jobs, three cards, chip 3', await settled(() => live(channel).length === 3 && jobRows(channel).length === 3))
    // A user interrupt (Esc) interrupts the turn, never a task.
    await session.cancel('user')
    check('a user interrupt only interrupts (no stopTask), the jobs keep running', query.calls.some(call => call.method === 'interrupt') && !query.calls.some(call => call.method === 'stopTask') && live(channel).length === 3, query.calls.map(call => call.method))
    query.emit({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'aborted_streaming', result: '', total_cost_usd: 0, modelUsage: {} })
    check('… and after the aborted turn closes, still 3 live', await settled(() => !channel.working) && live(channel).length === 3)
    check('kill → stopTask(id); true while it runs', channel.jobControl.kill('j1') && await settled(() => query.calls.some(call => call.method === 'stopTask' && call.args[0] === 'j1')))
    query.emit({ type: 'system', subtype: 'task_updated', task_id: 'j1', patch: { status: 'killed' } })
    query.emit({ type: 'system', subtype: 'task_notification', task_id: 'j1', tool_use_id: 'c1', status: 'stopped', output_file: '', summary: 'Background command "sleep 100" was stopped' })
    check('the stopped report settles it killed, one toast', await settled(() => channel.backgroundJobs.find(job => job.id === 'j1')?.status === 'killed') && channel.notifications.filter(item => item.text.startsWith('Background job killed')).length === 1)
    check('a settled job cannot be killed again (nothing asked)', !channel.jobControl.kill('j1') && query.calls.filter(call => call.method === 'stopTask').length === 1)
    // Replace: the level now lists only j3, so j2 is gone without a bookend.
    query.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'j3', task_type: 'local_bash', description: 'c' }] })
    check('a job missing from the level is settled (inferred) at once, the chip drops to 1', await settled(() => live(channel).length === 1) && channel.backgroundJobs.find(job => job.id === 'j2')?.detail === t('jobs-detail-unknown') && !channel.notifications.some(item => item.text.includes('sleep 200')))
    // The level lists it again (ordering is unspecified): it runs again.
    query.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'j2', task_type: 'local_bash', description: 'b' }, { task_id: 'j3', task_type: 'local_bash', description: 'c' }] })
    check('… back in the level, it runs again', await settled(() => channel.backgroundJobs.find(job => job.id === 'j2')?.status === 'running') && channel.backgroundJobs.find(job => job.id === 'j2')?.detail === undefined)
    query.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
    query.emit({ type: 'system', subtype: 'task_notification', task_id: 'j2', tool_use_id: 'c2', status: 'failed', output_file: '', summary: 'Background command "sleep 200" failed with exit code 1' })
    check('a real failure after an inferred end is the outcome (one toast, its exit code)', await settled(() => channel.backgroundJobs.find(job => job.id === 'j2')?.status === 'failed') && channel.backgroundJobs.find(job => job.id === 'j2')?.detail === 'exit code: 1' && channel.notifications.filter(item => item.text.startsWith('Background job failed')).length === 1)
    check('j3 never reported: settled as unknown, no toast', channel.backgroundJobs.find(job => job.id === 'j3')?.status === 'killed' && channel.backgroundJobs.find(job => job.id === 'j3')?.detail === t('jobs-detail-unknown') && !channel.notifications.some(item => item.text.includes('sleep 300')))
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
}

// ── output path validation and the 64 KiB tail ──────────────────────────
const roots = mkdtempSync(join(tmpdir(), 'dsh-tui-task-roots-'))
const inside = join(roots, 'claude-1000', 'proj', 'sess', 'tasks')
const outside = mkdtempSync(join(tmpdir(), 'dsh-tui-task-outside-'))
mkdirSync(inside, { recursive: true })
{
  const allowed = [roots]
  const file = join(inside, 'tid1.output')
  const big = Array.from({ length: 4000 }, (_, index) => `line ${String(index).padStart(5, '0')} ${'x'.repeat(30)}`).join('\n') + '\n'
  writeFileSync(file, big)
  const tail = readTaskOutputTail(file, 'tid1', allowed)
  check('the tail is at most 64 KiB of the end, starting at a whole line', Buffer.byteLength(tail) <= TASK_OUTPUT_TAIL_BYTES && tail.startsWith('line ') && tail.endsWith('line 03999 ' + 'x'.repeat(30) + '\n') && Buffer.byteLength(big) > TASK_OUTPUT_TAIL_BYTES, Buffer.byteLength(tail))
  writeFileSync(join(inside, 'small.output'), 'a\nb\n')
  check('a small file is read whole', readTaskOutputTail(join(inside, 'small.output'), 'small', allowed) === 'a\nb\n')
  const refused = (path: string, id: string): boolean => {
    try { resolveTaskOutputPath(path, id, allowed); return false } catch { return true }
  }
  writeFileSync(join(outside, 'tid2.output'), 'secret')
  check('a file outside the CLI\'s directories is refused', refused(join(outside, 'tid2.output'), 'tid2'))
  symlinkSync(join(outside, 'tid2.output'), join(inside, 'tid2.output'))
  check('a symlink inside that resolves outside is refused', refused(join(inside, 'tid2.output'), 'tid2'))
  writeFileSync(join(inside, 'other.output'), 'x')
  check('a file not named <taskId>.output is refused', refused(join(inside, 'other.output'), 'tid3'))
  check('a relative path is refused', refused('tasks/tid1.output', 'tid1'))
  mkdirSync(join(inside, 'dir.output'))
  let dirRefused = false
  try { readTaskOutputTail(join(inside, 'dir.output'), 'dir', allowed) } catch { dirRefused = true }
  check('a directory is refused', dirRefused)
  if (process.platform !== 'win32') {
    // A FIFO in the file's place must be refused at once: a blocking open
    // would park the UI thread until a writer appears. The guard opens a
    // writer after 500 ms, so a regression fails on the elapsed time instead
    // of hanging the script.
    const fifo = join(inside, 'fifo1.output')
    execFileSync('mkfifo', [fifo])
    const unblocker = spawn('sh', ['-c', 'sleep 0.5; exec 3>"$1"; sleep 0.2', 'sh', fifo], { stdio: 'ignore' })
    const started = Date.now()
    let fifoRefused = false
    try { readTaskOutputTail(fifo, 'fifo1', allowed) } catch { fifoRefused = true }
    const elapsed = Date.now() - started
    unblocker.kill('SIGKILL')
    check('a FIFO named <taskId>.output is refused without blocking (non-blocking open)', fifoRefused && elapsed < 400, elapsed)
  }
  check('the default roots are the temp dir and the Claude config dir, resolved', taskOutputRoots({ CLAUDE_CONFIG_DIR: roots }).includes(roots))
}

// ── polling bounds (manual timer) ──────────────────────────────────────
{
  const timers: (() => void)[] = []
  let cleared = 0
  const reads: string[] = []
  let content = 'one\ntwo\n'
  const state = { rows: [] as never[], subagents: [] as never[], backgroundJobs: [] as never[] }
  let emits = 0
  let clock = 0
  /** One interval passes, then the timer fires. */
  const fire = async (): Promise<void> => {
    clock += ACTIVITY_TAIL_INTERVAL_MS
    timers.at(-1)!()
    await tick()
  }
  const activity = createActivityProjection(() => state as never, {
    rowIds: { value: 0 },
    now: () => clock,
    emit: () => { emits += 1 },
    readOutput: id => { reads.push(id); return Promise.resolve(content) },
    timer: { set: callback => { timers.push(callback); return timers.length }, clear: () => { cleared += 1 } },
  })
  activity.apply({ type: 'task.start', taskId: 'p1', kind: 'shell', description: 'tail me', background: true, outputFile: '/tmp/p1.output', time: 0 }, false)
  const unwatch = activity.watchOutput('p1')
  await tick()
  check('watching reads once at once, one interval at most once a second', reads.length === 1 && timers.length === 1 && ACTIVITY_TAIL_INTERVAL_MS === 1000)
  check('… the tail lands in the job (and is published)', (state.backgroundJobs as { outputLines: { text: string }[] }[])[0]?.outputLines.map(line => line.text).join() === 'one,two' && emits === 1)
  const second = activity.watchOutput('p1')
  check('a second watcher shares the interval and reads nothing sooner', timers.length === 1 && reads.length === 1)
  timers[0]!()
  await tick()
  check('a tick within the interval reads nothing (at most once a second)', reads.length === 1)
  await fire()
  check('each interval reads once', reads.length === 2)
  content = Array.from({ length: 100 }, (_, index) => `l${index}\rL${index}`).join('\n')
  await fire()
  const tail = (state.backgroundJobs as { outputLines: { text: string }[] }[])[0]!.outputLines
  check(`the tail keeps the last ${ACTIVITY_TAIL_LINES} lines, a carriage return keeps the rewritten form`, tail.length === ACTIVITY_TAIL_LINES && tail.at(-1)?.text === 'L99' && tail[0]?.text === 'L70', tail.at(-1))
  unwatch()
  await fire()
  check('one watcher left: still polled', reads.length === 4)
  second()
  check('the last unwatch stops the interval', cleared === 1)
  activity.watchOutput('p1')
  activity.apply({ type: 'task.end', taskId: 'p1', status: 'completed', time: 5 }, false)
  await tick()
  const afterEnd = reads.length
  await fire()
  await fire()
  check('a settled job is read once more (at its end), then left alone', afterEnd === 5 && reads.length === afterEnd, reads.length)
  const failing = createActivityProjection(() => ({ rows: [], subagents: [], backgroundJobs: [] }) as never, {
    rowIds: { value: 0 },
    now: () => clock,
    readOutput: id => { reads.push(`fail:${id}`); return Promise.reject(new Error('missing')) },
    timer: { set: callback => { timers.push(callback); return timers.length }, clear: () => undefined },
  })
  failing.apply({ type: 'task.start', taskId: 'f1', kind: 'shell', description: 'x', background: true, outputFile: '/tmp/f1.output', time: 0 }, false)
  failing.watchOutput('f1')
  await tick()
  for (let index = 0; index < 8; index += 1) await fire()
  check('repeated read failures stop the polling of that job (bounded)', reads.filter(read => read === 'fail:f1').length === 5)
  activity.dispose()
  failing.dispose()
}

// ── the tail waits for the output path; a new path is a fresh start ──────
{
  const timers: (() => void)[] = []
  const reads: string[] = []
  let failing = true
  let clock = 0
  const state = { rows: [] as never[], subagents: [] as never[], backgroundJobs: [] as never[] }
  const fire = async (): Promise<void> => {
    clock += ACTIVITY_TAIL_INTERVAL_MS
    timers.at(-1)?.()
    await tick()
  }
  const activity = createActivityProjection(() => state as never, {
    rowIds: { value: 0 },
    now: () => clock,
    readOutput: id => { reads.push(id); return failing ? Promise.reject(new Error('missing')) : Promise.resolve('late output\n') },
    timer: { set: callback => { timers.push(callback); return timers.length }, clear: () => undefined },
  })
  // A job whose path the backend has not named yet (a subagent's background
  // Bash, a foreground Bash moved to the background): watched, never read.
  activity.apply({ type: 'task.start', taskId: 'w1', kind: 'shell', description: 'no path yet', background: true, time: 0 }, false)
  activity.watchOutput('w1')
  await tick()
  for (let index = 0; index < 8; index += 1) await fire()
  check('no output path: the watched job is neither read nor counted as failing', reads.length === 0)
  activity.apply({ type: 'task.update', taskId: 'w1', patch: { outputFile: '/tmp/a/w1.output' } }, false)
  await tick()
  check('… the path arrives: it is read at once', reads.length === 1)
  for (let index = 0; index < 8; index += 1) await fire()
  check('… failing reads of that path stop after the bound', reads.length === 5, reads.length)
  failing = false
  activity.apply({ type: 'task.end', taskId: 'w1', status: 'completed', outputFile: '/tmp/b/w1.output', time: 9 }, false)
  await tick()
  await fire()
  const job = (state.backgroundJobs as { id: string; outputLines: { text: string }[] }[]).find(item => item.id === 'w1')
  check('… a new path at the end resets the bound: the final tail is still read', reads.length >= 6 && job?.outputLines.map(line => line.text).join() === 'late output', { reads: reads.length, lines: job?.outputLines })
  activity.dispose()
}

// ── output paths with spaces; housekeeping tasks ───────────────────────
{
  const { backgroundOutputPath, createClaudeTranslator } = await import('../src/backends/claude/translate.js')
  const ack = 'Command running in background with ID: b77. Output is being written to: /tmp/claude 1000/my project/tasks/b77.output. You will be notified when it completes.'
  check('an output path with spaces is read whole (cut after <taskId>.output)', backgroundOutputPath(ack, 'b77') === '/tmp/claude 1000/my project/tasks/b77.output', backgroundOutputPath(ack, 'b77'))
  check('… and without the task id in it, up to the first word-ending .output', backgroundOutputPath('Output is being written to: /tmp/a b/x.output. Next sentence.', 'other') === '/tmp/a b/x.output')
  const translator = createClaudeTranslator({ cwd: '/fixture/project', userRows: 'lifecycle', now: () => 0 })
  const hidden = translator.translate({ type: 'system', subtype: 'task_started', task_id: 'amb1', task_type: 'local_bash', description: 'watcher', is_backgrounded: true, skip_transcript: true, ambient: true })
  check('task_started{skip_transcript, ambient} → task.start{hidden}', hidden.length === 1 && hidden[0]!.type === 'task.start' && (hidden[0] as { hidden?: boolean }).hidden === true, hidden)
  const shown = translator.translate({ type: 'system', subtype: 'task_started', task_id: 'job1', task_type: 'local_bash', description: 'build', is_backgrounded: true })
  check('… an ordinary background task is not hidden', shown.length === 1 && (shown[0] as { hidden?: boolean }).hidden === undefined)
}

// ── housekeeping tasks are not activity ────────────────────────────────
{
  const toasts: string[] = []
  const state = { rows: [] as { kind: string }[], subagents: [] as never[], backgroundJobs: [] as never[] }
  const activity = createActivityProjection(() => state as never, { rowIds: { value: 0 }, notify: text => { toasts.push(text); return () => undefined } })
  activity.apply({ type: 'task.start', taskId: 'h1', kind: 'monitor', description: 'watcher', background: true, hidden: true, time: 0 }, false)
  activity.apply({ type: 'task.end', taskId: 'h1', status: 'completed', time: 1 }, false)
  check('a hidden task gets no card, no roster entry (chip) and no toast', state.rows.length === 0 && state.backgroundJobs.length === 0 && toasts.length === 0)
  activity.dispose()
}

// ── the session reads the reported file (real timer) and renders ─────────
{
  const configDir = join(roots, 'config')
  mkdirSync(configDir, { recursive: true })
  const outputFile = join(inside, 'b7live.output')
  writeFileSync(outputFile, 'compiling…\nstep 1 ok\n')
  const { channel, query, session } = await openChannel({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_TMPDIR: roots })
  const COLS = 110
  const ROWS = 30
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
  try {
    query.emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'c-live', name: 'Bash', input: { command: 'make all', run_in_background: true } }] } })
    query.emit({ type: 'system', subtype: 'task_started', task_id: 'b7live', tool_use_id: 'c-live', description: 'make all', is_backgrounded: true, task_type: 'local_bash' })
    query.emit({ type: 'user', tool_use_result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b7live' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c-live', content: `Command running in background with ID: b7live. Output is being written to: ${outputFile}. You will be notified when it completes.` }] } })
    await settled(() => channel.backgroundJobs[0]?.outputFile === outputFile)
    const app = await render(React.createElement(Chat, { channel, questionStore: new QuestionStore(), onExit: () => undefined, fullscreen: false, trajectorySeen: true }), {
      stdout: stdout as never, stdin: stdin as never, stderr: stdout as never, exitOnCtrlC: false, patchConsole: false,
    })
    try {
      check('render: the live job card shows its id and label', await settled(() => screen().includes(`${t('jobs-card-prefix')}b7live`) && screen().includes('make all')), screen())
      check('render: the on-screen card pulls its tail from the reported file', await settled(() => screen().includes('step 1 ok'), { timeoutMs: 5000 }), screen())
      writeFileSync(outputFile, 'compiling…\nstep 1 ok\nstep 2 ok\n')
      check('render: … and keeps it fresh (polled while on screen)', await settled(() => screen().includes('step 2 ok'), { timeoutMs: 5000 }), screen())
      check('render: the status-line chip counts the live job', /● 1/u.test(screen()), screen())
      // 固定窗:pacing the prompt attaches its key handler after the first frame.
      await sleep(200)
      for (const char of '/jobs') stdin.write(char)
      // 固定窗:pacing typed characters land before Enter.
      await sleep(100)
      stdin.write('\r')
      check('render: /jobs lists it with its command and tail', await settled(() => screen().includes(t('jobs-panel-title').trim()) && screen().includes('b7live') && screen().includes('step 2 ok')), screen())
      stdin.write('\x1b')
      await settled(() => !screen().includes(t('jobs-panel-title').trim()))
      // The CLI's end report is a long sentence: only its exit code rides
      // the card header (a long detail would squeeze the label to nothing).
      query.emit({ type: 'system', subtype: 'task_notification', task_id: 'b7live', tool_use_id: 'c-live', status: 'completed', output_file: outputFile, summary: 'Background command "make all && make test && make install && make docs" completed (exit code 0)' })
      check('render: settled id and exit code stay in the header, command follows below', await settled(() => { const lines = screen().split('\n'); const header = lines.findIndex(line => line.includes(`${t('jobs-card-prefix')}b7live`)); return header >= 0 && lines[header]?.includes('exit code: 0') === true && lines[header + 1]?.trimStart().startsWith('make all') === true }), screen())
    } finally {
      app.unmount()
      terminal.dispose()
    }
    check('the job settles; its output file stays the reported one', await settled(() => channel.backgroundJobs[0]?.status === 'completed') && channel.backgroundJobs[0]!.outputFile === outputFile)
    // A path the CLI never reported is never read.
    check('readOutput refuses a task with no reported file', await session.capabilities.tasks!.readOutput!('never-reported').then(() => false, () => true))
    // Named right, in the temp dir, but a symlink to a file outside it.
    symlinkSync(process.execPath, join(inside, 'evil.output'))
    query.emit({ type: 'user', tool_use_result: { backgroundTaskId: 'evil' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c-evil', content: `Command running in background with ID: evil. Output is being written to: ${join(inside, 'evil.output')}. You will be notified.` }] } })
    await tick()
    check('readOutput refuses a reported path outside the CLI\'s directories', await session.capabilities.tasks!.readOutput!('evil').then(() => false, () => true))
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
}

console.log(`\nverify-claude-tasks OK (${passed} checks)`)
process.exit(0)
