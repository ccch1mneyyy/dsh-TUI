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
 *    contract); the action layer offers add/edit — delete is gone from the
 *    top level (it now lives inside the edit menu).
 * 17. edit a catalog route: the menu offers only key/models/delete; editing
 *    the model list pre-checks the enabled models (defaultSelected) and
 *    PATCHES just `models` (no whole-profile rewrite), outcome updated.
 * 18. edit a custom route, API key only: credential overwritten, profile
 *    untouched, transcript notes the updated key.
 * 19. edit a custom route, base URL: a single-field path patch sets
 *    `baseURL` and nothing else — no profile rewrite, no discovery.
 * 20. edit a custom route, wire protocol: the current protocol is
 *    default-focused (defaultSelected); a single-field path patch sets `api`.
 * 21. edit a shadowed-key route: "Edit API Key" refuses (env) → cancelled,
 *    nothing written.
 * 22. edit with no configured providers: warning, cancelled.
 * 23. delete via the edit menu (stored key): profile then credential removed,
 *    both in transcript.
 * 24. delete via the edit menu with an env-shadowed key: credential left
 *    alone, env line pushed.
 * 25. delete cancelled at the confirm: nothing removed.
 * 26. a no-op base URL edit (empty input): nothing written, 'cancelled'.
 * 27. custom-route model-list edit that ends up empty: rejected with the
 *    required-models error, nothing written.
 * 28. menu shape: built-in routes offer key/models/delete only; custom routes
 *    also offer base URL and wire protocol.
 * 29. a catalog route that carries an explicit `api` override is still
 *    catalog (isCatalog), so its menu stays built-in-shaped (#3).
 * 30. delete where the profile unsets but the credential removal throws:
 *    outcome is still 'deleted', completion invalidated, a warning surfaces,
 *    transcript says the key cleanup failed (#2).
 * 31. delete of a route whose key ref is shared with another configured
 *    route: the credential is kept, the shared-key line is pushed (#5).
 * 32. a targeted edit of a stored profile that carries unknown fields:
 *    mutateProfile receives only the changed path — the untouched fields
 *    never enter the op list (#1).
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
 *   [spec, spec, ...]          successive answers for a question asked more
 *                              than once in a run; the last spec repeats if
 *                              the list runs out
 * Discovery is stubbed via `options.discovered` (array) or
 * `options.discoverThrows`; env shadow via `options.shadow`.
 */
function makeDeps(script, options = {}) {
  const calls = {
    credentials: [],
    removed: [],
    removedProfiles: [],
    profiles: [],
    mutations: [],
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
    /** question id → defaultSelected labels, for pre-check regressions. */
    defaults: {},
  }
  const specCounters = {}
  const specFor = id => {
    const raw = script[id]
    if (!Array.isArray(raw)) return raw
    const index = Math.min(specCounters[id] ?? 0, raw.length - 1)
    specCounters[id] = (specCounters[id] ?? 0) + 1
    return raw[index]
  }
  const host = {
    listCatalogProviders: () => [
      { provider: 'deepseek', displayName: 'DeepSeek' },
      { provider: 'openai', displayName: 'OpenAI' },
      { provider: 'same-name', displayName: 'same-name' },
    ],
    listConfiguredProviders: () => options.configured ?? [],
    // All-layer ref census. The stub derives it from `configured` by default,
    // dropping routes whose profile unset already landed (stateful like the
    // real merged section); `options.refUsers` overrides per ref to simulate
    // base-layer consumers invisible to the user layer.
    listRefUsers: (ref, exceptRoute) => {
      // Only the post-unset re-check (no exclusion arg) throws under the
      // flag; the pre-confirm census still runs the derived stub.
      if (options.refUsersThrows && exceptRoute === undefined) throw new Error('settings layer unavailable')
      if (options.refUsers) return options.refUsers[ref] ?? []
      return (options.configured ?? [])
        .filter(row => row.route !== exceptRoute
          && !calls.removedProfiles.includes(row.route)
          && row.ref === ref)
        .map(row => row.route)
    },
    routeExists: () => false,
    discoverModels: async () => {
      if (options.discoverThrows) throw new Error('connection refused')
      return options.discovered ?? []
    },
    envShadows: ref => options.shadow === ref,
    envValue: ref => options.shadow === ref ? (options.shadowValue ?? 'sk-from-env') : undefined,
    readCredential: async ref => options.storedCredentials?.[ref],
    writeCredential: (ref, value) => {
      if (options.credentialThrows) throw new Error('credential rejected')
      calls.credentials.push([ref, value])
    },
    removeCredential: ref => {
      if (options.credentialRemoveThrows) throw new Error('credentials store unwritable')
      calls.removed.push(ref)
    },
    removeProfile: route => {
      if (options.removeProfileThrows) throw new Error('settings-rejected: unset failed')
      calls.removedProfiles.push(route)
    },
    writeProfile: async (route, profile) => {
      if (options.profileThrows) throw new Error('settings-rejected: unserviceable')
      calls.profiles.push([route, profile])
    },
    mutateProfile: async (route, ops) => {
      if (options.profileThrows) throw new Error('settings-rejected: unserviceable')
      calls.mutations.push([route, ops])
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
        calls.defaults[question.id] = question.defaultSelected ?? []
        const spec = question.id === 'action' && script['action'] === undefined
          ? ACTION_ADD
          : specFor(question.id)
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
// Edit-menu picks (asked exactly once per edit session).
const MENU_KEY = { selected: [t('provider-opt-edit-key')] }
const MENU_BASEURL = { selected: [t('provider-opt-edit-baseurl')] }
const MENU_PROTOCOL = { selected: [t('provider-opt-edit-protocol')] }
const MENU_MODELS = { selected: [t('provider-opt-edit-models')] }
const MENU_DELETE = { selected: [t('provider-opt-edit-delete')] }

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
// OAuth branch is unreachable (regression for the optional-plugin contract);
// the action layer now offers exactly add / edit — delete moved into the
// edit menu, so the delete option is absent at the top level.
{
  const { deps, calls } = makeDeps({
    'mode': MODE_CATALOG,
    'catalog': 'cancel',
  })
  const outcome = await runProviderWizard(deps)
  const actionLabels = Object.keys(calls.optionDescriptions.action ?? {})
  check('16 no oauth service: action offers add/edit (delete gone)',
    actionLabels.length === 2
      && actionLabels.includes(t('provider-opt-action-add'))
      && actionLabels.includes(t('provider-opt-action-edit')),
    JSON.stringify(actionLabels))
  check('16 no oauth service: mode stayed two options',
    Object.keys(calls.optionDescriptions.mode ?? {}).length === 2,
    JSON.stringify(Object.keys(calls.optionDescriptions.mode ?? {})))
  check('16 no oauth service: catalog cancel still cancels', outcome === 'cancelled', outcome)
}

// 17. edit a catalog route: only the model list changed. The models question
// pre-checks the enabled models (defaultSelected), the profile is PATCHED at
// `models` only (no whole-profile write, no confirm/switch), key untouched.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_MODELS,
    'models': { selected: ['deepseek-reasoner'] },
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: false, isCatalog: true, models: ['deepseek-chat'], modelEntries: [{ id: 'deepseek-chat' }] }],
    discovered: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
  })
  const outcome = await runProviderWizard(deps)
  check('17 edit models: outcome updated', outcome === 'updated', outcome)
  check('17 edit models: no credential write', eq(calls.credentials, []))
  check('17 edit models: whole profile never rewritten',
    eq(calls.profiles, []), JSON.stringify(calls.profiles))
  check('17 edit models: only the models path is patched',
    eq(calls.mutations, [['deepseek', [{ op: 'set', path: ['models'], value: [{ id: 'deepseek-reasoner' }] }]]]),
    JSON.stringify(calls.mutations))
  check('17 edit models: mode/route/key questions never asked',
    !calls.asks.includes('mode') && !calls.asks.includes('catalog')
      && !calls.asks.includes('route-id') && !calls.asks.includes('apikey'))
  check('17 edit models: no confirm or switch after the targeted edit',
    !calls.asks.includes('confirm') && !calls.asks.includes('switch'))
  check('17 edit models: models question pre-checks the enabled models',
    eq(calls.defaults.models, ['deepseek-chat']), JSON.stringify(calls.defaults.models))
  check('17 edit models: menu asked exactly once',
    calls.asks.filter(id => id === 'edit-menu').length === 1, JSON.stringify(calls.asks))
  check('17 edit models: summary notes the kept key',
    calls.pushed[0]?.lines.includes(t('provider-line-key-kept', { ref: 'DEEPSEEK_API_KEY' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 18. edit a custom route, API key only: the credential is overwritten and
// the profile is left untouched; the transcript notes the updated key.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_KEY,
    'apikey': { custom: 'sk-new' },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
    storedCredentials: { ACME_GATEWAY_API_KEY: 'sk-old' },
  })
  const outcome = await runProviderWizard(deps)
  check('18 edit key: outcome updated', outcome === 'updated', outcome)
  check('18 edit key: credential overwritten',
    eq(calls.credentials, [['ACME_GATEWAY_API_KEY', 'sk-new']]),
    JSON.stringify(calls.credentials))
  check('18 edit key: profile untouched', eq(calls.profiles, []), JSON.stringify(calls.profiles))
  check('18 edit key: transcript notes the updated key',
    calls.pushed[0]?.lines.includes(t('provider-line-key-updated', { ref: 'ACME_GATEWAY_API_KEY' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 19. edit a custom route, base URL: a single-field path patch sets the new
// endpoint; the rest of the profile (models, unknown fields) never enters
// the write — there is no rebuild to drop them with.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_BASEURL,
    'baseurl': { custom: 'https://gw.example/v2' },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
    discovered: [{ id: 'acme-large', contextWindow: 131072, maxTokens: 8192 }],
    storedCredentials: { ACME_GATEWAY_API_KEY: 'sk-old' },
  })
  const outcome = await runProviderWizard(deps)
  check('19 edit baseURL: outcome updated', outcome === 'updated', outcome)
  check('19 edit baseURL: only the baseURL path is patched',
    eq(calls.mutations, [['acme-gateway', [{ op: 'set', path: ['baseURL'], value: 'https://gw.example/v2' }]]]),
    JSON.stringify(calls.mutations))
  check('19 edit baseURL: no whole-profile write, no discovery, no credential write',
    eq(calls.profiles, []) && eq(calls.credentials, []))
}

// 20. edit a custom route, wire protocol: the current protocol is
// default-focused (defaultSelected); the patch sets only `api`.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_PROTOCOL,
    'protocol': { selected: ['anthropic-messages'] },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
    discovered: [{ id: 'acme-large' }],
    storedCredentials: { ACME_GATEWAY_API_KEY: 'sk-old' },
  })
  const outcome = await runProviderWizard(deps)
  check('20 edit protocol: outcome updated', outcome === 'updated', outcome)
  check('20 edit protocol: current protocol is the default selection',
    eq(calls.defaults.protocol, ['openai-completions']), JSON.stringify(calls.defaults.protocol))
  check('20 edit protocol: only the api path is patched',
    eq(calls.mutations, [['acme-gateway', [{ op: 'set', path: ['api'], value: 'anthropic-messages' }]]]),
    JSON.stringify(calls.mutations))
}

// 21. edit a shadowed-key route: "Edit API Key" refuses (the env provides
// the key) → cancelled, nothing written.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_KEY,
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: true, isCatalog: true, models: ['deepseek-chat'] }],
    shadow: 'DEEPSEEK_API_KEY',
  })
  const outcome = await runProviderWizard(deps)
  check('21 edit shadow: outcome cancelled', outcome === 'cancelled', outcome)
  check('21 edit shadow: Edit API Key refused without asking for a key',
    !calls.asks.includes('apikey')
      && calls.notifications.some(n => n.color === 'warning' && n.text.includes('DEEPSEEK_API_KEY')),
    JSON.stringify(calls.notifications))
  check('21 edit shadow: nothing written',
    eq(calls.credentials, []) && eq(calls.profiles, []))
}

