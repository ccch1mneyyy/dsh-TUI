import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { t } from '../../i18n.js'
import { WORKING_GATE_NOTICES } from '../../commands.js'
import { writeModelPref } from '../../modelPrefs.js'
import type { createChannelBinding } from './binding.js'
import type { ChannelOwner } from './owner.js'
import type { ChannelState } from './types.js'

type Binding = ReturnType<typeof createChannelBinding>
type SwitchState = Pick<ChannelState, 'working' | 'provider' | 'model' | 'contextWindow' | 'effortLevels' | 'reasoningEffort' | 'emit'>

/** Select the next request's route without replacing the conversation or its agent. */
export function createModelSwitchAction(
  ctx: Context,
  state: SwitchState,
  deps: {
    owner: Pick<ChannelOwner, 'current'>
    binding: Pick<Binding, 'capture' | 'isCurrent'>
    selection: ModelSelectionRef
    settleCompaction(): Promise<void>
    applyPreferredEffort(): Promise<void>
    dropModelCompletion(): void
    notify: ChannelState['notify']
  },
) {
  let operation = 0
  return async (provider: string, model: string): Promise<boolean> => {
    if (!deps.owner.current()) return false
    if (state.working) { deps.notify(t(WORKING_GATE_NOTICES.model), { color: 'warning' }); return false }
    const generation = ++operation
    if (provider === state.provider && model === state.model) return true
    const capture = deps.binding.capture()
    const current = (): boolean => deps.owner.current() && deps.binding.isCurrent(capture) && generation === operation
    try {
      await deps.settleCompaction()
      const llm = ctx.get('llm') as { listModels?(provider: string): Promise<readonly { id: string }[]> } | undefined
      if (llm?.listModels !== undefined) {
        const models = await llm.listModels(provider)
        if (models.length > 0 && !models.some(entry => entry.id === model)) throw new Error(`unknown model: ${provider}/${model}`)
      }
    } catch (error) {
      if (current()) deps.notify(t('model-switch-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
      return false
    }
    if (!current() || state.working) return false
    // Assembly captures this complete route for both persona variables and the
    // request waterfall. The loop persists its actual header on the next request.
    deps.selection.current = { provider, model }
    state.provider = provider
    state.model = model
    state.contextWindow = undefined
    state.effortLevels = undefined
    state.reasoningEffort = undefined
    deps.dropModelCompletion()
    void deps.applyPreferredEffort()
    if (!writeModelPref(provider, model)) deps.notify(t('model-pref-write-failed'), { color: 'warning' })
    state.emit()
    return true
  }
}
