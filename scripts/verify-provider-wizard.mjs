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
 *    contract); the new action layer always offers add/edit/delete.
 * 17. edit a catalog route keeping the key: route/mode locked, no credential
 *    write, profile overwritten, summary notes the unchanged key.
 * 18. edit a custom route replacing the key: credential overwritten, confirm
 *    framed as an edit.
 * 19. edit a route whose key is env-shadowed: no key-action question.
 * 20. edit with no configured providers: warning, cancelled.
 * 21. delete happy path: profile then credential removed, both in transcript.
 * 22. delete with env-shadowed key: credential left alone, env line pushed.
 * 23. delete cancelled at the confirm: nothing removed.
 * 24. delete with no configured providers: warning, cancelled.
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
    removedProfiles: [],
    profiles: [],
    notifications: [],
    pushed: [],
    switches: [],
    asks: [],
    /** question id → hideCustomInput flag as submitted (panel contract). */
    hideFlags: {},
    /** question id → option descriptions, for catalog row-shape regressions. */
    optionDescriptions: {},
    /** question id → detail string, for confirm-summary regressions. */
    details: {},
  }
  const host = {
    listCatalogProviders: () => [
      { provider: 'deepseek', displayName: 'DeepSeek' },
      { provider: 'openai', displayName: 'OpenAI' },
      { provider: 'same-name', displayName: 'same-name' },
    ],
    listConfiguredProviders: () => options.configured ?? [],
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
    removeProfile: route => { calls.removedProfiles.push(route) },
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
        calls.details[question.id] = question.detail
        const spec = question.id === 'action' && script['action'] === undefined
          ? ACTION_ADD
          : script[question.id]
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
const ACTION_ADD = { selected: [t('provider-opt-action-add')] }
const ACTION_EDIT = { selected: [t('provider-opt-action-edit')] }
const ACTION_DELETE = { selected: [t('provider-opt-action-delete')] }

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
      'action': true,
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
      'action': true,
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
  check('16 no oauth service: action offered all three choices',
    Object.keys(calls.optionDescriptions.action ?? {}).length === 3,
    JSON.stringify(Object.keys(calls.optionDescriptions.action ?? {})))
  check('16 no oauth service: mode stayed two options',
    Object.keys(calls.optionDescriptions.mode ?? {}).length === 2,
    JSON.stringify(Object.keys(calls.optionDescriptions.mode ?? {})))
  check('16 no oauth service: catalog cancel still cancels', outcome === 'cancelled', outcome)
}