// 22. edit with no configured providers: warning, nothing asked, cancelled.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
  }, { configured: [] })
  const outcome = await runProviderWizard(deps)
  check('22 edit none: outcome cancelled', outcome === 'cancelled', outcome)
  check('22 edit none: warning notified',
    calls.notifications.some(n => n.color === 'warning' && n.text === t('provider-none-configured')),
    JSON.stringify(calls.notifications))
}

// 23. delete via the edit menu, stored key: profile removed, then the
// credential removed (after the post-unset reference re-check comes back
// empty), transcript notes both, outcome deleted. A non-reserved ref so the
// removal path is the one under test (33 covers the reserved namespace).
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_DELETE,
    'delete-confirm': { selected: [t('provider-opt-delete-yes')] },
  }, {
    configured: [{ route: 'deepseek', ref: 'MY-ROUTE_KEY', shadowed: false, isCatalog: true, models: ['deepseek-chat'] }],
  })
  const outcome = await runProviderWizard(deps)
  check('23 delete: outcome deleted', outcome === 'deleted', outcome)
  check('23 delete: profile removed', eq(calls.removedProfiles, ['deepseek']), JSON.stringify(calls.removedProfiles))
  check('23 delete: credential removed', eq(calls.removed, ['MY-ROUTE_KEY']), JSON.stringify(calls.removed))
  check('23 delete: nothing written', eq(calls.profiles, []) && eq(calls.credentials, []))
  check('23 delete: success notified', calls.notifications.some(n => n.color === 'success'))
  check('23 delete: transcript notes the removed key',
    calls.pushed[0]?.lines.includes(t('provider-line-deleted-key', { ref: 'MY-ROUTE_KEY' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 24. delete via the edit menu, env-shadowed key: profile removed, credential
// left alone, transcript says the key came from the environment.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_DELETE,
    'delete-confirm': { selected: [t('provider-opt-delete-yes')] },
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: true, isCatalog: true, models: ['deepseek-chat'] }],
    shadow: 'DEEPSEEK_API_KEY',
  })
  const outcome = await runProviderWizard(deps)
  check('24 delete shadow: outcome deleted', outcome === 'deleted', outcome)
  check('24 delete shadow: profile removed', eq(calls.removedProfiles, ['deepseek']), JSON.stringify(calls.removedProfiles))
  check('24 delete shadow: credential NOT removed', eq(calls.removed, []), JSON.stringify(calls.removed))
  check('24 delete shadow: transcript notes the env keyref',
    calls.pushed[0]?.lines.includes(t('provider-line-deleted-key-shadowed', { ref: 'DEEPSEEK_API_KEY' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 25. delete cancelled at the confirm: nothing removed.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_DELETE,
    'delete-confirm': { selected: [t('provider-opt-confirm-cancel')] },
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: false, isCatalog: true, models: ['deepseek-chat'] }],
  })
  const outcome = await runProviderWizard(deps)
  check('25 delete cancel: outcome cancelled', outcome === 'cancelled', outcome)
  check('25 delete cancel: nothing removed',
    eq(calls.removedProfiles, []) && eq(calls.removed, []))
}

