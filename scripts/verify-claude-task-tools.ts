/**
 * Claude Task* family → the shared todo panel (CLI 2.1.284: TaskCreate /
 * TaskUpdate / TaskList / TaskGet replaced TodoWrite for plan tracking; both
 * families are shouldDefer tools the preset does not list). Offline synthetic
 * SDK frames through the real translator + the ONE shared projector — no CLI,
 * no network, no credentials:
 *
 *  - role: the four Task* tools are 'todo' (never a card — suppressed call
 *    presentation, no result view, no tool row), while 'Task' (the subagent)
 *    and 'TaskStop' (a background task) keep their own roles;
 *  - state machine: TaskCreate's input names the content, its result the id;
 *    TaskUpdate's input patches in place ('deleted' removes); TaskList /
 *    TaskGet results are authoritative and overwrite local state; every
 *    change emits one full 'todo.write' snapshot in TodoPanelItem shape
 *    (content/status only, creation order, 'deleted' simply absent);
 *  - a FAILED TaskUpdate (is_error or the in-contract success:false) rolls
 *    the task's view back to its CONFIRMED base — seeds / create / get /
 *    list results / patches whose results came back successful — with the
 *    still-pending patches re-applied: a failure can neither hide behind a
 *    newer success nor resurrect a confirmed delete (RV follow-up), and the
 *    suppressed-card path lets a failure card through so the user sees the
 *    task change never happened;
 *  - resume: the replay's tracked tasks hand over to the live translator
 *    (serializable seeds), and a successful update of an untracked id
 *    completes the table from its own patch (R2/R6 reviews);
 *  - TodoWrite itself stays byte-identical (its own snapshot from its own
 *    input; activeForm still dropped) and replaces the panel view wholesale;
 *  - buildQueryOptions: allowedTools adds + pre-approves the family while
 *    'tools' stays the claude_code preset (never an explicit replacement),
 *    OPTION_POLICY.allowedTools is 'set'.
 *
 * Run: node --import tsx/esm scripts/verify-claude-task-tools.ts
 */
import assert from 'node:assert/strict'
import type { AgentEvent } from '../src/agent/events.js'
import { claudeToolRole } from '../src/backends/claude/tools.js'
import { createClaudeTranslator } from '../src/backends/claude/translate.js'
import { replayClaudeTranscript } from '../src/backends/claude/replay.js'
import { buildQueryOptions, OPTION_POLICY } from '../src/backends/claude/options.js'
import { setLang, t } from '../src/i18n.js'
import { createProjectorHarness } from './lib/projector-harness.js'

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

/** One scenario: fresh translator + projector, synthetic frames fed in order. */
function scenario(build: (f: ReturnType<typeof frames>) => Rec[]): { events: AgentEvent[]; harness: ReturnType<typeof createProjectorHarness> } {
  const translator = createClaudeTranslator({ cwd: '/fixture/project', userRows: 'lifecycle', now })
  const harness = createProjectorHarness({ model: '', activity: true, now })
  const events: AgentEvent[] = []
  for (const frame of build(frames())) events.push(...translator.translate(frame))
  harness.apply(events)
  harness.projector.settleStreaming()
  return { events, harness }
}

/** Fresh frame builders so every scenario's call ids start from 1. */
function frames() {
  let messageId = 0
  let callId = 0
  /** An assistant message whose only block is one tool_use. */
  const call = (name: string, input: Rec): Rec => ({
    type: 'assistant',
    message: { id: 'msg_' + ++messageId, model: 'fixture-model', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_' + ++callId, name, input }] },
  })
  /** The tool_result of the Nth call (1-based), with the message-level
   * structured result the CLI attaches to a single-result message. */
  const resultOf = (n: number, structured: Rec | undefined, isError = false): Rec => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_' + n, content: 'ok', ...(isError ? { is_error: true } : {}) }] },
    ...(structured === undefined ? {} : { tool_use_result: structured }),
  })
  const turnEnd = (): Rec => ({ type: 'result', subtype: 'success', duration_api_ms: 1, usage: { input_tokens: 1, output_tokens: 1 } })
  return { call, resultOf, turnEnd }
}

