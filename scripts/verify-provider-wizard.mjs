/**
 * Headless regression for the `/provider` wizard (src/dsh-adapter/providerWizard.ts).
 * Drives runProviderWizard with a stubbed ProviderSetupHost and a scripted
 * `ask` (answers keyed by question id, the way AskUserQuestionPanel would
 * submit them), asserting per scenario:
 *
 * 1. catalog path: profile shape (apiKeyEnv only + narrowed models, never
 *    an `api` field), credential written under the derived ref, switch
 *    question answered "keep" → no switchModel call.
 * 2. catalog path with NO models picked: profile omits `models` (whole
 *    catalog stays served) and the switch question is skipped.
 * 3. custom path with failed discovery: falls back to the manual model-id
 *    question; profile carries api + baseURL + plain id models.
 * 4. custom path with discovery: adopted capacities land on the models.
 * 5. writeProfile failure with no prior credential unsets the new one.
 * 6. env shadow: credential write skipped, profile still references the ref.
 * 7. user cancel (Esc) mid-wizard: zero side effects, outcome 'cancelled'.
 * 8. invalid route id is rejected and re-asked before proceeding.
 * 9. deriveKeyRef matches the web UI's convention.
 * 10. overwrite rollback RESTORES the previous credential value instead of
 *    deleting it (regression: unconditional unset destroyed the old key).
 * 11. providerSetup availability must not call APIs absent from dsh-llm rc.6
 *    (regression: listModelDiscoveryNamespaces() is undefined there and the
 *    guard threw before the wizard could open).
 * 13. OAuth branch: mode gains a third option, picking an unsigned provider
 *    runs login, pushes a masked summary, reports success.
 * 14. OAuth branch, signed-in provider choosing sign-out: logout runs, no
 *    login attempt, outcome 'signed-out'.
 * 15. OAuth branch, login failure: error surfaced with the cause.
 * 16. without host.oauth the mode question stays two options (optional-plugin
 *    contract).
 *
 * Run with plain node against the compiled lib (after `pnpm build`):
 * `node scripts/verify-provider-wizard.mjs`
 */
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import {
  deriveKeyRef,
  runProviderWizard,
} from '../lib/types/dsh-adapter/providerWizard.js'
import { t } from '../lib/types/i18n.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const CANCEL = new UserQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED')

/**
 * Build the wizard deps. `script` maps question id → answer spec:
 *   { selected: [...] }        option answer
 *   { custom: '...' }          free-text answer
 *   'cancel'                   throw the panel's cancel error
 * Discovery is stubbed via `options.discovered` (array) or
 * `options.discoverThrows`; env shadow via `options.shadow`.
 */
function makeDeps(script, options = {}) {
  const calls = {
    credentials: [],
    removed: [],
    profiles: [],
    notifications: [],
    pushed: [],
    switches: [],
    asks: [],
    /** question id → hideCustomInput flag as submitted (panel contract). */
    hideFlags: {},
    /** question id → option descriptions, for catalog row-shape regressions. */
    optionDescriptions: {},
  }
  const host = {
    listCatalogProviders: () => [
      { provider: 'deepseek', displayName: 'DeepSeek' },
      { provider: 'openai', displayName: 'OpenAI' },
      { provider: 'same-name', displayName: 'same-name' },
    ],
    routeExists: () => false,
    discoverModels: async () => {
      if (options.discoverThrows) throw new Error('connection refused')
      return options.discovered ?? []
    },
    envShadows: ref => options.shadow === ref,
    readCredential: async ref => options.storedCredentials?.[ref],
    writeCredential: (ref, value) => {
      if (options.credentialThrows) throw new Error('credential rejected')
      calls.credentials.push([ref, value])
    },
    removeCredential: ref => { calls.removed.push(ref) },
    writeProfile: async (route, profile) => {
      if (options.profileThrows) throw new Error('settings-rejected: unserviceable')
      calls.profiles.push([route, profile])
    },
    ...(options.oauth ? { oauth: options.oauth } : {}),
  }
  const deps = {
    host,
    ask: async request => {
      const answers = []
      for (const question of request.questions) {
        calls.asks.push(question.id)
        calls.hideFlags[question.id] = question.hideCustomInput === true
        calls.optionDescriptions[question.id] = Object.fromEntries(
          (question.options ?? []).map(option => [option.label, option.description]),
        )
        const spec = script[question.id]
        if (spec === undefined) throw new Error(`unscripted question: ${question.id}`)
        if (spec === 'cancel') throw CANCEL
        answers.push({
          id: question.id,
          selected: spec.selected ?? [],
          ...(spec.custom !== undefined ? { custom: spec.custom } : {}),
        })
      }
      return { answers }
    },
    notify: (text, opts) => { calls.notifications.push({ text, color: opts?.color }) },
    pushLocal: (title, lines) => { calls.pushed.push({ title, lines }) },
    working: () => options.working ?? false,
    switchModel: async (provider, model) => {
      calls.switches.push([provider, model])
      return true
    },
  }
  return { deps, calls }
}

