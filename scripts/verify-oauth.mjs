/**
 * Headless smoke for the built-in OAuth entry — real Cordis registration,
 * but no Harness host, real credentials, or external network. The legacy
 * profile-update fixture binds the official webserver to a loopback port.
 *
 * Covers: the credential file as a pi-ai `CredentialStore` (write/read/
 * modify/delete, list metadata, the serialized modify pi-ai's refresh-under-
 * lock depends on, loud corrupt-file refusal, loud refusal of non-OAuth
 * writes, stable OpenAI device ID), the mounted profiles (catalog identity,
 * runtime-gated OAuth flow presence, adapter-facing defaults), the question
 * bridge (select/text mapping, browser callback/manual-input single surface,
 * waiting-panel cancel wiring), and the service api (status/login/logout
 * over a fabricated flow), the Host-owned DeepSeek account handoff (state,
 * callback origin, browser panel, cancellation including logout during
 * pending callback resolution, masked command results,
 * profile-only update fallback listener and cleanup),
 * plus the public ./oauth entry's
 * route/command/service mount and lifecycle cleanup.
 *
 * Run after build: `pnpm verify:oauth`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settled } from './lib/term-test.mjs'

process.env.DSH_TUI_LANG = 'en'
const oauthModule = await import('../lib/types/oauth.js')
const {
  CredentialFile,
  defaultCredentialsFile,
  buildOAuthProfile,
  OAUTH_PROVIDER_IDS,
  availableOAuthProviderIds,
  QuestionBridge,
  createDshAuthApi,
  openerFor,
  CredentialGatedAdapter,
  DEEPSEEK_ACCOUNT_PROVIDER,
  deepSeekCallbackOrigin,
  deepSeekClientMetadata,
  loginDeepSeekAccount,
  WhaleCouponStore,
} = oauthModule
const { Context } = await import('@deepseek-ai/cordis')
const { QuestionStore } = await import('../lib/types/dsh-adapter/questions.js')
const { createDeepSeekCallbackOriginResolver } = await import('../lib/types/dsh-adapter/oauth/deepseek.js')
const { setLang } = await import('../lib/types/i18n.js')

/** Adapter options over one profile — enough for listModels/resolveModel offline. */
function gateAdapterOptions() {
  const profiles = new Map([['openai-codex', buildOAuthProfile('openai-codex')], ['anthropic', buildOAuthProfile('anthropic')]])
  return {
    profiles: () => profiles,
    resolveApiKey: async () => undefined,
    auth: {
      credentials: { read: async () => undefined, list: async () => [], modify: async (_p, fn) => fn(undefined), delete: async () => {} },
      authContext: { env: async () => undefined, fileExists: async () => false },
    },
  }
}

let passed = 0
let failed = 0
const ok = (condition, label) => {
  if (condition) {
    passed += 1
    console.log(`  ok  ${label}`)
  } else {
    failed += 1
    console.error(`FAIL  ${label}`)
  }
}