const todosOf = (events: readonly AgentEvent[]): readonly AgentEvent[] => events.filter(event => event.type === 'todo.write')
const items = (event: AgentEvent | undefined): { content: string; status: string }[] =>
  event !== undefined && event.type === 'todo.write' ? event.items.map(item => ({ content: item.content, status: item.status })) : []
const same = (actual: unknown, expected: unknown): boolean => JSON.stringify(actual) === JSON.stringify(expected)

// ── ⑥ role boundaries (checked first: everything below depends on them) ──
{
  check('role: the Task* family renders through the todo panel', ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite'].every(name => claudeToolRole(name) === 'todo'))
  check("role: 'Task' is still the subagent delegation", claudeToolRole('Task') === 'subagent')
  check("role: 'TaskStop' is still an ordinary card", claudeToolRole('TaskStop') === 'card')
}

// ── ① create ×2 → update(completed): snapshot order and statuses ─────────
const first = scenario(f => [
  f.call('TaskCreate', { subject: 'First chore', description: 'Do the first thing', activeForm: 'Doing the first thing' }),
  f.resultOf(1, { task: { id: 'task-1', subject: 'First chore' } }),
  f.call('TaskCreate', { subject: 'Second chore', description: 'Do the second thing' }),
  f.resultOf(2, { task: { id: 'task-2', subject: 'Second chore' } }),
  f.call('TaskUpdate', { taskId: 'task-1', status: 'completed' }),
  f.resultOf(3, { success: true, taskId: 'task-1', updatedFields: ['status'] }),
  f.turnEnd(),
])
{
  const writes = todosOf(first.events)
  check('create×2 + update: exactly three snapshots, none before the first id', writes.length === 3, writes.map(event => items(event)))
  check('create: the input names the content, the result the id — pending, creation order',
    same(items(writes[0]), [{ content: 'First chore', status: 'pending' }]) && same(items(writes[1]), [{ content: 'First chore', status: 'pending' }, { content: 'Second chore', status: 'pending' }]),
    writes.map(event => items(event)))
  check('update: the input patches status in place, order untouched',
    same(items(writes[2]), [{ content: 'First chore', status: 'completed' }, { content: 'Second chore', status: 'pending' }]), items(writes[2]))
  check('panel state adopts the last snapshot',
    same(first.harness.state.todos, [{ content: 'First chore', status: 'completed' }, { content: 'Second chore', status: 'pending' }]), first.harness.state.todos)
  check('never a card: no tool rows, every call suppressed as todo',
    first.harness.state.rows.every(row => row.kind !== 'tool') && first.events.every(event => event.type !== 'tool.call' || event.presentation?.card === 'todo'),
    first.harness.state.rows.map(row => row.kind))
  check('an errored create tracks nothing', scenario(f => [
    f.call('TaskCreate', { subject: 'Lost chore', description: 'never lands' }),
    f.resultOf(1, undefined, true),
    f.turnEnd(),
  ]).events.every(event => event.type !== 'todo.write'))
}

// ── ② update(deleted): the task disappears from the snapshot ─────────────
const deleted = scenario(f => [
  f.call('TaskCreate', { subject: 'Keep', description: 'stays' }),
  f.resultOf(1, { task: { id: 'task-1', subject: 'Keep' } }),
  f.call('TaskCreate', { subject: 'Drop', description: 'goes away' }),
  f.resultOf(2, { task: { id: 'task-2', subject: 'Drop' } }),
  f.call('TaskUpdate', { taskId: 'task-2', status: 'deleted' }),
  f.resultOf(3, { success: true, taskId: 'task-2', updatedFields: ['status'] }),
  f.turnEnd(),
])
{
  const last = items(todosOf(deleted.events).at(-1))
  check('deleted: gone from the snapshot, the survivor keeps its place', same(last, [{ content: 'Keep', status: 'pending' }]), last)
  check('deleted: the panel state cleared it too', same(deleted.harness.state.todos, [{ content: 'Keep', status: 'pending' }]), deleted.harness.state.todos)
  const unknown = scenario(f => [
    f.call('TaskUpdate', { taskId: 'never-created', status: 'completed' }),
    f.resultOf(1, { success: false, taskId: 'never-created', updatedFields: [], error: 'not found' }),
    f.turnEnd(),
  ])
  check('update of an unknown id: no snapshot (nothing applied)', unknown.events.every(event => event.type !== 'todo.write'))
}


// ── ③ TaskList / TaskGet results are authoritative ───────────────────────
const synced = scenario(f => [
  f.call('TaskCreate', { subject: 'Local A', description: 'a' }),
  f.resultOf(1, { task: { id: 'a', subject: 'Local A' } }),
  f.call('TaskCreate', { subject: 'Local B', description: 'b' }),
  f.resultOf(2, { task: { id: 'b', subject: 'Local B' } }),
  // Local says B in_progress; the list disagrees and adds an unknown task c.
  f.call('TaskUpdate', { taskId: 'b', status: 'in_progress' }),
  f.resultOf(3, { success: true, taskId: 'b', updatedFields: ['status'] }),
  f.call('TaskList', {}),
  f.resultOf(4, { tasks: [
    { id: 'a', subject: 'Local A', status: 'pending', blockedBy: [] },
    { id: 'c', subject: 'Fresh C', status: 'in_progress', blockedBy: [] },
  ] }),
  f.turnEnd(),
  // A single fetch renames and completes one entry.
  f.call('TaskGet', { taskId: 'c' }),
  f.resultOf(5, { task: { id: 'c', subject: 'Fresh C (done)', description: 'c', status: 'completed', blocks: [], blockedBy: [] } }),
  f.turnEnd(),
])
{
  const writes = todosOf(synced.events)
  const afterList = items(writes[3])
  check('TaskList result wins: b dropped, its status never applied, unknown c joins in result order',
    same(afterList, [{ content: 'Local A', status: 'pending' }, { content: 'Fresh C', status: 'in_progress' }]), afterList)
  check('TaskGet result wins: renamed and completed in place',
    same(items(writes.at(-1)), [{ content: 'Local A', status: 'pending' }, { content: 'Fresh C (done)', status: 'completed' }]), items(writes.at(-1)))
  check('sync: the panel state matches the authoritative view',
    same(synced.harness.state.todos, [{ content: 'Local A', status: 'pending' }, { content: 'Fresh C (done)', status: 'completed' }]), synced.harness.state.todos)
  const missing = scenario(f => [
    f.call('TaskCreate', { subject: 'Survivor', description: 'stays' }),
    f.resultOf(1, { task: { id: 's', subject: 'Survivor' } }),
    f.call('TaskList', {}),
    f.resultOf(2, undefined), // no structured result: nothing to sync on
    f.call('TaskGet', { taskId: 's' }),
    f.resultOf(3, { task: null }),
    f.turnEnd(),
  ])
  check('a result without records changes nothing (no structured / task:null)',
    same(items(todosOf(missing.events).at(-1)), [{ content: 'Survivor', status: 'pending' }]), items(todosOf(missing.events).at(-1)))
}

// ── ④ TodoWrite: the original path, byte-identical ───────────────────────
{
  const legacy = scenario(f => [
    f.call('TodoWrite', { todos: [
      { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
      { content: 'Ship it', status: 'pending' },
    ] }),
    f.resultOf(1, { todos: { count: 2 } }),
    f.turnEnd(),
  ])
  const writes = todosOf(legacy.events)
  check('TodoWrite: exactly one snapshot, straight from the input',
    writes.length === 1 && same(items(writes[0]), [{ content: 'Write tests', status: 'in_progress' }, { content: 'Ship it', status: 'pending' }]), writes.map(event => items(event)))
  check('TodoWrite: activeForm still dropped, panel adopts as-is',
    same(legacy.harness.state.todos, [{ content: 'Write tests', status: 'in_progress' }, { content: 'Ship it', status: 'pending' }])
      && writes[0] !== undefined && writes[0].type === 'todo.write' && writes[0].items.every(item => !('activeForm' in item)),
    legacy.harness.state.todos)
  const mixed = scenario(f => [
    f.call('TaskCreate', { subject: 'Task-family entry', description: 'x' }),
    f.resultOf(1, { task: { id: 't', subject: 'Task-family entry' } }),
    f.call('TodoWrite', { todos: [{ content: 'Legacy entry', status: 'completed' }] }),
    f.resultOf(2, { todos: { count: 1 } }),
    f.turnEnd(),
  ])
  const mixedWrites = todosOf(mixed.events)
  check('TodoWrite after a task snapshot: the whole-list write still wins the panel (last write wins)',
    same(items(mixedWrites.at(-1)), [{ content: 'Legacy entry', status: 'completed' }]) && same(mixed.harness.state.todos, [{ content: 'Legacy entry', status: 'completed' }]), mixed.harness.state.todos)
}

// ── ⑤ options: additive + pre-approved, the preset untouched ─────────────
{
  const options = buildQueryOptions({
    cwd: '/fixture/project',
    permissionMode: 'default',
    executable: undefined,
    env: {},
    canUseTool: () => Promise.resolve({ behavior: 'allow' }),
    stderr: () => undefined,
    abortController: new AbortController(),
    replayUserMessages: false,
    sessionId: 'fixture-session',
  })
  const family = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']
  const allowed = options.allowedTools ?? []
  check('options: allowedTools adds + pre-approves the whole family', family.every(name => allowed.includes(name)), allowed)
  check('options: tools stays the claude_code preset, never an explicit list',
    same(options.tools, { type: 'preset', preset: 'claude_code' }), options.tools)
  check('options: OPTION_POLICY says the profile sets allowedTools', OPTION_POLICY.allowedTools === 'set', OPTION_POLICY.allowedTools)
}

// ── ⑦ resume: the task table hands over (R2 review) ──────────────────────
{
  const at = (n: number): string => `2026-10-02T12:00:0${n}.000Z`
  /** A transcript chain whose Task* results carry the structured record (a
   *  raw transcript file) or do not (the SDK read API drops it). */
  const chain = (structured: boolean): Rec[] => [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'plan the chores' }, timestamp: at(0) },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'tool_use', id: 'c1', name: 'TaskCreate', input: { subject: 'Old chore', description: 'x', activeForm: 'Old form' } }] }, timestamp: at(1) },
    { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] }, ...(structured ? { tool_use_result: { task: { id: '1', subject: 'Old chore' } } } : {}), timestamp: at(2) },
    { type: 'assistant', uuid: 'a2', message: { id: 'm2', content: [{ type: 'tool_use', id: 'c2', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } }] }, timestamp: at(3) },
    { type: 'user', uuid: 'r2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c2', content: 'ok' }] }, ...(structured ? { tool_use_result: { success: true, taskId: '1', updatedFields: ['status'] } } : {}), timestamp: at(4) },
  ]
  /** The live translator of the resumed session, continuing one replay. */
  const liveSession = (replay: ReturnType<typeof replayClaudeTranscript>) => {
    const translator = createClaudeTranslator({
      cwd: '/fixture/project', userRows: 'lifecycle', now,
      start: { ...replay.start, ...(replay.tasks === undefined ? {} : { tasks: replay.tasks }) },
    })
    const events: AgentEvent[] = []
    for (const frame of [
      { type: 'assistant', message: { id: 'msg_1', model: 'fixture-model', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }, tool_use_result: { success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'in_progress', to: 'completed' } } },
    ] as Rec[]) events.push(...translator.translate(frame))
    return { events, translator }
  }

  // Rich raw transcript: the structured results survive, the replay tracks.
  const rich = replayClaudeTranscript(chain(true), { cwd: '/fixture/project' })
  check('resume: the replay hands the tracked tasks over as serializable seeds (id/subject/status/activeForm/seq)',
    JSON.stringify(rich.tasks) === JSON.stringify([{ id: '1', content: 'Old chore', status: 'in_progress', activeForm: 'Old form', seq: 1 }]), rich.tasks)
  const resumed = liveSession(rich)
  check('resume: a live update of a replayed id lands on the panel (not silently dropped)',
    same(items(todosOf(resumed.events).at(-1)), [{ content: 'Old chore', status: 'completed' }]), items(todosOf(resumed.events).at(-1)))
  const otherSession = createClaudeTranslator({
    cwd: '/fixture/project', userRows: 'lifecycle', now,
    start: { ...rich.start, ...(rich.tasks === undefined ? {} : { tasks: rich.tasks }) },
  })
  check('resume: seeds are per-session copies — completing one session leaves the other untouched',
    resumed.translator.taskSeeds()[0]?.status === 'completed' && otherSession.taskSeeds()[0]?.status === 'in_progress',
    [resumed.translator.taskSeeds()[0]?.status, otherSession.taskSeeds()[0]?.status])

  // SDK shape: the read API dropped the structured records — the result
  // itself (non-error) is the explicit authority, so the history's own
  // successful updates complete the table from their named patches.
  const sdk = replayClaudeTranscript(chain(false), { cwd: '/fixture/project' })
  check('resume: an SDK-shaped history syncs explicitly from its successful updates (no guessed ids)',
    JSON.stringify(sdk.tasks) === JSON.stringify([{ id: '1', content: t('claude-task-unnamed', { id: '1' }), status: 'in_progress', seq: 1 }]), sdk.tasks)
  const filled = liveSession(sdk)
  const filledWrites = todosOf(filled.events)
  check('resume: a successful live update of an untracked id completes the table from its patch (honest fallback subject)',
    filledWrites.length === 1 && same(items(filledWrites[0]), [{ content: t('claude-task-unnamed', { id: '1' }), status: 'completed' }]),
    filledWrites.map(event => items(event)))

  // The completion stays explicit: a rename-only success (no status known)
  // and a failed update of an unknown id still create nothing.
  const quiet = scenario(f => [
    f.call('TaskUpdate', { taskId: '7', subject: 'Just a rename' }),
    f.resultOf(1, { success: true, taskId: '7', updatedFields: ['subject'] }),
    f.call('TaskUpdate', { taskId: '8', status: 'completed' }),
    f.resultOf(2, { success: false, taskId: '8', updatedFields: [], error: 'no such task' }),
    f.turnEnd(),
  ])
  check('completion: only a status-bearing success of a named unknown id completes the table',
    quiet.events.every(event => event.type !== 'todo.write'), quiet.events.filter(event => event.type === 'todo.write').map(event => items(event)))
}