const MODE_CATALOG = { selected: [t('provider-opt-catalog')] }
const MODE_CUSTOM = { selected: [t('provider-opt-custom')] }
const SKIP_BASEURL = { selected: [t('provider-opt-baseurl-skip')] }
const CONFIRM_WRITE = { selected: [t('provider-opt-confirm-write')] }
const KEEP_MODEL = { selected: [t('provider-opt-switch-keep')] }

// 1. catalog happy path: discovery + narrowed models + switch declined.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CATALOG,
    'catalog': { selected: ['deepseek'] },
    'apikey': { custom: 'sk-test-key' },
    'baseurl-choice': SKIP_BASEURL,
    'models': { selected: ['deepseek-chat'], custom: 'deepseek-extra' },
    'confirm': CONFIRM_WRITE,
    'switch': KEEP_MODEL,
  }, {
    discovered: [
      { id: 'deepseek-chat', contextWindow: 128000 },
      { id: 'deepseek-reasoner', contextWindow: 128000 },
    ],
  })
  const outcome = await runProviderWizard(deps)
  check('1 catalog: outcome added', outcome === 'added', outcome)
  check('1 catalog: credential under derived ref',
    eq(calls.credentials, [['DEEPSEEK_API_KEY', 'sk-test-key']]),
    JSON.stringify(calls.credentials))
  check('1 catalog: profile shape (no api/baseURL, id-only models)',
    eq(calls.profiles, [['deepseek', {
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      models: [{ id: 'deepseek-chat' }, { id: 'deepseek-extra' }],
    }]]),
    JSON.stringify(calls.profiles))
  check('1 catalog: keep → no switch', eq(calls.switches, []))
  check('1 catalog: transcript summary pushed without the key',
    calls.pushed.length === 1
      && calls.pushed[0].lines.every(line => !line.includes('sk-test-key')))
}

// 2. catalog, no models picked: models omitted, switch question skipped.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CATALOG,
    'catalog': { selected: ['openai'] },
    'apikey': { custom: 'sk-openai' },
    'baseurl-choice': SKIP_BASEURL,
    'models': { selected: [] },
    'confirm': CONFIRM_WRITE,
  }, {
    discovered: [{ id: 'gpt-5' }],
  })
  const outcome = await runProviderWizard(deps)
  check('2 catalog bare: outcome added', outcome === 'added', outcome)
  check('2 catalog bare: profile omits models',
    eq(calls.profiles, [['openai', { apiKeyEnv: 'OPENAI_API_KEY' }]]),
    JSON.stringify(calls.profiles))
  check('2 catalog bare: switch never asked', !calls.asks.includes('switch'))
}

// 3. custom path, discovery fails: manual model fallback question.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CUSTOM,
    'route-id': { custom: 'acme-gateway' },
    'apikey': { custom: 'acme-key' },
    'baseurl': { custom: 'https://gw.example/v1' },
    'protocol': { selected: ['openai-completions'] },
    'models-fallback': { custom: 'acme-large, acme-think' },
    'confirm': CONFIRM_WRITE,
    'switch': { selected: [t('provider-opt-switch-now', { model: 'acme-large' })] },
  }, { discoverThrows: true })
  const outcome = await runProviderWizard(deps)
  check('3 custom fallback: outcome added', outcome === 'added', outcome)
  check('3 custom fallback: profile carries api + baseURL + id models',
    eq(calls.profiles, [['acme-gateway', {
      apiKeyEnv: 'ACME_GATEWAY_API_KEY',
      baseURL: 'https://gw.example/v1',
      api: 'openai-completions',
      models: [{ id: 'acme-large' }, { id: 'acme-think' }],
    }]]),
    JSON.stringify(calls.profiles))
  check('3 custom fallback: discovery-failure warning notified',
    calls.notifications.some(n => n.color === 'warning'))
  check('3 custom fallback: accepted switch to first model',
    eq(calls.switches, [['acme-gateway', 'acme-large']]),
    JSON.stringify(calls.switches))
}