// 26. a no-op base URL edit (empty input): nothing written, 'cancelled'.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_BASEURL,
    'baseurl': { custom: '' },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
  })
  const outcome = await runProviderWizard(deps)
  check('26 no-op baseURL: outcome cancelled', outcome === 'cancelled', outcome)
  check('26 no-op baseURL: no-changes notice notified',
    calls.notifications.some(n => n.text === t('provider-edit-no-changes')),
    JSON.stringify(calls.notifications))
  check('26 no-op baseURL: nothing written', eq(calls.profiles, []))
}

// 27. custom-route model-list edit that ends up empty is rejected — a manual
// route needs at least one model, nothing written.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_MODELS,
    'models': { selected: [] },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
    discovered: [{ id: 'acme-large' }],
  })
  const outcome = await runProviderWizard(deps)
  check('27 custom empty models: outcome cancelled', outcome === 'cancelled', outcome)
  check('27 custom empty models: required-models error notified',
    calls.notifications.some(n => n.color === 'error' && n.text === t('provider-models-required')),
    JSON.stringify(calls.notifications))
  check('27 custom empty models: nothing written',
    eq(calls.profiles, []) && eq(calls.credentials, []))
}

// 28. menu shape: built-in routes offer key/models/delete only; custom routes
// also offer base URL and wire protocol.
{
  const { deps: depsCatalog, calls: callsCatalog } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_KEY,
    'apikey': { custom: 'sk-x' },
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: false, isCatalog: true, models: ['deepseek-chat'] }],
  })
  const outcomeCatalog = await runProviderWizard(depsCatalog)
  const catalogLabels = Object.keys(callsCatalog.optionDescriptions['edit-menu'] ?? {})
  check('28 menu shape: built-in route offers key/models/delete only',
    outcomeCatalog === 'updated'
      && eq(catalogLabels, [
        t('provider-opt-edit-key'),
        t('provider-opt-edit-models'),
        t('provider-opt-edit-delete'),
      ]),
    JSON.stringify(catalogLabels))

  const { deps: depsCustom, calls: callsCustom } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_KEY,
    'apikey': { custom: 'sk-x' },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
  })
  const outcomeCustom = await runProviderWizard(depsCustom)
  const customLabels = Object.keys(callsCustom.optionDescriptions['edit-menu'] ?? {})
  check('28 menu shape: custom route also offers base URL + wire protocol',
    outcomeCustom === 'updated'
      && eq(customLabels, [
        t('provider-opt-edit-key'),
        t('provider-opt-edit-baseurl'),
        t('provider-opt-edit-protocol'),
        t('provider-opt-edit-models'),
        t('provider-opt-edit-delete'),
      ]),
    JSON.stringify(customLabels))
}

