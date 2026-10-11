/**
 * Claude backend working-activity line (the DSH working line reused for a
 * Claude session): the translator's own state folded by activity.ts into
 * WorkingActivityView values, published through the session's
 * `workingActivity` capability. Offline: synthetic SDK frames through the
 * real translator (no CLI, no network), the real fold, and one session-level
 * case over the shared fake SDK.
 *
 *  - fold lifecycle: nothing before the first turn; thinking on turn open;
 *    the ⏵ self-narration line of a streaming reply (and it survives the
 *    attempt that streamed it); tool phase (label = tool name, detail = the
 *    input's file_path/command/pattern/url/path, line = both); the tracked
 *    task's activeForm as the thinking phrase; a parked prompt outranks all
 *    (waiting); turn end parks on the done card (live=false, toolCount kept);
 *    the next turn revives; unchanged state publishes nothing.
 *  - detail extraction: priority order, whitespace flattening, 60-char clip.
 *  - session level: the capability delivers the same values a real turn
 *    produces (it fails without session.ts's publish hook), and a late
 *    subscriber receives the latest value once on subscribe.
 *
 * Run: node --import tsx/esm scripts/verify-claude-activity.ts
 */
import assert from 'node:assert/strict'
import type { WorkingActivityView } from '../src/adapter/ports/channel-view.js'
import { activityDetail, createClaudeActivityPublisher } from '../src/backends/claude/activity.js'
import { createClaudeTranslator, type ClaudeActivityState } from '../src/backends/claude/translate.js'
import { openClaudeSession } from '../src/backends/claude/session.js'
import { setLang, t } from '../src/i18n.js'
import { claudeText } from '../src/backends/claude/text.js'
import { claudeDeps, fakeClaudeSdk } from './lib/claude-fake-sdk.js'

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : label + ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)))
  passed += 1
  console.log('PASS ' + label)
}

type Rec = Record<string, unknown>
let clock = Date.UTC(2026, 9, 1, 12, 0, 0)
const now = (): number => (clock += 7)
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const settle = async (rounds = 4): Promise<void> => { for (let i = 0; i < rounds; i += 1) await tick() }

// ── ① detail extraction units ──────────────────────────────────────────────
{
  check('detail: file_path wins over the later keys',
    activityDetail({ file_path: 'src/a.ts', command: 'ls', pattern: '*.ts', url: 'https://x', path: 'b' }) === 'src/a.ts')
  check('detail: command second, pattern third',
    activityDetail({ command: 'pnpm build', pattern: 'TODO' }) === 'pnpm build' && activityDetail({ pattern: 'TODO.*' }) === 'TODO.*')
  check('detail: url and path are the last resorts',
    activityDetail({ url: 'https://example.com/x' }) === 'https://example.com/x' && activityDetail({ path: 'lib/x.js' }) === 'lib/x.js')
  check('detail: flattened and clipped at 60',
    activityDetail({ command: 'run ' + 'a'.repeat(80) + '\nnext' }) === 'run ' + 'a'.repeat(56) + '…')
  check('detail: non-strings and empty shapes give nothing',
    activityDetail({ file_path: 42 }) === undefined && activityDetail({}) === undefined && activityDetail('x') === undefined && activityDetail(undefined) === undefined)
}