// ── ⑧ a failed TaskUpdate rolls its patch back and says so (R6 review) ───
{
  const failureCards = (h: ReturnType<typeof createProjectorHarness>) =>
    h.state.rows.filter(row => row.kind === 'tool' && row.tool?.name === 'TaskUpdate' && row.tool?.status === 'error')

  // A failed delete of a known id: the task returns, the failure card shows.
  const failedDelete = scenario(f => [
    f.call('TaskCreate', { subject: 'Keep', description: 'stays' }),
    f.resultOf(1, { task: { id: 'task-1', subject: 'Keep' } }),
    f.call('TaskCreate', { subject: 'Drop', description: 'goes away' }),
    f.resultOf(2, { task: { id: 'task-2', subject: 'Drop' } }),
    f.call('TaskUpdate', { taskId: 'task-2', status: 'deleted' }),
    f.resultOf(3, undefined, true),
    f.turnEnd(),
  ])
  check('failed delete: the task returns to the panel (the CLI did not drop it)',
    same(failedDelete.harness.state.todos, [{ content: 'Keep', status: 'pending' }, { content: 'Drop', status: 'pending' }]), failedDelete.harness.state.todos)
  check('… the rollback re-emitted a snapshot after the optimistic one', todosOf(failedDelete.events).length === 4, todosOf(failedDelete.events).length)
  check('… the suppressed-card path still renders the failure card (the user sees why)',
    failureCards(failedDelete.harness).length === 1 && failureCards(failedDelete.harness)[0]?.tool?.errorText === 'ok', failureCards(failedDelete.harness).map(card => card.tool))

  // A failed complete and a failed rename (success:false without is_error).
  const refused = scenario(f => [
    f.call('TaskCreate', { subject: 'Chore', description: 'x', activeForm: 'Doing the chore' }),
    f.resultOf(1, { task: { id: 't', subject: 'Chore' } }),
    f.call('TaskUpdate', { taskId: 't', status: 'completed' }),
    f.resultOf(2, { success: false, taskId: 't', updatedFields: [], error: 'not while blocked' }),
    f.call('TaskUpdate', { taskId: 't', subject: 'Wrong name' }),
    f.resultOf(3, { success: false, taskId: 't', updatedFields: ['subject'], error: 'read-only' }),
    f.turnEnd(),
  ])
  check('success:false without is_error: the status and the subject both roll back',
    same(refused.harness.state.todos, [{ content: 'Chore', status: 'pending' }]), refused.harness.state.todos)
  check('… and both failures surface as error cards', failureCards(refused.harness).length === 2, failureCards(refused.harness).length)

  // Parallel updates of one task, results out of order: the newer SUCCESS
  // stands (its rename commits into the confirmed base); the older FAILED
  // completion rolls back to that base — it must NOT survive by hiding
  // behind the newer write (RV review: the old whole-record guard turned
  // this into a false lock expecting completed).
  const outOfOrder = scenario(f => [
    f.call('TaskCreate', { subject: 'A', description: 'x' }),
    f.resultOf(1, { task: { id: 'a', subject: 'A' } }),
    f.call('TaskUpdate', { taskId: 'a', status: 'completed' }),
    f.call('TaskUpdate', { taskId: 'a', subject: 'Renamed' }),
    f.resultOf(3, { success: true, taskId: 'a', updatedFields: ['subject'] }),
    f.resultOf(2, undefined, true),
    f.turnEnd(),
  ])
  check('out-of-order: the rename success commits, the failed completion still rolls back (Renamed/pending)',
    same(outOfOrder.harness.state.todos, [{ content: 'Renamed', status: 'pending' }]), outOfOrder.harness.state.todos)

  // Both fail, results in reverse order: the rollbacks stack to the original.
  const bothFailed = scenario(f => [
    f.call('TaskCreate', { subject: 'B', description: 'x' }),
    f.resultOf(1, { task: { id: 'b', subject: 'B' } }),
    f.call('TaskUpdate', { taskId: 'b', status: 'completed' }),
    f.call('TaskUpdate', { taskId: 'b', subject: 'Never' }),
    f.resultOf(3, undefined, true),
    f.resultOf(2, undefined, true),
    f.turnEnd(),
  ])
  check('both failed in reverse: stacked rollbacks reach the original state',
    same(bothFailed.harness.state.todos, [{ content: 'B', status: 'pending' }]), bothFailed.harness.state.todos)

  // RV form ②: both fail, results in EMISSION order — the first rollback
  // keeps the still-pending rename optimistic, the second drops it too.
  const bothFailedInOrder = scenario(f => [
    f.call('TaskCreate', { subject: 'B2', description: 'x' }),
    f.resultOf(1, { task: { id: 'b2', subject: 'B2' } }),
    f.call('TaskUpdate', { taskId: 'b2', status: 'completed' }),
    f.call('TaskUpdate', { taskId: 'b2', subject: 'Never' }),
    f.resultOf(2, undefined, true),
    f.resultOf(3, undefined, true),
    f.turnEnd(),
  ])
  check('both failed in emission order: the rollbacks still reach the original state',
    same(bothFailedInOrder.harness.state.todos, [{ content: 'B2', status: 'pending' }]), bothFailedInOrder.harness.state.todos)

  // RV form ③: a delete SUCCEEDS, then the older update fails — the task
  // stays deleted (no resurrection through the older failure's pre-image).
  const deletedThenFail = scenario(f => [
    f.call('TaskCreate', { subject: 'C2', description: 'x' }),
    f.resultOf(1, { task: { id: 'c2', subject: 'C2' } }),
    f.call('TaskUpdate', { taskId: 'c2', status: 'completed' }),
    f.call('TaskUpdate', { taskId: 'c2', status: 'deleted' }),
    f.resultOf(3, { success: true, taskId: 'c2', updatedFields: ['status'] }),
    f.resultOf(2, undefined, true),
    f.turnEnd(),
  ])
  check('delete success then older failure: the task stays deleted (no resurrection)',
    same(deletedThenFail.harness.state.todos, []), deletedThenFail.harness.state.todos)

  // RV follow-up 3 (ghost task): a List that superseded an update — the
  // update's LATE SUCCESS must not fabricate a task the list already
  // ruled away (the unknown-id completion path is for fresh facts, not
  // calls an authority discarded).
  const ghost = scenario(f => [
    f.call('TaskCreate', { subject: 'A', description: 'x' }),
    f.resultOf(1, { task: { id: 'a', subject: 'A' } }),
    f.call('TaskUpdate', { taskId: 'a', status: 'completed' }),
    f.call('TaskList', {}),
    f.resultOf(3, { tasks: [] }),
    f.resultOf(2, { success: true, taskId: 'a', updatedFields: ['status'] }),
    f.turnEnd(),
  ])
  check('late success of a superseded update fabricates nothing (the empty list stands)',
    same(ghost.harness.state.todos, []), ghost.harness.state.todos)

  // Superseding must not overreach: the list's own record stands, and a
  // FRESH update after it confirms on that record normally (only the
  // superseded call id is dropped, never the id itself).
  const rebuild = scenario(f => [
    f.call('TaskCreate', { subject: 'A', description: 'x' }),
    f.resultOf(1, { task: { id: 'a', subject: 'A' } }),
    f.call('TaskUpdate', { taskId: 'a', status: 'completed' }),
    f.call('TaskList', {}),
    f.resultOf(3, { tasks: [{ id: 'a', subject: 'A relaunched', status: 'in_progress', blockedBy: [] }] }),
    f.resultOf(2, { success: true, taskId: 'a', updatedFields: ['status'] }),
    f.call('TaskUpdate', { taskId: 'a', status: 'completed' }),
    f.resultOf(4, { success: true, taskId: 'a', updatedFields: ['status'] }),
    f.turnEnd(),
  ])
  check('superseded drops only the stale call: the list\'s record stands and a fresh update confirms on it',
    same(rebuild.harness.state.todos, [{ content: 'A relaunched', status: 'completed' }]), rebuild.harness.state.todos)
  // An authoritative List between the patch and its late failure: the List
  // wins; the stale failure neither reverts it nor resurrects a delete.
  const authoritative = scenario(f => [
    f.call('TaskCreate', { subject: 'C', description: 'x' }),
    f.resultOf(1, { task: { id: 'c', subject: 'C' } }),
    f.call('TaskUpdate', { taskId: 'c', status: 'completed' }),
    f.call('TaskList', {}),
    f.resultOf(3, { tasks: [{ id: 'c', subject: 'C', status: 'in_progress', blockedBy: [] }] }),
    f.resultOf(2, undefined, true),
    f.turnEnd(),
  ])
  check('authoritative List wins over the late failure (no rollback to the pre-image)',
    same(authoritative.harness.state.todos, [{ content: 'C', status: 'in_progress' }]), authoritative.harness.state.todos)
  const deletedSync = scenario(f => [
    f.call('TaskCreate', { subject: 'D', description: 'x' }),
    f.resultOf(1, { task: { id: 'd', subject: 'D' } }),
    f.call('TaskUpdate', { taskId: 'd', status: 'deleted' }),
    f.call('TaskList', {}),
    f.resultOf(3, { tasks: [] }),
    f.resultOf(2, undefined, true),
    f.turnEnd(),
  ])
  check('… a delete the List confirmed stays gone (the failure does not resurrect it)',
    same(deletedSync.harness.state.todos, []), deletedSync.harness.state.todos)

  // RV follow-up 4 (mixed family): a successful TodoWrite is the WHOLE-LIST
  // authority — the stale Task* view must go with its patches and bases,
  // or a later update of a stale id first repaints the panel from a stale
  // table and then empties it (the recompute finds no base).
  const legacyWins = scenario(f => [
    f.call('TaskCreate', { subject: 'Chore', description: 'x' }),
    f.resultOf(1, { task: { id: 't', subject: 'Chore' } }),
    f.call('TodoWrite', { todos: [{ content: 'Legacy entry', status: 'pending' }] }),
    f.resultOf(2, { todos: { count: 1 } }),
    f.call('TaskUpdate', { taskId: 't', subject: 'Chore done', status: 'completed' }),
    f.resultOf(3, { success: true, taskId: 't', updatedFields: ['subject', 'status'] }),
    f.turnEnd(),
  ])
  check('TodoWrite success clears the stale Task* view: the later update confirms on a clean table (no empty-panel glitch)',
    same(legacyWins.harness.state.todos, [{ content: 'Chore done', status: 'completed' }]), legacyWins.harness.state.todos)
  const legacyOnly = scenario(f => [
    f.call('TaskCreate', { subject: 'Chore', description: 'x' }),
    f.resultOf(1, { task: { id: 't', subject: 'Chore' } }),
    f.call('TodoWrite', { todos: [{ content: 'Legacy entry', status: 'pending' }] }),
    f.resultOf(2, { todos: { count: 1 } }),
    f.turnEnd(),
  ])
  check('… the legacy list owns the panel after its write',
    same(legacyOnly.harness.state.todos, [{ content: 'Legacy entry', status: 'pending' }]), legacyOnly.harness.state.todos)

  // Coexistence after the wipe: a fresh Task* family builds and confirms
  // normally (the last FULL write owns the panel, as ever).
  const coexist = scenario(f => [
    f.call('TodoWrite', { todos: [{ content: 'Legacy entry', status: 'pending' }] }),
    f.resultOf(1, { todos: { count: 1 } }),
    f.call('TaskCreate', { subject: 'Fresh', description: 'x' }),
    f.resultOf(2, { task: { id: 'new', subject: 'Fresh' } }),
    f.call('TaskUpdate', { taskId: 'new', status: 'completed' }),
    f.resultOf(3, { success: true, taskId: 'new', updatedFields: ['status'] }),
    f.turnEnd(),
  ])
  check('TodoWrite then fresh Task* work: create and update confirm normally (last full write wins)',
    same(coexist.harness.state.todos, [{ content: 'Fresh', status: 'completed' }]), coexist.harness.state.todos)}

console.log(passed + ' passed')