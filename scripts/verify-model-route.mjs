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
 * 2. A complete cordis.yml route wins whole over the pref.
 * 3. A model-only config pin also counts as unset → pref wins whole.
 * 4. Neither config nor pref → the harness default route.
 * 5. A half-pinned config with NO pref is ignored → the defaults win whole
 *    (no cross-source half-merge, even with the defaults).
 * 6. Empty-string config values count as unset.
 * 7. `/new` semantics: the channel passes its startup route as `defaults`,
 *    so a half-pinned config falls back to that whole route.
 * 8. validateModelRoute: a route absent from a non-empty adapter catalog is
 *    rejected wholesale to the fallback; an empty/failed/missing catalog is
 *    trusted (best effort, never blocks startup).
 * 9. recordedModelRoute: a resume's status-line route comes from the target
 *    session's own log (last request/header wins; a bare log records none).
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

// 2. A complete cordis.yml route wins whole over the pref.
{
  const config = { provider: 'my-gateway', model: 'glm-5.3-air' }
  const route = resolveModelRoute(config, PREF)
  check('complete config -> config wins whole', eq(route, config), JSON.stringify(route))
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
