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
 * Run with: node --import tsx/esm scripts/repro-effort.tsx
 */
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { createChannel } from '../src/channel.js'

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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

// applyPreferredEffort is async (route metadata resolution) — let it settle.
await sleep(50)

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

process.exit(failed === 0 ? 0 : 1)
