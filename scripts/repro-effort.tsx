/**
 * Repro for issue #51: cordis config `effort: high` must drive the actual
 * request's reasoningEffort, not just the startup status-line seed.
 *
 * Boots a REAL cordis root + REAL dsh-llm LlmRuntime with a DeepSeek-shaped
 * fake adapter (efforts off/high/max, adapter default `max` — mirroring the
 * shipped cordis.patch.yml `reasoningEffort: max`), then runs createChannel
 * with `effort: 'high'` and simulates exactly what dsh-agent-loop's
 * buildRequest does each step:
 *
 *   1. `system-prompt/assemble` waterfall (snapshots the model selection)
 *   2. `agent/request` waterfall over the seed config `{provider, model}`
 *      (a fresh session has no persisted header, so the seed carries no
 *      reasoningEffort — the adapter default `max` would materialize at
 *      prepareCall if nothing overrides it)
 *
 * Expected (fixed): the proposed request config carries reasoningEffort
 * 'high'. Buggy behavior: it stays undefined → adapter default `max` wins.
 *
 * Second part — request-level regression for the #866 preferred-effort
 * fallback: a stored tier must still reach the request config on the SECOND and
 * every later bind. bind() resets `selection.current` on every session switch
 * (binding-events.ts), so the fallback-notice dedupe may gate only the toast.
 * An early return on an unchanged (preferred → applied) pair leaves the request
 * without any tier from the second bind on — the very "effort resets every new
 * session" symptom the fallback exists to fix, reborn one session later, and it
 * is invisible to a single-bind assertion because the first bind always applies.
 * Those cases drive the real binding cell + binding router + model actions and
 * read the tier each request config actually carries, bind after bind.
 *
 * Run with: node --import tsx/esm scripts/repro-effort.tsx
 */
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { createChannel } from '../src/dsh-adapter/channel.js'
import { createChannelBinding } from '../src/dsh-adapter/channel/binding.js'
import { createBindingEvents } from '../src/dsh-adapter/channel/binding-events.js'
import { createModelActions } from '../src/dsh-adapter/channel/model-actions.js'
import { createChannelOwner } from '../src/dsh-adapter/channel/owner.js'
import { settle, sleep } from './lib/term-test.mjs'

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const root = new Context()
const llm = new LlmRuntime(root)

