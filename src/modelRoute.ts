/**
 * Model route resolution (issue #67). The `(provider, model)` pair is a
 * single value: every source either supplies the WHOLE route or is skipped,
 * so a cordis.yml `provider`-only pin (the bundle ships
 * `provider: deepseek-official` without `model`) can never merge with the
 * model half of the persisted `/model` choice into a route no adapter
 * recognizes.
 *
 * Precedence is the LAST-USED rule: the persisted `/model` choice — the route
 * the previous session actually ran on — wins whole; a complete cordis.yml
 * route is the deployment DEFAULT underneath it (it decides the first run,
 * and a resumed session's own record decides that session), and the harness
 * default closes the chain. A static config route therefore cannot silently
 * freeze the model every later session starts on. Startup, `/new`, resume and
 * the status line all resolve through these helpers so the displayed route is
 * the route requests actually take.
 */

import type { ModelPref } from './modelPrefs.js'

/** One complete model route. */
export interface ModelRoute {
  provider: string
  model: string
}

/** Harness default route: the final fallback when neither cordis.yml nor the persisted `/model` choice supplies one. */
export const DEFAULT_MODEL_ROUTE: ModelRoute = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
}

const nonEmpty = (value: string | undefined): value is string => value !== undefined && value !== ''

/**
 * The route cordis.yml pins explicitly — only when it names BOTH halves. A
 * half-pinned config counts as unset here so it cannot override half of the
 * persisted preference (issue #67).
 * @param configured - Raw `provider`/`model` keys from cordis.yml.
 * @returns The configured route, or undefined when either half is missing.
 */
export function explicitModelRoute(configured: { provider?: string; model?: string }): ModelRoute | undefined {
  return nonEmpty(configured.provider) && nonEmpty(configured.model)
    ? { provider: configured.provider, model: configured.model }
    : undefined
}

/**
 * Resolve the effective route atomically: the persisted `/model` choice wins
 * whole; otherwise a complete cordis.yml route wins whole; otherwise the
 * defaults win whole — a half-pinned config is IGNORED rather than merged
 * with the defaults' other half, so no source ever contributes just one
 * half of the final route.
 *
 * The persisted pick leads because it is the standing user choice (`/model`
 * writes it on every switch): a static deployment route is a DEFAULT, not a
 * lock. A deployment that must pin a route states it where the composition
 * reads the environment, not in this config key.
 * @param configured - Raw `provider`/`model` keys from cordis.yml.
 * @param pref - The persisted `/model` choice, if any.
 * @param defaults - Final fallback route (the channel's startup route for
 *   `/new`, the harness default at boot).
 * @returns The resolved route.
 */
export function resolveModelRoute(
  configured: { provider?: string; model?: string },
  pref: ModelPref | undefined,
  defaults: ModelRoute = DEFAULT_MODEL_ROUTE,
): ModelRoute {
  if (pref !== undefined) return { provider: pref.provider, model: pref.model }
  const explicit = explicitModelRoute(configured)
  if (explicit !== undefined) return explicit
  return { provider: defaults.provider, model: defaults.model }
}

/**
 * The route a persisted session's own log records (issues #30/#67): the last
 * `request/header` snapshot carries the call config the agent loop builds its
 * requests from, so it IS the route a resume continues on — it outranks a
 * static cordis.yml route, which is only the deployment default (the route
 * that session actually ran is the more specific fact). The status line
 * derives the resumed session's route from this so the display follows the
 * session, not the startup resolution. A log without any header (a session
 * that never started a turn) records no route.
 * @param events - The session's durable event log.
 * @returns The last recorded route, or undefined when the log has none.
 */
export function recordedModelRoute(
  events: readonly { type: string; data?: unknown }[],
): ModelRoute | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event === undefined || event.type !== 'request/header') continue
    const config = (event.data as { header?: { config?: { provider?: unknown; model?: unknown } } } | undefined)
      ?.header?.config
    if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
  }
  return undefined
}

/**
 * `LlmError` code the adapter registry raises for a provider nobody
 * registered. Matched on the code rather than `instanceof LlmError`: a profile
 * that resolves two copies of the llm package would fail the identity check
 * while the code stays stable, and this module deliberately carries no llm
 * import.
 */
const NO_ADAPTER_CODE = 'NO_ADAPTER'

/**
 * Whether a catalog read failed because the provider itself is unregistered,
 * as opposed to a transport or adapter-internal failure.
 * @param error - The value `listModels` rejected with.
 * @returns True when no adapter owns the queried provider.
 */
function isUnregisteredProvider(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === NO_ADAPTER_CODE
  )
}

/**
 * Best-effort combination check (issue #67): when the llm runtime advertises
 * a non-empty catalog for the route's provider and the model is not in it,
 * reject the whole route in favor of `fallback` so a stale persisted choice
 * surfaces at startup instead of as a server-side model-name error.
 *
 * Uncertainty trusts the route — no llm service, an empty catalog, a catalog
 * read that failed for transport or adapter-internal reasons. An unregistered
 * PROVIDER is not uncertainty: no adapter owns the name, so the route is
 * proven unusable and falls back exactly like an unknown model does. Trusting
 * it does not keep startup alive either — agent creation dies a few frames
 * later inside the preset setup hook, reported as `refusing to compose an
 * unscoped context`, which names neither the provider nor the stale
 * preference that chose it.
 * @param llm - The llm runtime seam, when mounted.
 * @param route - The resolved route to check.
 * @param fallback - Route to adopt when the check rejects.
 * @returns The adopted route plus the rejected one (for a warning), if any.
 */
export async function validateModelRoute(
  llm: { listModels(provider: string): Promise<readonly { id: string }[]> } | undefined,
  route: ModelRoute,
  fallback: ModelRoute = DEFAULT_MODEL_ROUTE,
): Promise<{ route: ModelRoute; rejected?: ModelRoute }> {
  if (llm === undefined) return { route }
  let models: readonly { id: string }[]
  try {
    models = await llm.listModels(route.provider)
  } catch (error) {
    if (!isUnregisteredProvider(error)) return { route }
    return { route: fallback, rejected: route }
  }
  if (models.length === 0 || models.some(model => model.id === route.model)) return { route }
  return { route: fallback, rejected: route }
}
