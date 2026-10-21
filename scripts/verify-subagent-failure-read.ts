/** Session/run-scoped unread failure regression. No backend calls. */
import assert from 'node:assert/strict'
import { createSubagentFailureReadStore, subagentFailureScope } from '../src/components/sidePanel/subagentFailureRead.js'
import type { SubagentState } from '../src/adapter/ports/channel-view.js'
import { deriveCompanionMood } from '../src/components/sidePanel/companion/mood.js'

const store = createSubagentFailureReadStore()
const scope = (backendId: string, sessionId: string): string => subagentFailureScope({ sessionRef: { backendId, sessionId }, sessionId })
const a = scope('dsh', 'parent-a')
const b = scope('dsh', 'parent-b')
const codex = scope('codex', 'parent-a')
const failed = (agentId: string, runId = 'run-1', completedAt = 20): SubagentState => ({
  agentId, runId, startedAt: 10, completedAt, status: 'failed', description: agentId,
  output: [], outputEvents: [], toolCalls: [], error: 'fixture failure',
})
const rows = [failed('child-a'), failed('child-b')]
let notifications = 0
const stop = store.subscribe(() => { notifications += 1 })
assert.equal(store.unread(a, rows).size, 2, 'cold restored failures begin unread')
store.acknowledge(a, rows[0]!)
assert.deepEqual([...store.unread(a, rows)], ['child-b'], 'reading A must not acknowledge B')
store.acknowledge(a, rows[0]!)
assert.equal(notifications, 1, 'repeated view effects are idempotent')
assert.equal(store.unread(b, rows).size, 2, 'another parent has independent acknowledgements')
assert.equal(store.unread(codex, rows).size, 2, 'same session id on another backend is independent')
assert.equal(store.unread(a, [failed('child-a', 'run-2')]).size, 1, 'new run is unread')
assert.equal(store.unread(a, [failed('child-a', 'run-1', 30)]).size, 1, 'new failure revision is unread')
store.forgetRecovered(a, [{ ...rows[0]!, status: 'running' }])
assert.equal(store.unread(a, rows).size, 2, 'observed retry clears an old acknowledgement even with reused timing')
store.acknowledge(a, rows[0]!)
store.acknowledge(a, rows[1]!)
assert.equal(store.unread(a, rows).size, 0, 'panel remount reads the same shared store')
assert.equal(rows[0]!.status, 'failed', 'acknowledgement never mutates task facts')
const inputs = {
  working: true, spinnerMode: 'tool-use' as const, activity: undefined, celebration: undefined,
  attention: { approvalPending: false, questionPending: false },
  failures: { failedJobsUnread: 0, failedSubagents: store.unread(a, rows).size },
  lastInputAt: 0, sleepAfterMs: 0,
}
assert.notEqual(deriveCompanionMood(inputs, 100).mood, 'error', 'read failures no longer hold the companion in error')
assert.equal(deriveCompanionMood({ ...inputs, failures: { failedJobsUnread: 0, failedSubagents: 1 } }, 100).mood, 'error')
assert.equal(deriveCompanionMood({ ...inputs, attention: { approvalPending: true, questionPending: false }, failures: { failedJobsUnread: 0, failedSubagents: 1 } }, 100).mood, 'attention', 'approval keeps priority')
stop()
store.acknowledge(b, rows[0]!)
assert.equal(notifications, 4, 'unsubscribe removes the listener')
console.log('verify-subagent-failure-read OK')
