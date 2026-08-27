/**
 * Headless regression for `/model <provider/id>` completion cache invalidation.
 *
 * The completion list is a session-lifetime channel cache (modelNodeCache):
 * `commandCompletions('/model …')` warms it once and serves the snapshot
 * synchronously until something invalidates it. A `/provider` catalog change
 * (add / edit / delete / OAuth sign-in-out) must invalidate it — otherwise a
 * deleted provider keeps showing up in `/model` completion until a model
 * switch or a restart (the reported bug), and an added one stays invisible.
 *
 * Pins the contract:
 *   1. the cache warms across every registered provider;
 *   2. without invalidation the snapshot is stale after the catalog shrinks
 *      (the buggy behavior this regression exists to catch);
 *   3. `channel.invalidateModelCompletion()` drops the cache synchronously;
 *   4. the next `/model ` keystroke refetches the fresh catalog — the
 *      deleted provider is gone, the survivor is listed.
 *
 * Run with plain node against the compiled lib (after `pnpm build`):
 * `node scripts/verify-model-completion-invalidate.mjs`
 */
import { createChannel } from '../lib/types/dsh-adapter/channel.js'
import { settled } from './lib/term-test.mjs'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The `llm` service seam the channel reads: the provider set is a live
// variable so the test can "delete" a provider by shrinking the catalog —
// the same observable the dsh-llm-pi-ai adapter produces when a profile is
// unset from the `llm-pi-ai` settings section.
let providerCatalog = [
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'my-gateway', name: 'My Gateway' },
]
const llmStub = {
  listProviders() {
    return providerCatalog.map(entry => ({ id: entry.id, name: entry.name }))
  },
  listModels(provider) {
    if (provider === 'deepseek') return Promise.resolve([{ provider, id: 'ds-1', name: 'DeepSeek 1' }])
    if (provider === 'my-gateway') return Promise.resolve([{ provider, id: 'gw-1', name: 'Gateway 1' }])
    return Promise.resolve([])
  },
}

const handlers = new Map()
const ctx = {
  on(event, handler) {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  get(service) {
    return service === 'llm' ? llmStub : undefined
  },
  logger: { warn() {} },
}

const stubAgentCtx = { on: () => () => {} }
const agent = {
  id: 'a1',
  status: 'idle',
  session: { id: 's1', seq: 0, events: [] },
  ctx: stubAgentCtx,
  followup() {},
  steer() {},
  inbox: { remove() { return true } },
}

const channel = createChannel(ctx, agent, {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
})

const completionNames = input => channel.commandCompletions(input).map(node => node.name)
const has = (names, spec) => names.some(name => name.endsWith(` ${spec}`))

// 1. Warm the session-lifetime cache across every registered provider.
check('completion warms both providers', await settled(() => {
  const names = completionNames('/model ')
  return names.length === 2 && has(names, 'my-gateway/gw-1') && has(names, 'deepseek/ds-1')
}, { timeoutMs: 4000 }), JSON.stringify(completionNames('/model ')))

// 2. The catalog shrinks: `/provider` deleted my-gateway. The cache is
//    session-lifetime, so without invalidation the stale snapshot lingers —
//    exactly the reported bug (deleted provider still visible in /model).
providerCatalog = providerCatalog.filter(entry => entry.id !== 'my-gateway')
check('stale snapshot still lists the deleted provider until invalidated',
  has(completionNames('/model '), 'my-gateway/gw-1'))

// 3. The fix: the catalog-changing path calls invalidateModelCompletion().
//    The cache is dropped synchronously — the next keystroke refetches.
channel.invalidateModelCompletion()
check('invalidateModelCompletion drops the cache synchronously',
  completionNames('/model ').length === 0, JSON.stringify(completionNames('/model ')))

// 4. The next `/model ` keystroke refetches the fresh catalog: the deleted
//    provider is gone, the survivor is listed.
check('completion refetches without the deleted provider', await settled(() => {
  const names = completionNames('/model ')
  return names.length === 1 && has(names, 'deepseek/ds-1') && !has(names, 'my-gateway/gw-1')
}, { timeoutMs: 4000 }), JSON.stringify(completionNames('/model ')))

if (failed === 0) {
  console.log('verify-model-completion-invalidate: all checks passed')
} else {
  console.error(`verify-model-completion-invalidate: ${failed} FAILURE(S)`)
}
process.exit(failed === 0 ? 0 : 1)
