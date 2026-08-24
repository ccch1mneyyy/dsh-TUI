import assert from 'node:assert/strict'
import { apply } from '../presets/liangshen/instruction-hint.mjs'

function createHarness() {
  const listeners = {}
  const files = new Map([
    ['/workspace/.git', { type: 'directory' }],
    ['/workspace/AGENTS.md', { type: 'file' }],
  ])
  const fs = {
    probes: 0,
    async resolve(path) {
      return path
    },
    async stat(path) {
      this.probes += 1
      return files.get(path)
    },
  }
  const warnings = []
  const ctx = {
    on(event, callback) {
      listeners[event] = callback
    },
    get(service) {
      assert.equal(service, 'fs')
      return fs
    },
    logger: { warn: message => warnings.push(message) },
  }

  apply(ctx, { promoteOn: 'tool-call', includeSubagents: true })

  return {
    fs,
    warnings,
    async preStep(session) {
      return listeners['agent/pre-step'](
        { agent: { session }, signal: undefined },
        async () => ({ kind: 'enter', messages: [] }),
      )
    },
  }
}

const promoted = {
  id: 'promoted',
  header: { cwd: '/workspace/project' },
  events: [{ type: 'tool/call', seq: 1, data: { name: 'bash' } }],
}
const first = createHarness()
const firstDecision = await first.preStep(promoted)
assert.equal(firstDecision.messages.length, 1)
assert.equal(firstDecision.messages[0].id, 'instruction-hint-promoted')
assert.equal(firstDecision.messages[0].source.kind, 'instruction-hint')

const resumed = createHarness()
const resumedDecision = await resumed.preStep({
  ...promoted,
  events: [
    ...promoted.events,
    { type: 'user/message', seq: 2, data: firstDecision.messages[0] },
  ],
})
assert.equal(resumedDecision.messages.length, 0)
assert.equal(resumed.fs.probes, 0)

const unrelated = createHarness()
const unrelatedDecision = await unrelated.preStep({
  id: 'unrelated',
  header: { cwd: '/workspace/project' },
  events: [
    { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [] } },
    { type: 'tool/call', seq: 2, data: { name: 'bash' } },
  ],
})
assert.equal(unrelatedDecision.messages.length, 1)
assert.equal(unrelatedDecision.messages[0].id, 'instruction-hint-unrelated')

const reentry = createHarness()
assert.equal((await reentry.preStep({ ...promoted, id: 'reentry' })).messages.length, 1)
const reentryProbes = reentry.fs.probes
assert.equal((await reentry.preStep({ ...promoted, id: 'reentry' })).messages.length, 0)
assert.equal(reentry.fs.probes, reentryProbes)

const failedScan = createHarness()
const events = {
  *[Symbol.iterator]() {
    yield { type: 'tool/call', seq: 1, data: { name: 'bash' } }
  },
  some() {
    throw new Error('durable scan failed')
  },
}
assert.equal((await failedScan.preStep({ ...promoted, id: 'failed-scan', events })).messages.length, 0)
assert.equal((await failedScan.preStep({ ...promoted, id: 'failed-scan', events })).messages.length, 0)
assert.equal(failedScan.fs.probes, 0)
assert.equal(failedScan.warnings.length, 1)

assert.deepEqual(first.warnings, [])
assert.deepEqual(resumed.warnings, [])
assert.deepEqual(unrelated.warnings, [])
assert.deepEqual(reentry.warnings, [])

console.log('liangshen instruction hint verified (promotion, durable resume, unrelated messages, re-entry, scan failure)')