// 4. custom path, discovery supplies capacities.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CUSTOM,
    'route-id': { custom: 'local-llm' },
    'apikey': { custom: 'no-key-needed-but-required' },
    'baseurl': { custom: 'http://127.0.0.1:11434/v1' },
    'protocol': { selected: ['openai-completions'] },
    'models': { selected: ['qwen3-32b'] },
    'confirm': CONFIRM_WRITE,
    'switch': KEEP_MODEL,
  }, {
    discovered: [{ id: 'qwen3-32b', contextWindow: 131072, maxTokens: 8192 }],
  })
  const outcome = await runProviderWizard(deps)
  check('4 custom discovered: outcome added', outcome === 'added', outcome)
  check('4 custom discovered: capacities adopted',
    eq(calls.profiles[0]?.[1]?.models, [{ id: 'qwen3-32b', contextWindow: 131072, maxTokens: 8192 }]),
    JSON.stringify(calls.profiles[0]?.[1]?.models))
}

// 5. writeProfile failure with no prior credential unsets the new one.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CATALOG,
    'catalog': { selected: ['deepseek'] },
    'apikey': { custom: 'sk-rollback' },
    'baseurl-choice': SKIP_BASEURL,
    'models': { selected: ['deepseek-chat'] },
    'confirm': CONFIRM_WRITE,
  }, {
    discovered: [{ id: 'deepseek-chat' }],
    profileThrows: true,
  })
  const outcome = await runProviderWizard(deps)
  check('5 rollback: outcome failed', outcome === 'failed', outcome)
  check('5 rollback: credential unset after profile failure',
    eq(calls.removed, ['DEEPSEEK_API_KEY']), JSON.stringify(calls.removed))
  check('5 rollback: error notified',
    calls.notifications.some(n => n.color === 'error'))
}

// 10. overwrite rollback restores the previous credential, never unsets it.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CATALOG,
    'catalog': { selected: ['deepseek'] },
    'apikey': { custom: 'sk-new' },
    'baseurl-choice': SKIP_BASEURL,
    'models': { selected: ['deepseek-chat'] },
    'confirm': CONFIRM_WRITE,
  }, {
    discovered: [{ id: 'deepseek-chat' }],
    profileThrows: true,
    storedCredentials: { DEEPSEEK_API_KEY: 'sk-old' },
  })
  const outcome = await runProviderWizard(deps)
  check('10 overwrite rollback: outcome failed', outcome === 'failed', outcome)
  check('10 overwrite rollback: old key restored, never unset',
    eq(calls.removed, [])
      && eq(calls.credentials, [
        ['DEEPSEEK_API_KEY', 'sk-new'],
        ['DEEPSEEK_API_KEY', 'sk-old'],
      ]),
    JSON.stringify({ removed: calls.removed, credentials: calls.credentials }))
}

// 11. the compiled channel must not reference APIs absent from dsh-llm rc.6.
{
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(
    new URL('../lib/types/dsh-adapter/channel.js', import.meta.url), 'utf8')
  check('11 channel: no listModelDiscoveryNamespaces call (absent in rc.6)',
    !source.includes('.listModelDiscoveryNamespaces('))
  check('11 channel: availability guard uses the settings descriptor',
    source.includes("descriptor.ns === 'llm-pi-ai'"))
}

// 6. env shadow: credential write skipped, profile still references the ref.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CATALOG,
    'catalog': { selected: ['deepseek'] },
    'apikey': { custom: 'sk-shadowed' },
    'baseurl-choice': SKIP_BASEURL,
    'models': { selected: ['deepseek-chat'] },
    'confirm': CONFIRM_WRITE,
    'switch': KEEP_MODEL,
  }, {
    discovered: [{ id: 'deepseek-chat' }],
    shadow: 'DEEPSEEK_API_KEY',
  })
  const outcome = await runProviderWizard(deps)
  check('6 shadow: outcome added', outcome === 'added', outcome)
  check('6 shadow: credential write skipped', eq(calls.credentials, []))
  check('6 shadow: profile still references the ref',
    calls.profiles[0]?.[1]?.apiKeyEnv === 'DEEPSEEK_API_KEY')
}

