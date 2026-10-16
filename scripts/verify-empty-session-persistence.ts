/**
 * Empty-session persistence through real DSH services and channel actions.
 * Covers JSONL encodings, checkpoints, policy inheritance, retry and restart.
 * Run: node --import tsx/esm scripts/verify-empty-session-persistence.ts [--negative-controls]
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import PlanMode from '@deepseek-ai/dsh-plan-mode'
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistenceModule from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Approval, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { settled, sleep } from './lib/term-test.mjs'

const JsonlSessionPersistence = 'default' in JsonlSessionPersistenceModule ? JsonlSessionPersistenceModule.default : JsonlSessionPersistenceModule

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
const { createFreshAgent, isUnstoredFreshSession, INITIAL_POLICY_EVENTS } = await import('../src/dsh-adapter/fresh-agent.js')
const { createChannel } = await import('../src/dsh-adapter/channel.js')
const { createForkSessionAction } = await import('../src/dsh-adapter/channel/session-fork.js')
const { createRewindToAction } = await import('../src/dsh-adapter/channel/session-rewind.js')
const { dshHandleOf } = await import('../src/dsh-adapter/backend/session.js')
const { rewindTarget } = await import('../src/dsh-adapter/sessionTree.js')
const { isExitResumable } = await import('../src/dsh-adapter/plugin.js')
const { concreteService } = await import('../src/dsh-adapter/host-access.js')
const { liveSessionCreateOptions } = await import('../src/dsh-adapter/compat/index.js')
const { holdsNoConversation, latestPolicyFacts } = await import('../src/dsh-adapter/session-seed.js')
const { foldPermissionPreset } = await import('../src/dsh-adapter/channel/mode-permission.js')
const { t } = await import('../src/i18n.js')

const negativeControls = process.argv.includes('--negative-controls')

for (const [events, empty] of [
  [[], true],
  [[{ type: 'user/message', data: { source: { kind: 'user' } } }], false],
  [[{ type: 'user/message', data: {} }], false],
  [[{ type: 'user/message', data: { source: { kind: 'subagent' } } }], true],
  [[{ type: 'agent/inbox/spliced', data: { inserted: [{ role: 'user' }] } }], false],
  [[{ type: 'agent/inbox/spliced', data: {} }], false],
  [[{ type: 'turn/start' }], false],
] as const) assert.equal(holdsNoConversation(events), empty)
assert.deepEqual(latestPolicyFacts([
  { type: 'plan/mode', data: { active: true } },
  { type: 'sandbox/mode', data: { mode: 'read-only' } },
  { type: 'session/title', data: { title: 'ignored' } },
  { type: 'plan/mode', data: { active: false } },
]), [
  { type: 'sandbox/mode', data: { mode: 'read-only' } },
  { type: 'plan/mode', data: { active: false } },
])

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

type PolicyReading = Record<'plan' | 'sandbox' | 'approval' | 'preset', unknown>
function policyOf(ctx: Context, agent: Agent): PolicyReading {
  return {
    plan: ctx.planMode.get(agent).active,
    sandbox: ctx.sandboxPolicy.overrideOf(agent.session),
    approval: ctx.approval.overrideOf(agent.session),
    preset: foldPermissionPreset(agent.session.snapshotEvents()),
  }
}

const RESTRICTED_POLICY: PolicyReading = { plan: true, sandbox: 'read-only', approval: 'never', preset: 'read-only' }

function restrictPolicy(ctx: Context, agent: Agent): void {
  ctx.planMode.set(agent, true)
  setSandboxMode(agent.session, 'read-only')
  setApprovalPolicy(agent.session, 'never')
  agent.session.append('permission/preset', { preset: 'read-only' })
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
    const createFlushes = new Set<string>()
    const writers = new Map<string, { writer: { append(events: readonly SessionEvent[]): Promise<void> }; flush: () => Promise<void> }>()
    let preFixId = ''
    ctx.on('session/created', session => {
      if (session.seq !== 0) return
      const append = session.append as (type: string, data: Record<string, unknown>) => unknown
      append.call(session, 'permission/preset', { preset: 'workspace-write' })
      session.append('sandbox/mode', { mode: 'workspace-write' })
      session.append('approval/policy', { policy: 'ask' })
      const id = String(session.id)
      if (!createFlushes.has(id)) return
      const captured = writers.get(id)
      if (negativeControls && id === preFixId && captured !== undefined) {
        const events = session.snapshotEvents()
        void (async () => {
          try {
            if (events.length > 0) await captured.writer.append(events)
            await captured.flush()
          } catch (error) { ctx.logger.warn(`negative control: pre-fix flush failed: ${String(error)}`) }
        })()
        return
      }
      void ctx.sessions.flush(session)
    })
    const foreignSeen = new Map<string, number>()
    ctx.on('session/event', session => {
      const id = String(session.id)
      foreignSeen.set(id, (foreignSeen.get(id) ?? 0) + 1)
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

    persistence.create = async function (header, config) {
      const writer = await originalCreate.call(this, header, config)
      writers.set(String(header.id), { writer, flush: writer.flush.bind(writer) })
      return writer
    }
    const verifyCheckpointPublication = async (): Promise<void> => {
      const createFlushId = String(options('create-flush').sessionId)
      createFlushes.add(createFlushId)
      const createFlushed = await fresh('create-flush')
      assert.deepEqual(createFlushed.agent.session.snapshotEvents().map(event => event.type), policyTypes)
      await sleep(250) // 固定窗:探针 — beyond JSONL's 200ms live drain timer.
      assert.equal(existsSync(artifact(createFlushed.agent.session)), false, 'the create-time checkpoint does not publish the permission-only shell')
      assert.equal(isUnstoredFreshSession(createFlushed.agent.session), true, 'the create-time checkpoint does not hand the session off')
      console.log(`INFO deferred create-flush session: foreign listeners observed ${String(foreignSeen.get(createFlushId) ?? 0)} events`)
      title(createFlushed.agent.session, 'first real event')
      await ctx.sessions.flush(createFlushed.agent.session)
      assert.equal(isUnstoredFreshSession(createFlushed.agent.session), false, 'the first real event still hands the checkpointed session off')
      await assertComplete(createFlushed.agent.session)
      assert.deepEqual((await stored(createFlushed.agent.session)).map(event => event.seq), [0, 1, 2, 3], 'the published log is contiguous from seq 0')

      const explicit = await fresh('explicit-flush')
      assert.equal(await ctx.sessions.flush(explicit.agent.session), true, 'an idle checkpoint still reaches a participating listener')
      assert.equal(isUnstoredFreshSession(explicit.agent.session), true, 'an idle checkpoint does not publish the initialization')
      assert.equal(existsSync(artifact(explicit.agent.session)), false)
      title(explicit.agent.session, 'explicitly flushed')
      await ctx.sessions.flush(explicit.agent.session)
      assert.equal(isUnstoredFreshSession(explicit.agent.session), false, 'the first real event still hands the session off')
      await assertComplete(explicit.agent.session)
      const serviceFlush = await fresh('service-flush')
      await persistence.flush()
      assert.equal(existsSync(artifact(serviceFlush.agent.session)), false, 'the backend sweep does not publish an untouched session')
      title(serviceFlush.agent.session, 'after the sweep')
      await persistence.flush()
      await assertComplete(serviceFlush.agent.session)

      const backgroundSource = await fresh('channel-background-source')
      const backgroundChannel = createChannel(ctx, backgroundSource.agent, { handle: backgroundSource, cwd: root, provider: 'scripted', model: 'scripted', activity: false })
      assert.equal((await backgroundChannel.backgroundCurrent()).ok, true, 'the /bg action completes')
      const backgrounded = ctx.agents.get(SessionId(backgroundChannel.agentId))!
      assert.notEqual(backgrounded.session.id, backgroundSource.agent.session.id)
      backgroundChannel.releaseContributions()
      await sleep(250) // 固定窗:探针 — an absent artifact is already true, so polling it proves nothing; the window (250ms > the JSONL 200ms batch timer) is what makes the checkpoint's silence observable.
      assert.equal(existsSync(artifact(backgrounded.session)), false, 'the /bg action keeps its new foreground session unpublished')
      const ungated = await ctx.agents.create(options('channel-background-action-ungated'))
      handles.push(ungated)
      assert.ok(await settled(() => existsSync(artifact(ungated.agent.session))), 'the ungated /bg shape still publishes the shell')
      await ungated.dispose()

      if (negativeControls) {
        preFixId = String(options('negative-control').sessionId)
        createFlushes.add(preFixId)
        const preFix = await fresh('negative-control')
        await sleep(250) // 固定窗:墙钟 — the replayed pre-fix append+flush runs detached, so the shell lands on the JSONL writer's 200ms batch deadline rather than when create() resolves.
        assert.equal(existsSync(artifact(preFix.agent.session)), true, 'negative control: an unconditional drain+flush on the create checkpoint publishes the shell')
        console.log('PASS negative control: the pre-fix drain-on-flush semantics publish the shell')
      }
    }
    await verifyCheckpointPublication()
    persistence.create = originalCreate

    const policySwitchEnvelope = (session: Session): void => {
      session.append('command/run', { commandId: 'cmd-fixture-permission-1', name: 'permission', args: ' workspace-write', source: { kind: 'user' } })
      session.append('agent/inbox/spliced', {
        target: 'next-step',
        start: 0,
        inserted: [{
          content: [{ type: 'text', text: 'The approval policy changed from "never" to "ask" (changed by the user).' }],
          source: { kind: 'user-approval' },
          role: 'user',
          id: 'fixture-approval-notice',
        }],
      })
      session.append('command/done', { commandId: 'cmd-fixture-permission-1', kind: 'success', text: 'preset workspace-write' })
      session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
    }
    const verifyPolicyPlaneStaysDeferred = async (): Promise<void> => {
      for (const type of ['command/run', 'command/done', 'agent/inbox/spliced']) {
        assert.equal(INITIAL_POLICY_EVENTS.has(type), false, `${type} is outside the initialization vocabulary — the old rule started on it`)
      }
      const switched = await fresh('policy-switch')
      assert.deepEqual(switched.agent.session.snapshotEvents().map(event => event.type), policyTypes, 'a fresh session starts on its initialization')
      policySwitchEnvelope(switched.agent.session)
      await sleep(250) // 固定窗:探针 — beyond JSONL's 200ms live drain timer, so an absent artifact is observable silence.
      assert.equal(existsSync(artifact(switched.agent.session)), false, 'a permission switch alone publishes nothing')
      assert.equal(isUnstoredFreshSession(switched.agent.session), true, 'a permission switch alone does not hand the session off')

      switched.agent.session.append('agent/inbox/spliced', {
        target: 'next-step',
        start: 0,
        inserted: [{
          content: [{ type: 'text', text: 'a real prompt' }],
          source: { kind: 'user' },
          role: 'user',
          id: 'fixture-human-message',
        }],
      })
      assert.equal(isUnstoredFreshSession(switched.agent.session), false, 'a human message in the same session still hands it off')
      await ctx.sessions.flush(switched.agent.session)
      await assertComplete(switched.agent.session)
      const published = await stored(switched.agent.session)
      assert.equal(published.length, policyTypes.length + 5, 'the published log keeps the switch AND the prompt, from seq 0')
      console.log('PASS a permission switch stays deferred and the first human message still publishes it')

      if (negativeControls) {
        const ungatedSwitch = await ctx.agents.create(options('policy-switch-ungated'))
        handles.push(ungatedSwitch)
        policySwitchEnvelope(ungatedSwitch.agent.session)
        assert.ok(await settled(() => existsSync(artifact(ungatedSwitch.agent.session))), 'negative control: the same envelope publishes without the gate')
        await ungatedSwitch.dispose()
        console.log('PASS negative control: the permission-switch envelope is storable — the deferral, not the fixture, keeps it off disk')
      }
    }
    await verifyPolicyPlaneStaysDeferred()

    const verifyGateInstalledShape = async (): Promise<void> => {
      const shaped = await createFreshAgent(ctx, ctx.agents, {
        ...options('production-shape'),
        setup: async () => {
        },
      })
      handles.push(shaped)
      assert.equal(isUnstoredFreshSession(shaped.agent.session), true, 'the production create shape arms the deferral gate (its setup resolves without appending)')
      await sleep(250) // 固定窗:探针 — an armed gate must keep the session out of the store; absence needs an observation window past the 200ms drain timer to mean anything.
      assert.equal(existsSync(artifact(shaped.agent.session)), false, 'and an armed gate still keeps that session out of the store')
      title(shaped.agent.session, 'production shape')
      await ctx.sessions.flush(shaped.agent.session)
      assert.equal(isUnstoredFreshSession(shaped.agent.session), false, 'a real event still releases the armed gate')
      await assertComplete(shaped.agent.session)

      if (negativeControls) {
        const preAppend = await createFreshAgent(ctx, ctx.agents, {
          ...options('production-shape-pre-append'),
          setup: async (_agentCtx, agent) => {
            agent.session.append('session/title', { title: 'appended before the commit', messageSeqs: [], source: { kind: 'user' } })
          },
        })
        handles.push(preAppend)
        assert.equal(isUnstoredFreshSession(preAppend.agent.session), false, 'negative control: an append before the setup resolves leaves the gate uninstalled')
        assert.ok(await settled(() => existsSync(artifact(preAppend.agent.session))), 'negative control: and that shape stores the session immediately')
        console.log('PASS negative control: an append before the setup resolves skips the deferral in silence')
      }
    }
    await verifyGateInstalledShape()

    const verifyOnDiskShellSource = async (): Promise<void> => {
      const shell = await ctx.agents.create(options('on-disk-shell'))
      handles.push(shell)
      assert.ok(await settled(() => existsSync(artifact(shell.agent.session))), 'the ungated shell publishes at creation')
      await shell.dispose()
      const resumed = await ctx.agents.resume({ resumeSessionId: options('on-disk-shell').sessionId })
      handles.push(resumed)
      const shellEvents = resumed.agent.session.snapshotEvents()
      assert.deepEqual((await stored(resumed.agent.session)).slice(0, 3).map(event => event.type), policyTypes, 'the log on disk keeps the initialization it was created with')
      assert.equal(shellEvents.some(event => event.type === 'turn/start' || event.type === 'user/message'), false, 'the resumed shell carries no conversation evidence in the snapshot the verdict reads')
      assert.equal(isUnstoredFreshSession(resumed.agent.session), false, 'the never-used verdict cannot see a shell that is already on disk — the face this widening adds')

      const forks: AgentHandle[] = []
      const notices: string[] = []
      const created: string[] = []
      const fork = createForkSessionAction(
        ctx,
        { working: false, cwd: root, provider: 'scripted', model: 'scripted', sessionTitle: 'shell' },
        {
          owner: { current: () => true },
          settleCompaction: async () => {},
          notify: text => { notices.push(text) },
          source: () => resumed.agent.session,
          createDetachedHandle: async create => {
            const handle = await create()
            forks.push(handle)
            return { handle, release: async () => { await handle.dispose() } }
          },
        },
      )
      const driveFork = async (): Promise<string> => {
        notices.length = 0
        forks.length = 0
        created.length = 0
        persistence.create = async function (header, config) {
          created.push(String(header.id))
          return originalCreate.call(this, header, config)
        }
        try {
          assert.equal(await fork(), true, 'the /fork action completes')
        } finally { persistence.create = originalCreate }
        await sleep(250) // 固定窗:探针 — beyond JSONL's 200ms live drain timer.
        assert.equal(created.length, 1, 'the fork creates exactly one session')
        return created[0]!
      }

      const childId = await driveFork()
      const child = forks[0]!
      assert.equal(isUnstoredFreshSession(child.agent.session), true, 'the /fork action took its unseeded branch for an on-disk shell')
      assert.equal(existsSync(artifact(child.agent.session)), false, 'a fork of an on-disk shell publishes no child')
      const notice = notices.at(-1) ?? ''
      assert.equal(notice, t('fork-done-unstored', { id: childId }), 'the fork notice for a conversation-less source is the new-session wording')
      assert.equal(notice.includes('--resume'), false, 'a fork of a conversation-less source must not print a --resume command')
      assert.equal(notice.includes('DSH_TUI_RESUME_SESSION'), false, 'nor the POSIX resume form')

      const usedChannel = createChannel(ctx, resumed.agent, { handle: resumed, cwd: root, provider: 'scripted', model: 'scripted', activity: false })
      try {
        usedChannel.submit('a real prompt')
        assert.ok(await settled(() => usedChannel.rows.some(row => row.text === 'saved reply') && !usedChannel.working))
      } finally { usedChannel.releaseContributions() }
      await ctx.sessions.flush(resumed.agent.session)
      const usedEvents = resumed.agent.session.snapshotEvents()
      assert.ok(usedEvents.some(event => event.type === 'turn/start'), 'the source now holds a turn')
      const seededId = await driveFork()
      const seededChild = forks[0]!
      const seededNotice = notices.at(-1) ?? ''
      assert.equal(isUnstoredFreshSession(seededChild.agent.session), false, 'a source with real content still takes the seeded branch')
      assert.equal(existsSync(artifact(seededChild.agent.session)), true, '…and its child still publishes the copied prefix')
      assert.equal(seededNotice.includes(`--resume ${seededId}`) || seededNotice.includes(`DSH_TUI_RESUME_SESSION=${seededId}`), true, '…and the notice still says how to enter it')
      assert.deepEqual((await stored(seededChild.agent.session)).slice(0, usedEvents.length), usedEvents, 'the copied prefix is byte for byte the source log')
      console.log('PASS /fork on an on-disk shell: no resume command, no child log, and a used source still seeds')

      if (negativeControls) {
        const preFixId = String(options('on-disk-shell-pre-fix').sessionId)
        const preFix = await ctx.agents.create(liveSessionCreateOptions({
          sessionId: SessionId(preFixId),
          seed: shellEvents,
          runtimeSession: resumed.agent.session,
          inheritedCount: shellEvents.length,
          cwd: root,
          agentOptions: { provider: 'scripted', model: 'scripted' },
        }))
        handles.push(preFix)
        assert.equal(isUnstoredFreshSession(preFix.agent.session), false, 'negative control: a seeded child of an on-disk shell is not an unstored fresh session')
        assert.equal(existsSync(artifact(preFix.agent.session)), true, 'negative control: seeding an on-disk shell publishes its child')
        assert.equal(t('fork-done', { id: preFixId, command: `dsh-tui --resume ${preFixId}` }).includes('--resume'), true, 'negative control: the pre-fix notice advertises a resume command')
        console.log('PASS negative control: seeding an on-disk shell publishes its child and the pre-fix notice advertises a resume command')
      }
    }
    await verifyOnDiskShellSource()

    const verifyCutPrefixSeeding = async (): Promise<void> => {
      const source = await ctx.agents.create(options('rewind-cut-source'))
      handles.push(source)
      for (const [turn, text] of [[1, 'first prompt'], [2, 'second prompt']] as const) {
        source.agent.session.append('turn/start', { turn })
        source.agent.session.append('step/start', { turn, step: 1 })
        source.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
        source.agent.session.append('assistant/message', {
          turn, step: 1, stream: [],
          message: createAssistantMessage({ source: { provider: 'scripted', model: 'scripted' }, content: [{ type: 'text', text: 'saved reply' }] }),
        }, { surfaceOp: 'append' })
        source.agent.session.append('step/end', { turn, step: 1 })
        source.agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
      await ctx.sessions.flush(source.agent.session)
      const notices: string[] = []
      const created: AgentSession[] = []
      const switched: string[] = []
      const channel = createChannel(ctx, source.agent, { handle: source, cwd: root, provider: 'scripted', model: 'scripted', activity: false })
      const rewindRows = () => channel.rows.filter(row => row.kind === 'user' && row.label === undefined)
      const rewind = createRewindToAction(
        ctx,
        { working: false, cwd: root, provider: 'scripted', model: 'scripted' },
        {
          owner: { current: () => true },
          binding: {
            agent: source.agent,
            capture: () => ({ session: source.agent.session, agent: source.agent, generation: 1 }),
            isCurrent: () => true,
            prepare: async (_capture, create) => await create(),
            abandon: async session => { await session.dispose() },
          },
          settleCompaction: async () => {},
          notify: text => { notices.push(text) },
          adoptForkedAgent: candidate => { created.push(candidate); return String(source.agent.session.id) },
          notifySessionSwitched: (_kind, sessionId) => { switched.push(sessionId) },
        },
      )
      const drive = async (row: ReturnType<typeof rewindRows>[number]): Promise<AgentSession> => {
        notices.length = 0
        created.length = 0
        switched.length = 0
        assert.equal(await rewind(row), row.text, 'the /rewind action completes and hands the prompt back for editing')
        assert.equal(created.length, 1, 'the rewind creates exactly one session')
        assert.equal(switched.length, 1, 'the rewind commits the switch')
        return created[0]!
      }
      const liveOf = (candidate: AgentSession) => dshHandleOf(candidate).agent.session
      try {
        const events = source.agent.session.snapshotEvents()
        assert.ok(await settled(() => rewindRows().length === 2), 'the conversation offers both prompts as rewind rows')
        const rows = rewindRows()
        assert.equal(events[rows[0]!.seq!]!.type, 'user/message', 'a rewind row carries its own message seq')
        assert.equal(isUnstoredFreshSession(source.agent.session), false, 'the rewind source is a used session — the source verdict alone would seed it')
        assert.ok(events.some(event => event.type === 'turn/start' && event.seq > 0), 'the conversation opens behind the initialization (otherwise its first message could not be rewound at all)')

        const firstBoundary = rewindTarget(events, rows[0]!.seq!).boundary
        assert.ok(firstBoundary >= 0, 'rewinding to the first message is reachable — it is not the turn-0 refusal')
        assert.deepEqual(events.slice(0, firstBoundary + 1).map(event => event.type), policyTypes, 'the cut on offer is the initialization alone')
        const cutChild = await drive(rows[0]!)
        handles.push(dshHandleOf(cutChild))
        await sleep(250) // 固定窗:探针 — beyond JSONL's 200ms live drain timer.
        assert.equal(isUnstoredFreshSession(liveOf(cutChild)), true, 'a cut that holds no conversation takes the unseeded branch')
        assert.equal(existsSync(artifact(liveOf(cutChild))), false, 'and leaves no log on disk')
        assert.deepEqual(liveOf(cutChild).snapshotEvents().map(event => event.type), [...policyTypes, ...policyTypes], 'the child starts from its own initialization plus the cut policy facts — the conversation is still not inherited')
        assert.equal(notices.some(text => text.includes('--resume') || text.includes('DSH_TUI_RESUME_SESSION')), false, 'no notice offers to resume a session that has no log')

        const secondBoundary = rewindTarget(events, rows[1]!.seq!).boundary
        const expectedCut = events.slice(0, secondBoundary + 1)
        assert.ok(expectedCut.some(event => event.type === 'turn/start'), 'the second cut holds the conversation')
        const seededChild = await drive(rows[1]!)
        handles.push(dshHandleOf(seededChild))
        await sleep(250) // 固定窗:墙钟 — the /rewind child's seed is host-appended before session/created and materializes on the first 200ms batch, before it can be read back.
        assert.equal(isUnstoredFreshSession(liveOf(seededChild)), false, 'a cut that holds a conversation takes the seeded branch')
        assert.equal(existsSync(artifact(liveOf(seededChild))), true, 'and publishes the copied prefix')
        assert.deepEqual((await stored(liveOf(seededChild))).slice(0, expectedCut.length), expectedCut, 'the copied prefix is byte for byte the cut')
        console.log('PASS /rewind cut prefix: a policy-only cut stays unseeded while a content cut still seeds')

        if (negativeControls) {
          const cut = events.slice(0, firstBoundary + 1)
          const preFix = await ctx.agents.create(liveSessionCreateOptions({
            sessionId: SessionId(`${compression}-rewind-cut-pre-fix-seed`),
            seed: cut,
            runtimeSession: source.agent.session,
            inheritedCount: cut.length,
            cwd: root,
            agentOptions: { provider: 'scripted', model: 'scripted' },
          }))
          handles.push(preFix)
          assert.equal(isUnstoredFreshSession(preFix.agent.session), false, 'negative control: a seeded child of a policy-only cut is not an unstored fresh session')
          assert.equal(existsSync(artifact(preFix.agent.session)), true, 'negative control: the source verdict seeds the policy-only cut into a published shell')
          console.log('PASS negative control: the source verdict seeds the policy-only cut into a published shell')
        }
      } finally { channel.releaseContributions() }
    }
    await verifyCutPrefixSeeding()

    for (const index of [0, 1]) {
      const treeSource = await fresh(`tree-source-${index}`)
      for (const [turn, text] of [[1, 'tree first'], [2, 'tree second']] as const) {
        treeSource.agent.session.append('turn/start', { turn })
        treeSource.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
        treeSource.agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
      await ctx.sessions.flush(treeSource.agent.session)
      const treeChannel = createChannel(ctx, treeSource.agent, { handle: treeSource, cwd: root, provider: 'scripted', model: 'scripted', activity: false })
      try {
        const row = treeChannel.rows.filter(row => row.kind === 'user' && row.label === undefined)[index]!
        assert.equal(await treeChannel.rewindToNode(String(treeSource.agent.session.id), row.seq!, 'rewind'), row.text)
        const child = ctx.agents.get(SessionId(treeChannel.agentId))!
        assert.equal(isUnstoredFreshSession(child.session), index === 0, 'tree chooses fresh or seeded creation from the actual cut')
        await sleep(250) // 固定窗:探针 — an empty child must stay absent beyond JSONL's 200ms drain timer.
        assert.equal(existsSync(artifact(child.session)), index !== 0)
        const expected = treeSource.agent.session.snapshotEvents().slice(0, rewindTarget(treeSource.agent.session.snapshotEvents(), row.seq!).boundary + 1)
        if (index !== 0) assert.deepEqual((await stored(child.session)).slice(0, expected.length), expected)
      } finally { treeChannel.releaseContributions() }
    }
    console.log('PASS /tree: policy-only cuts stay unpublished and conversation cuts retain their seed')

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

    const disposing = await fresh('disposing')
    title(disposing.agent.session, 'save before exit')
    disposing.agent.session.append('sandbox/mode', { mode: 'read-only' })
    await disposing.dispose()
    await assertComplete(disposing.agent.session)

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
        // This fixture respawns itself rather than the installed host entry.
        DSH_TUI_HOST_ENTRY_PATH: '',
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

async function verifyCutPolicyReplay(): Promise<void> {
  const policyRoot = mkdtempSync(join(tmpdir(), 'dsh-tui-policy-replay-'))
  const ctx = new Context()
  const handles: AgentHandle[] = []
  try {
    for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) {
      await ctx.plugin(plugin)
    }
    await ctx.plugin(JsonlSessionPersistence, { root: policyRoot, compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SandboxPolicy, { mode: 'workspace-write' })
    await ctx.plugin(Approval)
    await ctx.plugin(PlanMode, { section: 'plan mode is active' })
    ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter())
    ctx.on('session/created', session => {
      if (session.seq !== 0) return
      session.append('permission/preset', { preset: 'workspace-write' })
      session.append('sandbox/mode', { mode: 'workspace-write' })
      session.append('approval/policy', { policy: 'ask' })
      void ctx.sessions.flush(session)
    })
    const persistence = concreteService(ctx.sessionPersistence)
    const artifact = (session: Session): string => persistence.locate(session.header).path
    const fresh = async (id: string): Promise<AgentHandle> => {
      const handle = await createFreshAgent(ctx, ctx.agents, {
        sessionId: SessionId(`policy-${id}`), meta: { cwd: policyRoot },
        agentOptions: { provider: 'scripted', model: 'scripted' },
      })
      handles.push(handle)
      return handle
    }
    const stored = async (session: Session): Promise<readonly SessionEvent[]> => {
      const reader = await persistence.open(session.id, 'read')
      try { return (await reader.read()).events } finally { await reader.close() }
    }

    const unused = await fresh('cut-model-source')
    restrictPolicy(ctx, unused.agent)
    assert.deepEqual(policyOf(ctx, unused.agent), RESTRICTED_POLICY, '(A) the source is in a non-default policy')
    assert.equal(isUnstoredFreshSession(unused.agent.session), true, '(A) and nobody has used it — the never-used verdict still answers')
    assert.equal(holdsNoConversation(unused.agent.session.snapshotEvents()), true, '(A) its cut holds no conversation: the CR-1 shape')
    const modelChannel = createChannel(ctx, unused.agent, { handle: unused, cwd: policyRoot, provider: 'scripted', model: 'scripted', activity: false })
    try {
      assert.equal(await modelChannel.switchModel('scripted', 'scripted-next'), true, '(A) the /model action completes')
      const live = ctx.agents.get(SessionId(modelChannel.agentId))
      assert.equal(live, unused.agent, '(A) the switch retains the same agent and session')
      assert.deepEqual(policyOf(ctx, live!), RESTRICTED_POLICY, '(A) the same-session switch keeps the source policy')
      assert.equal(isUnstoredFreshSession(live!.session), true, '(A) and it is still unpublished')
      await sleep(250) // 固定窗:探针 — beyond JSONL's 200ms live drain timer.
      assert.equal(existsSync(artifact(live!.session)), false, '(A) no log is created before the first real event')
      modelChannel.submit('first real prompt')
      assert.ok(await settled(() => modelChannel.rows.some(row => row.text === 'saved reply') && !modelChannel.working), '(A) the same agent runs its first turn')
      await ctx.sessions.flush(live!.session)
      const published = await stored(live!.session)
      assert.deepEqual(published.map(event => event.seq), published.map((_, index) => index), '(A) the published log is contiguous from seq 0')
      assert.equal(live!.session.requestHeader()?.config.model, 'scripted-next', '(A) the first request records the selected model')
      assert.deepEqual(policyOf(ctx, live!), RESTRICTED_POLICY, '(A) the published session still carries the source policy')
      console.log('PASS CR-1 /model: the same agent keeps policy and defers publication until its first real request')
    } finally { modelChannel.releaseContributions() }

    const shell = await fresh('cut-fork-shell')
    restrictPolicy(ctx, shell.agent)
    title(shell.agent.session, 'a titled shell')
    await ctx.sessions.flush(shell.agent.session)
    assert.equal(isUnstoredFreshSession(shell.agent.session), false, '(B) a titled shell is no longer never-used')
    assert.equal(holdsNoConversation(shell.agent.session.snapshotEvents()), true, '(B) yet its cut still holds no conversation')

    const talker = await fresh('cut-fork-used')
    restrictPolicy(ctx, talker.agent)
    const talkerChannel = createChannel(ctx, talker.agent, { handle: talker, cwd: policyRoot, provider: 'scripted', model: 'scripted', activity: false })
    try {
      talkerChannel.submit('a real prompt')
      assert.ok(await settled(() => talkerChannel.rows.some(row => row.text === 'saved reply') && !talkerChannel.working), '(C) the source answers its prompt')
    } finally { talkerChannel.releaseContributions() }
    await ctx.sessions.flush(talker.agent.session)
    assert.equal(holdsNoConversation(talker.agent.session.snapshotEvents()), false, '(C) the used source holds a conversation')

    let forkSource: Session = shell.agent.session
    const forks: AgentHandle[] = []
    let releases = 0
    const fork = createForkSessionAction(
      ctx,
      { working: false, cwd: policyRoot, provider: 'scripted', model: 'scripted', sessionTitle: 'source' },
      {
        owner: { current: () => true },
        settleCompaction: async () => {},
        notify: () => {},
        source: () => forkSource,
        createDetachedHandle: async create => {
          const handle = await create()
          forks.push(handle)
          handles.push(handle)
          return { handle, release: async () => { releases++ } }
        },
      },
    )
    const driveFork = async (source: Session): Promise<AgentHandle> => {
      forkSource = source
      forks.length = 0
      releases = 0
      assert.equal(await fork(), true, 'the /fork action completes')
      assert.equal(forks.length, 1, 'the fork creates exactly one child')
      assert.equal(releases, 1, 'and releases it')
      return forks[0]!
    }

    const shellChild = await driveFork(shell.agent.session)
    assert.deepEqual(policyOf(ctx, shellChild.agent), RESTRICTED_POLICY, '(B) the unseeded /fork child keeps the shell policy')
    assert.equal(isUnstoredFreshSession(shellChild.agent.session), true, '(B) and it is still unpublished')
    await sleep(250) // 固定窗:探针 — beyond JSONL's 200ms live drain timer.
    assert.equal(existsSync(artifact(shellChild.agent.session)), false, '(B) and it leaves no log on disk')
    console.log('PASS CR-1 /fork: an unseeded child keeps the shell policy and stays unpublished')

    const seededChild = await driveFork(talker.agent.session)
    assert.deepEqual(policyOf(ctx, seededChild.agent), RESTRICTED_POLICY, '(C) a source with real content keeps its policy on the seeded branch')
    assert.equal(isUnstoredFreshSession(seededChild.agent.session), false, '(C) and still takes the seeded branch — the widening did not swallow it')
    assert.ok(await settled(() => existsSync(artifact(seededChild.agent.session))), '(C) which publishes the copied prefix')
    assert.deepEqual(
      (await stored(seededChild.agent.session)).slice(0, talker.agent.session.snapshotEvents().length),
      talker.agent.session.snapshotEvents(),
      '(C) the copied prefix is byte for byte the source log',
    )
    console.log('PASS CR-1 /fork reverse: a source with real content is unchanged, policy included')

    const rewound = await fresh('cut-rewind-source')
    restrictPolicy(ctx, rewound.agent)
    for (const [turn, text] of [[1, 'first prompt'], [2, 'second prompt']] as const) {
      rewound.agent.session.append('turn/start', { turn })
      rewound.agent.session.append('step/start', { turn, step: 1 })
      rewound.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
      rewound.agent.session.append('assistant/message', {
        turn, step: 1, stream: [],
        message: createAssistantMessage({ source: { provider: 'scripted', model: 'scripted' }, content: [{ type: 'text', text: 'saved reply' }] }),
      }, { surfaceOp: 'append' })
      rewound.agent.session.append('step/end', { turn, step: 1 })
      rewound.agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    await ctx.sessions.flush(rewound.agent.session)
    const rewindChannel = createChannel(ctx, rewound.agent, { handle: rewound, cwd: policyRoot, provider: 'scripted', model: 'scripted', activity: false })
    try {
      const rows = rewindChannel.rows.filter(row => row.kind === 'user' && row.label === undefined)
      assert.equal(rows.length, 2, '(D) the conversation offers both prompts as rewind rows')
      const events = rewound.agent.session.snapshotEvents()
      const boundary = rewindTarget(events, rows[0]!.seq!).boundary
      assert.equal(holdsNoConversation(events.slice(0, boundary + 1)), true, '(D) the cut on offer is the policy atoms alone')
      assert.equal(await rewindChannel.rewindTo(rows[0]!), 'first prompt', '(D) the /rewind action hands the prompt back for editing')
      const child = ctx.agents.get(SessionId(rewindChannel.agentId))
      assert.ok(child !== undefined && child.session.id !== rewound.agent.session.id, '(D) the rewind adopted a replacement session')
      assert.deepEqual(policyOf(ctx, child), RESTRICTED_POLICY, '(D) the unseeded /rewind child keeps the cut policy')
      assert.equal(isUnstoredFreshSession(child.session), true, '(D) and it is still unpublished')
      await sleep(250) // 固定窗:探针 — beyond JSONL's 200ms live drain timer.
      assert.equal(existsSync(artifact(child.session)), false, '(D) and it leaves no log on disk')
      console.log('PASS CR-1 /rewind: an unseeded child keeps the cut policy and stays unpublished')
    } finally { rewindChannel.releaseContributions() }

    if (negativeControls) {
      const preFix = await fresh('cut-pre-fix')
      assert.notDeepEqual(policyOf(ctx, preFix.agent), RESTRICTED_POLICY, 'negative control: without the replay an unseeded child loses the source policy')
      assert.deepEqual(policyOf(ctx, preFix.agent), { plan: false, sandbox: 'workspace-write', approval: 'ask', preset: 'workspace-write' }, 'negative control: it falls back to the deployment defaults')
      await sleep(250) // 固定窗:探针 — an absent artifact is already true, so the window is what makes the silence observable.
      assert.equal(existsSync(artifact(preFix.agent.session)), false, 'negative control: and it publishes nothing, so only the policy assertion can see the loss')
      console.log('PASS negative control: an unseeded child without the replay loses the source policy while publishing nothing')

      const started = await fresh('cut-pre-fix-started')
      title(started.agent.session, 'a replayed non-policy event')
      assert.equal(isUnstoredFreshSession(started.agent.session), false, 'negative control: a non-policy append starts the deferral')
      assert.ok(await settled(() => existsSync(artifact(started.agent.session))), 'negative control: and that replay publishes the shell')
      console.log('PASS negative control: replaying a non-policy cut event starts the deferral and publishes the shell')
    }
  } finally {
    for (const handle of handles) await handle.dispose()
    await ctx.fiber.dispose()
    rmSync(policyRoot, { recursive: true, force: true })
  }
}

try {
  const savedId = await verify('none')
  await verify('zstd')
  await verifyCutPolicyReplay()
  verifyHandoffs(savedId)
} finally {
  rmSync(root, { recursive: true, force: true })
}
