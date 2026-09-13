import { createSessionTreeReader } from './channel/session-tree.js'
import { createInputDelivery } from './channel/input-delivery.js'
import { createChannelBinding } from './channel/binding.js'
import { createChannelActivity } from './channel/activity.js'
import { createCommandCompletions } from './channel/command-completions.js'
import { createLocalActions } from './channel/local-actions.js'
import { createDetachedHandleFactory } from './channel/lifetime-resources.js'
import { createContextBookkeeping } from './channel/context-bookkeeping.js'
import { createChannelActionMethods, createChannelActionReadiness, type ChannelActionDelegates } from './channel/action-readiness.js'
import { createBindingEvents } from './channel/binding-events.js'
import { createInitialChannelView, type ChannelLaunchOptions } from './channel/state.js'
import { createChannelProjection } from './channel/projection.js'
import { createManualCompaction } from './channel/compaction.js'
import { createSessionAdoption } from './channel/session-adoption.js'
import { createRewindPromptAction } from './channel/session-actions.js'
import { createForkSessionAction } from './channel/session-fork.js'
import { createRewindToAction } from './channel/session-rewind.js'
import { createLiveAgentAdoption } from './channel/session-live-adoption.js'
import { createSessionResumeActions } from './channel/session-resume.js'
import { createTreeRewindAction } from './channel/session-tree-actions.js'
import { createModelActions } from './channel/model-actions.js'
import { createWorkspaceActions } from './channel/workspace-actions.js'
import { createModelSwitchAction } from './channel/model-switch.js'
import { createModeActions } from './channel/mode-actions.js'
import { createFileActions } from './channel/file-actions.js'
import { createReportActions } from './channel/reports.js'
import { createSessionMetadataActions } from './channel/session-metadata.js'
import { markChannelReadDirty } from '../adapter/channel/read-view.js'
import { createAgentViewProjection } from './channel/agent-view-projection.js'
import { createJobProjection } from './channel/job-projection.js'
import { createExternalCommandInvoker } from './channel/external-commands.js'
import { createLoadedContextRefresher } from './channel/loaded-context.js'
import { createSkillCatalog } from './channel/skill-catalog.js'
import { createBackgroundCurrentAction } from './channel/background-action.js'
import { createSubagentProjection } from './channel/subagent-projection.js'
import { createChannelNotifications } from './channel/notifications.js'
import type { Context } from '@deepseek-ai/cordis'
import { type Agent, type AgentHandle, type CreateAgentOptions, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import {
  createUserMessage,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { writeActivityFrames } from '../activityPrefs.js'
import { adapterRuntimeFor } from '../adapter/kernel/runtime-context.js'
import {
  assertCapabilityShadowPolicy,
} from '../adapter/kernel/runtime.js'
import { readGrantStore } from '../adapter/standard/grants.js'
import { HIDDEN_COMMAND_NAMES, isCommandCompletionToken, isLocalCommandName, LOCAL_COMMANDS, parseCommandName, type LocalCommand } from '../commands.js'
import { isPresetName } from '../components/activityFrames.js'
import { t, tOr, type Lang } from '../i18n.js'
import { readModelPref } from '../modelPrefs.js'
import { resolveModelRoute, validateModelRoute } from '../modelRoute.js'
import { readPresetPref } from '../presetPrefs.js'
import { readAgentViewSessions, touchAgentViewSession, touchSession } from '../sessionHistory.js'
import { DEFAULT_SESSION_MODES, resolveSessionModes, type SessionModeSpec } from '../sessionModes.js'
import { resolveDshProfileName } from '../update.js'
import { logForDebugging } from '../utils/debug.js'
import { channelCommands } from './channel/commands.js'
import { normalizeInputDecision, normalizeRewindDoneSummary, normalizeRewindPromptDecision, NOTICE_CELLS } from './channel/decisions.js'
import { createChannelEmitter } from './channel/emitter.js'
import { createInputActions, type InputConvergence } from './channel/input-actions.js'
import { createComposerImages } from './channel/composer-images.js'
import { snapshotLiveSessionEvents } from './compat/liveSession.js'
import { createPermissionModeRoster } from './channel/mode-roster.js'
import { createPermissionModeActions } from './channel/mode-permission-actions.js'
import { expandMentions, mentionAttachments, mentionFs } from './channel/mentions.js'
import { sessionCwdMatches } from './channel/paths.js'
import { legacyPermissionPresetSnapshot, permissionPresetSnapshotFromService, unavailablePermissionPresetSnapshot } from './channel/permissions.js'
import { createPreferences } from './channel/preferences.js'
import { createSettingsHosts } from './channel/settings-host.js'
import { createChannelOwner, registerChannelOwner } from './channel/owner.js'
import { ARGS_PREVIEW_LIMIT, foldBack, harnessToolResultView, LOCAL_OUTPUT_LIMIT, prepareReplayEvents, preview, RESULT_PREVIEW_LIMIT, toolErrorText } from './channel/transcript.js'
import type { ActivityStatus, AgentViewRow, Channel, ChannelGoal, ChannelImageBlock, ChannelState, ChatRow, CredentialStatus, EffortOption, JobControl, LoadedContextEntry, LoadedContextFile, LoadedContextSkill, LoadedContextTool, MentionFs, NotificationItem, PendingMessage, PresetOption, ResumeResult, StagedImageInput, SubagentControl, SubagentRow, TodoPanelItem, ToolCallView, ToolResultView, ToolsRegistryLike } from './channel/types.js'
import { estimateTokens, isTokenDelta, tokenDeltaChars, usageOutputTokens } from './channel/usage.js'
import { getHostCommandTrees } from './command-trees.js'
import { installDecisionGuard, markDecisionDispatchTopology } from './decision-guard.js'
import type {
  TuiRewindMode
} from './extension-events.js'
import { dispatchTuiDecision, dispatchTuiNotification, normalizeCancelDecision } from './extension-events.js'
import { getHostGrantStore } from './host-grants.js'
import type { JobsRuntime } from './jobs.js'
import { getHostMessageObserver, type TuiMessageObserverRuntime } from './message-observer.js'
import { composePreset, runningPresetOf, serviceForAgent } from './presets.js'
import { getHostRenderers, type TuiRendererRuntime } from './renderers.js'
import { cleanRenderText } from './sanitize.js'
import { getHostSceneRuntime, type TuiSceneRuntime } from './scenes.js'
import {
  listSummaries,
  noteBranch,
  type SessionSource,
  type SessionSummary
} from './sessions/index.js'
import {
  buildSessionTree,
  liveTailWindow,
  type FamilySession,
  type SessionTreeData,
} from './sessionTree.js'
import { getHostSettingsSections, getLocalSettingsSectionsHost, type TuiSettingsSection, type TuiSettingsSectionsRuntime } from './settings-sections.js'
import { SubagentActivityStore, type SubagentState } from './subagents.js'
import { getHostThemes, type TuiThemeRuntime } from './themes.js'
import { attachSessionToWorkspace } from './workspace.js'
import { createLocalWorkspaceRuntime, getHostWorkspaceRuntime, type TuiWorkspaceTarget } from './workspaces.js'
export type { SubagentState } from './subagents.js'

import { isSubagentToolName, parseJobOutputId, toolCommandOf, BACKGROUND_START_ACK, todoPanelItems } from './channel/projection-helpers.js'
/** Token buffer below the context window at which the context-low warning fires. */
const CONTEXT_WARNING_BUFFER_TOKENS = 20_000

/**
 * Read the persistence backend's full session list (empty without one) —
 * the agent view's "stopped" rows come from this snapshot.
 * @param ctx - The channel's context.
 * @returns Classified summaries, most recently active first.
 */
async function listSessionsSnapshot(ctx: Context): Promise<readonly SessionSummary[]> {
  const persistence = ctx.get('sessionPersistence') as SessionSource | undefined
  if (!persistence) return []
  return listSummaries(persistence)
}

/**
 * Create the live channel state for one agent session: replay the durable
 * transcript, subscribe to the agent's events, and expose every TUI action.
 * @internal
 * @param ctx - The plugin context; optional services are resolved via ctx.get.
 * @param initialAgent - The agent whose session the channel renders; rewinds,
 *   resumes, and model switches replace it.
 * @param options - Boot options: model route, cwd, provider, and the
 *   reasoning-effort / working-activity / agent-handle preferences.
 * @returns The live channel state, subscribed and ready to render.
 */
export function createChannel(
  ctx: Context,
  initialAgent: Agent,
  options: ChannelLaunchOptions,
): ChannelState {
  const owner = createChannelOwner()
  try {
    return createChannelWithOwner(ctx, initialAgent, options, owner)
  } catch (error) {
    // Setup is one transaction from the first acquired resource. Preserve the
    // construction failure while still attempting every registered rollback.
    try { owner.dispose() } catch { /* primary setup error remains authoritative */ }
    throw error
  }
}

function createChannelWithOwner(
  ctx: Context,
  initialAgent: Agent,
  options: ChannelLaunchOptions,
  owner: ReturnType<typeof createChannelOwner>,
): ChannelState {
  const rowIds = { value: 0 }
  const binding = createChannelBinding(initialAgent, options.handle, owner)
  // Detached work (/fork and agent-view dispatch) is owned until a caller
  // explicitly transfers the temporary handle to its destination ledger.
  const createDetachedHandle = createDetachedHandleFactory(owner)
  const adapterRuntime = adapterRuntimeFor(ctx)
  const themeHost = getHostThemes(ctx.get('tuiThemes') as TuiThemeRuntime | undefined)

  // Detached handles are a stable ledger shared with adoption actions. The
  // agent-view factory itself starts only after the full state surface exists.
  const backgroundHandles = new Map<string, AgentHandle>()
  let backgroundCurrentAction!: () => Promise<import('./channel/types.js').BackgroundResult>
  let agentView!: ReturnType<typeof createAgentViewProjection>
  let unsubscribeScenes: (() => void) | undefined

  // D-7 backstop: the extensions row installs the decision-subscription
  // gate, but the channel IS the dispatch path — a stale patch without that
  // row (or a bare embed mounting neither) would otherwise leave tui/input
  // & friends subscribable by default, silently voiding the default-deny
  // posture. Idempotent per cordis root, so the full-patch path installs
  // exactly once whichever side runs first. One store instance serves both
  // the gate and the invoke checkpoint below.
  // Keep a private fallback for bare embedders, but resolve the host-owned
  // store on every operation so a plugin-host row mounted later (or a custom
  // live GrantStore) is not shadowed by an early snapshot.
  const fallbackGrantStore = readGrantStore(undefined, undefined, adapterRuntime)
  const currentGrantStore = (): ReturnType<typeof readGrantStore> =>
    getHostGrantStore(ctx.get('tuiPluginHost')) ?? fallbackGrantStore
  installDecisionGuard(ctx, currentGrantStore())
  // The channel is the real DecisionEvents dispatch path. Record that
  // topology so the live driver can distinguish "guard installed" (not a
  // live feature) from "events can actually be dispatched here". The
  // returned disposer is owned by this channel's Cordis lifecycle below.
  const unmarkDecisionTopology = markDecisionDispatchTopology(ctx)
  // This marker is effectful topology state, so own it at acquisition. A
  // later setup failure must roll it back without waiting for final wiring.
  owner.own(unmarkDecisionTopology)
  // Subagent projection owns the child store, transcript row identity and
  // stream batching. Transport subscriptions below only route scoped events.
  const subagentProjection = createSubagentProjection(() => state, {
    rowIds,
    agent: () => binding.agent,
    subagents: () => (ctx as { get(name: string): unknown }).get('subagents') as { interrupt?(target: string, reason: unknown): void } | undefined,
    lookupChild: id => {
      const agents = ctx.get('agents') as { get(id: string): { session?: unknown; options?: { provider?: string; model?: string } } | undefined } | undefined
      return agents?.get(id)
    },
  })
  const subagentStore = subagentProjection.store
  const subagentControl = subagentProjection.control
  const pendingTaskDescriptions = subagentProjection.pendingTaskDescriptions
  // Job projection owns registry callbacks and transcript rows. The optional
  // service attachment has no authority after its injected lifetime ends.
  const jobProjection = createJobProjection(() => state, {
    owner, notify: (...args) => notify(...args), rowIds, agent: () => binding.agent, steer: text => channelCommands(state).steer(text),
  })
  const jobStore = jobProjection.store
  const jobControl = jobProjection.control
  const attachJobs = jobProjection.attach
  const resetJobProjection = jobProjection.reset


  // The DSH slash-command registry (optional service): /plan, /goal and
  // friends register here; the TUI merges their descriptors into the slash
  // menu and dispatches through `execute` (which logs the paired
  // command/run + command/done records). Absent the service, only the
  // built-in local commands exist.
  const commandService: CommandRuntime | undefined = ctx.get('commands')
  // messages.observe broker (optional service, C-042): mounted by the
  // dsh-tui-plugin-host row; absent the row, publish is a no-op and nothing
  // else changes (soft degradation, #183).
  const messageObserver = getHostMessageObserver(
    ctx.get('tuiMessageObserver') as TuiMessageObserverRuntime | undefined,
  )
  // Workspace registry runtime (optional service, issue #183): mounted by
  // the bundle patch's dsh-tui-workspaces row; absent the row (stale patch
  // or a bare embedder), degrade to the local-only runtime. plugin.ts owns
  // the degraded-boot warning for profile launches.
  const workspaceService = getHostWorkspaceRuntime(ctx.get('tuiWorkspaces')) ?? createLocalWorkspaceRuntime()
  const commandTrees = getHostCommandTrees(ctx.get('tuiCommandTrees'))
  // The `/settings` screen reads its host on EVERY render, so the host must
  // be a stable object: a fresh literal per call would re-fire the screen's
  // host-keyed effects endlessly (render → new host → effect → state →
  // render). The underlying services are fixed for the channel's lifetime,
  // so compute once and cache.
  // Plugin scene runtime (optional service, same degradation rule as
  // tuiWorkspaces/tuiCommandTrees): mounted by the bundle patch's
  // dsh-tui-scenes row; absent the row, `pluginScene` simply stays undefined.
  const sceneRuntime = getHostSceneRuntime(ctx.get('tuiScenes') as TuiSceneRuntime | undefined)
  // Falls back to the in-package local host when the composition's service
  // row is unavailable (issue #557: the row can be disposed right after
  // load in real compositions); the TUI's own section registers there.
  const settingsSectionsRuntime = getHostSettingsSections(
    ctx.get('tuiSettingsSections') as TuiSettingsSectionsRuntime | undefined,
  ) ?? getLocalSettingsSectionsHost(ctx)
  // Custom-entry text renderers (optional service, dsh-tui-extensions row):
  // absent the row, unknown plugin event types stay invisible in the
  // transcript, exactly as before the seam existed.
  const rendererRuntime = getHostRenderers(ctx.get('tuiRenderers') as TuiRendererRuntime | undefined)
  // Shift+Tab session-mode cycle: cordis.yml `modes` wins; absent/empty/
  // atom-less → the built-in default/plan/full cycle (sessionModes.ts).
  // Configured entries may additionally pin a durable `permission` preset
  // identity (permission + plan allowed; permission + sandbox/approval is
  // contradictory and dropped with a warning).
  const { modes: resolvedConfiguredSessionModes, dropped: droppedModeIds } = resolveSessionModes(options.modes)
  const invalidConfiguredPermissionIds = resolvedConfiguredSessionModes
    .filter(spec => spec.permission !== undefined && !isCommandCompletionToken(spec.permission))
    .map(spec => spec.id)
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
  const emitter = createChannelEmitter(() => state, () => subagentProjection.flush())
  // The emitter is created before the complete state surface exists. Put it
  // in the construction rollback funnel immediately; normal release remains
  // idempotent through the same disposer.
  owner.own(() => emitter.dispose())
  // foldRows incremental cursor (see foldRows): rows only append past the
  // fold line, so each pass touches only newly-eligible rows.
  const foldCursor: { rows: unknown; index: number } = { rows: null, index: 0 }
  const notify: ChannelState['notify'] = (...args) => {
    if (!owner.current()) return () => undefined
    return channelCommands(state).notify(...args)
  }
  const bookkeeping = createContextBookkeeping(
    () => state,
    (text, options) => notify(text, options),
    percent => t('context-low-warning', { percent }),
    CONTEXT_WARNING_BUFFER_TOKENS,
  )
  const { warning: contextWarning, resetContextWarning, checkContextWarning, trackPending, untrackPending } = bookkeeping
  const composer = createComposerImages(ctx, owner, { generation: () => state.agentBindingGeneration })
  const inputDelivery = createInputDelivery(ctx, owner, binding, () => state,
    (...args) => notify(...args), trackPending, untrackPending, composer)
  const { dispatchUserText, deliverUserText, withDecisionPending, clearStagedImages } = inputDelivery
  /**
   * The `tui/session-switch` decision event (pi's `session_before_switch`),
   * fired before `/new` or `/resume` replaces the live session (rewind has
   * its own prompt event). The first answering plugin may veto the switch;
   * the reason is toasted here so the fallback string stays host-localized.
   */
  const sessionSwitchVetoed = async (kind: 'new' | 'resume' | 'agent-view', targetSessionId?: string): Promise<boolean> => {
    // D-6 stale detection captures the AGENT REFERENCE (session ids are
    // reusable — ABA): a slow decision must not let an older /resume roll
    // over a newer session the user already switched to mid-await.
    const originAgent = binding.agent
    const decision = await withDecisionPending('tui/session-switch', dispatchTuiDecision(ctx, 'tui/session-switch', {
      kind,
      ...(targetSessionId === undefined ? {} : { targetSessionId }),
      sessionId: state.agentId,
      cwd: state.cwd,
    }, normalizeCancelDecision))
    if (binding.agent !== originAgent) {
      // The world changed while the decision parked: drop the pending
      // switch instead of replacing the user's newer session.
      notify(t('ext-stale-dropped'), { color: 'warning', timeoutMs: 4000 })
      return true
    }
    if (decision !== undefined) {
      notify(decision.reason ?? t('ext-action-cancelled'), { color: 'warning', timeoutMs: 4000 })
      return true
    }
    return false
  }
  /** Fire-and-forget `tui/session-switched` (parallel): per-session plugin
   *  state rebinds here. Listener failures are logged, never propagated —
   *  the switch itself already succeeded. */
  const notifySessionSwitched = (kind: 'new' | 'resume' | 'rewind' | 'fork' | 'agent-view' | 'background', sessionId: string, previousSessionId: string): void => {
      try {
        void dispatchTuiNotification(ctx, 'tui/session-switched', { kind, sessionId, previousSessionId, cwd: state.cwd }).catch((error: unknown) => {
          ctx.logger.warn('dsh-tui: tui/session-switched listener failed: %o', error)
        })
    } catch (error) {
      // A bare embedder's context may lack the event bus entirely; the
      // switch itself already succeeded, so this stays a log line.
      ctx.logger.warn('dsh-tui: tui/session-switched dispatch failed: %o', error)
    }
  }

  /**
   * Swap the live agent for a freshly created fork (rewindTo and the session
   * tree's rewindToNode share this tail): reset every session-scoped
   * projection, replay the fork's seed into a fresh transcript (tokens/
   * spinner counters land back at the rewind point, matching the fork),
   * rebind subscriptions to the new agent, and free the replaced handle.
   * Returns the source session's id (for the session-switched notification).
   */
  // Installed after ChannelState initialization. The action surface is inert
  // during construction, then delegates its synchronous adoption tail to the
  // binding-owned session-adoption module.
  let adoptForkedAgent!: (
    handle: AgentHandle,
    capture: ReturnType<typeof binding.capture>,
    seed: readonly SessionEvent[],
    agentPreset: string | undefined,
    childId: SessionId,
  ) => string
  /** Monotonic token: only the latest `interruptAndDeliver` re-queues, so a
   *  second interrupt while the abort settles cannot double-deliver. */
  const inputConvergence: InputConvergence = { interruptSeq: 0, cancelInFlight: false }
  // Cancellation is asynchronous: a fast second Esc can arrive after the
  // driver has accepted the first abort but before its turn/end event lands.
  // Do not cancel the same driver twice, or the second cancel can swallow the
  // replacement work queued by interruptAndDeliver and leave the UI gated on
  // a working flag that has not observed turn/end yet.

  // Model selection is installed by bindAgent; route/effort state is owned by model-actions.
  const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
  // Model/effort/preset actions are composed after state construction.
  // Registry command policy and rc.8 image encoding are an owner-scoped module.
  const externalCommands = createExternalCommandInvoker(ctx, {
    commandService,
    runtime: adapterRuntime,
    agent: () => binding.agent,
    capture: () => binding.capture(),
    bindingCurrent: capture => binding.isCurrent(capture as ReturnType<typeof binding.capture>),
    allows: (subject, permission, scope) => currentGrantStore().allows(subject, permission, scope),
    composer,
    attachments: () => mentionAttachments(ctx),
    notify: (...args) => notify(...args),
  })
  const executeRegistryCommand = externalCommands.invokeText

  // Durable mode folds/transitions are composed after state construction.
  // Model/preset completion caches are owned by model-actions.ts.

  // Session actions close over these inert placeholders. They are explicitly
  // installed after ChannelState initialization below.
  let settleManualCompaction!: () => Promise<void>
  let compactManualSession!: () => void
  let forkSessionAction!: () => Promise<boolean>
  let rewindToAction!: (row: ChatRow, mode?: string | null) => Promise<string | null>
  let rewindToNodeAction!: (sessionId: string, seq: number, mode?: 'rewind' | 'fork') => Promise<string | null>
  let resumeToAction!: (sessionId: string) => Promise<ResumeResult>
  let newSessionAction!: () => Promise<boolean>
  let resumeInto!: (sessionId: string, kind: 'resume' | 'agent-view', keepCurrent: boolean) => Promise<ResumeResult>
  let adoptLiveAgent!: (target: Agent) => Promise<ResumeResult>

  // This is the one necessary cyclic seam: mode actions need the completed
  // state, while the state exposes their command surface. It is assigned before
  // the channel starts binding/session observation.
  let modeActions: ReturnType<typeof createPermissionModeActions>
  let modelActions: ReturnType<typeof createModelActions>
  let workspaceActions: ReturnType<typeof createWorkspaceActions>
  let switchModelAction: (provider: string, model: string) => Promise<boolean>
  let fileActions: ReturnType<typeof createFileActions>
  let reportActions: ReturnType<typeof createReportActions>
  let sessionMetadataActions: ReturnType<typeof createSessionMetadataActions>
  let localActions!: ReturnType<typeof createLocalActions>
  let commandCompletions!: (input: string) => readonly import('../commands.js').CommandCompletion[]
  const actionReadiness = createChannelActionReadiness()
  const getReadyActions = (): ChannelActionDelegates => {
    owner.assertActive()
    return actionReadiness.getReadyActions()
  }
  const actionMethods = createChannelActionMethods(getReadyActions)

  const state: ChannelState = {
    ...createInputActions(() => state, () => binding.agent, owner, inputConvergence,
      composer,
      (text, placement, images) => dispatchUserText(text, placement, images),
      (command, includeInContext) => getReadyActions().runLocalCommand(command, includeInContext)),
    subscribe: emitter.subscribe,
    emit: emitter.emit,
    emitStream: emitter.emitStream,
    ...createSettingsHosts(ctx, owner.assertActive),
    ...createPreferences(() => state),
    get autoRecapOnOpen(): boolean {
      const settings = ctx.get('settings') as
        | { describe(options?: { redactSecrets?: boolean }): readonly { ns: string; value: unknown }[] }
        | undefined
      if (settings === undefined) return false
      const ns = settings.describe({ redactSecrets: true }).find(entry => entry.ns === 'dsh-tui')
      return (ns?.value as Record<string, unknown> | undefined)?.recapOnOpen !== false
    },
    ...createInitialChannelView(options, {
      agentId: binding.agent.id,
      mode: sessionModes[0]!,
      cwdDescription: workspaceService.describe(options.cwd).description ?? options.cwd,
    }),
    commandList: LOCAL_COMMANDS,
    ...actionMethods,
    subagentControl,
    jobControl,
    stagedImageGeneration: composer.stagedImageGeneration,
    stageImage: composer.stageImage,
    stageComposerImage: composer.stageComposerImage,
    hasStagedImage: composer.hasStagedImage,
    discardStagedImage: composer.discardStagedImage,
    stagedImage: composer.stagedImage,
    stagedImageLimits: composer.stagedImageLimits,
    /**
     * The `tui/rewind-prompt` decision event (pi's `session_before_fork`):
     * fired when the rewind picker confirms a message, before any fork
     * work. The first answering plugin may cancel the rewind (the picker
     * stays open; the reason is toasted here so the UI string stays
     * host-localized when absent) or offer extra modes rendered in the
     * confirm pane. Returns 'cancel', the modes, or null for "no opinion".
     */
    promptRewind: createRewindPromptAction(ctx, {
      agent: () => binding.agent,
      state: () => state,
      withDecisionPending,
      notify,
    }),
    buildSessionTree: createSessionTreeReader(ctx, binding, () => state.cwd, (...args) => notify(...args), owner),
    notify: createChannelNotifications(() => state, owner),
    permissionPresets() {
      let service: unknown
      try {
        service = ctx.get('permissionPresets')
      } catch {
        return unavailablePermissionPresetSnapshot()
      }
      if (service === undefined) return legacyPermissionPresetSnapshot(state.mode.sandbox)
      return permissionPresetSnapshotFromService(service, binding.agent.session)
    },
    settingsSections(): readonly TuiSettingsSection[] {
      return settingsSectionsRuntime?.list() ?? []
    },
    subscribeSettingsSections(listener: () => void): () => void {
      return emitter.subscribe(listener)
    },
    pluginScene: sceneRuntime?.active,
    openPluginScene(id: string) {
      return sceneRuntime?.open(id) ?? false
    },
    closePluginScene() {
      sceneRuntime?.close()
    },
    releaseContributions() {
      // Owner cleanup is exhaustive, but it can report an external cleanup
      // failure. The local emitter is outside that owner and must still stop.
      try { owner.dispose() } finally { emitter.dispose() }
    },
    traceEvents() {
      // Immutable per-append snapshot (dsh-session caches the frozen array);
      // reads follow agent swaps (/resume /rewind /new) automatically.
      return snapshotLiveSessionEvents(binding.agent.session)
    },
  }

  // Register the raw state before any specialist can synchronously publish a
  // callback. The renderer lease binds its external authority later, but this
  // owner already makes teardown and construction failure fail closed.
  registerChannelOwner(state, owner)

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
    sessionSwitchVetoed: (kind, sessionId) => sessionSwitchVetoed(kind, sessionId),
    adoptLive: target => adoptLiveAgent(target),
    resumeInto: (sessionId, kind, keepCurrent) => resumeInto(sessionId, kind, keepCurrent),
    backgroundCurrent: () => backgroundCurrentAction(),
    backgroundHandles,
  })

  // The injection callback may synchronously publish its initial list, so it
  // is installed only after the full action surface is ready below.
  const startJobs = (): void => {
    if (typeof (ctx as { inject?: unknown }).inject === 'function') {
      ctx.inject(['jobs'], jobsCtx => {
        attachJobs((jobsCtx as { jobs?: JobsRuntime }).jobs, dispose => jobsCtx.effect(() => dispose))
      })
    } else {
      attachJobs((ctx as { get?: (name: string) => unknown }).get?.('jobs') as JobsRuntime | undefined)
    }
  }

  // Catalog/context services own their caches, registrations and async origin fences.
  const skillCatalog = createSkillCatalog(ctx, {
    owner,
    commandService,
    agent: () => binding.agent,
    cwd: () => state.cwd,
    setCommands(commands) { state.commandList = commands; state.emit() },
    commandDescriptions: name => commandTrees?.descriptions(name),
    deliverUserText,
  })
  const skillViewOptions = skillCatalog.viewOptions
  const skillRegistryFor = skillCatalog.registryFor
  const refreshCommandList = skillCatalog.refreshCommands
  const refreshSkillCommands = skillCatalog.refreshSkillCommands
  const releaseSkillCommands = skillCatalog.release
  // Each helper captures binding/cwd at invocation, rather than receiving a
  // root-state bag. Its late completions are rejected by owner + binding.
  fileActions = createFileActions({
    owner,
    capture: () => binding.capture(),
    current: capture => binding.isCurrent(capture as ReturnType<typeof binding.capture>),
    cwd: () => state.cwd,
    fs: () => ctx.get('fs') as MentionFs | undefined,
  })
  reportActions = createReportActions(ctx, {
    owner,
    capture: () => binding.capture(),
    current: capture => binding.isCurrent(capture),
    cwd: () => state.cwd,
    model: () => state.model,
    provider: () => options.provider,
    contextWindow: () => state.contextWindow,
    sessionTitle: () => state.sessionTitle,
    runtime: adapterRuntime,
    grantStore: currentGrantStore,
  })
  sessionMetadataActions = createSessionMetadataActions(ctx, {
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
  const startRuntimeSubscriptions = (): void => {
    owner.own(ctx.on('commands/change', () => { if (owner.current()) modeActions.refreshMode() }))
    owner.own(settingsSectionsRuntime?.subscribe(() => { if (owner.current()) state.emit() }) ?? (() => undefined))
    const disposeScenes = sceneRuntime?.subscribe(() => {
      if (state.pluginScene === sceneRuntime.active) return
      state.pluginScene = sceneRuntime.active
      state.emit()
    })
    if (disposeScenes !== undefined) {
      unsubscribeScenes = disposeScenes
      owner.own(() => {
        if (unsubscribeScenes !== disposeScenes) return
        unsubscribeScenes = undefined
        disposeScenes()
      })
    }
  }
  const bash = ctx.get('shell') as {
    resolve(request: { command: string; workdir?: string; timeoutMs: number }): { command: string; timeoutMs: number }
    run(spec: { command: string; timeoutMs: number }): Promise<{ stdout: { text: string }; stderr: { text: string }; timedOut: boolean }>
  } | undefined

  const projector = createChannelProjection(state, {
    agent: () => binding.agent, rowIds, resetContextWarning, pendingTaskDescriptions, jobs: jobStore, inputConvergence,
    checkContextWarning, notify: (...args) => notify(...args),
    tools: ctx.get('tools') as ToolsRegistryLike | undefined, renderer: rendererRuntime,
    attachments: () => ctx.get('attachments'),
  })
  localActions = createLocalActions({
    ctx,
    owner,
    binding,
    state,
    rowIds,
    projector,
    subagents: subagentProjection,
    jobs: jobProjection,
    foldBack,
    workspace: workspaceService,
    shell: bash,
    notify,
  })

  // Replay the durable transcript first, then follow live events.
  projector.replayEvents(snapshotLiveSessionEvents(binding.agent.session))
  projector.settleStreaming()
  // Attached to an idle agent: any replayed turn/start belongs to a previous
  // session run, so the spinner must not come up on boot.
  state.working = false
  state.cancelPending = false
  state.status = binding.agent.status
  state.emit()

  // The activity sidecar owns its tracker and interval; it never projects transcript facts.
  const activity = createChannelActivity(ctx, state, owner, options.activity !== false)

  modelActions = createModelActions(ctx, state, {
    owner,
    binding,
    selection,
    initialEffort: options.effort,
    agent: () => binding.agent,
    notify,
  })

  commandCompletions = createCommandCompletions({
    state: () => state,
    themeHost,
    commandTrees,
    workspaceCommands: () => workspaceService.commands(),
    model: modelActions,
  })

  switchModelAction = createModelSwitchAction(ctx, state, {
    owner,
    binding,
    rowIds,
    // Compaction is installed below before the channel binds or exposes input.
    settleCompaction: () => settleManualCompaction(),
    resetProjector: () => projector.reset(),
    resetSubagents: subagentProjection.reset,
    resetJobs: resetJobProjection,
    replay: events => projector.replayEvents(events),
    settleReplay: projector.settleStreaming,
    bindAgent: () => bindAgent(),
    refreshCommands: refreshCommandList,
    refreshLoadedContext,
    refreshSkillCommands,
    clearStagedImages,
    dropModelCompletion: () => modelActions.dropModelNodeCache(),
    onModelSwitch: model => activity.onModelSwitch(model),
    notify,
  })

  workspaceActions = createWorkspaceActions(state, {
    owner,
    service: workspaceService,
    // This reference is intentionally lazy: session construction is installed
    // later, before any UI action can invoke workspace switching.
    newSession: target => resumeActions.newSessionWithTarget(target),
    refreshGitBranch: () => refreshGitBranch(),
    notify,
  })

  modeActions = createPermissionModeActions(ctx, state, {
    owner,
    runtime: adapterRuntime,
    binding,
    sessionModes,
    roster: permissionRoster,
    commandService,
    executeRegistryCommand,
    notify,
  })

  // Event subscription routing is a distinct binding owner. It captures the
  // live binding generation through binding.subscribe and refuses retained
  // callbacks after owner revocation; projection remains single-writer.
  const bindingEvents = createBindingEvents(ctx, {
    owner,
    binding,
    state,
    activity,
    inputConvergence,
    selection,
    modelActions,
    modeActions,
    projector,
    subagents: subagentProjection,
    agentView,
    messageObserver,
  })
  const bindAgent = bindingEvents.bind

  const sessionAdoption = createSessionAdoption(state, {
    binding,
    rowIds,
    resetProjector: () => projector.reset(),
    resetSubagents: subagentProjection.reset,
    resetJobs: resetJobProjection,
    replay: events => projector.replayEvents(events),
    settleReplay: projector.settleStreaming,
    bindAgent,
    refreshCommands: refreshCommandList,
    refreshLoadedContext,
    refreshSkillCommands,
    clearStagedImages,
    touchSession,
  })
  adoptForkedAgent = sessionAdoption.adoptForkedAgent

  adoptLiveAgent = createLiveAgentAdoption(state, {
    binding,
    backgroundHandles,
    rowIds,
    resetProjector: () => projector.reset(),
    resetSubagents: subagentProjection.reset,
    resetJobs: resetJobProjection,
    replay: events => projector.replayEvents(events),
    settleReplay: projector.settleStreaming,
    describeWorkspace: cwd => workspaceService.describe(cwd),
    refreshGitBranch: () => refreshGitBranch(),
    bindAgent,
    refreshCommands: refreshCommandList,
    refreshLoadedContext,
    refreshSkillCommands,
    clearStagedImages,
    notifySessionSwitched,
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
    backgroundHandles,
    rowIds,
    resetProjector: () => projector.reset(),
    resetSubagents: subagentProjection.reset,
    resetJobs: resetJobProjection,
    replay: events => projector.replayEvents(events),
    settleReplay: projector.settleStreaming,
    describeWorkspace: cwd => workspaceService.describe(cwd),
    refreshGitBranch: () => refreshGitBranch(),
    bindAgent,
    refreshCommands: refreshCommandList,
    refreshLoadedContext,
    refreshSkillCommands,
    clearStagedImages,
    settleCompaction: () => settleManualCompaction(),
    sessionSwitchVetoed,
    notify,
    notifySessionSwitched,
    runtime: adapterRuntime,
  })
  resumeInto = resumeActions.resumeInto
  resumeToAction = resumeActions.resumeTo
  newSessionAction = resumeActions.newSession

  rewindToNodeAction = createTreeRewindAction(ctx, state, {
    owner,
    binding,
    settleCompaction: () => settleManualCompaction(),
    notify,
    adoptForkedAgent,
    notifySessionSwitched,
  })

  rewindToAction = createRewindToAction(ctx, state, {
    owner,
    binding,
    settleCompaction: () => settleManualCompaction(),
    notify,
    adoptForkedAgent,
    notifySessionSwitched,
  })

  forkSessionAction = createForkSessionAction(ctx, state, {
    owner,
    settleCompaction: () => settleManualCompaction(),
    notify,
    source: () => binding.agent.session,
    createDetachedHandle,
  })

  const manualCompaction = createManualCompaction(ctx, state, {
    owner,
    agent: () => binding.agent,
    withDecisionPending,
    notify,
    onComplete: () => activity.onCompact(),
  })
  settleManualCompaction = manualCompaction.settle
  compactManualSession = manualCompaction.compact
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
    resetProjector: () => projector.reset(),
    resetSubagents: subagentProjection.reset,
    resetJobs: resetJobProjection,
    refreshEffortLevels: () => modelActions.refreshEffortLevels(),
    bindAgent,
    refreshCommands: refreshCommandList,
    refreshLoadedContext,
    refreshSkillCommands,
    clearStagedImages,
    notifySessionSwitched,
    notify: (...args) => notify(...args),
    notifyAgentView: agentView.notify,
  })

  // Complete the entire public action surface before any callback, catalog,
  // registry, binding, or timer can run. The state methods above are typed,
  // pure delegates through this one readiness cell; no successful-looking
  // construction placeholder remains callable.
  actionReadiness.install({
    commandCompletions,
    runLocalCommand: localActions.runLocalCommand,
    runPermissionPreset: modeActions.runPermissionPreset,
    loadOlder: localActions.loadOlder,
    rewindTo: rewindToAction,
    rewindToNode: rewindToNodeAction,
    forkSession: forkSessionAction,
    resumeTo: resumeToAction,
    newSession: newSessionAction,
    listWorkspaces: workspaceActions.listWorkspaces,
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
    clear: localActions.clear,
    setActivityFrames: localActions.setActivityFrames,
    listPresets: modelActions.listPresets,
    switchPreset: modelActions.switchPreset,
    listModels: modelActions.listModels,
    listProviders: modelActions.listProviders,
    invalidateModelCompletion: modelActions.dropModelNodeCache,
    listSkills: sessionMetadataActions.listSkills,
    describeCredential: sessionMetadataActions.describeCredential,
    balanceInfo: reportActions.balanceInfo,
    sideQuestion: sessionMetadataActions.sideQuestion,
    listFileCandidates: fileActions.listFileCandidates,
    listFiles: fileActions.listFiles,
    listSessions: sessionMetadataActions.listSessions,
    previewSession: sessionMetadataActions.previewSession,
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
    compact: compactManualSession,
    runExternalCommand: externalCommands.invokeText,
    runExternalCommandOutcome: externalCommands.invoke,
    pushLocal: localActions.pushLocal,
    mcpStatus: reportActions.mcpStatus,
    exportSession: reportActions.exportSession,
    initWorkspace: reportActions.initWorkspace,
    doctorInfo: reportActions.doctorInfo,
    pluginsInfo: reportActions.pluginsInfo,
    listSubagents: localActions.listSubagents,
  })

  // Subagents inherit provider/model from AgentOptions, but resumed TUI
  // agents can legitimately carry their route only in persisted request
  // headers. Their child scopes do not share this channel's per-agent
  // ModelSelectionRef, so fill an otherwise incomplete first request from
  // the active route. Keep complete child-specific routes authoritative.
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
  try {
    // Everything below can synchronously invoke external callbacks. It runs
    // only after the owner is registered and the complete delegate surface is
    // installed; the outer construction transaction rolls every step back.
    agentView.start()
    startRuntimeSubscriptions()
    startJobs()
    skillCatalog.start()
    void refreshLoadedContext()
    bindAgent()
  } catch (error) {
    // Keep the setup failure primary. The outer construction funnel attempts
    // every cleanup, including partial subscriptions from this exact step.
    throw error
  }
  // Cordis owns the Channel lifetime. Rebinding handles the common case;
  // this effect closes the final timer and releases the DecisionEvents
  // dispatch-topology marker when the Channel's context unloads.
  const effect = (ctx as Context & {
    effect?: (setup: () => () => void, label?: string) => void
  }).effect
  effect?.call(ctx, () => () => {
    // The context owns the complete Channel lifetime, not merely the skill
    // command contribution. Keep emitter teardown in the same finally funnel.
    state.releaseContributions()
  }, 'dsh-tui channel lifecycle')
  // Statusline breadcrumb: current git branch of the session cwd (best-effort).
  // Re-run when an agent swap adopts a different persisted cwd (/resume,
  // issue #96) so the breadcrumb never shows the previous workspace's branch.
  const refreshGitBranch = () => {
    state.gitBranch = undefined
    if (!bash) return
    // Capture the requested cwd: a /resume landing while this query is in
    // flight refreshes the branch for the NEW cwd, so a late reply from the
    // old workspace must be dropped (statusline staleness, issue #96 review).
    const requestedCwd = state.cwd
    void bash
      .run(
        bash.resolve({
          command: 'git branch --show-current',
          workdir: requestedCwd,
          timeoutMs: 3000,
        }),
      )
      .then((result) => {
        if (!owner.current() || state.cwd !== requestedCwd) return
        const branch = result.stdout.text.trim()
        if (branch !== '') {
          state.gitBranch = branch
          // Note it against the session too. A session log records no branch,
          // and nothing can reconstruct one after the fact, so the browser can
          // only show a branch for sessions this install actually used — which
          // is exactly what the column claims.
          noteBranch(binding.agent.session.id, branch)
          // Feed the working line so git tools can show ` · git <branch>`.
          activity.onGitBranch(branch)
          state.emit()
        }
      })
      .catch(() => {
        // Git branch detection is best-effort; on Windows the sandbox
        // backend may be unavailable (no confinement yet) or the cwd may
        // not be a git repo. Either way the statusline simply stays blank.
      })
  }
  refreshGitBranch()

  return state
}

export type { ChannelLaunchOptions } from './channel/state.js'
export { expandMentions } from './channel/mentions.js'
export { sessionCwdMatches } from './channel/paths.js'
export type { ActivityStatus, AgentViewDispatchResult, AgentViewRow, AgentViewStatus, BackgroundResult, Channel, ChannelGoal, ChannelState, ChatRow, ComposerImageRef, ComposerSubmission, CredentialStatus, EffortOption, ExternalCommandOutcome, JobControl, JobRow, LoadedContext, LoadedContextEntry, LoadedContextFile, LoadedContextSkill, LoadedContextTool, MentionAttachments, MentionExpansion, MentionFs, NotificationItem, PendingMessage, PermissionPresetAvailability, PermissionPresetCurrent, PermissionPresetOption, PermissionPresetSnapshot, PresetOption, ResumeResult, SkillInfo, StagedImageHandle, StagedImageInput, SubagentControl, SubagentRow, TodoPanelItem, TokenBucket, TokenUsage, ToolCallView, ToolFileDiff, ToolResultView, ToolRow, ToolViewPresenter, TranscriptImage } from './channel/types.js'
export { emptyTokenUsage } from './channel/usage.js'
