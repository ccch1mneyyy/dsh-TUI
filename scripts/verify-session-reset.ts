/** Focused reset regression for L4 session adoption. */
import assert from 'node:assert/strict'
import { resetSessionProjection } from '../src/dsh-adapter/channel/session-reset.js'

const rows = [{ id: 1 }] as never[]
const state = {
  rows,
  todos: [{ text: 'old' }],
  pending: [{ id: 'old' }],
  goal: { text: 'old' },
  sessionTitle: 'old',
  sessionColor: 'red',
  tokens: { input: 1 },
  responseChars: 1,
  activeToolCount: 1,
  lastUserText: 'old',
  working: true,
  cancelPending: true,
  spinnerMode: 'tool',
  tps: 1,
  tpsSamples: [1],
  lastUsage: { input: 1 },
  workingActivity: { line: 'old' },
  contextSegments: { system: 1 },
} as never
const rowIds = { value: 9 }
let projectorResets = 0
let subagentResets = 0
let jobResets = 0
resetSessionProjection(
  state,
  rowIds,
  () => { projectorResets += 1 },
  () => { subagentResets += 1 },
  () => { jobResets += 1 },
)
assert.equal(projectorResets, 1)
assert.equal(subagentResets, 1)
assert.equal(jobResets, 1)
assert.equal(rowIds.value, 0)
assert.equal(state.rows.length, 0)
assert.deepEqual(state.todos, [])
assert.deepEqual(state.pending, [])
assert.equal(state.goal, undefined)
assert.equal(state.working, false)
assert.equal(state.cancelPending, false)
assert.equal(state.spinnerMode, 'requesting')
assert.deepEqual(state.contextSegments, { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 })
console.log('verify:session-reset OK (common foreground adoption projection reset)')
