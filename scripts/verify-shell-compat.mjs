/**
 * Shell API compatibility (#974 / #983): legacy run and 0.1.7 execute/result().
 * Exercises both Channel consumers. Run after compile:
 *   node scripts/verify-shell-compat.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { settled } from './lib/term-test.mjs'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-shell-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = home
const { createChannel } = await import('../lib/types/dsh-adapter/channel.js')
const { runForegroundShell } = await import('../lib/types/dsh-adapter/compat/shell.js')

const output = (stdout = '', stderr = '', timedOut = false) => ({
  stdout: { text: stdout }, stderr: { text: stderr }, timedOut,
})
const request = { command: 'echo ok', workdir: home, timeoutMs: 30000 }

async function submitShell(channel, command, includeInContext) {
  const rowCount = channel.rows.length
  channel.submit(`${includeInContext ? '!!' : '!'}${command}`)
  assert.ok(await settled(() => channel.rows.length === rowCount + 2))
}

function channelFor(shell) {
  const messages = []
  const ctx = { on: () => () => {}, get: name => name === 'shell' ? shell : undefined, logger: { warn() {} } }
  const agent = {
    id: 'shell-agent', status: 'idle', session: { id: 'shell-session', seq: 0, events: [] },
    ctx: { on: () => () => {} }, followup: message => messages.push(message),
  }
  const channel = createChannel(ctx, agent, { cwd: home, model: 'deepseek-chat', provider: 'deepseek', activity: false })
  return { channel, messages }
}

try {
  for (const api of ['run', 'execute']) {
    const requests = []
    const specs = []
    let result = output(' main\n')
    const shell = {
      resolve(value) {
        assert.equal(this, shell)
        requests.push(value)
        const spec = { ...value, sandboxPolicy: { mode: 'workspace-write' } }
        specs.push(spec)
        return spec
      },
      async [api](spec) {
        assert.equal(this, shell)
        assert.equal(spec, specs.at(-1), 'pass the resolved policy-bearing spec unchanged')
        if (api === 'run') return result
        const execution = { async result() { assert.equal(this, execution); return result } }
        return execution
      },
    }
    const { channel, messages } = channelFor(shell)
    try {
      assert.ok(await settled(() => channel.gitBranch === 'main'), `${api}: boot resolves git branch`)
      assert.deepEqual(requests[0], { command: 'git branch --show-current', workdir: home, timeoutMs: 3000 })
      result = output(' ok\n')
      await submitShell(channel, request.command, true)
      assert.deepEqual(requests[1], request)
      assert.equal(channel.rows.at(-1).text, 'ok')
      assert.equal(messages[0].content[0].text, '<bash-stdout>\nok\n</bash-stdout>')
      result = output('', ' denied\n')
      await submitShell(channel, 'denied', false)
      assert.equal(channel.rows.at(-1).text, 'denied')
      result = output('', '', true)
      await submitShell(channel, 'slow', false)
      assert.equal(channel.rows.at(-1).text, '(timed out)')
      assert.equal(messages.length, 1, 'only explicit context inclusion sends a message')
    } finally { channel.releaseContributions() }
  }

  let legacyCalls = 0
  const failure = new Error('sandbox unavailable')
  const modern = {
    resolve: value => value,
    async execute() { return { async result() { throw failure } } },
    async run() { legacyCalls++; return output() },
  }
  await assert.rejects(runForegroundShell(modern, request), error => error === failure)
  assert.equal(legacyCalls, 0, 'an execution failure must never rerun through the old API')

  // A synchronous resolver failure must not escape best-effort startup.
  const broken = { resolve() { throw failure } }
  const { channel } = channelFor(broken)
  try {
    await submitShell(channel, 'failure', false)
    assert.equal(channel.rows.at(-1).text, failure.message)
    assert.equal(channel.gitBranch, undefined)
  } finally { channel.releaseContributions() }

  // Late shell output cannot mutate a released Channel or inject a followup.
  const { promise, resolve } = Promise.withResolvers()
  const started = []
  const completed = []
  const delayed = { resolve: value => value, async execute(spec) {
    return { async result() {
      started.push(spec.command)
      const result = await promise
      completed.push(spec.command)
      return result
    } }
  } }
  const stale = channelFor(delayed)
  stale.channel.submit('!!late')
  assert.ok(await settled(() => started.includes('late')), 'the submitted command must start before release')
  assert.deepEqual(started, ['git branch --show-current', 'late'])
  stale.channel.releaseContributions()
  const rowCount = stale.channel.rows.length
  resolve(output('late output'))
  assert.ok(await settled(() => completed.length === 2), 'both in-flight results must complete')
  await setImmediate()
  assert.equal(stale.channel.rows.length, rowCount)
  assert.equal(stale.messages.length, 0)
  assert.equal(stale.channel.gitBranch, undefined)
  console.log('shell compatibility OK: legacy/execute, policy forwarding, errors, timeout, lifecycle')
} finally {
  rmSync(home, { recursive: true, force: true })
}