// 7. cancel mid-wizard: zero side effects.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CATALOG,
    'catalog': 'cancel',
  })
  const outcome = await runProviderWizard(deps)
  check('7 cancel: outcome cancelled', outcome === 'cancelled', outcome)
  check('7 cancel: nothing written',
    eq(calls.credentials, []) && eq(calls.profiles, []) && eq(calls.removed, []))
}

// 8. invalid route id is rejected, then re-asked (scripted via ask wrapper).
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CUSTOM,
    'route-id': { custom: 'BAD ROUTE' },
    'apikey': { custom: 'k' },
    'baseurl': { custom: 'https://gw.example/v1' },
    'protocol': { selected: ['openai-completions'] },
    'models-fallback': { custom: 'm1' },
    'confirm': CONFIRM_WRITE,
    'switch': KEEP_MODEL,
  }, { discoverThrows: true })
  let routeIdAsks = 0
  const innerAsk = deps.ask
  deps.ask = async request => {
    if (request.questions.some(q => q.id === 'route-id')) {
      routeIdAsks += 1
      if (routeIdAsks === 2) {
        return { answers: [{ id: 'route-id', selected: [], custom: 'good-route' }] }
      }
    }
    return innerAsk(request)
  }
  const outcome = await runProviderWizard(deps)
  check('8 invalid route: re-asked then proceeded',
    routeIdAsks === 2 && outcome === 'added', `asks=${routeIdAsks} outcome=${outcome}`)
  check('8 invalid route: warning notified',
    calls.notifications.some(n => n.color === 'warning'))
  check('8 invalid route: written under the corrected route',
    calls.profiles[0]?.[0] === 'good-route', JSON.stringify(calls.profiles[0]?.[0]))
}

// 9. deriveKeyRef matches the web UI convention.
{
  check('9 deriveKeyRef', deriveKeyRef('acme-gateway') === 'ACME_GATEWAY_API_KEY'
    && deriveKeyRef('openai') === 'OPENAI_API_KEY')
}

// 12. hideCustomInput contract: pure option questions carry the flag, text
// questions and the models multi-select keep the input row.
{
  const catalog = makeDeps({
    'mode': MODE_CATALOG,
    'catalog': { selected: ['deepseek'] },
    'apikey': { custom: 'sk-flags' },
    'baseurl-choice': SKIP_BASEURL,
    'models': { selected: ['deepseek-chat'] },
    'confirm': CONFIRM_WRITE,
    'switch': KEEP_MODEL,
  }, { discovered: [{ id: 'deepseek-chat' }] })
  await runProviderWizard(catalog.deps)
  check('12 hide flags (catalog path)',
    eq(catalog.calls.hideFlags, {
      'mode': true,
      'catalog': true,
      'apikey': false,
      'baseurl-choice': true,
      'models': false,
      'confirm': true,
      'switch': true,
    }),
    JSON.stringify(catalog.calls.hideFlags))
  check('12 catalog omits a duplicate display name',
    catalog.calls.optionDescriptions.catalog?.['same-name'] === undefined,
    JSON.stringify(catalog.calls.optionDescriptions.catalog))

  const custom = makeDeps({
    'mode': MODE_CUSTOM,
    'route-id': { custom: 'flag-route' },
    'apikey': { custom: 'k' },
    'baseurl': { custom: 'https://gw.example/v1' },
    'protocol': { selected: ['openai-completions'] },
    'models-fallback': { custom: 'm1' },
    'confirm': CONFIRM_WRITE,
    'switch': KEEP_MODEL,
  }, { discoverThrows: true })
  await runProviderWizard(custom.deps)
  check('12 hide flags (custom path)',
    eq(custom.calls.hideFlags, {
      'mode': true,
      'route-id': false,
      'apikey': false,
      'baseurl': false,
      'protocol': true,
      'models-fallback': false,
      'confirm': true,
      'switch': true,
    }),
    JSON.stringify(custom.calls.hideFlags))
}

/**
 * Build a dsh-auth-style OAuth host stub. `behavior.providers` overrides the
 * status list; `behavior.loginThrows` makes login reject with that message.
 */
