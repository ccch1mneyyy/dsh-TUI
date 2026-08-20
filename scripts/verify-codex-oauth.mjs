/**
 * Headless verification for the OpenAI Codex (ChatGPT Plus/Pro) OAuth
 * plumbing (src/dsh-adapter/codexOAuth.ts + codexRefresher.ts).
 *
 * Scenarios (all against temp dirs — nothing under ~/.dsh-tui is ever
 * touched; this module does not read ~/.pi):
 *
 *  1. extractCodexAccountId from a JWT.
 *  2. store round trip: write → read identity, corrupt store → undefined,
 *     created file mode is 0600.
 *  3. refreshCodexCredential: fresh short-circuit (no network), stale
 *     refresh mints a new access token, network failure throws.
 *  4. loginCodexDevice: user code → pending poll → auth-code exchange;
 *     denied error.
 *  5. refreshCodexSubscriptionOnce: expired store rotated; fresh / route
 *     removed / env shadow / cleared credential stop the refresh.
 *
 * Run with plain node against the compiled lib (after `pnpm build`):
 * `node scripts/verify-codex-oauth.mjs`
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CodexOAuthError,
  extractCodexAccountId,
  loginCodexDevice,
  readCodexOAuthStore,
  refreshCodexCredential,
  writeCodexOAuthStore,
} from '../lib/types/dsh-adapter/codexOAuth.js'
import { refreshCodexSubscriptionOnce } from '../lib/types/dsh-adapter/codexRefresher.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** A JWT-shaped access token carrying ChatGPT account id and optional exp. */
function jwtWithAccount(accountId, expSeconds) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    ...(expSeconds === undefined ? {} : { exp: expSeconds }),
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })).toString('base64url')
  return `${header}.${payload}.sig`
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-codex-'))
const storePath = join(dir, 'codex-oauth.json')
const accountId = '95bcba73-bd54-4e5a-93a3-5ceeb179b2b8'
const accessJwt = jwtWithAccount(accountId, 1_800_000)

check('1 extract: accountId from JWT', extractCodexAccountId(accessJwt) === accountId)
check('1 extract: stored accountId wins', extractCodexAccountId(accessJwt, 'stored-id') === 'stored-id')
check('1 extract: missing JWT claim → undefined', extractCodexAccountId('not-a-jwt') === undefined)

{
  const store = {
    route: 'openai-codex',
    ref: 'OPENAI_CODEX_API_KEY',
    credential: { access: 'a1', refresh: 'r1', expires: 1234, accountId },
  }
  check('2 store: write succeeds', writeCodexOAuthStore(store, storePath) === true)
  check('2 store: round trip identity', eq(readCodexOAuthStore(storePath), store))
  const mode = statSync(storePath).mode & 0o777
  check('2 store: file mode 0600', mode === 0o600, mode.toString(8))
  writeFileSync(storePath, '{not json')
  check('2 store: corrupt file → undefined', readCodexOAuthStore(storePath) === undefined)
}

{
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  const freshAccess = jwtWithAccount('acct-rotated', 2_000_000)
  globalThis.fetch = async () => {
    fetchCalls += 1
    return new Response(JSON.stringify({
      access_token: freshAccess,
      refresh_token: 'new-refresh',
      expires_in: 3600,
    }), { status: 200 })
  }
  try {
    const fresh = { access: 'old', refresh: 'r', expires: Date.now() + 3_600_000, accountId }
    const untouched = await refreshCodexCredential(fresh)
    check('3 refresh: fresh credential short-circuits (no network)',
      untouched === fresh && fetchCalls === 0)

    const stale = { access: 'old', refresh: 'r', expires: Date.now() - 1000, accountId }
    const rotated = await refreshCodexCredential(stale)
    check('3 refresh: stale token rotated',
      fetchCalls === 1
        && rotated.access === freshAccess
        && rotated.refresh === 'new-refresh'
        && rotated.accountId === 'acct-rotated',
      JSON.stringify({ ...rotated, access: 'jwt' }))
    check('3 refresh: expiry computed with skew',
      rotated.expires > Date.now() && rotated.expires < Date.now() + 3_600_000)
  } finally {
    globalThis.fetch = originalFetch
  }

  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
  }
  try {
    await refreshCodexCredential({ access: 'old', refresh: 'r', expires: Date.now() - 1000 })
    check('3 refresh: network failure throws', false)
  } catch (error) {
    check('3 refresh: network failure throws CodexOAuthError',
      error instanceof CodexOAuthError && error.code === 'failed',
      error instanceof Error ? error.message : String(error))
  }
  globalThis.fetch = originalFetch
}