// 29. a catalog route that explicitly overrides `api` stays catalog: the
// menu shape is membership-driven, not field-presence-driven (#3).
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['openai'] },
    'edit-menu': MENU_KEY,
    'apikey': { custom: 'sk-x' },
  }, {
    configured: [{ route: 'openai', ref: 'OPENAI_API_KEY', shadowed: false, isCatalog: true, api: 'openai-responses', models: ['gpt-1'] }],
  })
  const outcome = await runProviderWizard(deps)
  const labels = Object.keys(calls.optionDescriptions['edit-menu'] ?? {})
  check('29 catalog with api override: built-in menu shape kept',
    outcome === 'updated'
      && eq(labels, [
        t('provider-opt-edit-key'),
        t('provider-opt-edit-models'),
        t('provider-opt-edit-delete'),
      ]),
    JSON.stringify(labels))
}

// 30. delete with a failing credential cleanup: the profile unset landed,
// so the outcome is still 'deleted' (caller refreshes completions), the
// transcript says the key cleanup failed, and a warning names the ref (#2).
// Non-reserved ref: the removal path itself is under test here.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_DELETE,
    'delete-confirm': { selected: [t('provider-opt-delete-yes')] },
  }, {
    configured: [{ route: 'deepseek', ref: 'MY-ROUTE_KEY', shadowed: false, isCatalog: true, models: ['deepseek-chat'] }],
    credentialRemoveThrows: true,
  })
  const outcome = await runProviderWizard(deps)
  check('30 delete key-cleanup failure: outcome deleted (catalog changed)',
    outcome === 'deleted', outcome)
  check('30 delete key-cleanup failure: profile removed', eq(calls.removedProfiles, ['deepseek']))
  check('30 delete key-cleanup failure: warning names the ref',
    calls.notifications.some(n => n.color === 'warning' && n.text.includes('MY-ROUTE_KEY')),
    JSON.stringify(calls.notifications))
  check('30 delete key-cleanup failure: transcript says the cleanup failed',
    calls.pushed[0]?.lines.includes(t('provider-line-deleted-key-cleanup-failed', { ref: 'MY-ROUTE_KEY' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
  check('30 delete key-cleanup failure: no error toast, catalog is consistent',
    !calls.notifications.some(n => n.color === 'error'))
}

// 30b. removeProfile itself failing: NOTHING changed → honest 'failed'.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_DELETE,
    'delete-confirm': { selected: [t('provider-opt-delete-yes')] },
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: false, isCatalog: true, models: ['deepseek-chat'] }],
    removeProfileThrows: true,
  })
  const outcome = await runProviderWizard(deps)
  check('30b removeProfile failure: outcome failed', outcome === 'failed', outcome)
  check('30b removeProfile failure: credential untouched', eq(calls.removed, []))
  check('30b removeProfile failure: error notified',
    calls.notifications.some(n => n.color === 'error'))
}