function oauthStub(behavior = {}) {
  const calls = { listed: 0, logins: [], logouts: [] }
  return {
    calls,
    providers: async () => {
      calls.listed += 1
      return behavior.providers ?? [
        { provider: 'openai-codex', label: 'OpenAI Codex', oauthLabel: 'OpenAI (ChatGPT Plus/Pro)', loginLabel: 'Sign in with ChatGPT', signedIn: false, expiresAt: undefined, expired: false },
        { provider: 'anthropic', label: 'Anthropic', oauthLabel: 'Anthropic (Claude Pro/Max)', loginLabel: undefined, signedIn: true, expiresAt: 1_787_000_000_000, expired: false },
      ]
    },
    login: async provider => {
      calls.logins.push(provider)
      if (behavior.loginThrows) throw new Error(behavior.loginThrows)
      return { provider, oauthLabel: 'OpenAI (ChatGPT Plus/Pro)', expiresAt: 1_787_000_000_000 }
    },
    logout: async provider => {
      calls.logouts.push(provider)
      return true
    },
  }
}

// 13. OAuth branch: mode offers three options, picking an unsigned provider
// runs login, pushes a masked summary, and reports success.
{
  const oauth = oauthStub()
  const { deps, calls } = makeDeps({
    'mode': { selected: [t('provider-opt-oauth')] },
    'oauth-provider': { selected: ['openai-codex'] },
  }, { oauth })
  const outcome = await runProviderWizard(deps)
  check('13 oauth: outcome added', outcome === 'added', outcome)
  check('13 oauth: mode offered the OAuth option',
    Object.keys(calls.optionDescriptions.mode ?? {}).length === 3,
    JSON.stringify(Object.keys(calls.optionDescriptions.mode ?? {})))
  check('13 oauth: login ran for the chosen provider',
    eq(oauth.calls.logins, ['openai-codex']), JSON.stringify(oauth.calls.logins))
  check('13 oauth: masked summary pushed with the /model hint',
    calls.pushed.length === 1 && calls.pushed[0].lines.length === 4
      && calls.pushed[0].lines.some(line => line.includes('/model') || line.includes('模型')),
    JSON.stringify(calls.pushed))
  check('13 oauth: success notified',
    calls.notifications.some(n => n.color === 'success'))
}

// 14. OAuth branch, signed-in provider choosing sign-out: logout runs, no
// login attempt, outcome 'signed-out'.
{
  const oauth = oauthStub()
  const { deps, calls } = makeDeps({
    'mode': { selected: [t('provider-opt-oauth')] },
    'oauth-provider': { selected: ['anthropic'] },
    'oauth-signed-action': { selected: [t('provider-opt-oauth-logout')] },
  }, { oauth })
  const outcome = await runProviderWizard(deps)
  check('14 oauth sign-out: outcome signed-out', outcome === 'signed-out', outcome)
  check('14 oauth sign-out: logout ran, no login',
    eq(oauth.calls.logouts, ['anthropic']) && eq(oauth.calls.logins, []))
  check('14 oauth sign-out: summary notes the removed credential',
    calls.pushed.length === 1 && calls.pushed[0].lines.length === 2)
}

// 15. OAuth branch, login failure: error surfaced, outcome 'failed', nothing
// pushed.
{
  const oauth = oauthStub({ loginThrows: 'invalid_grant' })
  const { deps, calls } = makeDeps({
    'mode': { selected: [t('provider-opt-oauth')] },
    'oauth-provider': { selected: ['openai-codex'] },
  }, { oauth })
  const outcome = await runProviderWizard(deps)
  check('15 oauth failure: outcome failed', outcome === 'failed', outcome)
  check('15 oauth failure: error notified with the cause',
    calls.notifications.some(n => n.color === 'error' && n.text.includes('invalid_grant')),
    JSON.stringify(calls.notifications))
  check('15 oauth failure: nothing pushed', calls.pushed.length === 0)
}

// 16. without host.oauth the mode question stays exactly two options and the
// OAuth branch is unreachable (regression for the optional-plugin contract).
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CATALOG,
    'catalog': 'cancel',
  })
  const outcome = await runProviderWizard(deps)
  check('16 no oauth service: mode stayed two options',
    Object.keys(calls.optionDescriptions.mode ?? {}).length === 2,
    JSON.stringify(Object.keys(calls.optionDescriptions.mode ?? {})))
  check('16 no oauth service: catalog cancel still cancels', outcome === 'cancelled', outcome)
}

console.log(failed === 0 ? '\nAll provider-wizard checks passed' : `\n${failed} check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)
