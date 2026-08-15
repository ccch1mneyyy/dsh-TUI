/**
 * `/provider` wizard — interactively adds an LLM provider route at runtime.
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
 * Runtime capabilities the wizard needs, implemented by the channel over
 * `ctx.settings` / `ctx.credentials` / `ctx.llm`. `undefined` from
 * `channel.providerSetup()` means the bare cordis.yml start (no dsh-base
 * services) and the command refuses to run.
 */
export interface ProviderSetupHost {
  /** Catalog routes activatable via the `llm-pi-ai` settings section. */
  listCatalogProviders(): readonly CatalogProviderCandidate[]
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
   * rejects when the adapter's validation deems it unserviceable.
   */
  writeProfile(route: string, profile: Record<string, unknown>): Promise<void>
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

export type ProviderWizardOutcome = 'added' | 'cancelled' | 'failed'

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
 * pure option questions hide the trailing free-text input row. Structurally
 * assigned into the dsh request type; the harness side never sets it, so
 * model-facing asks keep the input row.
 */
type WizardQuestionItem = AskUserQuestionItem & { hideCustomInput?: boolean }

function optionQuestion(
  id: string,
  question: string,
  options: readonly { label: string; description?: string }[],
  extra?: { detail?: string; multiSelect?: boolean; hideCustomInput?: boolean },
): AskUserQuestionItem {
  const item: WizardQuestionItem = {
    id,
    question,
    header: '/provider',
    options: options.map(option => ({ ...option })),
    ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
    ...(extra?.multiSelect ? { multiSelect: true } : {}),
    ...(extra?.hideCustomInput ? { hideCustomInput: true } : {}),
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
 * Run the add-provider wizard. Resolves 'cancelled' when the user dismisses
 * any question (Esc) — nothing has been written at that point by design:
 * all asks complete before the first side effect.
 */
export async function runProviderWizard(
  deps: ProviderWizardDeps,
): Promise<ProviderWizardOutcome> {
  const { host, ask, notify, pushLocal } = deps
  try {
    // ── 1. mode ────────────────────────────────────────────────────────
    const modeAnswer = await ask({
      questions: [optionQuestion('mode', t('provider-q-mode'), [
        { label: t('provider-opt-catalog'), description: t('provider-opt-catalog-desc') },
        { label: t('provider-opt-custom'), description: t('provider-opt-custom-desc') },
      ], { hideCustomInput: true })],
    })
    const isCatalog = answerSelected(modeAnswer, 'mode')[0] === t('provider-opt-catalog')

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
              description: candidate.displayName,
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
    const keyAnswer = await ask({
      questions: [textQuestion('apikey', t('provider-q-apikey'), t('provider-q-apikey-detail'))],
    }, { redact: true })
    const apiKey = answerText(keyAnswer, 'apikey')

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
      apiKey,
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
    const ref = deriveKeyRef(route)
    const shadowed = host.envShadows(ref)
    const summaryLines = buildSummaryLines({
      route, ref, shadowed, baseURL, api, models, isCatalog,
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
    if (!shadowed) {
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
  } catch (error) {
    if (error instanceof UserQuestionError) {
      notify(t('provider-cancelled'))
      return 'cancelled'
    }
    const err = error instanceof Error ? error.message : String(error)
    notify(t('provider-write-failed', { err }), { color: 'error', timeoutMs: 8000 })
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
}): string[] {
  const lines = [t('provider-line-route', { route: input.route })]
  lines.push(input.shadowed
    ? t('provider-line-keyref-env', { ref: input.ref })
    : t('provider-line-keyref', { ref: input.ref }))
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
  const profile: Record<string, unknown> = { apiKeyEnv: input.ref }
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
