/**
 * The channel's one action install (docs/agent-backend-design.md §3.5 item 4):
 * every `ChannelUi` action resolves, in layers,
 *
 *   1. explicitly unavailable — `capability-unavailable` + the contract's
 *      failure value (`createUnavailableActionDelegates`);
 *   2. backed by a typed session capability — resolved on the bound session
 *      at every call (a `/new` may land on a session with other
 *      capabilities); a rejecting capability is reported and answers the
 *      action's failure value, never an unhandled rejection;
 *   3. the backend-neutral core actions (local rows, shell, files,
 *      completions, `/doctor`, `/export`, `/new`);
 *   4. the extension's delegates on top (the DSH specialists).
 *
 * The readiness cell installs the merged table exactly once, after every
 * layer exists; no construction-time placeholder is callable.
 */
import type { AgentSession } from '../../../agent/session.js'
import { conversationRecapPrompt, parseRecapResponse, sideQuestionPrompt } from '../../../channel/side-prompts.js'
import { t } from '../../../i18n.js'
import { logForDebugging } from '../../../utils/debug.js'
import { createUnavailableActionDelegates, type ChannelActionDelegates, type createChannelActionReadiness } from '../action-readiness.js'
import type { ChannelOwner } from '../owner.js'
import type { ChannelState } from '../types.js'
import type { SessionControls } from './session-controls.js'

export function createCapabilityDelegates(deps: {
  owner: Pick<ChannelOwner, 'current'>
  session(): AgentSession
  state: () => Pick<ChannelState, 'provider' | 'capabilities'>
  notify: ChannelState['notify']
  unavailable(name: string): void
  unavailableLines(name: string): string[]
  controls: Pick<SessionControls, 'mcpReport'>
}): Partial<ChannelActionDelegates> {
  const { notify, unavailable } = deps
  const caps = (): AgentSession['capabilities'] => deps.session().capabilities
  const guarded = async <T>(name: string, fallback: T, run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      if (deps.owner.current()) notify(t('capability-failed', { name, err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
      return fallback
    }
  }
  return {
    compact: () => {
      const compact = caps().compact
      if (compact === undefined) { unavailable('compact'); return }
      void compact.run().catch((error: unknown) => {
        notify(t('compact-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error' })
      })
    },
    // Contract: a no-op when this process runs no compaction it may abort.
    cancelCompact: () => {
      try {
        caps().compact?.cancel?.()
      } catch (error) {
        logForDebugging(`channel: compact cancel failed (${error instanceof Error ? error.message : String(error)})`)
      }
    },
    cycleMode: () => guarded('mode', undefined, async () => {
      const modes = caps().modes
      if (modes === undefined) { unavailable('mode'); return }
      const list = modes.list()
      if (list.length === 0) return
      const index = list.findIndex(mode => mode.id === modes.current())
      await modes.set(list[(index + 1) % list.length]!.id)
    }),
    listModels: () => guarded('model', [], async () => {
      const models = caps().models
      if (models === undefined) { unavailable('model'); return [] }
      // One provider: the backend itself (the picker drills straight into
      // its models; `/model <id>` needs no provider segment).
      const provider = deps.state().provider
      return (await models.list()).map(model => ({ provider: model.provider ?? provider, id: model.id, name: model.label, ...(model.description === undefined ? {} : { description: model.description }) }))
    }),
    switchModel: (provider, model) => guarded('model', false, async () => {
      const models = caps().models
      if (models === undefined) { unavailable('model'); return false }
      const state = deps.state()
      const own = provider === '' || provider === state.capabilities.backendLabel || provider === state.provider
      const outcome = await models.set({ ...(own ? {} : { provider }), model })
      if (outcome.kind === 'refused') notify(outcome.reason, { color: 'warning' })
      return outcome.kind === 'switched'
    }),
    listEfforts: () => {
      const effort = caps().effort
      if (effort === undefined) { unavailable('effort'); return Promise.resolve({ efforts: [], defaultEffort: undefined }) }
      return Promise.resolve({ efforts: effort.levels().map(level => ({ id: level.id, name: level.label })), defaultEffort: effort.current() })
    },
    setEffort: id => guarded('effort', false, async () => {
      const effort = caps().effort
      if (effort === undefined || !effort.levels().some(level => level.id === id)) { unavailable('effort'); return false }
      await effort.set(id)
      return true
    }),
    mcpStatus: () => {
      if (caps().mcp === undefined) return deps.unavailableLines('mcp')
      // Synchronous by contract: the last report, and a fresh one for next time.
      return deps.controls.mcpReport(deps.session(), () => deps.owner.current()) ?? [t('claude-mcp-loading')]
    },
    mcpControl: request => guarded('mcp', false, async () => {
      const mcp = caps().mcp
      const run = request.action === 'reconnect' ? mcp?.reconnect : mcp?.toggle
      if (mcp === undefined || run === undefined) { unavailable(`mcp ${request.action}`); return false }
      if (request.action === 'reconnect') await mcp.reconnect!(request.name)
      else await mcp.toggle!(request.name, request.enabled)
      if (deps.owner.current()) {
        notify(t(request.action === 'reconnect' ? 'mcp-reconnected' : request.enabled ? 'mcp-enabled' : 'mcp-disabled', { name: request.name }), { color: 'success' })
        // The next /mcp shows the new state.
        deps.controls.mcpReport(deps.session(), () => deps.owner.current())
      }
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
