/**
 * Headless verification for the xAI (Grok/X subscription) OAuth plumbing
 * (src/dsh-adapter/xaiOAuth.ts + xaiRefresher.ts).
 *
 * Scenarios (all against temp dirs — nothing under ~/.dsh-tui is ever
 * touched; this module does not read ~/.pi):
 *
 *  1. store round trip: write → read identity, corrupt store → undefined,
 *     created file mode is 0600.
 *  2. refreshXaiCredential: fresh short-circuit (no network), stale refresh
 *     mints a new access token, network failure throws XaiOAuthError.
 *  3. loginXaiDevice: device code → polling → token; denied error.
 *  4. refreshXaiSubscriptionOnce: expired store rotated; fresh / route
 *     removed / env shadow / cleared credential stop the refresh.
 *
 * Run with plain node against the compiled lib (after `pnpm build`):
 * `node scripts/verify-xai-oauth.mjs`
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  XaiOAuthError,
  loginXaiDevice,
  readXaiOAuthStore,
  refreshXaiCredential,
  writeXaiOAuthStore,
} from '../lib/types/dsh-adapter/xaiOAuth.js'
import { refreshXaiSubscriptionOnce } from '../lib/types/dsh-adapter/xaiRefresher.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-xai-'))
const storePath = join(dir, 'xai-oauth.json')

{
  const store = {
    route: 'xai',
    ref: 'XAI_API_KEY',
    credential: { access: 'a1', refresh: 'r1', expires: 1234 },
  }
  check('1 store: write succeeds', writeXaiOAuthStore(store, storePath) === true)
  check('1 store: round trip identity', eq(readXaiOAuthStore(storePath), store))
  const mode = statSync(storePath).mode & 0o777
  check('1 store: file mode 0600', mode === 0o600, mode.toString(8))
  writeFileSync(storePath, '{not json')
  check('1 store: corrupt file → undefined', readXaiOAuthStore(storePath) === undefined)
}

{
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    return new Response(JSON.stringify({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
    }), { status: 200 })
  }
  try {
    const fresh = { access: 'old', refresh: 'r', expires: Date.now() + 3_600_000 }
    const untouched = await refreshXaiCredential(fresh)
    check('2 refresh: fresh credential short-circuits (no network)',
      untouched === fresh && fetchCalls === 0)

    const stale = { access: 'old', refresh: 'r', expires: Date.now() - 1000 }
    const rotated = await refreshXaiCredential(stale)
    check('2 refresh: stale token rotated',
      fetchCalls === 1
        && rotated.access === 'new-access'
        && rotated.refresh === 'new-refresh',
      JSON.stringify(rotated))
    check('2 refresh: expiry computed with skew',
      rotated.expires > Date.now() && rotated.expires < Date.now() + 3_600_000)
  } finally {
    globalThis.fetch = originalFetch
  }

  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
  }
  try {
    await refreshXaiCredential({ access: 'old', refresh: 'r', expires: Date.now() - 1000 })
    check('2 refresh: network failure throws', false)
  } catch (error) {
    check('2 refresh: network failure throws XaiOAuthError',
      error instanceof XaiOAuthError && error.code === 'failed',
      error instanceof Error ? error.message : String(error))
  }
  globalThis.fetch = originalFetch
}

{
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    calls.push(href)
    if (href.includes('/device/code')) {
      return new Response(JSON.stringify({
        device_code: 'dc',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.x.ai/device',
        interval: 1,
        expires_in: 600,
      }), { status: 200 })
    }
    if (calls.length === 2) {
      return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 })
    }
    return new Response(JSON.stringify({
      access_token: 'device-access',
      refresh_token: 'device-refresh',
      expires_in: 3600,
    }), { status: 200 })
  }
  try {
    let codeInfo = null
    const credential = await loginXaiDevice(info => {
      codeInfo = info
    })
    check('3 device: onCode surfaced the URI and code',
      eq(codeInfo, { verificationUri: 'https://auth.x.ai/device', userCode: 'ABCD-EFGH' }),
      JSON.stringify(codeInfo))
    check('3 device: device flow polled then minted a credential',
      calls.length === 3
        && credential.access === 'device-access'
        && credential.refresh === 'device-refresh',
      `${calls.length} calls, access=${credential.access}`)
  } finally {
    globalThis.fetch = originalFetch
  }

  globalThis.fetch = async (url) => {
    if (String(url).includes('/device/code')) {
      return new Response(JSON.stringify({
        device_code: 'dc',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.x.ai/device',
        interval: 1,
        expires_in: 600,
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ error: 'access_denied' }), { status: 400 })
  }
  try {
    await loginXaiDevice(() => {})
    check('3 device: denial rejected', false)
  } catch (error) {
    check('3 device: denial rejected as XaiOAuthError(denied)',
      error instanceof XaiOAuthError && error.code === 'denied',
      error instanceof Error ? error.message : String(error))
  }
  globalThis.fetch = originalFetch
}

{
  const originalFetch = globalThis.fetch
  const originalEnv = process.env.XAI_API_KEY
  delete process.env.XAI_API_KEY
  globalThis.fetch = async () => new Response(JSON.stringify({
    access_token: 'new-access',
    expires_in: 3600,
  }), { status: 200 })
  const sets = []
  const ctx = {
    get(name) {
      if (name === 'credentials') {
        return {
          resolve: async ref => ref === 'XAI_API_KEY' ? { value: 'old' } : undefined,
          set: async (ref, value) => { sets.push([ref, value]) },
        }
      }
      if (name === 'settings') {
        return { get: ns => ns === 'llm-pi-ai' ? { providers: { xai: {} } } : undefined }
      }
      return undefined
    },
    logger: { info: () => {}, warn: () => {} },
  }
  try {
    const expired = {
      route: 'xai',
      ref: 'XAI_API_KEY',
      credential: { access: 'old', refresh: 'r', expires: Date.now() - 1000 },
    }
    await refreshXaiSubscriptionOnce(ctx, expired, storePath)
    check('4 refresher: expired token rotated into the credential seam',
      eq(sets, [['XAI_API_KEY', 'new-access']]), JSON.stringify(sets))
    check('4 refresher: store file records the rotated token',
      readXaiOAuthStore(storePath)?.credential.access === 'new-access')

    const fetchCalls = []
    globalThis.fetch = async () => { fetchCalls.push(1); return new Response('{}', { status: 200 }) }
    sets.length = 0
    const fresh = {
      route: 'xai',
      ref: 'XAI_API_KEY',
      credential: { access: 'old', refresh: 'r', expires: Date.now() + 3_600_000 },
    }
    await refreshXaiSubscriptionOnce(ctx, fresh, storePath)
    check('4 refresher: fresh token untouched', sets.length === 0 && fetchCalls.length === 0)

    const noRouteCtx = {
      ...ctx,
      get(name) {
        if (name === 'settings') return { get: () => ({ providers: {} }) }
        return name === 'credentials' ? ctx.get('credentials') : undefined
      },
    }
    await refreshXaiSubscriptionOnce(noRouteCtx, fresh, storePath)
    check('4 refresher: route removed from settings stops the refresh',
      sets.length === 0 && fetchCalls.length === 0)

    process.env.XAI_API_KEY = 'shadow'
    await refreshXaiSubscriptionOnce(ctx, fresh, storePath)
    check('4 refresher: env shadow stops the refresh',
      sets.length === 0 && fetchCalls.length === 0)
    delete process.env.XAI_API_KEY

    const clearedCtx = {
      ...ctx,
      get(name) {
        if (name === 'credentials') return { resolve: async () => undefined, set: async () => {} }
        return name === 'settings' ? ctx.get('settings') : undefined
      },
    }
    await refreshXaiSubscriptionOnce(clearedCtx, {
      route: 'xai',
      ref: 'XAI_API_KEY',
      credential: { access: 'old', refresh: 'r', expires: Date.now() - 1000 },
    }, storePath)
    check('4 refresher: cleared credential stops the refresh',
      sets.length === 0 && fetchCalls.length === 0)
  } finally {
    globalThis.fetch = originalFetch
    if (originalEnv === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = originalEnv
  }
}

rmSync(dir, { recursive: true, force: true })
console.log(failed === 0 ? '\nAll xai-oauth checks passed' : `\n${failed} check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)
