/**
 * Headless regression for issue #67: the model route `(provider, model)`
 * resolves ATOMically — a source supplies the whole pair or is skipped, so a
 * cordis.yml `provider`-only pin (the bundle ships
 * `provider: deepseek-official` without `model`) can never merge with the
 * persisted `/model` choice into a mismatched route like
 * `{deepseek-official, glm-5.3}` that no adapter recognizes.
 *
 * Scenarios:
 * 1. The issue repro: config pins provider only + pref holds a complete
 *    custom route → the pref wins WHOLE (no cross-source halves).
 * 2. A complete cordis.yml route is the deployment DEFAULT: the pref still
 *    wins whole, and the config decides only when nothing is remembered.
 * 3. A model-only config pin also counts as unset → pref wins whole.
 * 4. Neither config nor pref → the harness default route.
 * 5. A half-pinned config with NO pref is ignored → the defaults win whole
 *    (no cross-source half-merge, even with the defaults).
 * 6. Empty-string config values count as unset.
 * 7. `/new` semantics: the channel passes its startup route as `defaults`,
 *    so a half-pinned config falls back to that whole route.
 * 8. validateModelRoute: a route absent from a non-empty adapter catalog is
 *    rejected wholesale to the fallback; an empty/failed/missing catalog is
 *    trusted (best effort, never blocks startup). A provider NO adapter
 *    registered is not "failed catalog" but proven-unusable, so it falls back
 *    too — trusting it does not keep startup alive, it defers the death to
 *    agent creation where the error names neither the provider nor the stale
 *    preference behind it. A rejected PREFERENCE lands on the deployment
 *    default route (the complete config pair), never on the built-in pair.
 * 9. recordedModelRoute: a resume's route comes from the target session's own
 *    log (last request/header wins; a bare log records none) — that record is
 *    what outranks a static config route on resume.
 *
 * Run with plain node against the compiled lib (after `pnpm build`):
 * `node scripts/verify-model-route.mjs`
 */
import {
  DEFAULT_MODEL_ROUTE,
  explicitModelRoute,
  recordedModelRoute,
  resolveModelRoute,
  validateModelRoute,
} from '../lib/types/modelRoute.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const PREF = { provider: 'my-gateway', model: 'glm-5.3' }

// 1. The issue repro: provider-only config pin + complete persisted route.
{
  const route = resolveModelRoute({ provider: 'deepseek-official' }, PREF)
  check('provider-only config + pref -> pref wins whole', eq(route, PREF), JSON.stringify(route))
}

// 2. A complete cordis.yml route is the deployment default: the persisted
//    last-used choice still wins whole, and the config decides only when the
//    preference is absent.
{
  const config = { provider: 'my-gateway', model: 'glm-5.3-air' }
  const route = resolveModelRoute(config, PREF)
  check('complete config + pref -> pref wins whole (config is the default)', eq(route, PREF), JSON.stringify(route))
  const fallback = resolveModelRoute(config, undefined)
  check('complete config, no pref -> config wins whole', eq(fallback, config), JSON.stringify(fallback))
}

// 3. A model-only pin is likewise half a route: pref wins whole.
{
  const route = resolveModelRoute({ model: 'deepseek-v4-pro' }, PREF)
  check('model-only config + pref -> pref wins whole', eq(route, PREF), JSON.stringify(route))
}

// 4. Neither source: the harness default.
{
  const route = resolveModelRoute({}, undefined)
  check('no config, no pref -> default route', eq(route, DEFAULT_MODEL_ROUTE), JSON.stringify(route))
}

// 5. Provider-only pin without a pref: ignored — defaults win whole.
{
  const route = resolveModelRoute({ provider: 'my-gateway' }, undefined)
  check(
    'provider-only config, no pref -> default route whole (half pin ignored)',
    eq(route, DEFAULT_MODEL_ROUTE),
    JSON.stringify(route),
  )
}

// 6. Empty strings count as unset.
{
  const route = resolveModelRoute({ provider: '', model: '' }, PREF)
  check('empty-string config halves count as unset', eq(route, PREF), JSON.stringify(route))
  check('explicitModelRoute rejects half-pinned config', explicitModelRoute({ provider: 'x' }) === undefined)
}

// 7. `/new` semantics: the channel's startup route is the fallback.
{
  const startup = { provider: 'my-gateway', model: 'glm-5.3' }
  const route = resolveModelRoute({ provider: 'deepseek-official' }, undefined, startup)
  check(
    '/new fallback -> startup route whole (never halves from two sources)',
    eq(route, startup),
    JSON.stringify(route),
  )
}

