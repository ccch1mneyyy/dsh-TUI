/**
 * `/provider` wizard — interactively adds, edits, or deletes an LLM
 * provider route at runtime.
 *
 * The wizard is a sequence of `QuestionStore` asks (the same panel the
 * model-facing `ask_user_question` tool uses), so it needs no UI state of
 * its own. All side effects go through {@link ProviderSetupHost}, which the
 * channel implements over the dsh settings/credentials/llm seams:
 *
 *   profile → settings `llm-pi-ai.providers.<route>` (dsh-llm-pi-ai watches
 *             the section and registers the route without a restart)
 *   key     → credentials store (`~/.dsh/.credentials.yaml`, 0600), named by
 *             the derived `<ROUTE>_API_KEY` env-style ref the profile's
 *             `apiKeyEnv` points at
 *
 * The module is React-free so `scripts/verify-provider-wizard.mjs` can drive
 * it headless with a stubbed host and scripted answers.
 */

import { t } from '../i18n.js'
import { isReservedCredentialRef } from './credentialRefGuard.js'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'

/** Route id rule shared with the dsh configuration surface (web Models page). */
export const PROVIDER_ROUTE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Wire protocols dsh-llm-pi-ai can serve on a manually declared route. */
export const PROVIDER_PROTOCOLS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
] as const

/**
 * Derive the credential ref for a route, matching the official web UI
 * convention so TUI- and web-added providers resolve the same key.
 */
