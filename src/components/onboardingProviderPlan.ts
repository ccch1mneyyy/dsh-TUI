/**
 * Pure derivation for the first-run guide's "accounts and models" step: what
 * a sign-in or a provider write actually produced, and what that means for
 * the default model.
 *
 * The guide's first step used to be a read-only credential check, which left
 * the user with an environment variable and no action. The configuration
 * surfaces already exist (`/provider`, `dsh-auth`'s subscription sign-in);
 * what was missing is the piece that catches their RESULT. That result is
 * observable: `dsh-auth`'s catalog is credential-gated
 * (`dsh-adapter/oauth/index.ts`, `CredentialGatedAdapter`), so a provider
 * with no stored credential lists no models — the moment a sign-in or key
 * write lands, its models appear in `channel.listModels()`.
 *
 * Everything here is a pure function of two catalog snapshots, so the
 * three-way decision the product wants — nothing new, exactly one model, or
 * several — is pinned by `scripts/verify-onboarding-provider-plan.ts` without
 * a terminal, a channel, or a credential store.
 *
 * @module dsh-tui/components/onboardingProviderPlan
 */
import type { LlmModelInfo } from '../adapter/ports/channel-view.js'

/** One model row, reduced to the identity the diff and the pickers need. */
export interface ProviderModelRef {
  readonly provider: string
  readonly id: string
  /** Display name; falls back to the id at the call site, never here. */
  readonly name: string
}

/**
 * What the adopter should do with the models that just appeared.
 *
 *   - `none` — nothing new; the caller only reports the action's outcome.
 *   - `auto` — exactly one new model; it becomes the default without asking
 *     (the product rule: one candidate needs no question).
 *   - `ask`  — several; the caller asks which to adopt and which is default.
 */
export type AdoptionDecision = 'none' | 'auto' | 'ask'

/** The adoption plan for one action's catalog delta. */
export interface AdoptionPlan {
  /**
   * The provider this batch belongs to: the explicit filter when the caller
   * knows what it acted on, else the first provider with new models. Absent
   * only when nothing was added.
   */
  readonly provider: string | undefined
  /** New models, current-catalog order, deduped by provider/id. */
  readonly added: readonly ProviderModelRef[]
  /** True when `added` spans more than one provider (copy needs the plural). */
  readonly multiProvider: boolean
  readonly decision: AdoptionDecision
  /**
   * The preselection for the `ask` branch: the live route when it is among
   * the new models (a re-login of the provider already in use must not move
   * the cursor), else the first added model. `undefined` for `none`.
   */
  readonly defaultPick: ProviderModelRef | undefined
}

/** Stable identity of one catalog row across snapshots. */
export function modelRefKey(ref: ProviderModelRef): string {
  return `${ref.provider}/${ref.id}`
}

/**
 * Reduce a channel catalog to the diffable rows.
 *
 * @param models - `channel.listModels()` result (advisory order preserved).
 * @returns One row per model, in the order the catalog listed them.
 */
export function modelRefsOf(models: readonly LlmModelInfo[]): readonly ProviderModelRef[] {
  return models.map(model => ({ provider: model.provider, id: model.id, name: model.name }))
}

/**
 * Models present now and absent from the baseline.
 *
 * @param baseline - Catalog snapshot taken BEFORE the action.
 * @param current - Catalog snapshot taken after it.
 * @param provider - Optional filter (the provider the action touched).
 * @returns New rows in `current` order, deduped by provider/id.
 */
export function addedModelRefs(
  baseline: readonly ProviderModelRef[],
  current: readonly ProviderModelRef[],
  provider?: string,
): readonly ProviderModelRef[] {
  const seen = new Set(baseline.map(modelRefKey))
  const added: ProviderModelRef[] = []
  for (const row of current) {
    if (provider !== undefined && row.provider !== provider) continue
    const key = modelRefKey(row)
    if (seen.has(key)) continue
    seen.add(key)
    added.push(row)
  }
  return added
}

