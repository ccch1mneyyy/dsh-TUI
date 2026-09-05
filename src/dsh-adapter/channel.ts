import { createSessionTreeReader } from './channel/session-tree.js'
import { createInputDelivery } from './channel/input-delivery.js'
import { createChannelBinding } from './channel/binding.js'
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
import { installModelSelection, type Agent, type AgentHandle, type CreateAgentOptions, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import {
  createUserMessage,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { featureOn } from 'dsh-working-activity/config'
import type { TrackerConfig } from 'dsh-working-activity/status'
import { ActivityTracker } from 'dsh-working-activity/status'
import { readActivityConfig, writeActivityFrames } from '../activityPrefs.js'
import { adapterRuntimeFor } from '../adapter/kernel/runtime-context.js'
import {
  assertCapabilityShadowPolicy,
} from '../adapter/kernel/runtime.js'
import { readGrantStore } from '../adapter/standard/grants.js'
import { SESSION_COLOR_NAMES } from '../cc/sessionColors.js'
import { completeCommands, HIDDEN_COMMAND_NAMES, isCommandCompletionToken, isLocalCommandName, LOCAL_COMMANDS, parseCommandName, type CommandCompletionNode, type LocalCommand } from '../commands.js'
import { isPresetName, PRESET_NAMES } from '../components/activityFrames.js'
import { getLang, LANGS, t, tOr, type Lang } from '../i18n.js'
import { readModelPref } from '../modelPrefs.js'
import { resolveModelRoute, validateModelRoute } from '../modelRoute.js'
import { readPresetPref } from '../presetPrefs.js'
import { readAgentViewSessions, touchAgentViewSession, touchSession } from '../sessionHistory.js'
import { resolveSessionModes, type SessionModeSpec } from '../sessionModes.js'
import { AUTO_THEME_NAME } from '../theme.js'
import { listThemeCatalog } from '../themeCatalog.js'
import { normalizePageMargin, normalizeScrollGutter, normalizeStatusBar, normalizeToolBackground, type PageMarginSetting, type ScrollGutterMode, type StatusBarConfig, type ToolBackground } from '../tuiDisplayPrefs.js'
import { resolveDshProfileName } from '../update.js'
import { logForDebugging } from '../utils/debug.js'
import { channelCommands } from './channel/commands.js'
import { normalizeInputDecision, normalizeRewindDoneSummary, normalizeRewindPromptDecision, NOTICE_CELLS } from './channel/decisions.js'
import { createChannelEmitter } from './channel/emitter.js'
import { createInputActions, type InputConvergence } from './channel/input-actions.js'
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
/** Buffer below the context window at which CC warns (autoCompact.ts). */
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
  options: {
    model: string
    cwd: string
    provider: string
    /** Configured reasoning effort: applied to the agent's requests when the
     *  live route offers it (silently ignored otherwise), and shown from
     *  startup until the first request/header event reports the adapter's
     *  live value. */
    effort?: string
    /** Derive the working line from base session events; default on. */
    activity?: boolean
    /** Indicator preset for the working-activity line (`moon8`/`moon`/
     *  `comet`/`dots`/… or `random`); default `moon8`. */
    activityFrames?: string
    /** Edit/Write diff presentation; default `auto` (side-by-side ≥110
     *  columns, unified below). */
    diffLayout?: 'auto' | 'split' | 'unified'
    /** Thinking-block display; default `preview` (2-3 line live preview,
     *  fold per step) — `full` keeps thinking expanded until turn end. */
    thinkingFold?: 'preview' | 'full'
    /** Tool-card background treatment; default `none`. */
    toolBackground?: ToolBackground
    /** Transcript gutter mode; default `timeline` (settings `dsh-tui.scrollGutter`). */
    scrollGutter?: ScrollGutterMode
    /** Root page inset setting; default `normal` (settings `dsh-tui.pageMargin`). */
    pageMargin?: PageMarginSetting
    /** Terminal-card header folding; default off (settings
     *  `dsh-tui.foldTerminalCommand`). */
    foldTerminalCommand?: boolean
    /** Session-name chip on the prompt top border; default off (settings
     *  `dsh-tui.promptSessionLabel`). */
    promptSessionLabel?: boolean
    /** Fullscreen draft editor entry points; default on (settings
     *  `dsh-tui.expandEditor`). */
    expandEditor?: boolean
    /** Smooth streaming reveal; default on (settings
     *  `dsh-tui.smoothStreaming`). */
    smoothStreaming?: boolean
    /** Status-footer field visibility and compactness. */
    statusBar?: Partial<StatusBarConfig>
    /** Show the header's pixel whale art; default on. */
    whale?: boolean
    /** Idle whale behaviors (fin/tail/sleep) after the intro settles;
     * default off (click-hearts are always available). */
    whaleIdle?: boolean
    /** Minimal mode; default off (settings `dsh-tui.minimal`). */
    minimal?: boolean
    /** Show the segmented context bar row in the status footer; default on
     *  (cordis.yml `contextBar: false` hides it, issue #29). */
    contextBar?: boolean
    /** cordis.yml's static preset choice (`preset` key): wins over the
     *  persisted `/preset` preference for NEW sessions this channel starts. */
    configuredPreset?: string
    /** cordis.yml's static route (`provider`/`model` keys), undefined when
     *  unset: wins over the persisted `/model` preference for NEW sessions
     *  only when BOTH halves are pinned (atomic rule, issue #67), and is the
     *  only route a resume overrides the target's own record with. */
    configuredProvider?: string
    configuredModel?: string
    /** cordis.yml's raw `lang` key, undefined when unset: `/reload` consults
     *  it so a static deployment choice is never overridden by lang.json. */
    configuredLang?: string
    /** cordis.yml's raw `activityFrames` key, undefined when unset: the
     *  static choice `/reload` must not override. */
    configuredActivityFrames?: string
    /** The preset the initial agent's session runs under (from resolveAgent). */
    agentPreset?: string
    /** Shift+Tab session-mode cycle from cordis.yml `modes`; undefined →
     *  the built-in default/plan/full cycle (sessionModes.ts). */
    modes?: readonly SessionModeSpec[]
    /** Handle of the initial agent; disposed when a rewind replaces it. */
    handle?: AgentHandle
  },
): ChannelState {
  const owner = createChannelOwner()
  const rowIds = { value: 0 }
  const binding = createChannelBinding(initialAgent, options.handle, owner)
  // Detached work (/fork and agent-view dispatch) must be cancellable by the
  // channel owner without pretending its temporary handle is a foreground
  // binding candidate. A successful caller explicitly transfers it instead.
  const createDetachedHandle = async (create: () => Promise<AgentHandle>): Promise<{
    handle: AgentHandle
    transfer(): void
    release(): Promise<void>
  }> => {
    owner.assertActive()
    let handle: AgentHandle | undefined
    let transferred = false
    let disposePromise: Promise<void> | undefined
    const release = (): Promise<void> => {
      if (transferred || handle === undefined) return Promise.resolve()
      disposePromise ??= handle.dispose().catch(() => undefined)
      return disposePromise
    }
    const unregister = owner.own(() => { void release() })
    try {
      handle = await create()
      if (!owner.current()) {
        await release()
        throw new Error('dsh-tui: Channel lifetime has ended')
      }
      return {
        handle,
        transfer() { transferred = true; unregister() },
        async release() { unregister(); await release() },
      }
    } catch (error) {
      unregister()
      await release()
      throw error
    }
  }
  const adapterRuntime = adapterRuntimeFor(ctx)
  const themeHost = getHostThemes(ctx.get('tuiThemes') as TuiThemeRuntime | undefined)

  // Detached handles are a stable ledger shared with adoption actions. The
  // agent-view factory itself starts only after the full state surface exists.
  const backgroundHandles = new Map<string, AgentHandle>()
  let backgroundCurrentAction: () => Promise<import('./channel/types.js').BackgroundResult> = async () => ({ ok: false })
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
  const emitter = createChannelEmitter(() => state, () => subagentProjection.flush())
  if (typeof ctx.effect === 'function') ctx.effect(() => () => { owner.dispose(); emitter.dispose() })
  // foldRows incremental cursor (see foldRows): rows only append past the
  // fold line, so each pass touches only newly-eligible rows.
  const foldCursor: { rows: unknown; index: number } = { rows: null, index: 0 }
  /** One-shot context-low warning per session (CC's TokenWarning). */
  const contextWarning = { value: false }
  const checkContextWarning = (): void => {
    if (contextWarning.value || state.contextWindow === undefined) return
    const remaining = state.contextWindow - state.tokens.input
    if (remaining >= CONTEXT_WARNING_BUFFER_TOKENS) return
    contextWarning.value = true
    const percentLeft = Math.max(
      0,
      Math.round((remaining / state.contextWindow) * 100),
    )
    notify(
      t('context-low-warning', { percent: percentLeft }),
      { color: 'warning', timeoutMs: 8000 },
    )
  }
  /**
   * Register a submitted message as pending and notify the UI. The inbox
   * events (claimed/discarded) retire it; nothing here guesses timing.
   */
  const trackPending = (
    message: { id: string; text: string },
    placement: PendingMessage['placement'],
    images: readonly ComposerImageRef[],
  ): void => {
    state.pending = [...state.pending, { id: message.id, text: message.text, images: [...images], placement }]
    state.emit()
  }
  /** Remove one pending entry (rollback on a refused send, steering
   *  rejection, or delivery races) and notify only when it existed. */
  const untrackPending = (messageId: string): void => {
    const before = state.pending.length
    state.pending = state.pending.filter(item => item.id !== messageId)
    if (state.pending.length !== before) state.emit()
  }
  const notify: ChannelState['notify'] = (...args) => {
    if (!owner.current()) return () => undefined
    return channelCommands(state).notify(...args)
  }
  const inputDelivery = createInputDelivery(ctx, owner, binding, () => state,
    (...args) => notify(...args), trackPending, untrackPending)
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
  let adoptForkedAgent: (
    handle: AgentHandle,
    capture: ReturnType<typeof binding.capture>,
    seed: readonly SessionEvent[],
    agentPreset: string | undefined,
    childId: SessionId,
  ) => string = () => { throw new Error('dsh-tui: session adoption is not initialized') }
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
    stagedImages: inputDelivery.stagedImages,
    attachments: () => mentionAttachments(ctx) as never,
    notify: (...args) => notify(...args),
  })
  const executeRegistryCommand = externalCommands.invoke

  // Durable mode folds/transitions are composed after state construction.
  // Model/preset completion caches are owned by model-actions.ts.

  // Session actions close over these inert placeholders. They are explicitly
  // installed after ChannelState initialization below.
  let settleManualCompaction: () => Promise<void> = async () => undefined
  let compactManualSession: () => void = () => undefined
  let forkSessionAction: () => Promise<boolean> = async () => false
  let rewindToAction: (row: ChatRow, mode?: string | null) => Promise<string | null> = async () => null
  let rewindToNodeAction: (sessionId: string, seq: number, mode?: 'rewind' | 'fork') => Promise<string | null> = async () => null
  let resumeToAction: (sessionId: string) => Promise<ResumeResult> = async () => ({ ok: false, reason: 'unavailable' })
  let newSessionAction: () => Promise<boolean> = async () => false
  let resumeInto: (sessionId: string, kind: 'resume' | 'agent-view', keepCurrent: boolean) => Promise<ResumeResult> = async () => ({ ok: false, reason: 'unavailable' })
  let adoptLiveAgent: (target: Agent) => Promise<ResumeResult> = async () => ({ ok: false, reason: 'unavailable' })

  // This is the one necessary cyclic seam: mode actions need the completed
  // state, while the state exposes their command surface. It is assigned before
  // the channel starts binding/session observation.
  let modeActions: ReturnType<typeof createModeActions>
  let modelActions: ReturnType<typeof createModelActions>
  let workspaceActions: ReturnType<typeof createWorkspaceActions>
  let switchModelAction: (provider: string, model: string) => Promise<boolean>
  let fileActions: ReturnType<typeof createFileActions>
  let reportActions: ReturnType<typeof createReportActions>
  let sessionMetadataActions: ReturnType<typeof createSessionMetadataActions>

  const state: ChannelState = {
    ...createInputActions(() => state, () => binding.agent, inputConvergence,
      (text, placement) => dispatchUserText(text, placement),
      (command, includeInContext) => runLocalCommand(command, includeInContext)),
    subscribe: emitter.subscribe,
    emit: emitter.emit,
    emitStream: emitter.emitStream,
    ...createSettingsHosts(ctx, owner.assertActive),
    ...createPreferences(() => state),
    effortLevels: undefined,
    version: 0,
    rows: [],
    status: 'starting',
    sessionTitle: '',
    sessionColor: '',
    get autoRecapOnOpen(): boolean {
      // Live read (not a boot snapshot): a /settings change applies on the
      // next session switch. No settings service → off (framework absent,
      // e.g. headless fixtures — nothing to configure and no llm route).
      const settings = ctx.get('settings') as
        | { describe(options?: { redactSecrets?: boolean }): readonly { ns: string; value: unknown }[] }
        | undefined
      if (settings === undefined) return false
      const ns = settings.describe({ redactSecrets: true }).find(entry => entry.ns === 'dsh-tui')
      return (ns?.value as Record<string, unknown> | undefined)?.recapOnOpen !== false
    },
    agentId: binding.agent.id,
    agentBindingGeneration: 0,
    model: options.model,
    provider: options.provider,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    cwd: options.cwd,
    displayCwd: workspaceService.describe(options.cwd).description ?? options.cwd,
    gitBranch: undefined,
    working: false,
    cancelPending: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    notifications: [],
    contextWindow: undefined,
    // Explicit cordis.yml `effort` wins; otherwise the persisted /effort
    // choice; the first request/header event re-asserts the adapter's truth.
    reasoningEffort: options.effort,
    // Session-mode seed; the first refreshMode() (bindAgent) re-derives it
    // from the session log, so a resumed session lands on its recorded mode.
    mode: sessionModes[0]!,
    modeIndex: 0,
    workingActivity: undefined,
    activityFrames: normalizeActivityPreset(options.activityFrames),
    configuredProvider: options.configuredProvider,
    configuredModel: options.configuredModel,
    configuredPreset: options.configuredPreset,
    configuredActivityFrames: options.configuredActivityFrames,
    configuredLang: options.configuredLang,
    diffLayout: options.diffLayout ?? 'auto',
    thinkingFold: options.thinkingFold ?? 'preview',
    toolBackground: normalizeToolBackground(options.toolBackground),
    scrollGutter: normalizeScrollGutter(options.scrollGutter),
    pageMargin: normalizePageMargin(options.pageMargin),
    foldTerminalCommand: options.foldTerminalCommand === true,
    promptSessionLabel: options.promptSessionLabel === true,
    expandEditor: options.expandEditor !== false,
    smoothStreaming: options.smoothStreaming !== false,
    statusBar: normalizeStatusBar(options.statusBar),
    whale: options.whale !== false,
    whaleIdle: options.whaleIdle !== false,
    minimal: options.minimal === true,
    activityEnabled: options.activity !== false,
    contextBarEnabled: options.contextBar !== false,
    agentPreset: options.agentPreset,
    goal: undefined,
    todos: [],
    loadedContext: undefined,
    pending: [],
    commandList: LOCAL_COMMANDS,
    commandCompletions(input: string) {
      // Warm the async vocabularies as soon as the input could be heading
      // for their commands (`/m`, `/pre`, …) — by the time a trailing space
      // asks children() for nodes, the fetch has usually landed.
      const head = input.slice(1).split(/[\t ]/)[0]?.toLowerCase() ?? ''
      if (head !== '') {
        if ('model'.startsWith(head)) modelActions.warmModelNodes()
        if ('preset'.startsWith(head)) modelActions.warmPresetOptions()
        if ('effort'.startsWith(head)) modelActions.warmEffortLevels()
      }
      return completeCommands(input, state.commandList, (path) => {
        if (path.length === 1 && path[0] === 'model') {
          // provider/id specs, current model tagged; see modelNodeCache.
          modelActions.warmModelNodes()
          return modelActions.modelNodes()
        }
        if (path.length === 1 && path[0] === 'lang') {
          return [
            { name: 'status', description: 'Show the current UI language', descriptionKey: 'sugg-status-desc' },
            ...LANGS.map((lang) => ({
              name: lang,
              description: `Switch the UI language to ${lang}`,
              descriptionKey: lang === 'zh' ? 'sugg-lang-zh-desc' : 'sugg-lang-en-desc',
              ...(getLang() === lang ? { tag: 'current' } : {}),
            })),
          ]
        }
        if (path.length === 1 && path[0] === 'theme') {
          const themeEntries = listThemeCatalog(themeHost)
          return [
            { name: 'status', description: 'Show the current theme', descriptionKey: 'sugg-status-desc' },
            { name: AUTO_THEME_NAME, description: 'Follow the terminal background', descriptionKey: 'sugg-theme-auto-desc' },
            ...themeEntries
              .filter((entry) => entry.name !== AUTO_THEME_NAME)
              .map((entry) => {
                const base = entry.base ?? 'dark'
                if (entry.source === 'builtin') {
                  return {
                    name: entry.name,
                    description: `Built-in theme ${entry.name}`,
                    descriptionKey: 'sugg-theme-builtin-desc',
                  }
                }
                if (entry.source === 'runtime') {
                  return {
                    name: entry.name,
                    description: `Plugin theme (${base} base)`,
                    descriptionKey: 'sugg-theme-plugin-desc',
                  }
                }
                return {
                  name: entry.name,
                  description: `User theme (${base} base)`,
                  descriptionKey: 'sugg-theme-user-desc',
                }
              }),
          ]
        }
        if (path.length === 1 && path[0] === 'color') {
          return [
            { name: 'status', description: 'Show the current session color', descriptionKey: 'sugg-status-desc' },
            { name: 'reset', description: 'Clear the session color', descriptionKey: 'sugg-color-reset-desc' },
            ...SESSION_COLOR_NAMES.map((name) => ({
              name,
              description: 'Session accent color',
              descriptionKey: 'sugg-color-name-desc',
              ...(state.sessionColor === name ? { tag: 'current' } : {}),
            })),
          ]
        }
        if (path.length === 1 && path[0] === 'effort') {
          modelActions.warmEffortLevels()
          return [
            { name: 'status', description: 'Show the current reasoning effort', descriptionKey: 'sugg-status-desc' },
            ...(state.effortLevels ?? []).map((id) => ({
              name: id,
              description: 'Reasoning effort level',
              descriptionKey: 'sugg-effort-level-desc',
              ...(state.reasoningEffort === id ? { tag: 'current' } : {}),
            })),
          ]
        }
        if (path.length === 1 && path[0] === 'preset') {
          modelActions.warmPresetOptions()
          return [
            { name: 'status', description: 'Show the current agent preset', descriptionKey: 'sugg-status-desc' },
            ...(modelActions.presetOptions()).map((preset) => ({
              name: preset.id,
              description: preset.description ?? preset.name ?? preset.id,
              ...(preset.id === state.agentPreset
                ? { tag: 'current' }
                : preset.isDefault
                  ? { tag: 'default' }
                  : {}),
            })),
          ]
        }
        if (path.length === 1 && path[0] === 'activity') {
          return [
            { name: 'status', description: 'Show the current activity preset', descriptionKey: 'sugg-status-desc' },
            { name: 'frames', description: 'List or switch frame presets', descriptionKey: 'sugg-activity-frames-desc' },
          ]
        }
        if (path.length === 2 && path[0] === 'activity' && path[1] === 'frames') {
          return PRESET_NAMES.map((name) => ({
            name,
            description: 'Animation frame preset',
            descriptionKey: 'sugg-activity-frame-desc',
            ...(state.activityFrames === name ? { tag: 'current' } : {}),
          }))
        }
        if (path.length === 1 && path[0] === 'workspace') {
          const builtins: CommandCompletionNode[] = [
            { name: 'resume', description: 'Switch to another workspace', descriptionKey: 'cmd-desc-workspace-resume' },
            { name: 'rename', description: 'Rename the current workspace', descriptionKey: 'cmd-desc-workspace-rename' },
            { name: 'open', description: 'Open a path or workspace URI', descriptionKey: 'cmd-desc-workspace-open' },
          ]
          const reserved = new Set(builtins.map(command => command.name))
          return [
            ...builtins,
            ...workspaceService.commands()
              .filter(command => !reserved.has(command.name.toLowerCase()))
              .map(command => ({
                name: command.name,
                aliases: command.aliases,
                description: command.description,
              })),
          ]
        }
        if (path.length === 1 && path[0] === 'permission') {
          const snapshot = state.permissionPresets()
          return snapshot.options
            .filter(option => isCommandCompletionToken(option.value) && !RESERVED_PERMISSION_PRESETS.has(option.value))
            .map(option => ({
              name: option.value,
              description: option.description ?? option.name,
              ...(option.value === 'read-only'
                ? { descriptionKey: 'permission-preset-readonly-desc' }
                : option.value === 'workspace-write'
                  ? { descriptionKey: 'permission-preset-workspace-write-desc' }
                  : option.value === 'danger-full-access'
                    ? { descriptionKey: 'permission-preset-full-access-desc' }
                    : {}),
              ...(snapshot.current?.kind === 'preset' && snapshot.current.value === option.value
                ? { tag: 'current' }
                : {}),
            }))
        }
        if (path.length === 1 && path[0] === 'plan') {
          return [
            { name: 'on', description: 'Enter plan mode: read-only, plan before acting', descriptionKey: 'plan-mode-on-desc' },
            { name: 'off', description: 'Exit plan mode, back to normal execution', descriptionKey: 'plan-mode-off-desc' },
          ]
        }
        return commandTrees?.children(path) ?? []
      })
    },
    lastUsage: undefined,
    tps: undefined,
    tpsSamples: [],
    contextSegments: {
      system: 0,
      prompt: 0,
      assistant: 0,
      thinking: 0,
      tools: 0,
    },
    subagents: [],
    subagentControl,
    backgroundJobs: [],
    jobControl,
    loadOlder() {
      // Restore folded-away full text from the session log, newest folded
      // batch first, clearing the folded marks. The log is the authoritative
      // source, so restored rows match a fresh replay; live streaming rows
      // are never folded, so nothing here races a running turn.
      const restored = foldBack(state.rows, binding.agent.session.events, { call: projector.presentCallView, result: projector.presentResultView })
      if (restored > 0) state.emit()
      return restored
    },
    stageImage: inputDelivery.stageImage,
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
    rewindTo(row: ChatRow, mode: string | null = null) {
      return rewindToAction(row, mode)
    },
    buildSessionTree: createSessionTreeReader(ctx, binding, () => state.cwd, (...args) => notify(...args), owner),
    rewindToNode(sessionId: string, seq: number, mode: 'rewind' | 'fork' = 'rewind'): Promise<string | null> {
      return rewindToNodeAction(sessionId, seq, mode)
    },
    forkSession() {
      return forkSessionAction()
    },
    resumeTo(sessionId: string): Promise<ResumeResult> {
      return resumeToAction(sessionId)
    },
    newSession(): Promise<boolean> {
      return newSessionAction()
    },
    listWorkspaces() { return workspaceActions.listWorkspaces() },
    resolveWorkspace(uri: string) { return workspaceActions.resolveWorkspace(uri) },
    switchWorkspace(target: TuiWorkspaceTarget) { return workspaceActions.switchWorkspace(target) },
    renameWorkspace(title: string) { return workspaceActions.renameWorkspace(title) },
    workspaceCommands() { return workspaceActions.workspaceCommands() },
    runWorkspaceCommand(name: string, input: string) { return workspaceActions.runWorkspaceCommand(name, input) },
    switchModel(provider: string, model: string) { return switchModelAction(provider, model) },
    listEfforts() { return modelActions.listEfforts() },
    setEffort(id) { return modelActions.setEffort(id) },
    cycleMode() {
      return modeActions.cycleMode()
    },
    clear() {
      state.rows.length = 0
      markChannelReadDirty(state.rows)
      rowIds.value = 0
      projector.reset()

      // In-flight subagents keep streaming after the wipe; clearing the row
      // map lets their next event re-create the card as a fresh row instead
      // of feeding a row object no transcript holds (the store keeps live
      // tracking for the dashboard — same session, still running).
      subagentProjection.dropRows()
      // Live jobs keep running across the wipe too (same session): clear the
      // row map so their next commit re-creates the card as a fresh row.
      jobProjection.dropRows()
      state.activeToolCount = 0
      state.responseChars = 0
      state.rows.push({
        id: rowIds.value,
        kind: 'notice',
        text: 'Session cleared',
      })
      rowIds.value += 1
      state.emit()
    },
    notify: createChannelNotifications(() => state, owner),
    setActivityFrames(name) {
      name = normalizeActivityPreset(name) ?? 'moon8'
      if (!isPresetName(name)) {
        notify(t('unknown-activity-preset', { name }), { color: 'error' })
        return false
      }
      if (name === state.activityFrames) {
        notify(t('activity-indicator-already', { name }), { color: 'success' })
        return true
      }
      // Persist first (pi behavior: a failed write refuses the switch) so a
      // preference that cannot be saved never silently disappears.
      if (!writeActivityFrames(name)) {
        notify(t('activity-pref-write-failed'), { color: 'error' })
        return false
      }
      state.activityFrames = name
      state.emit()
      notify(t('activity-indicator-switched', { name }))
      return true
    },
    permissionPresets() {
      let service: unknown
      try {
        service = ctx.get('permissionPresets')
      } catch {
        return unavailablePermissionPresetSnapshot()
      }
      if (service === undefined) return legacyPermissionPresetSnapshot(state.mode.sandbox)
      return permissionPresetSnapshotFromService(service, binding.agent.session.events)
    },
    listPresets() { return modelActions.listPresets() },
    switchPreset(presetId) { return modelActions.switchPreset(presetId) },
    listModels() { return modelActions.listModels() },
    listProviders() { return modelActions.listProviders() },
    invalidateModelCompletion() { modelActions.dropModelNodeCache() },
    listSkills() { return sessionMetadataActions.listSkills() },
    describeCredential(ref) { return sessionMetadataActions.describeCredential(ref) },
    balanceInfo() { return reportActions.balanceInfo() },
    settingsSections(): readonly TuiSettingsSection[] {
      return settingsSectionsRuntime?.list() ?? []
    },
    subscribeSettingsSections(listener: () => void): () => void {
      return emitter.subscribe(listener)
    },
    sideQuestion(question, options) { return sessionMetadataActions.sideQuestion(question, options) },
    listFileCandidates(query, options) { return fileActions.listFileCandidates(query, options) },
    listFiles() { return fileActions.listFiles() },
    listSessions() { return sessionMetadataActions.listSessions() },
    previewSession(sessionId) { return sessionMetadataActions.previewSession(sessionId) },
    // ── agent view (CC's `claude agents`) ───────────────────────────────────
    bindApprovalStore(store) { agentView.bindApprovalStore(store) },
    agentViewRows() { return agentView.rows() },
    subscribeAgentView(listener) { return agentView.subscribe(listener) },
    dispatchBackgroundAgent(prompt) { return agentView.dispatch(prompt) },
    stopBackgroundAgent(sessionId) { return agentView.stop(sessionId) },
    attachToAgent(sessionId) { return agentView.attach(sessionId) },
    peekAgentSession(sessionId) { return agentView.peek(sessionId) },
    replyToAgent(sessionId, text) { return agentView.reply(sessionId, text) },
    backgroundCurrent() { return agentView.backgroundCurrent() },
    setResumeTarget(sessionId) { sessionMetadataActions.setResumeTarget(sessionId) },
    renameSession(title) { sessionMetadataActions.renameSession(title) },
    setSessionColor(color) { sessionMetadataActions.setSessionColor(color) },
    recapRecent(options) { return sessionMetadataActions.recapRecent(options) },
    deleteSession(sessionId) { return sessionMetadataActions.deleteSession(sessionId) },
    renameSessionTo(sessionId, title) { return sessionMetadataActions.renameSessionTo(sessionId, title) },
    compact() {
      compactManualSession()
    },
    runExternalCommand(name, rawInput, images = []) {
      return executeRegistryCommand(name, rawInput, images).then(outcome => outcome?.text)
    },
    runExternalCommandOutcome(name, rawInput, images = []) {
      return executeRegistryCommand(name, rawInput, images)
    },
    /** TUI-side permission switch (see the public Channel type). */
    runPermissionPreset(name) {
      return applyPermissionIdentity(name.trim())
    },
    pluginScene: sceneRuntime?.active,
    openPluginScene(id: string) {
      return sceneRuntime?.open(id) ?? false
    },
    closePluginScene() {
      sceneRuntime?.close()
    },
    pushLocal(title, lines) {
      state.rows.push({ id: rowIds.value++, kind: 'local', text: title })
      for (const line of lines) {
        state.rows.push({
          id: rowIds.value++,
          kind: 'local-output',
          text: preview(line, LOCAL_OUTPUT_LIMIT),
        })
      }
      state.emit()
    },
    mcpStatus() { return reportActions.mcpStatus() },
    exportSession() { return reportActions.exportSession() },
    initWorkspace() { return reportActions.initWorkspace() },
    doctorInfo() { return reportActions.doctorInfo() },
    pluginsInfo(args: string) { return reportActions.pluginsInfo(args) },
    async listSubagents() {
      const subagents = ctx.get('subagents') as
        | {
          listChildren(
            sessionId: unknown,
            signal?: AbortSignal,
          ): Promise<
            Array<{
              kind: string
              mode: string
              label?: string
              activity: string
              id: string | { value?: string }
            }>
          >
        }
        | undefined
      if (!subagents) return [t('subagent-not-mounted')]
      try {
        const children = await subagents.listChildren(binding.agent.session.id)
        if (children.length === 0) return [t('subagent-none')]
        return children.map((child) => {
          const id =
            typeof child.id === 'string' ? child.id : (child.id.value ?? '')
          const label = child.label ? `「${child.label}」` : ''
          const mode = child.mode === 'continuable' ? t('subagent-resumable') : t('subagent-oneshot')
          return `${t('subagent-row', { mode, label, activity: child.activity === 'running' ? t('subagent-running') : t('subagent-archived'), id: id.slice(0, 8) })}`
        })
      } catch (error) {
        return [t('subagent-query-failed', { err: error instanceof Error ? error.message : String(error) })]
      }
    },
    releaseContributions() {
      owner.dispose()
      binding.clearSubscriptions()
      stopActivityTick()
      emitter.dispose()
      releaseSkillCommands()
      unsubscribeScenes?.()
    },
    traceEvents() {
      // Immutable per-append snapshot (dsh-session caches the frozen array);
      // reads follow agent swaps (/resume /rewind /new) automatically.
      return binding.agent.session.events
    },
  }

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

  // Attach optional jobs only after the state exists; an inject callback may
  // synchronously publish its initial list.
  if (typeof (ctx as { inject?: unknown }).inject === 'function') {
    ctx.inject(['jobs'], jobsCtx => {
      attachJobs((jobsCtx as { jobs?: JobsRuntime }).jobs, dispose => jobsCtx.effect(() => dispose))
    })
  } else {
    attachJobs((ctx as { get?: (name: string) => unknown }).get?.('jobs') as JobsRuntime | undefined)
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
  owner.own(settingsSectionsRuntime?.subscribe(() => { if (owner.current()) state.emit() }) ?? (() => undefined))
  unsubscribeScenes = sceneRuntime?.subscribe(() => {
    if (state.pluginScene === sceneRuntime.active) return
    state.pluginScene = sceneRuntime.active
    state.emit()
  })
  skillCatalog.start()
  void refreshLoadedContext()

  /** The leaf's bash executor (dsh-bash-local in the example leaf) — the DSH
 *  execution seam for local `!` commands and the git status breadcrumb. The
 *  service registers under `ctx.shell` (ShellExecutor; dsh-bash-local and
 *  dsh-pwsh-local are the providers). */
  const bash = ctx.get('shell') as
    | {
      resolve(request: {
        command: string
        workdir?: string
        timeoutMs?: number
      }): { command: string; timeoutMs: number }
      run(spec: { command: string; timeoutMs: number }): Promise<{
        exitCode: number | null
        stdout: { text: string }
        stderr: { text: string }
        timedOut: boolean
      }>
    }
    | undefined

  /** Local `!` mode: execute in the current workspace provider and
   *  render local-only transcript rows (never sent to the model). */
  const runLocalCommand = async (
    command: string,
    includeInContext: boolean,
  ): Promise<void> => {
    const capture = binding.capture()
    const cwd = state.cwd
    const workspace = workspaceService.describe(cwd)
    state.rows.push({
      id: rowIds.value++,
      kind: 'local',
      text: command,
      executionTarget: workspace.kind === 'local' ? workspace.badge : `${workspace.badge} · ${workspace.label}`,
    })
    state.emit()
    let output = '(no output)'
    const executionShell = await workspaceService.commandShell(cwd) ?? bash
    if (!binding.isCurrent(capture)) return
    if (executionShell) {
      try {
        const spec = executionShell.resolve({
          command,
          workdir: state.cwd,
          timeoutMs: 30000,
        })
        const result = await executionShell.run(spec)
        output =
          result.stdout.text.trim() ||
          result.stderr.text.trim() ||
          (result.timedOut ? '(timed out)' : '(no output)')
      } catch (error) {
        output = error instanceof Error ? error.message : String(error)
      }
    }
    if (!binding.isCurrent(capture)) return
    state.rows.push({
      id: rowIds.value++,
      kind: 'local-output',
      text: preview(output, LOCAL_OUTPUT_LIMIT),
    })
    state.emit()
    if (includeInContext) {
      // The <local-command-output> envelope tells the model that this is the
      // result of a local command the user just ran.
      binding.agent.followup(createUserMessage({
        content: [{
          type: 'text',
          text: `<local-command-output>
${output}
</local-command-output>`,
        }],
        source: { kind: 'user' },
      }))
    }
  }
  const projector = createChannelProjection(state, {
    agent: () => binding.agent, rowIds, contextWarning, pendingTaskDescriptions, jobs: jobStore, inputConvergence,
    checkContextWarning, notify: (...args) => notify(...args),
    tools: ctx.get('tools') as ToolsRegistryLike | undefined, renderer: rendererRuntime,
  })
  // Replay the durable transcript first, then follow live events.
  projector.replayEvents(binding.agent.session.events)
  projector.settleStreaming()
  // Attached to an idle agent: any replayed turn/start belongs to a previous
  // session run, so the spinner must not come up on boot.
  state.working = false
  state.cancelPending = false
  state.status = binding.agent.status
  state.emit()

  // Live subscription list and activity timer, rebound to every replacement
  // agent so no status from the previous session can leak across a swap.
  /** Tracker knobs + custom actions from the persisted pi-style config
   *  (`~/.dsh-tui/working-activity.json`); a missing file means lively
   *  defaults (all eggs on). */
  const activityPrefsSnapshot = (): {
    config: TrackerConfig
    customActions?: Readonly<Record<string, readonly string[]>>
  } => {
    const cfg = readActivityConfig()
    if (cfg === undefined) {
      return { config: { phrases: true, detailLimit: 40, showIdle: false } }
    }
    return {
      config: {
        phrases: featureOn(cfg, 'phrases'),
        detailLimit: 40,
        showIdle: false,
        features: {
          rareEggs: featureOn(cfg, 'rareEggs'),
          weekend: featureOn(cfg, 'weekend'),
          holidays: featureOn(cfg, 'holidays'),
          nightPhrases: featureOn(cfg, 'nightPhrases'),
        },
        customPhrases: cfg.customPhrases,
        showTokPerSec: cfg.showTokPerSec,
        workRemindAt: cfg.workRemindAt,
      },
      customActions: cfg.customActions,
    }
  }
  let activityTracker = (() => {
    const prefs = activityPrefsSnapshot()
    return new ActivityTracker(prefs.config, Date.now, prefs.customActions)
  })()
  let activityTickTimer: NodeJS.Timeout | undefined

  const stopActivityTick = (): void => {
    if (activityTickTimer === undefined) return
    clearInterval(activityTickTimer)
    activityTickTimer = undefined
  }


  modelActions = createModelActions(ctx, state, {
    owner,
    binding,
    selection,
    initialEffort: options.effort,
    agent: () => binding.agent,
    notify,
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
    onModelSwitch: model => updateWorkingActivity('model switch', () => activityTracker.onModelSwitch(model)),
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

  modeActions = createModeActions(ctx, state, {
    binding,
    sessionModes,
    commandService,
    executeRegistryCommand,
    notify,
  })

  /** Render the current tracker into the TUI-only projection. */
  const renderWorkingActivity = (): ActivityStatus | undefined => {
    if (options.activity === false) {
      state.workingActivity = undefined
      return undefined
    }
    const rendered = activityTracker.render()
    state.workingActivity = rendered
    return rendered
  }

  // Working Activity is an optional presentation sidecar. A malformed durable
  // event must never let it abort the authoritative channel projection (Cordis
  // contains the listener throw, but the rest of THIS callback would otherwise
  // be skipped — including turn/end and inbox retirement).
  let activityFailureReported = false
  const updateWorkingActivity = (
    source: string,
    update?: () => void,
  ): ActivityStatus | undefined => {
    try {
      update?.()
      return renderWorkingActivity()
    } catch (error: unknown) {
      if (!activityFailureReported) {
        activityFailureReported = true
        const detail = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`dsh-tui: working-activity ignored ${source} after a projection error: ${detail}`)
      }
      return undefined
    }
  }

  /**
   * Release volatile UI gates when the bound driver is definitively quiescent
   * but its terminal session event did not reach this projection. This does not
   * invent a turn/end or any transcript fact; it only reconciles live controls
   * to the authoritative Agent status so Enter/Esc cannot remain latched.
   */
  const reconcileRetiredProjection = (status: 'idle' | 'disposed'): void => {
    if (!state.working) return
    ctx.logger.warn(
      `dsh-tui: agent became ${status} while the channel still projected an open turn; releasing volatile UI gates`,
    )
    inputConvergence.cancelInFlight = false
    state.cancelPending = false
    state.working = false
    state.activeToolCount = 0
    projector.settleStreaming()
    projector.updateSpinnerMode()
  }

  const bindAgentUnsafe = (): void => {
    state.agentBindingGeneration = binding.bind()
    stopActivityTick()
    // Cancel state and deferred interrupt delivery belong to one bound agent.
    // A replacement must neither inherit the old latch nor receive its queued
    // microtask after the session identity changes.
    inputConvergence.cancelInFlight = false
    inputConvergence.interruptSeq += 1
    const prefs = activityPrefsSnapshot()
    activityTracker = new ActivityTracker(prefs.config, Date.now, prefs.customActions)
    activityFailureReported = false
    updateWorkingActivity('agent bind', () => activityTracker.onAgentStatus(binding.agent.status))
    activityTickTimer = setInterval(() => {
      if (!owner.current()) { stopActivityTick(); return }
      const previous = state.workingActivity
      const rendered = updateWorkingActivity('activity tick')
      if (rendered === undefined) return
      // Live phases deliberately wake at 500 ms even when the formatted line
      // has not crossed its next whole-second boundary: turnElapsedMs remains
      // a current state value, while line changes cover phrase rotation and
      // the short-lived completed-tool summary.
      if (
        rendered.phase === 'waiting' ||
        rendered.phase === 'thinking' ||
        rendered.phase === 'tool' ||
        previous?.phase !== rendered.phase ||
        previous.line !== rendered.line
      ) {
        state.emit()
      }
    }, 500)
    activityTickTimer.unref()
    // Re-couple the channel-owned model selection to the new agent's
    // assembly/request waterfalls, then re-apply the persisted effort when
    // this agent's route offers it (dsh-agent installModelSelection).
    modelActions.selection.current = undefined
    modelActions.selection.assembled = undefined
    // {{model}} backfill (issue #155): a resumed agent's route lives only in
    // its session's request/header records — agentOptions.model stays
    // undefined unless cordis.yml pins a COMPLETE provider+model pair — so
    // the assemble-time persona variable `{{model}}` was registered but
    // valueless, and dsh-system-prompt's interpolate() throws before any
    // model call. Seed the selection from the channel's display route (on
    // resume it already carries the session's recorded route; on create it
    // matches the route the agent was created with). Per
    // installModelSelection's contract an absent effort restores the
    // provider/default behavior, so seeding never pins an effort the route
    // did not ask for; applyPreferredEffort below still upgrades the seed
    // when the user has a persisted preference the route offers.
    if (binding.agent.options?.model === undefined && state.provider !== '' && state.model !== '') {
      modelActions.selection.current = { provider: state.provider, model: state.model }
    }
    void modelActions.applyPreferredEffort()
    modeActions.refreshMode()
    const register = <T extends () => void>(dispose: T): T => {
      binding.subscribe(dispose)
      return dispose
    }
    const on = (...args: Parameters<typeof ctx.on>): ReturnType<typeof ctx.on> =>
      register(ctx.on(...args))
    register(installModelSelection(binding.agent.ctx, modelActions.selection))
    void [
      on('agent/status', ({ agent: subject, status }) => {
        if (subject !== binding.agent) return
        state.status = status
        updateWorkingActivity(`agent/status:${status}`, () => activityTracker.onAgentStatus(status))
        if (status === 'idle') reconcileRetiredProjection('idle')
        state.emit()
      }),
      on('agent/disposed', ({ agent: subject }) => {
        if (subject !== binding.agent) return
        state.status = 'disposed'
        stopActivityTick()
        reconcileRetiredProjection('disposed')
        state.emit()
      }),
      // Pending delivery is driven by the agent inbox: a claimed message
      // has landed in a turn (steer → step boundary, followup → next turn);
      // a discarded one was dropped by a cancel or withdrawn via Alt+Up.
      // Retire it from the preview. Official dsh-agent rc.6 emits these as
      // single-payload notifications `{ agent, message }`; `inserted` is not
      // handled here because trackPending already registered the preview
      // synchronously at submit time.
      (() => {
        const retirePending = (payload: { agent: unknown; message: { id?: unknown } }): void => {
          if (payload.agent !== binding.agent) return
          const messageId = payload.message?.id
          if (typeof messageId !== 'string') return
          const before = state.pending.length
          state.pending = state.pending.filter(item => item.id !== messageId)
          if (state.pending.length !== before) state.emit()
        }
        const disposers: Array<() => boolean> = []
        for (const event of ['agent/inbox/claimed', 'agent/inbox/discarded'] as const) {
          disposers.push(on(event, retirePending))
        }
        return () => {
          for (const dispose of disposers) dispose()
        }
      })(),
      on('session/event', (session, event) => {
        // The currently bound main session always wins. SubagentActivityStore
        // intentionally retains Session-object mappings for completed cards;
        // if one of those sessions is later adopted/resumed as the main agent,
        // checking the stale child mapping first would swallow every main event
        // (including turn/end) and leave working/cancelPending latched forever.
        const isMainSession = session === binding.agent.session
        if (!isMainSession && subagentProjection.onSessionEvent(session, event)) return
        // Otherwise handle the bound main-agent session.
        if (!isMainSession) return
        if (session !== binding.agent.session) {
          // A background (agent view) session is active: refresh the rows
          // so its summary/status follows the live output, throttled.
          agentView.schedule()
          return
        }
        // Observation broker (C-042): maps user/message + assistant/message
        // into grant-gated envelopes; every other event type is a no-op, and
        // publish never throws into this arm.
        messageObserver?.publish(session, event)
        updateWorkingActivity(`session/event:${event.type}`, () => {
          activityTracker.onSessionEvent(event)
          // Interrupt quip: an aborted/interrupted turn ends the round; the
          // comeback copy shows on the next thinking rotation.
          if ((event as { type: string }).type === 'turn/end') {
            const reason = (event.data as { reason?: { kind?: string } }).reason
            if (reason?.kind === 'aborted' || reason?.kind === 'interrupted') {
              activityTracker.onInterrupted()
            }
          }
        })
        modeActions.onSessionEvent(session, event)
        projector.renderEvent(event)
        // Streaming deltas (one event per token) take the frame-aligned
        // path; every other event keeps synchronous notification.
        if (event.type === 'assistant/chunk') state.emitStream()
        else state.emit()
      }),
      // Child lifecycle remains an observe-only transport; the projection
      // performs synchronous settlement and frame-batched streaming itself.
      (() => {
        const disposeStart = on('subagent/start' as any, (info: { id: string; runId?: string; provider: string; local?: boolean }) => {
          subagentProjection.onStart(info)
        })
        const disposeEnd = on('subagent/end' as any, (info: { id: string; stopReason: string; lastAssistantMessage?: unknown[] }) => subagentProjection.onEnd(info))
        return () => { disposeStart(); disposeEnd() }
      })(),
    ]
  }
  // A subscription/setup exception after commit must not strand a live-looking
  // identity with only part of its channel plumbing installed.
  const bindAgent = (): void => {
    try {
      bindAgentUnsafe()
    } catch (error) {
      owner.dispose()
      throw error
    }
  }
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
    onComplete: () => updateWorkingActivity('compaction', () => activityTracker.onCompact('done')),
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

  // Subagents inherit provider/model from AgentOptions, but resumed TUI
  // agents can legitimately carry their route only in persisted request
  // headers. Their child scopes do not share this channel's per-agent
  // ModelSelectionRef, so fill an otherwise incomplete first request from
  // the active route. Keep complete child-specific routes authoritative.
  ctx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    if (!owner.current()) return resolved
    if (
      typeof resolved.provider === 'string' && resolved.provider.length > 0 &&
      typeof resolved.model === 'string' && resolved.model.length > 0
    ) {
      return resolved
    }
    return {
      ...resolved,
      provider: state.provider,
      model: state.model,
    }
  })
  bindAgent()
  // Cordis owns the Channel lifetime. Rebinding handles the common case;
  // this effect closes the final timer and releases the DecisionEvents
  // dispatch-topology marker when the Channel's context unloads.
  const effect = (ctx as Context & {
    effect?: (setup: () => () => void, label?: string) => void
  }).effect
  const releaseLifecycle = owner.own(() => {
    stopActivityTick()
    unmarkDecisionTopology()
    releaseSkillCommands()
    unsubscribeScenes?.()
  })
  effect?.call(ctx, () => releaseLifecycle, 'dsh-tui channel lifecycle')
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
          updateWorkingActivity('git branch', () => activityTracker.onGitBranch(branch))
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

  registerChannelOwner(state, owner)
  return state
}

export { expandMentions } from './channel/mentions.js'
export { sessionCwdMatches } from './channel/paths.js'
export type { ActivityStatus, AgentViewDispatchResult, AgentViewRow, AgentViewStatus, BackgroundResult, Channel, ChannelGoal, ChannelState, ChatRow, CredentialStatus, EffortOption, JobControl, JobRow, LoadedContext, LoadedContextEntry, LoadedContextFile, LoadedContextSkill, LoadedContextTool, MentionAttachments, MentionExpansion, MentionFs, NotificationItem, PendingMessage, PermissionPresetAvailability, PermissionPresetCurrent, PermissionPresetOption, PermissionPresetSnapshot, PresetOption, ResumeResult, SkillInfo, StagedImageInput, SubagentControl, SubagentRow, TodoPanelItem, TokenBucket, TokenUsage, ToolCallView, ToolFileDiff, ToolResultView, ToolRow, ToolViewPresenter } from './channel/types.js'
export { emptyTokenUsage } from './channel/usage.js'