// ── ② the fold over the real translator ───────────────────────────────────
{
  const translator = createClaudeTranslator({ cwd: '/fixture/project', userRows: 'lifecycle', now })
  const publisher = createClaudeActivityPublisher({ now })
  const published: WorkingActivityView[] = []
  publisher.subscribe(view => published.push(view))
  /** Feed one frame, then fold (exactly what session.ts does after a batch). */
  const feed = (frame: Rec, waiting = false): void => {
    translator.translate(frame)
    publisher.fold(translator.activityState(), waiting)
  }
  const lines = (): string[] => published.map(view => view.phase + '|' + view.line)

  // Before any turn: nothing published — the classic spinner keeps its slot.
  feed({ type: 'system', subtype: 'status', status: 'ready' })
  check('before the first turn nothing is published', published.length === 0, lines())

  // A user input the CLI starts opens the turn: thinking.
  translator.registerInput('u1', 'fix the login bug', 'turn')
  feed({ type: 'command_lifecycle', state: 'started', command_uuid: 'u1' })
  check('turn open publishes thinking with the turn anchor',
    published.length === 1 && published[0]!.phase === 'thinking' && published[0]!.line === claudeText('claude-activity-thinking') && published[0]!.turnStartedAt !== 0,
    lines())

  // The reply narrates: the ⏵ line becomes the line while it streams.
  feed({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1', model: 'fixture-model' } } })
  feed({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '⏵Fixing the login bug' } } })
  check('an unterminated narration line stays hidden (no half line)', published.length === 1, lines())
  feed({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '\nand the details follow' } } })
  check('a complete narration line takes the working line',
    published.at(-1)!.phase === 'thinking' && published.at(-1)!.line === '⏵Fixing the login bug' && published.at(-1)!.phrase === '⏵Fixing the login bug',
    lines())

  // The attempt settles: the narration survives it (the turn is the window).
  feed({ type: 'stream_event', event: { type: 'message_stop' } })
  check('the narration survives its attempt settling', published.at(-1)!.line === '⏵Fixing the login bug', lines())

  // A tool call: label + detail + the line names both.
  feed({ type: 'assistant', message: { id: 'msg_2', model: 'fixture-model', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/login.tsx' } }] } })
  const tool = published.at(-1)!
  check('a tool call takes the tool phase with label and detail',
    tool.phase === 'tool' && tool.label === 'Read' && tool.detail === 'src/login.tsx' && tool.line === 'Read src/login.tsx',
    lines())

  // Unchanged state: nothing new (a toolCount-only drift rides the next one).
  const before = published.length
  feed({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 12 })
  check('an unchanged state publishes nothing', published.length === before, lines())

  // The result settles: back to thinking, carrying toolCount.
  feed({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } })
  const afterResult = published.at(-1)!
  check('the settled result returns thinking and carries toolCount',
    afterResult.phase === 'thinking' && afterResult.toolCount === 1 && afterResult.line === '⏵Fixing the login bug',
    lines())

  // A tracked task's activeForm becomes the phrase once no narration is newer…
  feed({ type: 'assistant', message: { id: 'msg_3', model: 'fixture-model', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'TaskUpdate', input: { taskId: 'task-1', status: 'in_progress', activeForm: 'Rewriting the auth check' } }] } })
  feed({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }], tool_use_result: { success: true, taskId: 'task-1', updatedFields: ['status'] } } })
  // …but the turn's narration outranks it while the window (the turn) lives.
  check('the turn narration outranks activeForm while the turn lives', published.at(-1)!.line === '⏵Fixing the login bug', lines())

  // A parked permission prompt outranks everything: waiting.
  feed({ type: 'assistant', message: { id: 'msg_4', model: 'fixture-model', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_3', name: 'Bash', input: { command: 'rm -rf /tmp/x' } }] } }, true)
  const waiting = published.at(-1)!
  check('a parked prompt is the waiting phase with the pending tool named',
    waiting.phase === 'waiting' && waiting.line === claudeText('claude-activity-waiting') && waiting.label === 'Bash' && waiting.detail === 'rm -rf /tmp/x',
    lines())

  // Turn end: the done card, settled copy, the count kept.
  feed({ type: 'result', subtype: 'success', duration_api_ms: 1, usage: { input_tokens: 1, output_tokens: 1 } })
  const done = published.at(-1)!
  check('turn end parks on the done card',
    done.phase === 'done' && done.live === false && done.line === claudeText('claude-activity-done-tools', { count: 2 }) && done.toolCount === 2,
    lines())
  check('the done card is not republished while idle', (feed({ type: 'system', subtype: 'status', status: 'ready' }), published.length) === published.length || published.at(-1) === done, lines())

  // The next turn revives the line from done.
  translator.registerInput('u2', 'ship it', 'turn')
  feed({ type: 'command_lifecycle', state: 'started', command_uuid: 'u2' })
  check('the next turn revives from done', published.at(-1)!.phase === 'thinking' && published.at(-1)!.turnStartedAt > done.turnStartedAt, lines())
}

// ── ③ the activeForm phrase when the turn never narrated ──────────────────
{
  const translator = createClaudeTranslator({ cwd: '/fixture/project', userRows: 'lifecycle', now })
  const publisher = createClaudeActivityPublisher({ now })
  translator.translate({ type: 'system', subtype: 'status', status: 'requesting' })
  publisher.fold(translator.activityState(), false)
  // TaskCreate (result names the id) then TaskUpdate in_progress: the CLI's
  // own spinner wording is the closest thing to a DSH phrase we have.
  translator.translate({ type: 'assistant', message: { id: 'm1', model: 'f', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'TaskCreate', input: { subject: 'Chore', activeForm: 'Doing the chore' } }] } })
  publisher.fold(translator.activityState(), false)
  translator.translate({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, tool_use_result: { task: { id: 'task-9', subject: 'Chore' } } })
  publisher.fold(translator.activityState(), false)
  translator.translate({ type: 'assistant', message: { id: 'm2', model: 'f', role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'TaskUpdate', input: { taskId: 'task-9', status: 'in_progress' } }] } })
  publisher.fold(translator.activityState(), false)
  // While the update runs the line names it; once it settles (the task is
  // in_progress, no call open), the CLI's own spinner wording takes over.
  check('while the update runs the line names the tool', publisher.last()?.phase === 'tool' && publisher.last()?.label === 'TaskUpdate', publisher.last())
  translator.translate({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] }, tool_use_result: { success: true, taskId: 'task-9', updatedFields: ['status'] } })
  publisher.fold(translator.activityState(), false)
  const view = publisher.last()
  check('an in_progress task with no narration shows its activeForm',
    view !== undefined && view.phase === 'thinking' && view.line === 'Doing the chore' && view.phrase === 'Doing the chore',
    view)
}