// DeepSeek-shaped adapter: the wire levels are off/high/max and the adapter
// config's reasoningEffort (max in the shipped cordis.patch.yml) becomes the
// model's defaultEffort — exactly what dsh-llm-deepseek rc.6 reports.
const ADAPTER_EFFORTS = [
  { id: 'off', name: 'Off' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
]
llm.registerAdapter(['deepseek-official'], {
  providerInfo(provider: string) {
    return { id: provider, name: 'DeepSeek' }
  },
  providerRetryPolicy() {
    return undefined
  },
  async resolveModel(provider: string, model: string) {
    return {
      provider,
      id: model,
      name: model,
      reasoning: { efforts: ADAPTER_EFFORTS, defaultEffort: 'max' },
    }
  },
  async *stream(): AsyncGenerator<never> {
    throw new Error('not exercised')
  },
} as never)

// A minimal agent whose ctx is a plain child context standing in for the
// agent scope; the channel binds installModelSelection on it, and the loop
// simulation below dispatches the two agent-scoped waterfalls on it.
const agentCtx = root.extend()
const agent = {
  id: 'a1',
  status: 'idle',
  ctx: agentCtx,
  session: { id: 's1', seq: 0, events: [] },
  followup() {},
  steer() {},
  inbox: { remove() {} },
} as never

const channel = createChannel(root as never, agent, {
  model: 'deepseek-v4-flash',
  cwd: '/tmp',
  provider: 'deepseek-official',
  effort: 'high',
  activity: false,
})
check('startup status line seeds the configured effort', channel.reasoningEffort === 'high', channel.reasoningEffort)

// applyPreferredEffort is async (route metadata resolution) — let it settle:
// it writes state.effortLevels and installs selection.current in the same
// synchronous continuation, so effortLevels appearing implies the install ran.
await settle(() => channel.effortLevels !== undefined)

// ── dsh-agent-loop buildRequest simulation (fresh session, first request) ──
// 1. prompt assembly: installModelSelection snapshots selection.current here.
const assembly = { variables: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }
await (agentCtx as Context).waterfall(
  'system-prompt/assemble' as never,
  assembly,
  {},
  () => Promise.resolve(assembly),
)
// 2. request config: the seed a fresh session produces (no persisted header).
const seed = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
const proposed = (await (agentCtx as Context).waterfall(
  'agent/request' as never,
  { turn: 1, step: 1, signal: new AbortController().signal },
  () => Promise.resolve(seed),
)) as { reasoningEffort?: string }

check(
  'config effort: high reaches the request config (issue #51)',
  proposed.reasoningEffort === 'high',
  `reasoningEffort=${String(proposed.reasoningEffort)} (undefined would materialize the adapter default "max" at prepareCall)`,
)

// ── control: no configured effort → the adapter default path stays open ──
// A separate root: plain extend() children share one fiber, so two channels
// on one root would both receive each other's agent-scoped waterfalls (the
// real harness isolates agent scopes; this repro does not emulate dsh-scope).
const root2 = new Context()
const llm2 = new LlmRuntime(root2)
llm2.registerAdapter(['deepseek-official'], {
  providerInfo(provider: string) {
    return { id: provider, name: 'DeepSeek' }
  },
  providerRetryPolicy() {
    return undefined
  },
  async resolveModel(provider: string, model: string) {
    return {
      provider,
      id: model,
      name: model,
      reasoning: { efforts: ADAPTER_EFFORTS, defaultEffort: 'max' },
    }
  },
  async *stream(): AsyncGenerator<never> {
    throw new Error('not exercised')
  },
} as never)
const agentCtx2 = root2.extend()
const agent2 = { ...(agent as object), ctx: agentCtx2 } as never
createChannel(root2 as never, agent2, {
  model: 'deepseek-v4-flash',
  cwd: '/tmp',
  provider: 'deepseek-official',
  activity: false,
})
// 固定窗:探针 断言「无配置 effort 时不安装选择」，no-op 路径不留痕、
// 没有可轮询的完成条件——留一个观察窗让错误安装显形。
await sleep(50)
const seed2 = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
const proposed2 = (await (agentCtx2 as Context).waterfall(
  'agent/request' as never,
  { turn: 1, step: 1, signal: new AbortController().signal },
  () => Promise.resolve(seed2),
)) as { reasoningEffort?: string }
check(
  'control: no configured effort leaves the seed untouched (adapter default applies)',
  proposed2.reasoningEffort === undefined,
  `reasoningEffort=${String(proposed2.reasoningEffort)}`,
)

// ── part 2: the preferred tier must survive a rebind (request level) ────────
// One rig per scenario: the real binding cell, the real binding router
// (bind → selection reset → applyPreferredEffort → assemble → request) and the
// real model actions over a fake route, so the assertion reads what the agent
// loop's buildRequest would actually carry.

/**
 * Mirror of channel.ts's wiring for the parts that decide the request tier.
 * `initialEffort` is passed explicitly, which also keeps the run hermetic
 * (no read of the operator's real effort.json).
 */
function createRebindRig(options: { preferred: string; efforts: { id: string; name: string }[]; defaultEffort: string }) {
  const rigRoot = new Context()
  const rigLlm = new LlmRuntime(rigRoot)
  rigLlm.registerAdapter(['narrow-route'], {
    providerInfo(provider: string) {
      return { id: provider, name: 'Narrow' }
    },
    providerRetryPolicy() {
      return undefined
    },
    async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, reasoning: { efforts: options.efforts, defaultEffort: options.defaultEffort } }
    },
    async *stream(): AsyncGenerator<never> {
      throw new Error('not exercised')
    },
  } as never)
  const agentCtx = rigRoot.extend()
  const agent = {
    id: 'rebind-agent',
    status: 'idle',
    ctx: agentCtx,
    session: { id: 'rebind-session', events: [] as unknown[] },
    followup() {},
    steer() {},
    inbox: { remove() {} },
  }
  const owner = createChannelOwner()
  const binding = createChannelBinding(agent as never, undefined, owner)
  const selection: { current?: { provider: string; model: string; reasoningEffort?: string }; assembled?: { provider: string; model: string; reasoningEffort?: string } } = {}
  const notices: string[] = []
  const state = {
    agentBindingGeneration: 0,
    provider: 'narrow-route',
    model: 'narrow-model',
    reasoningEffort: undefined as string | undefined,
    effortLevels: undefined as string[] | undefined,
    agentPreset: undefined as string | undefined,
    working: false,
    status: 'idle',
    pending: [] as unknown[],
    cancelPending: false,
    activeToolCount: 0,
    emit() {},
    emitStream() {},
  }
  const modelActions = createModelActions(rigRoot as never, state as never, {
    owner,
    binding,
    selection: selection as never,
    initialEffort: options.preferred,
    agent: () => binding.agent as never,
    notify: (text: string) => { notices.push(text) },
  })
  // Instrumentation only — the router still calls the production apply; the
  // counter lets the driver wait for THAT call to settle instead of guessing a
  // wall-clock window.
  let applies = 0
  const applyPreferredEffort = async (): Promise<void> => {
    try { await modelActions.applyPreferredEffort() } finally { applies += 1 }
  }
  const events = createBindingEvents(rigRoot as never, {
    owner,
    binding: binding as never,
    state: state as never,
    activity: { start() {}, stop() {}, onAgentStatus() {}, onSessionEvent() {} },
    inputConvergence: { interruptSeq: 0, cancelInFlight: false },
    selection: selection as never,
    modelActions: { selection: selection as never, applyPreferredEffort },
    modeActions: { refreshMode() {}, onSessionEvent() {} },
    projector: { renderEvent() {}, settleStreaming() {}, updateSpinnerMode() {} } as never,
    subagents: { onSessionEvent() { return false }, onStart() {}, onEnd() {} },
    agentView: { schedule() {} },
  })

  /**
   * Real bind entry. Later binds go through a binding-cell transaction
   * (`switchTo`), which does the three things every session-switch tail does —
   * generation bump, cleared subscriptions, then `bindAgent()` — so
   * `selection.current` is reset precisely as production resets it. /new and
   * /bg reach the same place through `adopt` instead; only the adoption
   * transaction differs, not the reset-then-reapply sequence under test.
   */
  const bindOnce = async (first = false): Promise<void> => {
    const before = applies
    if (first) events.bind()
    else binding.switchTo(binding.agent, undefined, () => events.bind())
    // The apply chain is promise-only (no timer anywhere in it), so a bounded
    // setImmediate spin settles it in both the fixed and the buggy tree — no
    // wall-clock window that could go green on a slow runner.
    for (let i = 0; i < 2000 && applies === before; i += 1) await new Promise(resolve => setImmediate(resolve))
  }

  /** Exactly the two waterfalls dsh-agent-loop's buildRequest dispatches. */
  const requestTier = async (): Promise<string | undefined> => {
    const assembly = { variables: { provider: 'narrow-route', model: 'narrow-model' } }
    await (agentCtx as Context).waterfall('system-prompt/assemble' as never, assembly, {}, () => Promise.resolve(assembly))
    const seed = { provider: 'narrow-route', model: 'narrow-model' }
    const proposed = (await (agentCtx as Context).waterfall(
      'agent/request' as never,
      { turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve(seed),
    )) as { reasoningEffort?: string }
    return proposed.reasoningEffort
  }

  /**
   * `setDefaultEffort` runs applyPreferredEffort through its own closure, so the
   * `applies` counter above cannot see it — poll a readout the branch must reach
   * instead. The chain is promise-only, so this settles deterministically in both
   * the fixed and the buggy tree.
   */
  const drainUntil = async (ready: () => boolean): Promise<void> => {
    for (let i = 0; i < 2000 && !ready(); i += 1) await new Promise(resolve => setImmediate(resolve))
  }

  return {
    state,
    selection,
    notices,
    defaultEffort: options.defaultEffort,
    setDefaultEffort: modelActions.setDefaultEffort,
    bindOnce,
    drainUntil,
    requestTier,
  }
}

