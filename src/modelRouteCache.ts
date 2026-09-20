/**
 * Verification cache for the advisory model-catalog check (see
 * modelRoute.validateModelRoute). The check exists so a stale persisted
 * `/model` choice surfaces at startup instead of as a server-side model-name
 * error — but it costs a provider round trip, and a third-party adapter can
 * answer it from its own catalog/billing chain: on a real Windows Terminal
 * launch the `commandcode` provider took 2.0–2.9 s for that one call, which
 * was the largest single block of the whole boot (measured 2026-09-20: total
 * 4.2–5.2 s, of which hold 120 ms, `agents.create` ~120 ms,
 * `validateModelRoute` 2.0–2.9 s).
 *
 * So the DECISION is remembered at `~/.dsh-tui/model-route-cache.json` and
 * reused for MODEL_ROUTE_CACHE_TTL_MS. The cache is keyed by the exact
 * `(provider, model)` pair, so a route the user changes to misses it and is
 * verified on that launch — the check still runs whenever the answer could
 * have changed. Only a real catalog answer is remembered (accepted OR
 * rejected): a route that was merely trusted (no llm service, an empty
 * catalog, a transport failure) is not a verification and is re-checked next
 * launch.
 *
 * The file is best-effort like every other preference: missing, unreadable,
 * corrupt or expired simply means "ask the provider again".
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_MODEL_ROUTE, validateModelRoute, type ModelRoute } from './modelRoute.js'
import { DATA_DIR } from './utils/paths.js'

/** Prefs file name inside the data directory. */
const CACHE_FILE = 'model-route-cache.json'

/**
 * How long one remembered answer is trusted. Long enough that the catalog
 * read happens on a `/model` change rather than on a timer, short enough that
 * a model retired afterwards heals by itself.
 */
export const MODEL_ROUTE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Newest decisions kept; the file only ever holds routes this profile used. */
const MAX_ENTRIES = 32

/** One remembered catalog decision for an exact requested route. */
export interface CachedRouteDecision {
  /** The route that was checked. */
  provider: string
  model: string
  /** The route the check adopted (the same pair, or the fallback). */
  adopted: ModelRoute
  /** Wall clock (ms) of the check. */
  at: number
}

const isRoute = (value: unknown): value is ModelRoute => {
  if (value === null || typeof value !== 'object') return false
  const { provider, model } = value as Record<string, unknown>
  return typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== ''
}

/**
 * Parse the cache file; anything malformed is dropped rather than repaired.
 * @param text - Raw file contents.
 * @returns The decisions the file holds, newest last.
 */
export function parseRouteCache(text: string): CachedRouteDecision[] {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    const entries = (parsed as { routes?: unknown }).routes
    if (!Array.isArray(entries)) return []
    const decisions: CachedRouteDecision[] = []
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue
      const { provider, model, adopted, at } = entry as Record<string, unknown>
      if (typeof provider !== 'string' || provider === '') continue
      if (typeof model !== 'string' || model === '') continue
      if (typeof at !== 'number' || !Number.isFinite(at)) continue
      if (!isRoute(adopted)) continue
      decisions.push({ provider, model, adopted: { provider: adopted.provider, model: adopted.model }, at })
    }
    return decisions
  } catch {
    return []
  }
}

/**
 * The decisions the cache file holds, or none when unreadable.
 * @param dir - Prefs directory (injectable for tests).
 * @returns Remembered decisions.
 */
export function readRouteCache(dir: string = DATA_DIR): CachedRouteDecision[] {
  try {
    return parseRouteCache(readFileSync(join(dir, CACHE_FILE), 'utf8'))
  } catch {
    return []
  }
}

/**
 * The remembered decision for one exact route, when it is still fresh.
 * @param route - The requested route.
 * @param decisions - Remembered decisions.
 * @param now - Wall clock (ms) to age entries against.
 * @param ttlMs - Freshness window.
 * @returns The adopted route, or undefined when there is nothing fresh.
 */
export function lookupCachedRoute(
  route: ModelRoute,
  decisions: readonly CachedRouteDecision[],
  now: number = Date.now(),
  ttlMs: number = MODEL_ROUTE_CACHE_TTL_MS,
): ModelRoute | undefined {
  for (let i = decisions.length - 1; i >= 0; i--) {
    const entry = decisions[i]
    if (entry === undefined) continue
    if (entry.provider !== route.provider || entry.model !== route.model) continue
    return now - entry.at <= ttlMs ? { provider: entry.adopted.provider, model: entry.adopted.model } : undefined
  }
  return undefined
}

/**
 * Remember one catalog decision, replacing any earlier one for the same
 * route and dropping entries the TTL has already retired (best effort).
 * @param route - The route that was checked.
 * @param adopted - The route the check adopted.
 * @param dir - Prefs directory (injectable for tests).
 * @param now - Wall clock (ms) of the check.
 * @returns True when the file was written.
 */
export function rememberRouteDecision(
  route: ModelRoute,
  adopted: ModelRoute,
  dir: string = DATA_DIR,
  now: number = Date.now(),
): boolean {
  try {
    const kept = readRouteCache(dir).filter(entry =>
      now - entry.at <= MODEL_ROUTE_CACHE_TTL_MS
      && !(entry.provider === route.provider && entry.model === route.model))
    kept.push({ provider: route.provider, model: route.model, adopted: { provider: adopted.provider, model: adopted.model }, at: now })
    const routes = kept.slice(-MAX_ENTRIES)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, CACHE_FILE), JSON.stringify({ version: 1, routes }, null, 2))
    return true
  } catch {
    return false
  }
}

/**
 * `validateModelRoute` with the verification cache in front of it: a route
 * whose catalog answer is already remembered (and fresh) is adopted without
 * touching the provider, and every real answer is remembered so the next
 * launch — and every launch after it, until the TTL or a `/model` change —
 * pays nothing.
 * @param llm - The llm runtime seam, when mounted.
 * @param route - The resolved route to check.
 * @param fallback - Route to adopt when the check rejects.
 * @param dir - Prefs directory (injectable for tests).
 * @returns The adopted route plus the rejected one (for a warning), if any.
 */
export async function validateModelRouteCached(
  llm: { listModels(provider: string): Promise<readonly { id: string }[]> } | undefined,
  route: ModelRoute,
  fallback: ModelRoute = DEFAULT_MODEL_ROUTE,
  dir: string = DATA_DIR,
): Promise<{ route: ModelRoute; rejected?: ModelRoute }> {
  if (llm === undefined) return { route }
  const cached = lookupCachedRoute(route, readRouteCache(dir))
  if (cached !== undefined) {
    return cached.provider === route.provider && cached.model === route.model
      ? { route: cached }
      : { route: cached, rejected: route }
  }
  const result = await validateModelRoute(llm, route, fallback)
  // Only a catalog that actually answered is worth remembering: a trusted
  // route proves nothing about the catalog and must be re-checked.
  if (result.verified === true || result.rejected !== undefined) {
    rememberRouteDecision(route, result.route, dir)
  }
  return result.rejected === undefined
    ? { route: result.route }
    : { route: result.route, rejected: result.rejected }
}
