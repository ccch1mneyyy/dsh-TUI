/**
 * Startup and /new must not materialize permission-only DSH sessions.
 * Real AgentLoop, SessionStore and JSONL; scripted model, temporary HOME,
 * no network or credentials. Covers both JSONL encodings, suffix handoff,
 * write failure/retry, disposal, concurrent factories and saved history.
 * Restart/update cases spawn real replacements, parse the real Config and
 * create/resume through the real Agent registry; no installer is invoked.
 *
 * A flush is not a publication either: the host projection cache checkpoints a
 * session from its `session/created` hook and from its own event throttle, and
 * draining on those checkpoints re-materialized exactly the permission-only
 * shell the deferral keeps out of JSONL. The checkpoint still participates, and
 * the first real event still publishes the complete log from seq 0.
 *
 * The other side of the same shell is the SEED. The four channel actions that
 * create a child from a source prefix (`/model`, `/fork`, `/rewind`, `/tree`)
 * copied a source nobody had used, and the host stores a seed at publication
 * (`dsh-agent-loop` `appendUnstoredSuffix` → `writer.append`) — so the copy,
 * not a flush, is what puts the child's log on disk before its first real
 * event. Each of them now asks whether the CUT HOLDS NO CONVERSATION — the
 * slice the child actually inherits, never the session it was cut from: the
 * deferral's own `isUnstoredFreshSession` (`src/dsh-adapter/fresh-agent.ts`)
 * answers first for the live source, then the exit sweep's evidence rule
 * (`src/dsh-adapter/unspoken-sessions.ts`'s `conversationEvidence`, asked
 * through the exported `holdsNoConversation`) reads that slice. Judging the SOURCE left a hole
 * a rewind reaches: the first message's boundary is the seq before its
 * turn/start, and that turn opens behind the initialization `session/created`
 * wrote (seq 0-2), so a whole conversation can cut down to the initialization
 * alone while the source verdict says "seed it". The evidence rule is also what
 * an already-stored shell satisfies and the never-used shortcut cannot see: a
 * shell left by an earlier process, one web created, or one whose
 * `agent-preset/selected` already started the deferral. A cut that holds no
 * conversation starts an unseeded fresh session instead. Both halves are pinned
 * here: the creation shapes below drive the real host, `/fork` is driven end to
 * end from an on-disk shell, `/rewind` is driven end to end at both cut depths,
 * and `verifySeededWiring` reads the four actions to prove the cut verdict is
 * what selects the unseeded branch.
 *
 * A cut that holds no conversation is not an EMPTY inheritance. The session's
 * policy — plan mode, sandbox mode, approval policy and the durable permission
 * preset — lives in the same prefix, and the unseeded branch copies none of it,
 * so the child fell back to the deployment defaults and could end up with WIDER
 * permissions than the session it came from (CR-1). Each action therefore takes
 * the cut's last value per policy type (`latestPolicyFacts`) and replays those
 * facts into the unseeded child (`replayPolicyFacts`) AFTER the factory returns:
 * the deferral is armed by then, and those four types are exactly the ones it
 * holds back — any other type would start it and publish the shell. Inside
 * `setup` the same append would leave `seq !== 0` and the gate would refuse to
 * arm in silence (KNOWN-ISSUES B-14 ①), which is why the placement is pinned by
 * behaviour and not only by the wiring text. `verifyCutPolicyReplay` drives
 * that over real actions and reads the child's effective policy through the
 * services that enforce it.
 *
 * The gate itself has one precondition, and it is pinned here rather than
 * assumed: `fresh-agent.ts:72` returns SILENTLY unless the session is still at
 * `seq === 0` when `createFreshAgent`'s own setup resolves. A create whose
 * setup appends an event before resolving therefore skips the deferral and
 * stores the session immediately, with nothing above reddening. The production
 * shape appends nothing of its own — `composePreset` composes a setup that
 * awaits its mount and returns undefined (`presets.ts:70-72`) —
 * so `verifyGateInstalledShape` drives that shape and asserts the gate armed,
 * and `--negative-controls` replays the pre-append shape that skips it.
 * Throwing on that branch is deliberately NOT done: a setup that owns
 * pre-publication facts is a legitimate shape and the deferral has nothing to
 * say about it.
 *
 * Run: node --import tsx/esm scripts/verify-empty-session-persistence.ts
 *
 * Negative controls:
 *   1. In-process (re-runnable): add `--negative-controls`. It replays the
 *      pre-fix `guardedFlush` (start, drain the live snapshot, flush) on the
 *      same creation shape and asserts the shell DOES appear — the pair is what
 *      makes "the create-time checkpoint does not publish the permission-only
 *      shell" a discriminating assertion instead of a vacuous one. It also
 *      replays the pre-fix SEED for the same never-used sources, for an
 *      on-disk shell, and for a `/rewind` cut that reaches only the
 *      initialization (asserting that the child DOES appear and that the
 *      pre-fix notice DOES advertise a resume command), and reverses the four
 *      wiring checks four ways — `=> cutHoldsNoConversation` → `=> false`, the
 *      cut verdict put back on the SOURCE session, the never-used shortcut
 *      dropped, and the verdict dropped entirely — to prove those checks can
 *      fail (LESSONS L-044 / L-048).
 *   2. Real revert (flush): restore `start(); await drain()` at the head of
 *      `guardedFlush` in src/dsh-adapter/fresh-agent.ts, then
 *      `node --import tsx/esm scripts/verify-empty-session-persistence.ts`
 *      → expect FAIL "the create-time checkpoint does not publish the
 *      permission-only shell" (plus the two narrowed checkpoint cases).
 *   3. Real revert (seed): make one action seed unconditionally — e.g. in
 *      src/dsh-adapter/channel/model-switch.ts replace
 *      `=> cutHoldsNoConversation` with `=> false` — then the same command →
 *      expect FAIL "channel-model-switch: the cut verdict selects the unseeded
 *      branch". The creation-shape cases stay green there: they drive the
 *      creation, the wiring check reads the action.
 *   4. Real revert (verdict narrowed): put the widening back to T-FIX-10's
 *      criterion in src/dsh-adapter/channel/session-fork.ts — replace the two
 *      lines `seed = isUnstoredFreshSession(source) ? [] : sliceLiveSessionSeed(source)`
 *      + `if (holdsNoConversation(seed)) seed = []` with
 *      `seed = isUnstoredFreshSession(source) ? [] : sliceLiveSessionSeed(source)`
 *      — then the same command → expect FAIL "the fork notice for a
 *      conversation-less source is the new-session wording", FAIL "the /fork
 *      action took its unseeded branch for an on-disk shell" and FAIL "a fork
 *      of an on-disk shell publishes no child", plus the
 *      `channel-session-fork` wiring FAIL. The creation-shape cases stay green
 *      there too.
 *   5. Real revert (T-FIX-12, the cut judged by its source): in
 *      src/dsh-adapter/channel/session-rewind.ts restart the verdict from the
 *      source session — replace
 *      `if (holdsNoConversation(seed)) seed = []`
 *      with
 *      `if (holdsNoConversation(snapshotLiveSessionEvents(source))) seed = []`
 *      — then the same command → expect FAIL "a cut that holds no conversation
 *      takes the unseeded branch", FAIL "and leaves no log on disk", and the
 *      `channel-session-rewind` wiring FAIL. `--negative-controls` carries the
 *      same reversal textually for all four sites and replays its DECISION
 *      behaviourally (`PASS negative control: the source verdict seeds the
 *      policy-only cut into a published shell`).
 *   6. Real revert (gate shape): give `verifyGateInstalledShape`'s `setup` an
 *      append before it resolves — e.g. `agent.session.append('session/title',
 *      { title: 'appended before the commit', messageSeqs: [], source: { kind:
 *      'user' } })` — then the same command → expect FAIL "the production
 *      create shape arms the deferral gate (its setup resolves without
 *      appending)". `--negative-controls` replays that shape behaviourally
 *      (`PASS negative control: an append before the setup resolves skips the
 *      deferral in silence`).
 *   7. Real revert (policy replay): drop it from one action — e.g. in
 *      src/dsh-adapter/channel/model-switch.ts replace
 *      `if (cutHoldsNoConversation) replayPolicyFacts(handle.agent.session, policyFacts)`
 *      with `void policyFacts` — then the same command → expect FAIL "(A) the
 *      unseeded /model child keeps the source policy" while the "has no log"
 *      assertions stay GREEN: losing the policy and publishing the shell are
 *      separately visible failure modes. Replaying the WHOLE cut instead of the
 *      four policy types is the other mode — the child is published, and the
 *      "no log" assertion fails while the policy one passes.
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
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Approval, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
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
const { createFreshAgent, isUnstoredFreshSession, INITIAL_POLICY_EVENTS } = await import('../src/dsh-adapter/fresh-agent.js')
const { createChannel } = await import('../src/dsh-adapter/channel.js')
const { createForkSessionAction } = await import('../src/dsh-adapter/channel/session-fork.js')
const { createRewindToAction } = await import('../src/dsh-adapter/channel/session-rewind.js')
const { dshHandleOf } = await import('../src/dsh-adapter/backend/session.js')
const { extractEntries, rewindTarget } = await import('../src/dsh-adapter/sessionTree.js')
const { isExitResumable } = await import('../src/dsh-adapter/plugin.js')
const { concreteService } = await import('../src/dsh-adapter/host-access.js')
const { liveSessionCreateOptions } = await import('../src/dsh-adapter/compat/index.js')
const { holdsNoConversation } = await import('../src/dsh-adapter/unspoken-sessions.js')
const { foldPermissionPreset } = await import('../src/dsh-adapter/channel/mode-permission.js')
const { t } = await import('../src/i18n.js')

const negativeControls = process.argv.includes('--negative-controls')

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

/**
 * The four enforcement-relevant policy atoms of one live session — plan mode,
 * sandbox mode, approval policy and the durable permission preset — read
 * through the services that ENFORCE them (`ctx.planMode`, `ctx.sandboxPolicy`,
 * `ctx.approval`, and the channel's own preset fold) rather than restated here.
 * CR-1 / T-FIX-17 is about exactly these four: a child created without a seed
 * falls back to the deployment defaults, which may be WIDER than the session
 * it came from.
 */
