/**
 * OpenAI Codex (ChatGPT Plus/Pro subscription) OAuth credential management
 * for the `/provider` wizard and its background refresher.
 *
 * Codex authenticates through OpenAI's ChatGPT OAuth (the same client pi
 * uses: `app_EMoamEEZ73f0CkXaXp7hrann`). The access token is a JWT that
 * `dsh-llm-pi-ai` sends as the bearer; pi-ai's `openai-codex-responses`
 * implementation extracts `chatgpt_account_id` from that JWT at request
 * time, so the harness credential store only needs the access string.
 * Refresh token + expiry live in `~/.dsh-tui/codex-oauth.json` (0600).
 *
 * Device login is OpenAI's custom device-auth (not RFC 8628): a user-code
 * request, a poll that yields an authorization code + PKCE verifier, then
 * a standard authorization-code exchange. Subscription auth is device-code
 * only — this module does not read `~/.pi` auth or model files.
 *
 * The module is React-free so `scripts/verify-codex-oauth.mjs` can drive
 * it headless and the refresher can run without UI state.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../utils/paths.js'

/** The OAuth client pi's SDK uses for Codex; tokens are interchangeable with pi's. */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

const AUTH_BASE_URL = 'https://auth.openai.com'
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`

/** Device-code lifetime; OpenAI does not return `expires_in` on the user-code reply. */
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60

/** JWT claim object that carries the ChatGPT account id. */
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

/** Refresh before the reported expiry so a token never dies mid-request. */
export const CODEX_REFRESH_SKEW_MS = 5 * 60 * 1000

/** Poll interval fallback when the device response omits `interval`. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5

/** The TUI's own refresh record (see the module header). */
export const CODEX_OAUTH_STORE_PATH = join(DATA_DIR, 'codex-oauth.json')

/** One Codex OAuth credential: the bearer plus what it takes to rotate it. */
export interface CodexOAuthCredential {
  /** Access token, sent as the bearer for chatgpt.com/backend-api. */
  access: string
  /** Refresh token; OpenAI may rotate it on refresh. */
  refresh: string
  /** Epoch ms at which the access token counts as expired (skew included when minted here). */
  expires: number
  /** ChatGPT account id; also embedded in the access JWT. */
  accountId?: string
}

/** What the refresher needs to keep a route's credential alive. */
export interface CodexOAuthStore {
  /** Provider route the credential belongs to (the `llm-pi-ai` profile). */
  route: string
  /** Credential-ref the access token is written under (`apiKeyEnv`). */
  ref: string
  credential: CodexOAuthCredential
}

/** Device-code info the wizard surfaces to the user. */
export interface CodexDeviceCodeInfo {
  /** https URL the user opens. */
  verificationUri: string
  /** The human-typed authorization code. */
  userCode: string
}

/** OAuth failure kinds the wizard can translate to user-facing text. */
export type CodexOAuthErrorCode = 'cancelled' | 'denied' | 'expired' | 'failed'

/** A failed Codex OAuth exchange, carrying the wizard-mappable kind. */
export class CodexOAuthError extends Error {
  constructor(
    readonly code: CodexOAuthErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CodexOAuthError'
  }
}

/** Decode a JWT payload, when parseable. */
function decodeJwt(access: string): Record<string, unknown> | undefined {
  try {
    const payload = access.split('.')[1]
    if (payload === undefined) return undefined
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/**
 * ChatGPT account id from a stored field or the access JWT. Requests fail
 * without it (`chatgpt-account-id`), so a credential that cannot name one
 * is unusable.
 */
export function extractCodexAccountId(access: string, stored?: string): string | undefined {
  if (typeof stored === 'string' && stored.length > 0) return stored
  const auth = decodeJwt(access)?.[JWT_CLAIM_PATH]
  if (auth === null || typeof auth !== 'object' || Array.isArray(auth)) return undefined
  const accountId = (auth as Record<string, unknown>).chatgpt_account_id
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined
}

/**
 * The persisted refresh record, when present and well-formed.
 * @param path - The store file (injectable for tests).
 * @returns The store, or undefined when absent or corrupt.
 */
export function readCodexOAuthStore(path: string = CODEX_OAUTH_STORE_PATH): CodexOAuthStore | undefined {
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
  const accountId = typeof parts.accountId === 'string' && parts.accountId !== ''
    ? parts.accountId
    : undefined
  return {
    route: record.route,
    ref: record.ref,
    credential: {
      access: parts.access,
      refresh: parts.refresh,
      expires: parts.expires as number,
      ...(accountId === undefined ? {} : { accountId }),
    },
  }
}

/**
 * Persist the refresh record under `~/.dsh-tui/codex-oauth.json` with mode
 * 0600 (it holds a long-lived refresh secret). Best effort: the wizard warns
 * when this fails, because the alternative — no refresh record — means the
 * route dies with its access token.
 * @param store - The record to persist.
 * @param path - The store file (injectable for tests).
 * @returns True when written.
 */
export function writeCodexOAuthStore(
  store: CodexOAuthStore,
  path: string = CODEX_OAUTH_STORE_PATH,
): boolean {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

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
    if (signal?.aborted) throw new CodexOAuthError('cancelled', 'OpenAI Codex OAuth cancelled')
    throw error
  }
  return readJsonResponse(response)
}

async function postJson(
  url: string,
  payload: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown>; text: string }> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw new CodexOAuthError('cancelled', 'OpenAI Codex OAuth cancelled')
    throw error
  }
  const text = await response.text().catch(() => '')
  let parsed: unknown
  try {
    parsed = text === '' ? {} : JSON.parse(text)
  } catch {
    parsed = {}
  }
  const body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
  return { ok: response.ok, status: response.status, body, text }
}

async function readJsonResponse(
  response: Response,
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new CodexOAuthError(
      'failed',
      `OpenAI Codex OAuth returned invalid JSON (HTTP ${response.status})`,
    )
  }
  const body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
  return { ok: response.ok, status: response.status, body }
}

function grantFailure(body: Record<string, unknown>, status: number): string {
  const error = typeof body.error === 'string' ? body.error : undefined
  const description = typeof body.error_description === 'string' ? body.error_description : undefined
  const detail = [error, description].filter(Boolean).join(': ')
  return `OpenAI Codex OAuth request failed (HTTP ${status})${detail === '' ? '' : `: ${detail}`}`
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new CodexOAuthError('failed', `Invalid OpenAI Codex OAuth response field: ${field}`)
  }
  return value
}

function optionalPositiveNumber(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function deviceErrorCode(body: Record<string, unknown>): string | undefined {
  const error = body.error
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const code = (error as Record<string, unknown>).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

/**
 * Build a credential from a token response. OpenAI always returns a refresh
 * token on this client (offline_access). The account id must be present in
 * the access JWT or the token cannot drive Codex requests.
 */
function credentialFromTokenResponse(body: Record<string, unknown>): CodexOAuthCredential {
  const access = requiredString(body, 'access_token')
  const refresh = requiredString(body, 'refresh_token')
  const lifetimeSeconds = optionalPositiveNumber(body, 'expires_in')
  if (lifetimeSeconds === undefined) {
    throw new CodexOAuthError('failed', 'Invalid OpenAI Codex OAuth response field: expires_in')
  }
  const accountId = extractCodexAccountId(access)
  if (accountId === undefined) {
    throw new CodexOAuthError('failed', 'Failed to extract accountId from token')
  }
  return {
    access,
    refresh,
    expires: Date.now() + lifetimeSeconds * 1000 - CODEX_REFRESH_SKEW_MS,
    accountId,
  }
}

/**
 * Refresh a Codex credential with its refresh token. A credential still
 * outside the refresh skew is returned unchanged.
 * @param credential - The stored credential.
 * @param signal - Aborts the request; aborted calls throw `cancelled`.
 * @returns A credential whose access token is fresh enough to send.
 */
export async function refreshCodexCredential(
  credential: CodexOAuthCredential,
  signal?: AbortSignal,
): Promise<CodexOAuthCredential> {
  if (credential.expires - Date.now() > CODEX_REFRESH_SKEW_MS) return credential
  const { ok, status, body } = await postForm(TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: CODEX_CLIENT_ID,
    refresh_token: credential.refresh,
  }, signal)
  if (!ok) throw new CodexOAuthError('failed', grantFailure(body, status))
  return credentialFromTokenResponse(body)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CodexOAuthError('cancelled', 'OpenAI Codex OAuth cancelled'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new CodexOAuthError('cancelled', 'OpenAI Codex OAuth cancelled'))
    }, { once: true })
  })
}

/**
 * Run the Codex device-authorization flow: request a user code, surface it
 * through `onCode`, poll until OpenAI yields an authorization code, then
 * exchange it for tokens.
 * @param onCode - Called once the user code is obtained.
 * @param signal - Aborts the polls; aborted calls throw `cancelled`.
 * @returns The fresh credential.
 */
export async function loginCodexDevice(
  onCode: (info: CodexDeviceCodeInfo) => void,
  signal?: AbortSignal,
): Promise<CodexOAuthCredential> {
  const start = await postJson(DEVICE_USER_CODE_URL, { client_id: CODEX_CLIENT_ID }, signal)
  if (!start.ok) {
    if (start.status === 404) {
      throw new CodexOAuthError(
        'failed',
        'OpenAI Codex device code login is not enabled for this server. Use browser login or verify the server URL.',
      )
    }
    throw new CodexOAuthError(
      'failed',
      `OpenAI Codex device code request failed with status ${start.status}${
        start.text === '' ? '' : `: ${start.text}`
      }`,
    )
  }
  const deviceAuthId = requiredString(start.body, 'device_auth_id')
  const userCode = requiredString(start.body, 'user_code')
  const intervalRaw = start.body.interval
  const intervalSeconds = typeof intervalRaw === 'string'
    ? Number(intervalRaw.trim())
    : optionalPositiveNumber(start.body, 'interval') ?? DEFAULT_POLL_INTERVAL_SECONDS
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
    throw new CodexOAuthError('failed', `Invalid OpenAI Codex device code response: ${JSON.stringify(start.body)}`)
  }
  onCode({ verificationUri: DEVICE_VERIFICATION_URI, userCode })

  const deadline = Date.now() + DEVICE_CODE_TIMEOUT_SECONDS * 1000
  let intervalMs = Math.max(1000, Math.floor(intervalSeconds * 1000))
  let firstPoll = true
  while (Date.now() < deadline) {
    if (firstPoll) {
      firstPoll = false
    } else {
      await sleep(intervalMs, signal)
    }
    const poll = await postJson(DEVICE_TOKEN_URL, {
      device_auth_id: deviceAuthId,
      user_code: userCode,
    }, signal)
    if (poll.ok) {
      const authorizationCode = requiredString(poll.body, 'authorization_code')
      const codeVerifier = requiredString(poll.body, 'code_verifier')
      const { ok, status, body } = await postForm(TOKEN_URL, {
        grant_type: 'authorization_code',
        client_id: CODEX_CLIENT_ID,
        code: authorizationCode,
        code_verifier: codeVerifier,
        redirect_uri: DEVICE_REDIRECT_URI,
      }, signal)
      if (!ok) throw new CodexOAuthError('failed', grantFailure(body, status))
      return credentialFromTokenResponse(body)
    }
    if (poll.status === 403 || poll.status === 404) continue
    const error = deviceErrorCode(poll.body)
    if (error === 'deviceauth_authorization_pending' || error === 'authorization_pending') continue
    if (error === 'slow_down') {
      intervalMs += DEFAULT_POLL_INTERVAL_SECONDS * 1000
      continue
    }
    if (error === 'access_denied' || error === 'authorization_denied') {
      throw new CodexOAuthError('denied', 'OpenAI Codex device authorization was denied')
    }
    if (error === 'expired_token') {
      throw new CodexOAuthError('expired', 'OpenAI Codex device code expired')
    }
    throw new CodexOAuthError(
      'failed',
      `OpenAI Codex device auth failed with status ${poll.status}${
        poll.text === '' ? '' : `: ${poll.text}`
      }`,
    )
  }
  throw new CodexOAuthError('expired', 'OpenAI Codex device code expired')
}
