/**
 * xAI (Grok/X subscription) OAuth credential management for the `/provider`
 * wizard and its background refresher.
 *
 * The Grok/X subscription authenticates through xAI's OAuth device flow and
 * yields a short-lived access token that `https://api.x.ai/v1` accepts as a
 * bearer API key. This module mirrors the client id, scope, and endpoints
 * pi uses (`@earendil-works/pi-ai`). The credential rides two stores — the
 * harness credential store (the access token, under the route's `apiKeyEnv`
 * ref, resolved per request) and this TUI's own refresh record
 * `~/.dsh-tui/xai-oauth.json` (0600), which carries the refresh token and
 * expiry. Subscription auth is device-code (or a console API key); this
 * module does not read `~/.pi` auth or model files.
 *
 * The module is React-free so `scripts/verify-xai-oauth.mjs` can drive it
 * headless and the refresher can run without UI state.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../utils/paths.js'

/** The OAuth client pi's SDK uses for xAI; tokens are interchangeable with pi's. */
export const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'

/** OAuth scope granting Grok CLI and xAI API access under the subscription. */
const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access'

/** Device-authorization endpoint (RFC 8628). */
const XAI_DEVICE_CODE_URL = 'https://auth.x.ai/oauth2/device/code'

/** Token endpoint; used for both the device grant and refresh grants. */
const XAI_TOKEN_URL = 'https://auth.x.ai/oauth2/token'

/** Refresh before the reported expiry so a token never dies mid-request. */
export const XAI_REFRESH_SKEW_MS = 5 * 60 * 1000

/** xAI expiry fallback when the token response omits `expires_in`. */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600

/** Poll interval fallback when the device response omits `interval`. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5

/** Device-code lifetime fallback when the response omits `expires_in`. */
const DEFAULT_DEVICE_EXPIRES_SECONDS = 1800

/** Default xAI endpoint; the subscription token is a bearer for this URL. */
export const XAI_DEFAULT_BASE_URL = 'https://api.x.ai/v1'

/**
 * Wire protocol pi's current xAI catalog uses for every SuperGrok model.
 * The bundled pi-ai catalog still splits completions vs responses and omits
 * grok-4.6; a subscription route must name this so extra ids are serviceable.
 */
export const XAI_SUBSCRIPTION_API = 'openai-responses'

/** The TUI's own refresh record (see the module header). */
export const XAI_OAUTH_STORE_PATH = join(DATA_DIR, 'xai-oauth.json')

/** One xAI OAuth credential: the bearer plus what it takes to rotate it. */
export interface XaiOAuthCredential {
  /** Access token, sent as the bearer for api.x.ai. */
  access: string
  /** Refresh token; xAI may rotate it on refresh. */
  refresh: string
  /** Epoch ms at which the access token counts as expired (skew included). */
  expires: number
}

/** What the refresher needs to keep a route's credential alive. */
export interface XaiOAuthStore {
  /** Provider route the credential belongs to (the `llm-pi-ai` profile). */
  route: string
  /** Credential-ref the access token is written under (`apiKeyEnv`). */
  ref: string
  credential: XaiOAuthCredential
}

/** Device-code info the wizard surfaces to the user. */
export interface XaiDeviceCodeInfo {
  /** https URL the user opens, with the code pre-filled when offered. */
  verificationUri: string
  /** The human-typed authorization code. */
  userCode: string
}

/**
 * One xAI model from a live listing. Written onto the route profile so
 * `/model` can serve ids the bundled catalog does not yet ship.
 */
export interface XaiCatalogModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: readonly string[]
  reasoningEfforts?: Readonly<Record<string, string | null>>
}

/** OAuth failure kinds the wizard can translate to user-facing text. */
export type XaiOAuthErrorCode = 'cancelled' | 'denied' | 'expired' | 'failed'

/** A failed xAI OAuth exchange, carrying the wizard-mappable kind. */
export class XaiOAuthError extends Error {
  constructor(
    readonly code: XaiOAuthErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'XaiOAuthError'
  }
}

/**
 * The persisted refresh record, when present and well-formed.
 * @param path - The store file (injectable for tests).
 * @returns The store, or undefined when absent or corrupt.
 */
export function readXaiOAuthStore(path: string = XAI_OAUTH_STORE_PATH): XaiOAuthStore | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.route !== 'string' || record.route === '') return undefined
  if (typeof record.ref !== 'string' || record.ref === '') return undefined
  const credential = record.credential
  if (credential === null || typeof credential !== 'object' || Array.isArray(credential)) {
    return undefined
  }
  const parts = credential as Record<string, unknown>
  if (typeof parts.access !== 'string' || parts.access === '') return undefined
  if (typeof parts.refresh !== 'string' || parts.refresh === '') return undefined
  if (typeof parts.expires !== 'number' || !Number.isFinite(parts.expires as number)) {
    return undefined
  }
  return {
    route: record.route,
    ref: record.ref,
    credential: {
      access: parts.access,
      refresh: parts.refresh,
      expires: parts.expires as number,
    },
  }
}

/**
 * Persist the refresh record under `~/.dsh-tui/xai-oauth.json` with mode
 * 0600 (it holds a long-lived refresh secret). Best effort: the wizard warns
 * when this fails, because the alternative — no refresh record — means the
 * route dies with its access token.
 * @param store - The record to persist.
 * @param path - The store file (injectable for tests).
 * @returns True when written.
 */
