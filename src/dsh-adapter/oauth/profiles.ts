/**
 * Provider routes this plugin owns: the pi-ai catalog providers that ship an
 * OAuth flow, mounted with their catalog models, wire implementations, and
 * OAuth flow objects untouched. Credential resolution is not wrapped at all —
 * the adapter's collection carries this plugin's `CredentialStore`
 * (`PiAiAuthInjection`), so requests resolve the stored OAuth credential
 * through the provider's own auth and refresh tokens under the store's lock.
 *
 * The hand-built profile mirrors what an empty llm-pi-ai settings profile
 * resolves to for a catalog route, including the image-request defaults
 * (llm-pi-ai's own `DEFAULT_*` constants are not exported; the values below
 * are those constants, and the comment on each says so).
 *
 * @module @deepseek-harness-tui/dsh-tui/oauth/profiles
 */

import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { UPSTREAM_RETRY_MAX_RETRIES, UPSTREAM_RETRYABLE_CODES } from '../channel/upstream-retry.js'
import { adapterBuiltinProviders, type PiAiProvider } from './pi-ai.js'

/** Subscription routes this build can mount, in picker order. */
export const OAUTH_PROVIDER_IDS = ['openai', 'openai-codex', 'anthropic', 'xai', 'meta'] as const

/** One routable provider id. */
export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number]

/** Mount only flows actually shipped by the adapter's pi-ai instance. */
export function availableOAuthProviderIds(): OAuthProviderId[] {
  const catalog = new Map(adapterBuiltinProviders().map(provider => [provider.id, provider] as const))
  return OAUTH_PROVIDER_IDS.filter(id => catalog.get(id)?.auth.oauth !== undefined)
}

/**
 * One per-model catalog override a deployment may name, keyed by model id.
 * Every field is optional; an absent field keeps the installed catalog's
 * value, so one model's capacity can be tuned without restating the rest.
 */
export interface ModelOverride {
  /** Override the installed catalog's context window, in tokens. */
  contextWindow?: number
  /** Override the installed catalog's max output tokens. */
  maxTokens?: number
}

/** llm-pi-ai `DEFAULT_MAX_REQUEST_IMAGE_BYTES` (20 MiB, base64 payload bound). */
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
/** llm-pi-ai `DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET` (2048×2048 pixels). */
const REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
/** llm-pi-ai `DEFAULT_REQUEST_IMAGE_MAX_BYTES` (1 MiB per image). */
const REQUEST_IMAGE_MAX_BYTES = 1024 * 1024
/** llm-pi-ai `DEFAULT_STREAM_IDLE_TIMEOUT_MS` (5 minutes). */
const STREAM_IDLE_TIMEOUT_MS = 300_000

/** The installed pi-ai catalog provider for one route, whose OAuth flow we mount. */
function catalogProviderOf(id: string): PiAiProvider {
  const found = adapterBuiltinProviders().find(provider => provider.id === id)
  if (found === undefined) {
    throw new Error(
      `dsh-auth: the installed pi-ai catalog ships no provider "${id}"; `
      + 'remove it from this plugin\'s providers config or update pi-ai',
    )
  }
  return found
}

/** The OAuth flow object for one mounted route (login/refresh/toAuth live here). */
export function oauthOf(route: PiAiProvider): NonNullable<PiAiProvider['auth']['oauth']> {
  const oauth = route.auth.oauth
  if (oauth === undefined) {
    throw new Error(`dsh-auth: pi-ai provider "${route.id}" ships no OAuth flow`)
  }
  return oauth
}

/**
 * Apply per-model overrides to one catalog provider. Only the touched model
 * entries are cloned — the installed catalog objects are shared module state
 * and must never be mutated in place — and a miss is refused, never skipped,
 * so a typo lands as a boot error instead of a silently unchanged model.
 * @param catalog - the installed pi-ai catalog provider for one route.
 * @param overrides - per-model field overrides, keyed by model id.
 * @returns the catalog provider, or a shallow clone carrying overridden models.
 */
function withModelOverrides(
  catalog: PiAiProvider,
  overrides: Readonly<Record<string, ModelOverride>> | undefined,
): PiAiProvider {
  if (overrides === undefined || Object.keys(overrides).length === 0) return catalog
  const catalogModels = new Map(catalog.getModels().map(model => [model.id, model] as const))
  for (const id of Object.keys(overrides)) {
    if (!catalogModels.has(id)) {
      throw new Error(
        `dsh-auth: modelOverrides names "${id}", which provider "${catalog.id}" does not ship in the installed catalog`,
      )
    }
  }
  const models = catalog.getModels().map(model => {
    const override = overrides[model.id]
    if (override === undefined) return model
    return { ...model, ...override }
  })
  return {
    ...catalog,
    getModels: () => models,
  }
}

/**
 * Build the resolved profile one route registers under. Mirrors the fields
 * `PiAiAdapter` reads: identity for selectors, the idle timeout, retry
 * policy, and image budgets it forwards per request, and the catalog provider
 * with its own models. Everything optional stays absent — the adapter treats
 * absence as "provider defaults" exactly as an empty llm-pi-ai profile would.
 * @param id - the OAuth provider route to mount.
 * @param modelOverrides - optional per-model catalog overrides (see
 *   {@link ModelOverride}); `undefined` serves the installed catalog unchanged.
 */
export function buildOAuthProfile(
  id: string,
  modelOverrides?: Readonly<Record<string, ModelOverride>>,
): ResolvedPiAiProviderProfile {
  if (!(OAUTH_PROVIDER_IDS as readonly string[]).includes(id)) {
    throw new Error(`dsh-auth: "${id}" is not an OAuth provider this build mounts (${OAUTH_PROVIDER_IDS.join(', ')})`)
  }
  const catalog = withModelOverrides(catalogProviderOf(id), modelOverrides)
  // An older pi-ai catalog can know the route but not its newer OAuth flow
  // (notably `openai`). Explicit requests must fail at boot, not at /auth.
  oauthOf(catalog)
  return {
    provider: id,
    displayName: catalog.name,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    // The widened upstream-retry codes (upstream-retry.ts): the stock
    // default set would leave STREAM_CLOSED — a dropped upstream stream
    // — un-retried on this plugin's own routes too.
    retryPolicy: resolveRetryPolicy(
      { mode: 'normal', maxRetries: UPSTREAM_RETRY_MAX_RETRIES, retryableCodes: [...UPSTREAM_RETRYABLE_CODES] },
      `dsh-auth: provider "${id}" retryPolicy`,
    ),
    configuredMaxTokens: new Map(),
    piProvider: catalog,
    // Required since 0.1.5 (per-model pre-request diagnostics); this build
    // reports none. Older adapters never read the field, so carrying it is
    // harmless on a pre-0.1.5 host.
    modelErrors: new Map(),
    maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
    requestImagePixelBudget: REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,
  }
}
