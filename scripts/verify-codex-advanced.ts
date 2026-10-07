/** Codex C4 goals/tasks over a scripted hub and a manual clock. No I/O. */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import type { AgentEvent } from '../src/agent/events.js'
import { createCodexGoals, codexGoalEvent } from '../src/backends/codex/session/goals.js'
import { createCodexTasks, CODEX_TASK_OUTPUT_BYTES, CODEX_TASK_POLL_MS } from '../src/backends/codex/session/tasks.js'
import { CLIENT, NOTIFY } from '../src/backends/codex/protocol/index.js'
import { CodexRpcError } from '../src/backends/codex/rpc/client.js'
import { setLang, t } from '../src/i18n.js'
import { manualClock } from './lib/claude-fake-sdk.js'

setLang('en')
type Rec = Record<string, unknown>
let passed = 0
const check = (label: string, ok: unknown): void => { assert.ok(ok, label); passed += 1; console.log('PASS ' + label) }
const root = 'parent'
const goal = { threadId: root, objective: 'Finish the task', status: 'active', tokenBudget: 5000, tokensUsed: 12, timeUsedSeconds: 3, createdAt: 1, updatedAt: 2 }
const requests: { method: string; params: Rec }[] = []
const events: AgentEvent[] = []
const hub = {
  async call<R = unknown>(method: string, params: unknown = {}): Promise<R> {
    const input = params as Rec
    requests.push({ method, params: input })
    if (method === CLIENT.threadGoalGet) return { goal } as R
    if (method === CLIENT.threadGoalSet) { Object.assign(goal, input, { updatedAt: goal.updatedAt + 1 }); return { goal } as R }
    if (method === CLIENT.threadGoalClear) return { cleared: true } as R
    throw new Error('unexpected method ' + method)
  },
}
const goals = createCodexGoals({ hub, threadId: () => root, emit: batch => events.push(...batch) })
await goals.initialize()
const initial = events[0]
check('initial goal uses the native get call and token/time budget', requests[0]?.method === CLIENT.threadGoalGet && initial?.type === 'goal.change' && initial.goal?.budget?.tokensUsed === 12 && initial.goal.budget.timeUsedSeconds === 3)
await goals.capability.set('New objective', { tokenBudget: 50 })
check('set sends the objective/budget and publishes the server acknowledgement', requests.at(-1)?.params.objective === 'New objective' && requests.at(-1)?.params.tokenBudget === 50 && events.at(-1)?.type === 'goal.change')
await goals.capability.pause()
check('pause changes only status, retaining the native objective', requests.at(-1)?.params.status === 'paused' && !('objective' in requests.at(-1)!.params))
await goals.capability.resume()
check('resume sets active', requests.at(-1)?.params.status === 'active')
for (const status of ['blocked', 'usageLimited', 'budgetLimited']) {
  for (const lang of ['en', 'zh'] as const) {
    setLang(lang)
    const mapped = codexGoalEvent({ ...goal, status, tokenBudget: null })!
    check('native ' + status + ' is localized as blocked (' + lang + ')', mapped.goal?.phase === 'blocked' && mapped.goal.blockedReason?.code === status && mapped.goal.blockedReason.message !== '' && mapped.goal.budget?.tokenBudget === null)
  }
}
setLang('en')
const prior = events.length
goals.notification(NOTIFY.threadGoalUpdated, { threadId: 'foreign', goal })
check('a foreign goal does not replace the parent goal', events.length === prior)
await goals.capability.clear()
check('clear reports a clear fact', events.at(-1)?.type === 'goal.change' && (events.at(-1) as Extract<AgentEvent, { type: 'goal.change' }>).operation === 'clear')
goals.close()

