/**
 * Verification of the atomic model-route resolution (issue #67): the
 * (provider, model) pair must always leave every resolution point from the
 * SAME source — a cordis.yml override wins only as a complete pair, the
 * persisted `/model` choice wins as a whole otherwise, and the harness
 * default backs the rest. A mixed route like deepseek-official + glm-5.3
 * must be impossible to construct.
 *
 * Part 1 exercises resolveModelRoute as a pure function; part 2 drives the
 * real channel `/new` path (which re-resolves the route through the same
 * helper) against a fake ctx whose agents.create captures the route it was
 * handed, with HOME pointed at a temp dir holding a persisted pref.
 *
 * Run with plain node against the compiled lib: `node scripts/verify-model-route.mjs`
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// modelPrefs captures PREFS_DIR at MODULE LOAD (os.homedir()), so the lib
// modules must be imported AFTER HOME points at the sandbox dir — dynamic
// imports below keep the real ~/.dsh-cc untouched (read AND write paths).
const home = mkdtempSync(join(tmpdir(), 'dsh-model-route-'))
mkdirSync(join(home, '.dsh-cc'), { recursive: true })
writeFileSync(join(home, '.dsh-cc', 'model.json'), JSON.stringify({ provider: 'my-gateway', model: 'glm-5.3' }, null, 2))
const realHome = process.env.HOME
process.env.HOME = home

const [{ createChannel }, { DEFAULT_MODEL_ROUTE, resolveModelRoute }] = await Promise.all([
  import('../lib/types/channel.js'),
  import('../lib/types/modelPrefs.js'),
])

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// ---- part 1: resolveModelRoute pure-function precedence --------------------

const PREF = { provider: 'my-gateway', model: 'glm-5.3' }

// Complete cordis.yml pair wins atomically.
{
  const { route, source } = resolveModelRoute(
    { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    PREF,
  )
  check(
    'complete config pair wins',
    source === 'config' && route.provider === 'deepseek-official' && route.model === 'deepseek-v4-flash',
    `${source}: ${route.provider}/${route.model}`,
  )
}

// THE BUG (issue #67): a half-written config (only provider) must NOT
// half-override the persisted choice — the pref wins as a whole.
{
  const { route, source } = resolveModelRoute({ provider: 'deepseek-official' }, PREF)
  check(
    'provider-only config ignored, pref wins whole (issue #67)',
    source === 'pref' && route.provider === 'my-gateway' && route.model === 'glm-5.3',
    `${source}: ${route.provider}/${route.model}`,
  )
}

// Symmetric: a model-only config is ignored the same way.
{
  const { route, source } = resolveModelRoute({ model: 'deepseek-v4-flash' }, PREF)
  check(
    'model-only config ignored, pref wins whole',
    source === 'pref' && route.provider === 'my-gateway' && route.model === 'glm-5.3',
    `${source}: ${route.provider}/${route.model}`,
  )
}

// No pref: the halves fall back per-side to the harness default.
{
  const { route, source } = resolveModelRoute({}, undefined)
  check(
    'empty config, no pref -> harness default',
    source === 'default' && route.provider === DEFAULT_MODEL_ROUTE.provider && route.model === DEFAULT_MODEL_ROUTE.model,
    `${source}: ${route.provider}/${route.model}`,
  )
}

// No pref, provider-only config: pinning one half is allowed ONLY in the
// default branch (nothing persisted to conflict with).
{
  const { route, source } = resolveModelRoute({ provider: 'my-gateway' }, undefined)
  check(
    'provider-only config pins provider in default branch',
    source === 'default' && route.provider === 'my-gateway' && route.model === DEFAULT_MODEL_ROUTE.model,
    `${source}: ${route.provider}/${route.model}`,
  )
}

// Custom fallback: the channel's live route backs /new's default branch.
{
  const { route, source } = resolveModelRoute({}, undefined, { provider: 'live-p', model: 'live-m' })
  check(
    'custom fallback honored',
    source === 'default' && route.provider === 'live-p' && route.model === 'live-m',
    `${source}: ${route.provider}/${route.model}`,
  )
}

// ---- part 2: channel /new resolves the same way ---------------------------
// HOME already points at the sandbox (top of file), so readModelPref()
// inside the channel finds the seeded pref.

const handlers = new Map()
const created = []
// Minimal agent event context: bindAgent installs the model-selection
// wiring through `agent.ctx.on` (installModelSelection); everything else
// on the channel is optional-service guarded.
const agentCtx = () => ({
  on() {
    return () => false
  },
})
const ctx = {
  on(event, handler) {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  get(name) {
    if (name === 'agents') {
      return {
        async create(options) {
          created.push(options)
          return {
            agent: {
              id: `a${created.length}`,
              status: 'idle',
              session: { id: `s${created.length}`, seq: 0, events: [] },
              ctx: agentCtx(),
            },
            dispose: async () => {},
          }
        },
      }
    }
    return undefined
  },
  logger: { warn() {} },
}

const agent = { id: 'a0', status: 'idle', session: { id: 's0', seq: 0, events: [] }, ctx: agentCtx() }
const channel = createChannel(ctx, agent, {
  // The live route the channel itself was seeded with (deepseek-official
  // halves, like a stock boot) — exactly the setup that used to produce the
  // mixed route on /new.
  model: 'deepseek-v4-flash',
  cwd: '/tmp',
  provider: 'deepseek-official',
  activity: false,
})

const ok = await channel.newSession()
check('/new created a session', ok && created.length === 1)
const route = created[0]?.agentOptions
check(
  '/new route halves share one source (issue #67)',
  route?.provider === 'my-gateway' && route?.model === 'glm-5.3',
  `agentOptions=${JSON.stringify(route)}`,
)

// A complete cordis.yml pair still wins atomically on /new.
const channel2 = createChannel(ctx, agent, {
  model: 'deepseek-v4-flash',
  cwd: '/tmp',
  provider: 'deepseek-official',
  configuredProvider: 'deepseek-official',
  configuredModel: 'deepseek-v4-flash',
  activity: false,
})
const ok2 = await channel2.newSession()
const route2 = created.at(-1)?.agentOptions
check(
  '/new complete config pair wins whole',
  ok2 && route2?.provider === 'deepseek-official' && route2?.model === 'deepseek-v4-flash',
  `agentOptions=${JSON.stringify(route2)}`,
)

process.env.HOME = realHome
rmSync(home, { recursive: true, force: true })

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
