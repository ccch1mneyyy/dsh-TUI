/**
 * Channel composition for a session served by a non-DSH backend
 * (docs/agent-backend-design.md §3.5): the backend-neutral core only — one
 * binding, the shared projector fed by `session.subscribe`, the input
 * pipeline (FIFO, `tui/input` decisions, `@` mentions, staged images) ending
 * in `session.submit`, host seams (settings, scenes, themes, notifications)
 * and the generic actions. None of the DSH specialists is constructed here;
 * every action they would serve is either backed by a typed session
 * capability or explicitly unavailable (`createUnavailableActionDelegates`).
 *
 * The DSH composition (`../channel.ts`) is untouched by this module: a DSH
 * session never reaches it.
 */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { markChannelReadDirty } from '../../adapter/channel/read-view.js'
import { adapterRuntimeFor } from '../../adapter/kernel/runtime-context.js'
import { readGrantStore } from '../../adapter/standard/grants.js'
import type { LocalCommand } from '../../adapter/ports/channel-catalog.js'
import type { OAuthSetupHost } from '../../adapter/ports/channel-settings.js'
import type { OpenTarget } from '../../agent/backend.js'
import type { AgentEvent } from '../../agent/events.js'
import type { AgentSession } from '../../agent/session.js'
import { channelCapabilities } from '../../channel/capabilities.js'
import { attachInteraction } from '../../channel/interaction.js'
import { createChannelProjection } from '../../channel/projection.js'
import { LOCAL_COMMANDS } from '../../commands.js'
import { t } from '../../i18n.js'
import { DEFAULT_SESSION_MODES } from '../../sessionModes.js'
import { logForDebugging } from '../../utils/debug.js'
import { getHostCommandTrees } from '../command-trees.js'
import { runForegroundShell, type ForegroundShell } from '../compat/shell.js'
import { installDecisionGuard, markDecisionDispatchTopology } from '../decision-guard.js'
import { dispatchTuiDecision, dispatchTuiNotification, normalizeCancelDecision } from '../extension-events.js'
import { getHostGrantStore } from '../host-grants.js'
import { getHostRenderers, type TuiRendererRuntime } from '../renderers.js'
import { getHostSceneRuntime, type TuiSceneRuntime } from '../scenes.js'
import { getHostSettingsSections, getLocalSettingsSectionsHost, type TuiSettingsSectionsRuntime } from '../settings-sections.js'
import { getHostThemes, type TuiThemeRuntime } from '../themes.js'
import { createLocalWorkspaceRuntime, getHostWorkspaceRuntime } from '../workspaces.js'
import { createChannelActionMethods, createChannelActionReadiness, createUnavailableActionDelegates, type ChannelActionDelegates } from './action-readiness.js'
import { createChannelBinding } from './binding.js'
import { createSessionBatchRouter } from './binding-events.js'
import { createCommandCompletions } from './command-completions.js'
import { channelCommands } from './commands.js'
import { createComposerImages } from './composer-images.js'
import { createContextBookkeeping } from './context-bookkeeping.js'
import { createChannelEmitter } from './emitter.js'
import { createFileActions } from './file-actions.js'
import { createSelectionAttachments } from './ide-selection.js'
import { createInputActions, type InputConvergence } from './input-actions.js'
import { createInputDelivery } from './input-delivery.js'
import { createLocalFs } from './local-fs.js'
import { setActivityFrames } from './local-actions.js'
import { mentionFs } from './mentions.js'
import { createChannelNotifications } from './notifications.js'
import type { createChannelOwner } from './owner.js'
import { registerChannelOwner } from './owner.js'
import { unavailablePermissionPresetSnapshot } from './permissions.js'
import { createPreferences } from './preferences.js'
import { resetSessionProjection } from './session-reset.js'
import { createSettingsHosts } from './settings-host.js'
import { createInitialChannelView, type ChannelLaunchOptions } from './state.js'
import { LOCAL_OUTPUT_LIMIT, preview } from './transcript.js'
import type { ChannelState } from './types.js'

/** Token buffer below the context window at which the context-low warning fires. */
const CONTEXT_WARNING_BUFFER_TOKENS = 20_000

