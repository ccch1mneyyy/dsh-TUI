/**
 * Herdr lifecycle integration regression.
 *
 * Run: node --import tsx/esm scripts/verify-herdr-integration.ts
 */

import assert from 'node:assert/strict'
import { attachHerdrIntegration } from '../src/herdr.js'
import { execFileNoThrow } from '../src/utils/execFileNoThrow.js'

class ObservableState {
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(): void {
    for (const listener of this.listeners) listener()
  }
}

class TestChannel extends ObservableState {
  agentId = 'session-1'
  working = false
}

class TestBlockingStore extends ObservableState {
  snapshot: object | null = null

  getSnapshot = (): object | null => this.snapshot
}

const channel = new TestChannel()
const questions = new TestBlockingStore()
const approvals = new TestBlockingStore()
const calls: Array<{ file: string; args: readonly string[] }> = []

const integration = attachHerdrIntegration({
  channel,
  questions,
  approvals,
  env: {
    HERDR_ENV: '1',
    HERDR_BIN_PATH: 'C:\\Tools\\herdr.exe',
    HERDR_PANE_ID: 'w1:p2',
  },
  run: async (file, args) => {
    calls.push({ file, args })
    return { code: 0, stdout: '', stderr: '' }
  },
})

assert.ok(integration, 'Herdr environment should enable the integration')
await integration.settled()
assert.deepEqual(calls, [{
  file: 'C:\\Tools\\herdr.exe',
  args: [
    'pane', 'report-agent', 'w1:p2',
    '--source', 'custom:dsh-tui',
    '--agent', 'dsh-tui',
    '--state', 'idle',
    '--seq', '1',
  ],
}])

channel.working = true
channel.emit()
await integration.settled()
assert.equal(calls.length, 2)
assert.deepEqual(calls[1]?.args, [
  'pane', 'report-agent', 'w1:p2',
  '--source', 'custom:dsh-tui',
  '--agent', 'dsh-tui',
  '--state', 'working',
  '--seq', '2',
])

questions.snapshot = { key: 'question-1' }
questions.emit()
await integration.settled()
assert.deepEqual(calls[2]?.args, [
  'pane', 'report-agent', 'w1:p2',
  '--source', 'custom:dsh-tui',
  '--agent', 'dsh-tui',
  '--state', 'blocked',
  '--message', 'Waiting for user input',
  '--seq', '3',
])

approvals.snapshot = { key: 'approval-1' }
approvals.emit()
channel.emit()
await integration.settled()
assert.equal(calls.length, 3, 'unchanged blocked state must not spawn duplicate reports')

channel.agentId = 'session-2'
channel.emit()
await integration.settled()
assert.equal(calls.length, 3, 'custom integrations must not claim native session identity')

questions.snapshot = null
questions.emit()
await integration.settled()
assert.equal(calls.length, 3, 'approval keeps the agent blocked after the question closes')

approvals.snapshot = null
approvals.emit()
await integration.settled()
assert.equal(calls[3]?.args.at(8), 'working')

channel.working = false
channel.emit()
await integration.settled()
assert.equal(calls[4]?.args.at(8), 'idle')

await integration.dispose()
assert.deepEqual(calls[5]?.args, [
  'pane', 'release-agent', 'w1:p2',
  '--source', 'custom:dsh-tui',
  '--agent', 'dsh-tui',
  '--seq', '6',
])
await integration.dispose()
assert.equal(calls.length, 6, 'dispose must be idempotent')

for (const env of [
  {},
  { HERDR_ENV: '0', HERDR_BIN_PATH: 'herdr', HERDR_PANE_ID: 'w1:p2' },
  { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p2' },
  { HERDR_ENV: '1', HERDR_BIN_PATH: 'herdr' },
]) {
  assert.equal(attachHerdrIntegration({
    channel: new TestChannel(),
    questions: new TestBlockingStore(),
    approvals: new TestBlockingStore(),
    env,
    run: async () => {
      throw new Error('disabled integration must not run Herdr')
    },
  }), undefined)
}

if (process.env.DSH_TUI_HERDR_E2E === '1') {
  const executable = process.env.HERDR_BIN_PATH
  const paneId = process.env.HERDR_PANE_ID
  assert.ok(executable && paneId, 'real Herdr verification requires HERDR_BIN_PATH and HERDR_PANE_ID')

  const realChannel = new TestChannel()
  const realQuestions = new TestBlockingStore()
  const realApprovals = new TestBlockingStore()
  const real = attachHerdrIntegration({
    channel: realChannel,
    questions: realQuestions,
    approvals: realApprovals,
  })
  assert.ok(real, 'real Herdr environment should enable the integration')

  const expectRealState = async (state: 'idle' | 'working' | 'blocked'): Promise<void> => {
    await real.settled()
    const result = await execFileNoThrow(executable, ['agent', 'get', paneId], { timeout: 2000 })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, new RegExp(`"agent":"dsh-tui".*"agent_status":"${state}"`))
  }

  await expectRealState('idle')
  realChannel.working = true
  realChannel.emit()
  await expectRealState('working')
  realQuestions.snapshot = { key: 'real-question' }
  realQuestions.emit()
  await expectRealState('blocked')
  await real.dispose()

  const released = await execFileNoThrow(executable, ['agent', 'get', paneId], { timeout: 2000 })
  assert.notEqual(released.code, 0, 'released custom agent must no longer resolve')
  console.log('verify-herdr-integration: real Herdr lifecycle passed')
} else {
  console.log('SKIP: real Herdr lifecycle (set DSH_TUI_HERDR_E2E=1 inside a Herdr pane)')
}

console.log('verify-herdr-integration: lifecycle, gating, and release passed')