{
  const originalFetch = globalThis.fetch
  const calls = []
  const deviceAccess = jwtWithAccount('acct-device', 2_000_000)
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    calls.push(href)
    if (href.includes('/deviceauth/usercode')) {
      return new Response(JSON.stringify({
        device_auth_id: 'da-1',
        user_code: 'ABCD-EFGH',
        interval: 1,
      }), { status: 200 })
    }
    if (href.includes('/deviceauth/token')) {
      if (calls.filter(item => item.includes('/deviceauth/token')).length === 1) {
        return new Response(JSON.stringify({ error: { code: 'deviceauth_authorization_pending' } }), { status: 403 })
      }
      return new Response(JSON.stringify({
        authorization_code: 'auth-code',
        code_verifier: 'verifier',
      }), { status: 200 })
    }
    const body = Object.fromEntries(new URLSearchParams(init.body))
    if (body.grant_type !== 'authorization_code' || body.code !== 'auth-code' || body.code_verifier !== 'verifier') {
      return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 })
    }
    return new Response(JSON.stringify({
      access_token: deviceAccess,
      refresh_token: 'device-refresh',
      expires_in: 3600,
    }), { status: 200 })
  }
  try {
    let codeInfo = null
    const credential = await loginCodexDevice(info => {
      codeInfo = info
    })
    check('4 device: onCode surfaced the URI and code',
      eq(codeInfo, { verificationUri: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' }),
      JSON.stringify(codeInfo))
    check('4 device: device flow polled then exchanged a credential',
      calls.length === 4
        && credential.access === deviceAccess
        && credential.refresh === 'device-refresh'
        && credential.accountId === 'acct-device',
      `${calls.length} calls, account=${credential.accountId}`)
  } finally {
    globalThis.fetch = originalFetch
  }

  globalThis.fetch = async (url) => {
    if (String(url).includes('/deviceauth/usercode')) {
      return new Response(JSON.stringify({
        device_auth_id: 'da-1',
        user_code: 'ABCD-EFGH',
        interval: 1,
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ error: 'access_denied' }), { status: 400 })
  }
  try {
    await loginCodexDevice(() => {})
    check('4 device: denial rejected', false)
  } catch (error) {
    check('4 device: denial rejected as CodexOAuthError(denied)',
      error instanceof CodexOAuthError && error.code === 'denied',
      error instanceof Error ? error.message : String(error))
  }
  globalThis.fetch = originalFetch
}

{
  const originalFetch = globalThis.fetch
  const originalEnv = process.env.OPENAI_CODEX_API_KEY
  delete process.env.OPENAI_CODEX_API_KEY
  const freshAccess = jwtWithAccount('acct-refresh', 2_000_000)
  globalThis.fetch = async () => new Response(JSON.stringify({
    access_token: freshAccess,
    refresh_token: 'kept-refresh',
    expires_in: 3600,
  }), { status: 200 })
  const sets = []
  const ctx = {
    get(name) {
      if (name === 'credentials') {
        return {
          resolve: async ref => ref === 'OPENAI_CODEX_API_KEY' ? { value: 'old' } : undefined,
          set: async (ref, value) => { sets.push([ref, value]) },
        }
      }
      if (name === 'settings') {
        return { get: ns => ns === 'llm-pi-ai' ? { providers: { 'openai-codex': {} } } : undefined }
      }
      return undefined
    },
    logger: { info: () => {}, warn: () => {} },
  }
  try {
    const expired = {
      route: 'openai-codex',
      ref: 'OPENAI_CODEX_API_KEY',
      credential: { access: 'old', refresh: 'r', expires: Date.now() - 1000, accountId },
    }
    await refreshCodexSubscriptionOnce(ctx, expired, storePath)
    check('5 refresher: expired token rotated into the credential seam',
      eq(sets, [['OPENAI_CODEX_API_KEY', freshAccess]]),
      JSON.stringify(sets.map(([ref]) => ref)))
    check('5 refresher: store file records the rotated token',
      readCodexOAuthStore(storePath)?.credential.access === freshAccess)

    const fetchCalls = []
    globalThis.fetch = async () => { fetchCalls.push(1); return new Response('{}', { status: 200 }) }
    sets.length = 0
    const fresh = {
      route: 'openai-codex',
      ref: 'OPENAI_CODEX_API_KEY',
      credential: { access: 'old', refresh: 'r', expires: Date.now() + 3_600_000, accountId },
    }
    await refreshCodexSubscriptionOnce(ctx, fresh, storePath)
    check('5 refresher: fresh token untouched', sets.length === 0 && fetchCalls.length === 0)

    const noRouteCtx = {
      ...ctx,
      get(name) {
        if (name === 'settings') return { get: () => ({ providers: {} }) }
        return name === 'credentials' ? ctx.get('credentials') : undefined
      },
    }
    await refreshCodexSubscriptionOnce(noRouteCtx, fresh, storePath)
    check('5 refresher: route removed from settings stops the refresh',
      sets.length === 0 && fetchCalls.length === 0)

    process.env.OPENAI_CODEX_API_KEY = 'shadow'
    await refreshCodexSubscriptionOnce(ctx, fresh, storePath)
    check('5 refresher: env shadow stops the refresh',
      sets.length === 0 && fetchCalls.length === 0)
    delete process.env.OPENAI_CODEX_API_KEY

    const clearedCtx = {
      ...ctx,
      get(name) {
        if (name === 'credentials') return { resolve: async () => undefined, set: async () => {} }
        return name === 'settings' ? ctx.get('settings') : undefined
      },
    }
    await refreshCodexSubscriptionOnce(clearedCtx, {
      route: 'openai-codex',
      ref: 'OPENAI_CODEX_API_KEY',
      credential: { access: 'old', refresh: 'r', expires: Date.now() - 1000, accountId },
    }, storePath)
    check('5 refresher: cleared credential stops the refresh',
      sets.length === 0 && fetchCalls.length === 0)
  } finally {
    globalThis.fetch = originalFetch
    if (originalEnv === undefined) delete process.env.OPENAI_CODEX_API_KEY
    else process.env.OPENAI_CODEX_API_KEY = originalEnv
  }
}

rmSync(dir, { recursive: true, force: true })
console.log(failed === 0 ? '\nAll codex-oauth checks passed' : `\n${failed} check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)