/**
 * The whole step-1 decision in one call.
 *
 * Repeated calls with the same baseline are idempotent (`added` is a set
 * difference), which is what lets a remount after a question panel re-run the
 * same plan without asking about the same models twice — the baseline lives
 * in `src/onboardingDraft.ts`, not in React state, exactly for that remount.
 *
 * @param input - Baseline and current catalogs, optional provider filter and
 *   the live route used to preselect the `ask` branch.
 * @returns The plan described by {@link AdoptionPlan}.
 */
export function planModelAdoption(input: {
  readonly baseline: readonly ProviderModelRef[]
  readonly current: readonly ProviderModelRef[]
  readonly provider?: string | undefined
  readonly currentRoute?: { readonly provider: string; readonly id: string } | undefined
}): AdoptionPlan {
  const added = addedModelRefs(input.baseline, input.current, input.provider)
  const providers = new Set(added.map(row => row.provider))
  const provider = input.provider
    ?? (added[0] === undefined ? undefined : added[0].provider)
  const live = input.currentRoute === undefined
    ? undefined
    : added.find(row => row.provider === input.currentRoute!.provider && row.id === input.currentRoute!.id)
  return {
    provider,
    added,
    multiProvider: providers.size > 1,
    decision: added.length === 0 ? 'none' : added.length === 1 ? 'auto' : 'ask',
    defaultPick: added.length === 0 ? undefined : live ?? added[0],
  }
}

/**
 * Provider ids in first-appearance order — the group order for the adoption
 * layer, so a batch is presented in the order the catalog produced it rather
 * than in a second, arbitrary sort.
 *
 * @param added - The plan's `added` rows.
 * @returns Distinct provider ids.
 */
export function addedProviderOrder(added: readonly ProviderModelRef[]): readonly string[] {
  const order: string[] = []
  for (const row of added) if (!order.includes(row.provider)) order.push(row.provider)
  return order
}

/**
 * Toggle one row in a selection set, returning a new set (React state safe).
 *
 * @param selected - Current selection (model ref keys).
 * @param key - Row key to flip.
 * @returns A new set with the row toggled.
 */
export function toggleModelRef(
  selected: ReadonlySet<string>,
  key: string,
): ReadonlySet<string> {
  const next = new Set(selected)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

/**
 * The selection a fresh `ask` branch starts from: every added model is
 * adopted unless the user unchecks it (the question is "add these?", so the
 * default answer is yes).
 *
 * @param added - The plan's `added` rows.
 * @returns Their keys.
 */
export function defaultSelection(added: readonly ProviderModelRef[]): ReadonlySet<string> {
  return new Set(added.map(modelRefKey))
}

/**
 * The models a selection resolves to, in catalog order; an empty selection
 * stays empty (the caller decides whether that means "skip").
 *
 * @param added - The plan's `added` rows.
 * @param selected - Selected keys.
 * @returns Selected rows in `added` order.
 */
export function selectedModelRefs(
  added: readonly ProviderModelRef[],
  selected: ReadonlySet<string>,
): readonly ProviderModelRef[] {
  return added.filter(row => selected.has(modelRefKey(row)))
}

/**
 * The default to apply for a resolved selection: the plan's preselection when
 * it survived the multi-select, else the first selected row. Keeping the
 * preselection stable is what stops "adopt several, keep the current route"
 * from silently changing the default.
 *
 * @param picked - Selected rows (catalog order).
 * @param preferred - The plan's `defaultPick`.
 * @returns The row to make default, or undefined when nothing is selected.
 */
export function resolveDefaultPick(
  picked: readonly ProviderModelRef[],
  preferred: ProviderModelRef | undefined,
): ProviderModelRef | undefined {
  if (preferred !== undefined && picked.some(row => modelRefKey(row) === modelRefKey(preferred))) {
    return preferred
  }
  return picked[0]
}
