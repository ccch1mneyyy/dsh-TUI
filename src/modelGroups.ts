/**
 * Pure derivation for the two-level `/model` picker: providers as top-level
 * groups, their models one level down, with a pinned "recently used"
 * pseudo-group first. Kept free of React/channel/i18n state so
 * `scripts/verify-model-picker-groups.mjs` can drive it headless; the
 * recents row's localized label is resolved at render time (its `label`
 * field is the {@link RECENTS_LABEL_PLACEHOLDER} sentinel).
 *
 * @module dsh-tui/modelGroups
 */

import type { LlmModelInfo, LlmProviderInfo } from './dsh-adapter/types.js'

/**
 * The pseudo provider key of the pinned "recently used" group. Provider
 * route ids cannot contain underscores (`PROVIDER_ROUTE_ID`), so this can
 * never collide with a real route.
 */
export const RECENTS_GROUP_PROVIDER = '__recents__'

/** The recents row's raw label; renderers replace it with the localized one. */
export const RECENTS_LABEL_PLACEHOLDER = '__recent__'

/** One recent-model reference (same shape as modelRecents' persisted ref). */
export interface ModelRef {
  readonly provider: string
  readonly id: string
}

/** One top-level row: a provider route with its picker-facing identity. */
export interface ModelGroupRow {
  /** Harness route key (also the grouping key over `LlmModelInfo.provider`). */
  readonly provider: string
  /** Display label — the registry's provider name, falling back to the route key. */
  readonly label: string
  /** How many of the listed models belong to this provider. */
  readonly count: number
}

/**
 * The recent refs that the current catalog still lists, most-recent-first —
 * the second level of the recents group. Refs whose model vanished from the
 * catalog (provider removed, or an OAuth provider signed out and
 * credential-gated away) drop out here, so the group never offers a row the
 * picker could not switch to.
 */
export function recentCatalogModels(
  recents: readonly ModelRef[],
  models: readonly LlmModelInfo[],
): readonly LlmModelInfo[] {
  const listed: LlmModelInfo[] = []
  for (const ref of recents) {
    const found = models.find(model => model.provider === ref.provider && model.id === ref.id)
    if (found === undefined) continue
    if (listed.some(seen => seen.provider === found.provider && seen.id === found.id)) continue
    listed.push(found)
    if (listed.length >= 10) break
  }
  return listed
}

/**
 * Group a flat model catalog into provider rows, first-appearance order
 * (the registry's own listing order), labels resolved through
 * `providerInfos` with a route-key fallback. Recent refs (when supplied and
 * still catalogued) pin one extra pseudo-group at the top.
 */
export function deriveModelGroups(
  models: readonly LlmModelInfo[],
  providerInfos: readonly LlmProviderInfo[],
  recents?: readonly ModelRef[],
): readonly ModelGroupRow[] {
  const order: string[] = []
  const counts = new Map<string, number>()
  for (const model of models) {
    if (!counts.has(model.provider)) {
      order.push(model.provider)
      counts.set(model.provider, 0)
    }
    counts.set(model.provider, counts.get(model.provider)! + 1)
  }
  const groups: ModelGroupRow[] = order.map(provider => ({
    provider,
    label: providerInfos.find(info => info.id === provider)?.name ?? provider,
    count: counts.get(provider)!,
  }))
  if (recents !== undefined) {
    const recentCount = recentCatalogModels(recents, models).length
    if (recentCount > 0) {
      groups.unshift({ provider: RECENTS_GROUP_PROVIDER, label: RECENTS_LABEL_PLACEHOLDER, count: recentCount })
    }
  }
  return groups
}

/** Where `/model` should open (or re-land after the fresh catalog arrives). */
export interface ModelPickerLanding {
  /**
   * The group to open *inside* — set only by the single-provider fast path,
   * where a one-row top level would be pure friction (and there are no
   * recents to pin). Multi-provider catalogs — and any catalog with recents
   * — land at the top level (`undefined`).
   */
  readonly group: string | undefined
  /** Focus index within the landed level's rows. */
  readonly index: number
}

/**
 * Compute the picker's landing: with a meaningful recents list pinned, focus
 * the recents row itself (its first entry is the most recently used model —
 * the likeliest destination); without recents, focus the current provider's
 * group. The single-provider fast path applies while recents carry no
 * navigation value — an empty list, or a lone entry that can only be the
 * current model (the picker seeds it): drilling straight into the only
 * provider's list beats a top level whose recents row duplicates it. Two or
 * more recents (or any multi-provider catalog) land at the top level.
 */
export function modelPickerLanding(
  models: readonly LlmModelInfo[],
  currentProvider: string | undefined,
  currentModel: string | undefined,
  recents?: readonly ModelRef[],
): ModelPickerLanding {
  const providers: string[] = []
  for (const model of models) {
    if (!providers.includes(model.provider)) providers.push(model.provider)
  }
  if (providers.length === 0) return { group: undefined, index: 0 }
  const recentCount = recents === undefined ? 0 : recentCatalogModels(recents, models).length
  if (providers.length === 1 && recentCount <= 1) {
    const only = providers[0]!
    const index = models.findIndex(
      model => model.provider === currentProvider && model.id === currentModel,
    )
    return { group: only, index: index >= 0 ? index : 0 }
  }
  if (recentCount > 0) return { group: undefined, index: 0 }
  const groupIndex = providers.indexOf(currentProvider ?? '')
  return { group: undefined, index: groupIndex >= 0 ? groupIndex : 0 }
}
