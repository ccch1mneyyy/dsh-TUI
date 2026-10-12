/**
 * Startup and /new must not materialize permission-only DSH sessions.
 * Real AgentLoop, SessionStore and JSONL; scripted model, temporary HOME,
 * no network or credentials. Covers both JSONL encodings, suffix handoff,
 * write failure/retry, disposal, concurrent factories and saved history.
 * Restart/update cases spawn real replacements, parse the real Config and
 * create/resume through the real Agent registry; no installer is invoked.
 * Run: node --import tsx/esm scripts/verify-empty-session-persistence.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { settled, sleep } from './lib/term-test.mjs'

const handoffRole = process.env.DSH_TUI_EMPTY_HANDOFF_ROLE
if (handoffRole === 'driver') {
  const { restartTui } = await import('../src/update.js')
  const kind = process.env.DSH_TUI_EMPTY_HANDOFF_KIND === 'update' ? 'update' : 'restart'
  process.exit(await restartTui(process.env.DSH_TUI_EMPTY_HANDOFF_SESSION ?? '', {
    kind, kernel: 'dsh', env: { DSH_TUI_EMPTY_HANDOFF_ROLE: 'child' },
  }))
}
if (handoffRole === 'child') {
  const [{ Config }, { resumeTargetFromArgv }, { createFreshAgent }] = await Promise.all([
    import('../src/dsh-adapter/index.js'),
    import('../src/sessionHistory.js'),
    import('../src/dsh-adapter/fresh-agent.js'),
  ])
  const config = Config({ sessionId: process.env.DSH_TUI_RESUME_SESSION })
  const target = config.sessionId ?? resumeTargetFromArgv(process.argv.slice(2))
  const expected = process.env.DSH_TUI_EMPTY_HANDOFF_SESSION ?? ''
  const ctx = new Context()
  try {
    for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) await ctx.plugin(plugin)
    await ctx.plugin(JsonlSessionPersistence, { root: process.env.DSH_TUI_EMPTY_HANDOFF_ROOT, compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    const handle = target === undefined
      ? await createFreshAgent(ctx, ctx.agents, { sessionId: SessionId('handoff-fresh'), meta: { cwd: process.env.HOME } })
      : await ctx.agents.resume({ resumeSessionId: SessionId(target) })
    try {
      assert.deepEqual(process.argv.slice(2), JSON.parse(process.env.DSH_TUI_EMPTY_HANDOFF_ARGV!))
      if (expected === '') {
        assert.equal(Object.hasOwn(process.env, 'DSH_TUI_RESUME_SESSION'), false)
        assert.equal(config.sessionId, undefined)
        assert.equal(target, undefined)
        assert.equal(handle.agent.session.id, 'handoff-fresh')
        assert.equal((await ctx.sessionPersistence.list()).some(row => row.header.id === handle.agent.session.id && row.sizeBytes !== undefined), false)
      } else {
        assert.equal(config.sessionId, expected)
        assert.equal(handle.agent.session.id, expected)
        assert.ok(handle.agent.session.snapshotEvents().some(event => event.type === 'user/message'))
      }
    } finally { await handle.dispose() }
  } finally { await ctx.fiber.dispose() }
  console.log('PASS replacement Config and Agent startup')
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-fresh-persistence-'))
process.env.HOME = root
process.env.USERPROFILE = root
process.env.DSH_HOME = join(root, 'home')
process.env.DSH_TUI_LANG = 'en'
const { createFreshAgent, isUnstoredFreshSession } = await import('../src/dsh-adapter/fresh-agent.js')
const { createChannel } = await import('../src/dsh-adapter/channel.js')
const { isExitResumable } = await import('../src/dsh-adapter/plugin.js')
const { concreteService } = await import('../src/dsh-adapter/host-access.js')

class ScriptedAdapter extends LlmAdapter {
  async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  async *stream() {
    yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
    yield { type: 'text-delta' as const, index: 0, text: 'saved reply' }
    yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: 'saved reply' } }
    yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
  }
}

const policyTypes = ['permission/preset', 'sandbox/mode', 'approval/policy']
const title = (session: Session, text: string): void => {
  session.append('session/title', { title: text, messageSeqs: [], source: { kind: 'user' } })
}

async function verify(compression: 'zstd' | 'none'): Promise<SessionId> {
  const ctx = new Context()
  const handles: AgentHandle[] = []
  const releaseWaiters: Array<() => void> = []
  const abandonedIds = new Set<SessionId>()
  const sessionsRoot = join(root, compression)
  let channel: ReturnType<typeof createChannel> | undefined
  let savedId: SessionId | undefined
  let teardownSession: Session | undefined
  try {
    for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) {
      await ctx.plugin(plugin)
    }
    const backend = await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter())
    // Reproduce the official permission service's session/created pinning.
    ctx.on('session/created', session => {
      if (session.seq !== 0) return
      const append = session.append as (type: string, data: Record<string, unknown>) => unknown
      append.call(session, 'permission/preset', { preset: 'workspace-write' })
      session.append('sandbox/mode', { mode: 'workspace-write' })
      session.append('approval/policy', { policy: 'ask' })
    })
    const seen = new Map<Session, SessionEvent[]>()
    ctx.on('session/event', (session, event) => {
      const events = seen.get(session) ?? []
      events.push(event)
      seen.set(session, events)
    }, { global: true })
    const persistence = concreteService(ctx.sessionPersistence)
    const originalCreate = persistence.create
    const artifact = (session: Session): string => persistence.locate(session.header).path
    const options = (id: string) => ({
      sessionId: SessionId(`${compression}-${id}`), meta: { cwd: root },
      agentOptions: { provider: 'scripted', model: 'scripted' },
    })
    const fresh = async (id: string): Promise<AgentHandle> => {
      const handle = await createFreshAgent(ctx, ctx.agents, options(id))
      handles.push(handle)
      return handle
    }
    const stored = async (session: Session): Promise<readonly SessionEvent[]> => {
      const reader = await persistence.open(session.id, 'read')
      try { return (await reader.read()).events }
      finally { await reader.close() }
    }
    const assertComplete = async (session: Session): Promise<void> => {
      const events = session.snapshotEvents()
      assert.deepEqual(await stored(session), events, 'persisted log equals the canonical Session, including seq and message ids')
      assert.deepEqual(seen.get(session), events, 'global consumers receive each original event exactly once')
    }

    const control = await ctx.agents.create(options('control'))
    handles.push(control)
    assert.ok(await settled(() => existsSync(artifact(control.agent.session))), 'ungated factory reproduces the permission-only artifact')
    await control.dispose()

    const startup = await fresh('startup')
    abandonedIds.add(startup.agent.session.id)
    assert.deepEqual(startup.agent.session.snapshotEvents().map(event => event.type), policyTypes, 'permissions are initialized before input')
    assert.equal(isUnstoredFreshSession(startup.agent.session), true, 'restart/update must not resume this unstored id')
    assert.equal(isExitResumable({ pendingCount: 1, liveAgent: startup.agent, startupAgent: startup.agent }), false, 'a parked TUI input cannot leave a marker for an unstored session')
    await sleep(250) // 固定窗:探针 — permission-only sessions must remain absent beyond JSONL's 200ms drain timer.
    assert.equal(existsSync(artifact(startup.agent.session)), false)
    await startup.dispose()
    assert.equal(existsSync(artifact(startup.agent.session)), false, 'idle exit does not save the initialization')
    assert.equal(await persistence.stat(startup.agent.session.id), undefined, 'the unmaterialized claim is released')

    const first = await fresh('new-start')
    channel = createChannel(ctx, first.agent, { handle: first, cwd: root, provider: 'scripted', model: 'scripted', activity: false })
    const emptySessions = [first.agent.session]
    for (let index = 0; index < 3; index++) {
      assert.equal(await channel.newSession(), true)
      const current = ctx.agents.get(SessionId(channel.agentId))!
      emptySessions.push(current.session)
      assert.deepEqual(current.session.snapshotEvents().map(event => event.type), policyTypes)
    }
    const current = ctx.agents.get(SessionId(channel.agentId))!
    channel.submit('first real prompt')
    assert.ok(await settled(() => channel!.rows.some(row => row.text === 'saved reply') && !channel!.working))
    await ctx.sessions.flush(current.session)
    assert.equal(isUnstoredFreshSession(current.session), false, 'a written conversation keeps its handoff id')
    assert.equal(isExitResumable({ pendingCount: 0, liveAgent: current, startupAgent: first.agent }), true, 'real user input leaves a resumable exit marker')
    await assertComplete(current.session)
    assert.deepEqual(current.session.snapshotEvents().slice(0, 3).map(event => event.type), policyTypes)
    assert.equal(current.session.snapshotEvents().filter(event => event.type === 'user/message').length, 1)
    for (const empty of emptySessions.slice(0, -1)) {
      abandonedIds.add(empty.id)
      assert.ok(await settled(() => ctx.agents.get(empty.id) === undefined), 'the replaced empty Agent closes')
      assert.equal(existsSync(artifact(empty)), false, '/new does not save the previous initialization')
    }
    savedId = current.session.id
    assert.equal(await channel.newSession(), true)
    const blank = ctx.agents.get(SessionId(channel.agentId))!
    assert.equal(isExitResumable({ pendingCount: 0, liveAgent: blank, startupAgent: current }), false, '/new cannot retain the previous conversation as its exit target')
    assert.equal((await channel.resumeTo(String(savedId))).ok, true)
    assert.ok(channel.rows.some(row => row.text === 'saved reply'), 'saved history resumes normally')
    channel.releaseContributions()
    channel = undefined

    // An explicit checkpoint retains the persistence contract, even before a prompt.
    const explicit = await fresh('explicit-flush')
    await ctx.sessions.flush(explicit.agent.session)
    assert.equal(isUnstoredFreshSession(explicit.agent.session), false, 'an explicitly saved empty session can be handed off')
    await assertComplete(explicit.agent.session)
    const serviceFlush = await fresh('service-flush')
    await persistence.flush()
    await assertComplete(serviceFlush.agent.session)

    // Hold the first suffix in the public writer while more events arrive,
    // then fail the next suffix. A checkpoint must retry that exact prefix.
    const entered = Promise.withResolvers<void>()
    const permit = Promise.withResolvers<void>()
    releaseWaiters.push(permit.resolve)
    let calls = 0
    persistence.create = async function (header, config) {
      const writer = await originalCreate.call(this, header, config)
      if (header.id === options('handoff').sessionId) {
        const append = writer.append.bind(writer)
        writer.append = async events => {
          calls++
          if (calls === 1) { entered.resolve(); await permit.promise }
          if (calls === 2) throw new Error('injected suffix failure')
          await append(events)
        }
      }
      return writer
    }
    const handoff = await fresh('handoff')
    persistence.create = originalCreate
    title(handoff.agent.session, 'during handoff')
    await entered.promise
    handoff.agent.session.append('sandbox/mode', { mode: 'read-only' })
    const failingFlush = ctx.sessions.flush(handoff.agent.session)
    permit.resolve()
    await assert.rejects(failingFlush, /injected suffix failure/)
    await ctx.sessions.flush(handoff.agent.session)
    await assertComplete(handoff.agent.session)
    title(handoff.agent.session, 'after handoff')
    await ctx.sessions.flush(handoff.agent.session)
    await assertComplete(handoff.agent.session)
    await handoff.dispose()

    // Teardown waits for a started handoff before closing the owned writer.
    const disposing = await fresh('disposing')
    title(disposing.agent.session, 'save before exit')
    disposing.agent.session.append('sandbox/mode', { mode: 'read-only' })
    await disposing.dispose()
    await assertComplete(disposing.agent.session)

    // Completing overlapping factories out of order must restore the public
    // create method and leave no stale capture or permission-only artifact.
    const aEntered = Promise.withResolvers<void>()
    const aPermit = Promise.withResolvers<void>()
    releaseWaiters.push(aPermit.resolve)
    const aPending = createFreshAgent(ctx, ctx.agents, {
      ...options('concurrent-a'), setup: async () => { aEntered.resolve(); await aPermit.promise },
    })
    await aEntered.promise
    const host = await ctx.agents.create(options('concurrent-host'))
    handles.push(host)
    title(host.agent.session, 'host history')
    await ctx.sessions.flush(host.agent.session)
    await assertComplete(host.agent.session)
    const b = await fresh('concurrent-b')
    aPermit.resolve()
    const a = await aPending
    handles.push(a)
    assert.equal(persistence.create, originalCreate, 'the temporary capture is completely removed')
    for (const handle of [a, b]) {
      abandonedIds.add(handle.agent.session.id)
      assert.deepEqual(handle.agent.session.snapshotEvents().map(event => event.type), policyTypes)
      await handle.dispose()
      assert.equal(existsSync(artifact(handle.agent.session)), false)
    }

    await assert.rejects(createFreshAgent(ctx, ctx.agents, {
      ...options('setup-failure'), setup: () => { throw new Error('injected setup failure') },
    }), /injected setup failure/)
    assert.equal(persistence.create, originalCreate, 'failed setup restores the capture')
    assert.equal(await persistence.stat(options('setup-failure').sessionId), undefined)

    // A publication commit's events are stored by the factory itself.
    const seeded = await createFreshAgent(ctx, ctx.agents, {
      ...options('setup-commit'), setup: (_scope, agent) => ({ commit: () => title(agent.session, 'setup history') }),
    })
    handles.push(seeded)
    title(seeded.agent.session, 'later history')
    await ctx.sessions.flush(seeded.agent.session)
    assert.deepEqual(await stored(seeded.agent.session), seeded.agent.session.snapshotEvents())

    const closeEntered = Promise.withResolvers<void>()
    const closePermit = Promise.withResolvers<void>()
    releaseWaiters.push(closePermit.resolve)
    persistence.create = async function (header, config) {
      const writer = await originalCreate.call(this, header, config)
      if (header.id === options('provider-teardown').sessionId) {
        const append = writer.append.bind(writer)
        let firstAppend = true
        writer.append = async events => {
          await append(events)
          if (firstAppend) {
            firstAppend = false
            closeEntered.resolve()
            await closePermit.promise
          }
        }
      }
      return writer
    }
    const teardown = await fresh('provider-teardown')
    persistence.create = originalCreate
    teardownSession = teardown.agent.session
    title(teardownSession, 'first suffix')
    await closeEntered.promise
    teardownSession.append('sandbox/mode', { mode: 'read-only' })
    let providerClosed = false
    const closingProvider = backend.dispose().then(() => { providerClosed = true })
    await setImmediate()
    assert.equal(providerClosed, false, 'provider teardown waits for the pending handoff')
    closePermit.resolve()
    await closingProvider
    console.log(`PASS ${compression}: startup, repeated /new, first prompt, resume, flush, suffix retry, exit and factory cleanup`)
  } finally {
    for (const release of releaseWaiters) release()
    channel?.releaseContributions()
    for (const handle of handles) await handle.dispose()
    await ctx.fiber.dispose()
  }
  const reopened = new Context()
  try {
    await reopened.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression })
    const rows = await reopened.sessionPersistence.list()
    assert.equal(rows.some(row => abandonedIds.has(row.header.id)), false, 'fresh readers cannot list abandoned empty sessions')
    assert.ok(rows.some(row => row.header.id === savedId), 'the real conversation survives a fresh backend')
    const reader = await reopened.sessionPersistence.open(savedId!, 'read')
    try {
      const events = (await reader.read()).events
      assert.deepEqual(events.slice(0, 3).map(event => event.type), policyTypes)
      assert.ok(events.some(event => event.type === 'user/message'))
    } finally { await reader.close() }
    const teardownReader = await reopened.sessionPersistence.open(teardownSession!.id, 'read')
    try {
      assert.deepEqual((await teardownReader.read()).events, teardownSession!.snapshotEvents(), 'provider-first teardown preserves every event of the handoff')
    } finally { await teardownReader.close() }
  } finally { await reopened.fiber.dispose() }
  return savedId!
}

function verifyHandoffs(savedId: SessionId): void {
  const cases = [
    { name: 'startup empty /restart', kind: 'restart', session: '', args: [], expected: [] },
    { name: '/new then /restart from an inherited resume', kind: 'restart', session: '', args: ['--resume', 'old-session', '--fullscreen'], expected: ['--fullscreen'] },
    { name: '/new then /update from inherited resume flags', kind: 'update', session: '', args: ['--resume=old-session', '--continue', '-c', '--fullscreen'], expected: ['--fullscreen'] },
    { name: 'saved conversation /restart', kind: 'restart', session: savedId, args: ['--resume', 'old-session'], expected: ['--resume', 'old-session'] },
    { name: 'saved conversation /update', kind: 'update', session: savedId, args: [], expected: [] },
  ]
  for (const test of cases) {
    const run = spawnSync(process.execPath, ['--import', 'tsx/esm', fileURLToPath(import.meta.url), ...test.args], {
      encoding: 'utf8', timeout: 30000,
      env: {
        ...process.env,
        DSH_TUI_RESUME_SESSION: 'old-session',
        DSH_TUI_EMPTY_HANDOFF_ROLE: 'driver',
        DSH_TUI_EMPTY_HANDOFF_KIND: test.kind,
        DSH_TUI_EMPTY_HANDOFF_SESSION: test.session,
        DSH_TUI_EMPTY_HANDOFF_ROOT: join(root, 'none'),
        DSH_TUI_EMPTY_HANDOFF_ARGV: JSON.stringify(test.expected),
      },
    })
    assert.equal(run.status, 0, `${test.name}: ${run.error?.message ?? ''}\n${run.stderr}\n${run.stdout}`)
    assert.ok(run.stdout.includes('PASS replacement Config and Agent startup'), test.name)
    console.log(`PASS ${test.name}`)
  }
}

try {
  const savedId = await verify('none')
  await verify('zstd')
  verifyHandoffs(savedId)
} finally {
  rmSync(root, { recursive: true, force: true })
}
