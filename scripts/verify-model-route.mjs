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
 *    trusted (best effort, never blocks startup). A provider NO adapter
 *    registered is not "failed catalog" but proven-unusable, so it falls back
 *    too — trusting it does not keep startup alive, it defers the death to
 *    agent creation where the error names neither the provider nor the stale
 *    preference behind it.
 * 9. recordedModelRoute: a resume's status-line route comes from the target
 *    session's own log (last request/header wins; a bare log records none).
 * 10. validateModelRouteCached: the advisory catalog check is remembered per
 *    exact route, so the provider is asked once per `/model` change instead of
 *    once per launch (a third-party adapter can spend seconds on that one
 *    call). A remembered answer is reused while fresh, expires with the TTL,
 *    and is only ever written for a catalog that actually answered — a trusted
 *    route is re-checked.
 *
 * Run with plain node against the compiled lib (after `pnpm build`):
 * `node scripts/verify-model-route.mjs`
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_MODEL_ROUTE,
  explicitModelRoute,
  recordedModelRoute,
  resolveModelRoute,
  validateModelRoute,
} from '../lib/types/modelRoute.js'
import {
  MODEL_ROUTE_CACHE_TTL_MS,
  lookupCachedRoute,
  parseRouteCache,
  readRouteCache,
  rememberRouteDecision,
  validateModelRouteCached,
} from '../lib/types/modelRouteCache.js'

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

// 10. Verification cache (see modelRouteCache.ts): the catalog answer is
//     remembered per exact route, so a launch does not pay the provider's
//     catalog round trip again — a third-party adapter's cold answer measured
//     2.0-2.9s on a real launch, the largest single block of the boot.
{
  const dirs = []
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-model-route-cache-'))
    dirs.push(dir)
    return dir
  }
  const catalog = provider => Promise.resolve(provider === 'my-gateway' ? [{ id: 'glm-5.3' }] : [])

  // A miss asks the provider once and remembers the decision.
  const missDir = tempDir()
  let calls = 0
  const counting = { listModels: provider => { calls += 1; return catalog(provider) } }
  const first = await validateModelRouteCached(counting, PREF, DEFAULT_MODEL_ROUTE, missDir)
  check(
    'cache miss -> catalog read once, route kept and remembered',
    calls === 1 && first.rejected === undefined && eq(first.route, PREF) && readRouteCache(missDir).length === 1,
    `calls=${calls}`,
  )

  // A fresh entry answers without touching the provider at all.
  const second = await validateModelRouteCached(counting, PREF, DEFAULT_MODEL_ROUTE, missDir)
  check(
    'fresh cache -> provider never asked again',
    calls === 1 && second.rejected === undefined && eq(second.route, PREF),
    `calls=${calls}`,
  )

  // A `/model` change is a different key: it is verified on that launch, and
  // the wholesale fallback it produces is remembered too (the stale pref must
  // not cost a network round trip on every launch until it is fixed).
  const badRoute = { provider: 'my-gateway', model: 'glm-4' }
  const changed = await validateModelRouteCached(counting, badRoute, DEFAULT_MODEL_ROUTE, missDir)
  check(
    'changed route -> verified on that launch, wholesale fallback',
    calls === 2 && changed.rejected !== undefined && eq(changed.route, DEFAULT_MODEL_ROUTE),
    `calls=${calls}`,
  )
  const changedAgain = await validateModelRouteCached(counting, badRoute, DEFAULT_MODEL_ROUTE, missDir)
  check(
    'remembered rejection -> fallback without another catalog read',
    calls === 2 && eq(changedAgain.route, DEFAULT_MODEL_ROUTE) && eq(changedAgain.rejected, badRoute),
    `calls=${calls}`,
  )

  // Trusted-but-unverified answers (transport failure, empty catalog) prove
  // nothing about the catalog and are re-checked on the next launch.
  const trustDir = tempDir()
  let trustCalls = 0
  const failing = { listModels: () => { trustCalls += 1; return Promise.reject(new Error('boom')) } }
  await validateModelRouteCached(failing, PREF, DEFAULT_MODEL_ROUTE, trustDir)
  await validateModelRouteCached(failing, PREF, DEFAULT_MODEL_ROUTE, trustDir)
  check(
    'transport failure -> trusted, never cached (re-checked)',
    trustCalls === 2 && readRouteCache(trustDir).length === 0,
    `calls=${trustCalls}`,
  )
  const emptyDir = tempDir()
  let emptyCalls = 0
  const emptyCatalog = { listModels: () => { emptyCalls += 1; return Promise.resolve([]) } }
  await validateModelRouteCached(emptyCatalog, PREF, DEFAULT_MODEL_ROUTE, emptyDir)
  await validateModelRouteCached(emptyCatalog, PREF, DEFAULT_MODEL_ROUTE, emptyDir)
  check(
    'empty catalog -> trusted, never cached (re-checked)',
    emptyCalls === 2 && readRouteCache(emptyDir).length === 0,
    `calls=${emptyCalls}`,
  )
  const absentDir = tempDir()
  const noLlm = await validateModelRouteCached(undefined, PREF, DEFAULT_MODEL_ROUTE, absentDir)
  check(
    'no llm service -> trusted, nothing written',
    eq(noLlm.route, PREF) && readRouteCache(absentDir).length === 0,
  )

  // TTL expiry: an old answer is not reused.
  const staleDir = tempDir()
  rememberRouteDecision(PREF, PREF, staleDir, Date.now() - MODEL_ROUTE_CACHE_TTL_MS - 1)
  const stale = readRouteCache(staleDir)
  check(
    'expired entry -> not reused',
    stale.length === 1
      && lookupCachedRoute(PREF, stale, Date.now()) === undefined
      && eq(lookupCachedRoute(PREF, stale, Date.now() - MODEL_ROUTE_CACHE_TTL_MS), PREF),
  )

  // A corrupt or malformed file only means "ask again" — never a crash.
  const corruptDir = tempDir()
  writeFileSync(join(corruptDir, 'model-route-cache.json'), '{not json')
  check(
    'corrupt cache file -> treated as empty',
    readRouteCache(corruptDir).length === 0 && parseRouteCache('{not json').length === 0,
  )
  check(
    'malformed entries dropped, valid ones kept',
    parseRouteCache(JSON.stringify({
      version: 1,
      routes: [
        { provider: 'a' },
        { provider: 'a', model: 'b', adopted: { provider: 'a', model: 'b' }, at: 'x' },
        { provider: 'a', model: 'b', adopted: { provider: 'a', model: 'b' }, at: 1 },
      ],
    })).length === 1,
  )

  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll model-route checks passed')