// A — downgrade (the C1 shape): preferred `max` on a route that only offers
// off/low must pin the nearest lower tier `low` on EVERY bind. With the dedupe
// early-returning, the first bind pinned it and every later bind shipped the
// model default instead (`undefined` here, i.e. no tier in the request at all).
{
  const rig = createRebindRig({
    preferred: 'max',
    efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }],
    defaultEffort: 'off',
  })
  const tiers: (string | undefined)[] = []
  for (let index = 0; index < 3; index += 1) {
    await rig.bindOnce(index === 0)
    tiers.push(await rig.requestTier())
  }
  check(
    'rebind: 第 2、3 次 bind 的请求仍带就近降档档位 low',
    tiers[0] === 'low' && tiers[1] === 'low' && tiers[2] === 'low',
    `tiers=${JSON.stringify(tiers)}（undefined = 请求不带档位 → 模型默认档 off）`,
  )
  check('rebind: 状态行读数是实际生效档', rig.state.reasoningEffort === 'low', String(rig.state.reasoningEffort))
  check('rebind: 每次 bind 后 selection.current 都被重新钉住', rig.selection.current?.reasoningEffort === 'low', JSON.stringify(rig.selection.current))
  check('rebind: 同一 (偏好 → 实际) 对只提示一次', rig.notices.length === 1, `notices=${JSON.stringify(rig.notices)}`)
}

// B — exact hit: nothing is downgraded and nothing should toast, but the pin
// still has to be re-seeded after each switch (the M1 half of the same round).
{
  const rig = createRebindRig({
    preferred: 'medium',
    efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }],
    defaultEffort: 'medium',
  })
  const tiers: (string | undefined)[] = []
  const readouts: (string | undefined)[] = []
  for (let index = 0; index < 2; index += 1) {
    await rig.bindOnce(index === 0)
    tiers.push(await rig.requestTier())
    readouts.push(rig.state.reasoningEffort)
  }
  check('rebind: 精确命中档在第二次 bind 的请求里仍在', tiers[0] === 'medium' && tiers[1] === 'medium', `tiers=${JSON.stringify(tiers)}`)
  check('rebind: 精确命中时读数每次 bind 都是 medium', readouts.every(readout => readout === 'medium'), `readouts=${JSON.stringify(readouts)}`)
  check('rebind: 精确命中不提示', rig.notices.length === 0, `notices=${JSON.stringify(rig.notices)}`)
}

