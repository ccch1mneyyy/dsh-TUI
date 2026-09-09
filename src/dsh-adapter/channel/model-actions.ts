import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { CommandCompletionNode } from '../../commands.js'
import { readEffortPref, resolveEffortDefault, writeEffortPref } from '../../effortPrefs.js'
import { snapshotLiveSessionEvents } from '../compat/liveSession.js'
import { getLang, t, tOr, type Lang } from '../../i18n.js'
import { migratePresetPref, writePresetPref } from '../../presetPrefs.js'
import { resolveCompatiblePreset, rosterOf, type AgentPresetInfo } from '../preset-resolution.js'
import type { createChannelBinding } from './binding.js'
import type { ChannelOwner } from './owner.js'
import type { ChannelState, EffortOption, PresetOption } from './types.js'

type Binding = ReturnType<typeof createChannelBinding>

/**
 * Route metadata, effort preference and preset/model catalog actions.
 * This owns the async catalog caches and their generation fences; callers only
 * compose its surface into ChannelState after the state has been constructed.
 */
export function createModelActions(
  ctx: Context,
  state: Pick<ChannelState, 'provider' | 'model' | 'reasoningEffort' | 'effortLevels' | 'agentPreset' | 'working' | 'emit'>,
  deps: {
    owner: Pick<ChannelOwner, 'current'>
    binding: Pick<Binding, 'capture' | 'isCurrent'>
    selection: ModelSelectionRef
    initialEffort?: string
    agent(): Agent
    notify: ChannelState['notify']
  },
) {
  const { owner, selection, notify } = deps
  const llmRuntime = ctx.get('llm') as
    | {
      resolveModelInfo(provider: string, model: string): Promise<{ reasoning?: { efforts: ReadonlyArray<{ id: string; name: string; description?: string }>; defaultEffort?: string } }>
      listProviders(): readonly { id: string; name: string }[]
      listModels(provider: string): Promise<readonly LlmModelInfo[]>
    }
    | undefined
  let preferredEffort: string | undefined = deps.initialEffort ?? readEffortPref()
  // State construction cannot call this factory yet; seed the visible value
  // before the root starts binding or exposes the completed ChannelState.
  state.reasoningEffort = preferredEffort
  let effortLevelsGeneration = 0
  let effortOperation = 0
  let presetOperation = 0
  const effortWarm = { tried: false }
  const modelNodeCache = { nodes: undefined as readonly CommandCompletionNode[] | undefined, load: undefined as Promise<void> | undefined, generation: 0 }
  const presetOptionCache = { lang: undefined as Lang | undefined, list: undefined as readonly PresetOption[] | undefined, load: undefined as Promise<void> | undefined }

  type EffortResult = { efforts: ReadonlyArray<{ id: string; name: string; description?: string }>; defaultEffort: string | undefined }
  type EffortCapture = { readonly binding: ReturnType<Binding['capture']>; readonly provider: string; readonly model: string; readonly operation: number }
  const captureEffort = (): EffortCapture => ({
    binding: deps.binding.capture(), provider: state.provider, model: state.model, operation: ++effortOperation,
  })
  const effortCurrent = (capture: EffortCapture): boolean =>
    owner.current() && deps.binding.isCurrent(capture.binding) &&
    state.provider === capture.provider && state.model === capture.model && effortOperation === capture.operation
  const resolveEfforts = async (capture: EffortCapture): Promise<EffortResult | 'unavailable' | 'error' | 'stale'> => {
    if (llmRuntime === undefined || typeof llmRuntime.resolveModelInfo !== 'function') return 'unavailable'
    try {
      const info = await llmRuntime.resolveModelInfo(capture.provider, capture.model)
      if (!effortCurrent(capture)) return 'stale'
      const efforts = info.reasoning?.efforts ?? []
      state.effortLevels = efforts.map(level => level.id)
      return { efforts, defaultEffort: info.reasoning?.defaultEffort }
    } catch (error) {
      if (!effortCurrent(capture)) return 'stale'
      notify(t('effort-read-failed', { error: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
      return 'error'
    }
  }
  const applyPreferredEffort = async (): Promise<void> => {
    if (llmRuntime === undefined || typeof llmRuntime.resolveModelInfo !== 'function') return
    const capture = captureEffort()
    const resolved = await resolveEfforts(capture)
    if (resolved === 'unavailable' || resolved === 'error' || resolved === 'stale' || !effortCurrent(capture)) return
    // This same binding-time lookup is the route's initial tier refresh even
    // without a stored preference. Do not make a separate competing refresh
    // operation that could invalidate the selected preference completion.
    if (preferredEffort === undefined || !resolved.efforts.some(effort => effort.id === preferredEffort)) return
    selection.current = { provider: capture.provider, model: capture.model, reasoningEffort: ReasoningEffortId(preferredEffort) }
  }
  const refreshEffortLevels = (): void => {
    if (llmRuntime === undefined || typeof llmRuntime.resolveModelInfo !== 'function') return
    const capture = captureEffort()
    const generation = ++effortLevelsGeneration
    void llmRuntime.resolveModelInfo(capture.provider, capture.model).then(info => {
      if (!effortCurrent(capture) || generation !== effortLevelsGeneration) return
      state.effortLevels = (info.reasoning?.efforts ?? []).map(level => level.id)
      state.emit()
    }).catch(() => undefined)
  }
  const applyEffort = (effort: { id: string; name: string }, capture: EffortCapture): void => {
    if (!effortCurrent(capture)) return
    selection.current = { provider: capture.provider, model: capture.model, reasoningEffort: ReasoningEffortId(effort.id) }
    preferredEffort = effort.id
    state.reasoningEffort = effort.id
    writeEffortPref(effort.id)
    notify(t('effort-switched', { name: effort.name }))
    state.emit()
  }
  const listEfforts = async (): Promise<{ efforts: readonly EffortOption[]; defaultEffort: string | undefined }> => {
    const capture = captureEffort()
    const resolved = await resolveEfforts(capture)
    if (resolved === 'stale') return { efforts: [], defaultEffort: undefined }
    if (resolved === 'unavailable') { notify(t('effort-unavailable'), { color: 'error' }); return { efforts: [], defaultEffort: undefined } }
    if (resolved === 'error') return { efforts: [], defaultEffort: undefined }
    if (!effortCurrent(capture)) return { efforts: [], defaultEffort: undefined }
    if (resolved.efforts.length === 0) notify(t('effort-unsupported'), { color: 'warning' })
    else if (resolved.efforts.length === 1) notify(t('effort-single-tier', { name: resolved.efforts[0]!.name }), { color: 'warning' })
    return resolved
  }
  const setEffort = async (id: string): Promise<boolean> => {
    const capture = captureEffort()
    const resolved = await resolveEfforts(capture)
    if (resolved === 'stale') return false
    if (resolved === 'unavailable') { notify(t('effort-unavailable'), { color: 'error' }); return false }
    if (resolved === 'error') return false
    if (!effortCurrent(capture)) return false
    if (resolved.efforts.length === 0) { notify(t('effort-unsupported'), { color: 'warning' }); return false }
    const found = resolved.efforts.find(effort => effort.id === id)
    if (found === undefined) { notify(t('effort-invalid', { id, ids: resolved.efforts.map(effort => effort.id).join(', ') }), { color: 'warning' }); return false }
    applyEffort(found, capture)
    return effortCurrent(capture)
  }
  /**
   * Re-seat the future-sessions default reasoning effort. `id` is the settings
   * user layer (the settings user layer outranks the cordis.yml `effort` pin);
   * an absent level re-derives the boot chain (cordis `effort` → the persisted
   * /effort choice). Also re-pins the live agent when its route offers the
   * level, so the change lands on the next request. No-op when unchanged.
   */
  const setDefaultEffort = (id: string | undefined): void => {
    const resolved = resolveEffortDefault(id, deps.initialEffort, readEffortPref())
    if (resolved === preferredEffort) return
    preferredEffort = resolved
    void applyPreferredEffort()
  }
  const warmEffortLevels = (): void => {
    if (state.effortLevels !== undefined || effortWarm.tried) return
    effortWarm.tried = true
    const capture = captureEffort()
    void resolveEfforts(capture).then(result => {
      if (result !== 'unavailable' && result !== 'error' && result !== 'stale' && effortCurrent(capture)) {
        effortWarm.tried = false
        state.emit()
      } else if (effortOperation === capture.operation) {
        // A stale route/binding has its own next bind warm; a transient
        // unavailable/error may be retried on a later explicit completion.
        effortWarm.tried = false
      }
    }).catch(() => undefined)
  }
  const listModels = (): Promise<readonly LlmModelInfo[]> => {
    if (llmRuntime === undefined) return Promise.resolve([])
    return Promise.all(llmRuntime.listProviders().map(provider => llmRuntime.listModels(provider.id).catch(() => []))).then(lists => lists.flat())
  }
  const listProviders = () => Promise.resolve(llmRuntime === undefined ? [] : llmRuntime.listProviders().map(info => ({ ...info })))
  const dropModelNodeCache = (): void => { modelNodeCache.generation += 1; modelNodeCache.nodes = undefined; modelNodeCache.load = undefined }
  const warmModelNodes = (): void => {
    if (modelNodeCache.load !== undefined) return
    const generation = modelNodeCache.generation
    modelNodeCache.load = listModels().then(list => {
      if (!owner.current() || generation !== modelNodeCache.generation) return
      modelNodeCache.nodes = list.map(model => ({ name: `${model.provider}/${model.id}`, description: model.name, ...(state.provider === model.provider && state.model === model.id ? { tag: 'current' } : {}) }))
      state.emit()
    }).catch(() => { if (owner.current() && generation === modelNodeCache.generation) modelNodeCache.nodes = [] })
  }
  const warmPresetOptions = (): void => {
    const lang = getLang()
    if (presetOptionCache.lang !== undefined && presetOptionCache.lang !== lang) { presetOptionCache.list = undefined; presetOptionCache.load = undefined }
    if (presetOptionCache.load !== undefined) return
    presetOptionCache.lang = lang
    presetOptionCache.load = listPresets().then(list => { presetOptionCache.list = list; state.emit() }).catch(() => { presetOptionCache.list = [] })
  }
  const listPresets = async (): Promise<readonly PresetOption[]> => {
    const presets = rosterOf(ctx)
    if (presets === undefined) return []
    const localized = getLang() === 'en'
    try {
      return (await presets.list()).map(preset => ({ id: preset.id, ...(preset.name === undefined ? {} : { name: localized ? tOr(`preset-name-${preset.id}`, preset.name) : preset.name }), ...(preset.description === undefined ? {} : { description: localized ? tOr(`preset-desc-${preset.id}`, preset.description) : preset.description }), ...(preset.broken === undefined ? {} : { broken: preset.broken }), isDefault: preset.id === presets.defaultId }))
    } catch { return [] }
  }
  const switchPreset = async (presetId: string): Promise<boolean> => {
    const presets = rosterOf(ctx)
    if (presets === undefined) { notify(t('preset-unavailable'), { color: 'error' }); return false }
    if (state.working) { notify(t('preset-agent-running'), { color: 'warning' }); return false }
    const capture = deps.binding.capture()
    const targetAgent = deps.agent()
    const targetSession = targetAgent.session
    const operation = ++presetOperation
    const current = (): boolean => owner.current() && deps.binding.isCurrent(capture) && deps.agent() === targetAgent && targetAgent.session === targetSession && operation === presetOperation
    let target: AgentPresetInfo
    try { target = await resolveCompatiblePreset(presets, presetId) } catch (error) { if (current()) notify(t('preset-not-found', { id: presetId, err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 }); return false }
    if (!current()) return false
    if (target.broken !== undefined) { notify(t('preset-load-failed', { id: target.id, broken: target.broken }), { color: 'error', timeoutMs: 8000 }); return false }
    if (target.id === state.agentPreset) {
      if (!migratePresetPref(presetId, target.id)) { notify(t('preset-switched-pref-failed', { id: target.id }), { color: 'warning' }); return true }
      notify(t('preset-already-current', { id: target.id }), { color: 'success' }); return true
    }
    if (snapshotLiveSessionEvents(targetSession).some(event => event.type === 'turn/start')) {
      if (!current()) return false
      if (!writePresetPref(target.id)) { notify(t('preset-pref-write-failed'), { color: 'error' }); return false }
      notify(t('preset-locked-saved-default', { current: state.agentPreset ?? 'host', id: target.id }), { color: 'warning', timeoutMs: 8000 }); return true
    }
    let preset: AgentPresetInfo
    try { preset = await presets.recompose(targetAgent.ctx, target.id) } catch (error) { if (current()) notify(t('preset-switch-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 }); return false }
    if (!current()) return false
    ;(targetSession as unknown as { append(type: string, data: unknown): void }).append('agent-preset/selected', { agentPreset: preset.id })
    if (!current()) return false
    state.agentPreset = preset.id
    state.emit()
    if (!current()) return false
    if (!writePresetPref(target.id)) { notify(t('preset-switched-pref-failed', { id: target.id }), { color: 'warning' }); return true }
    notify(t('preset-switched-saved', { id: target.id }), { color: 'success' }); return true
  }
  return { selection, applyPreferredEffort, refreshEffortLevels, listEfforts, setEffort, setDefaultEffort, warmEffortLevels, listModels, listProviders, dropModelNodeCache, warmModelNodes, modelNodes: () => modelNodeCache.nodes ?? [], warmPresetOptions, presetOptions: () => presetOptionCache.list ?? [], listPresets, switchPreset }
}