/** Completion warmers for the DSH model/preset/effort catalogs: none here. */
const NO_CATALOG_COMPLETION = {
  warmModelNodes: () => undefined,
  modelNodes: () => [],
  warmPresetOptions: () => undefined,
  presetOptions: () => [],
  warmEffortLevels: () => undefined,
}

/** The job registry is a DSH host service; nothing feeds it here. */
const NO_JOB_FEED = { onOutputSeen: () => undefined, onStarted: () => undefined }

/** A non-DSH session has no DSH session log for `/trace`. */
const NO_TRACE: readonly never[] = Object.freeze([])

/**
 * Compose the channel for one non-DSH session. Called by `createChannel`
 * inside its construction transaction (the caller disposes `owner` on throw).
 */
export function createSessionChannelWithOwner(
  ctx: Context,
  initialSession: AgentSession,
  options: ChannelLaunchOptions,
  owner: ReturnType<typeof createChannelOwner>,
): ChannelState {
  const rowIds = { value: 0 }
  const binding = createChannelBinding(initialSession, owner)
  // A non-DSH session owns its own lifetime (no host registry disposes it):
  // releasing the channel closes the bound session — for the Claude backend
  // that is what stops its CLI child process. Registered first, so a throw
  // anywhere later in this composition still stops it (the caller disposes
  // `owner` on throw). Replaced sessions are closed by the binding at
  // adoption.
  owner.own(() => {
    void Promise.resolve().then(() => binding.session.dispose()).catch((error: unknown) => {
      logForDebugging(`session-channel: dispose failed (${error instanceof Error ? error.message : String(error)})`)
    })
  })
  const backendLabel = options.backendLabel ?? initialSession.ref.backendId
  const snapshotOf = (session: AgentSession) => channelCapabilities({
    backendId: session.ref.backendId,
    backendLabel,
    capabilities: session.capabilities,
    dsh: false,
  })
  const commandListOf = (commands: readonly string[]) => LOCAL_COMMANDS.filter(command => commands.includes(command.name))

  // Host seams shared with every composition; each degrades when its row is
  // not mounted, exactly as in the DSH composition.
  const adapterRuntime = adapterRuntimeFor(ctx)
  const themeHost = getHostThemes(ctx.get('tuiThemes') as TuiThemeRuntime | undefined)
  const workspaceService = getHostWorkspaceRuntime(ctx.get('tuiWorkspaces')) ?? createLocalWorkspaceRuntime()
  const commandTrees = getHostCommandTrees(ctx.get('tuiCommandTrees'))
  const sceneRuntime = getHostSceneRuntime(ctx.get('tuiScenes') as TuiSceneRuntime | undefined)
  const settingsSectionsRuntime = getHostSettingsSections(
    ctx.get('tuiSettingsSections') as TuiSettingsSectionsRuntime | undefined,
  ) ?? getLocalSettingsSectionsHost(ctx)
  const rendererRuntime = getHostRenderers(ctx.get('tuiRenderers') as TuiRendererRuntime | undefined)
  // D-7: this channel dispatches `tui/input` & friends too, so it installs the
  // same default-deny decision gate the DSH composition does.
  const fallbackGrantStore = readGrantStore(undefined, undefined, adapterRuntime)
  installDecisionGuard(ctx, getHostGrantStore(ctx.get('tuiPluginHost')) ?? fallbackGrantStore)
  owner.own(markDecisionDispatchTopology(ctx))

  // No history slicing (`loadOlder`) behind a non-DSH session yet: folded
  // rows could never be restored, so the window is not folded at all.
  const emitter = createChannelEmitter(() => state, () => false, { fold: false })
  owner.own(() => emitter.dispose())
  const notify: ChannelState['notify'] = (...args) => {
    if (!owner.current()) return () => undefined
    return channelCommands(state).notify(...args)
  }
  /** The explicit failure every unbacked action reports (design §3.5). */
  const unavailable = (name: string): void => {
    notify(t('capability-unavailable', { name }), { color: 'warning', timeoutMs: 4000 })
  }
  const unavailableLines = (name: string): string[] => [t('capability-unavailable', { name })]
  const bookkeeping = createContextBookkeeping(
    () => state,
    (text, notifyOptions) => notify(text, notifyOptions),
    percent => t('context-low-warning', { percent }),
    CONTEXT_WARNING_BUFFER_TOKENS,
  )
  const { resetContextWarning, checkContextWarning, trackPending, untrackPending } = bookkeeping
  const selectionAttachments = createSelectionAttachments()
  const composer = createComposerImages(ctx, owner, { generation: () => state.agentBindingGeneration })
  // The session's working directory is the local disk when the host mounts
  // no fs service (mentions and `@` completion read it directly).
  const localFs = createLocalFs()
  const fs = () => mentionFs(ctx) ?? localFs
  const inputDelivery = createInputDelivery(ctx, owner, binding, () => state,
    (...args) => notify(...args), trackPending, untrackPending, composer,
    // IDE selection consumption is a DSH-composition feature for now.
    () => undefined, (messageId, info) => selectionAttachments.remember(messageId, info), () => localFs)
  const { dispatchUserText, withDecisionPending, clearStagedImages } = inputDelivery
  const inputConvergence: InputConvergence = { interruptSeq: 0, cancelInFlight: false }

  const actionReadiness = createChannelActionReadiness()
  const getReadyActions = (): ChannelActionDelegates => {
    owner.assertActive()
    return actionReadiness.getReadyActions()
  }
  const actionMethods = createChannelActionMethods(getReadyActions)
  const initialCapabilities = snapshotOf(initialSession)

  const state: ChannelState = {
    ...createInputActions(() => state, () => binding.session, owner, inputConvergence,
      composer,
      (text, placement, images) => dispatchUserText(text, placement, images),
      (command, includeInContext) => getReadyActions().runLocalCommand(command, includeInContext),
      // `/resume`'s MRU lists DSH sessions; this session cannot be opened there.
      () => undefined),
    subscribe: emitter.subscribe,
    emit: emitter.emit,
    emitStream: emitter.emitStream,
    ...createSettingsHosts(ctx, owner.assertActive),
    ...createPreferences(() => state),
    settingsNamespace: options.settingsNs ?? 'dsh-tui',
    // The open-time recap is a DSH LLM call; no backend-neutral recap exists.
    autoRecapOnOpen: false,
    ...createInitialChannelView(options, {
      agentId: initialSession.ref.sessionId,
      sessionId: initialSession.ref.sessionId,
      // The unmarked base mode: backend-native modes are a capability.
      mode: DEFAULT_SESSION_MODES[0]!,
      cwdDescription: workspaceService.describe(options.cwd).description ?? options.cwd,
    }),
    get minimal(): boolean {
      return state.minimalUi
    },
    commandList: commandListOf(initialCapabilities.commands),
    capabilities: initialCapabilities,
    get sessionRef() {
      const ref = binding.session.ref
      return { backendId: ref.backendId, sessionId: ref.sessionId }
    },
    costReport: undefined,
    rateLimit: undefined,
    backendAuth: () => {
      const auth = binding.session.capabilities.auth
      if (auth === undefined) return undefined
      return {
        provider: auth.oauthProvider,
        // The host's OAuth sign-in (dsh-auth), the same surface `/provider`
        // offers; absent when the plugin is not mounted.
        oauth: (ctx.get('dshAuth') as { api?: OAuthSetupHost } | undefined)?.api,
        status: async () => [...(await auth.status()).lines],
        reconnect: () => auth.reconnect(),
      }
    },
    ...actionMethods,
    subagentControl: { interrupt: () => { unavailable('agents'); return false } },
    jobControl: { kill: () => { unavailable('jobs'); return false } },
    stagedImageGeneration: composer.stagedImageGeneration,
    stageImage: composer.stageImage,
    stageComposerImage: composer.stageComposerImage,
    hasStagedImage: composer.hasStagedImage,
    discardStagedImage: composer.discardStagedImage,
    stagedImage: composer.stagedImage,
    stagedImageLimits: composer.stagedImageLimits,
    promptRewind: () => {
      unavailable('rewind')
      return Promise.resolve('cancel' as const)
    },
    buildSessionTree: () => {
      unavailable('tree')
      return Promise.resolve(null)
    },
    notify: createChannelNotifications(() => state, owner),
    permissionPresets: () => unavailablePermissionPresetSnapshot(),
    settingsSections: () => settingsSectionsRuntime?.list() ?? [],
    subscribeSettingsSections: listener => emitter.subscribe(listener),
    pluginScene: sceneRuntime?.active,
    openPluginScene: id => sceneRuntime?.open(id) ?? false,
    closePluginScene: () => { sceneRuntime?.close() },
    releaseContributions() {
      try {
        owner.dispose()
      } finally {
        emitter.dispose()
      }
    },
    traceEvents: () => NO_TRACE,
  }
  registerChannelOwner(state, owner)

  const projector = createChannelProjection(state, {
    rowIds, resetContextWarning, jobs: NO_JOB_FEED, inputConvergence,
    checkContextWarning, notify: (...args) => notify(...args),
    renderer: rendererRuntime,
    selectionAttached: messageId => selectionAttachments.take(messageId),
  })
  const router = createSessionBatchRouter({
    state, projector, inputConvergence,
    warn: message => ctx.logger.warn(message),
  })

  /**
   * Repaint the session's durable history once, when it is non-empty and
   * nothing live has painted yet. The history is asynchronous while the
   * binding transaction is synchronous; a session opened by `create` has
   * none, and ordering a non-empty history against live events that already
   * arrived is the resume work of a later phase (design §8.5).
   */
  const replayHistory = (capture: ReturnType<typeof binding.capture>): void => {
    void capture.session.history().then(events => {
      if (events.length === 0 || !owner.current() || !binding.isCurrent(capture)) return
      if (state.rows.length > 0) {
        logForDebugging('session-channel: history arrived after live rows; not replayed')
        return
      }
      projector.apply(events, { replay: true })
      projector.settleStreaming()
      state.working = false
      state.cancelPending = false
      state.emit()
    }).catch((error: unknown) => {
      logForDebugging(`session-channel: history failed (${error instanceof Error ? error.message : String(error)})`)
    })
  }

  // ── backend-native controls (design §4.9–4.10, §5.3–5.4) ─────────────
  // The projector owns the transcript; these are the session-level facts
  // only a non-DSH backend reports: its native permission mode, effort, own
  // slash commands, subscription usage, and the context / MCP reports the
  // synchronous `/context` and `/mcp` read.

  /** The backend's own commands, merged after the local ones. */
  let backendCommands: LocalCommand[] = []
  const refreshCommandList = (): void => {
    // Local names win, served here or not: a typed `/init` is the local
    // command (or its explicit unavailability), never the backend's.
    const local = new Set(LOCAL_COMMANDS.map(command => command.name))
    state.commandList = [...commandListOf(state.capabilities.commands), ...backendCommands.filter(command => !local.has(command.name))]
  }
  const loadBackendCommands = (session: AgentSession, current: () => boolean): void => {
    const commands = session.capabilities.commands
    if (commands === undefined) return
    void commands.list().then(list => {
      if (!current()) return
      backendCommands = list.map(command => ({
        name: command.name,
        description: command.description ?? '',
        tag: backendLabel,
        skill: true,
        origin: 'backend' as const,
      }))
      refreshCommandList()
      state.emit()
    }).catch((error: unknown) => {
      logForDebugging(`session-channel: backend commands failed (${error instanceof Error ? error.message : String(error)})`)
    })
  }

  /** The native mode as the status line shows it: the base mode unmarked,
   *  any other one labelled by the backend (plan mode in its own colour). */
  const applyMode = (session: AgentSession, modeId: string): void => {
    const list = session.capabilities.modes?.list() ?? []
    const index = list.findIndex(mode => mode.id === modeId)
    state.mode = { id: `${session.ref.backendId}:${modeId}`, label: list[index]?.label ?? modeId, ...(modeId === 'plan' ? { plan: true } : {}) }
    state.modeIndex = index === 0 ? 0 : Math.max(1, index)
  }

  const applyEffort = (session: AgentSession, effort: string | null | undefined): void => {
    const levels = session.capabilities.effort?.levels() ?? []
    state.effortLevels = levels.length === 0 ? undefined : levels.map(level => level.id)
    state.reasoningEffort = effort ?? undefined
  }

  /** `/mcp` is synchronous: it reads the last report (refreshed per turn). */
  let mcpLines: string[] | undefined
  const refreshMcp = (session: AgentSession, current: () => boolean): void => {
    const mcp = session.capabilities.mcp
    if (mcp === undefined) return
    void mcp.status().then(servers => {
      if (!current()) return
      mcpLines = servers.length === 0
        ? [t('claude-mcp-none')]
        : [
            t('claude-mcp-heading', { n: servers.length }),
            ...servers.map(server => t('claude-mcp-row', {
              name: server.name,
              status: server.status,
              tools: server.toolCount === undefined ? '' : t('claude-mcp-tools', { n: server.toolCount }),
            })),
            ...(servers.some(server => server.status === 'needs-auth') ? [t('claude-mcp-needs-auth')] : []),
          ]
    }).catch((error: unknown) => {
      logForDebugging(`session-channel: mcp status failed (${error instanceof Error ? error.message : String(error)})`)
    })
  }

  /** `/context` reads `loadedContext`: the backend's own measurement. */
  const refreshContext = (session: AgentSession, current: () => boolean): void => {
    const context = session.capabilities.context
    if (context === undefined) return
    void context.usage('summary').then(usage => {
      if (!current()) return
      const tokens = (n: number): string => t('claude-context-tokens', { n: n.toLocaleString() })
      // The summary report may carry no per-section split (the CLI answers
      // it from the last response's usage): the used categories stand in.
      const sections = usage.sections ?? []
      const used = usage.categories.filter(category => category.kind === 'used')
      state.loadedContext = {
        sections: (sections.length > 0 ? sections : used).map(item => ({ name: item.name, text: tokens(item.tokens) })),
        contexts: sections.length > 0 ? used.map(category => ({ name: category.name, text: tokens(category.tokens) })) : [],
        files: (usage.files ?? []).map(file => ({ displayPath: file.path.startsWith(`${state.cwd}/`) ? `./${file.path.slice(state.cwd.length + 1)}` : file.path })),
        skills: (usage.skills ?? []).map(skill => ({ name: skill.name, description: tokens(skill.tokens) })),
        tools: (usage.tools ?? []).map(tool => ({ name: tool.server === undefined ? tool.name : `${tool.server} › ${tool.name}`, description: tokens(tool.tokens) })),
      }
      if (state.contextWindow === undefined && usage.max !== undefined && usage.max > 0) state.contextWindow = usage.max
      state.emit()
    }).catch((error: unknown) => {
      logForDebugging(`session-channel: context usage failed (${error instanceof Error ? error.message : String(error)})`)
    })
  }

  /** A freshly bound session: read what it already knows. */
  const seedBackendSide = (session: AgentSession, current: () => boolean): void => {
    backendCommands = []
    mcpLines = undefined
    const modes = session.capabilities.modes
    if (modes !== undefined) applyMode(session, modes.current())
    if (session.capabilities.effort !== undefined) applyEffort(session, session.capabilities.effort.current())
    loadBackendCommands(session, current)
    refreshMcp(session, current)
    refreshContext(session, current)
  }

  /** The session-level events the shared projector leaves to the channel. */
  const applyBackendSide = (batch: readonly AgentEvent[], session: AgentSession): void => {
    const current = (): boolean => owner.current() && binding.session === session
    let changed = false
    for (const event of batch) {
      switch (event.type) {
        case 'mode.changed':
          applyMode(session, event.modeId)
          changed = true
          break
        case 'effort.changed':
          applyEffort(session, event.effort)
          changed = true
          break
        case 'model.changed':
          // Effort levels follow the model.
          if (session.capabilities.effort !== undefined) applyEffort(session, session.capabilities.effort.current())
          break
        case 'commands.changed':
          loadBackendCommands(session, current)
          break
        case 'rate-limit':
          state.rateLimit = { windows: event.info.windows }
          changed = true
          break
        case 'turn.end':
          refreshContext(session, current)
          refreshMcp(session, current)
          break
        default:
          break
      }
    }
    if (changed) state.emit()
  }

  /**
   * The bound session's prompts ↔ the stores Chat renders (design §4.7). One
   * link per binding: a replaced session (or a released channel) withdraws
   * everything it parked, so no panel outlives its session.
   */
  let interactionLink: ReturnType<typeof attachInteraction> | undefined
  owner.own(() => { interactionLink?.release() })

  /** Bind the current session: the one subscription feeding the projector. */
  const bind = (): void => {
    try {
      state.agentBindingGeneration = binding.bind()
      inputConvergence.cancelInFlight = false
      inputConvergence.interruptSeq += 1
      const capture = binding.capture()
      const current = (): boolean => owner.current() && binding.isCurrent(capture)
      interactionLink?.release()
      const link = options.interaction === undefined
        ? undefined
        : attachInteraction({ ...options.interaction, debug: logForDebugging }, { sessionId: capture.session.ref.sessionId, capabilities: capture.session.capabilities })
      interactionLink = link
      binding.subscribe(capture.session.subscribe((batch, meta) => {
        // Prompts first: a batch that also closes the turn must not leave a
        // panel behind it; the generation fence applies to both halves.
        if (current()) {
          link?.apply(batch)
          applyBackendSide(batch, capture.session)
        }
        router.route(batch, meta, current)
      }))
      state.status = capture.session.status === 'running' || capture.session.status === 'requires-action'
        ? 'running'
        : capture.session.status === 'disposed' ? 'disposed' : 'idle'
      replayHistory(capture)
      seedBackendSide(capture.session, current)
    } catch (error) {
      owner.dispose()
      throw error
    }
  }

  const clear = (): void => {
    state.rows.length = 0
    markChannelReadDirty(state.rows)
    rowIds.value = 0
    projector.reset()
    state.activeToolCount = 0
    state.responseChars = 0
    state.rows.push({ id: rowIds.value++, kind: 'notice', text: t('session-cleared') })
    state.emit()
  }

  const pushLocal = (title: string, lines: readonly string[]): void => {
    state.rows.push({ id: rowIds.value++, kind: 'local', text: title })
    for (const line of lines) state.rows.push({ id: rowIds.value++, kind: 'local-output', text: preview(line, LOCAL_OUTPUT_LIMIT) })
    state.emit()
  }

  /** `!cmd` / `!!cmd`: the host shell when mounted; `!!` sends the output on. */
  const runLocalCommand = async (command: string, includeInContext: boolean): Promise<void> => {
    const capture = binding.capture()
    const current = (): boolean => owner.current() && binding.isCurrent(capture)
    const cwd = state.cwd
    const target = workspaceService.describe(cwd)
    state.rows.push({ id: rowIds.value++, kind: 'local', text: command, executionTarget: target.kind === 'local' ? target.badge : `${target.badge} · ${target.label}` })
    state.emit()
    const executor = await workspaceService.commandShell(cwd) ?? ctx.get('shell') as ForegroundShell | undefined
    if (!current()) return
    if (executor === undefined) {
      unavailable('shell')
      return
    }
    let output: string
    try {
      const result = await runForegroundShell(executor, { command, workdir: cwd, timeoutMs: 30000 })
      output = result.stdout.text.trim() || result.stderr.text.trim() || (result.timedOut ? '(timed out)' : '(no output)')
    } catch (error) {
      output = error instanceof Error ? error.message : String(error)
    }
    if (!current()) return
    state.rows.push({ id: rowIds.value++, kind: 'local-output', text: preview(output, LOCAL_OUTPUT_LIMIT) })
    state.emit()
    if (includeInContext) {
      // This runs detached (`void runLocalCommand`): a session that closed
      // meanwhile (the CLI exited) must not surface as an unhandled rejection.
      try {
        await capture.session.submit({ text: `<bash-stdout>\n${output}\n</bash-stdout>`, clientMessageId: randomUUID() }, 'followup')
      } catch (error) {
        if (current()) notify(t('send-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
      }
    }
  }

  const fileActions = createFileActions({
    owner,
    capture: () => binding.capture(),
    current: capture => binding.isCurrent(capture as ReturnType<typeof binding.capture>),
    cwd: () => state.cwd,
    fs,
  })

  const commandCompletions = createCommandCompletions({
    state: () => state,
    themeHost,
    commandTrees,
    workspaceCommands: () => [],
    model: NO_CATALOG_COMPLETION,
  })

  /** `tui/session-switch` veto, the same decision seam the DSH `/new` uses. */
  const sessionSwitchVetoed = async (): Promise<boolean> => {
    const origin = binding.session
    const decision = await withDecisionPending('tui/session-switch', dispatchTuiDecision(ctx, 'tui/session-switch', {
      kind: 'new',
      sessionId: state.agentId,
      cwd: state.cwd,
    }, normalizeCancelDecision))
    if (binding.session !== origin) {
      notify(t('ext-stale-dropped'), { color: 'warning', timeoutMs: 4000 })
      return true
    }
    if (decision !== undefined) {
      notify(decision.reason ?? t('ext-action-cancelled'), { color: 'warning', timeoutMs: 4000 })
      return true
    }
    return false
  }

  /** `/new`: a fresh session of the same backend, adopted through the binding. */
  const newSession = async (open: (target: OpenTarget & { kind: 'create' }) => Promise<AgentSession>): Promise<boolean> => {
    owner.assertActive()
    if (state.working) {
      notify(t('new-session-while-working'), { color: 'warning' })
      return false
    }
    const capture = binding.capture()
    const current = (): boolean => owner.current() && binding.isCurrent(capture)
    if (await sessionSwitchVetoed() || !current()) return false
    const cwd = state.cwd
    let candidate: AgentSession
    try {
      candidate = await binding.prepare(capture, () => open({ kind: 'create', cwd }))
    } catch (error) {
      if (current()) notify(t('new-session-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
      return false
    }
    // A synchronous commit tail; a throw inside it revokes the candidate.
    return binding.adopt(candidate, capture, (previous, disposePrevious) => {
      clearStagedImages()
      resetSessionProjection(state, rowIds, () => projector.reset(), () => undefined, () => undefined)
      state.agentId = candidate.ref.sessionId
      state.sessionId = candidate.ref.sessionId
      const capabilities = snapshotOf(candidate)
      state.capabilities = capabilities
      backendCommands = []
      refreshCommandList()
      bind()
      state.emit()
      disposePrevious('dispose')
      try {
        void dispatchTuiNotification(ctx, 'tui/session-switched', { kind: 'new', sessionId: candidate.ref.sessionId, previousSessionId: previous.session.ref.sessionId, cwd: state.cwd })
          .catch((error: unknown) => { ctx.logger.warn('dsh-tui: tui/session-switched listener failed: %o', error) })
      } catch (error) {
        ctx.logger.warn('dsh-tui: tui/session-switched dispatch failed: %o', error)
      }
      return true
    })
  }

  /** `/doctor`: the backend-neutral facts plus the backend's own lines. */
  const doctorInfo = (): string[] => {
    const session = binding.session
    return [
      `Node ${process.version} · ${process.platform} ${process.arch}`,
      t('doctor-backend', { label: backendLabel, id: session.ref.backendId }),
      t('doctor-model', { model: state.model || t('doctor-unknown'), provider: backendLabel }),
      t('doctor-cwd', { cwd: state.cwd }),
      t('doctor-context-window', { window: state.contextWindow ?? t('doctor-unknown') }),
      t('doctor-session', { id: session.ref.sessionId }),
      ...session.capabilities.diagnostics?.lines() ?? [],
    ]
  }

  // Capability-backed delegates: an action whose typed capability the session
  // declares delegates to it; everything else stays explicitly unavailable.
  // Callers `void` most of these, so a rejecting capability is reported here
  // and answers the action's failure value — never an unhandled rejection.
  const caps = (): AgentSession['capabilities'] => binding.session.capabilities
  const guarded = async <T>(name: string, fallback: T, run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      if (owner.current()) notify(t('capability-failed', { name, err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
      return fallback
    }
  }
  const capabilityBacked: Partial<ChannelActionDelegates> = {}
  if (initialSession.capabilities.compact !== undefined) {
    capabilityBacked.compact = () => {
      const compact = caps().compact
      if (compact === undefined) { unavailable('compact'); return }
      void compact.run().catch((error: unknown) => {
        notify(t('compact-failed', { err: error instanceof Error ? error.message : String(error) }), { color: 'error' })
      })
    }
    capabilityBacked.cancelCompact = () => {
      try {
        caps().compact?.cancel?.()
      } catch (error) {
        logForDebugging(`session-channel: compact cancel failed (${error instanceof Error ? error.message : String(error)})`)
      }
    }
  }
  if (initialSession.capabilities.modes !== undefined) {
    capabilityBacked.cycleMode = () => guarded('mode', undefined, async () => {
      const modes = caps().modes
      if (modes === undefined) { unavailable('mode'); return }
      const list = modes.list()
      if (list.length === 0) return
      const index = list.findIndex(mode => mode.id === modes.current())
      await modes.set(list[(index + 1) % list.length]!.id)
    })
  }
  if (initialSession.capabilities.models !== undefined) {
    capabilityBacked.listModels = () => guarded('model', [], async () => {
      const models = caps().models
      if (models === undefined) { unavailable('model'); return [] }
      // One provider: the backend itself (the picker drills straight into
      // its models; `/model <id>` needs no provider segment).
      return (await models.list()).map(model => ({ provider: model.provider ?? state.provider, id: model.id, name: model.label, ...(model.description === undefined ? {} : { description: model.description }) }))
    })
    capabilityBacked.switchModel = (provider, model) => guarded('model', false, async () => {
      const models = caps().models
      if (models === undefined) { unavailable('model'); return false }
      const outcome = await models.set({ ...(provider === '' || provider === backendLabel || provider === state.provider ? {} : { provider }), model })
      if (outcome.kind === 'refused') notify(outcome.reason, { color: 'warning' })
      return outcome.kind === 'switched'
    })
  }
  if (initialSession.capabilities.effort !== undefined) {
    capabilityBacked.listEfforts = () => {
      const effort = caps().effort
      if (effort === undefined) { unavailable('effort'); return Promise.resolve({ efforts: [], defaultEffort: undefined }) }
      return Promise.resolve({ efforts: effort.levels().map(level => ({ id: level.id, name: level.label })), defaultEffort: effort.current() })
    }
    capabilityBacked.setEffort = id => guarded('effort', false, async () => {
      const effort = caps().effort
      if (effort === undefined || !effort.levels().some(level => level.id === id)) { unavailable('effort'); return false }
      await effort.set(id)
      return true
    })

  }
  if (initialSession.capabilities.fork !== undefined) {
    capabilityBacked.forkSession = () => guarded('fork', false, async () => {
      const fork = caps().fork
      if (fork === undefined) { unavailable('fork'); return false }
      await fork.fork()
      return true
    })
  }

  if (initialSession.capabilities.mcp !== undefined) {
    capabilityBacked.mcpStatus = () => {
      // Synchronous by contract: the last report, and a fresh one for next time.
      refreshMcp(binding.session, () => owner.current())
      return mcpLines ?? [t('claude-mcp-loading')]
    }
  }

  const openSession = options.openSession
  actionReadiness.install({
    ...createUnavailableActionDelegates(unavailable, unavailableLines),
    ...capabilityBacked,
    commandCompletions,
    runLocalCommand,
    loadOlder: () => 0,
    clear,
    setActivityFrames: name => setActivityFrames(state, notify, name),
    pushLocal,
    listFileCandidates: fileActions.listFileCandidates,
    listFiles: fileActions.listFiles,
    doctorInfo,
    ...(openSession === undefined ? {} : { newSession: () => newSession(openSession) }),
  })

  const startRuntimeSubscriptions = (): void => {
    owner.own(settingsSectionsRuntime?.subscribe(() => { if (owner.current()) state.emit() }) ?? (() => undefined))
    const disposeScenes = sceneRuntime?.subscribe(() => {
      if (state.pluginScene === sceneRuntime.active) return
      state.pluginScene = sceneRuntime.active
      state.emit()
    })
    if (disposeScenes !== undefined) owner.own(disposeScenes)
  }
  startRuntimeSubscriptions()
  bind()
  // Cordis owns the channel lifetime: unloading the context releases it.
  const effect = (ctx as Context & {
    effect?: (setup: () => () => void, label?: string) => void
  }).effect
  effect?.call(ctx, () => () => { state.releaseContributions() }, 'dsh-tui session channel lifecycle')
  state.emit()
  return state
}