export function deriveKeyRef(route: string): string {
  return `${route.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/** One catalog route the mounted adapters offer for activation. */
export interface CatalogProviderCandidate {
  readonly provider: string
  readonly displayName: string
}

/**
 * One user-added provider route read from the settings section. The parsed
 * fields drive the edit/delete picker rows, the catalog/custom split
 * (`isCatalog`) and the key-keep question (`ref` + `shadowed`).
 */
export interface ConfiguredProvider {
  readonly route: string
  /** Credential ref (profile.apiKeyEnv) when the profile names one. */
  readonly ref: string
  /** Whether the process environment shadows the ref (env-provided key). */
  readonly shadowed: boolean
  /**
   * Whether the route belongs to the installed catalog — real membership
   * as the llm adapter reports it, never inferred from the profile shape:
   * a catalog profile may carry an explicit `api` override and still be a
   * catalog route.
   */
  readonly isCatalog: boolean
  /** baseURL when the profile sets one. */
  readonly baseURL?: string
  /** Explicit `api` override in the stored profile; catalog routes can
   *  carry one too, so this alone does not classify the route. */
  readonly api?: string
  /** Enabled model ids; undefined means the whole catalog stays served. */
  readonly models?: readonly string[]
  /**
   * Raw `profile.models` entries (plain objects, in order) as stored. A
   * targeted model-list rewrite reuses these for kept ids so fields the
   * wizard never learned about (`input`, `compat`, …) survive the edit.
   */
  readonly modelEntries?: readonly Record<string, unknown>[]
}

/** One path op inside a provider profile, relative to the profile object. */
export type ProfilePathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

/** One OAuth-capable provider a dsh-auth-style plugin mounts (masked state only). */
export interface OAuthProviderStatus {
  readonly provider: string
  readonly label: string
  readonly oauthLabel: string
  readonly loginLabel: string | undefined
  readonly signedIn: boolean
  readonly expiresAt: number | undefined
  readonly expired: boolean
}

/** One successful OAuth login. */
export interface OAuthLoginResult {
  readonly provider: string
  readonly oauthLabel: string
  readonly expiresAt: number
}

/**
 * The `ctx.dshAuth` api, structural so this tree never imports the plugin:
 * mounting dsh-auth (or anything exporting this shape) lights up the wizard's
 * OAuth branch; absent it, the wizard behaves exactly as before.
 */
export interface OAuthSetupHost {
  providers(): Promise<readonly OAuthProviderStatus[]>
  login(provider?: string, signal?: AbortSignal): Promise<OAuthLoginResult>
  logout(provider: string): Promise<boolean>
}

/**
 * Runtime capabilities the wizard needs, implemented by the channel over
 * `ctx.settings` / `ctx.credentials` / `ctx.llm`. `undefined` from
 * `channel.providerSetup()` means the bare cordis.yml start (no dsh-base
 * services) and the command refuses to run.
 */
export interface ProviderSetupHost {
  /** Catalog routes activatable via the `llm-pi-ai` settings section. */
  listCatalogProviders(): readonly CatalogProviderCandidate[]
  /**
   * The editable/deletable set: provider profiles the user layer itself
   * carries. Profiles inherited from the composition base are deliberately
   * absent — an unset only clears the user layer, so listing an inherited
   * route would promise a delete that silently reverts to the base value.
   */
  listConfiguredProviders(): readonly ConfiguredProvider[]
  /**
   * Routes whose stored profile names `ref` as `apiKeyEnv` at ANY settings
   * layer (user + inherited base), minus `exceptRoute`. Credential-impact
   * decisions (delete cleanup, shared-key confirm) must go through this,
   * never through {@link listConfiguredProviders}: that lists the user
   * layer only (a deletable set), so a base provider or a composition-base
   * route sharing the ref would be invisible and its key destroyed.
   */
  listRefUsers(ref: string, exceptRoute?: string): readonly string[]
  /** Whether a profile (any layer) already exists for the route. */
  routeExists(route: string): boolean
  /** Interrogate a draft endpoint; the draft key is never persisted. */
  discoverModels(request: {
    provider?: string
    baseURL?: string
    api?: string
    apiKey?: string
  }): Promise<readonly LlmDiscoveredModel[]>
  /** Whether the process environment already provides this ref (shadow). */
  envShadows(ref: string): boolean
  /** The process-environment value for a shadowed ref; undefined when absent. */
  envValue(ref: string): string | undefined
  /**
   * Read the currently stored value for rollback purposes; undefined when no
   * credential exists under the ref. Only called when {@link envShadows} is
   * false, so the value comes from a writable/seeded store, never the env.
   */
  readCredential(ref: string): Promise<string | undefined>
  /** Persist the key under the ref; rejects when env-shadowed or invalid. */
  writeCredential(ref: string, value: string): void | Promise<void>
  /** Best-effort rollback of a just-written credential. */
  removeCredential(ref: string): void | Promise<void>
  /**
   * Persist the provider profile under `llm-pi-ai.providers.<route>`;
   * rejects when the adapter's validation deems it unserviceable. Used by
   * the add flow, where a whole-profile write is the intent.
   */
  writeProfile(route: string, profile: Record<string, unknown>): Promise<void>
  /**
   * Apply targeted path ops inside `llm-pi-ai.providers.<route>`. Edits go
   * through here, never through {@link writeProfile}: replacing the whole
   * object would silently drop every field the wizard does not model
   * (`headers`, `timeoutMs`, `retryPolicy`, `displayName`, …). Paths are
   * relative to the profile object, so `['baseURL']` patches exactly the
   * one item the user picked; unknown fields stay untouched by omission.
   */
  mutateProfile(route: string, ops: readonly ProfilePathOp[]): Promise<void>
  /** Unset the profile under `llm-pi-ai.providers.<route>`. */
  removeProfile(route: string): Promise<void>
  /** The OAuth sign-in surface; absent when no dsh-auth-style plugin is mounted. */
  readonly oauth?: OAuthSetupHost
}

export interface ProviderWizardDeps {
  readonly host: ProviderSetupHost
  readonly ask: (
    request: AskUserQuestionRequest,
    options?: { redact?: boolean },
  ) => Promise<AskUserQuestionAnswer>
  readonly notify: (
    text: string,
    options?: { color?: 'error' | 'warning' | 'success'; timeoutMs?: number },
  ) => void
  readonly pushLocal: (title: string, lines: readonly string[]) => void
  /** Live turn state; the model-switch question is skipped while working. */
  readonly working: () => boolean
  readonly switchModel: (provider: string, model: string) => Promise<boolean>
}

export type ProviderWizardOutcome = 'added' | 'updated' | 'deleted' | 'signed-out' | 'cancelled' | 'failed'

/** Max attempts for validated free-text prompts before giving up. */
const MAX_RETRY = 3

function answerText(answer: AskUserQuestionAnswer, id: string): string {
  return answer.answers.find(item => item.id === id)?.custom?.trim() ?? ''
}

function answerSelected(answer: AskUserQuestionAnswer, id: string): readonly string[] {
  return answer.answers.find(item => item.id === id)?.selected ?? []
}

/**
 * Local presentation extension carried through to AskUserQuestionPanel:
 * pure option questions hide the trailing free-text input row, and
 * `defaultSelected` pre-checks (multi-select) or default-focuses
 * (single-select) the listed option labels — e.g. the models already
 * enabled on a route being edited. Structurally assigned into the dsh
 * request type; the harness side never sets it, so model-facing asks keep
 * the input row and no pre-selection.
 */
type WizardQuestionItem = AskUserQuestionItem & {
  hideCustomInput?: boolean
  defaultSelected?: readonly string[]
}

function optionQuestion(
  id: string,
  question: string,
  options: readonly { label: string; description?: string }[],
  extra?: {
    detail?: string
    multiSelect?: boolean
    hideCustomInput?: boolean
    defaultSelected?: readonly string[]
  },
): AskUserQuestionItem {
  const item: WizardQuestionItem = {
    id,
    question,
    header: '/provider',
    options: options.map(option => ({ ...option })),
    ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
    ...(extra?.multiSelect ? { multiSelect: true } : {}),
    ...(extra?.hideCustomInput ? { hideCustomInput: true } : {}),
    ...(extra?.defaultSelected !== undefined ? { defaultSelected: extra.defaultSelected } : {}),
  }
  return item
}

function textQuestion(id: string, question: string, detail?: string): AskUserQuestionItem {
  return {
    id,
    question,
    header: '/provider',
    ...(detail !== undefined ? { detail } : {}),
  }
}

/**
 * Run the provider wizard. Opens with an action choice (add / edit); the
 * add path runs the guided config flow, and edit picks a configured route
 * then opens a menu of targeted edits (API key, base URL, wire protocol,
 * model list, delete this provider) with the route locked. Each menu item
 * applies immediately and exits — no confirmation between picking an edit
 * and writing it — and patches only the picked field, leaving every other
 * stored setting (including fields the wizard does not model) in place.
 * For built-in (catalog) routes the menu is limited to API
 * key, model list, and delete; base URL and wire protocol are only
 * meaningful for custom endpoints. Resolves 'cancelled' when the user
 * dismisses any question (Esc) — nothing has been written at that point.
 */
export async function runProviderWizard(
  deps: ProviderWizardDeps,
): Promise<ProviderWizardOutcome> {
  const { ask, notify } = deps
  let action: 'add' | 'edit' = 'add'
  try {
    const actionAnswer = await ask({
      questions: [optionQuestion('action', t('provider-q-action'), [
        { label: t('provider-opt-action-add'), description: t('provider-opt-action-add-desc') },
        { label: t('provider-opt-action-edit'), description: t('provider-opt-action-edit-desc') },
      ], { hideCustomInput: true })],
    })
    const pickedAction = answerSelected(actionAnswer, 'action')[0]
    if (pickedAction === t('provider-opt-action-edit')) {
      action = 'edit'
      // `await` before returning keeps the sub-wizard's rejection inside the
      // try so its UserQuestionError maps to the action-specific outcome —
      // a bare `return promise` would bypass the catch below.
      return await runEditWizard(deps)
    }
    return await runAddFlow(deps)
  } catch (error) {
    if (error instanceof UserQuestionError) {
      notify(action === 'edit'
        ? t('provider-edit-cancelled')
        : t('provider-cancelled'))
      return 'cancelled'
    }
    const err = error instanceof Error ? error.message : String(error)
    notify(t('provider-write-failed', { err }), { color: 'error', timeoutMs: 8000 })
    return 'failed'
  }
}

/**
 * The guided add flow behind `/provider`'s "Add a new provider" branch:
 * mode (catalog / custom / optional OAuth), route, API key, endpoint /
 * protocol, model discovery + selection, confirm, then persist with
 * credential rollback. Esc anywhere cancels with nothing written.
 */
async function runAddFlow(
  deps: ProviderWizardDeps,
): Promise<ProviderWizardOutcome> {
  const { host, ask, notify, pushLocal } = deps

  // ── 1. mode ────────────────────────────────────────────────────────
  const modeOptions = [
    { label: t('provider-opt-catalog'), description: t('provider-opt-catalog-desc') },
    { label: t('provider-opt-custom'), description: t('provider-opt-custom-desc') },
  ]
  // The OAuth branch exists only while a dsh-auth-style plugin is mounted;
  // without the service the mode question stays exactly two options.
  if (host.oauth !== undefined) {
    modeOptions.push({ label: t('provider-opt-oauth'), description: t('provider-opt-oauth-desc') })
  }
  const modeAnswer = await ask({
    questions: [optionQuestion('mode', t('provider-q-mode'), modeOptions, { hideCustomInput: true })],
  })
  const pickedMode = answerSelected(modeAnswer, 'mode')[0]
  if (host.oauth !== undefined && pickedMode === t('provider-opt-oauth')) {
    return runOAuthWizard(deps, host.oauth)
  }
  const isCatalog = pickedMode === t('provider-opt-catalog')

  // ── 2. route ───────────────────────────────────────────────────────
  let route = ''
  if (isCatalog) {
    const candidates = host.listCatalogProviders()
    if (candidates.length > 0) {
      const otherLabel = t('provider-opt-other-route')
      const catalogAnswer = await ask({
        questions: [optionQuestion('catalog', t('provider-q-catalog'), [
          ...candidates.map(candidate => ({
            label: candidate.provider,
            description: candidate.displayName === candidate.provider
              ? undefined
              : candidate.displayName,
          })),
          { label: otherLabel, description: t('provider-opt-other-route-desc') },
        ], { hideCustomInput: true })],
      })
      const pick = answerSelected(catalogAnswer, 'catalog')[0]
      if (pick !== undefined && pick !== otherLabel) route = pick
    }
  }
  if (route === '') {
    route = await promptRouteId(ask, notify)
    if (route === '') return 'cancelled'
  }

  // ── 3. API key (own batch so redact covers exactly the secret) ─────
  const ref = deriveKeyRef(route)
  const shadowed = host.envShadows(ref)
  const keyAnswer = await ask({
    questions: [textQuestion('apikey', t('provider-q-apikey'), t('provider-q-apikey-detail'))],
  }, { redact: true })
  const apiKey = answerText(keyAnswer, 'apikey')
  const keyLine = shadowed
    ? t('provider-line-keyref-env', { ref })
    : t('provider-line-keyref', { ref })

  // ── 4. endpoint / protocol ─────────────────────────────────────────
  let baseURL: string | undefined
  let api: string | undefined
  if (isCatalog) {
    const choiceAnswer = await ask({
      questions: [optionQuestion('baseurl-choice', t('provider-q-baseurl-choice'), [
        { label: t('provider-opt-baseurl-skip') },
        { label: t('provider-opt-baseurl-input') },
      ], { hideCustomInput: true })],
    })
    if (answerSelected(choiceAnswer, 'baseurl-choice')[0] === t('provider-opt-baseurl-input')) {
      const urlAnswer = await ask({
        questions: [textQuestion('baseurl', t('provider-q-baseurl'))],
      })
      baseURL = answerText(urlAnswer, 'baseurl')
    }
  } else {
    const endpointAnswer = await ask({
      questions: [
        textQuestion('baseurl', t('provider-q-baseurl')),
        optionQuestion('protocol', t('provider-q-protocol'), [
          { label: 'openai-completions', description: t('provider-protocol-completions-desc') },
          { label: 'openai-responses', description: t('provider-protocol-responses-desc') },
          { label: 'anthropic-messages', description: t('provider-protocol-anthropic-desc') },
        ], { hideCustomInput: true }),
      ],
    })
    baseURL = answerText(endpointAnswer, 'baseurl')
    api = answerSelected(endpointAnswer, 'protocol')[0]
  }

  // ── 5. model discovery (draft credential, nothing persisted) ───────
  notify(t('provider-discovery-running'))
  const discovered = await host.discoverModels({
    ...(isCatalog ? { provider: route } : {}),
    ...(baseURL !== undefined && baseURL !== '' ? { baseURL } : {}),
    ...(api !== undefined ? { api } : {}),
    apiKey: apiKey ?? '',
  }).catch(() => [])

  // ── 6. model selection ─────────────────────────────────────────────
  let models: string[] = []
  let discoveredById = new Map<string, LlmDiscoveredModel>()
  if (discovered.length > 0) {
    discoveredById = new Map(discovered.map(model => [model.id, model] as const))
    const modelsAnswer = await ask({
      questions: [optionQuestion('models', t('provider-q-models'),
        discovered.map(model => ({
          label: model.id,
          description: [
            model.name ?? '',
            model.contextWindow !== undefined ? `${model.contextWindow}` : '',
          ].filter(part => part !== '').join(' · ') || undefined,
        })),
        { multiSelect: true },
      )],
    })
    models = mergeModelIds(
      answerSelected(modelsAnswer, 'models'),
      answerText(modelsAnswer, 'models'),
    )
  } else {
    notify(t('provider-discovery-failed'), { color: 'warning' })
    for (let attempt = 0; attempt < MAX_RETRY && models.length === 0; attempt += 1) {
      const fallbackAnswer = await ask({
        questions: [textQuestion('models-fallback', t('provider-q-models-fallback'))],
      })
      models = mergeModelIds([], answerText(fallbackAnswer, 'models-fallback'))
      if (models.length === 0) notify(t('provider-models-required'), { color: 'warning' })
    }
    if (models.length === 0) return 'cancelled'
  }
  if (!isCatalog && models.length === 0) {
    // A manual route without models fails the adapter validation; the
    // loops above should prevent this, but guard before writing.
    notify(t('provider-models-required'), { color: 'error' })
    return 'cancelled'
  }

  // ── 7. confirm ─────────────────────────────────────────────────────
  const summaryLines = buildSummaryLines({
    route, ref, shadowed, baseURL, api, models, isCatalog, keyLine,
  })
  const detail = host.routeExists(route)
    ? `${summaryLines.join('\n')}\n${t('provider-route-exists-warning')}`
    : summaryLines.join('\n')
  const confirmAnswer = await ask({
    questions: [optionQuestion('confirm', t('provider-q-confirm'), [
      { label: t('provider-opt-confirm-write') },
      { label: t('provider-opt-confirm-cancel') },
    ], { detail, hideCustomInput: true })],
  })
  if (answerSelected(confirmAnswer, 'confirm')[0] !== t('provider-opt-confirm-write')) {
    notify(t('provider-cancelled'))
    return 'cancelled'
  }

  // ── 8. persist: credential first (rollbackable), then the profile ──
  let wroteCredential = false
  let previousCredential: string | undefined
  if (!shadowed && apiKey !== undefined) {
    // Capture any pre-existing value BEFORE overwriting: when the profile
    // write below fails, rollback must restore it — an unconditional unset
    // would destroy the old key of the route being overwritten.
    previousCredential = await host.readCredential(ref)
    await host.writeCredential(ref, apiKey)
    wroteCredential = true
  }
  const profile = buildProfile({ isCatalog, ref, baseURL, api, models, discoveredById })
  try {
    await host.writeProfile(route, profile)
  } catch (error) {
    if (wroteCredential) {
      try {
        if (previousCredential !== undefined) {
          await host.writeCredential(ref, previousCredential)
        } else {
          await host.removeCredential(ref)
        }
        notify(t('provider-rollback-ok'))
      } catch {
        notify(t('provider-rollback-failed'), { color: 'warning' })
      }
    }
    const err = error instanceof Error ? error.message : String(error)
    notify(t('provider-write-failed', { err }), { color: 'error', timeoutMs: 8000 })
    return 'failed'
  }

  // ── 9. success: transcript summary + optional live switch ──────────
  pushLocal('/provider', [
    ...summaryLines,
    ...(deps.working() || models.length === 0
      ? [t('provider-switch-hint')]
      : []),
  ])
  notify(t('provider-success', { route }), { color: 'success' })

  if (!deps.working() && models.length > 0) {
    const target = models[0]!
    const switchAnswer = await ask({
      questions: [optionQuestion('switch', t('provider-q-switch'), [
        { label: t('provider-opt-switch-now', { model: target }) },
        { label: t('provider-opt-switch-keep') },
      ], { hideCustomInput: true })],
    })
    if (answerSelected(switchAnswer, 'switch')[0] === t('provider-opt-switch-now', { model: target })) {
      await deps.switchModel(route, target)
    }
  }
  return 'added'
}

/**
 * The edit branch of `/provider`: pick a configured route, then open the
 * one-shot targeted-edit menu ({@link runEditMenu}) with the route locked.
 */
async function runEditWizard(
  deps: ProviderWizardDeps,
): Promise<ProviderWizardOutcome> {
  const { host, ask, notify } = deps
  const configured = host.listConfiguredProviders()
  if (configured.length === 0) {
    notify(t('provider-none-configured'), { color: 'warning' })
    return 'cancelled'
  }
  const pickAnswer = await ask({
    questions: [optionQuestion('edit-provider', t('provider-q-edit'), configured.map(provider => ({
      label: provider.route,
      description: providerRowDescription(provider),
    })), { hideCustomInput: true })],
  })
  const route = answerSelected(pickAnswer, 'edit-provider')[0]
  const existing = configured.find(row => row.route === route)
  if (existing === undefined) return 'cancelled'
  return runEditMenu(deps, existing)
}

/**
 * The edit menu for one configured route: pick exactly one targeted edit and
 * apply it immediately. Base URL and wire protocol only make sense for
 * custom (non-catalog) routes, so built-in routes get a three-item menu —
 * API key / model list / delete.
 */
async function runEditMenu(
  deps: ProviderWizardDeps,
  provider: ConfiguredProvider,
): Promise<ProviderWizardOutcome> {
  const { ask, notify } = deps
  const menuAnswer = await ask({
    questions: [optionQuestion('edit-menu', t('provider-q-edit-menu', { route: provider.route }),
      buildEditMenuOptions(provider),
      { hideCustomInput: true })],
  })
  const picked = answerSelected(menuAnswer, 'edit-menu')[0]
  if (picked === t('provider-opt-edit-delete')) return deleteConfiguredProvider(deps, provider)
  if (picked === t('provider-opt-edit-key')) return editApiKey(deps, provider)
  if (picked === t('provider-opt-edit-baseurl')) return editBaseUrl(deps, provider)
  if (picked === t('provider-opt-edit-protocol')) return editWireProtocol(deps, provider)
  if (picked === t('provider-opt-edit-models')) return editModelList(deps, provider)
  notify(t('provider-edit-cancelled'))
  return 'cancelled'
}

/** Menu rows for one edit session; base URL / protocol are custom-only.
 *  The catalog split reads the route's real catalog membership — an
 *  explicit `api` override on a built-in route does not make it custom. */
function buildEditMenuOptions(provider: ConfiguredProvider): { label: string; description?: string }[] {
  const isCatalog = provider.isCatalog
  const options: { label: string; description?: string }[] = [
    { label: t('provider-opt-edit-key'),
      ...(provider.shadowed ? { description: t('provider-row-key-shadowed') } : {}) },
  ]
  if (!isCatalog) {
    options.push(
      { label: t('provider-opt-edit-baseurl'), description: provider.baseURL },
      { label: t('provider-opt-edit-protocol'), description: provider.api },
    )
  }
  options.push(
    { label: t('provider-opt-edit-models'),
      description: provider.models !== undefined && provider.models.length > 0
        ? t('provider-row-models', { n: provider.models.length })
        : t('provider-row-catalog') },
    { label: t('provider-opt-edit-delete'), description: t('provider-opt-edit-delete-desc') },
  )
  return options
}

/** Replace the route's API key: prompt, then write the credential at once.
 *  An env-shadowed key cannot be edited from here; an empty answer is a
 *  no-op. The profile already points at the ref, so no profile write. */
async function editApiKey(
  deps: ProviderWizardDeps,
  provider: ConfiguredProvider,
): Promise<ProviderWizardOutcome> {
  const { ask, notify, pushLocal, host } = deps
  if (provider.ref === '') {
    // No apiKeyEnv in the stored profile (externally-edited / legacy route):
    // there is no persisted credential to replace, so a store write under an
    // empty ref would never be read at request time.
    notify(t('provider-key-no-ref', { route: provider.route }), { color: 'warning' })
    return 'cancelled'
  }
  if (provider.shadowed) {
    // The environment provides the key: it cannot be edited from here and
    // a store write would never be read at request time anyway.
    notify(t('provider-key-env-not-editable', { route: provider.route, ref: provider.ref }),
      { color: 'warning' })
    return 'cancelled'
  }
  const keyAnswer = await ask({
    questions: [textQuestion('apikey', t('provider-q-apikey'), t('provider-q-apikey-detail'))],
  }, { redact: true })
  const value = answerText(keyAnswer, 'apikey')
  if (value === '') {
    notify(t('provider-key-empty'), { color: 'warning' })
    return 'cancelled'
  }
  // The ref is only a name: writing it replaces the key for EVERY profile
  // pointing at it (the all-layer census also covers base-inherited routes
  // the editable list never shows). Silently rotating a shared credential
  // would break those routes' auth, so the overwrite needs an explicit
  // opt-in naming the blast radius.
  const otherUsers = host.listRefUsers(provider.ref, provider.route)
  if (otherUsers.length > 0) {
    let overwriteAnswer: AskUserQuestionAnswer
    try {
      overwriteAnswer = await ask({
        questions: [optionQuestion('key-overwrite-confirm',
          t('provider-q-key-overwrite-confirm', { ref: provider.ref }), [
            { label: t('provider-opt-key-overwrite-yes') },
            { label: t('provider-opt-confirm-cancel') },
          ], {
            detail: t('provider-key-overwrite-warning', { routes: otherUsers.join(', ') }),
            hideCustomInput: true,
          })],
      })
    } catch (error) {
      if (error instanceof UserQuestionError) {
        notify(t('provider-edit-cancelled'))
        return 'cancelled'
      }
      throw error
    }
    if (answerSelected(overwriteAnswer, 'key-overwrite-confirm')[0] !== t('provider-opt-key-overwrite-yes')) {
      notify(t('provider-edit-cancelled'))
      return 'cancelled'
    }
  }
  await host.writeCredential(provider.ref, value)
  pushLocal('/provider', buildSummaryLines({
    route: provider.route,
    ref: provider.ref,
    shadowed: provider.shadowed,
    baseURL: provider.baseURL,
    api: provider.api,
    models: provider.models ?? [],
    isCatalog: provider.isCatalog,
    keyLine: t('provider-line-key-updated', { ref: provider.ref }),
  }))
  notify(t('provider-edit-success', { route: provider.route }), { color: 'success' })
  return 'updated'
}

/** Apply a targeted single-field edit as one path patch under the stored
 *  profile: the picked field is set, everything else — modeled or not —
 *  stays exactly as stored. No discovery rewrite: capacity refresh belongs
 *  to the model-list edit, not to a key/endpoint/protocol change. */
async function patchProfileField(
  deps: ProviderWizardDeps,
  provider: ConfiguredProvider,
  path: readonly string[],
  value: unknown,
  /** Summary override for the field that changed; the others as stored. */
  change: { baseURL?: string; api?: string },
): Promise<ProviderWizardOutcome> {
  const { host, notify, pushLocal } = deps
  await host.mutateProfile(provider.route, [{ op: 'set', path, value }])
  pushLocal('/provider', buildSummaryLines({
    route: provider.route,
    ref: provider.ref,
    shadowed: provider.shadowed,
    baseURL: change.baseURL ?? provider.baseURL,
    api: change.api ?? provider.api,
    models: provider.models ?? [],
    isCatalog: provider.isCatalog,
    keyLine: provider.ref !== ''
      ? t('provider-line-key-kept', { ref: provider.ref })
      : t('provider-line-key-none'),
  }))
  notify(t('provider-edit-success', { route: provider.route }), { color: 'success' })
  return 'updated'
}

/** Edit the base URL (custom routes only): prompt the new endpoint, then
 *  patch just that field. An empty answer is a no-op. */
async function editBaseUrl(
  deps: ProviderWizardDeps,
  provider: ConfiguredProvider,
): Promise<ProviderWizardOutcome> {
  const { ask, notify } = deps
  const urlAnswer = await ask({
    questions: [textQuestion('baseurl', t('provider-q-baseurl'),
      provider.baseURL !== undefined
        ? t('provider-edit-current', { value: provider.baseURL })
        : undefined)],
  })
  const value = answerText(urlAnswer, 'baseurl')
  if (value === '') {
    notify(t('provider-edit-no-changes'))
    return 'cancelled'
  }
  return patchProfileField(deps, provider, ['baseURL'], value, { baseURL: value })
}

/** Edit the wire protocol (custom routes only): pick from the three wire
 *  protocols (the current one is default-focused), then patch just that
 *  field. Picking the current protocol is a no-op. */
async function editWireProtocol(
  deps: ProviderWizardDeps,
  provider: ConfiguredProvider,
): Promise<ProviderWizardOutcome> {
  const { ask, notify } = deps
  const current = provider.api ?? 'openai-completions'
  const protocolAnswer = await ask({
    questions: [optionQuestion('protocol', t('provider-q-protocol'), [
      { label: 'openai-completions', description: t('provider-protocol-completions-desc') },
      { label: 'openai-responses', description: t('provider-protocol-responses-desc') },
      { label: 'anthropic-messages', description: t('provider-protocol-anthropic-desc') },
    ], { hideCustomInput: true, defaultSelected: [current] })],
  })
  const picked = answerSelected(protocolAnswer, 'protocol')[0]
  if (picked === undefined || picked === current) {
    notify(t('provider-edit-no-changes'))
    return 'cancelled'
  }
  return patchProfileField(deps, provider, ['api'], picked, { api: picked })
}

/**
 * Re-discover the endpoint's models and pick the enabled set (the current
 * ones pre-checked), then patch just the profile's `models`. Kept models
 * reuse their stored entries, so per-model fields the wizard does not
 * model (`input`, `compat`, …) survive the re-selection. On discovery
 * failure a manual id question is the fallback; an empty result is a no-op
 * for whole-catalog routes and rejected for custom routes.
 */
async function editModelList(
  deps: ProviderWizardDeps,
  provider: ConfiguredProvider,
): Promise<ProviderWizardOutcome> {
  const { host, ask, notify, pushLocal } = deps
  const isCatalog = provider.isCatalog
  const previous = provider.models ?? []
  const key = provider.ref !== ''
    ? (provider.shadowed ? host.envValue(provider.ref) : await host.readCredential(provider.ref))
    : undefined
  notify(t('provider-discovery-running'))
  const discovered = await host.discoverModels({
    ...(isCatalog ? { provider: provider.route } : {}),
    ...(provider.baseURL !== undefined && provider.baseURL !== '' ? { baseURL: provider.baseURL } : {}),
    ...(provider.api !== undefined ? { api: provider.api } : {}),
    apiKey: key ?? '',
  }).catch(() => [])

  let models: string[]
  let discoveredById = new Map<string, LlmDiscoveredModel>()
  if (discovered.length === 0) {
    notify(t('provider-discovery-failed'), { color: 'warning' })
    const fallbackAnswer = await ask({
      questions: [textQuestion('models-fallback', t('provider-q-models-fallback'))],
    })
    models = mergeModelIds([], answerText(fallbackAnswer, 'models-fallback'))
    if (models.length === 0) {
      notify(t('provider-edit-no-changes'))
      return 'cancelled'
    }
  } else {
    discoveredById = new Map(discovered.map(model => [model.id, model] as const))
    // Existing models the endpoint no longer advertises (renamed, beta
    // pulled, transient discovery gap) must still appear in the panel,
    // pre-checked and marked: options built from `discovered` alone would
    // silently drop them on an Enter-through confirm, destroying their
    // stored entries and the unmodeled per-model fields. Only an explicit
    // un-check removes one.
    const optionRows = discovered.map(model => ({
      label: model.id,
      description: [
        model.name ?? '',
        model.contextWindow !== undefined ? `${model.contextWindow}` : '',
      ].filter(part => part !== '').join(' · ') || undefined,
    }))
    const missingRows = previous
      .filter(id => !discoveredById.has(id))
      .map(id => ({
        label: id,
        description: t('provider-row-model-missing'),
      }))
    const modelsAnswer = await ask({
      questions: [optionQuestion('models', t('provider-q-models'),
        [...optionRows, ...missingRows],
        { multiSelect: true, defaultSelected: previous },
      )],
    })
    models = mergeModelIds(
      answerSelected(modelsAnswer, 'models'),
      answerText(modelsAnswer, 'models'),
    )
  }

  if (!isCatalog && models.length === 0) {
    // A manual route without models fails the adapter validation.
    notify(t('provider-models-required'), { color: 'error' })
    return 'cancelled'
  }
  if (sameModels(models, previous)) {
    notify(t('provider-edit-no-changes'))
    return 'cancelled'
  }
  // The new `models` value: a kept id re-enters its stored entry verbatim;
  // a newly enabled one is built from the discovery row (plain `{id}` on a
  // catalog route, where the catalog itself carries the capabilities).
  const storedById = new Map((provider.modelEntries ?? [])
    .flatMap(entry => typeof entry['id'] === 'string' ? [[entry['id'], entry] as const] : []))
  const modelsValue = models.map(id => {
    const stored = storedById.get(id)
    if (stored !== undefined) return stored
    const discovered = discoveredById.get(id)
    return {
      id,
      ...(isCatalog || discovered === undefined ? {} : {
        ...(discovered.contextWindow !== undefined
          ? { contextWindow: discovered.contextWindow }
          : {}),
        ...(discovered.maxTokens !== undefined
          ? { maxTokens: discovered.maxTokens }
          : {}),
      }),
    }
  })
  await host.mutateProfile(provider.route, [
    { op: 'set', path: ['models'], value: modelsValue },
  ])
  pushLocal('/provider', buildSummaryLines({
    route: provider.route,
    ref: provider.ref,
    shadowed: provider.shadowed,
    baseURL: provider.baseURL,
    api: provider.api,
    models,
    isCatalog,
    keyLine: provider.ref !== ''
      ? t('provider-line-key-kept', { ref: provider.ref })
      : t('provider-line-key-none'),
  }))
  notify(t('provider-edit-success', { route: provider.route }), { color: 'success' })
  return 'updated'
}

/** Whether two model lists are equal (undefined = the whole catalog = []). */
function sameModels(a: readonly string[], b: readonly string[] | undefined): boolean {
  if (b === undefined) return a.length === 0
  return a.length === b.length && b.every(id => a.includes(id))
}

/**
 * Delete one configured route from inside the edit menu: confirm against a
 * summary, then unset the profile. The credential goes afterwards, as pure
 * best-effort cleanup — only when it is this route's own (not env-provided,
 * not shared with another profile). Unsetting the profile is the catalog
 * change: once it landed, every cleanup path still reports 'deleted' (with
 * an honest transcript line for what survived), so a failed key removal
 * never leaves the UI serving a stale model completion for a route that is
 * already gone. `failed` is reserved for the profile unset itself failing,
 * which really did change nothing.
 */
async function deleteConfiguredProvider(
  deps: ProviderWizardDeps,
  provider: ConfiguredProvider,
): Promise<ProviderWizardOutcome> {
  const { host, ask, notify, pushLocal } = deps
  // A credential ref is only a name — several routes may share it, possibly
  // at settings layers the editable list never shows (a base-inherited
  // provider, or a consumer like the balance probe that resolves the ref
  // without any profile). The all-layer ref query is the only sound sharer
  // census: removing the key together with this route would silently break
  // every remaining consumer, so a shared key is kept — the confirm detail
  // says so up front and the transcript repeats it.
  const sharers = provider.ref === ''
    ? []
    : host.listRefUsers(provider.ref, provider.route)
  const lines = buildDeleteSummary(provider)
  let confirmAnswer: AskUserQuestionAnswer
  try {
    confirmAnswer = await ask({
      questions: [optionQuestion('delete-confirm', t('provider-q-delete-confirm', { route: provider.route }), [
        { label: t('provider-opt-delete-yes') },
        { label: t('provider-opt-confirm-cancel') },
      ], {
        detail: sharers.length > 0
          ? `${lines.join('\n')}\n${t('provider-delete-shared-warning', { ref: provider.ref, routes: sharers.join(', ') })}`
          : lines.join('\n'),
        hideCustomInput: true,
      })],
    })
  } catch (error) {
    if (error instanceof UserQuestionError) {
      notify(t('provider-delete-cancelled'))
      return 'cancelled'
    }
    throw error
  }
  if (answerSelected(confirmAnswer, 'delete-confirm')[0] !== t('provider-opt-delete-yes')) {
    notify(t('provider-delete-cancelled'))
    return 'cancelled'
  }

  try {
    await host.removeProfile(provider.route)
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error)
    notify(t('provider-delete-failed', { err }), { color: 'error', timeoutMs: 8000 })
    return 'failed'
  }

  // The catalog changed from here on: report 'deleted' whatever the
  // credential cleanup below does, so the caller invalidates completions.
  const pushedLines = [...lines]
  let keyCleanupFailed = false
  if (provider.ref !== '') {
    if (provider.shadowed) {
      pushedLines.push(t('provider-line-deleted-key-shadowed', { ref: provider.ref }))
    } else if (isReservedCredentialRef(provider.ref)) {
      // Host-owned credential namespace (the harness's own main key lives
      // here): never removed as a side effect of deleting a route.
      pushedLines.push(t('provider-line-deleted-key-reserved', { ref: provider.ref }))
    } else {
      // Reference re-check AFTER the profile unset, not the pre-confirm
      // census: the store may have gained or lost users while the confirm
      // was up (and a route whose user-layer override was just cleared can
      // re-inherit a base profile still pointing at the ref). The route is
      // gone from the merged section, so no exclusion is needed — any hit
      // here is a live consumer. When the running settings layer cannot
      // answer the query at all, treat the ref as shared and keep it: an
      // unremovable key is recoverable, a destroyed one is not.
      let remaining: readonly string[]
      try {
        remaining = host.listRefUsers(provider.ref)
      } catch {
        remaining = [t('provider-unknown-ref-users')]
      }
      if (remaining.length > 0) {
        pushedLines.push(t('provider-line-deleted-key-shared',
          { ref: provider.ref, routes: remaining.join(', ') }))
      } else {
        try {
          await host.removeCredential(provider.ref)
          pushedLines.push(t('provider-line-deleted-key', { ref: provider.ref }))
        } catch {
          keyCleanupFailed = true
          pushedLines.push(t('provider-line-deleted-key-cleanup-failed', { ref: provider.ref }))
        }
      }
    }
  }
  pushLocal('/provider', pushedLines)
  if (keyCleanupFailed) {
    notify(t('provider-delete-key-cleanup-failed', { route: provider.route, ref: provider.ref }),
      { color: 'warning', timeoutMs: 8000 })
  } else {
    notify(t('provider-delete-success', { route: provider.route }), { color: 'success' })
  }
  return 'deleted'
}

/** Short picker-row description for one configured provider. */
function providerRowDescription(provider: ConfiguredProvider): string {
  const parts: string[] = []
  if (provider.baseURL !== undefined) parts.push(provider.baseURL)
  parts.push(provider.models !== undefined && provider.models.length > 0
    ? t('provider-row-models', { n: provider.models.length })
    : t('provider-row-catalog'))
  if (provider.shadowed) parts.push(t('provider-row-key-shadowed'))
  return parts.join(' · ')
}

/** Confirm-summary lines for the delete branch (reuses the shared keyref
 *  and models lines; no credential values are ever rendered). */
function buildDeleteSummary(provider: ConfiguredProvider): string[] {
  const lines = [t('provider-line-route', { route: provider.route })]
  if (provider.baseURL !== undefined) lines.push(t('provider-line-baseurl', { url: provider.baseURL }))
  if (provider.api !== undefined) lines.push(t('provider-line-protocol', { api: provider.api }))
  lines.push(provider.models !== undefined && provider.models.length > 0
    ? t('provider-line-models', { models: provider.models.join(', ') })
    : t('provider-line-models-catalog'))
  if (provider.ref !== '') {
    lines.push(provider.shadowed
      ? t('provider-line-keyref-env', { ref: provider.ref })
      : t('provider-line-keyref', { ref: provider.ref }))
  }
  return lines
}

/** Masked state line for one provider row in the OAuth pick question. */
function oauthStateDescription(status: OAuthProviderStatus): string {
  if (status.signedIn) {
    return t('provider-oauth-state-in', { time: new Date(status.expiresAt ?? 0).toISOString() })
  }
  return status.expired
    ? t('provider-oauth-state-expired')
    : (status.loginLabel ?? status.oauthLabel)
}

/**
 * The OAuth branch of `/provider`: pick a subscription provider, then sign
 * in (the plugin's own question panels carry the flow — device codes,
 * authorization URLs), or re-login / sign out when one is already signed in.
 * No settings or credential writes happen here; the plugin owns its store.
 */
async function runOAuthWizard(
  deps: ProviderWizardDeps,
  oauth: OAuthSetupHost,
): Promise<ProviderWizardOutcome> {
  const { ask, notify, pushLocal } = deps
  try {
    const statuses = await oauth.providers()
    if (statuses.length === 0) {
      notify(t('provider-oauth-none'), { color: 'warning' })
      return 'failed'
    }
    const pickAnswer = await ask({
      questions: [optionQuestion('oauth-provider', t('provider-q-oauth'), statuses.map(status => ({
        label: status.provider,
        description: oauthStateDescription(status),
      })), { hideCustomInput: true })],
    })
    const providerId = answerSelected(pickAnswer, 'oauth-provider')[0]
    const status = statuses.find(row => row.provider === providerId)
    if (status === undefined) return 'cancelled'

    if (status.signedIn) {
      const actionAnswer = await ask({
        questions: [optionQuestion('oauth-signed-action', t('provider-q-oauth-signed', { provider: status.provider }), [
          { label: t('provider-opt-oauth-relogin'), description: t('provider-opt-oauth-relogin-desc') },
          { label: t('provider-opt-oauth-logout'), description: t('provider-opt-oauth-logout-desc') },
          { label: t('provider-opt-confirm-cancel') },
        ], { hideCustomInput: true })],
      })
      const action = answerSelected(actionAnswer, 'oauth-signed-action')[0]
      if (action === t('provider-opt-oauth-logout')) {
        await oauth.logout(status.provider)
        pushLocal('/provider', [
          t('provider-line-oauth-provider', { provider: status.provider }),
          t('provider-line-oauth-out'),
        ])
        notify(t('provider-oauth-logout-ok', { provider: status.provider }), { color: 'success' })
        return 'signed-out'
      }
      if (action !== t('provider-opt-oauth-relogin')) return 'cancelled'
    }

    const result = await oauth.login(status.provider)
    pushLocal('/provider', [
      t('provider-line-oauth-provider', { provider: result.provider }),
      t('provider-line-oauth-flow', { flow: result.oauthLabel }),
      t('provider-line-oauth-expires', { time: new Date(result.expiresAt).toISOString() }),
      t('provider-switch-hint'),
    ])
    notify(t('provider-oauth-login-ok', { provider: result.provider }), { color: 'success' })
    return 'added'
  } catch (error) {
    if (error instanceof UserQuestionError) {
      notify(t('provider-cancelled'))
      return 'cancelled'
    }
    const err = error instanceof Error ? error.message : String(error)
    notify(t('provider-oauth-login-failed', { err }), { color: 'error', timeoutMs: 8000 })
    return 'failed'
  }
}

/** Prompt for a route id until it validates or the retry budget runs out. */
async function promptRouteId(
  ask: ProviderWizardDeps['ask'],
  notify: ProviderWizardDeps['notify'],
): Promise<string> {
  for (let attempt = 0; attempt < MAX_RETRY; attempt += 1) {
    const answer = await ask({
      questions: [textQuestion('route-id', t('provider-q-route-id'), t('provider-q-route-id-detail'))],
    })
    const route = answerText(answer, 'route-id')
    if (PROVIDER_ROUTE_ID.test(route)) return route
    notify(t('provider-route-id-invalid'), { color: 'warning' })
  }
  return ''
}

/** Merge multi-select picks with comma/space-separated custom input, deduped. */
function mergeModelIds(selected: readonly string[], custom: string): string[] {
  const ids = [...selected]
  for (const piece of custom.split(/[,，\s]+/)) {
    const id = piece.trim()
    if (id !== '' && !ids.includes(id)) ids.push(id)
  }
  return ids
}

function buildSummaryLines(input: {
  route: string
  ref: string
  shadowed: boolean
  baseURL: string | undefined
  api: string | undefined
  models: readonly string[]
  isCatalog: boolean
  /** Key line override (kept / updated / env); add mode derives it. */
  keyLine?: string
}): string[] {
  const lines = [t('provider-line-route', { route: input.route })]
  lines.push(input.keyLine ?? (input.shadowed
    ? t('provider-line-keyref-env', { ref: input.ref })
    : t('provider-line-keyref', { ref: input.ref })))
  if (input.baseURL !== undefined && input.baseURL !== '') {
    lines.push(t('provider-line-baseurl', { url: input.baseURL }))
  }
  if (input.api !== undefined) lines.push(t('provider-line-protocol', { api: input.api }))
  lines.push(input.models.length > 0
    ? t('provider-line-models', { models: input.models.join(', ') })
    : t('provider-line-models-catalog'))
  return lines
}

function buildProfile(input: {
  isCatalog: boolean
  ref: string
  baseURL: string | undefined
  api: string | undefined
  models: readonly string[]
  discoveredById: ReadonlyMap<string, LlmDiscoveredModel>
}): Record<string, unknown> {
  const profile: Record<string, unknown> = {}
  // Preserve the profile's credential shape: an empty ref (no apiKeyEnv)
  // must not be rewritten as `apiKeyEnv: ''`.
  if (input.ref !== '') profile['apiKeyEnv'] = input.ref
  if (input.baseURL !== undefined && input.baseURL !== '') profile['baseURL'] = input.baseURL
  if (input.isCatalog) {
    // `models` replaces the catalog when present; omit it to keep the whole
    // catalog served.
    if (input.models.length > 0) {
      profile['models'] = input.models.map(id => ({ id }))
    }
    return profile
  }
  profile['api'] = input.api
  profile['models'] = input.models.map(id => {
    const discovered = input.discoveredById.get(id)
    return {
      id,
      ...(discovered?.contextWindow !== undefined
        ? { contextWindow: discovered.contextWindow }
        : {}),
      ...(discovered?.maxTokens !== undefined
        ? { maxTokens: discovered.maxTokens }
        : {}),
    }
  })
  return profile
}
