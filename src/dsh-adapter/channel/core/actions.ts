/**
 * The channel's single action install. Every `ChannelUi` action resolves
 * through these layers, later ones overriding earlier ones:
 *
 *   1. unavailable: `capability-unavailable-backend` plus the contract's
 *      failure value (`createUnavailableActionDelegates`);
 *   2. a typed session capability, looked up on the bound session at every
 *      call since a `/new` may land on a session with other capabilities. A
 *      rejecting capability is reported and returns the action's failure
 *      value instead of an unhandled rejection;
 *   3. the backend-neutral core actions (local rows, shell, files,
 *      completions, `/doctor`, `/export`, `/new`);
 *   4. the extension's delegates (the DSH extensions).
 *
 * The readiness cell installs the merged table once, after every layer
 * exists, so no construction-time placeholder is ever callable.
 */
import type { AgentSession } from '../../../agent/session.js'
import { conversationRecapPrompt, parseRecapResponse, sideQuestionPrompt } from '../../../channel/side-prompts.js'
import { t } from '../../../i18n.js'
import { createUnavailableActionDelegates, type ChannelActionDelegates, type createChannelActionReadiness } from '../action-readiness.js'
import type { ChannelOwner } from '../owner.js'
import type { ChannelState } from '../types.js'

export function createCapabilityDelegates(deps: {
  owner: Pick<ChannelOwner, 'current'>
  session(): AgentSession
  state: () => Pick<ChannelState, 'provider' | 'model' | 'backendCapabilities'>
  notify: ChannelState['notify']
  unavailable(name: string): void
  unavailableLines(name: string): string[]
  guarded<T>(name: string, fallback: T, run: () => Promise<T>): Promise<T>
}): Partial<ChannelActionDelegates> {
  const { notify, unavailable, guarded } = deps
  const caps = (): AgentSession['capabilities'] => deps.session().capabilities
  return {
    compact: () => {
      const compact = caps().compact
      if (compact === undefined) { unavailable('compact'); return }
      void compact.run().catch((error: unknown) => {
        notify(t('compact-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error' })
      })
    },
    cycleMode: () => guarded('mode', undefined, async () => {
      const modes = caps().modes
      if (modes === undefined) { unavailable('mode'); return }
      // The reflex key walks the backend's declared cycle surface when it is
      // narrower than the roster (Claude keeps `bypassPermissions`
      // picker-only); a backend that declares none cycles the full list.
      const list = modes.cycle?.() ?? modes.list()
      if (list.length === 0) return
      const index = list.findIndex(mode => mode.id === modes.current())
      await modes.set(list[(index + 1) % list.length]!.id)
    }),
    listModels: () => guarded('model', [], async () => {
      const models = caps().models
      if (models === undefined) { unavailable('model'); return [] }
      // One provider: the backend itself; `/model <id>` needs no provider segment.
      const provider = deps.state().provider
      return (await models.list()).map(model => ({ provider: model.provider ?? provider, id: model.id, name: model.label, ...(model.description === undefined ? {} : { description: model.description }) }))
    }),
    listProviders: () => {
      const state = deps.state()
      return Promise.resolve(caps().models === undefined ? [] : [{ id: state.provider, name: state.backendCapabilities.backendLabel }])
    },
    switchModel: (provider, model) => guarded('model', false, async () => {
      const models = caps().models
      if (models === undefined) { unavailable('model'); return false }
      const state = deps.state()
      const own = provider === '' || provider === state.backendCapabilities.backendLabel || provider === state.provider
      const outcome = await models.set({ ...(own ? {} : { provider }), model })
      if (outcome.kind === 'refused') notify(outcome.reason, { color: 'warning' })
      return outcome.kind === 'switched'
    }),
    listEfforts: route => {
      const effort = caps().effort
      if (route !== undefined) {
        const state = deps.state()
        const preview = effort?.forModel?.(route)
        const live = route.provider === state.provider && route.model === state.model
        return Promise.resolve({
          efforts: (preview?.levels ?? (live ? effort?.levels() : undefined) ?? []).map(level => ({ id: level.id, name: level.label })),
          defaultEffort: preview?.defaultEffort ?? (live ? effort?.current() : undefined),
          ...((preview?.levelsFallback ?? (live ? effort?.levelsFallback : undefined)) === true ? { levelsFallback: true as const } : {}),
        })
      }
      if (effort === undefined) { unavailable('effort'); return Promise.resolve({ efforts: [], defaultEffort: undefined }) }
      const levels = effort.levels()
      // The slider relies on this call to explain why it cannot open (Chat
      // returns silently for <= 1 tiers), so a route with zero or one effort
      // tier gets the same warning the DSH extension shows.
      if (levels.length === 0) notify(t('effort-unsupported'), { color: 'warning' })
      else if (levels.length === 1) notify(t('effort-single-tier', { name: levels[0]!.label }), { color: 'warning' })
      // levelsFallback is passed on when the backend marks the ladder as the
      // CLI-standard fallback (the model row declares no tiers of its own), so
      // the slider can say so instead of presenting them as the model's tiers.
      return Promise.resolve({ efforts: levels.map(level => ({ id: level.id, name: level.label })), defaultEffort: effort.current(), ...(effort.levelsFallback === true ? { levelsFallback: true as const } : {}) })
    },
    setEffort: id => guarded('effort', false, async () => {
      const effort = caps().effort
      if (effort === undefined || !effort.levels().some(level => level.id === id)) { unavailable('effort'); return false }
      await effort.set(id)
      return true
    }),
    // `/btw`: the backend's side call with the shared side-question contract.
    sideQuestion: async (question, options) => {
      const side = caps().sideQuery
      if (side === undefined) {
        unavailable('btw')
        return { answer: null, error: deps.unavailableLines('btw').join(' ') }
      }
      try {
        return { ...await side.ask(sideQuestionPrompt(question), options) }
      } catch (error) {
        return { answer: null, error: error instanceof Error ? error.message : String(error) }
      }
    },
    // `/recap`: the same side call over the conversation itself, read back
    // as a one-line summary plus a proposed title.
    recapRecent: async options => {
      const side = caps().sideQuery
      if (side === undefined) {
        unavailable('recap')
        return { summary: null, error: deps.unavailableLines('recap').join(' ') }
      }
      try {
        const outcome = await side.ask(conversationRecapPrompt(), options)
        if (outcome.answer === null) return { summary: null, ...(outcome.error === undefined ? {} : { error: outcome.error }) }
        const parsed = parseRecapResponse(outcome.answer)
        return { summary: parsed.summary, ...(parsed.title === undefined ? {} : { title: parsed.title }) }
      } catch (error) {
        return { summary: null, error: error instanceof Error ? error.message : String(error) }
      }
    },
    renameSession: title => {
      const rename = caps().rename
      if (rename === undefined) { unavailable('rename'); return }
      void rename.rename(title).catch((error: unknown) => {
        if (deps.owner.current()) notify(t('rename-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
      })
    },
    setSessionColor: color => {
      const accent = caps().color
      if (accent === undefined) { unavailable('color'); return }
      try {
        accent.set(color)
      } catch (error) {
        notify(t('capability-failed', { name: 'color', err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
      }
    },
  }
}

/** Merge the layers and install them once. */
export function installChannelActions(
  readiness: ReturnType<typeof createChannelActionReadiness>,
  layers: {
    unavailable(name: string): void
    unavailableLines(name: string): string[]
    capability: Partial<ChannelActionDelegates>
    core: Partial<ChannelActionDelegates>
    extension: Partial<ChannelActionDelegates> | undefined
  },
): void {
  readiness.install({
    ...createUnavailableActionDelegates(layers.unavailable, layers.unavailableLines),
    ...layers.capability,
    ...layers.core,
    ...layers.extension,
  })
}