type PolicyReading = Record<'plan' | 'sandbox' | 'approval' | 'preset', unknown>
function policyOf(ctx: Context, agent: Agent): PolicyReading {
  return {
    plan: ctx.planMode.get(agent).active,
    sandbox: ctx.sandboxPolicy.overrideOf(agent.session),
    approval: ctx.approval.overrideOf(agent.session),
    preset: foldPermissionPreset(agent.session.snapshotEvents()),
  }
}

/** The non-default policy every CR-1 fixture switches its source into. */
const RESTRICTED_POLICY: PolicyReading = { plan: true, sandbox: 'read-only', approval: 'never', preset: 'read-only' }

/** Switch one session into that policy, through each service's own write path. */
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
    // Reproduce the official permission service's session/created pinning, plus
    // the host projection cache's create-time checkpoint: both are listeners of
    // the same event, and the cache's `flushSoft('create')` reaches
    // `ctx.sessions.flush(session)` from inside the creation transaction.
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
        // Pre-fix `guardedFlush`: start(), drain the live snapshot, then flush.
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
    // Informational: a listener on a foreign fiber still observes a deferred
    // session (the gate only mutes the JSONL provider's own routing), which is
    // why the cache's event throttle also reaches the gate.
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

    // A checkpoint is not a publication: the host projection cache checkpoints
    // from `session/created` (and from its event throttle) while the session
    // still holds only initialization, so draining there re-materialized the
    // exact shell the deferral keeps out of JSONL. The checkpoint still
    // participates — callers keep observing a durability listener — and the
    // first real event still publishes the complete log from seq 0.
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

      // The five channel actions that reached `agents.create` directly.
      // `/bg` starts an unseeded session, so it shares the gate: its creation
      // shape stays unpublished while idle, and the same shape without the gate
      // still publishes (this pair is what makes the case discriminative).
      const backgrounded = await fresh('channel-background-action')
      await sleep(250) // 固定窗:探针 — an absent artifact is already true, so polling it proves nothing; the window (250ms > the JSONL 200ms batch timer) is what makes the checkpoint's silence observable.
      assert.equal(existsSync(artifact(backgrounded.agent.session)), false, 'the /bg creation shape stays unpublished while idle')
      const ungated = await ctx.agents.create(options('channel-background-action-ungated'))
      handles.push(ungated)
      assert.ok(await settled(() => existsSync(artifact(ungated.agent.session))), 'the ungated /bg shape still publishes the shell')
      await ungated.dispose()

      // The other four channel actions (`/model`, `/fork`, `/rewind`, `/tree`)
      // copy a source prefix into the child, and the host appends that prefix
      // through the writer BEFORE `session/created` (dsh-agent-loop
      // `appendUnstoredSuffix` → writer.append → the JSONL backend materializes
      // on the first batch), so a flush-side gate cannot unmake a seeded child's
      // artifact: the file IS the inherited prefix. They are covered by
      // `verifySeededFamily` below, which is about the SOURCE they copy from.

      // Negative control (--negative-controls): replay the pre-fix
      // `guardedFlush` — start, drain the live snapshot, flush — for the same
      // creation shape and assert the shell DOES materialize.
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

    /**
     * A permission switch is session policy, not conversation.
     *
     * Measured on a real tree (2026-10-10): an idle fresh session that only
     * switched its permission preset published an 11-event shell — `command/run`
     * + `command/done` (the registry command `mode-permission.ts` drives the
     * switch through) and the `agent/inbox/spliced` approval notice it leaves —
     * because those types are not initialization atoms, so the deferral started
     * on the first of them. The stored shell is exactly the 「未命名」 row this
     * change exists to remove, so the policy plane (atoms AND the command
     * envelope / inbox notice a policy switch leaves behind) must stay deferred.
     *
     *  (a) the switch alone publishes nothing;
     *  (b) a HUMAN message in the same session still publishes — the gate is
     *      live, the classification is what changed;
     *  (c) `INITIAL_POLICY_EVENTS` alone cannot express (a): every envelope type
     *      below is outside it, which is why the old rule leaked;
     *  (d) `--negative-controls` creates the same envelope WITHOUT the gate: the
     *      events are storable, so (a) is the gate's doing and not a fixture that
     *      cannot be written at all.
     */
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

    /**
     * The deferral is armed from `createFreshAgent`'s own setup, and
     * `fresh-agent.ts:72` returns SILENTLY unless the session is still at
     * `seq === 0` when that setup resolves. The production shape meets that
     * precondition — `composePreset` composes a setup that awaits its mount and
     * returns undefined, and the composed factory appends nothing of its own —
     * so a session created in that shape must come out already unstored. None
     * of the cases above would redden if the gate silently stopped arming: a
     * setup that appends first stores the session immediately and leaves every
     * assertion there untouched.
     */
    const verifyGateInstalledShape = async (): Promise<void> => {
      const shaped = await createFreshAgent(ctx, ctx.agents, {
        ...options('production-shape'),
        setup: async () => {
          // `composePreset`'s composed setup: awaits the mount, returns no commit.
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

      // Negative control (--negative-controls): the KNOWN BOUNDARY replayed.
      // The same create with a setup that appends BEFORE it resolves leaves
      // `seq !== 0` behind `fresh-agent.ts:72`; the gate is skipped in silence
      // and the session is stored without ever being marked unstored.
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

    /**
     * The SEEDED family (`/model`, `/fork`, `/rewind`, `/tree`). Each of the
     * four copies a source prefix into a child, and the host stores a seed at
     * publication — the copy, not a flush, is what materializes the child. The
     * cases below drive BOTH shapes on real sources:
     *
     *  (a) a never-used source (`isUnstoredFreshSession` true) and the unseeded
     *      shape the action now takes: the create-time checkpoint still fires
     *      and the child's log must NOT appear until a real event, which then
     *      publishes it completely from seq 0;
     *  (b) a used source and the unchanged seeded shape: the whole prefix is
     *      copied and the child's log is complete at publication.
     *
     * `verifySeededWiring` pins which shape each action takes; these two halves
     * together are what make the pair discriminating.
     */
    const verifySeededFamily = async (): Promise<void> => {
      const unusedSource = await fresh('channel-seed-unused-source')
      assert.equal(isUnstoredFreshSession(unusedSource.agent.session), true, 'an untouched fresh session is the never-used verdict the four actions key on')
      const unusedSeed = unusedSource.agent.session.snapshotEvents()
      assert.deepEqual(unusedSeed.map(event => event.type), policyTypes, 'a never-used source holds initialization only')

      // Boundary of this change's coverage, asserted rather than argued: the
      // `/rewind` and `/tree` branches below are defense-in-depth while a
      // never-used source cannot be reached by either. Chat.tsx's rewind list
      // is human `user` rows only, and a tree entry comes from `extractEntries`
      // — both need real content, so a never-used source offers neither. If a
      // future projection starts offering one, this fails first and the two
      // branches need reachable coverage of their own — `/rewind` already has
      // it (`verifyCutPrefixSeeding` drives the real action end to end).
      const unusedChannel = createChannel(ctx, unusedSource.agent, { handle: unusedSource, cwd: root, provider: 'scripted', model: 'scripted', activity: false })
      try {
        assert.equal(unusedChannel.rows.filter(row => row.kind === 'user' && row.label === undefined).length, 0, 'a never-used source offers no /rewind candidate (Chat.tsx rewindRows)')
      } finally { unusedChannel.releaseContributions() }
      assert.equal(extractEntries(String(unusedSource.agent.session.id), unusedSeed).length, 0, 'a never-used source offers no /tree entry to rewind or fork from')
      assert.equal(isUnstoredFreshSession(unusedSource.agent.session), true, 'mounting a channel over the source does not use it up')

      const usedSource = await fresh('channel-seed-used-source')
      const usedChannel = createChannel(ctx, usedSource.agent, { handle: usedSource, cwd: root, provider: 'scripted', model: 'scripted', activity: false })
      try {
        usedChannel.submit('a real prompt')
        assert.ok(await settled(() => usedChannel.rows.some(row => row.text === 'saved reply') && !usedChannel.working))
      } finally { usedChannel.releaseContributions() }
      await ctx.sessions.flush(usedSource.agent.session)
      assert.equal(isUnstoredFreshSession(usedSource.agent.session), false, 'a source with a real event is no longer never-used')
      const usedSeed = usedSource.agent.session.snapshotEvents()
      assert.ok(usedSeed.some(event => event.type === 'turn/start'), 'the used source holds a turn')
      assert.ok(usedSeed.some(event => event.type === 'user/message'), 'the used source holds the human prompt that started it')

      const sites: readonly { readonly name: string; readonly parentSession: SessionId | undefined }[] = [
        { name: 'channel-model-switch', parentSession: undefined },
        { name: 'channel-session-fork', parentSession: undefined },
        { name: 'channel-session-rewind', parentSession: usedSource.agent.session.id },
        { name: 'channel-session-tree-actions', parentSession: usedSource.agent.session.id },
      ]
      for (const site of sites) {
        // (a) The branch a never-used source takes: unseeded, and created
        // through the fresh-session gate (the shape `/new` and `/bg` use).
        const childId = SessionId(`${site.name}-unused`)
        createFlushes.add(String(childId))
        const child = await createFreshAgent(ctx, ctx.agents, {
          sessionId: childId,
          meta: { cwd: root },
          agentOptions: { provider: 'scripted', model: 'scripted' },
        })
        handles.push(child)
        await sleep(250) // 固定窗:探针 — beyond JSONL's 200ms live drain timer.
        assert.equal(existsSync(artifact(child.agent.session)), false, `${site.name}: a never-used source publishes no child`)
        assert.equal(isUnstoredFreshSession(child.agent.session), true, `${site.name}: the child starts as an unstored fresh session`)
        assert.deepEqual(child.agent.session.snapshotEvents().map(event => event.type), policyTypes, `${site.name}: the child starts from its own initialization`)
        title(child.agent.session, 'first real event')
        await ctx.sessions.flush(child.agent.session)
        assert.deepEqual((await stored(child.agent.session)).map(event => event.seq), [0, 1, 2, 3], `${site.name}: the child publishes completely from seq 0`)
        await assertComplete(child.agent.session)

        // (b) A source with real events keeps the unchanged branch: the prefix
        // is copied, and the create-time checkpoint adds nothing to it.
        const seededId = SessionId(`${site.name}-used`)
        createFlushes.add(String(seededId))
        const seeded = await ctx.agents.create(liveSessionCreateOptions({
          sessionId: seededId,
          seed: usedSeed,
          runtimeSession: usedSource.agent.session,
          inheritedCount: usedSeed.length,
          cwd: root,
          ...(site.parentSession === undefined ? {} : { parentSession: site.parentSession }),
          agentOptions: { provider: 'scripted', model: 'scripted' },
        }))
        handles.push(seeded)
        await sleep(250) // 固定窗:墙钟 — the host-appended prefix reaches disk only when the JSONL 200ms batch drain fires; the read-back below compares that file.
        const persisted = await stored(seeded.agent.session)
        assert.deepEqual(persisted.slice(0, usedSeed.length), usedSeed, `${site.name}: a used source still copies its whole prefix`)
        assert.deepEqual(persisted, seeded.agent.session.snapshotEvents(), `${site.name}: the seeded child stores exactly its own log`)
        assert.deepEqual(persisted.slice(0, 3).map(event => event.type), policyTypes, `${site.name}: no create-time checkpoint adds a suffix to the seeded child`)

        // Negative control (--negative-controls): the pre-fix DECISION for the
        // same never-used source — copy its initialization anyway. The host
        // stores a seed at publication, so the child's log appears; this is the
        // revert the wiring checks above refuse to let back in.
        if (negativeControls) {
          const preFix = await ctx.agents.create(liveSessionCreateOptions({
            sessionId: SessionId(`${site.name}-pre-fix-seed`),
            seed: unusedSeed,
            runtimeSession: unusedSource.agent.session,
            inheritedCount: unusedSeed.length,
            cwd: root,
            agentOptions: { provider: 'scripted', model: 'scripted' },
          }))
          handles.push(preFix)
          assert.equal(existsSync(artifact(preFix.agent.session)), true, `negative control: seeding a never-used source publishes the ${site.name} child`)
          console.log(`PASS negative control: seeding a never-used source publishes the ${site.name} child`)
        }
      }
    }
    await verifySeededFamily()

    /**
     * The face T-FIX-10's verdict could not see: a shell that is ALREADY on
     * disk. `isUnstoredFreshSession` answers for the deferral THIS process
     * installed, so a shell left behind by an earlier process — or one whose
     * `agent-preset/selected` already started the gate, or one web created — is
     * not in its WeakSet. The widened verdict asks what the source's log holds
     * instead, from the live snapshot in hand.
     *
     * The real `/fork` action is driven here, not just the creation shape it
     * takes: its notice is the user-facing half of the same decision, and a
     * seeded child would publish an artifact. Narrowing the verdict back to
     * `isUnstoredFreshSession` therefore reddens this case on all three counts.
     * The same action is then driven over a source that HAS content, which must
     * keep the seeded path exactly as it was.
     */
    const verifyOnDiskShellSource = async (): Promise<void> => {
      const shell = await ctx.agents.create(options('on-disk-shell'))
      handles.push(shell)
      assert.ok(await settled(() => existsSync(artifact(shell.agent.session))), 'the ungated shell publishes at creation')
      await shell.dispose()
      const resumed = await ctx.agents.resume({ resumeSessionId: options('on-disk-shell').sessionId })
      handles.push(resumed)
      const shellEvents = resumed.agent.session.snapshotEvents()
      // The shell's log is the shape an earlier process leaves behind: the
      // initialization it was created with (plus the constructor's own
      // `session/end-seed`), and nothing a person ever said.
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

      // (a) A shell on disk: no notice may promise a resume, and no child log
      // may exist before the child's own first real event.
      const childId = await driveFork()
      const child = forks[0]!
      assert.equal(isUnstoredFreshSession(child.agent.session), true, 'the /fork action took its unseeded branch for an on-disk shell')
      assert.equal(existsSync(artifact(child.agent.session)), false, 'a fork of an on-disk shell publishes no child')
      const notice = notices.at(-1) ?? ''
      assert.equal(notice, t('fork-done-unstored', { id: childId }), 'the fork notice for a conversation-less source is the new-session wording')
      assert.equal(notice.includes('--resume'), false, 'a fork of a conversation-less source must not print a --resume command')
      assert.equal(notice.includes('DSH_TUI_RESUME_SESSION'), false, 'nor the POSIX resume form')

      // (b) The other direction at the same level: a source WITH content keeps
      // the seeded branch — a widening that swallowed every source would fail
      // here, and the copied prefix is still byte for byte the source log.
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
        // The pre-fix DECISION for the same on-disk shell: copy its
        // initialization into a child and advertise the resume command. Both
        // assertions above must be able to see this (L-044 / L-048).
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

    /**
     * The CUT the verdict now judges, driven through the real `/rewind` action.
     * T-FIX-11 asked whether the SOURCE SESSION holds a conversation, and a
     * rewind boundary can stop before every real event: the first message's
     * boundary is the seq before its turn/start, and that turn opens behind the
     * initialization `session/created` wrote (seq 0-2). A source that holds a
     * whole conversation can therefore cut down to a prefix with no evidence in
     * it, and the source verdict seeded that prefix — the host stores a seed at
     * publication, so the child's log existed before its first real event: the
     * permission-only shell, by the one road the source verdict could not see.
     *
     * The source conversation is written in the durable `user/message` form
     * `conversationEvidence` also counts (`digest.ts:66-98`), not through this
     * host's inbox. A live prompt is preceded by its own `agent/inbox/spliced`,
     * and that splice carries the human message — as evidence it fills the
     * first-message cut, which is why the fixture writes the durable form a
     * foreign or older writer leaves. The verdict must judge that cut, not the
     * session it was cut from.
     *
     *  (a) rewind to the first message: the cut is the initialization alone, so
     *      the child must be unseeded, must leave no log, and no notice may
     *      offer a resume command for a session that has none;
     *  (b) rewind to the second message: the cut holds the first turn, so the
     *      branch is unchanged and the copied prefix is byte for byte the cut.
     *
     * `--negative-controls` replays the pre-fix DECISION on the same cut (seed
     * it, as the source verdict did), so "no log" in (a) is a discriminating
     * assertion rather than a vacuous one (L-044 / L-048).
     */
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
      /** The child's live session, through the handle its adoption kept. */
      const liveOf = (candidate: AgentSession) => dshHandleOf(candidate).agent.session
      try {
        const events = source.agent.session.snapshotEvents()
        assert.ok(await settled(() => rewindRows().length === 2), 'the conversation offers both prompts as rewind rows')
        const rows = rewindRows()
        assert.equal(events[rows[0]!.seq!]!.type, 'user/message', 'a rewind row carries its own message seq')
        assert.equal(isUnstoredFreshSession(source.agent.session), false, 'the rewind source is a used session — the source verdict alone would seed it')
        assert.ok(events.some(event => event.type === 'turn/start' && event.seq > 0), 'the conversation opens behind the initialization (otherwise its first message could not be rewound at all)')

        // (a) The first message: the cut stops before its turn/start, so it is
        // the initialization alone while the source is a whole conversation.
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

        // (b) The second message: the cut still holds the whole first turn, so
        // the branch is the unchanged one, prefix included.
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
          // The pre-fix DECISION for the same cut: the source holds a
          // conversation, so the source verdict seeded the initialization-only
          // prefix — and the host stores a seed at publication, so the shell
          // appeared. (a) asserts exactly what this produces.
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

/**
 * `/bg` is the one channel create that starts an unseeded session, so it is the
 * one that can share the gate. The shape checks above drive `createFreshAgent`
 * directly and would stay green if the action went back to the ungated factory,
 * so pin the wiring itself.
 */
function verifyChannelWiring(): void {
  const source = readFileSync(new URL('../src/dsh-adapter/channel/background-action.ts', import.meta.url), 'utf8')
  assert.match(source, /import \{ createFreshAgent \} from '\.\.\/fresh-agent\.js'/, '/bg imports the fresh-session gate')
  assert.match(source, /createFreshAgent\(ctx, agents, \{/, '/bg creates through the gate')
  assert.equal(source.includes('agents.create('), false, '/bg no longer calls the ungated factory')
  console.log('PASS /bg creation wiring')
}

/**
 * The four seeded channel actions. `verifySeededFamily` drives the creation
 * SHAPES through the real host, `verifyOnDiskShellSource` drives `/fork` itself,
 * `verifyCutPrefixSeeding` drives `/rewind` itself and `verifyCutPolicyReplay`
 * drives the real `/model` and `/fork` over a source in a non-default policy;
 * the SHAPES alone would stay green if an action went back to seeding
 * unconditionally, because they drive the creation rather than the action. So
 * pin the wiring: each action must cut the seed first, ask the CUT verdict —
 * the deferral's `isUnstoredFreshSession` where it can answer, then the sweep's
 * evidence rule over that slice — let THAT verdict select the unseeded branch,
 * and replay the cut's policy facts into that branch AFTER the factory returns
 * (never inside `setup`, where the deferral would silently not arm). Every
 * marker is guarded (a missing or reordered marker fails instead of passing on
 * an empty window — LESSONS L-048), and `--negative-controls` reverses the
 * decision to prove the checks can fail (L-044): seeded unconditionally, the
 * verdict put back on the SOURCE session, the never-used shortcut dropped, the
 * verdict dropped, the policy replay dropped, the facts never read from the
 * cut, and `/fork`'s notice reverting to an advertised resume command.
 */

/** The one line every site must carry: the verdict asks the CUT, never the source. */
const CUT_EVIDENCE = 'holdsNoConversation(cut)'

/** The one line that turns a conversation-less cut's policy facts into the child's. */
const POLICY_FACTS = 'const policyFacts = cutHoldsNoConversation ? latestPolicyFacts(cut) : []'

const SEEDED_SITES: readonly {
  readonly name: string
  readonly file: string
  /** The live snapshot each site judged before T-FIX-12, for the "back to the source" reversal. */
  readonly sourceEvents: string
  /** The session expression the never-used shortcut reads, for the "shortcut dropped" reversal. */
  readonly subject: string
  /** The site's own replay call, for the "replay dropped" reversal. */
  readonly replay: string
  /** A notice line, when the site has one, for the "resume command is back" reversal. */
  readonly notice?: string
  readonly markers: readonly string[]
}[] = [
  {
    name: 'channel-model-switch',
    file: 'model-switch.ts',
    sourceEvents: 'snapshotLiveSessionEvents(source)',
    subject: 'source',
    replay: 'if (cutHoldsNoConversation) replayPolicyFacts(handle.agent.session, policyFacts)',
    markers: [
      'const neverUsed = isUnstoredFreshSession(source)',
      'cut = neverUsed ? snapshotLiveSessionEvents(source) : sliceLiveSessionSeed(source)',
      `seed = neverUsed || ${CUT_EVIDENCE} ? [] : cut`,
      'const cutHoldsNoConversation = seed.length === 0',
      POLICY_FACTS,
      'const create = (): Promise<AgentHandle> => cutHoldsNoConversation',
      '? createFreshAgent(ctx, agents, {',
      ': agents.create(liveSessionCreateOptions({',
      'const handle = await create()',
      'if (cutHoldsNoConversation) replayPolicyFacts(handle.agent.session, policyFacts)',
      'return createDshSession(ctx, handle)',
    ],
  },
  {
    name: 'channel-session-fork',
    file: 'session-fork.ts',
    sourceEvents: 'snapshotLiveSessionEvents(source)',
    subject: 'source',
    replay: 'if (cutHoldsNoConversation) replayPolicyFacts(detached.handle.agent.session, policyFacts)',
    notice: "? t('fork-done-unstored', { id: String(childId) })",
    markers: [
      'const neverUsed = isUnstoredFreshSession(source)',
      'cut = neverUsed ? snapshotLiveSessionEvents(source) : sliceLiveSessionSeed(source)',
      `seed = neverUsed || ${CUT_EVIDENCE} ? [] : cut`,
      'const cutHoldsNoConversation = seed.length === 0',
      POLICY_FACTS,
      'deps.createDetachedHandle(() => cutHoldsNoConversation',
      '? createFreshAgent(ctx, agents, {',
      ': agents.create(liveSessionCreateOptions({',
      'if (cutHoldsNoConversation) replayPolicyFacts(detached.handle.agent.session, policyFacts)',
      "? t('fork-done-unstored', { id: String(childId) })",
    ],
  },
  {
    name: 'channel-session-rewind',
    file: 'session-rewind.ts',
    sourceEvents: 'snapshotLiveSessionEvents(source)',
    subject: 'source',
    replay: 'if (cutHoldsNoConversation) replayPolicyFacts(handle.agent.session, policyFacts)',
    markers: [
      'const neverUsed = isUnstoredFreshSession(source)',
      'cut = neverUsed ? snapshotLiveSessionEvents(source) : sliceLiveSessionSeed(source, boundary)',
      `seed = neverUsed || ${CUT_EVIDENCE} ? [] : cut`,
      'const cutHoldsNoConversation = seed.length === 0',
      POLICY_FACTS,
      'const create = (): Promise<AgentHandle> => cutHoldsNoConversation',
      '? createFreshAgent(ctx, agents, {',
      ': agents.create(liveSessionCreateOptions({',
      'const handle = await create()',
      'if (cutHoldsNoConversation) replayPolicyFacts(handle.agent.session, policyFacts)',
      'return createDshSession(ctx, handle)',
    ],
  },
  {
    name: 'channel-session-tree-actions',
    file: 'session-tree-actions.ts',
    sourceEvents: 'sourceEvents',
    subject: 'entrySession',
    replay: 'if (cutHoldsNoConversation) replayPolicyFacts(handle.agent.session, policyFacts)',
    markers: [
      'const cut = sourceEvents.filter(event => event.seq <= target.boundary)',
      // The never-used shortcut still answers first, but only for the LIVE
      // source (the deferral is this process's own bookkeeping): the evidence
      // rule below reads the CUT for a persisted foreign source too.
      'const neverUsed = forkFromLive && isUnstoredFreshSession(entrySession)',
      `const seed = neverUsed || ${CUT_EVIDENCE} ? [] : cut`,
      'const cutHoldsNoConversation = seed.length === 0',
      POLICY_FACTS,
      'const create = (): Promise<AgentHandle> => cutHoldsNoConversation',
      '? createFreshAgent(ctx, agents, {',
      ': agents.create(liveSessionCreateOptions({',
      'const handle = await create()',
      'if (cutHoldsNoConversation) replayPolicyFacts(handle.agent.session, policyFacts)',
      'return createDshSession(ctx, handle)',
    ],
  },
]

/** Every wiring violation of one site's source text, in reading order. */
function seededWiringViolations(
  site: (typeof SEEDED_SITES)[number],
  source: string,
): string[] {
  const violations: string[] = []
  if (!/import \{ createFreshAgent, isUnstoredFreshSession \} from '\.\.\/fresh-agent\.js'/.test(source)) {
    violations.push('does not import createFreshAgent + isUnstoredFreshSession')
  }
  // Co-imports are allowed (and now present): all three cut helpers must come
  // from the one module that owns them.
  if (!/import \{[^}]*\bholdsNoConversation\b[^}]*\blatestPolicyFacts\b[^}]*\breplayPolicyFacts\b[^}]*\} from '\.\.\/unspoken-sessions\.js'/.test(source)) {
    violations.push('does not ask the cut criterion and replay the cut policy through unspoken-sessions.ts')
  }
  let cursor = -1
  for (const marker of site.markers) {
    const at = source.indexOf(marker)
    if (at === -1) { violations.push(`missing: ${marker}`); continue }
    if (at <= cursor) violations.push(`out of order: ${marker}`)
    cursor = at
  }
  return violations
}

function verifySeededWiring(): void {
  for (const site of SEEDED_SITES) {
    const path = new URL(`../src/dsh-adapter/channel/${site.file}`, import.meta.url)
    const source = readFileSync(path, 'utf8')
    assert.deepEqual(seededWiringViolations(site, source), [], `${site.name}: the cut verdict selects the unseeded branch and its policy facts reach the child`)
    if (negativeControls) {
      // The reversals this task forbids — seed unconditionally, put the verdict
      // back on the SOURCE session, drop the never-used shortcut, drop the
      // verdict, drop the policy replay (and read no facts from the cut), and
      // put the resume command back in `/fork`'s notice. Every one must be
      // caught (L-044 / L-048). For `/model` and `/fork` the source form
      // denotes the same events as the cut (their cut IS the whole log), so
      // that reversal is a text-level one there; the behavioural proof lives in
      // `verifyCutPrefixSeeding`'s pre-fix replay.
      const unconditional = seededWiringViolations(site, source.replaceAll('=> cutHoldsNoConversation', '=> false'))
      assert.ok(unconditional.length > 0, `negative control: ${site.name} wiring catches seeding unconditionally`)
      const sourceJudged = seededWiringViolations(site, source.replace(CUT_EVIDENCE, `holdsNoConversation(${site.sourceEvents})`))
      assert.ok(sourceJudged.length > 0, `negative control: ${site.name} wiring catches the cut verdict narrowed back to the source session`)
      const shortcutless = seededWiringViolations(site, source.replaceAll(`isUnstoredFreshSession(${site.subject})`, 'false'))
      assert.ok(shortcutless.length > 0, `negative control: ${site.name} wiring catches a dropped never-used shortcut`)
      const verdictless = seededWiringViolations(site, source.replace(CUT_EVIDENCE, 'true'))
      assert.ok(verdictless.length > 0, `negative control: ${site.name} wiring catches a dropped verdict`)
      const replayless = seededWiringViolations(site, source.replace(site.replay, 'void policyFacts'))
      assert.ok(replayless.length > 0, `negative control: ${site.name} wiring catches a dropped policy replay`)
      const factless = seededWiringViolations(site, source.replace(POLICY_FACTS, 'const policyFacts: readonly unknown[] = []'))
      assert.ok(factless.length > 0, `negative control: ${site.name} wiring catches policy facts that are never read from the cut`)
      const notice = site.notice === undefined
        ? []
        : seededWiringViolations(site, source.replace(site.notice, "t('fork-done', { id: String(childId), command })"))
      if (site.notice !== undefined) {
        assert.ok(notice.length > 0, `negative control: ${site.name} wiring catches a notice that advertises a resume command again`)
      }
      console.log(`PASS negative control: ${site.name} wiring catches "seed unconditionally", the verdict back on the source session, a dropped never-used shortcut, a dropped verdict, a dropped policy replay and cut facts that are never read${site.notice === undefined ? '' : ', and the resume notice coming back'}`)
    }
    console.log(`PASS ${site.name} seeded wiring`)
  }
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

/**
 * CR-1 / T-FIX-17: the POLICY FACTS a conversation-less cut carries.
 *
 * "This cut holds no conversation" is not "this cut holds nothing". The
 * source's plan mode, sandbox mode, approval policy and durable permission
 * preset live in the same prefix, and the unseeded branch copies none of it —
 * a child that falls back to the deployment defaults can end up with WIDER
 * permissions than the session it came from. That is the regression
 * CodeRabbit reported against the T-FIX-10/12 decision, and the reason the
 * four actions replay the cut's policy facts before the child's first prompt.
 *
 * Every case drives a REAL action (the channel's `/model`, the `/fork` action)
 * over a source in a NON-DEFAULT policy and reads the child's effective policy
 * through the services that ENFORCE it (`ctx.planMode`, `ctx.sandboxPolicy`,
 * `ctx.approval`, the channel's preset fold) — never by restating their folds.
 * The source reading is pinned to `RESTRICTED_POLICY` first, so "the child
 * equals the source" cannot pass vacuously, and each case also asserts the
 * child stays unpublished: a replay that appended anything the deferral does
 * NOT ignore would start it and publish the very shell the unseeded branch
 * exists to avoid (`fresh-agent.ts`'s `INITIAL_POLICY_EVENTS` is the whole
 * reason appending those four types is safe — which is also why the replay
 * must run AFTER the factory returns; inside `setup` a `seq !== 0` session
 * makes the gate return in silence, KNOWN-ISSUES B-14 ①).
 *
 * The context is this case's own: the policy services contribute runtime
 * context to every request (the agent loop logs that snapshot as model
 * history), which would add a `user/message` to the cases above.
 */
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
    // The official permission service's `session/created` pinning, plus the
    // host projection cache's create-time checkpoint: every session starts
    // from the same three deployment defaults and is checkpointed at once.
    // The checkpoint is not a publication — the child must survive it.
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

    // (A) `/model` over a never-used source: its cut is the policy alone.
    const unused = await fresh('cut-model-source')
    restrictPolicy(ctx, unused.agent)
    assert.deepEqual(policyOf(ctx, unused.agent), RESTRICTED_POLICY, '(A) the source is in a non-default policy')
    assert.equal(isUnstoredFreshSession(unused.agent.session), true, '(A) and nobody has used it — the never-used verdict still answers')
    assert.equal(holdsNoConversation(unused.agent.session.snapshotEvents()), true, '(A) its cut holds no conversation: the CR-1 shape')
    const modelChannel = createChannel(ctx, unused.agent, { handle: unused, cwd: policyRoot, provider: 'scripted', model: 'scripted', activity: false })
    try {
      assert.equal(await modelChannel.switchModel('scripted', 'scripted'), true, '(A) the /model action completes')
      const child = ctx.agents.get(SessionId(modelChannel.agentId))
      assert.ok(child !== undefined && child.session.id !== unused.agent.session.id, '(A) the switch adopted a replacement session')
      assert.deepEqual(policyOf(ctx, child), RESTRICTED_POLICY, '(A) the unseeded /model child keeps the source policy')
      assert.equal(isUnstoredFreshSession(child.session), true, '(A) and it is still unpublished')
      await sleep(250) // 固定窗:探针 — beyond JSONL's 200ms live drain timer.
      assert.equal(existsSync(artifact(child.session)), false, '(A) the child has no log before its first real event')
      modelChannel.submit('first real prompt')
      assert.ok(await settled(() => modelChannel.rows.some(row => row.text === 'saved reply') && !modelChannel.working), '(A) the child runs its first turn')
      await ctx.sessions.flush(child.session)
      const published = await stored(child.session)
      assert.deepEqual(published.map(event => event.seq), published.map((_, index) => index), '(A) the published log is contiguous from seq 0')
      assert.deepEqual(policyOf(ctx, child), RESTRICTED_POLICY, '(A) and the published child still carries the source policy')
      console.log('PASS CR-1 /model: an unseeded child keeps the source policy, and the deferral survives the replay')
    } finally { modelChannel.releaseContributions() }

    // (B) `/fork` over a TITLED SHELL: not never-used, yet its cut still holds
    // no conversation — the face only the cut criterion can answer (T-FIX-12's
    // widening). The same action over a source that DOES hold a conversation
    // must keep the seeded branch, policy included.
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
          // The child stays LIVE here on purpose: the action replays the cut's
          // policy facts only after this factory returns, so a reading taken
          // inside it would see the child before the replay. The real
          // implementation disposes the handle right after the action, and
          // `verifyOnDiskShellSource` covers that shape end to end.
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

    // (D) `/rewind` to the first message of a hand-written conversation: the
    // boundary stops before its `turn/start`, so the cut is the policy atoms
    // alone. Written in the durable `user/message` form a foreign writer leaves
    // — a live prompt carries its own `agent/inbox/spliced` before the turn,
    // and that splice IS human evidence filling the first-message cut.
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
      // The pre-fix DECISION for the same policy-only cut: an unseeded child
      // and no replay at all. Its policy falls back to the deployment defaults
      // — and it still publishes nothing, which is why the policy assertion
      // above is not vacuous, and why the two failure modes ("the policy was
      // lost" / "the shell was published") are separately visible.
      const preFix = await fresh('cut-pre-fix')
      assert.notDeepEqual(policyOf(ctx, preFix.agent), RESTRICTED_POLICY, 'negative control: without the replay an unseeded child loses the source policy')
      assert.deepEqual(policyOf(ctx, preFix.agent), { plan: false, sandbox: 'workspace-write', approval: 'ask', preset: 'workspace-write' }, 'negative control: it falls back to the deployment defaults')
      await sleep(250) // 固定窗:探针 — an absent artifact is already true, so the window is what makes the silence observable.
      assert.equal(existsSync(artifact(preFix.agent.session)), false, 'negative control: and it publishes nothing, so only the policy assertion can see the loss')
      console.log('PASS negative control: an unseeded child without the replay loses the source policy while publishing nothing')

      // The other failure mode: a replay that appends a cut event the deferral
      // does NOT ignore starts it, and the child is published immediately —
      // the shell the unseeded branch exists to avoid.
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
  verifyChannelWiring()
  verifySeededWiring()
  const savedId = await verify('none')
  await verify('zstd')
  await verifyCutPolicyReplay()
  verifyHandoffs(savedId)
} finally {
  rmSync(root, { recursive: true, force: true })
}
