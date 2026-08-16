/**
 * Regression for issue #191: a subagent whose AgentOptions do not carry a
 * route must still receive the TUI's active provider/model pair through the
 * agent/request waterfall. Complete child-specific routes remain untouched.
 *
 * Run with: node --import tsx/esm scripts/verify-subagent-model-route.tsx
 */
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createChannel } from '../src/dsh-adapter/channel.js'

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const root = new Context()
let parentScope: ReturnType<typeof createScope>
const parent = {
  id: 'parent-agent',
  status: 'idle',
  options: {},
  get ctx() { return parentScope.ctx },
  session: { id: 'parent-session', seq: 0, events: [], header: {} },
  followup() {},
  steer() {},
  inbox: { remove() {} },
} as never
parentScope = createScope(root, parent)

createChannel(root as never, parent, {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  cwd: '/tmp',
  activity: false,
})

// A real sibling Agent scope stands in for the child. Scoped dispatch excludes
// the parent's installModelSelection listener while retaining unscoped root
// listeners, matching the spawn/fork routing boundary.
let childScope: ReturnType<typeof createScope>
const child = {
  id: 'child-agent',
  status: 'idle',
  options: {},
  get ctx() { return childScope.ctx },
  session: { id: 'child-session', seq: 0, events: [], header: {} },
  followup() {},
  steer() {},
  inbox: { remove() {} },
} as never
childScope = createScope(root, child)
const childEvents = agentEvents(root, child)
const payload = { turn: 1, step: 1, signal: new AbortController().signal }
const inherited = (await childEvents.waterfall(
  'agent/request',
  payload,
  () => Promise.resolve({ maxTokens: 1024 }),
)) as { provider?: string; model?: string; maxTokens?: number }

check(
  'route-less child inherits the active TUI route (issue #191)',
  inherited.provider === 'deepseek-official' && inherited.model === 'deepseek-v4-flash',
  `provider=${String(inherited.provider)}, model=${String(inherited.model)}`,
)
check('unrelated request options survive fallback routing', inherited.maxTokens === 1024)

const explicit = (await childEvents.waterfall(
  'agent/request',
  payload,
  () => Promise.resolve({ provider: 'custom-provider', model: 'custom-model' }),
)) as { provider?: string; model?: string }

check(
  'complete child-specific routes are not overwritten',
  explicit.provider === 'custom-provider' && explicit.model === 'custom-model',
  `provider=${String(explicit.provider)}, model=${String(explicit.model)}`,
)

const partial = (await childEvents.waterfall(
  'agent/request',
  payload,
  () => Promise.resolve({ provider: 'orphaned-provider' }),
)) as { provider?: string; model?: string }

check(
  'partial routes are replaced atomically',
  partial.provider === 'deepseek-official' && partial.model === 'deepseek-v4-flash',
  `provider=${String(partial.provider)}, model=${String(partial.model)}`,
)

process.exit(failed === 0 ? 0 : 1)
