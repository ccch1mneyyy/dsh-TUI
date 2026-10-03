/**
 * The channel's one action install (docs/agent-backend-design.md §3.5 item 4):
 * every `ChannelUi` action resolves, in layers,
 *
 *   1. explicitly unavailable — `capability-unavailable-backend` + the contract's
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
  state: () => Pick<ChannelState, 'provider' | 'backendCapabilities' | 'agentBindingGeneration' | 'model' | 'modelDisplay' | 'emit'>
  notify: ChannelState['notify']
  unavailable(name: string): void
  unavailableLines(name: string): string[]
  controls: Pick<SessionControls, 'mcpReport' | 'refreshModelDisplay'>
}): Partial<ChannelActionDelegates> {
  const { notify, unavailable } = deps
  const caps = (): AgentSession['capabilities'] => deps.session().capabilities
  /**
   * An MCP answer is a fact of ONE session: both /mcp and the server controls
   * run async against the bound session, and a '/new' or '/resume' may land
   * before the answer does. The channel owner staying alive is not enough —
   * this fence also captures the session and its binding generation, so a
   * late answer of the replaced session (even of the SAME session re-bound a
   * round trip later) writes neither the report nor a toast for its successor.
   */
  const mcpFence = (): { session: AgentSession; current(): boolean } => {
    const session = deps.session()
    const generation = deps.state().agentBindingGeneration
    return { session, current: () => deps.owner.current() && deps.session() === session && deps.state().agentBindingGeneration === generation }
  }
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
      // The reflex key walks the backend's declared cycle surface when it is
      // narrower than the roster (Claude keeps `bypassPermissions`
      // picker-only); a backend that declares none cycles the full list.
      const list = modes.cycle?.() ?? modes.list()
      if (list.length === 0) return
      const index = list.findIndex(mode => mode.id === modes.current())
      await modes.set(list[(index + 1) % list.length]!.id)
    }),
    // Passive roster read for the /permission picker: sync (modes.list() is
    // synchronous by contract) and silent when absent — the empty list is
    // the answer, exactly what permissionPresets() answers for a missing
    // roster. DSH sessions declare no modes capability, so they read empty
    // and their preset pipeline stays the only /permission.
    listModes: () => {
      const modes = caps().modes
      if (modes === undefined) return { modes: [], currentIndex: -1 }
      const list = modes.list()
      const index = list.findIndex(mode => mode.id === modes.current())
      return { modes: list.map(mode => ({ id: mode.id, name: mode.label, ...(mode.description === undefined ? {} : { description: mode.description }) })), currentIndex: index }
    },
    setMode: id => guarded('mode', false, async () => {
      const modes = caps().modes
      if (modes === undefined || !modes.list().some(mode => mode.id === id)) { unavailable('mode'); return false }
      await modes.set(id)
      return true
    }),
    // `/channel`: the typed `channels` capability's roster — sync and
    // silent when absent (the empty roster IS the answer, like listModes).
    listChannels: () => {
      const channels = caps().channels
      if (channels === undefined) return { channels: [], activeId: undefined }
      return { channels: channels.list(), activeId: channels.activeId() }
    },
    setChannel: id => {
      const channels = caps().channels
      if (channels === undefined || !channels.list().some(channel => channel.id === id)) { unavailable('channel'); return false }
      channels.setActive(id)
      // The active channel's mapping is the model display's truth source
      // (backends/claude/modelEnv.ts reads the store lazily), so one refresh
      // repaints the footer and the /model labels immediately — no
      // model.changed round trip needed.
      try {
        deps.controls.refreshModelDisplay(deps.session())
        deps.state().emit()
      } catch (error) {
        logForDebugging(`channel: model display refresh failed (${error instanceof Error ? error.message : String(error)})`)
      }
      return true
    },
    importChannel: () => {
      const channels = caps().channels
      if (channels === undefined) { unavailable('channel'); return undefined }
      try {
        return channels.importFromSettings()
      } catch (error) {
        notify(t('capability-failed', { name: 'channel', err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
        return undefined
      }
    },
    // The phase-3 wizard's writes: upsert with connection fields (the
    // token travels capability→credential seam, never through the UI), and
    // the delete. Both refuse politely on backends without the surface.
    saveChannel: input => {
      const channels = caps().channels
      if (channels?.save === undefined) { unavailable('channel'); return undefined }
      try {
        return channels.save(input)
      } catch (error) {
        notify(t('capability-failed', { name: 'channel', err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
        return undefined
      }
    },
    removeChannel: id => {
      const channels = caps().channels
      if (channels?.remove === undefined) { unavailable('channel'); return false }
      try {
        return channels.remove(id)
      } catch (error) {
        notify(t('capability-failed', { name: 'channel', err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
        return false
      }
    },
    // Read-only peek at what settings.json holds (the wizard's absorb
    // offer); silent undefined when there is nothing importable.
    peekChannelImport: () => {
      const channels = caps().channels
      if (channels?.peekSettingsImport === undefined) return undefined
      try {
        return channels.peekSettingsImport()
      } catch {
        return undefined
      }
    },
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
      const own = provider === '' || provider === state.backendCapabilities.backendLabel || provider === state.provider
      const outcome = await models.set({ ...(own ? {} : { provider }), model })
      if (outcome.kind === 'refused') notify(outcome.reason, { color: 'warning' })
      return outcome.kind === 'switched'
    }),
    listEfforts: () => {
      const effort = caps().effort
      if (effort === undefined) { unavailable('effort'); return Promise.resolve({ efforts: [], defaultEffort: undefined }) }
      const levels = effort.levels()
      // The slider trusts this answer to have said why it cannot open (Chat
      // returns silently for <= 1 tiers): a backend whose route exposes no (or
      // a single) effort tier gets the same honesty the DSH specialist gives.
      if (levels.length === 0) notify(t('effort-unsupported'), { color: 'warning' })
      else if (levels.length === 1) notify(t('effort-single-tier', { name: levels[0]!.label }), { color: 'warning' })
      // levelsFallback rides along when the backend marks the ladder as
      // the CLI-standard compatibility offer (a model row that declares no
      // tiers of its own) — the slider says so instead of pretending the
      // tiers are the model's own list.
      return Promise.resolve({ efforts: levels.map(level => ({ id: level.id, name: level.label })), defaultEffort: effort.current(), ...(effort.levelsFallback === true ? { levelsFallback: true as const } : {}) })
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
      const fence = mcpFence()
      return deps.controls.mcpReport(fence.session, fence.current) ?? [t('claude-mcp-loading')]
    },
    mcpControl: request => guarded('mcp', false, async () => {
      const mcp = caps().mcp
      const run = request.action === 'reconnect' ? mcp?.reconnect : mcp?.toggle
      if (mcp === undefined || run === undefined) { unavailable(`mcp ${request.action}`); return false }
      const fence = mcpFence()
      if (request.action === 'reconnect') await mcp.reconnect!(request.name)
      else await mcp.toggle!(request.name, request.enabled)
      if (fence.current()) {
        notify(t(request.action === 'reconnect' ? 'mcp-reconnected' : request.enabled ? 'mcp-enabled' : 'mcp-disabled', { name: request.name }), { color: 'success' })
        // The next /mcp shows the new state.
        deps.controls.mcpReport(fence.session, fence.current)
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