// 17. edit a catalog route, keeping the key: route/mode locked, no credential
// write, profile overwritten, summary notes the unchanged key, outcome updated.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'key-action': { selected: [t('provider-opt-key-keep')] },
    'baseurl-choice': SKIP_BASEURL,
    'models': { selected: ['deepseek-reasoner'] },
    'confirm': CONFIRM_WRITE,
    'switch': KEEP_MODEL,
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: false, models: ['deepseek-chat'] }],
    discovered: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
  })
  const outcome = await runProviderWizard(deps)
  check('17 edit keep: outcome updated', outcome === 'updated', outcome)
  check('17 edit keep: no credential write', eq(calls.credentials, []))
  check('17 edit keep: profile overwritten',
    eq(calls.profiles, [['deepseek', { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-reasoner' }] }]]),
    JSON.stringify(calls.profiles))
  check('17 edit keep: mode/route questions never asked',
    !calls.asks.includes('mode') && !calls.asks.includes('catalog') && !calls.asks.includes('route-id'))
  check('17 edit keep: summary notes the kept key',
    calls.pushed[0]?.lines.includes(t('provider-line-key-kept', { ref: 'DEEPSEEK_API_KEY' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 18. edit a custom route, replacing the key: credential overwritten (with
// rollback capture), edit framing on the confirm, outcome updated.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'key-action': { selected: [t('provider-opt-key-replace')] },
    'apikey': { custom: 'sk-new' },
    'baseurl': { custom: 'https://gw.example/v2' },
    'protocol': { selected: ['openai-completions'] },
    'models': { selected: ['acme-large'] },
    'confirm': CONFIRM_WRITE,
    'switch': KEEP_MODEL,
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
    discovered: [{ id: 'acme-large' }],
    storedCredentials: { ACME_GATEWAY_API_KEY: 'sk-old' },
  })
  const outcome = await runProviderWizard(deps)
  check('18 edit replace: outcome updated', outcome === 'updated', outcome)
  check('18 edit replace: credential overwritten',
    eq(calls.credentials, [['ACME_GATEWAY_API_KEY', 'sk-new']]),
    JSON.stringify(calls.credentials))
  check('18 edit replace: custom profile rewritten with new values',
    eq(calls.profiles, [['acme-gateway', {
      apiKeyEnv: 'ACME_GATEWAY_API_KEY',
      baseURL: 'https://gw.example/v2',
      api: 'openai-completions',
      models: [{ id: 'acme-large' }],
    }]]),
    JSON.stringify(calls.profiles))
  check('18 edit replace: confirm detail framed as an edit',
    calls.details.confirm?.includes(t('provider-edit-note', { route: 'acme-gateway' })) === true,
    JSON.stringify(calls.details.confirm))
}

// 19. edit a route whose key is env-shadowed: no key-action question, no
// credential write, summary shows the env line.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'baseurl-choice': SKIP_BASEURL,
    'models': { selected: ['deepseek-chat'] },
    'confirm': CONFIRM_WRITE,
    'switch': KEEP_MODEL,
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: true, models: ['deepseek-chat'] }],
    discovered: [{ id: 'deepseek-chat' }],
    shadow: 'DEEPSEEK_API_KEY',
  })
  const outcome = await runProviderWizard(deps)
  check('19 edit shadow: outcome updated', outcome === 'updated', outcome)
  check('19 edit shadow: key-action never asked', !calls.asks.includes('key-action'))
  check('19 edit shadow: no credential write', eq(calls.credentials, []))
  check('19 edit shadow: summary shows the env keyref line',
    calls.pushed[0]?.lines.includes(t('provider-line-keyref-env', { ref: 'DEEPSEEK_API_KEY' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 20. edit with no configured providers: warning, nothing asked, cancelled.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
  }, { configured: [] })
  const outcome = await runProviderWizard(deps)
  check('20 edit none: outcome cancelled', outcome === 'cancelled', outcome)
  check('20 edit none: warning notified',
    calls.notifications.some(n => n.color === 'warning' && n.text === t('provider-none-configured')),
    JSON.stringify(calls.notifications))
}

// 21. delete a catalog route: profile removed, then the credential removed,
// transcript notes both, outcome deleted.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_DELETE,
    'delete-provider': { selected: ['deepseek'] },
    'delete-confirm': { selected: [t('provider-opt-delete-yes')] },
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: false, models: ['deepseek-chat'] }],
  })
  const outcome = await runProviderWizard(deps)
  check('21 delete: outcome deleted', outcome === 'deleted', outcome)
  check('21 delete: profile removed', eq(calls.removedProfiles, ['deepseek']), JSON.stringify(calls.removedProfiles))
  check('21 delete: credential removed', eq(calls.removed, ['DEEPSEEK_API_KEY']), JSON.stringify(calls.removed))
  check('21 delete: nothing written', eq(calls.profiles, []) && eq(calls.credentials, []))
  check('21 delete: success notified', calls.notifications.some(n => n.color === 'success'))
  check('21 delete: transcript notes the removed key',
    calls.pushed[0]?.lines.includes(t('provider-line-deleted-key', { ref: 'DEEPSEEK_API_KEY' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 22. delete a route whose key is env-shadowed: profile removed, credential
// left alone, transcript says the key came from the environment.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_DELETE,
    'delete-provider': { selected: ['deepseek'] },
    'delete-confirm': { selected: [t('provider-opt-delete-yes')] },
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: true, models: ['deepseek-chat'] }],
  })
  const outcome = await runProviderWizard(deps)
  check('22 delete shadow: outcome deleted', outcome === 'deleted', outcome)
  check('22 delete shadow: profile removed', eq(calls.removedProfiles, ['deepseek']), JSON.stringify(calls.removedProfiles))
  check('22 delete shadow: credential NOT removed', eq(calls.removed, []), JSON.stringify(calls.removed))
  check('22 delete shadow: transcript notes the env keyref',
    calls.pushed[0]?.lines.includes(t('provider-line-deleted-key-shadowed', { ref: 'DEEPSEEK_API_KEY' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 23. delete cancelled at the confirm: nothing removed.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_DELETE,
    'delete-provider': { selected: ['deepseek'] },
    'delete-confirm': { selected: [t('provider-opt-confirm-cancel')] },
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: false, models: ['deepseek-chat'] }],
  })
  const outcome = await runProviderWizard(deps)
  check('23 delete cancel: outcome cancelled', outcome === 'cancelled', outcome)
  check('23 delete cancel: nothing removed',
    eq(calls.removedProfiles, []) && eq(calls.removed, []))
}

// 24. delete with no configured providers: warning, outcome cancelled.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_DELETE,
  }, { configured: [] })
  const outcome = await runProviderWizard(deps)
  check('24 delete none: outcome cancelled', outcome === 'cancelled', outcome)
  check('24 delete none: warning notified',
    calls.notifications.some(n => n.color === 'warning' && n.text === t('provider-none-configured')),
    JSON.stringify(calls.notifications))
}

console.log(failed === 0 ? '\nAll provider-wizard checks passed' : `\n${failed} check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)
