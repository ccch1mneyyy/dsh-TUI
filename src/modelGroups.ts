/**
 * Pure derivation for the `/model` provider tabs, with a pinned
 * "recently used" pseudo-provider first. Kept free of React/channel/i18n state so
 * `scripts/verify-model-picker-groups.mjs` can drive it headless; the
 * recents row's localized label is resolved at render time (its `label`
 * field is the {@link RECENTS_LABEL_PLACEHOLDER} sentinel).
 *
 * @module dsh-tui/modelGroups
 */

import type { LlmModelInfo, LlmProviderInfo } from './adapter/ports/channel-view.js'

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

/** One provider tab with its picker-facing identity. */
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
 * the model list of the recents tab. Refs whose model vanished from the
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
 * `providerInfos` with a route-key fallback. Supplying recent refs pins an
 * extra pseudo-group at the top, including an empty tab.
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
    groups.unshift({ provider: RECENTS_GROUP_PROVIDER, label: RECENTS_LABEL_PLACEHOLDER, count: recentCount })
  }
  return groups
}

/** Where `/model` should open. */
export interface ModelPickerLanding {
  /** Active provider tab; undefined only for an empty catalog without recents. */
  readonly group: string | undefined
  /** Focus index within that tab's model list. */
  readonly index: number
}

/**
 * Open on the first recent model when the recents tab is present. Otherwise
 * open the current provider and focus its current model, falling back to the
 * first provider/model when the current route is absent.
 */
export function modelPickerLanding(
  models: readonly LlmModelInfo[],
  currentProvider: string | undefined,
  currentModel: string | undefined,
  recents?: readonly ModelRef[],
): ModelPickerLanding {
  if (recents !== undefined) return { group: RECENTS_GROUP_PROVIDER, index: 0 }
  const providers: string[] = []
  for (const model of models) {
    if (!providers.includes(model.provider)) providers.push(model.provider)
  }
  if (providers.length === 0) return { group: undefined, index: 0 }
  const group = providers.includes(currentProvider ?? '') ? currentProvider! : providers[0]!
  const index = models.filter(model => model.provider === group).findIndex(model => model.id === currentModel && model.provider === currentProvider)
  return { group, index: Math.max(0, index) }
}