// C — no lower tier at all: nothing is pinned, so the ROUTE's model default is
// what actually ships and the readout (status line, `/effort status`) must say
// so. Syncing the readout is not licence to put a tier on the wire: the request
// stays unpinned, which is what keeps "nearest LOWER, never up" intact.
//
// The readout reaches this branch non-undefined from two real writers — the
// constructor seed `state.reasoningEffort = preferredEffort` (model-actions.ts:47,
// i.e. the first bind after boot) and a resumed log's replayed `request/header`
// (session-resume.ts:130 → projection.ts:965-968, which runs after the switch
// tail already cleared the field) — and undefined after any switch tail cleared
// it (session-resume.ts:129, model-switch.ts:93, session-live-adoption.ts:82,
// background-action.ts:106). All three have to end on the model default.
{
  const rig = createRebindRig({
    preferred: 'low',
    efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }],
    defaultEffort: 'max',
  })
  // Bind 1: the seeded / replayed tier is on the readout while the default ships.
  await rig.bindOnce(true)
  const firstTier = await rig.requestTier()
  check(
    'rebind: 无更低档时读数纠正为实际生效档（残留 preferred）',
    rig.state.reasoningEffort === rig.defaultEffort,
    `readout=${String(rig.state.reasoningEffort)} default=${rig.defaultEffort}`,
  )
  check(
    'rebind: 无更低档时不把档位伪造进请求',
    firstTier === undefined && rig.selection.current?.reasoningEffort === undefined,
    `tier=${String(firstTier)} selection=${JSON.stringify(rig.selection.current)}`,
  )
  // Bind 2: a switch tail cleared the readout first; the default still ships and
  // the notice still must not repeat.
  rig.state.reasoningEffort = undefined
  await rig.bindOnce()
  const secondTier = await rig.requestTier()
  check(
    'rebind: 无更低档时请求保持模型默认（不升档）',
    firstTier === undefined && secondTier === undefined,
    `tiers=${JSON.stringify([firstTier, secondTier])}`,
  )
  check(
    'rebind: 被切换尾清空过的读数同样回到模型默认档',
    rig.state.reasoningEffort === rig.defaultEffort,
    `readout=${String(rig.state.reasoningEffort)} default=${rig.defaultEffort}`,
  )
  check('rebind: 无更低档只提示一次', rig.notices.length === 1, `notices=${JSON.stringify(rig.notices)}`)
}

// D — the non-bind path. `/settings`' effortDefault hands the chosen level
// straight to setDefaultEffort → applyPreferredEffort (plugin.ts:804 →
// model-actions.ts setDefaultEffort) WITHOUT a bind, and the four switch tails
// that clear `selection.current` all live on the bind side. So a pin installed
// by an earlier exact hit outlives the default change: unless the miss branch
// drops that stale effort itself, the request keeps carrying the OLD tier while
// the readout says the model default ships — the readout-vs-request split this
// PR exists to remove.
{
  const rig = createRebindRig({
    preferred: 'max',
    efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }],
    defaultEffort: 'high',
  })
  await rig.bindOnce(true)
  const pinned = await rig.requestTier()
  check(
    'rebind: 精确命中 max 先把它钉进请求',
    pinned === 'max' && rig.selection.current?.reasoningEffort === 'max',
    `tier=${String(pinned)} selection=${JSON.stringify(rig.selection.current)}`,
  )
  // Same route, no bind: the settings layer moves the default to a level this
  // route does not offer and has nothing lower than.
  rig.setDefaultEffort('low')
  await rig.drainUntil(() => rig.state.reasoningEffort === rig.defaultEffort)
  const afterDefault = await rig.requestTier()
  check(
    'rebind: 非 bind 改默认档后请求不再携带旧 pin',
    afterDefault === undefined,
    `tier=${String(afterDefault)}（"max" = 旧 pin 还留在链路上）`,
  )
  check(
    'rebind: 非 bind 改默认档后 selection.current 不再持有 effort',
    rig.selection.current?.reasoningEffort === undefined,
    JSON.stringify(rig.selection.current),
  )
  check(
    'rebind: 非 bind 改默认档后读数与请求一致（读数=模型默认档）',
    rig.state.reasoningEffort === rig.defaultEffort,
    `readout=${String(rig.state.reasoningEffort)} default=${rig.defaultEffort}`,
  )
}

process.exit(failed === 0 ? 0 : 1)
