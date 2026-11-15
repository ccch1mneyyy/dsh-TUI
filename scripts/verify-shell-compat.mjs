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

const output = (stdout = '', stderr = '', timedOut = false, aborted = false) => ({
  stdout: { text: stdout }, stderr: { text: stderr }, timedOut, aborted,
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
      assert.equal(requests[1].command, request.command)
      assert.equal(requests[1].workdir, request.workdir)
      if (api === 'execute') {
        assert.equal(requests[1].onExpiry, 'none', 'user commands arm no deadline on a modern shell')
        assert.equal(requests[1].timeoutMs, undefined)
        assert.ok(requests[1].signal instanceof AbortSignal)
      } else {
        assert.deepEqual(requests[1], request, 'legacy run() shells keep the bounded request')
      }
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
  // A refused `!!` followup (accepted: false resolves, never throws) must be
  // reported, not silently dropped while its output rows look delivered.
  {
    const { createCoreLocalActions } = await import('../lib/types/dsh-adapter/channel/core/local-actions.js')
    const notices = []
    const fakeShell = {
      resolve: value => value,
      async execute() { return { async result() { return output(' hi\n') } } },
    }
    const actions = createCoreLocalActions({ get: name => name === 'shell' ? fakeShell : undefined }, {
      owner: { current: () => true },
      binding: {
        capture: () => ({ session: { submit: async () => ({ accepted: false, reason: 'session disposed' }) } }),
        isCurrent: () => true,
      },
      state: { rows: [], emit() {} },
      rowIds: { value: 0 },
      workspace: {
        describe: () => ({ kind: 'local', badge: 'local', label: 'local' }),
        commandShell: async () => undefined,
      },
      resetProjection() {},
      notify: (text, options) => { notices.push({ text, options }) },
      unavailable() {},
      dropRows() {},
      loadOlder: () => undefined,
      stageContext() {},
    })
    await actions.runLocalCommand('echo hi', 'send')
    assert.equal(notices.length, 1, 'a refused !! submit must notify exactly once')
    assert.match(notices[0].text, /session disposed/, 'the refusal notice carries the backend reason')
  }

  const stale = channelFor(delayed)
  stale.channel.submit('!!late')
  assert.ok(await settled(() => started.includes('late') && started.includes('git branch --show-current')),
    'both the submitted command and async branch probe must start before release')
  assert.deepEqual([...started].sort(), ['git branch --show-current', 'late'])
  stale.channel.releaseContributions()
  const rowCount = stale.channel.rows.length
  resolve(output('late output'))
  assert.ok(await settled(() => completed.length === 2), 'both in-flight results must complete')
  await setImmediate()
  assert.equal(stale.channel.rows.length, rowCount)
  assert.equal(stale.messages.length, 0)
  assert.equal(stale.channel.gitBranch, undefined)
  // Unlimited + interruptible: a modern (execute) shell receives
  // `onExpiry: 'none'` and the caller's signal, no timeoutMs; cancelling
  // through the channel kills it, shows partial output as interrupted,
  // and a cancelled `!!` delivers nothing.
  {
    const requests = []
    let settleSlow
    let slowKilled = false
    const shell = {
      resolve(value) { requests.push(value); return value },
      async execute(spec) {
        if (spec.command === 'git branch --show-current') {
          return { async result() { return output(' main\n') } }
        }
        return {
          kill() { slowKilled = true; settleSlow?.(output(' partial\n', '', false, true)); return true },
          result: () => new Promise((resolveResult) => { settleSlow = resolveResult }),
        }
      },
    }
    const { channel, messages } = channelFor(shell)
    try {
      assert.ok(await settled(() => channel.gitBranch === 'main'))
      channel.submit('!!slow')
      assert.ok(await settled(() => requests.some(r => r.command === 'slow')), 'the command starts')
      const request = requests.find(r => r.command === 'slow')
      assert.equal(request.onExpiry, 'none', 'no deadline is armed for user commands')
      assert.equal(request.timeoutMs, undefined, 'no timeoutMs is passed on the modern path')
      assert.ok(request.signal instanceof AbortSignal, 'the interrupt signal reaches resolve')
      assert.equal(channel.localCommandRunning, true, 'the run is visible while it runs')
      assert.equal(channel.cancelLocalCommands(), 1, 'one running command is signalled')
      assert.ok(await settled(() => channel.rows.at(-1)?.text === '(interrupted)'), 'partial output lands as interrupted')
      assert.equal(slowKilled, true, 'the execution handle was killed')
      assert.equal(channel.localCommandRunning, false, 'the run retired after settling')
      assert.equal(messages.length, 0, 'an interrupted !! delivers nothing to the model')
    } finally { channel.releaseContributions() }
  }

  // Legacy run()-only shells keep the bounded request and cannot be
  // interrupted: cancel reports 0 and the run completes normally.
  {
    const requests = []
    let settleSlow
    const shell = {
      resolve(value) { requests.push(value); return value },
      async run(spec) {
        if (spec.command === 'git branch --show-current') return output(' main\n')
        return new Promise((resolveResult) => { settleSlow = resolveResult })
      },
    }
    const { channel, messages } = channelFor(shell)
    try {
      assert.ok(await settled(() => channel.gitBranch === 'main'))
      channel.submit('!!slow')
      assert.ok(await settled(() => requests.some(r => r.command === 'slow')))
      const request = requests.find(r => r.command === 'slow')
      assert.equal(request.timeoutMs, 30000, 'legacy shells keep the bounded request')
      assert.equal(channel.cancelLocalCommands(), 0, 'a legacy run cannot be signalled')
      settleSlow(output(' done\n'))
      assert.ok(await settled(() => messages.length === 1), 'the uninterrupted legacy run still delivers')
    } finally { channel.releaseContributions() }
  }

  // Timing unification: `!!` takes its input-FIFO slot at invocation, `$`
  // attaches to the next submission and that submission waits for the run.
  function deferredShell() {
    const runs = new Map()
    const shell = {
      resolve: value => value,
      async execute(spec) {
        if (spec.command === 'git branch --show-current') return { async result() { return output(' main\n') } }
        let resolveResult
        const promise = new Promise((res) => { resolveResult = res })
        const run = { resolve: resolveResult, killed: false }
        runs.set(spec.command, run)
        return {
          kill() { run.killed = true; resolveResult(output(' partial\n', '', false, true)); return true },
          result: () => promise,
        }
      },
    }
    return { shell, runs }
  }
  const messageText = message => message.content.map(block => block.text ?? '').join('\n')

  { // `!!slow` invoked before a typed message: the model sees them in
    // invocation order, however long the command takes.
    const { shell, runs } = deferredShell()
    const { channel, messages } = channelFor(shell)
    try {
      assert.ok(await settled(() => channel.gitBranch === 'main'))
      channel.submit('!!slowcmd')
      channel.submit('hello')
      await setImmediate()
      assert.equal(messages.length, 0, 'the typed message waits behind the !! slot')
      assert.ok(channel.pending.some(item => item.text === 'hello'), 'the waiting message is displayed as a pending preview')
      runs.get('slowcmd').resolve(output(' slow out\n'))
      assert.ok(await settled(() => messages.length === 2), 'both inputs are delivered')
      assert.match(messageText(messages[0]), /<bash-stdout>\nslow out\n<\/bash-stdout>/, 'the !! output is delivered first')
      assert.equal(messageText(messages[1]), 'hello', 'the typed message follows in invocation order')
    } finally { channel.releaseContributions() }
  }

  { // Interrupting the shell releases the FIFO slot without a delivery.
    const { shell, runs } = deferredShell()
    const { channel, messages } = channelFor(shell)
    try {
      assert.ok(await settled(() => channel.gitBranch === 'main'))
      channel.submit('!!slowcmd')
      channel.submit('after')
      assert.ok(await settled(() => runs.has('slowcmd')), 'the command has started')
      assert.equal(channel.cancelLocalCommands(), 1)
      assert.ok(await settled(() => messages.length === 1), 'the queued message is released by the interrupt')
      assert.equal(messageText(messages[0]), 'after', 'only the typed message is delivered')
      assert.equal(runs.get('slowcmd').killed, true)
    } finally { channel.releaseContributions() }
  }

  { // A message parked behind a shell slot can be withdrawn (Alt+↑ path):
    // its preview is displayed, removal succeeds, and it never delivers.
    const { shell, runs } = deferredShell()
    const { channel, messages } = channelFor(shell)
    try {
      assert.ok(await settled(() => channel.gitBranch === 'main'))
      channel.submit('!!slowcmd')
      channel.submit('nevermind')
      assert.ok(await settled(() => runs.has('slowcmd')), 'the command has started')
      const preview = channel.pending.find(item => item.text === 'nevermind')
      assert.ok(preview, 'the parked message has a preview to withdraw')
      assert.equal(channel.removePending(preview.id), true, 'a FIFO-parked message withdraws channel-side')
      assert.ok(!channel.pending.some(item => item.text === 'nevermind'), 'the preview is gone')
      runs.get('slowcmd').resolve(output(' slow out\n'))
      assert.ok(await settled(() => messages.length === 1), 'only the !! output is delivered')
      assert.match(messageText(messages[0]), /<bash-stdout>/, 'the withdrawn message never reaches the model')
    } finally { channel.releaseContributions() }
  }

  { // `$cmd` then a message sent before the command finishes: the message
    // carries the output as an attached context (and waits for it).
    const { shell, runs } = deferredShell()
    const { channel, messages } = channelFor(shell)
    try {
      assert.ok(await settled(() => channel.gitBranch === 'main'))
      channel.submit('$ctxcmd')
      channel.submit('use this')
      await setImmediate()
      assert.equal(messages.length, 0, 'the message waits for the $ command it carries')
      runs.get('ctxcmd').resolve(output(' ctx out\n'))
      assert.ok(await settled(() => messages.length === 1), 'the message is delivered with its context')
      assert.equal(messages[0].content[0].text, 'use this')
      assert.match(messageText(messages[0]), /<attached-context[^>]*title="\$ ctxcmd">\n\$ ctxcmd\nctx out\n<\/attached-context>/, 'the $ output rides the next message')
    } finally { channel.releaseContributions() }
  }

  console.log('shell compatibility OK: legacy/execute, policy forwarding, errors, timeout, lifecycle')
} finally {
  rmSync(home, { recursive: true, force: true })
}