// 8. Combination validation.
{
  const catalog = { listModels: provider => Promise.resolve(provider === 'my-gateway' ? [{ id: 'glm-5.3' }] : []) }
  const ok = await validateModelRoute(catalog, PREF)
  check('catalog contains the route -> kept', ok.rejected === undefined && eq(ok.route, PREF))

  const bad = await validateModelRoute(catalog, { provider: 'my-gateway', model: 'glm-4' }, DEFAULT_MODEL_ROUTE)
  check(
    'catalog rejects the route -> wholesale fallback',
    bad.rejected !== undefined && eq(bad.route, DEFAULT_MODEL_ROUTE),
    JSON.stringify(bad),
  )

  const empty = await validateModelRoute({ listModels: () => Promise.resolve([]) }, PREF)
  check('empty catalog -> trusted (cannot verify)', empty.rejected === undefined && eq(empty.route, PREF))

  const throwing = await validateModelRoute({ listModels: () => Promise.reject(new Error('boom')) }, PREF)
  check('failing catalog -> trusted (best effort)', throwing.rejected === undefined && eq(throwing.route, PREF))

  const absent = await validateModelRoute(undefined, PREF)
  check('no llm service -> trusted', absent.rejected === undefined && eq(absent.route, PREF))

  // A stale PREFERENCE is exactly the case the fallback exists for: it must
  // land on the deployment default (the complete config pair), not on the
  // built-in pair — the boot chain the caller resolved and passed in.
  const deployment = resolveModelRoute(
    { provider: 'my-gateway', model: 'glm-5.3-air' },
    undefined,
    DEFAULT_MODEL_ROUTE,
  )
  const stale = await validateModelRoute(
    { listModels: provider => Promise.resolve(provider === 'my-gateway' ? [{ id: 'glm-5.3-air' }] : []) },
    PREF,
    deployment,
  )
  check(
    'stale pref -> deployment default (complete config), not the built-in route',
    stale.rejected !== undefined && eq(stale.route, deployment),
    JSON.stringify(stale),
  )

  // A provider nobody registered: dsh-llm's registry raises LlmError with code
  // NO_ADAPTER before any catalog read happens. Proven unusable, so it falls
  // back like an unknown model — matched on the code, never on message text.
  const noAdapter = Object.assign(new Error('no adapter registered for provider "fake-provider"'), {
    code: 'NO_ADAPTER',
  })
  const unregistered = await validateModelRoute(
    { listModels: () => Promise.reject(noAdapter) },
    { provider: 'fake-provider', model: 'deepseek-v4-flash' },
    DEFAULT_MODEL_ROUTE,
  )
  check(
    'unregistered provider -> wholesale fallback',
    unregistered.rejected !== undefined
      && eq(unregistered.rejected, { provider: 'fake-provider', model: 'deepseek-v4-flash' })
      && eq(unregistered.route, DEFAULT_MODEL_ROUTE),
    JSON.stringify(unregistered),
  )

  // The discriminator must be the code, not the wording: an adapter-internal
  // failure that happens to mention adapters stays trusted.
  const lookalike = await validateModelRoute(
    { listModels: () => Promise.reject(new Error('no adapter registered for provider "my-gateway"')) },
    PREF,
  )
  check(
    'transport failure that reads like NO_ADAPTER -> still trusted',
    lookalike.rejected === undefined && eq(lookalike.route, PREF),
    JSON.stringify(lookalike),
  )

  // A non-Error rejection must not crash the check.
  const weird = await validateModelRoute({ listModels: () => Promise.reject('nope') }, PREF)
  check('non-Error rejection -> trusted, no throw', weird.rejected === undefined && eq(weird.route, PREF))
}

// 9. Resume status-line route (review feedback on #76): the status line
//    derives the resumed session's route from its own log — the last
//    request/header record wins, a log without any header records no route.
{
  const log = [
    { type: 'session/start', data: {} },
    { type: 'request/header', data: { header: { config: { provider: 'my-gateway', model: 'glm-5.3' } } } },
    { type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } } },
    { type: 'assistant/message', data: {} },
  ]
  const route = recordedModelRoute(log)
  check(
    'resume -> last request/header route wins (status line follows the session)',
    eq(route, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
    JSON.stringify(route),
  )
  check(
    'resume -> a bare log records no route (caller falls back best-effort)',
    recordedModelRoute([{ type: 'session/start', data: {} }]) === undefined,
  )
  check(
    'resume -> malformed header data is skipped',
    recordedModelRoute([{ type: 'request/header', data: { header: {} } }]) === undefined,
  )
}

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll model-route checks passed')
