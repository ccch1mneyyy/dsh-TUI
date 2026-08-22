import assert from 'node:assert/strict'
import { apply } from '../presets/liangshen/instruction-hint.mjs'

const makeCtx = () => {
  const listeners = {}
  const ctx = {
    on(event, callback) {
      listeners[event] = callback
    },
    get(name) {
      if (name !== 'fs') return undefined
      return {
        async resolve(path) {
          return path
        },
        async stat(path) {
          return path.endsWith('AGENTS.md') ? { type: 'file' } : undefined
        },
      }
    },
    logger: { warn() {} },
  }
  apply(ctx, { promoteOn: 'tool-call' })
  return listeners
}

const next = async () => ({ messages: [] })
const promoted = { type: 'tool/call', seq: 1, data: { name: 'bash' } }
const makeSession = events => ({
  id: 'session-123',
  events,
  header: { cwd: '/workspace/project' },
})

const firstProcess = makeCtx()
const firstDecision = await firstProcess['agent/pre-step'](
  { agent: { session: makeSession([promoted]) }, signal: undefined },
  next,
)
assert.equal(firstDecision.messages.length, 1)
assert.equal(firstDecision.messages[0].id, 'instruction-hint-session-123')

const durableHint = {
  type: 'user/message',
  seq: 2,
  data: firstDecision.messages[0],
}
const secondProcess = makeCtx()
const resumedDecision = await secondProcess['agent/pre-step'](
  { agent: { session: makeSession([promoted, durableHint]) }, signal: undefined },
  next,
)
assert.equal(resumedDecision.messages.length, 0)

console.log('instruction-hint dedupe verified (durable session scan)')