const clock = manualClock()
const taskEvents: AgentEvent[] = []
const taskRequests: { method: string; params: Rec }[] = []
let inventory: Rec[] = []
let failure: Error | undefined
const taskHub = {
  async call<R = unknown>(method: string, params: unknown = {}): Promise<R> {
    taskRequests.push({ method, params: params as Rec })
    if (failure !== undefined) throw failure
    if (method === CLIENT.backgroundTerminalsList) return { data: inventory, nextCursor: null } as R
    if (method === CLIENT.backgroundTerminalsTerminate) { inventory = inventory.filter(item => item.processId !== (params as Rec).processId); return { terminated: true } as R }
    throw new Error('unexpected method ' + method)
  },
}
const tasks = createCodexTasks({ hub: taskHub, threadId: () => root, clock: clock.clock, now: () => 1, emit: batch => taskEvents.push(...batch) })
await tasks.initialize()
const idleCalls = taskRequests.length
clock.advance(30_000)
check('empty inventory creates no perpetual idle timer', taskRequests.length === idleCalls && tasks.capability !== undefined && tasks.capability.readOutput === undefined)
inventory = [{ itemId: 'command', processId: 'process', command: 'sleep 5', cwd: '/TMP/cwd', osPid: 1, cpuPercent: 0, rssKb: 0 }]
tasks.notification(NOTIFY.itemCompleted, { threadId: root, item: { type: 'commandExecution', id: 'command', processId: 'process', command: 'sleep 5', aggregatedOutput: 'early output' } })
tasks.notification(NOTIFY.turnCompleted, { threadId: root })
await tasks.refresh()
const start = taskEvents.find(event => event.type === 'task.start')
check('a real inventory entry starts a background shell task', start?.type === 'task.start' && start.taskId === 'process' && start.callId === 'command' && start.background)
check('observed early output is readable after task discovery', await tasks.capability!.readOutput!('process') === 'early output')
const pollingCalls = taskRequests.length
clock.advance(CODEX_TASK_POLL_MS)
await tasks.refresh()
check('nonempty inventory polls at the declared two-second cadence', taskRequests.length === pollingCalls + 1)
const beforeOutput = taskEvents.length
for (let index = 0; index < 50; index += 1) tasks.notification(NOTIFY.commandOutputDelta, { threadId: root, itemId: 'command', delta: '.' })
check('task deltas do not emit per-token renderer wakes', taskEvents.length === beforeOutput)
clock.advance(100)
check('task deltas coalesce into one 100ms output event', taskEvents.length === beforeOutput + 1 && taskEvents.at(-1)?.type === 'task.output')
tasks.notification(NOTIFY.commandOutputDelta, { threadId: root, itemId: 'command', delta: '中'.repeat(30_000) + 'tail' })
const output = await tasks.capability!.readOutput!('process')
check('output stays within 64KiB with intact UTF-8 code points', Buffer.byteLength(output) <= CODEX_TASK_OUTPUT_BYTES && output.endsWith('tail') && !output.includes('\uFFFD'))
failure = new CodexRpcError('temporary timeout', -32000)
const beforeFailure = taskEvents.length
await tasks.refresh()
check('a transient inventory failure does not fabricate task exit', tasks.capability !== undefined && !taskEvents.slice(beforeFailure).some(event => event.type === 'task.end'))
failure = undefined
check('unknown tasks cannot terminate another process', await tasks.capability!.stop('foreign') === false)
check('stop calls native terminate and confirms disappearance as stopped', await tasks.capability!.stop('process') && taskRequests.some(request => request.method === CLIENT.backgroundTerminalsTerminate && request.params.processId === 'process') && taskEvents.some(event => event.type === 'task.end' && event.status === 'stopped'))
const stoppedCalls = taskRequests.length
clock.advance(20_000)
check('the last terminal exit stops idle polling', taskRequests.length === stoppedCalls)
inventory = [{ itemId: 'another', processId: 'natural', command: 'echo ready' }]
await tasks.refresh()
inventory = []
await tasks.refresh()
const ended = taskEvents.find(event => event.type === 'task.end' && event.taskId === 'natural')
check('inventory disappearance reports unknown exit status, never a fake code', ended?.type === 'task.end' && ended.summary === t('codex-terminal-ended') && !('exitCode' in ended))
tasks.close()
const closedCalls = taskRequests.length
clock.advance(20_000)
check('close releases polling and the capability', taskRequests.length === closedCalls && tasks.capability === undefined)

for (const code of [-32601, -32602]) {
  const notices: AgentEvent[] = []
  let calls = 0
  const unavailable = createCodexTasks({ hub: { call: async () => { calls += 1; throw new CodexRpcError('unsupported', code) } }, threadId: () => root, clock: manualClock().clock, emit: batch => notices.push(...batch) })
  await unavailable.initialize()
  await unavailable.refresh()
  check('true unsupported ' + code + ' disables capability with one notice', unavailable.capability === undefined && calls === 1 && notices.filter(event => event.type === 'notice').length === 1)
  unavailable.close()
}
for (const code of [-32601, -32602, -32000]) {
  let attempts = 0
  const notices: AgentEvent[] = []
  const goals = createCodexGoals({ hub: { call: async () => { attempts += 1; throw new CodexRpcError('fixture unavailable', code) } }, threadId: () => root, emit: batch => notices.push(...batch) })
  await goals.initialize()
  await goals.initialize()
  check('initial goal ' + code + ' does not prevent boot and only true unsupported removes capability', code === -32000 ? goals.capability !== undefined && attempts === 2 && notices.length === 0 : goals.capability === undefined && attempts === 1 && notices.length === 1)
  goals.close()
}
console.log('\nverify-codex-advanced OK (' + passed + ' checks)')