// 31. delete of a route whose key ref is shared with another configured
// route: the key is kept (removing it would break the sibling), the confirm
// detail warns up front and the transcript records the decision (#5).
// Non-reserved ref: the shared branch is under test (33 covers reserved).
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_DELETE,
    'delete-confirm': { selected: [t('provider-opt-delete-yes')] },
  }, {
    configured: [
      { route: 'acme-gateway', ref: 'ACME_SHARED_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] },
      { route: 'acme-clone', ref: 'ACME_SHARED_KEY', shadowed: false, isCatalog: false, baseURL: 'https://clone.example/v1', api: 'openai-completions', models: ['acme-large'] },
    ],
  })
  const outcome = await runProviderWizard(deps)
  check('31 delete shared key: outcome deleted', outcome === 'deleted', outcome)
  check('31 delete shared key: profile removed, credential kept',
    eq(calls.removedProfiles, ['acme-gateway']) && eq(calls.removed, []),
    JSON.stringify(calls.removed))
  check('31 delete shared key: confirm detail warns about the shared ref',
    (calls.details['delete-confirm'] ?? '').includes('acme-clone'),
    calls.details['delete-confirm'])
  check('31 delete shared key: transcript notes the kept key',
    calls.pushed[0]?.lines.includes(t('provider-line-deleted-key-shared', { ref: 'ACME_SHARED_KEY', routes: 'acme-clone' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 32. a model-list rewrite reuses stored entries verbatim for kept ids, so
// per-model fields the wizard does not model survive; new ids are built
// from the discovery rows (#1).
{
  const storedEntry = { id: 'acme-large', contextWindow: 4096, input: ['text'], compat: { tier: 'pro' } }
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_MODELS,
    'models': { selected: ['acme-large', 'acme-small'] },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'], modelEntries: [storedEntry] }],
    discovered: [
      { id: 'acme-large', contextWindow: 131072, maxTokens: 8192 },
      { id: 'acme-small', contextWindow: 2048 },
    ],
  })
  const outcome = await runProviderWizard(deps)
  check('32 edit models: outcome updated', outcome === 'updated', outcome)
  const mutations = calls.mutations
  check('32 edit models: one set op on models, nothing else',
    mutations.length === 1 && mutations[0][0] === 'acme-gateway'
      && mutations[0][1].length === 1 && mutations[0][1][0].op === 'set'
      && eq(mutations[0][1][0].path, ['models']),
    JSON.stringify(mutations))
  check('32 edit models: kept model reuses the stored entry verbatim (unknown fields survive)',
    eq(mutations[0][1][0].value[0], storedEntry), JSON.stringify(mutations[0][1][0].value))
  check('32 edit models: newly enabled model is built from the discovery row',
    eq(mutations[0][1][0].value[1], { id: 'acme-small', contextWindow: 2048 }),
    JSON.stringify(mutations[0][1][0].value[1]))
}

// 33. delete of a route whose ref is host-reserved (DEEPSEEK_API_KEY): the
// credential is NEVER removed even though the user layer shows no other
// user — the harness itself resolves this ref. Transcript says reserved.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['deepseek'] },
    'edit-menu': MENU_DELETE,
    'delete-confirm': { selected: [t('provider-opt-delete-yes')] },
  }, {
    configured: [{ route: 'deepseek', ref: 'DEEPSEEK_API_KEY', shadowed: false, isCatalog: true, models: ['deepseek-chat'] }],
  })
  const outcome = await runProviderWizard(deps)
  check('33 delete reserved ref: outcome deleted', outcome === 'deleted', outcome)
  check('33 delete reserved ref: profile removed, credential kept',
    eq(calls.removedProfiles, ['deepseek']) && eq(calls.removed, []),
    JSON.stringify(calls.removed))
  check('33 delete reserved ref: transcript notes the reserved key',
    calls.pushed[0]?.lines.includes(t('provider-line-deleted-key-reserved', { ref: 'DEEPSEEK_API_KEY' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 33b. delete of a route whose ref is consumed by a BASE-layer profile the
// editable user-layer list never shows: the all-layer census keeps the key
// even though no OTHER CONFIGURED ROUTE names the ref.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['my-gateway'] },
    'edit-menu': MENU_DELETE,
    'delete-confirm': { selected: [t('provider-opt-delete-yes')] },
  }, {
    configured: [{ route: 'my-gateway', ref: 'GATEWAY_SHARED_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['m1'] }],
    // Base-inherited consumer, invisible to listConfiguredProviders.
    refUsers: { GATEWAY_SHARED_KEY: ['deepseek'] },
  })
  const outcome = await runProviderWizard(deps)
  check('33b delete with hidden base consumer: outcome deleted', outcome === 'deleted', outcome)
  check('33b delete with hidden base consumer: credential kept', eq(calls.removed, []),
    JSON.stringify(calls.removed))
  check('33b delete with hidden base consumer: transcript names the base route',
    calls.pushed[0]?.lines.includes(t('provider-line-deleted-key-shared', { ref: 'GATEWAY_SHARED_KEY', routes: 'deepseek' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 33c. the reference RE-CHECK runs after the profile unset: the pre-confirm
// census saw no sharer, but the merged section still names consumers when
// removal time comes (e.g. the unset re-inherited a base profile) — the key
// is kept.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['my-gateway'] },
    'edit-menu': MENU_DELETE,
    'delete-confirm': { selected: [t('provider-opt-delete-yes')] },
  }, {
    configured: [{ route: 'my-gateway', ref: 'GATEWAY_SHARED_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['m1'] }],
  })
  const base = deps.host.listRefUsers
  deps.host.listRefUsers = (ref, exceptRoute) => {
    // First call: pre-confirm census — empty. Second: post-unset re-check —
    // a consumer appeared in the merged section meanwhile.
    const users = exceptRoute === undefined ? ['deepseek'] : base(ref, exceptRoute)
    return users
  }
  const outcome = await runProviderWizard(deps)
  check('33c post-unset recheck finds a consumer: credential kept',
    outcome === 'deleted' && eq(calls.removed, []), JSON.stringify(calls.removed))
  check('33c post-unset recheck finds a consumer: transcript notes shared key',
    calls.pushed[0]?.lines.includes(t('provider-line-deleted-key-shared', { ref: 'GATEWAY_SHARED_KEY', routes: 'deepseek' })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 33d. the post-unset re-check itself throws: fail closed — the key is kept
// with an unknown-users note (an unremovable key is recoverable, a
// destroyed one is not).
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['my-gateway'] },
    'edit-menu': MENU_DELETE,
    'delete-confirm': { selected: [t('provider-opt-delete-yes')] },
  }, {
    configured: [{ route: 'my-gateway', ref: 'GATEWAY_SHARED_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['m1'] }],
    refUsersThrows: true,
  })
  const outcome = await runProviderWizard(deps)
  check('33d ref query failure: outcome deleted, credential kept',
    outcome === 'deleted' && eq(calls.removed, []), JSON.stringify(calls.removed))
  check('33d ref query failure: transcript notes the kept key',
    calls.pushed[0]?.lines.includes(t('provider-line-deleted-key-shared',
      { ref: 'GATEWAY_SHARED_KEY', routes: t('provider-unknown-ref-users') })) === true,
    JSON.stringify(calls.pushed[0]?.lines))
}

// 34. edit the API key of a route whose ref is shared: the write is gated
// by an explicit overwrite confirm naming the other users; cancelling the
// confirm writes nothing.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_KEY,
    'apikey': { custom: 'sk-new' },
    'key-overwrite-confirm': { selected: [t('provider-opt-confirm-cancel')] },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
    storedCredentials: { ACME_GATEWAY_API_KEY: 'sk-old' },
    refUsers: { ACME_GATEWAY_API_KEY: ['acme-clone'] },
  })
  const outcome = await runProviderWizard(deps)
  check('34 edit shared key declined: outcome cancelled', outcome === 'cancelled', outcome)
  check('34 edit shared key declined: credential untouched', eq(calls.credentials, []),
    JSON.stringify(calls.credentials))
  check('34 edit shared key declined: confirm names the other user',
    (calls.details['key-overwrite-confirm'] ?? '').includes('acme-clone'),
    calls.details['key-overwrite-confirm'])
}

// 34b. same, confirming the overwrite: the shared credential is written.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_KEY,
    'apikey': { custom: 'sk-new' },
    'key-overwrite-confirm': { selected: [t('provider-opt-key-overwrite-yes')] },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
    storedCredentials: { ACME_GATEWAY_API_KEY: 'sk-old' },
    refUsers: { ACME_GATEWAY_API_KEY: ['acme-clone'] },
  })
  const outcome = await runProviderWizard(deps)
  check('34b edit shared key confirmed: credential overwritten',
    outcome === 'updated' && eq(calls.credentials, [['ACME_GATEWAY_API_KEY', 'sk-new']]),
    JSON.stringify(calls.credentials))
}

// 34c. an unshared ref edits straight through: no confirm question at all.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_KEY,
    'apikey': { custom: 'sk-new' },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
    storedCredentials: { ACME_GATEWAY_API_KEY: 'sk-old' },
  })
  const outcome = await runProviderWizard(deps)
  check('34c edit unshared key: no overwrite confirm asked',
    outcome === 'updated' && !calls.asks.includes('key-overwrite-confirm'),
    JSON.stringify(calls.asks))
}

