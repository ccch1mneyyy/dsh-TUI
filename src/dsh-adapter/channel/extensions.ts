/**
 * The DSH extensions of the channel core (docs/agent-backend-design.md §3.5):
 * everything only a DSH session can serve, attached when the bound session
 * carries `native.dsh`. The specialists are the same modules as before the
 * core existed — their internals are unchanged; this file is their wiring.
 *
 * - transcript: the synchronous seed replay of the DSH log (subagent catalog
 *   included), `/trace`, "load earlier" restored from the log, the DeepSeek
 *   rate window for usage pricing, the job registry feed;
 * - subagents and background jobs: projections, child listeners, controls;
 * - sessions: `/resume`, `/home` and the agent view (MRU, background
 *   sessions, `/bg`), rewind, the session tree, fork, the DSH `/new` create
 *   path (preset, route, mount reservation, workspace ownership);
 * - session metadata: recap and auto-recap on open, `/btw`, `/rename`,
 *   `/color`, loaded context, skills, plugin (registry) commands;
 * - controls: permission modes and presets, model / preset / effort, manual
 *   compaction, the model-selection waterfalls and the child-route fill;
 * - reports: `/doctor`, `/export` (from the log), `/mcp`, `/init`, `/balance`,
 *   `/plugins`, `/login` credential descriptions.
 *
 * Construction order mirrors the pre-core composition wherever it is
 * observable: the job feed and pricing are installed before the seed replay,
 * the replay runs before the model / mode actions read the replayed state,
 * the child-route `agent/request` listener registers before the first bind's
 * own, and the runtime starts keep their order around the core's host
 * subscriptions.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { DshNative } from '../../agent/capabilities.js'
import type { AgentSession } from '../../agent/session.js'
import { channelCapabilities } from '../../channel/capabilities.js'
import { isCommandCompletionToken, LOCAL_COMMANDS } from '../../commands.js'
import { touchSession } from '../../sessionHistory.js'
import { DEFAULT_SESSION_MODES, resolveSessionModes } from '../../sessionModes.js'
import { createDshSession } from '../backend/session.js'
import { dshPricingWindow } from '../backend/translate.js'
import { getHostMessageObserver, type TuiMessageObserverRuntime } from '../message-observer.js'
import { createForeignBrowser } from '../migrate/browse.js'
import type { JobsRuntime } from '../jobs.js'
import { listSummaries, noteBranch, type SessionSource, type SessionSummary } from '../sessions/index.js'
import type { ChannelActionDelegates } from './action-readiness.js'
import { createAgentViewProjection } from './agent-view-projection.js'
import { createBackgroundCurrentAction } from './background-action.js'
import { dshChannelBinding } from './binding.js'
import { createBindingEvents } from './binding-events.js'
import { agentCapabilityEvidence, annotateCommandCapabilities, resolveAgentCapabilities } from './capabilities.js'
import { channelCommands } from './commands.js'
import { createManualCompaction } from './compaction.js'
import type { CoreChannel } from './core/compose.js'
import { createExternalCommandInvoker } from './external-commands.js'
import { createJobProjection } from './job-projection.js'
import { createDetachedHandleFactory } from './lifetime-resources.js'
import { createLoadedContextRefresher } from './loaded-context.js'
import { createLocalActions } from './local-actions.js'
import { mentionAttachments } from './mentions.js'
import { createModelActions } from './model-actions.js'
import { createModelSwitchAction } from './model-switch.js'
import { createPermissionModeActions } from './mode-permission-actions.js'
import { createPermissionModeRoster } from './mode-roster.js'
import { legacyPermissionPresetSnapshot, permissionPresetSnapshotFromService, unavailablePermissionPresetSnapshot } from './permissions.js'
import { createReportActions } from './reports.js'
import { createRewindPromptAction } from './session-actions.js'
import { createSessionAdoption } from './session-adoption.js'
import { createForkSessionAction } from './session-fork.js'
import { createLiveAgentAdoption } from './session-live-adoption.js'
import { createSessionMetadataActions } from './session-metadata.js'
import { createSessionResumeActions } from './session-resume.js'
import { createRewindToAction } from './session-rewind.js'
import { createSessionTreeReader } from './session-tree.js'
import { createTreeRewindAction } from './session-tree-actions.js'
import { createSkillCatalog } from './skill-catalog.js'
import { createSubagentProjection, type SubagentsServiceView } from './subagent-projection.js'
import { DSH_BACKEND_LABEL, type ChannelLaunchOptions } from './state.js'
import { foldBack } from './transcript.js'
import type { BackgroundResult, ResumeResult } from './types.js'
import { createWorkspaceActions } from './workspace-actions.js'

/** Actions the core serves for a DSH session too (with the hooks below). */
type CoreServedAction =
  | 'commandCompletions' | 'runLocalCommand' | 'loadOlder' | 'newSession' | 'clear'
  | 'setActivityFrames' | 'pushLocal' | 'listFileCandidates' | 'listFiles'
  // Capability-backed only: a DSH session offers no MCP control (its `/mcp`
  // is the status report, `capabilities.mcpControl` false).
  | 'mcpControl'
  // Capability-backed only: a DSH session declares no native `modes`
  // capability, so listModes answers the silent empty roster and setMode its
  // explicit refusal — the DSH /permission pipeline never routes through them.
  | 'listModes' | 'setMode'
  // Capability-backed only: the typed `channels` capability is the Claude
  // backend's own profile store — a DSH session answers the silent empty
  // roster and the explicit refusals, and /channel never appears there.
  | 'listChannels' | 'setChannel' | 'importChannel' | 'saveChannel' | 'removeChannel' | 'peekChannelImport'

