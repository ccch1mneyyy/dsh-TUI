/** Real 0.2.2 AgentLoop model selection through the channel, with an offline adapter.
 * Covers explicit branch routes, external live updates, fixed step snapshots and
 * cold JSONL restoration. No network, credentials or real user state.
 * Run: node --import tsx/esm scripts/verify-durable-model-selection.ts [case name]
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context as ContextType } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentSetup, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ChannelState } from '../src/dsh-adapter/channel.js'
import type { ContextPressureSource } from '../src/dsh-adapter/context-occupancy.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-durable-model-'))
process.env.HOME = root
process.env.USERPROFILE = root
process.env.DSH_HOME = join(root, 'home')
process.env.DSH_TUI_LANG = 'en'
const [
  { Context }, { default: AgentRegistry }, { default: AgentLoop },
  { default: LlmRuntime, LlmAdapter, createUserMessage, createAssistantMessage, ReasoningEffortId },
  { default: SessionStore, SessionId }, { default: SessionProjectionRegistry },
  JsonlModule, { default: SystemPrompt }, { default: ToolRuntime }, NativeExecutor,
  { createChannel }, { readEffortPref, writeEffortPref }, { settled },
] = await Promise.all([
  import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-agent'), import('@deepseek-ai/dsh-agent-loop'),
  import('@deepseek-ai/dsh-llm'), import('@deepseek-ai/dsh-session'), import('@deepseek-ai/dsh-session-projection'),
  import('@deepseek-ai/dsh-session-persistence-jsonl'), import('@deepseek-ai/dsh-system-prompt'),
  import('@deepseek-ai/dsh-tools'), import('@deepseek-ai/dsh-tool-executor-native'),
  import('../src/dsh-adapter/channel.js'), import('../src/effortPrefs.js'), import('./lib/term-test.mjs'),
])
const JsonlPersistence = 'default' in JsonlModule ? JsonlModule.default : JsonlModule
const a = { provider: 'fixture', model: 'a' }
const b = { provider: 'fixture-next', model: 'b' }
const c = { provider: 'fixture', model: 'c' }
const contexts = new Set<ContextType>()
const channels = new Set<ChannelState>()
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function info(provider: string, model: string): LlmResolvedModelInfo {
  return {
    provider, id: model, name: model,
    ...(model === 'no-capacity' ? {} : { context: { contextWindow: model === 'a' ? 32000 : 64000 } }),
    reasoning: { efforts: ['low', 'high'].map(id => ({ id: ReasoningEffortId(id), name: id })) },
  }
}
async function runtime(label: string, inputTokens?: number) {
  const ctx = new Context()
  contexts.add(ctx)
  const requests: GenerateOptions[] = []
  class OfflineAdapter extends LlmAdapter {
    async resolveModel(provider: string, model: string) { return info(provider, model) }
    async listModels(provider: string) { return ['a', 'b', 'c', 'no-capacity'].map(model => info(provider, model)) }
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options)
      const text = `reply ${requests.length}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      if (inputTokens !== undefined) yield { type: 'usage', usage: { inputTokens, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, ToolRuntime, NativeExecutor, AgentRegistry]) await ctx.plugin(plugin)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'route={{provider}}/{{model}}' })
  await ctx.plugin(JsonlPersistence, { root: join(root, label, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['fixture', 'fixture-next'], new OfflineAdapter())
  const create = (id: string, route: ModelSelection = a, setup?: AgentSetup) => ctx.agents.create({
    sessionId: SessionId(id), meta: { cwd: root }, agentOptions: route, ...(setup === undefined ? {} : { setup }),
  })
  const channel = (handle: AgentHandle, route: ModelSelection = a, contextPressure?: ContextPressureSource) => {
    // Borrowing lets the tests park and reattach a real registry Agent.
    const view = createChannel(ctx, handle.agent, { ...route, cwd: root, activity: false, ...(contextPressure === undefined ? {} : { contextPressure }) })
    channels.add(view)
    return view
  }
  const turn = async (agent: Agent, text: string, route: ModelSelection) => {
    const count = requests.length
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
    await agent.whenIdle()
    assert.equal(requests.length, count + 1, `one real offline request for ${text}`)
    const request = requests.at(-1)!
    assert.equal(request.provider, route.provider)
    assert.equal(request.model, route.model)
    assert.equal(request.reasoningEffort, route.reasoningEffort)
    const prompt = request.messages.filter(message => message.role === 'system').flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.ok(prompt.includes(`route=${route.provider}/${route.model}`), 'persona and transport use the same fixed route')
    return request
  }
  return { ctx, requests, create, channel, turn }
}
async function close(ctx: ContextType, channel?: ChannelState) {
  if (channel !== undefined) { channel.releaseContributions(); channels.delete(channel) }
  await ctx.fiber.dispose()
  contexts.delete(ctx)
}
let failures = 0
async function check(name: string, run: () => Promise<void>) {
  if (process.argv[2] !== undefined && process.argv[2] !== name) return
  try { writeEffortPref(''); await run(); console.log(`PASS ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}`, error) }
}

try {
  for (const mode of ['row-rewind', 'tree-rewind', 'tree-fork'] as const) for (const pinned of [false, true]) await check(pinned ? `${mode}-pinned` : mode, async () => {
    const label = pinned ? `${mode}-pinned` : mode
    const test = await runtime(label)
    const initial = pinned ? { ...a, reasoningEffort: ReasoningEffortId('high') } : a
    const chosen = pinned ? initial : b
    const source = await test.create(`${label}-source`, initial)
    const channel = test.channel(source)
    await test.turn(source.agent, 'first', initial)
    await test.turn(source.agent, 'second', initial)
    const target = channel.rows.find(row => row.kind === 'user' && row.text === 'second')
    assert.ok(target?.seq !== undefined)
    if (!pinned) assert.equal(await channel.switchModel(b.provider, b.model), true)
    assert.equal(source.agent.session.requestHeader()?.config.model, 'a', 'the inherited cut still records A')
    let published: Readonly<ModelSelection> | undefined
    const stop = test.ctx.on('agent/created', ({ agent }) => { published = agent.model.current() })
    try {
      const result = mode === 'row-rewind' ? await channel.rewindTo(target)
        : await channel.rewindToNode(String(source.agent.session.id), target.seq, mode === 'tree-fork' ? 'fork' : 'rewind')
      assert.notEqual(result, null, channel.notifications.map(row => row.text).join('\n'))
      const child = test.ctx.agents.get(SessionId(channel.agentId))!
      assert.notEqual(child, source.agent)
      assert.deepEqual(published, chosen, 'the complete explicit choice is durable before the child is published')
      assert.deepEqual(child.model.current(), chosen, 'branch route and explicit effort outrank inherited history')
      assert.equal(channel.provider, chosen.provider)
      assert.equal(channel.model, chosen.model)
      assert.equal(channel.reasoningEffort, pinned ? 'high' : undefined)
      await test.turn(child, 'after branch', chosen)
    } finally { stop() }
    await close(test.ctx, channel)
  })

  for (const upstreamNotice of [false, true]) await check(upstreamNotice ? 'external-upstream' : 'external', async () => {
    const label = upstreamNotice ? 'external-upstream' : 'external'
    const test = await runtime(label)
    const { installModelSelection } = await import('@deepseek-ai/dsh-agent')
    const handle = await test.create(label, a, upstreamNotice ? agentCtx => { installModelSelection(agentCtx) } : undefined)
    const channel = test.channel(handle)
    await test.turn(handle.agent, 'before external choice', a)
    const beforeVersion = channel.version
    handle.agent.model.select(b)
    assert.equal(channel.provider, b.provider, 'external durable choice updates the UI immediately')
    assert.equal(channel.model, b.model)
    assert.ok(channel.version > beforeVersion, 'external selection wakes channel subscribers')
    await test.turn(handle.agent, 'after external choice', b)
    const notices = handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'model-selection')
    assert.equal(notices.length, 1, 'the upstream owns model-change provenance; no duplicate TUI notice')
    assert.equal(await channel.setEffort('high'), true)
    assert.deepEqual(handle.agent.model.current(), { ...b, reasoningEffort: 'high' }, 'effort-only preserves the externally selected route')
    await test.turn(handle.agent, 'effort only', { ...b, reasoningEffort: ReasoningEffortId('high') })
    await close(test.ctx, channel)
  })

  await check('parked', async () => {
    const test = await runtime('parked')
    const first = await test.create('parked-first')
    const other = await test.create('parked-other', c)
    const channel = test.channel(first)
    await test.turn(first.agent, 'before parking', a)
    assert.deepEqual(await channel.resumeTo(String(other.agent.id)), { ok: true })
    first.agent.model.select(b)
    assert.equal(channel.model, 'c', 'parked choices cannot change the foreground')
    await test.turn(first.agent, 'while parked', b)
    first.agent.model.select({ ...b, reasoningEffort: ReasoningEffortId('high') })
    assert.deepEqual(await channel.resumeTo(String(first.agent.id)), { ok: true })
    assert.equal(channel.provider, b.provider)
    assert.equal(channel.model, b.model)
    assert.equal(channel.reasoningEffort, 'high', 'rebind adopts a parked pending choice')
    await close(test.ctx, channel)
  })

  for (const scenario of ['fixed-step', 'fixed-step-no-capacity', 'fixed-step-meter'] as const) await check(scenario, async () => {
    const test = await runtime(scenario, 20000)
    const fixedA = { ...a, reasoningEffort: ReasoningEffortId('high') }
    const route = scenario === 'fixed-step-no-capacity' ? { ...b, model: 'no-capacity' } : b
    const capacity = scenario === 'fixed-step-no-capacity' ? undefined : 64000
    const pendingB = { ...route, reasoningEffort: ReasoningEffortId('low') }
    const handle = await test.create(scenario, fixedA)
    const meter: ContextPressureSource | undefined = scenario === 'fixed-step-meter' ? {
      read: () => ({ projectedTokens: 20000, contextWindow: 128000 }),
      subscribe: () => () => {},
    } : undefined
    const channel = test.channel(handle, fixedA, meter)
    const entered = deferred<void>()
    const release = deferred<void>()
    let armed = true
    const stop = handle.agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (armed && context.modelSelection !== undefined) {
        armed = false
        entered.resolve()
        await release.promise
      }
      return next()
    }, { prepend: true })
    const step = test.turn(handle.agent, 'fixed A', fixedA)
    // Observe immediately: a failed race assertion still releases and drains the step.
    void step.catch(() => undefined)
    try {
      await entered.promise
      handle.agent.model.select(pendingB)
      // A diagnostic assembly has no step selection and must see the latest B.
      const inspection = await test.ctx.systemPrompt.assemble({ scope: handle.agent, agent: handle.agent })
      assert.equal(inspection.variables.model, route.model)
      assert.ok(await settled(() => channel.effortLevels !== undefined), 'B metadata resolves before the old A step resumes')
      assert.equal(channel.contextWindow, capacity, 'B owns its advertised capacity, including an unknown window')
      release.resolve()
      await step
      assert.deepEqual(handle.agent.model.current(), pendingB, 'a prepared A request cannot consume pending B')
      assert.equal(channel.model, route.model, 'logging fixed A does not revert the next-step choice')
      assert.equal(channel.reasoningEffort, 'low', 'late A/high header cannot replace pending B/low in the UI')
      assert.equal(channel.working, false)
      assert.equal(handle.agent.session.requestHeader()?.config.model, 'a', 'A still records its real request header')
      assert.equal(handle.agent.session.requestContext()?.contextWindow, 32000, 'A still records its real capacity')
      assert.equal(channel.lastUsage?.input, 20000, 'A usage is not discarded with its stale capacity readout')
      assert.equal(channel.contextWindow, capacity, 'late A context cannot replace pending B capacity')
      assert.deepEqual(channel.contextOccupancy, {
        usedTokens: 20000, contextWindow: meter === undefined ? capacity : 128000,
        source: meter === undefined ? 'sample' : 'projection',
      }, 'normal meter projection still outranks the channel fallback')
      assert.deepEqual(channel.notifications, [], 'the old 32k capacity must not raise a false context-low warning')
      if (capacity !== undefined) {
        // A current-route capacity update still wins over catalog metadata.
        handle.agent.session.append('request/context', { ...route, contextWindow: 96000 })
        assert.equal(channel.contextWindow, 96000)
      }
      await test.turn(handle.agent, 'next B', pendingB)
      assert.equal(channel.contextWindow, capacity, 'the next B request publishes its own actual capacity')
    } finally { release.resolve(); await step.catch(() => undefined); stop() }
    await close(test.ctx, channel)
  })

  await check('capacity-synchronous', async () => {
    const test = await runtime('capacity-synchronous')
    const handle = await test.create('capacity-synchronous')
    const channel = test.channel(handle)
    await test.turn(handle.agent, 'first A', a)
    handle.agent.model.select(b)
    assert.ok(await settled(() => channel.contextWindow === 64000))
    // Publish a complete old-route turn without yielding between context and
    // usage: a post-projection microtask is too late to prevent its warning.
    const session = handle.agent.session
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('request/context', { ...a, contextWindow: 32000 })
    session.append('assistant/message', {
      turn: 2, step: 1, stream: [],
      message: createAssistantMessage({ source: a, content: [{ type: 'text', text: 'synchronous A' }] }),
      usage: { inputTokens: 20000, outputTokens: 1 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 2, step: 1 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    assert.deepEqual(channel.notifications, [], 'stale capacity must be rejected before same-dispatch usage can warn')
    assert.equal(channel.contextWindow, 64000)
    assert.equal(channel.lastUsage?.input, 20000)
    assert.equal(channel.rows.some(row => row.text === 'synchronous A'), true, 'the actual A assistant event is still projected')
    const { createDshSession } = await import('../src/dsh-adapter/backend/session.js')
    const replay = await createDshSession(test.ctx, handle).history()
    assert.ok(replay.some(event => event.type === 'context.capacity' && event.contextWindow === 32000), 'historical capacity is not filtered from replay')
    await test.ctx.sessions.flush(session)
    const reader = await test.ctx.sessionPersistence.open(session.id, 'read')
    try { assert.deepEqual((await reader.read()).events, session.snapshotEvents(), 'the live capacity gate never alters persistence') }
    finally { await reader.close() }
    await close(test.ctx, channel)
  })

  await check('capacity-legacy-shapes', async () => {
    const { createDshSession } = await import('../src/dsh-adapter/backend/session.js')
    for (const modern of [true, false]) {
      const test = await runtime(`capacity-legacy-${modern}`)
      const handle = await test.create(`capacity-legacy-${modern}`)
      handle.agent.model.select(b)
      // The legacy view has the same Session but no Agent-owned model seam.
      const agent = modern ? handle.agent : Object.create(handle.agent, { model: { value: undefined } }) as Agent
      // Exercise legacy wire shapes at the backend feed, not at the modern
      // host registry that validates and eagerly folds its own committed log.
      const feedCtx = new Context()
      contexts.add(feedCtx)
      const backend = createDshSession(feedCtx, { agent, handle: undefined })
      const capacities: number[] = []
      const raw: SessionEvent[] = []
      const stopRaw = backend.capabilities.native.dsh!.subscribeRaw(event => { raw.push(event) })
      const stop = backend.subscribe(events => {
        for (const event of events) if (event.type === 'context.capacity') capacities.push(event.contextWindow)
      })
      try {
        for (const data of [
          { ...a, contextWindow: 32000 },
          { contextWindow: 48000 },
          { provider: a.provider, contextWindow: 64000 },
          { provider: '', model: a.model, contextWindow: 96000 },
          { ...b, contextWindow: 128000 },
        ]) {
          // Old hosts did not always record route identity in this metadata.
          feedCtx.emit('session/event', handle.agent.session, { type: 'request/context', seq: 0, time: 1, data } as SessionEvent)
        }
        assert.deepEqual(capacities, modern ? [48000, 64000, 96000, 128000] : [32000, 48000, 64000, 96000, 128000])
        assert.equal(raw.length, 5, 'the live gate never removes raw observations')
      } finally { stop(); stopRaw(); await close(feedCtx) }
      await close(test.ctx)
    }
  })

  await check('metadata', async () => {
    const test = await runtime('metadata')
    const handle = await test.create('metadata')
    const channel = test.channel(handle)
    assert.ok(await settled(() => channel.effortLevels !== undefined))
    const beforePref = readEffortPref()
    const gate = deferred<LlmResolvedModelInfo>()
    const original = test.ctx.llm.resolveModelInfo.bind(test.ctx.llm)
    test.ctx.llm.resolveModelInfo = (provider, model) => model === 'a' ? gate.promise : original(provider, model)
    try {
      const pending = channel.setEffort('high')
      handle.agent.model.select(b)
      assert.ok(await settled(() => channel.model === 'b' && channel.contextWindow === 64000))
      gate.resolve(info(a.provider, a.model))
      assert.equal(await pending, false, 'late A validation cannot overwrite external B')
      assert.deepEqual(handle.agent.model.current(), b)
      assert.equal(channel.contextWindow, 64000, 'late A metadata cannot overwrite B capacity')
      assert.equal(readEffortPref(), beforePref, 'a stale effort action cannot persist its preference')
    } finally { gate.resolve(info(a.provider, a.model)); test.ctx.llm.resolveModelInfo = original }
    await close(test.ctx, channel)
  })

  for (const phase of ['bind', 'set'] as const) await check(`metadata-effort-${phase}`, async () => {
    const test = await runtime(`metadata-effort-${phase}`)
    const handle = await test.create(`metadata-effort-${phase}`)
    if (phase === 'bind') writeEffortPref('low')
    const beforePref = readEffortPref()
    const gate = deferred<LlmResolvedModelInfo>()
    const original = test.ctx.llm.resolveModelInfo.bind(test.ctx.llm)
    let channel: ChannelState
    if (phase === 'set') {
      channel = test.channel(handle)
      assert.ok(await settled(() => channel.effortLevels !== undefined))
    }
    test.ctx.llm.resolveModelInfo = () => gate.promise
    let pending: Promise<boolean> | undefined
    const selected = { ...a, reasoningEffort: ReasoningEffortId(phase === 'bind' ? 'high' : 'low') }
    try {
      if (phase === 'bind') channel = test.channel(handle)
      else pending = channel!.setEffort('high')
      handle.agent.model.select(selected)
      gate.resolve(info(a.provider, a.model))
      if (pending !== undefined) assert.equal(await pending, false, 'external effort choice invalidates a pending same-route action')
      // Drain the fire-and-forget binding preference, not a wall-clock window.
      await new Promise<void>(done => setImmediate(done))
      assert.deepEqual(handle.agent.model.current(), selected, 'late metadata must not overwrite a newer same-route pin')
      assert.equal(channel!.reasoningEffort, selected.reasoningEffort)
      assert.deepEqual(channel!.effortLevels, ['low', 'high'], 'a newer same-route pin does not discard valid tier metadata')
      assert.equal(readEffortPref(), beforePref, 'rejected same-route metadata never writes the global preference')
      await test.turn(handle.agent, `after same-route ${phase}`, selected)
    } finally { gate.resolve(info(a.provider, a.model)); test.ctx.llm.resolveModelInfo = original }
    await close(test.ctx, channel!)
  })

  await check('metadata-disposed', async () => {
    const test = await runtime('metadata-disposed')
    const handle = await test.create('metadata-disposed')
    const view = test.channel(handle)
    assert.ok(await settled(() => view.effortLevels !== undefined))
    const gate = deferred<LlmResolvedModelInfo>()
    const original = test.ctx.llm.resolveModelInfo.bind(test.ctx.llm)
    test.ctx.llm.resolveModelInfo = () => gate.promise
    try {
      const pending = view.setEffort('high')
      await handle.dispose()
      gate.resolve(info(a.provider, a.model))
      assert.equal(await pending, false, 'disposed Agent rejects late effort metadata without reading its released selection')
    } finally { gate.resolve(info(a.provider, a.model)); test.ctx.llm.resolveModelInfo = original }
    await close(test.ctx, view)
  })

  await check('background', async () => {
    const test = await runtime('background')
    const handle = await test.create('background-source')
    const view = test.channel(handle)
    await test.turn(handle.agent, 'before background', a)
    const result = await view.backgroundCurrent()
    assert.equal(result.ok, true, JSON.stringify(result))
    const foreground = test.ctx.agents.get(SessionId(view.agentId))!
    assert.notEqual(foreground, handle.agent, '/bg binds a new foreground Agent')
    assert.ok(await settled(() => view.effortLevels !== undefined))
    const selected = foreground.model.current()!
    assert.equal(view.provider, selected.provider)
    assert.equal(view.model, selected.model)
    await test.turn(foreground, 'after background', selected)
    await close(test.ctx, view)
  })

  for (const effort of ['high', undefined]) await check(effort === undefined ? 'restore-unpinned' : 'restore-pinned', async () => {
    const label = effort === undefined ? 'restore-unpinned' : 'restore-pinned'
    const test = await runtime(label)
    const source = await test.create(label)
    await test.turn(source.agent, 'recorded A', a)
    const selected = { ...b, ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }) }
    source.agent.model.select(selected)
    await test.ctx.sessionPersistence.flush()
    await close(test.ctx)
    writeEffortPref('low')
    const reopened = await runtime(label)
    const handle = await reopened.ctx.agents.resume({ resumeSessionId: SessionId(label), agentOptions: a })
    const view = reopened.channel(handle, a)
    assert.ok(await settled(() => view.effortLevels !== undefined))
    assert.deepEqual(handle.agent.model.current(), selected, 'passive restore never selects stale boot options or a global effort over pending B')
    assert.equal(view.provider, b.provider)
    assert.equal(view.model, b.model)
    assert.equal(view.reasoningEffort, effort)
    await reopened.turn(handle.agent, 'after cold restore', selected)
    await close(reopened.ctx, view)
  })
} finally {
  for (const channel of channels) channel.releaseContributions()
  for (const ctx of contexts) await ctx.fiber.dispose()
  // Only this invocation's freshly allocated temp tree is eligible for removal.
  assert.ok(isAbsolute(root) && dirname(root) === resolve(tmpdir()) && basename(root).startsWith('dsh-tui-durable-model-'))
  rmSync(root, { recursive: true, force: true })
}
if (failures > 0) process.exitCode = 1
console.log(`durable-model-selection: ${failures === 0 ? 'OK' : `${failures} failed`}`)