/** A credential-free account state stream with the same attempt transitions as the Host. */
function fakeDeepSeekAccount() {
  const id = 'account-attempt-1'
  const links = { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top-up' }
  let state = { status: 'signed-out', links, attempt: null }
  let revision = 0
  const wakes = new Set()
  const calls = { starts: [], cancels: [], signOuts: [] }
  const update = next => {
    state = next
    revision += 1
    for (const wake of [...wakes]) wake()
  }
  return {
    calls,
    current: () => state,
    update,
    getState: async () => state,
    startSignIn: async (client, origin, source) => {
      calls.starts.push({ client, origin, source })
      update({ status: 'signed-out', links, attempt: { id, phase: 'initializing' } })
      return state
    },
    cancelSignIn: async target => {
      calls.cancels.push(target)
      if (state.attempt?.id === target && !['succeeded', 'failed', 'cancelled', 'expired'].includes(state.attempt.phase)) {
        update({ status: 'signed-out', links, attempt: { id, phase: 'cancelled' } })
      }
      return state
    },
    signOut: async client => {
      calls.signOuts.push(client)
      update({ status: 'signed-out', links, attempt: null })
      return state
    },
    async *watch(signal) {
      let seen = -1
      while (!signal.aborted) {
        if (revision !== seen) {
          seen = revision
          yield state
          continue
        }
        await new Promise(resolve => {
          const wake = () => {
            wakes.delete(wake)
            signal.removeEventListener('abort', wake)
            resolve()
          }
          wakes.add(wake)
          signal.addEventListener('abort', wake, { once: true })
        })
      }
    },
  }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-auth-smoke-'))
try {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  ok(manifest.dependencies?.['@deepseek-harness-tui/dsh-auth'] === undefined
    && !(manifest.bundledDependencies ?? []).includes('@deepseek-harness-tui/dsh-auth'),
    'the TUI has no runtime or bundled dependency on the former auth package')
  const previousHome = process.env.DSH_HOME
  const previousCredentials = process.env.DSH_AUTH_CREDENTIALS
  try {
    process.env.DSH_HOME = root
    delete process.env.DSH_AUTH_CREDENTIALS
    ok(defaultCredentialsFile() === join(root, 'dsh-auth', 'credentials.json'),
      'the built-in module reuses the previous credential location')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousCredentials === undefined) delete process.env.DSH_AUTH_CREDENTIALS
    else process.env.DSH_AUTH_CREDENTIALS = previousCredentials
  }

  // ── credential store ─────────────────────────────────────────────────────
  console.log('credential store')
  const store = new CredentialFile(join(root, 'creds', 'credentials.json'))
  const firstCred = { type: 'oauth', access: 'a1', refresh: 'r1', expires: Date.now() + 3_600_000 }
  await store.modify('anthropic', async () => firstCred)
  ok((await store.read('anthropic'))?.access === 'a1', 'modify persists and read returns the credential')
  const document = JSON.parse(readFileSync(store.path, 'utf8'))
  ok(document.version === 1 && document.providers['anthropic']?.type === 'oauth', 'file shape is the versioned document')
  await store.modify('anthropic', async () => undefined)
  ok((await store.read('anthropic'))?.access === 'a1', 'undefined from modify leaves the entry unchanged')
  ok((await store.list()).length === 1 && (await store.list())[0].type === 'oauth', 'list reports credential metadata without secrets')
  ok((await store.describe()).length === 1, 'describe lists stored providers without secrets')

  // The exclusion pi-ai's refresh-under-lock depends on: two modifies for one
  // provider run serialized, the second seeing the first's write.
  let observed = []
  await Promise.all([
    store.modify('xai', async current => {
      observed.push(current?.access)
      await Promise.resolve()
      return { type: 'oauth', access: 'x1', refresh: 'r', expires: Date.now() + 60_000 }
    }),
    store.modify('xai', async current => {
      observed.push(current?.access)
      return { type: 'oauth', access: 'x2', refresh: 'r', expires: Date.now() + 60_000 }
    }),
  ])
  ok(JSON.stringify(observed) === JSON.stringify([undefined, 'x1']), `concurrent modifies serialize, each seeing the last write (saw ${JSON.stringify(observed)})`)
  ok((await store.read('xai'))?.access === 'x2', 'the last modify wins on disk')

  // Different providers share one JSON document. Their writes must not both
  // start from the same snapshot and let the later rename erase the first.
  await Promise.all([
    store.modify('openai-codex', async () => {
      await Promise.resolve()
      return { type: 'oauth', access: 'c1', refresh: 'r', expires: Date.now() + 60_000 }
    }),
    store.modify('meta', async () => ({ type: 'oauth', access: 'm1', refresh: 'r', expires: Date.now() + 60_000 })),
  ])
  const concurrentDocument = JSON.parse(readFileSync(store.path, 'utf8'))
  ok(concurrentDocument.providers['openai-codex']?.access === 'c1'
    && concurrentDocument.providers['meta']?.access === 'm1',
  'concurrent writes to different providers retain both credentials on disk')

  const sharedPath = join(root, 'cross-process', 'credentials.json')
  const parentStore = new CredentialFile(sharedPath)
  let childDone
  await parentStore.modify('openai-codex', async () => {
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', `
        const { CredentialFile } = await import(process.argv[1])
        const store = new CredentialFile(process.argv[2])
        await store.read('meta')
        process.stdout.write('ready\\n')
        await store.modify('meta', async () => ({ type: 'oauth', access: 'm2', refresh: 'r', expires: Date.now() + 60_000 }))
      `,
      new URL('../lib/types/dsh-adapter/oauth/credentials.js', import.meta.url).href, sharedPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let childError = ''
    child.stderr.on('data', chunk => { childError += String(chunk) })
    childDone = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => code === 0 ? resolve() : reject(new Error(childError || `child exited ${code}`)))
    })
    await new Promise((resolve, reject) => {
      child.stdout.once('data', chunk => String(chunk).includes('ready') ? resolve() : reject(new Error(`unexpected child output: ${chunk}`)))
      child.once('error', reject)
    })
    return { type: 'oauth', access: 'c2', refresh: 'r', expires: Date.now() + 60_000 }
  })
  await childDone
  const sharedDocument = JSON.parse(readFileSync(sharedPath, 'utf8'))
  ok(sharedDocument.providers['openai-codex']?.access === 'c2'
    && sharedDocument.providers['meta']?.access === 'm2',
  'two processes writing one credential file retain both providers')
  await parentStore.delete('openai-codex')
  const afterCrossProcessDelete = JSON.parse(readFileSync(sharedPath, 'utf8'))
  ok(afterCrossProcessDelete.providers['openai-codex'] === undefined
    && afterCrossProcessDelete.providers['meta']?.access === 'm2',
  'deleting from a stale store retains another process\'s credential')

  const observer = new CredentialFile(join(root, 'external-visibility', 'credentials.json'))
  const writer = new CredentialFile(observer.path)
  await observer.read('xai')
  await writer.modify('xai', async () => ({ type: 'oauth', access: 'external', refresh: 'r', expires: Date.now() + 60_000 }))
  ok((await observer.read('xai'))?.access === 'external'
    && (await observer.list()).some(row => row.providerId === 'xai')
    && (await observer.describe()).some(row => row.provider === 'xai'),
  'an existing store sees another process sign in')
  const signedObserver = new CredentialFile(observer.path)
  await signedObserver.read('xai')
  await writer.delete('xai')
  ok((await signedObserver.read('xai')) === undefined
    && !(await signedObserver.list()).some(row => row.providerId === 'xai')
    && !(await signedObserver.describe()).some(row => row.provider === 'xai'),
  'an existing store sees another process sign out')

  let refusedWrite = ''
  try {
    await store.modify('xai', async () => ({ type: 'api_key', key: 'nope' }))
  } catch (error) {
    refusedWrite = error.message
  }
  ok(refusedWrite.includes('OAuth credentials only'), 'a non-OAuth credential write is refused loudly')

  ok(await (async () => { const had = (await store.read('anthropic')) !== undefined; await store.delete('anthropic'); return had })(), 'delete removes the credential')
  ok((await store.read('anthropic')) === undefined, 'deleted entry reads as nothing stored')

  const corruptPath = join(root, 'corrupt.json')
  writeFileSync(corruptPath, '{not json', { mode: 0o600 })
  let corruptRefused = false
  try {
    await new CredentialFile(corruptPath).read('anyone')
  } catch {
    corruptRefused = true
  }
  ok(corruptRefused, 'corrupt file refuses loudly instead of acting empty')

  // pi-ai 0.87.1's OpenAI OAuth registration needs a stable installation UUID.
  // It lives beside, not inside, the versioned credential document and survives
  // process restarts and logout. The callback is lazy for older login flows.
  const deviceId = store.getOrCreateDeviceId()
  const deviceIdPath = join(root, 'creds', 'device-id')
  ok(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(deviceId), 'OpenAI agent-host ID is a UUID')
  ok(readFileSync(deviceIdPath, 'utf8').trim() === deviceId
    && new CredentialFile(store.path).getOrCreateDeviceId() === deviceId,
  'device ID persists independently of a CredentialFile instance')
  if (process.platform !== 'win32') {
    ok((statSync(deviceIdPath).mode & 0o777) === 0o600, 'new device ID file is mode 0600')
  }
  const invalidDeviceStore = new CredentialFile(join(root, 'invalid-device', 'credentials.json'))
  mkdirSync(join(root, 'invalid-device'))
  writeFileSync(join(root, 'invalid-device', 'device-id'), 'not-a-uuid\n', { mode: 0o600 })
  let invalidDeviceRefused = false
  try {
    invalidDeviceStore.getOrCreateDeviceId()
  } catch (error) {
    invalidDeviceRefused = error.message.includes('not a UUID')
  }
  ok(invalidDeviceRefused, 'corrupt device ID is refused instead of silently rotated')

  const directToken = {
    type: 'oauth', access: 'direct-access', refresh: 'direct-refresh', expires: Date.now() + 3_600_000,
    clientId: 'oaiapp_issued', scopes: ['chatgpt.tokens.use.direct'],
  }
  await store.modify('openai', async () => directToken)
  ok((await store.read('openai'))?.clientId === 'oaiapp_issued'
    && (await new CredentialFile(store.path).read('openai'))?.scopes?.[0] === 'chatgpt.tokens.use.direct',
  'new OpenAI OAuth client ID and scopes survive credential round-trip')

  // ── profiles ─────────────────────────────────────────────────────────────
  console.log('profiles')
  const profile = buildOAuthProfile('openai-codex')
  ok(profile.provider === 'openai-codex' && profile.displayName.length > 0, 'profile builds with catalog identity')
  ok(profile.piProvider.auth.oauth !== undefined, 'the provider keeps its OAuth flow object')
  ok(typeof profile.piProvider.auth.oauth?.name === 'string', 'the flow carries a display name')
  ok(profile.maxRequestImageBytes === 20 * 1024 * 1024, 'image budgets mirror llm-pi-ai defaults')
  ok(JSON.stringify(OAUTH_PROVIDER_IDS) === JSON.stringify(['openai', 'openai-codex', 'anthropic', 'xai', 'meta']),
    `allow-list includes the new pi-ai subscription routes (got ${OAUTH_PROVIDER_IDS.join(',')})`)
  const available = availableOAuthProviderIds()
  ok(available.includes('openai-codex') && available.includes('anthropic') && available.includes('xai')
    && available.every(id => OAUTH_PROVIDER_IDS.includes(id)),
  `defaults follow the installed adapter's OAuth catalog (got ${available.join(',')})`)
  ok(available.every(id => buildOAuthProfile(id).piProvider.auth.oauth !== undefined),
    'every default route actually has an OAuth flow')
  if (!available.includes('openai')) {
    let missingOpenAIFlow = ''
    try {
      buildOAuthProfile('openai')
    } catch (error) {
      missingOpenAIFlow = error.message
    }
    ok(missingOpenAIFlow.includes('ships no OAuth flow'), 'explicit new OpenAI route refuses an older pi-ai catalog at boot')
  }
  let unknownProvider = ''
  try {
    buildOAuthProfile('openrouter')
  } catch (error) {
    unknownProvider = error.message
  }
  ok(unknownProvider.includes('not an OAuth provider'), 'building an unmounted provider fails loudly')

  // ── per-model overrides ─────────────────────────────────────────────────
  console.log('model overrides')
  const solBase = profile.piProvider.getModels().find(model => model.id === 'gpt-5.6-sol')
  ok(solBase !== undefined && typeof solBase?.contextWindow === 'number', 'the catalog ships a numeric context window for gpt-5.6-sol')
  const overridden = buildOAuthProfile('openai-codex', {
    'gpt-5.6-sol': { contextWindow: 1000000 },
  })
  const sol = overridden.piProvider.getModels().find(model => model.id === 'gpt-5.6-sol')
  ok(sol?.contextWindow === 1000000, 'modelOverrides contextWindow lands on the target model')
  ok(sol?.maxTokens === solBase?.maxTokens, 'untouched fields keep the installed catalog value')
  const untouched = overridden.piProvider.getModels().find(model => model.id === 'gpt-5.5')
  ok(untouched?.contextWindow === solBase?.contextWindow, 'models without an override stay on the catalog value')
  ok(overridden.piProvider.getModels().length === profile.piProvider.getModels().length, 'the model list keeps every catalog entry')
  ok(overridden.piProvider.auth.oauth !== undefined, 'the provider keeps its OAuth flow object under overrides')
  ok(profile.piProvider.getModels().find(model => model.id === 'gpt-5.6-sol')?.contextWindow === solBase?.contextWindow,
    'the installed catalog object is not mutated in place')
  let unknownOverride = ''
  try {
    buildOAuthProfile('openai-codex', { 'not-a-model': { contextWindow: 1 } })
  } catch (error) {
    unknownOverride = error.message
  }
  ok(unknownOverride.includes('does not ship in the installed catalog'), 'an override naming an unknown model fails loudly')
  // Overrides are provider-scoped: a dict that tunes a Codex model is refused
  // on a provider whose catalog does not ship it (the global-dict shape made
  // one cross-provider model id break every provider's boot).
  let crossProviderOverride = ''
  try {
    buildOAuthProfile('anthropic', { 'gpt-5.6-sol': { contextWindow: 1000000 } })
  } catch (error) {
    crossProviderOverride = error.message
  }
  ok(crossProviderOverride.includes('does not ship in the installed catalog'), 'an override naming a model another provider ships is refused on this provider')

  // ── credential-gated adapter ─────────────────────────────────────────────
  console.log('credential-gated adapter')
  const gateStore = new CredentialFile(join(root, 'gate', 'credentials.json'))
  const gated = new CredentialGatedAdapter(gateAdapterOptions(), async provider => {
    try {
      return await gateStore.read(provider) !== undefined
    } catch {
      return false
    }
  })
  const anyGptModel = (await gated.listModels('openai-codex'))[0]
  ok(anyGptModel === undefined, 'unsigned provider lists no models')
  const resolvedWhileUnsigned = await gated.resolveModel('openai-codex', 'gpt-5.6-sol')
  ok(resolvedWhileUnsigned?.id === 'gpt-5.6-sol', 'resolveModel stays ungated (saved sessions keep working)')
  await gateStore.modify('openai-codex', async () => ({ type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3_600_000 }))
  const listed = await gated.listModels('openai-codex')
  ok(listed.length > 0 && listed.every(m => m.provider === 'openai-codex'), `signed-in provider lists its catalog (${listed.length} models)`)
  ok((await gated.listModels('anthropic')).length === 0, 'other unsigned providers stay hidden on the same store')

  // ── question bridge ──────────────────────────────────────────────────────
  console.log('question bridge')
  const runAbort = new AbortController()
  const asked = []
  // Scripted answers for the waiting panel, consumed in order; the default
  // mirrors the old behavior (immediate cancel).
  let waitingScript = ['Cancel sign-in']
  let waitingAsked = 0
  const openedUrls = []
  const copiedTexts = []
  const helpers = {
    openUrl: url => { openedUrls.push(url); return true },
    copyText: async text => { copiedTexts.push(text); return true },
  }
  const fakeAsk = async request => {
    asked.push(request)
    const question = request.questions[0]
    if (question.id === 'dsh-auth-prompt' && question.options !== undefined) {
      return { answers: [{ id: question.id, selected: [question.options[0].label] }] }
    }
    if (question.id === 'dsh-auth-waiting') {
      waitingAsked += 1
      const pick = waitingScript[waitingAsked - 1]
      if (pick === undefined) {
        // Script exhausted: park like a human who has not answered yet —
        // only settle()'s abort resolves this, proving the retire path.
        return new Promise((resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new Error('panel retired')), { once: true })
        })
      }
      return { answers: [{ id: question.id, selected: [pick] }] }
    }
    return { answers: [{ id: question.id, selected: [], custom: 'typed-answer' }] }
  }
  const qb = new QuestionBridge(fakeAsk, runAbort, helpers)
  const selectId = await qb.prompt({ type: 'select', message: 'Choose', options: [{ id: 'opt-2', label: 'Option Two' }, { id: 'opt-1', label: 'Option One' }] })
  ok(selectId === 'opt-2', `select prompt maps the chosen label back to its id (got ${selectId})`)
  const typed = await qb.prompt({ type: 'manual_code', message: 'Paste the code', placeholder: 'xxxx-xxxx' })
  ok(typed === 'typed-answer', 'text prompt reads the custom-answer input row')

  // auth_url: browser opens automatically, panel offers copy/reopen/cancel,
  // and each action re-asks once before the scripted cancel.
  const longUrl = 'https://auth.example/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s1'
  waitingScript = ['Copy authorization link', 'Open browser again', 'Cancel sign-in']
  qb.notify({ type: 'auth_url', url: longUrl, instructions: 'A browser window should open.' })
  const cancelled = await settled(() => runAbort.signal.aborted)
  ok(openedUrls[0] === longUrl, 'auth_url opens the browser automatically')
  ok(asked.some(r => r.questions[0]?.id === 'dsh-auth-waiting' && r.questions[0]?.options?.some(o => o.label === 'Copy authorization link')), 'waiting panel offers a copy action')
  ok(cancelled, 'cancel from the waiting panel aborts the run')
  ok(JSON.stringify(copiedTexts) === JSON.stringify([longUrl]), 'copy action copies the exact, unbroken URL')
  ok(openedUrls.length === 2 && openedUrls[1] === longUrl, 'reopen action opens the same URL again')
  ok(waitingAsked === 3, `the panel re-asks after each action (asked ${waitingAsked})`)
  await qb.settle()

  // device_code: verification page auto-opens, the code is the copy target,
  // and settle retires the panel without any cancel answer.
  const runAbort2 = new AbortController()
  const qb2 = new QuestionBridge(fakeAsk, runAbort2, helpers)
  waitingScript = ['Copy code']
  waitingAsked = 0
  qb2.notify({ type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://auth.example/device' })
  const copiedCode = await settled(() => copiedTexts.length >= 2)
  ok(openedUrls[2] === 'https://auth.example/device', 'device flow opens the verification page automatically')
  ok(copiedCode && copiedTexts[1] === 'ABCD-1234', 'copy action on the device panel copies the user code')
  ok(asked.some(r => r.questions[0]?.id === 'dsh-auth-waiting' && r.questions[0]?.options?.some(o => o.label === 'Copy code')), 'device panel offers Copy code')
  await qb2.settle()

  // auto-open failure degrades to copy guidance, never a crash.
  const runAbort3 = new AbortController()
  const qb3 = new QuestionBridge(fakeAsk, runAbort3, { openUrl: () => false, copyText: async () => false })
  waitingScript = ['Cancel sign-in']
  waitingAsked = 0
  qb3.notify({ type: 'auth_url', url: 'https://auth.example/x' })
  ok(await settled(() => asked.some(r => r.questions[0]?.id === 'dsh-auth-waiting' && (r.questions[0]?.detail ?? '').includes('too long'))),
    'failed open degrades to copy guidance')
  await qb3.settle()

  // pi-ai 0.87.1 races a loopback callback against a manual_code prompt.
  // The real FIFO QuestionStore must expose that paste input immediately,
  // not park it behind the auth_url waiting panel.
  const browserStore = new QuestionStore()
  const browserSnapshots = []
  browserStore.subscribe(() => {
    const id = browserStore.getSnapshot()?.question.id
    if (id !== undefined) browserSnapshots.push(id)
  })
  const browserAbort = new AbortController()
  const browserBridge = new QuestionBridge(request => browserStore.ask(request), browserAbort, helpers)
  browserBridge.notify({ type: 'info', message: 'Could not listen on the callback port; paste the redirect URL.' })
  browserBridge.notify({ type: 'auth_url', url: longUrl, instructions: 'Paste the final redirect URL if needed.' })
  const manual = browserBridge.prompt({ type: 'manual_code', message: 'Complete login or paste the redirect URL:' })
  ok(await settled(() => browserStore.getSnapshot()?.question.id === 'dsh-auth-prompt'),
    'browser OAuth exposes the manual-code question immediately')
  const browserQuestion = browserStore.getSnapshot()?.question
  ok(!browserSnapshots.includes('dsh-auth-waiting')
    && browserQuestion?.detail?.includes('Could not listen on the callback port')
    && browserQuestion?.detail?.includes(longUrl)
    && browserQuestion?.options?.some(option => option.label === 'Copy authorization link'),
  'one question carries the callback paste field, complete URL, copy action, and pi-ai info event')
  const copiedBefore = copiedTexts.length
  browserStore.answerCurrent({ selected: ['Copy authorization link'] })
  ok(await settled(() => copiedTexts.length === copiedBefore + 1
    && browserStore.getSnapshot()?.question.id === 'dsh-auth-prompt'),
  'copy action reopens the same manual-code question instead of stranding it')
  const callbackUrl = 'http://localhost:1455/auth/callback?code=manual&state=s1'
  // Typing on the focused copy row attaches its label; custom input must win.
  browserStore.answerCurrent({ selected: ['Copy authorization link'], custom: callbackUrl })
  ok(await manual === callbackUrl && browserStore.getSnapshot() === null,
    'a pasted callback URL resolves the pi-ai prompt despite an attached action label')
  await browserBridge.settle()

  const delayedStore = new QuestionStore()
  const delayedBridge = new QuestionBridge(request => delayedStore.ask(request), new AbortController(), helpers)
  delayedBridge.notify({ type: 'auth_url', url: longUrl })
  ok(await settled(() => delayedStore.getSnapshot()?.question.id === 'dsh-auth-waiting'),
    'browser flow without an immediate manual prompt retains a waiting panel')
  const delayedManual = delayedBridge.prompt({ type: 'manual_code', message: 'Paste code:' })
  ok(await settled(() => delayedStore.getSnapshot()?.question.id === 'dsh-auth-prompt'),
    'a later manual prompt retires the fallback waiting panel')
  delayedStore.answerCurrent({ selected: [], custom: 'later-code' })
  ok(await delayedManual === 'later-code', 'delayed manual prompt remains answerable')
  await delayedBridge.settle()

  const callbackStore = new QuestionStore()
  const callbackAbort = new AbortController()
  const callbackBridge = new QuestionBridge(request => callbackStore.ask(request), new AbortController(), helpers)
  callbackBridge.notify({ type: 'auth_url', url: longUrl })
  const callbackManual = callbackBridge.prompt({ type: 'manual_code', message: 'Paste code:', signal: callbackAbort.signal })
  ok(await settled(() => callbackStore.getSnapshot()?.question.id === 'dsh-auth-prompt'),
    'callback race has a live manual prompt before callback completion')
  callbackAbort.abort()
  let callbackPromptAborted = false
  try {
    await callbackManual
  } catch {
    callbackPromptAborted = true
  }
  ok(callbackPromptAborted && callbackStore.getSnapshot() === null,
    'callback winning aborts only its manual prompt and retires the question')
  await callbackBridge.settle()

  const externalStore = new QuestionStore()
  const externalAbort = new AbortController()
  const externalBridge = new QuestionBridge(request => externalStore.ask(request), externalAbort, helpers)
  externalBridge.notify({ type: 'auth_url', url: longUrl })
  const externalManual = externalBridge.prompt({
    type: 'manual_code', message: 'Paste code:', signal: new AbortController().signal,
  })
  ok(await settled(() => externalStore.getSnapshot()?.question.id === 'dsh-auth-prompt'),
    'manual prompt with its own signal is active before whole-login cancellation')
  externalAbort.abort('external cancellation')
  let externalCancelled = false
  try {
    await externalManual
  } catch {
    externalCancelled = true
  }
  ok(externalCancelled && externalStore.getSnapshot() === null,
    'whole-login abort still closes a manual prompt carrying a separate pi-ai signal')
  await externalBridge.settle()

  const cancelStore = new QuestionStore()
  const cancelAbort = new AbortController()
  const cancelBridge = new QuestionBridge(request => cancelStore.ask(request), cancelAbort, helpers)
  cancelBridge.notify({ type: 'auth_url', url: longUrl })
  const cancelledManual = cancelBridge.prompt({ type: 'manual_code', message: 'Paste code:' })
  ok(await settled(() => cancelStore.getSnapshot()?.question.id === 'dsh-auth-prompt'),
    'manual callback question is active before user cancellation')
  cancelStore.cancelCurrent()
  let manualCancelled = false
  try {
    await cancelledManual
  } catch {
    manualCancelled = true
  }
  ok(manualCancelled && cancelAbort.signal.aborted && cancelStore.getSnapshot() === null,
    'Esc on the manual callback question aborts the whole OAuth run')
  await cancelBridge.settle()

  const dismissStore = new QuestionStore()
  const dismissAbort = new AbortController()
  const dismissBridge = new QuestionBridge(request => dismissStore.ask(request), dismissAbort, helpers)
  dismissBridge.notify({ type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://auth.example/device' })
  ok(await settled(() => dismissStore.getSnapshot()?.question.id === 'dsh-auth-waiting'),
    'device authorization shows its waiting panel')
  dismissStore.cancelCurrent()
  ok(await settled(() => dismissAbort.signal.aborted && dismissStore.getSnapshot() === null),
    'dismissing the device-code question cancels the login instead of polling without UI')
  await dismissBridge.settle()

  setLang('zh')
  const zhStore = new QuestionStore()
  const zhBridge = new QuestionBridge(request => zhStore.ask(request), new AbortController(), helpers)
  zhBridge.notify({ type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://auth.example/device' })
  ok(await settled(() => zhStore.getSnapshot()?.question.options?.some(option => option.label === '复制代码')),
    'bridge-owned OAuth actions use the active Chinese locale')
  await zhBridge.settle()
  setLang('en')

  // ── opener argv shape ────────────────────────────────────────────────────
  console.log('opener argv')
  const authorizeLikeUrl = 'https://auth.openai.com/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s1'
  const opener = openerFor(authorizeLikeUrl)
  if (process.platform === 'win32') {
    ok(opener?.verbatim === true, 'win32 opener uses verbatim argv (node would not quote a space-free URL)')
    const startToken = opener?.args[3]
    ok(typeof startToken === 'string' && startToken.startsWith('start "" "') && startToken.endsWith('"'),
      `the whole start command is one token with the URL double-quoted inside (got ${JSON.stringify(startToken?.slice(0, 32))}…)`)
    // Live round-trip through a real cmd.exe: `&` inside double quotes must
    // survive the shell that `start` will run under. Echo (not start) keeps
    // this side-effect free.
    const echo = await new Promise(resolve => {
      const child = spawn('cmd.exe', ['/d', '/c', `echo "${authorizeLikeUrl}"`], { windowsVerbatimArguments: true })
      let out = ''
      child.stdout.on('data', chunk => { out += String(chunk) })
      child.on('close', () => resolve(out.trim()))
      child.on('error', () => resolve(''))
    })
    ok(echo.includes('client_id=app_EMoamEEZ73f0CkXaXp7hrann') && echo.includes('redirect_uri=http%3A%2F%2Flocalhost%3A1455'),
      `a quoted URL survives cmd.exe parsing intact (echo returned ${echo.length} chars)`)
  } else {
    ok(opener !== undefined && !opener.verbatim && opener.args[0] === authorizeLikeUrl,
      `${process.platform} opener passes the URL as a single exec argument (no shell)`)
  }

  // ── service api ──────────────────────────────────────────────────────────
  console.log('service api')
  const apiStore = new CredentialFile(join(root, 'api', 'credentials.json'))
  let loginDeviceId
  const fakeProvider = {
    id: 'fake',
    name: 'Fake Provider',
    auth: {
      oauth: {
        name: 'Fake (subscription)',
        loginLabel: 'Sign in with Fake',
        async login(_interaction, options) {
          loginDeviceId = options?.getDeviceId?.()
          return {
            type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3_600_000,
            clientId: 'oaiapp_issued', scopes: ['chatgpt.tokens.use.direct'],
          }
        },
        async refresh(credential) {
          return credential
        },
        async toAuth() {
          return { headers: { authorization: 'Bearer a' } }
        },
      },
    },
  }
  const fakeProfile = { provider: 'fake', displayName: 'Fake Provider', streamIdleTimeoutMs: 300_000, retryPolicy: { mode: 'normal', maxRetries: 2, retryDelayMs: () => 1 }, configuredMaxTokens: new Map(), piProvider: fakeProvider, maxRequestImageBytes: 1, requestImagePixelBudget: 1, requestImageMaxBytes: 1 }
  const api = createDshAuthApi({
    profiles: new Map([['fake', fakeProfile]]),
    store: apiStore,
    resolveAsk: () => fakeAsk,
  })
  ok((await api.providers())[0].signedIn === false, 'status reports unsigned providers')
  const login = await api.login('fake')
  ok(login.oauthLabel === 'Fake (subscription)' && (await apiStore.read('fake'))?.access === 'a', 'login runs the flow and persists the credential')
  ok(loginDeviceId === apiStore.getOrCreateDeviceId()
    && (await apiStore.read('fake'))?.clientId === 'oaiapp_issued',
  'service passes pi-ai 0.87.1 login options and preserves flow-specific credential fields')
  ok((await api.providers())[0].signedIn === true, 'status reports the signed-in provider')
  ok(await api.logout('fake'), 'logout removes the credential')
  ok(readFileSync(join(root, 'api', 'device-id'), 'utf8').trim() === loginDeviceId,
    'logout leaves the stable OpenAI installation ID intact')

  let completeLateLogin
  let lateLoginSignal
  const lateProvider = {
    ...fakeProvider,
    auth: { oauth: {
      ...fakeProvider.auth.oauth,
      login(interaction) {
        lateLoginSignal = interaction.signal
        return new Promise(resolve => { completeLateLogin = resolve })
      },
    } },
  }
  const lateStore = new CredentialFile(join(root, 'late-login', 'credentials.json'))
  const lateApi = createDshAuthApi({
    profiles: new Map([['fake', { ...fakeProfile, piProvider: lateProvider }]]),
    store: lateStore,
    resolveAsk: () => fakeAsk,
  })
  const lateLogin = lateApi.login('fake').then(() => 'success', error => String(error))
  ok(await settled(() => completeLateLogin !== undefined), 'late login flow started')
  await lateApi.logout('fake')
  completeLateLogin({ type: 'oauth', access: 'late', refresh: 'r', expires: Date.now() + 60_000 })
  const lateResult = await lateLogin
  ok(lateLoginSignal.aborted && lateResult !== 'success' && (await lateStore.read('fake')) === undefined,
    'logout cancels an in-flight login and prevents its late credential write')

  const legacyStore = new CredentialFile(join(root, 'legacy-api', 'credentials.json'))
  const legacyProfile = {
    ...fakeProfile,
    piProvider: {
      ...fakeProvider,
      auth: { oauth: {
        ...fakeProvider.auth.oauth,
        async login() { return { type: 'oauth', access: 'old', refresh: 'old-r', expires: Date.now() + 3_600_000 } },
      } },
    },
  }
  const legacyApi = createDshAuthApi({
    profiles: new Map([['fake', legacyProfile]]), store: legacyStore,
    resolveAsk: () => fakeAsk,
  })
  await legacyApi.login('fake')
  ok(!existsSync(join(root, 'legacy-api', 'device-id')),
    'older one-argument pi-ai flows ignore the new login context without creating an ID')
  let unknownLogin = ''
  try {
    await api.login('nobody')
  } catch (error) {
    unknownLogin = error.message
  }
  ok(unknownLogin.includes('unknown provider'), 'login names the mounted set on an unknown provider')

  // ── Host-owned DeepSeek account ──────────────────────────────────────────
  console.log('DeepSeek account handoff')
  const callbackContext = new Context()
  try {
    let noListener = ''
    try { deepSeekCallbackOrigin(callbackContext) } catch (error) { noListener = error.message }
    ok(noListener.includes('webServer'), 'a callback-origin lookup refuses without a Host listener')
    callbackContext.provide('webServer', { port: 43123 })
    ok(deepSeekCallbackOrigin(callbackContext) === 'http://127.0.0.1:43123',
      'the callback origin uses the active Host port and loopback address')
  } finally {
    await callbackContext.fiber.dispose()
  }
  const invalidCallbackContext = new Context()
  const unreadyWebServer = { port: 0 }
  invalidCallbackContext.provide('webServer', unreadyWebServer)
  try {
    const resolver = createDeepSeekCallbackOriginResolver(invalidCallbackContext)
    let invalidListener = ''
    try { await resolver.resolve() } catch (error) { invalidListener = error.message }
    ok(invalidListener.includes('needs an active Host webServer')
      && invalidCallbackContext.get('webServer') === unreadyWebServer,
    'an existing but unready Host listener is not shadowed by a fallback')
    await resolver.dispose()
  } finally {
    await invalidCallbackContext.fiber.dispose()
  }
  const declaredCallbackContext = new Context()
  declaredCallbackContext.provide('loader', {
    entries: () => [{ options: { id: 'dsh-tui-webserver', name: '@deepseek-ai/dsh-host-webserver' }, disabled: true }],
  })
  try {
    const resolver = createDeepSeekCallbackOriginResolver(declaredCallbackContext)
    let missingDeclaredListener = ''
    try { await resolver.resolve() } catch (error) { missingDeclaredListener = error.message }
    ok(missingDeclaredListener.includes('needs an active Host webServer')
      && declaredCallbackContext.get('webServer') === undefined,
    'a declared but disabled Host listener is not bypassed by the legacy fallback')
    await resolver.dispose()
  } finally {
    await declaredCallbackContext.fiber.dispose()
  }
  const callbackOrigin = 'http://127.0.0.1:43123'
  const englishClient = deepSeekClientMetadata()
  setLang('zh')
  const chineseClient = deepSeekClientMetadata()
  setLang('en')
  ok(englishClient.version === manifest.version && englishClient.locale === 'en-US'
    && chineseClient.locale === 'zh-CN'
    && englishClient.timezoneOffsetSeconds === -new Date().getTimezoneOffset() * 60,
  'account requests identify the current TUI version, language, and timezone')

  const account = fakeDeepSeekAccount()
  const accountQuestions = new QuestionStore()
  const accountOpened = []
  const accountUrl = 'https://platform.deepseek.com/dsh/authorize?authorize_id=fixture'
  const accountLogin = loginDeepSeekAccount(account, callbackOrigin,
    request => accountQuestions.ask(request), undefined, {
      openUrl: url => { accountOpened.push(url); return true },
      copyText: async () => true,
    })
  ok(await settled(() => account.calls.starts.length === 1)
    && account.calls.starts[0].origin === callbackOrigin
    && account.calls.starts[0].source === 'desktop',
  'DeepSeek authorization requests Desktop promotion through the Host with its loopback callback origin')
  account.update({ ...account.current(), attempt: { id: 'account-attempt-1', phase: 'waiting-browser', authorizeUrl: accountUrl } })
  ok(await settled(() => accountQuestions.getSnapshot()?.question.id === 'dsh-auth-waiting')
    && accountOpened[0] === accountUrl
    && accountQuestions.getSnapshot()?.question.detail?.includes(accountUrl),
  'Host authorize URL opens through the existing question bridge and remains copyable')
  account.update({ ...account.current(), status: 'credential-stored', attempt: { id: 'account-attempt-1', phase: 'succeeded' } })
  await accountLogin
  ok(account.calls.cancels.length === 0 && accountQuestions.getSnapshot() === null,
    'a committed Host credential completes sign-in and retires the waiting panel')

  const cancelledAccount = fakeDeepSeekAccount()
  const cancelledQuestions = new QuestionStore()
  const cancelledLogin = loginDeepSeekAccount(cancelledAccount, callbackOrigin,
    request => cancelledQuestions.ask(request), undefined, { openUrl: () => false })
    .then(() => '', error => error.message)
  ok(await settled(() => cancelledAccount.calls.starts.length === 1), 'cancel fixture started its Host attempt')
  cancelledAccount.update({ ...cancelledAccount.current(), attempt: { id: 'account-attempt-1', phase: 'waiting-browser', authorizeUrl: accountUrl } })
  ok(await settled(() => cancelledQuestions.getSnapshot()?.question.id === 'dsh-auth-waiting'),
    'cancel fixture exposes the waiting panel')
  cancelledQuestions.cancelCurrent()
  const cancelledReason = await cancelledLogin
  ok(cancelledReason.includes('cancelled') && cancelledAccount.calls.cancels[0] === 'account-attempt-1'
    && cancelledQuestions.getSnapshot() === null,
  'Esc cancels the exact upstream attempt and retires the panel')

  const failedAccount = fakeDeepSeekAccount()
  const failedLogin = loginDeepSeekAccount(failedAccount, callbackOrigin, fakeAsk, undefined,
    { openUrl: () => false }).then(() => '', error => error.message)
  ok(await settled(() => failedAccount.calls.starts.length === 1), 'failure fixture started its Host attempt')
  failedAccount.update({ ...failedAccount.current(), attempt: { id: 'account-attempt-1', phase: 'failed', errorCode: 'network' } })
  ok((await failedLogin).includes('network') && failedAccount.calls.cancels.length === 0,
    'Host failure surfaces its safe code without cancelling a settled attempt')

  const facadeAccount = fakeDeepSeekAccount()
  const coupons = new WhaleCouponStore()
  const couponEvents = []
  const stopCoupons = coupons.subscribe(() => couponEvents.push(coupons.getSnapshot()))
  const granted = { orderId: 'coupon-order-1', campaign: 'dsh_login_bonus', amount: '5.00', currency: 'CNY', expiresAt: '2099-01-01T00:00:00Z' }
  const acknowledgements = []
  facadeAccount.getUnnotifiedBonuses = async () => ({ accountId: 'coupon-account-1', bonuses: [granted] })
  facadeAccount.ackBonusNotified = async (...args) => { acknowledgements.push(args); return true }
  facadeAccount.startSignIn = async (client, origin, source) => {
    facadeAccount.calls.starts.push({ client, origin, source })
    facadeAccount.update({ ...facadeAccount.current(), status: 'credential-stored',
      attempt: { id: 'account-attempt-1', phase: 'succeeded' } })
    return facadeAccount.current()
  }
  const accountApi = createDshAuthApi({
    profiles: new Map([['fake', fakeProfile]]), store: apiStore,
    resolveAsk: () => fakeAsk,
    resolveDeepSeekAccount: () => facadeAccount,
    resolveCallbackOrigin: () => callbackOrigin,
    coupons,
  })
  const accountRows = await accountApi.providers()
  ok(accountRows.length === 2 && accountRows[0].provider === DEEPSEEK_ACCOUNT_PROVIDER
    && accountRows[1].provider === 'fake'
    && accountRows[0].signedIn === false && accountRows[0].expiresAt === undefined,
  'the facade lists the Host account first without registering a second pi-ai route')
  const accountResult = await accountApi.login(DEEPSEEK_ACCOUNT_PROVIDER)
  ok(accountResult.expiresAt === undefined && facadeAccount.calls.starts[0].origin === callbackOrigin
    && facadeAccount.calls.starts[0].source === 'desktop'
    && (await accountApi.providers())[0].signedIn === true,
  'facade login delegates with the Desktop source and reports a non-expiring account grant')
  ok(await settled(() => coupons.getSnapshot()?.orderId === granted.orderId)
    && coupons.getSnapshot()?.amount === '5.00' && acknowledgements.length === 0,
  'a Platform-confirmed login bonus is offered without acknowledging an unseen card')
  coupons.shown(granted.orderId)
  coupons.shown(granted.orderId)
  ok(await settled(() => acknowledgements.length === 1)
    && acknowledgements[0][0] === 'coupon-account-1' && acknowledgements[0][1] === granted.orderId,
  'the displayed order is acknowledged once with its account identity')
  coupons.dismiss(granted.orderId)
  ok(await settled(() => coupons.getSnapshot() === null)
    && couponEvents.filter(event => event?.orderId === granted.orderId).length === 1,
  'dismissing the card does not re-offer the same unnotified order')
  ok(await accountApi.logout(DEEPSEEK_ACCOUNT_PROVIDER)
    && facadeAccount.calls.signOuts.length === 1
    && (await apiStore.read(DEEPSEEK_ACCOUNT_PROVIDER)) === undefined,
  'facade logout calls Host signOut and never stores the account grant in pi-ai credentials')
  stopCoupons()

  const pendingAccount = fakeDeepSeekAccount()
  pendingAccount.startSignIn = async (...args) => {
    pendingAccount.calls.starts.push(args)
    throw new Error('late sign-in after logout')
  }
  let releaseCallbackOrigin
  let callbackOriginRequested = false
  const pendingCallbackOrigin = new Promise(resolve => { releaseCallbackOrigin = resolve })
  const pendingAccountApi = createDshAuthApi({
    profiles: new Map(), store: apiStore,
    resolveAsk: () => fakeAsk,
    resolveDeepSeekAccount: () => pendingAccount,
    resolveCallbackOrigin: () => {
      callbackOriginRequested = true
      return pendingCallbackOrigin
    },
  })
  const pendingLogin = pendingAccountApi.login(DEEPSEEK_ACCOUNT_PROVIDER)
    .then(() => 'success', error => error instanceof Error ? error.message : String(error))
  ok(await settled(() => callbackOriginRequested), 'DeepSeek login awaits callback listener startup')
  await pendingAccountApi.logout(DEEPSEEK_ACCOUNT_PROVIDER)
  releaseCallbackOrigin(callbackOrigin)
  const pendingOutcome = await pendingLogin
  ok(pendingAccount.calls.signOuts.length === 1
    && pendingAccount.calls.starts.length === 0
    && pendingOutcome.includes('Login cancelled'),
  'logout completes before callback resolution and prevents a later Host sign-in attempt')

  const otherCoupons = new WhaleCouponStore()
  const stopOtherCoupons = otherCoupons.subscribe(() => undefined)
  await otherCoupons.refresh({
    getUnnotifiedBonuses: async () => ({ accountId: 'coupon-account-2', bonuses: [{ ...granted, campaign: 'unrelated' }] }),
    ackBonusNotified: async () => true,
  })
  ok(otherCoupons.getSnapshot() === null, 'unrelated bonus campaigns do not masquerade as login coupons')
  await otherCoupons.refresh({
    getUnnotifiedBonuses: async () => { throw new Error('offline') },
    ackBonusNotified: async () => true,
  })
  ok(otherCoupons.getSnapshot() === null, 'a failed bonus read does not fabricate a coupon')
  stopOtherCoupons()

  // ── public Cordis entry ──────────────────────────────────────────────────
  console.log('Cordis mount')
  const ctx = new Context()
  const registeredRoutes = []
  const registeredCommands = []
  const released = []
  ctx.provide('llm', {
    registerAdapter(ids, adapter) {
      registeredRoutes.push({ ids, adapter })
      return () => { released.push('llm') }
    },
  })
  ctx.provide('commands', {
    register(descriptor) {
      registeredCommands.push(descriptor)
      return () => { released.push('commands') }
    },
  })
  ctx.provide('deepseekAccount', facadeAccount)
  const sharedWebServer = { port: 43123 }
  ctx.provide('webServer', sharedWebServer)
  try {
    const fiber = await ctx.plugin(oauthModule, {
      providers: ['openai-codex'],
      credentialsFile: join(root, 'mount', 'credentials.json'),
    })
    ok(oauthModule.name === 'dsh-auth' && typeof oauthModule.apply === 'function',
      'the public ./oauth entry exposes the compatible Cordis plugin contract')
    ok(registeredRoutes.length === 1 && registeredRoutes[0].ids[0] === 'openai-codex',
      'the internal entry registers the configured llm route')
    ok(registeredCommands.length === 1 && registeredCommands[0].name === 'auth',
      'the internal entry registers /auth')
    const service = ctx.get('dshAuth')
    const mountedRows = await service?.api?.providers()
    ok(mountedRows?.[0]?.provider === DEEPSEEK_ACCOUNT_PROVIDER
      && mountedRows?.[1]?.provider === 'openai-codex',
    'the public entry exposes ctx.dshAuth with the Host account first')
    const status = await registeredCommands[0].handler({ rawInput: 'status', signal: new AbortController().signal })
    ok(status.kind === 'success' && status.text.split('\n')[1]?.includes('deepseek-account')
      && status.text.includes('not signed in') && !status.text.includes('access')
      && !status.text.includes('1970'),
    '/auth status returns masked account metadata without a fake token expiry')
    const headless = await registeredCommands[0].handler({ rawInput: 'login openai-codex', signal: new AbortController().signal })
    ok(headless.kind === 'error' && headless.text.includes('interactive surface'),
      '/auth login refuses clearly without an interactive question surface')
    ctx.provide('userQuestions', { ask: fakeAsk })
    const accountCommand = await registeredCommands[0].handler({ rawInput: 'login deepseek-account', signal: new AbortController().signal })
    ok(accountCommand.kind === 'success' && accountCommand.text.includes('DeepSeek')
      && !accountCommand.text.includes('token expires') && !accountCommand.text.includes('1970'),
    '/auth login deepseek-account uses the Host flow and omits token-expiry copy')
    ok(ctx.get('webServer') === sharedWebServer,
      'DeepSeek sign-in reuses an existing Web callback listener')
    await fiber.dispose()
    ok(released.length === 2 && released.includes('llm') && released.includes('commands'),
      'Cordis teardown unregisters both the route and /auth')
    const previousRoutes = registeredRoutes.length
    const defaultFiber = await ctx.plugin(oauthModule, {
      credentialsFile: join(root, 'mount-default', 'credentials.json'),
    })
    ok(JSON.stringify(registeredRoutes.slice(previousRoutes).map(route => route.ids[0])) === JSON.stringify(available),
      'omitted providers config mounts exactly the installed pi-ai OAuth flows')
    await defaultFiber.dispose()
  } finally {
    await ctx.fiber.dispose()
  }

  // The v0.11.2 global patch still mounts ./oauth but lacks its new
  // dsh-tui-webserver row. After /update, this new module must provide the
  // missing Host listener without relying on the stale patch being replaced.
  console.log('legacy global patch fallback')
  const legacyCtx = new Context()
  const legacyAccount = fakeDeepSeekAccount()
  legacyCtx.provide('loader', {
    entries: () => [{ options: { id: 'dsh-tui-auth', name: '@deepseek-harness-tui/dsh-tui/oauth' } }],
  })
  legacyCtx.provide('llm', { registerAdapter: () => () => {} })
  legacyCtx.provide('commands', { register: () => () => {} })
  legacyCtx.provide('deepseekAccount', legacyAccount)
  legacyCtx.provide('userQuestions', { ask: fakeAsk })
  try {
    const fiber = await legacyCtx.plugin(oauthModule, {
      providers: ['openai-codex'],
      credentialsFile: join(root, 'legacy-global-patch', 'credentials.json'),
    })
    const api = legacyCtx.get('dshAuth')?.api
    ok(legacyCtx.get('webServer') === undefined,
      'a stale patch does not open a callback listener before DeepSeek sign-in')
    const aborted = new AbortController()
    aborted.abort()
    let cancelledBeforeStart = false
    try { await api.login(DEEPSEEK_ACCOUNT_PROVIDER, aborted.signal) } catch { cancelledBeforeStart = true }
    ok(cancelledBeforeStart && legacyCtx.get('webServer') === undefined
      && legacyAccount.calls.starts.length === 0,
    'an already-cancelled login opens no fallback listener')
    const login = api.login(DEEPSEEK_ACCOUNT_PROVIDER)
    ok(await settled(() => legacyAccount.calls.starts.length === 1),
      'DeepSeek login starts through the built-in OAuth module without a webserver patch row')
    const fallback = legacyCtx.get('webServer')
    ok(fallback?.host === '127.0.0.1' && Number.isInteger(fallback.port) && fallback.port > 0
      && legacyAccount.calls.starts[0].origin === `http://127.0.0.1:${fallback.port}`,
    'the fallback mounts the official Host webServer on an assigned loopback port')
    let accountContext
    const accountFiber = await legacyCtx.plugin({
      name: 'account-callback-fixture',
      apply(ctx) { accountContext = ctx },
    })
    try {
      const releaseRoute = accountContext.get('webServer').register({
        kind: 'exact', path: '/oauth/callback',
        handler: (_request, response) => { response.writeHead(204); response.end() },
      })
      try {
        const response = await fetch(`http://127.0.0.1:${fallback.port}/oauth/callback`, {
          signal: AbortSignal.timeout(2000),
        })
        ok(response.status === 204,
          'the Host account context can serve its browser callback through the fallback listener')
      } finally {
        releaseRoute()
      }
    } finally {
      await accountFiber.dispose()
    }
    legacyAccount.update({ ...legacyAccount.current(), status: 'credential-stored',
      attempt: { id: 'account-attempt-1', phase: 'succeeded' } })
    await login

    const secondLogin = api.login(DEEPSEEK_ACCOUNT_PROVIDER)
    ok(await settled(() => legacyAccount.calls.starts.length === 2), 'a repeated account login starts')
    ok(legacyCtx.get('webServer')?.port === fallback.port
      && legacyAccount.calls.starts[1].origin === `http://127.0.0.1:${fallback.port}`,
      'repeated account login reuses the one fallback listener')
    legacyAccount.update({ ...legacyAccount.current(), status: 'credential-stored',
      attempt: { id: 'account-attempt-1', phase: 'succeeded' } })
    await secondLogin
    await fiber.dispose()
    ok(legacyCtx.get('webServer') === undefined,
      'disposing built-in OAuth closes its fallback listener')
  } finally {
    await legacyCtx.fiber.dispose()
  }

  const oldHostCtx = new Context()
  oldHostCtx.provide('llm', { registerAdapter: () => () => {} })
  oldHostCtx.provide('commands', { register: () => () => {} })
  try {
    const fiber = await oldHostCtx.plugin(oauthModule, {
      providers: ['openai-codex'],
      credentialsFile: join(root, 'old-host', 'credentials.json'),
    })
    const rows = await oldHostCtx.get('dshAuth')?.api?.providers()
    ok(!rows?.some(row => row.provider === DEEPSEEK_ACCOUNT_PROVIDER)
      && oldHostCtx.get('webServer') === undefined,
    'an older Host without deepseekAccount opens no fallback callback listener')
    await fiber.dispose()
  } finally {
    await oldHostCtx.fiber.dispose()
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