export function writeXaiOAuthStore(
  store: XaiOAuthStore,
  path: string = XAI_OAUTH_STORE_PATH,
): boolean {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * POST a form body to a xAI OAuth endpoint and parse the JSON reply.
 * Non-2xx statuses are returned, not thrown, so the device poll can tell a
 * pending grant from a denial; the grant callers decide what non-ok means.
 */
async function postForm(
  url: string,
  fields: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields),
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw new XaiOAuthError('cancelled', 'xAI OAuth cancelled')
    throw error
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new XaiOAuthError(
      'failed',
      `xAI OAuth returned invalid JSON (HTTP ${response.status})`,
    )
  }
  const body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
  return { ok: response.ok, status: response.status, body }
}

/** The `error`/`error_description` pair of a failed grant, for diagnostics. */
function grantFailure(body: Record<string, unknown>, status: number): string {
  const error = typeof body.error === 'string' ? body.error : undefined
  const description = typeof body.error_description === 'string' ? body.error_description : undefined
  const detail = [error, description].filter(Boolean).join(': ')
  return `xAI OAuth request failed (HTTP ${status})${detail === '' ? '' : `: ${detail}`}`
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new XaiOAuthError('failed', `Invalid xAI OAuth response field: ${field}`)
  }
  return value
}

function optionalPositiveNumber(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Build a credential from a token response, computing the expiry with the
 * refresh skew applied so `refreshXaiCredential` re-runs before the instant
 * the token actually dies. A refresh may omit `refresh_token` when xAI does
 * not rotate; the previous token then stays valid. The device grant has no
 * previous token and must be offered one (it asked for `offline_access`).
 */
function credentialFromTokenResponse(
  body: Record<string, unknown>,
  previousRefresh: string | undefined,
): XaiOAuthCredential {
  const access = requiredString(body, 'access_token')
  const refresh = body.refresh_token === undefined && previousRefresh !== undefined
    ? previousRefresh
    : requiredString(body, 'refresh_token')
  const lifetimeSeconds = optionalPositiveNumber(body, 'expires_in')
    ?? DEFAULT_TOKEN_LIFETIME_SECONDS
  return {
    access,
    refresh,
    expires: Date.now() + lifetimeSeconds * 1000 - XAI_REFRESH_SKEW_MS,
  }
}

/**
 * Refresh an xAI credential with its refresh token. A credential still
 * outside the refresh skew is returned unchanged — the caller's one call
 * covers both "make it fresh" and "leave it alone".
 * @param credential - The stored credential.
 * @param signal - Aborts the request; aborted calls throw `cancelled`.
 * @returns A credential whose access token is fresh enough to send.
 */
export async function refreshXaiCredential(
  credential: XaiOAuthCredential,
  signal?: AbortSignal,
): Promise<XaiOAuthCredential> {
  if (credential.expires - Date.now() > XAI_REFRESH_SKEW_MS) return credential
  const { ok, status, body } = await postForm(XAI_TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: XAI_CLIENT_ID,
    refresh_token: credential.refresh,
  }, signal)
  if (!ok) throw new XaiOAuthError('failed', grantFailure(body, status))
  return credentialFromTokenResponse(body, credential.refresh)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new XaiOAuthError('cancelled', 'xAI OAuth cancelled'))
    }, { once: true })
  })
}

/**
 * Run the xAI device-authorization flow: request a device code, surface it
 * through `onCode`, then poll the token endpoint until the user authorizes
 * (or the code dies).
 * @param onCode - Called once the device code is obtained; the caller shows
 *   the verification URI and user code and waits.
 * @param signal - Aborts the polls; aborted calls throw `cancelled`.
 * @returns The fresh credential.
 */
export async function loginXaiDevice(
  onCode: (info: XaiDeviceCodeInfo) => void,
  signal?: AbortSignal,
): Promise<XaiOAuthCredential> {
  const deviceResponse = await postForm(XAI_DEVICE_CODE_URL, {
    client_id: XAI_CLIENT_ID,
    scope: XAI_SCOPE,
    referrer: 'dsh-tui',
  }, signal)
  if (!deviceResponse.ok) {
    throw new XaiOAuthError('failed', grantFailure(deviceResponse.body, deviceResponse.status))
  }
  const deviceBody = deviceResponse.body
  const deviceCode = requiredString(deviceBody, 'device_code')
  const userCode = requiredString(deviceBody, 'user_code')
  const verificationUri = requiredString(deviceBody, 'verification_uri')
  onCode({ verificationUri, userCode })
  const expiresInSeconds = optionalPositiveNumber(deviceBody, 'expires_in')
    ?? DEFAULT_DEVICE_EXPIRES_SECONDS
  let intervalSeconds = optionalPositiveNumber(deviceBody, 'interval')
    ?? DEFAULT_POLL_INTERVAL_SECONDS
  const deadline = Date.now() + expiresInSeconds * 1000
  let firstPoll = true
  while (Date.now() < deadline) {
    if (firstPoll) {
      firstPoll = false
    } else {
      await sleep(intervalSeconds * 1000, signal)
    }
    const { ok, status, body } = await postForm(XAI_TOKEN_URL, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: XAI_CLIENT_ID,
      device_code: deviceCode,
    }, signal)
    const error = typeof body.error === 'string' ? body.error : undefined
    if (ok) return credentialFromTokenResponse(body, undefined)
    if (error === 'authorization_pending') continue
    if (error === 'slow_down') {
      const slowed = optionalPositiveNumber(body, 'interval')
      intervalSeconds = (slowed ?? intervalSeconds) + DEFAULT_POLL_INTERVAL_SECONDS
      continue
    }
    if (error === 'access_denied' || error === 'authorization_denied') {
      throw new XaiOAuthError('denied', 'xAI device authorization was denied')
    }
    if (error === 'expired_token') {
      throw new XaiOAuthError('expired', 'xAI device code expired')
    }
    throw new XaiOAuthError('failed', grantFailure(body, status))
  }
  throw new XaiOAuthError('expired', 'xAI device code expired')
}