/**
 * Read the persistence backend's full session list (empty without one) —
 * the agent view's "stopped" rows come from this snapshot.
 */
async function listSessionsSnapshot(ctx: Context): Promise<readonly SessionSummary[]> {
  const persistence = ctx.get('sessionPersistence') as SessionSource | undefined
  if (!persistence) return []
  return listSummaries(persistence)
}

/**
 * Attach the DSH specialists to a core whose bound session is a DSH session.
 * Called inside `createChannel`'s construction transaction: a throw here is
 * rolled back by the caller through the core's owner.
 */
export function attachDshExtensions(
  core: CoreChannel,
  ctx: Context,
  initialNative: DshNative,
  options: ChannelLaunchOptions,
): void {
  const { state, owner, rowIds, host, notify } = core
  const { workspaceService, commandTrees } = host
  const adapterRuntime = host.adapterRuntime
  // The DSH specialists read the binding through its DSH view (the bound
  // session is a DSH session for this whole composition).
  const binding = dshChannelBinding(core.binding)
  /** The bound session's DSH escape hatch. */
  const dshNative = (): DshNative => {
    const native = binding.session.capabilities.native.dsh
    if (native === undefined) throw new Error('dsh-tui: the bound session is not a DSH session')
    return native
  }
  // Detached work (/fork and agent-view dispatch) is owned until a caller
  // explicitly transfers the temporary handle to its destination ledger.
  const createDetachedHandle = createDetachedHandleFactory(owner)

  // Detached handles are a stable ledger shared with adoption actions. The
  // agent-view factory itself starts only after the full state surface exists.
  const backgroundHandles = new Map<string, AgentHandle>()
  let backgroundCurrentAction!: () => Promise<BackgroundResult>
  let agentView!: ReturnType<typeof createAgentViewProjection>

  // Subagent projection owns the child store, transcript row identity and
  // stream batching. Transport subscriptions below only route scoped events.
  const subagentProjection = createSubagentProjection(() => state, {
    rowIds,
    agent: () => binding.agent,
    // The continuation service is an optional host plugin: the projection's
    // message capability (direct prompt, catalog roster) exists exactly when
    // the service and its methods do — never a fabricated capability.
    subagents: () => (ctx as { get(name: string): unknown }).get('subagents') as SubagentsServiceView | undefined,
    ownerSignal: owner.signal,
    lookupChild: id => {
      const agents = ctx.get('agents') as { get(id: string): { status?: string; session?: unknown; options?: { provider?: string; model?: string } } | undefined } | undefined
      return agents?.get(id)
    },
  })
  owner.own(() => subagentProjection.dispose())
  // Job projection owns registry callbacks and transcript rows. The optional
  // service attachment has no authority after its injected lifetime ends.
  const jobProjection = createJobProjection(() => state, {
    owner, notify: (...args) => notify(...args), rowIds, agent: () => binding.agent, steer: text => channelCommands(state).steer(text),
  })

  // The DSH slash-command registry (optional service): /plan, /goal and
  // friends register here; the TUI merges their descriptors into the slash
  // menu and dispatches through `execute`.
  const commandService: CommandRuntime | undefined = ctx.get('commands')
  // messages.observe broker (optional service, C-042): absent the plugin-host
  // row, publish is a no-op (soft degradation, #183).
  const messageObserver = getHostMessageObserver(
    ctx.get('tuiMessageObserver') as TuiMessageObserverRuntime | undefined,
  )
  // Shift+Tab session-mode cycle: cordis.yml `modes` wins; absent/empty/
  // atom-less → the built-in default/plan/full cycle (sessionModes.ts).
  // Configured entries may additionally pin a durable `permission` preset
  // identity (permission + plan allowed; permission + sandbox/approval is
  // contradictory and dropped with a warning).
  const { modes: resolvedConfiguredSessionModes, dropped: droppedModeIds } = resolveSessionModes(options.modes)
  const filteredConfiguredSessionModes = resolvedConfiguredSessionModes
    .filter(spec => spec.permission === undefined || isCommandCompletionToken(spec.permission))
  const configuredSessionModes = filteredConfiguredSessionModes.length > 0
    ? filteredConfiguredSessionModes
    : DEFAULT_SESSION_MODES
  if (droppedModeIds.length > 0) {
    ctx.logger.warn(
      `dsh-tui: session modes ${droppedModeIds.map(id => `"${id}"`).join(', ')} declare no plan/sandbox/approval/permission atom; dropped from the Shift+Tab cycle`,
    )
  }
  // Runtime permission roster: third-party presets enter the Shift+Tab cycle
  // after the configured/default modes, rebuilt from the live service snapshot.
  const permissionRoster = createPermissionModeRoster(ctx, {
    configuredModes: configuredSessionModes,
    agent: () => binding.agent,
    warn: message => ctx.logger.warn(message),
  })
  const sessionModes = permissionRoster.modes

  // ── the DSH session's view of the common state ─────────────────────────
  const initialSession: AgentSession = binding.session
  state.agentId = binding.agent.id
  state.sessionId = binding.agent.session.id
  state.mode = sessionModes[0]!
  // A DSH session supports everything the TUI offers (design §3.5).
  state.backendCapabilities = channelCapabilities({
    backendId: initialSession.ref.backendId,
    backendLabel: options.backendLabel ?? DSH_BACKEND_LABEL,
    capabilities: initialSession.capabilities,
    dsh: true,
  })
  // Capability facts for the bound agent (channel/capabilities.ts). Reads are
  // service lookups, so both consumers may call it freely: the public
  // `capabilities()` accessor and the command-list annotation below.
  const capabilitiesOf = () => resolveAgentCapabilities(agentCapabilityEvidence(ctx, binding.agent))
  // Annotated from the start: Help and `/` completion read `commandList`
  // before the first skill-catalog refresh publishes a new one, and a command
  // whose capability is missing must never look usable in that window.
  state.commandList = annotateCommandCapabilities(LOCAL_COMMANDS, capabilitiesOf())
  Object.defineProperty(state, 'autoRecapOnOpen', {
    configurable: true,
    enumerable: true,
    get(): boolean {
      const settings = ctx.get('settings') as
        | { describe(options?: { redactSecrets?: boolean }): readonly { ns: string; value: unknown }[] }
        | undefined
      if (settings === undefined) return false
      const ns = settings.describe({ redactSecrets: true }).find(entry => entry.ns === state.settingsNamespace)
      return (ns?.value as Record<string, unknown> | undefined)?.recapOnOpen !== false
    },
  })
  state.subagentControl = subagentProjection.control
  state.jobControl = jobProjection.control
  /**
   * The `tui/rewind-prompt` decision event (pi's `session_before_fork`):
   * fired when the rewind picker confirms a message, before any fork work.
   * The first answering plugin may cancel the rewind or offer extra modes
   * rendered in the confirm pane.
   */
  state.promptRewind = createRewindPromptAction(ctx, {
    agent: () => binding.agent,
    state: () => state,
    withDecisionPending: core.input.withDecisionPending,
    notify,
  })
  state.buildSessionTree = createSessionTreeReader(ctx, binding, () => state.cwd, (...args) => notify(...args), owner)
  state.permissionPresets = () => {
    let service: unknown
    try {
      service = ctx.get('permissionPresets')
    } catch {
      return unavailablePermissionPresetSnapshot()
    }
    if (service === undefined) return legacyPermissionPresetSnapshot(state.mode.sandbox)
    return permissionPresetSnapshotFromService(service, binding.agent.session)
  }
  // Immutable per-append snapshot (dsh-session caches the frozen array);
  // reads follow session swaps (/resume /rewind /new) automatically.
  state.traceEvents = () => dshNative().rawHistory()
  // The DSH side of the trajectory capability declaration: a source IS
  // mounted, so the report flips off the core's 'unsupported' — 'empty'
  // until the session logs its first event, 'supported' from then on. Read
  // per call over the same cached snapshot, so it follows session swaps and
  // appends with no extra bookkeeping.
  state.trajectorySource = () => (dshNative().rawHistory().length === 0 ? 'empty' : 'supported')

  // The DSH log restores folded rows; the projector prices by the DeepSeek
  // rate window and feeds the job registry. Installed before the seed replay.
  const dshLocal = createLocalActions({
    ctx,
    owner,
    binding,
    state,
    // Fold restore re-derives views with the bound session's presenters.
    presenters: {
      call: (name, rawArgs) => dshNative().presentCallView(name, rawArgs),
      result: (name, rawArgs, data) => dshNative().presentResultView(name, rawArgs, data),
    },
    foldBack,
  })
  core.extend({
    // D-6 stale detection follows the AGENT (session wrappers are recreated
    // per adoption; an A→B→A return is the same conversation).
    conversationKey: session => session.capabilities.native.dsh?.agent ?? session,
    flushDeferred: () => subagentProjection.flush(),
    loadOlder: dshLocal.loadOlder,
    // Subagents and jobs come from the DSH host services (projections above).
    ownsActivity: true,
    // The DSH workspace may be remote: no local-disk stand-in for `fs`.
    localFs: false,
    dropRows: () => {
      subagentProjection.dropRows()
      jobProjection.dropRows()
    },
    touchSession: sessionId => { touchSession(sessionId) },
    // A session log records no branch; note it so the browser can show it.
    noteBranch: branch => { noteBranch(binding.agent.session.id, branch) },
    // `ChannelUi.capabilities()`: the agent's composition facts.
    agentCapabilities: capabilitiesOf,
  })
  core.feed.configureProjection({ jobs: jobProjection.store, pricingWindow: dshPricingWindow })
  const resetProjection = core.feed.resetProjection
  const projector = core.feed.projector

  // Model selection is installed by bind; route/effort state is owned by model-actions.
  const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
  // Registry command policy and rc.8 image encoding are an owner-scoped module.
  const externalCommands = createExternalCommandInvoker(ctx, {
    commandService,
    runtime: adapterRuntime,
    agent: () => binding.agent,
    capture: () => binding.capture(),
    bindingCurrent: capture => binding.isCurrent(capture as ReturnType<typeof binding.capture>),
    allows: (subject, permission, scope) => host.currentGrantStore().allows(subject, permission, scope),
    composer: core.composer,
    attachments: () => mentionAttachments(ctx),
    notify: (...args) => notify(...args),
  })
  const executeRegistryCommand = externalCommands.invokeText

  // Session actions close over these inert placeholders; they are installed
  // below, before the channel starts.
  let settleManualCompaction!: () => Promise<void>
  let resumeInto!: (sessionId: string, kind: 'resume' | 'agent-view', keepCurrent: boolean) => Promise<ResumeResult>
  let adoptLiveAgent!: (target: Agent) => Promise<ResumeResult>
  let rewindToNodeAction!: (sessionId: string, seq: number, mode?: 'rewind' | 'fork') => Promise<string | null>

  // Agent-view is activated after the complete state/action surface exists:
  // no roster callback or persistence continuation can observe an unbound UI.
  agentView = createAgentViewProjection(ctx, {
    owner, binding, cwd: () => state.cwd,
    configuredPreset: options.configuredPreset,
    configuredProvider: options.configuredProvider,
    configuredModel: options.configuredModel,
    provider: options.provider, model: options.model,
    notify,
    listPersisted: () => listSessionsSnapshot(ctx),
    createDetached: createDetachedHandle,
    sessionSwitchVetoed: (kind, sessionId) => core.sessionSwitch.sessionSwitchVetoed(kind, sessionId),
    adoptLive: target => adoptLiveAgent(target),
    resumeInto: (sessionId, kind, keepCurrent) => resumeInto(sessionId, kind, keepCurrent),
    backgroundCurrent: () => backgroundCurrentAction(),
    backgroundHandles,
  })

  // The injection callback may synchronously publish its initial list, so it
  // is installed only after the full action surface is ready (start).
  const startJobs = (): void => {
    if (typeof (ctx as { inject?: unknown }).inject === 'function') {
      ctx.inject(['jobs'], jobsCtx => {
        jobProjection.attach((jobsCtx as { jobs?: JobsRuntime }).jobs, dispose => jobsCtx.effect(() => dispose))
      })
    } else {
      jobProjection.attach((ctx as { get?: (name: string) => unknown }).get?.('jobs') as JobsRuntime | undefined)
    }
  }

  // Catalog/context services own their caches, registrations and async origin fences.
  const skillCatalog = createSkillCatalog(ctx, {
    owner,
    commandService,
    agent: () => binding.agent,
    cwd: () => state.cwd,
    setCommands(commands) {
      // Annotate before publishing: Help and `/` completion both read
      // `commandList`, so a command whose capability is missing says so
      // instead of looking usable and failing on use.
      state.commandList = annotateCommandCapabilities(commands, capabilitiesOf())
      state.emit()
    },
    commandDescriptions: name => commandTrees?.descriptions(name),
    // Attached-context pass-through: the skill catalog never loses the
    // FIFO/decision fence.
    deliverUserText: (text, placement, attach) => core.input.deliverUserText(text, placement, [], attach),
  })
  const { viewOptions: skillViewOptions, registryFor: skillRegistryFor, refreshCommands: refreshCommandList, refreshSkillCommands } = skillCatalog
  // Each helper captures binding/cwd at invocation, rather than receiving a
  // root-state bag. Its late completions are rejected by owner + binding.
  const reportActions = createReportActions(ctx, {
    owner,
    capture: () => binding.capture(),
    current: capture => binding.isCurrent(capture as ReturnType<typeof binding.capture>),
    cwd: () => state.cwd,
    model: () => state.model,
    provider: () => options.provider,
    contextWindow: () => state.contextWindow,
    sessionTitle: () => state.sessionTitle,
    runtime: adapterRuntime,
    grantStore: host.currentGrantStore,
  })
  const foreignBrowser = createForeignBrowser(() => ctx.get('sessionPersistence'), owner.signal)
  const sessionMetadataActions = createSessionMetadataActions(ctx, {
    owner,
    binding,
    provider: () => state.provider,
    model: () => state.model,
    emit: () => state.emit(),
    sessionTitle: () => state.sessionTitle,
    setSessionTitle: title => { state.sessionTitle = title },
    setSessionColor: color => { state.sessionColor = color },
    forgetAgentView: sessionId => agentView.forget(sessionId),
    setPersistedSessions: rows => agentView.setPersisted(rows),
    skillRegistryFor,
    skillViewOptions,
  })
  const loadedContext = createLoadedContextRefresher(ctx, {
    owner,
    agent: () => binding.agent,
    cwd: () => state.cwd,
    skillRegistryFor,
    skillViewOptions,
    publish(context) { state.loadedContext = context; state.emit() },
  })
  const refreshLoadedContext = loadedContext.refresh

  // Replay the durable transcript first, then follow live events. The same
  // seed re-populates the subagent dashboard's durable discovery facts
  // (`subagent/catalog`, workflow member edges) so a resumed session keeps
  // its dispatched-children history (issue #966). The seed is translated
  // synchronously by the bound session (adoption tails replay inside a
  // synchronous binding transaction, which the async `history()` cannot
  // serve); callers have already bound the session the seed belongs to.
  const replaySessionSeed = (events: readonly SessionEvent[]): void => {
    projector.apply(dshNative().translateReplay(events), { replay: true })
    subagentProjection.bootstrapFromLog(events)
  }
  replaySessionSeed(initialNative.rawHistory())
  projector.settleStreaming()
  // Attached to an idle agent: any replayed turn/start belongs to a previous
  // session run, so the spinner must not come up on boot.
  state.working = false
  state.cancelPending = false
  state.status = binding.agent.status
  state.emit()

  const modelActions = createModelActions(ctx, state, {
    owner,
    binding,
    selection,
    initialEffort: options.effort,
    agent: () => binding.agent,
    notify,
    checkContextWarning: core.bookkeeping.checkContextWarning,
  })

  // The first bind (start) and every adoption tail bind through the core
  // feed, which runs the DSH binding-events hooks below.
  const bindAgent = (): void => { core.feed.bind() }
  const clearStagedImages = core.input.clearStagedImages

  const switchModelAction = createModelSwitchAction(ctx, state, {
    owner,
    binding,
    rowIds,
    // Compaction is installed below before the channel binds or exposes input.
    settleCompaction: () => settleManualCompaction(),
    resetProjector: resetProjection,
    resetSubagents: subagentProjection.reset,
    resetJobs: jobProjection.reset,
    replay: replaySessionSeed,
    settleReplay: projector.settleStreaming,
    bindAgent: () => bindAgent(),
    refreshCommands: refreshCommandList,
    refreshLoadedContext,
    refreshSkillCommands,
    clearStagedImages,
    dropModelCompletion: () => modelActions.dropModelNodeCache(),
    notify,
  })

  const workspaceActions = createWorkspaceActions(state, {
    owner,
    service: workspaceService,
    // The guarded workspace handoff: the core's `/new` over this session's
    // DSH create path, with the target cwd.
    newSession: target => core.sessionSwitch.newSession(target),
    refreshGitBranch: () => core.refreshGitBranch(),
    notify,
  })

  // This is the one necessary cyclic seam: mode actions need the completed
  // state, while the state exposes their command surface. It is assigned
  // before the channel starts binding/session observation.
  const modeActions = createPermissionModeActions(ctx, state, {
    owner,
    runtime: adapterRuntime,
    binding,
    sessionModes,
    roster: permissionRoster,
    commandService,
    executeRegistryCommand,
    notify,
  })

  // Event subscription routing is a distinct binding owner. Its hooks run in
  // every core bind: owner-level child listeners once, then per binding the
  // activity seed, the model selection waterfalls and the raw subscribers.
  const bindingEvents = createBindingEvents(ctx, {
    owner,
    binding,
    state,
    seedActivity: options.seedActivity,
    seedContextOccupancy: options.seedContextOccupancy,
    inputConvergence: core.inputConvergence,
    selection,
    modelActions,
    modeActions,
    projector,
    subagents: subagentProjection,
    agentView,
    messageObserver,
    retireAttachment: core.input.retireAttachment,
  })

  const sessionAdoption = createSessionAdoption(state, {
    binding,
    rowIds,
    resetProjector: resetProjection,
    resetSubagents: subagentProjection.reset,
    resetJobs: jobProjection.reset,
    replay: replaySessionSeed,
    settleReplay: projector.settleStreaming,
    bindAgent,
    refreshCommands: refreshCommandList,
    refreshLoadedContext,
    refreshSkillCommands,
    clearStagedImages,
    touchSession,
  })
  const adoptForkedAgent = sessionAdoption.adoptForkedAgent

  adoptLiveAgent = createLiveAgentAdoption(state, {
    binding,
    openSession: (agent, handle) => createDshSession(ctx, { agent, handle }),
    backgroundHandles,
    rowIds,
    resetProjector: resetProjection,
    resetSubagents: subagentProjection.reset,
    restoreSubagents: subagentProjection.restore,
    parkSubagents: subagentProjection.park,
    resetJobs: jobProjection.reset,
    replay: replaySessionSeed,
    settleReplay: projector.settleStreaming,
    describeWorkspace: cwd => workspaceService.describe(cwd),
    refreshGitBranch: () => core.refreshGitBranch(),
    bindAgent,
    refreshCommands: refreshCommandList,
    refreshLoadedContext,
    refreshSkillCommands,
    clearStagedImages,
    resetIdeSelection: core.resetIdeSelection,
    notifySessionSwitched: core.sessionSwitch.notifySessionSwitched,
    notifyAgentView: agentView.notify,
  })

  const resumeActions = createSessionResumeActions(ctx, state, {
    configuredPreset: options.configuredPreset,
    configuredProvider: options.configuredProvider,
    configuredModel: options.configuredModel,
    provider: options.provider,
    model: options.model,
  }, {
    owner,
    binding,
    // `/resume` shares the live-adoption path with the session supervisor, so
    // a target already running in this process is re-attached rather than
    // resumed twice from its log (which would mount one log in two places).
    adoptLive: target => adoptLiveAgent(target),
    parkSubagents: subagentProjection.park,
    backgroundHandles,
    rowIds,
    resetProjector: resetProjection,
    resetSubagents: subagentProjection.reset,
    resetJobs: jobProjection.reset,
    replay: replaySessionSeed,
    settleReplay: projector.settleStreaming,
    describeWorkspace: cwd => workspaceService.describe(cwd),
    refreshGitBranch: () => core.refreshGitBranch(),
    bindAgent,
    refreshCommands: refreshCommandList,
    refreshLoadedContext,
    refreshSkillCommands,
    clearStagedImages,
    resetIdeSelection: core.resetIdeSelection,
    settleCompaction: () => settleManualCompaction(),
    sessionSwitchVetoed: core.sessionSwitch.sessionSwitchVetoed,
    notify,
    notifySessionSwitched: core.sessionSwitch.notifySessionSwitched,
    runtime: adapterRuntime,
  })
  resumeInto = resumeActions.resumeInto

  rewindToNodeAction = createTreeRewindAction(ctx, state, {
    owner,
    binding,
    settleCompaction: () => settleManualCompaction(),
    notify,
    adoptForkedAgent,
    notifySessionSwitched: core.sessionSwitch.notifySessionSwitched,
  })

  const rewindToAction = createRewindToAction(ctx, state, {
    owner,
    binding,
    settleCompaction: () => settleManualCompaction(),
    notify,
    adoptForkedAgent,
    notifySessionSwitched: core.sessionSwitch.notifySessionSwitched,
  })

  const forkSessionAction = createForkSessionAction(ctx, state, {
    owner,
    settleCompaction: () => settleManualCompaction(),
    notify,
    source: () => binding.agent.session,
    createDetachedHandle,
  })

  const manualCompaction = createManualCompaction(ctx, state, {
    owner,
    agent: () => binding.agent,
    withDecisionPending: core.input.withDecisionPending,
    notify,
  })
  settleManualCompaction = manualCompaction.settle
  backgroundCurrentAction = createBackgroundCurrentAction(ctx, state, {
    configuredPreset: options.configuredPreset,
    configuredProvider: options.configuredProvider,
    configuredModel: options.configuredModel,
    provider: options.provider,
    model: options.model,
  }, {
    owner,
    binding,
    backgroundHandles,
    rowIds,
    resetProjector: resetProjection,
    resetSubagents: subagentProjection.reset,
    parkSubagents: subagentProjection.park,
    resetJobs: jobProjection.reset,
    refreshEffortLevels: () => modelActions.refreshEffortLevels(),
    bindAgent,
    refreshCommands: refreshCommandList,
    refreshLoadedContext,
    refreshSkillCommands,
    clearStagedImages,
    notifySessionSwitched: core.sessionSwitch.notifySessionSwitched,
    notify: (...args) => notify(...args),
    notifyAgentView: agentView.notify,
  })

  // Every action a DSH session serves beyond the core's (the type keeps this
  // table complete: a new public action must be placed on one side).
  const delegates = {
    runPermissionPreset: modeActions.runPermissionPreset,
    rewindTo: rewindToAction,
    rewindToNode: rewindToNodeAction,
    forkSession: forkSessionAction,
    resumeTo: resumeActions.resumeTo,
    listWorkspaces: workspaceActions.listWorkspaces,
    listWorkspaceRegistry: workspaceActions.listWorkspaceRegistry,
    removeWorkspace: workspaceActions.removeWorkspace,
    renameWorkspaceAt: workspaceActions.renameWorkspaceAt,
    resolveWorkspace: workspaceActions.resolveWorkspace,
    switchWorkspace: workspaceActions.switchWorkspace,
    renameWorkspace: workspaceActions.renameWorkspace,
    workspaceCommands: workspaceActions.workspaceCommands,
    runWorkspaceCommand: workspaceActions.runWorkspaceCommand,
    switchModel: switchModelAction,
    listEfforts: modelActions.listEfforts,
    setEffort: modelActions.setEffort,
    setDefaultEffort: modelActions.setDefaultEffort,
    cycleMode: modeActions.cycleMode,
    listPresets: modelActions.listPresets,
    switchPreset: modelActions.switchPreset,
    listModels: modelActions.listModels,
    listProviders: modelActions.listProviders,
    invalidateModelCompletion: modelActions.dropModelNodeCache,
    listSkills: sessionMetadataActions.listSkills,
    describeCredential: sessionMetadataActions.describeCredential,
    balanceInfo: reportActions.balanceInfo,
    sideQuestion: sessionMetadataActions.sideQuestion,
    cachedSessions: sessionMetadataActions.cachedSessions,
    listSessions: sessionMetadataActions.listSessions,
    previewSession: sessionMetadataActions.previewSession,
    listForeignSources: foreignBrowser.listSources,
    listForeignSessions: foreignBrowser.listSessions,
    importForeignSession: foreignBrowser.importSession,
    bindApprovalStore: agentView.bindApprovalStore,
    agentViewRows: agentView.rows,
    subscribeAgentView: agentView.subscribe,
    dispatchBackgroundAgent: agentView.dispatch,
    stopBackgroundAgent: agentView.stop,
    attachToAgent: agentView.attach,
    peekAgentSession: agentView.peek,
    replyToAgent: agentView.reply,
    backgroundCurrent: agentView.backgroundCurrent,
    setResumeTarget: sessionMetadataActions.setResumeTarget,
    renameSession: sessionMetadataActions.renameSession,
    setSessionColor: sessionMetadataActions.setSessionColor,
    recapRecent: sessionMetadataActions.recapRecent,
    deleteSession: sessionMetadataActions.deleteSession,
    renameSessionTo: sessionMetadataActions.renameSessionTo,
    compact: manualCompaction.compact,
    cancelCompact: manualCompaction.cancel,
    runExternalCommand: externalCommands.invokeText,
    runExternalCommandOutcome: externalCommands.invoke,
    mcpStatus: reportActions.mcpStatus,
    exportSession: reportActions.exportSession,
    initWorkspace: reportActions.initWorkspace,
    doctorInfo: reportActions.doctorInfo,
    pluginsInfo: reportActions.pluginsInfo,
    listSubagents: dshLocal.listSubagents,
  } satisfies Omit<ChannelActionDelegates, CoreServedAction>

  core.extend({
    completions: { workspaceCommands: () => workspaceService.commands(), model: modelActions },
    bind: {
      ...bindingEvents.hooks,
      // Re-anchor the job projection after every bind: its event
      // subscription is deliberately owner-agnostic, so this is what makes
      // the /jobs roster follow a session switch immediately.
      afterBind: () => { jobProjection.reanchor() },
      resetTranslation: () => { binding.session.capabilities.native.dsh?.resetTranslation() },
    },
    newSession: resumeActions.newSessionOpener,
    delegates,
    start: {
      before() {
        agentView.start()
        owner.own(ctx.on('commands/change', () => { if (owner.current()) modeActions.refreshMode() }))
      },
      after() {
        startJobs()
        skillCatalog.start()
        void refreshLoadedContext()
      },
    },
  })

  // Subagents inherit provider/model from AgentOptions, but resumed TUI
  // agents can legitimately carry their route only in persisted request
  // headers. Their child scopes do not share this channel's per-agent
  // ModelSelectionRef, so fill an otherwise incomplete first request from
  // the active route. Keep complete child-specific routes authoritative.
  // Registered before the first bind's own `agent/request` listener.
  const disposeInheritedChildRoute = ctx.on('agent/request', async (_payload, next) => {
    // This listener intentionally serves child scopes, not the bound agent's
    // selection pipeline. Capture the foreground route before awaiting so an
    // old child waterfall cannot borrow a later binding's model (A→B→A safe).
    const capture = binding.capture()
    const provider = state.provider
    const model = state.model
    const resolved = await next()
    if (!owner.current() || !binding.isCurrent(capture)) return resolved
    if (
      typeof resolved.provider === 'string' && resolved.provider.length > 0 &&
      typeof resolved.model === 'string' && resolved.model.length > 0
    ) {
      return resolved
    }
    return { ...resolved, provider, model }
  })
  owner.own(disposeInheritedChildRoute)
}