// 35. a model-list edit where discovery drops an existing model: the stored
// model still appears in the panel (marked not-found, pre-checked) so an
// Enter-through confirm cannot silently delete it; explicit un-check of the
// others keeps it.
{
  const storedMissing = { id: 'acme-legacy', contextWindow: 4096, compat: { tier: 'legacy' } }
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_MODELS,
    'models': { selected: ['acme-large', 'acme-legacy', 'acme-new'] },
  }, {
    configured: [{
      route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false,
      baseURL: 'https://gw.example/v1', api: 'openai-completions',
      models: ['acme-large', 'acme-legacy'], modelEntries: [{ id: 'acme-large' }, storedMissing],
    }],
    discovered: [{ id: 'acme-large' }, { id: 'acme-new' }],
    storedCredentials: { ACME_GATEWAY_API_KEY: 'sk-old' },
  })
  const outcome = await runProviderWizard(deps)
  check('35 edit models: undiscovered stored model stays in the option list',
    calls.optionDescriptions.models?.['acme-legacy'] === t('provider-row-model-missing'),
    JSON.stringify(calls.optionDescriptions.models))
  check('35 edit models: outcome updated', outcome === 'updated', outcome)
  const value = calls.mutations[0][1][0].value
  check('35 edit models: kept-but-undiscovered model is preserved verbatim',
    eq(value[1], storedMissing), JSON.stringify(value))
}

// 28b. single-field custom-route patch shape: editing baseURL addresses
// exactly one path — the rest of the stored object never enters the op list.
{
  const { deps, calls } = makeDeps({
    'action': ACTION_EDIT,
    'edit-provider': { selected: ['acme-gateway'] },
    'edit-menu': MENU_BASEURL,
    'baseurl': { custom: 'https://gw.example/v9' },
  }, {
    configured: [{ route: 'acme-gateway', ref: 'ACME_GATEWAY_API_KEY', shadowed: false, isCatalog: false, baseURL: 'https://gw.example/v1', api: 'openai-completions', models: ['acme-large'] }],
  })
  await runProviderWizard(deps)
  const op = calls.mutations[0][1][0]
  check('28b patch shape: single op, path is exactly [baseURL]',
    calls.mutations[0][1].length === 1 && eq(op.path, ['baseURL']) && op.op === 'set',
    JSON.stringify(calls.mutations))
}

console.log(failed === 0 ? '\nAll provider-wizard checks passed' : `\n${failed} check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)
