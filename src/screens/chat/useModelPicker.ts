import React from 'react'
import type { ChannelUi } from '../../adapter/ports/channel-ui.js'
import type { LlmModelInfo, LlmProviderInfo } from '../../adapter/ports/channel-view.js'
import { deriveModelGroups, modelPickerLanding, recentCatalogModels, RECENTS_GROUP_PROVIDER, type ModelRef } from '../../modelGroups.js'
import type { Key } from '../../ui.js'
import { wrapIndex } from '../chatOverlay.js'

type EffortCatalog = Awaited<ReturnType<ChannelUi['listEfforts']>>
type Cursor = { provider: string; index: number }
const modelKey = (model: LlmModelInfo): string => `${model.provider}/${model.id}`

/** Provider/model navigation and per-model effort drafts for the single-page picker. */
export function useModelPicker({ channel, models, providers, recents, open, onPick, onCancel }: {
  channel: ChannelUi
  models: readonly LlmModelInfo[]
  providers: readonly LlmProviderInfo[]
  /** Omitted for a backend-owned flat catalog without provider tabs. */
  recents?: readonly ModelRef[]
  open: boolean
  onPick(model: LlmModelInfo, effort: string | undefined): void
  onCancel(): void
}) {
  const providerTabs = recents !== undefined
  const groups = React.useMemo(() => providerTabs ? deriveModelGroups(models, providers, recents) : [], [models, providers, recents, providerTabs])
  const [cursor, setCursor] = React.useState<Cursor>({ provider: providerTabs ? RECENTS_GROUP_PROVIDER : channel.provider, index: providerTabs ? 0 : -1 })
  const cursorRef = React.useRef(cursor)
  const activeRef = React.useRef(open)
  const tabFocus = React.useRef(new Map<string, number>())
  const [drafts, setDrafts] = React.useState(new Map<string, string>())
  const draftsRef = React.useRef(drafts)
  const [catalogs, setCatalogs] = React.useState(new Map<string, EffortCatalog | 'error'>())

  const modelsFor = (provider: string): readonly LlmModelInfo[] => recents === undefined ? models : provider === RECENTS_GROUP_PROVIDER
    ? recentCatalogModels(recents, models)
    : models.filter(model => model.provider === provider)
  const normalize = (value: Cursor): Cursor => {
    const provider = !providerTabs ? channel.provider : groups.some(group => group.provider === value.provider) ? value.provider : RECENTS_GROUP_PROVIDER
    const list = modelsFor(provider)
    // A flat catalog's initial focus follows the live model when its async
    // list arrives. Explicit navigation replaces the -1 sentinel.
    const index = !providerTabs && value.index < 0
      ? list.findIndex(model => model.provider === channel.provider && model.id === channel.model)
      : value.index
    return { provider, index: Math.max(0, Math.min(index, list.length - 1)) }
  }
  const selected = normalize(cursor)
  const provider = selected.provider
  const listed = React.useMemo(() => modelsFor(provider), [provider, models, recents])
  const focused = listed[selected.index]
  const focusedKey = focused === undefined ? undefined : modelKey(focused)
  const catalog = focusedKey === undefined ? undefined : catalogs.get(focusedKey)

  // The ref advances synchronously so Tab/arrow/Enter in one stdin batch
  // operate on the newly focused row, before React commits another frame.
  React.useLayoutEffect(() => {
    cursorRef.current = selected
    activeRef.current = open
  })
  const focus = (next: Cursor): void => {
    const value = normalize(next)
    cursorRef.current = value
    tabFocus.current.set(value.provider, value.index)
    setCursor(value)
  }
  const reset = (): void => {
    const landing = modelPickerLanding(models, channel.provider, channel.model, recents)
    activeRef.current = true
    tabFocus.current.clear()
    const initial = providerTabs ? { provider: landing.group ?? RECENTS_GROUP_PROVIDER, index: landing.index }
      : { provider: channel.provider, index: -1 }
    cursorRef.current = initial
    setCursor(initial)
    draftsRef.current = new Map()
    setDrafts(draftsRef.current)
    setCatalogs(new Map())
  }
  React.useEffect(() => {
    if (!open || focused === undefined || catalog !== undefined) return
    let current = true
    const key = modelKey(focused)
    void Promise.resolve().then(() => channel.listEfforts({ provider: focused.provider, model: focused.id })).then(result => {
      if (current) setCatalogs(previous => new Map(previous).set(key, result))
    }).catch(() => {
      if (current) setCatalogs(previous => new Map(previous).set(key, 'error'))
    })
    return () => { current = false }
  }, [open, channel, focusedKey, catalog])

  const effortFor = (model: LlmModelInfo, result: EffortCatalog | 'error' | undefined): string | undefined => {
    if (result === undefined || result === 'error') return undefined
    const draft = draftsRef.current.get(modelKey(model))
    const value = draft ?? (model.provider === channel.provider && model.id === channel.model
      ? channel.reasoningEffort ?? result.defaultEffort : result.defaultEffort)
    return result.efforts.some(effort => effort.id === value) ? value : undefined
  }
  const focusProvider = (provider: string): void => {
    if (!groups.some(group => group.provider === provider)) return
    const current = normalize(cursorRef.current)
    tabFocus.current.set(current.provider, current.index)
    const list = modelsFor(provider)
    const initial = provider === RECENTS_GROUP_PROVIDER ? 0
      : Math.max(0, list.findIndex(model => model.provider === channel.provider && model.id === channel.model))
    focus({ provider, index: tabFocus.current.get(provider) ?? initial })
  }
  const moveModel = (delta: 1 | -1): void => {
    const current = normalize(cursorRef.current)
    const count = modelsFor(current.provider).length
    if (count > 0) focus({ ...current, index: wrapIndex(current.index, delta, count) })
  }
  const pickEffort = (index: number): void => {
    const current = normalize(cursorRef.current)
    const model = modelsFor(current.provider)[current.index]
    if (model === undefined) return
    const result = catalogs.get(modelKey(model))
    if (result === undefined || result === 'error') return
    const option = result.efforts[index]
    if (option === undefined) return
    draftsRef.current = new Map(draftsRef.current).set(modelKey(model), option.id)
    setDrafts(draftsRef.current)
  }
  const confirm = (): void => {
    if (!activeRef.current) return
    const current = normalize(cursorRef.current)
    const model = modelsFor(current.provider)[current.index]
    if (model === undefined) return
    activeRef.current = false
    // Derived defaults are preview text; only an explicit draft is a choice.
    onPick(model, draftsRef.current.get(modelKey(model)))
  }
  const cancel = (): void => {
    activeRef.current = false
    onCancel()
  }
  const handleKey = (input: string, key: Key, plainReturn: boolean): void => {
    if (!activeRef.current) return
    if (key.tab) {
      if (!providerTabs || groups.length === 0) return
      const index = groups.findIndex(group => group.provider === normalize(cursorRef.current).provider)
      focusProvider(groups[wrapIndex(index, key.shift ? -1 : 1, groups.length)]!.provider)
    } else if (key.upArrow || key.downArrow) {
      moveModel(key.upArrow ? -1 : 1)
    } else if (key.leftArrow || key.rightArrow) {
      const current = normalize(cursorRef.current)
      const model = modelsFor(current.provider)[current.index]
      const result = model === undefined ? undefined : catalogs.get(modelKey(model))
      if (model === undefined || result === undefined || result === 'error' || result.efforts.length === 0) return
      const index = result.efforts.findIndex(effort => effort.id === effortFor(model, result))
      pickEffort(result.efforts.length === 2 ? (index === 0 ? 1 : 0)
        : Math.max(0, Math.min(result.efforts.length - 1, index + (key.leftArrow ? -1 : 1))))
    } else if (plainReturn) {
      confirm()
    } else if (key.escape || (key.ctrl && input === 'c')) {
      cancel()
    }
  }
  return {
    groups, provider: selected.provider, models: listed, index: selected.index,
    efforts: catalog === undefined || catalog === 'error' ? [] : catalog.efforts,
    effortId: focused === undefined ? undefined : effortFor(focused, catalog),
    effortsLoading: focused !== undefined && catalog === undefined,
    effortError: catalog === 'error',
    levelsFallback: catalog !== undefined && catalog !== 'error' && catalog.levelsFallback === true,
    reset, focusProvider,
    focusModel: (index: number) => focus({ ...normalize(cursorRef.current), index }),
    moveModel, pickEffort, confirm, cancel, handleKey,
  }
}