// ── ④ session level: the capability publishes a real faked turn ───────────
{
  const fake = fakeClaudeSdk()
  const session = await openClaudeSession(claudeDeps(fake.sdk))
  const views: WorkingActivityView[] = []
  session.capabilities.workingActivity?.subscribe(view => views.push(view))
  const query = fake.queries[0]!
  await session.submit({ text: 'fix the login bug', clientMessageId: 'u1' }, 'turn')
  query.emit({ type: 'command_lifecycle', state: 'started', command_uuid: 'u1' })
  await settle()
  query.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1', model: 'fixture-model' } } })
  query.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '⏵Fixing the login bug\n' } } })
  query.emit({ type: 'stream_event', event: { type: 'message_stop' } })
  query.emit({ type: 'assistant', message: { id: 'msg_2', model: 'fixture-model', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/login.tsx' } }] } })
  await settle()
  query.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } })
  query.emit({ type: 'result', subtype: 'success', duration_api_ms: 1, usage: { input_tokens: 1, output_tokens: 1 } })
  await settle()
  const phases = views.map(view => view.phase)
  check('the session capability published the turn (thinking→tool→done)',
    phases.includes('thinking') && phases.includes('tool') && phases.at(-1) === 'done',
    views.map(view => view.phase + '|' + view.line))
  check('the narration and the tool detail both came through the session',
    views.some(view => view.line === '⏵Fixing the login bug') && views.some(view => view.detail === 'src/login.tsx'),
    views.map(view => view.line))
  // A late subscriber receives the latest value once on subscribe.
  const late: WorkingActivityView[] = []
  session.capabilities.workingActivity?.subscribe(view => late.push(view))
  check('a late subscriber immediately receives the latest value',
    late.length === 1 && late[0]!.phase === 'done',
    late.map(view => view.phase))
  await session.dispose()
}

console.log(`${passed} checks passed`)
