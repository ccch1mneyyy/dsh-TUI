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
import { markChannelReadDirty } from '../adapter/channel/read-view.js'
import { createChannelNotifications } from './channel/notifications.js'
import type { Context } from '@deepseek-ai/cordis'
import { assembleContextFor, installModelSelection, type Agent, type AgentHandle, type CreateAgentOptions, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { loadBaselineInstructions } from '@deepseek-ai/dsh-agent-instructions'
import type { CommandExecution, CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import {
  createUserMessage,
  ReasoningEffortId,
  type ContentBlock,
  type Message
} from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { isModelInvocable, isUserInvocable, renderSkillContent, type SkillSummary } from '@deepseek-ai/dsh-skill'
import { renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { randomUUID } from 'node:crypto'
import { featureOn } from 'dsh-working-activity/config'
import type { TrackerConfig } from 'dsh-working-activity/status'
import { ActivityTracker } from 'dsh-working-activity/status'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readActivityConfig, writeActivityFrames } from '../activityPrefs.js'
import { collectAdapterDiagnostics } from '../adapter/kernel/diagnostics.js'
import { adapterRuntimeFor } from '../adapter/kernel/runtime-context.js'
import {
  assertCapabilityShadowPolicy,
} from '../adapter/kernel/runtime.js'
import { readGrantStore } from '../adapter/standard/grants.js'
import { SESSION_COLOR_NAMES } from '../cc/sessionColors.js'
import { completeCommands, HIDDEN_COMMAND_NAMES, isCommandCompletionToken, isLocalCommandName, LOCAL_COMMANDS, parseCommandName, type CommandCompletionNode, type LocalCommand } from '../commands.js'
import { isPresetName, PRESET_NAMES } from '../components/activityFrames.js'
import { fetchBalance } from '../deepseekBalance.js'
import { isPeakHour } from '../deepseekPricing.js'
import { readEffortPref, writeEffortPref } from '../effortPrefs.js'
import { getLang, LANGS, t, tOr, type Lang } from '../i18n.js'
import { readModelPref, writeModelPref } from '../modelPrefs.js'
import { resolveModelRoute, validateModelRoute } from '../modelRoute.js'
import { migratePresetPref, readPresetPref, writePresetPref } from '../presetPrefs.js'
import { clearResumeTarget, forgetAgentViewSession, forgetSession, readAgentViewSessions, readResumeTarget, touchAgentViewSession, touchSession, writeResumeTarget } from '../sessionHistory.js'
import { modeDisplayName, resolveSessionModes, type SessionModeSpec } from '../sessionModes.js'
import { AUTO_THEME_NAME } from '../theme.js'
import { listThemeCatalog } from '../themeCatalog.js'
import { normalizePageMargin, normalizeScrollGutter, normalizeStatusBar, normalizeToolBackground, type PageMarginSetting, type ScrollGutterMode, type StatusBarConfig, type ToolBackground } from '../tuiDisplayPrefs.js'
import { resolveDshProfileName } from '../update.js'
import { logForDebugging } from '../utils/debug.js'
import { isPathLikeQuery, rankFileCandidates, type FileCandidate } from '../utils/fileSuggestions.js'
import { homeDir, LEGACY_DATA_DIR } from '../utils/paths.js'
import {
  AGENT_VIEW_STATUS_ORDER,
  agentViewLivePreview,
  agentViewStatusOf,
  foldAgentViewEvents,
  oneLine,
  sessionTitleFallback,
  type AgentViewFold,
} from './agent-view.js'
import { channelCommands } from './channel/commands.js'
import { normalizeInputDecision, normalizeRewindDoneSummary, normalizeRewindPromptDecision, NOTICE_CELLS } from './channel/decisions.js'
import { createChannelEmitter } from './channel/emitter.js'
import { createInputActions, type InputConvergence } from './channel/input-actions.js'
import { expandMentions, mentionAttachments, mentionFs } from './channel/mentions.js'
import { listFilesDeepCandidates, listPathCandidates, sessionCwdMatches } from './channel/paths.js'
import { legacyPermissionPresetSnapshot, permissionPresetSnapshotFromService, unavailablePermissionPresetSnapshot } from './channel/permissions.js'
import { createPreferences } from './channel/preferences.js'
import { createSettingsHosts } from './channel/settings-host.js'
import { createChannelOwner, registerChannelOwner } from './channel/owner.js'
import { ARGS_PREVIEW_LIMIT, foldBack, harnessToolResultView, LOCAL_OUTPUT_LIMIT, prepareReplayEvents, preview, RESULT_PREVIEW_LIMIT, toolErrorText } from './channel/transcript.js'
import type { ActivityStatus, AgentViewRow, Channel, ChannelGoal, ChannelImageBlock, ChannelState, ChatRow, CredentialStatus, EffortOption, JobControl, LoadedContextEntry, LoadedContextFile, LoadedContextSkill, LoadedContextTool, MentionFs, NotificationItem, PendingMessage, PresetOption, ResumeResult, SideQuestionLlm, StagedImageInput, SubagentControl, SubagentRow, TodoPanelItem, ToolCallView, ToolResultView, ToolsRegistryLike } from './channel/types.js'
import { estimateTokens, isTokenDelta, tokenDeltaChars, usageOutputTokens } from './channel/usage.js'
import { commandOwner } from './command-attribution.js'
import { hasCommandErrorCode, mapCommandError } from './command-errors.js'
import { getHostCommandTrees } from './command-trees.js'
import { appendSessionTitle, defaultMaxScanned, deleteSessionLog, readSessionEventsFromFile, readSessionEventsFromLog, sessionsRoots } from './compat/index.js'
import { installedMeetsVersion } from './contract.js'
import { installDecisionGuard, markDecisionDispatchTopology } from './decision-guard.js'
import type {
  TuiRewindMode
} from './extension-events.js'
import { dispatchTuiDecision, dispatchTuiNotification, normalizeCancelDecision } from './extension-events.js'
import { getHostGrantStore } from './host-grants.js'
import { BackgroundJobStore, formatJobDuration, type JobsRuntime } from './jobs.js'
import { getHostMessageObserver, type TuiMessageObserverRuntime } from './message-observer.js'
import { getHostFacade } from './plugin-host.js'
import { pluginsInfoLines } from './plugins-info.js'
import { resolveCompatiblePreset, rosterOf, type AgentPresetInfo } from './preset-resolution.js'
import { composePreset, runningPresetOf, serviceForAgent } from './presets.js'
import { collectRecentActivity, parseRecapResponse, RECAP_RECENT_CHARS, wrapRecapPrompt } from './recap.js'
import { getHostRenderers, type TuiRendererRuntime } from './renderers.js'
import { cleanRenderText } from './sanitize.js'
import { getHostSceneRuntime, type TuiSceneRuntime } from './scenes.js'
import {
  listSummaries,
  locateSession,
  noteBranch,
  previewSession,
  readHeader,
  type RawSessionHeader,
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
import { runSideQuestion, wrapSideQuestion } from './sideQuestion.js'
import { SubagentActivityStore, type SubagentState } from './subagents.js'
import { getHostThemes, type TuiThemeRuntime } from './themes.js'
import { attachSessionToWorkspace } from './workspace.js'
import { createLocalWorkspaceRuntime, getHostWorkspaceRuntime, type TuiWorkspaceTarget } from './workspaces.js'
export type { SubagentState } from './subagents.js'

/**
 * Delay before re-reading a skill catalog that reported an incomplete
 * observation (a provider whose directory watcher is still warming).
 */
const SKILL_COMMAND_RETRY_MS = 800

import { isSubagentToolName, parseJobOutputId, toolCommandOf, BACKGROUND_START_ACK, todoPanelItems } from './channel/projection-helpers.js'
/** Buffer below the context window at which CC warns (autoCompact.ts). */
const CONTEXT_WARNING_BUFFER_TOKENS = 20_000

/** How many trailing exchanges the browser's preview pane asks for. */
const PREVIEW_ENTRIES = 8

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

  // ── agent view internal state ─────────────────────────────────────────────
  // Handles of background sessions this channel dispatched or backgrounded.
  // The agents themselves live in the host registry (ctx.agents) and die with
  // this process's tree; the handles are what stopping one needs to dispose.
  const backgroundHandles = new Map<string, AgentHandle>()
  // The plugin's approval store, bound post-construction (bindApprovalStore):
  // row derivation reads the agent ids it has parked requests for, and its
  // emit re-publishes as an agent-view change so "needs input" appears live.
  let approvalStore: {
    pendingAgentIds(): readonly string[]
    pendingAgentDetail(agentId: string): { toolName: string; reason?: string; command?: string } | undefined
    subscribe(listener: () => void): () => void
  } | undefined
  const agentViewListeners = new Set<() => void>()
  // The row snapshot is a cached array rebuilt on the next read after a
  // notify — useSyncExternalStore demands a stable reference between changes.
  let agentViewRowsCache: readonly AgentViewRow[] | undefined
  const notifyAgentView = (): void => {
    agentViewRowsCache = undefined
    for (const listener of agentViewListeners) listener()
  }
  // Background-agent activity (status flips, session events) refreshes the
  // rows at most every 300 ms — token-level streaming must not rebuild the
  // snapshot per token.
  let agentViewRefreshTimer: NodeJS.Timeout | undefined
  const scheduleAgentViewRefresh = (): void => {
    if (agentViewRefreshTimer !== undefined) return
    agentViewRefreshTimer = setTimeout(() => {
      agentViewRefreshTimer = undefined
      notifyAgentView()
    }, 300)
  }
  // Persisted sessions without a live agent, cached so the synchronous row
  // snapshot can merge them; refreshed by listSessions() and attachToAgent.
  let persistedRowsCache: readonly SessionSummary[] = []
  void listSessionsSnapshot(ctx).then((rows) => {
    persistedRowsCache = rows
    notifyAgentView()
  })
  // Incremental fold cache per live agent: re-folded only over events
  // appended since the last call, so agentViewRows() stays cheap during
  // token-level streaming (a fresh frozen events array per append).
  const agentViewFolds = new Map<string, { events: readonly SessionEvent[]; fold: AgentViewFold }>()
  const foldOf = (liveAgent: Agent): AgentViewFold => {
    const events = snapshotLiveSessionEvents(liveAgent.session)
    const cached = agentViewFolds.get(String(liveAgent.id))
    const base: AgentViewFold = {
      hasTurns: false,
      firstPrompt: '',
      summary: '',
      summaryKind: 'none',
      title: '',
      updatedAt: liveAgent.session.header.createdAt,
      lastTurnFailed: false,
    }
    if (cached === undefined) {
      const fold = foldAgentViewEvents(events, 0, base)
      agentViewFolds.set(String(liveAgent.id), { events, fold })
      return fold
    }
    if (cached.events === events) return cached.fold
    const fold = foldAgentViewEvents(events, cached.events.length, cached.fold)
    agentViewFolds.set(String(liveAgent.id), { events, fold })
    return fold
  }
  const dropFold = (sessionId: string): void => {
    agentViewFolds.delete(sessionId)
  }
  // One process-lifetime set of agent-lifecycle listeners (the TUI and the
  // channel share the process): any agent's status/creation/disposal moves
  // rows in the view, not only the attached session's.
  ctx.on('agent/status', () => scheduleAgentViewRefresh())
  ctx.on('agent/created', () => notifyAgentView())
  ctx.on('agent/disposed', ({ agent: subject }: { agent: { id?: unknown } }) => {
    dropFold(String(subject.id ?? ''))
    notifyAgentView()
  })
  const subagentControl: SubagentControl = {
    interrupt(agentId) {
      const child = subagentStore.get(agentId)
      const target = child?.sessionId ?? agentId
      const runtime = (ctx as any).subagents
      if (!runtime?.interrupt || !target) return false
      try {
        runtime.interrupt(target, { kind: 'ancestor', agent: binding.agent })
        subagentStore.onCancelled(agentId, 'interrupted')
        syncSubagentsNow()
        state.emit()
        return true
      } catch {
        return false
      }
    },
  }
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
  // Subagent activity tracking: collects agent/subagent/*, session/event for
  // subagents, and exposes live snapshots for the UI.
  const subagentStore = new SubagentActivityStore()
  // Subagent ChatRow tracking: maps agentId to its ChatRow for live updates.
  const subagentRowsByAgentId = new Map<string, ChatRow>()
  // Task tool descriptions, queued in call order; each subagent/start consumes
  // the oldest one so the card shows the user-visible task label.
  const pendingTaskDescriptions: string[] = []
  // Background-job tracking (`ctx.jobs`, optional service): the registry's
  // host-level listeners see every owner's commits; the channel re-reads the
  // CURRENT agent's visible set after each one and projects it into
  // transcript rows (kind 'job'), the /jobs panel, the status-line chip and
  // completion toasts. The registry read stays untouched — output is
  // mirrored from the agent's own job_output results (see onOutputSeen).
  const jobRowsByJobId = new Map<string, ChatRow>()
  const syncJobRows = (): void => {
    state.backgroundJobs = jobStore.snapshot()
    for (const job of state.backgroundJobs) {
      let row = jobRowsByJobId.get(job.id)
      if (!row) {
        // New job: card joins the transcript tail, like the subagent cards.
        row = {
          id: rowIds.value++,
          kind: 'job',
          text: job.label,
          job: undefined,
        }
        jobRowsByJobId.set(job.id, row)
        state.rows.push(row)
      }
      row.job = {
        id: job.id,
        kind: job.kind,
        label: job.label,
        status: job.status,
        ...(job.detail === undefined ? {} : { detail: job.detail }),
        startedAt: job.startedAt,
        ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
        outputLines: job.outputLines,
      }
      row.text = job.label
      markChannelReadDirty(row)
      markChannelReadDirty(state.rows)
    }
  }
  const jobStore = new BackgroundJobStore({
    onSettled(job) {
      notify(
        t(
          job.status === 'completed'
            ? 'jobs-toast-completed'
            : job.status === 'failed'
              ? 'jobs-toast-failed'
              : 'jobs-toast-killed',
          {
            id: job.id,
            label: job.label,
            duration: formatJobDuration(job),
            detail: job.detail ?? '',
          },
        ),
        {
          color: job.status === 'completed' ? 'success' : job.status === 'failed' ? 'error' : 'warning',
          timeoutMs: 6000,
        },
      )
    },
    onChanged() {
      syncJobRows()
      state.emit()
    },
  })
  /** Live reference to the registry while the jobs service is mounted;
   *  cleared again when the service goes away (inject fiber cleanup). */
  let jobsRuntime: JobsRuntime | undefined
  const jobControl: JobControl = {
    kill(id) {
      const jobs = jobsRuntime
      if (!jobs?.kill) return false
      const job = jobStore.get(id)
      try {
        jobs.kill(id, binding.agent, 'dsh-tui /jobs panel')
      } catch {
        return false
      }
      // kill() marks the job reported, which SUPPRESSES the harness
      // completion notice — without this steer the model only learns about
      // the user's kill lazily, from its next job_list/job_output read.
      // Steer only for a job that was actually live; the steering row
      // doubles as the transcript record of the action.
      if (job !== undefined && (job.status === 'running' || job.status === 'stopping')) {
        channelCommands(state).steer(t('jobs-steer-killed', { id, label: job.label }))
      }
      return true
    },
  }
  // The jobs registry is optional: compositions without it load the UI
  // unchanged (feature silently off). inject() handles any load order when
  // the context offers it; stub/embedded contexts without the inject
  // lifecycle fall back to a direct lookup — the same degradation posture
  // as `(ctx as any).subagents` above.
  const attachJobs = (jobs: JobsRuntime | undefined, onDetach?: (dispose: () => void) => void): void => {
    if (jobs === undefined) return
    jobsRuntime = jobs
    const refresh = (): void => {
      try {
        jobStore.replace(jobs.list(binding.agent))
      } catch {
        // Owner no longer live / service disposing: keep the last view.
      }
    }
    const disposers = [
      typeof jobs.onJobsChanged === 'function' ? jobs.onJobsChanged(refresh) : undefined,
      typeof jobs.onJobDone === 'function' ? jobs.onJobDone(refresh) : undefined,
    ]
    refresh()
    onDetach?.(() => {
      jobsRuntime = undefined
      for (const dispose of disposers) dispose?.()
    })
  }
  if (typeof (ctx as { inject?: unknown }).inject === 'function') {
    ctx.inject(['jobs'], jobsCtx => {
      attachJobs(
        (jobsCtx as { jobs?: JobsRuntime }).jobs,
        dispose => jobsCtx.effect(() => dispose),
      )
    })
  } else {
    attachJobs((ctx as { get?: (name: string) => unknown }).get?.('jobs') as JobsRuntime | undefined)
  }

  /**
   * Sync subagentStore state into ChatRows (insert/update in state.rows).
   * Called whenever subagent state changes (spawned/completed/failed/output).
   * Accepts a caller-taken snapshot to avoid the double copy on the hot path
   * (session/event fires per subagent token: snapshot here + snapshot in the
   * caller = two full state copies before emitStream's 16ms throttle).
   */
  const syncSubagentRows = (preSnapshot?: readonly SubagentState[]): void => {
    const snapshot = preSnapshot ?? subagentStore.snapshot()
    for (const sub of snapshot) {
      let row = subagentRowsByAgentId.get(sub.agentId)
      if (!row) {
        // New subagent: insert a new ChatRow after the last user or assistant message
        row = {
          id: rowIds.value++,
          kind: 'subagent',
          text: sub.description,
          subagent: undefined, // will be filled below
        }
        subagentRowsByAgentId.set(sub.agentId, row)
        state.rows.push(row)
      }
      const subagentRow: SubagentRow = {
        agentId: sub.agentId,
        runId: sub.runId,
        description: sub.description,
        provider: sub.provider,
        model: sub.model || 'default',
        effort: sub.effort,
        status: sub.status,
        startedAt: sub.startedAt,
        completedAt: sub.completedAt,
        durationMs: sub.completedAt ? sub.completedAt - sub.startedAt : Date.now() - sub.startedAt,
        outputLines: sub.output.slice(-3),
        toolCalls: sub.toolCalls,
        tokens: sub.tokens,
        summary: sub.summary,
        stopReason: sub.stopReason,
        error: sub.error,
      }
      row.subagent = subagentRow
      row.text = sub.description
      markChannelReadDirty(row)
      markChannelReadDirty(state.rows)
    }
  }
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
  const emitter = createChannelEmitter(() => state, () => flushSubagentStream())
  if (typeof ctx.effect === 'function') ctx.effect(() => () => { owner.dispose(); emitter.dispose() })
  /** True while subagent assistant/chunk deltas have deferred their
   *  snapshot+projection to the frame-aligned flush (emitStream's timer).
   *  Chunks arrive at token rate (100-300 events/s) and the projection is a
   *  full deep state copy (SubagentActivityStore.snapshot) plus a SubagentRow
   *  rebuild per tracked agent — running that per token sits BEFORE
   *  emitStream's 16ms coalescing and defeats it. Non-chunk events
   *  (tool/call, subagent/end, interrupt) project immediately and clear
   *  this flag, so lifecycle transitions stay synchronous. */
  let subagentStreamDirty = false
  /** Deferred projection for the frame-aligned flush: runs INSIDE the
   *  emitStream timer, before listeners wake, so React always reads fully
   *  projected rows. No-op unless a chunk marked the projection dirty. */
  const flushSubagentStream = (): boolean => {
    if (!subagentStreamDirty) return false
    subagentStreamDirty = false
    state.subagents = subagentStore.snapshot()
    syncSubagentRows(state.subagents)
    return true
  }
  /** Immediate projection; supersedes any pending deferred flush (the fresh
   *  snapshot already contains everything the deferred pass would project). */
  const syncSubagentsNow = (): void => {
    subagentStreamDirty = false
    state.subagents = subagentStore.snapshot()
    syncSubagentRows(state.subagents)
  }
  /** Drop the subagent row map (transcript wipe): the next event for a still
   *  live subagent re-creates its card as a fresh row instead of feeding a
   *  row object no transcript holds (update-only orphan). */
  const dropSubagentRows = (): void => {
    subagentStreamDirty = false
    subagentRowsByAgentId.clear()
  }
  /** Full subagent reset for a session swap: the row map, the queued task
   *  descriptions and the store itself are all scoped to the OLD agent's
   *  session. Leaked into the adopted one, they would keep dead subagents in
   *  the dashboard snapshot until new events overwrite it, grow the row map
   *  without bound across swaps, and hand a stale queued description to the
   *  new session's first card. */
  const resetSubagentProjection = (): void => {
    dropSubagentRows()
    pendingTaskDescriptions.length = 0
    subagentStore.reset()
    state.subagents = []
  }
  /** Full job reset for a session swap: the row map and store are scoped to
   *  the OLD agent's session. Runs BEFORE the swap disposes the old agent,
   *  so the teardown cancellation those jobs receive finds an empty store —
   *  no "killed" toast storm for work the swap itself took down. */
  const resetJobProjection = (): void => {
    jobRowsByJobId.clear()
    jobStore.reset()
  }
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

  /** The llm runtime seam (dsh-llm LlmRuntime): route metadata resolution. */
  const llmRuntime = ctx.get('llm') as
    | {
        resolveModelInfo(
          provider: string,
          model: string,
        ): Promise<{
          reasoning?: {
            efforts: ReadonlyArray<{ id: string; name: string; description?: string }>
            defaultEffort?: string
          }
        }>
      }
    | undefined

  /** Mutable per-agent model selection (dsh-agent's routing override seam).
   *  `current` stays undefined until the user explicitly cycles effort, so
   *  default routing (agentOptions on create/fork) is untouched; bindAgent
   *  re-couples it to each new agent's prompt assembly + request config. */
  const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
  /** The effort chosen this run (or persisted from a previous one); applied
   *  to every newly bound agent once validated against its adapter's list.
   *  Chain: settings user layer (applied later via setDefaultEffort) →
   *  cordis.yml `effort` → the persisted /effort choice → adapter default. */
  let preferredEffort: string | undefined = resolveEffortDefault(undefined, options.effort, readEffortPref())

  /** Pin `preferredEffort` on the live agent when its route offers it;
   *  silent no-op otherwise (the next request/header corrects the display). */
  const applyPreferredEffort = async (): Promise<void> => {
    if (preferredEffort === undefined || llmRuntime === undefined) return
    try {
      const info = await llmRuntime.resolveModelInfo(state.provider, state.model)
      state.effortLevels = (info.reasoning?.efforts ?? []).map(level => level.id)
      if (!info.reasoning?.efforts.some(effort => effort.id === preferredEffort)) return
      selection.current = {
        provider: state.provider,
        model: state.model,
        reasoningEffort: ReasoningEffortId(preferredEffort),
      }
    } catch {
      // Route metadata resolution is best-effort; a failure just leaves the
      // provider default in effect.
    }
  }

  /** Best-effort refresh of the live route's effort-level table for
   *  top-tier-triggered UI (effort ignition): fire-and-forget on route
   *  changes (bind/model switch/resume); the /effort paths refresh it
   *  authoritatively via resolveEfforts. */
  let effortLevelsGeneration = 0
  const refreshEffortLevels = (): void => {
    if (llmRuntime === undefined || typeof llmRuntime.resolveModelInfo !== 'function') return
    // 代际保护：快速连续切路由时并发的 resolveModelInfo 可能乱序返回，
    // 只有最新一代的解析才允许落表；落表后 emit 让 useSyncExternalStore
    // 消费者立刻可见（否则要等下一次无关 emit）。
    const generation = ++effortLevelsGeneration
    void llmRuntime
      .resolveModelInfo(state.provider, state.model)
      .then(info => {
        if (generation !== effortLevelsGeneration) return
        state.effortLevels = (info.reasoning?.efforts ?? []).map(level => level.id)
        state.emit()
      })
      .catch(() => {
        // Route metadata resolution is best-effort; a failure keeps the
        // previous table until the next /effort interaction clears it.
      })
  }

  /** Resolve the live route's effort levels + adapter default through the
   *  llm runtime; 'unavailable' when the service is unmounted, 'error' when
   *  resolution throws (notified here). */
  const resolveEfforts = async (): Promise<
    | {
        efforts: ReadonlyArray<{ id: string; name: string; description?: string }>
        defaultEffort: string | undefined
      }
    | 'unavailable'
    | 'error'
  > => {
    if (llmRuntime === undefined) return 'unavailable'
    try {
      const info = await llmRuntime.resolveModelInfo(state.provider, state.model)
      state.effortLevels = (info.reasoning?.efforts ?? []).map(level => level.id)
      return {
        efforts: info.reasoning?.efforts ?? [],
        defaultEffort: info.reasoning?.defaultEffort,
      }
    } catch (error) {
      notify(t('effort-read-failed', { error: error instanceof Error ? error.message : String(error) }), {
        color: 'error',
        timeoutMs: 8000,
      })
      return 'error'
    }
  }

  /** Pin one validated effort level on the live route: reroutes the next
   *  request, persists the choice, and refreshes the StatusLine segment. */
  const applyEffort = (effort: { id: string; name: string }): void => {
    selection.current = {
      provider: state.provider,
      model: state.model,
      reasoningEffort: ReasoningEffortId(effort.id),
    }
    preferredEffort = effort.id
    state.reasoningEffort = effort.id
    writeEffortPref(effort.id)
    notify(t('effort-switched', { name: effort.name }))
    state.emit()
  }

  /** The live route's effort levels for the `/effort` slider; empty after
   *  notifying when the route is unsupported/unavailable/single-tier. */
  const listEfforts = async (): Promise<{ efforts: readonly EffortOption[]; defaultEffort: string | undefined }> => {
    const resolved = await resolveEfforts()
    if (resolved === 'unavailable') {
      notify(t('effort-unavailable'), { color: 'error' })
      return { efforts: [], defaultEffort: undefined }
    }
    if (resolved === 'error') return { efforts: [], defaultEffort: undefined }
    if (resolved.efforts.length === 0) {
      notify(t('effort-unsupported'), { color: 'warning' })
    } else if (resolved.efforts.length === 1) {
      notify(t('effort-single-tier', { name: resolved.efforts[0]!.name }), { color: 'warning' })
    }
    return resolved
  }

  /** Set one effort level by id (`/effort <id>` and the slider's live
   *  apply); false + a notify when the id is not offered by the route. */
  const setEffort = async (id: string): Promise<boolean> => {
    const resolved = await resolveEfforts()
    if (resolved === 'unavailable') {
      notify(t('effort-unavailable'), { color: 'error' })
      return false
    }
    if (resolved === 'error') return false
    if (resolved.efforts.length === 0) {
      notify(t('effort-unsupported'), { color: 'warning' })
      return false
    }
    const found = resolved.efforts.find(effort => effort.id === id)
    if (!found) {
      notify(
        t('effort-invalid', { id, ids: resolved.efforts.map(effort => effort.id).join(', ') }),
        { color: 'warning' },
      )
      return false
    }
    applyEffort(found)
    return true
  }

  /** The /settings “default reasoning effort” (see the public Channel
   *  type): re-seat the future-sessions default without touching effort.json
   *  (the settings user layer outranks that file); an absent level re-derives
   *  the boot chain (cordis `effort` → the persisted /effort choice). Also
   *  re-pins the live agent when its route offers the level, so the change
   *  lands on the next request. No-op when the effective level is unchanged. */
  const setDefaultEffort = (id: string | undefined): void => {
    const resolved = resolveEffortDefault(id, options.effort, readEffortPref())
    if (resolved === preferredEffort) return
    preferredEffort = resolved
    void applyPreferredEffort()
  }

  /** One composer image accompanying a registry-command line: structural
   *  mirror of rc.8's `EncodedImageAttachment` (`@deepseek-ai/dsh-attachment/
   *  types`). Kept local so older installs never resolve rc.8-only types. */
  type RegistryCommandImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  interface RegistryCommandImage {
    mediaType: RegistryCommandImageMediaType
    data: string
    name?: string
  }
  type RegistryCommandImageBatch =
    | { readonly kind: 'legacy' }
    | { readonly kind: 'ready'; readonly images: readonly RegistryCommandImage[] }
    | { readonly kind: 'error'; readonly reason: 'runtime' | 'missing' | 'limits'; readonly tokens: readonly string[] }
  /** Legacy command-service execute (rc.7 and older): (agent, line, signal). */
  type CommandExecuteLegacy = (agent: Agent, line: string, signal: AbortSignal) => Promise<CommandExecution | undefined>
  /** rc.8 command-service execute: composer images precede the signal. */
  type CommandExecuteWithImages = (
    agent: Agent,
    line: string,
    images: readonly RegistryCommandImage[],
    signal: AbortSignal,
  ) => Promise<CommandExecution | undefined>

  /** Whether the installed command service takes composer images: version
   *  gate (composer images arrived on 0.1.0-rc.8 and every later family —
   *  0.1.1 included — keeps the 4-param shape) with a structural fallback,
   *  so a failed manifest probe (bundlers, exotic loaders) still lands on
   *  the 4-param rc.8 shape at runtime. */
  const commandServiceSupportsImages = (service: CommandRuntime): boolean => {
    if (installedMeetsVersion('@deepseek-ai/dsh-commands', '0.1.0-rc.8')) return true
    return typeof (service.execute as { length?: number } | undefined)?.length === 'number'
      && (service.execute as { length: number }).length >= 4
  }

  /** Run one DSH registry command (`/plan`, …) on the live agent; the text
   *  of its result, '' when the result is textless, undefined when the
   *  command is not registered, and the error message when it throws. */
  const executeRegistryCommand = async (name: string, rawInput: string): Promise<string | undefined> => {
    const invocation = binding.capture()
    assertCapabilityShadowPolicy('host.commands.invoke', adapterRuntime.mode, adapterRuntime.slices)
    if (!commandService) return undefined
    const commandAgent = agent
    const stagedSnapshot = new Map(stagedImages)
    // Resolve the exact definition that execute() will select for this agent.
    // Same names may exist in distinct agent scopes, so a name-only lookup can
    // apply another scope's owner policy.
    const definition = commandService.find(binding.agent, name)
    const owner = commandOwner(ctx, definition)
    // The root checkpoint covers host/direct registrations.  A built-in name
    // is not necessarily a namespaced contribution id, so use a deterministic
    // host scope for that case; legacy unscoped denies still conservatively
    // revoke every valid command scope.
    const rootScope = owner?.commandId
      ?? (/^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/u.test(name)
        ? name
        : `dsh-tui.${name.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'command'}`)
    try {
      const signal = new AbortController().signal
      const line = `/${name}${rawInput}`
      const images = await registryCommandImages(commandService, definition, line, signal)
      if (!binding.isCurrent(invocation)) return undefined
      // rc.8 moved the signal to the 4th parameter and added composer
      // images; older lines (rc.7/rc.6) take (agent, line, signal).
      const execution = images === undefined
        ? await (commandService.execute as unknown as CommandExecuteLegacy)(invocation.agent, line, signal)
        : await (commandService.execute as unknown as CommandExecuteWithImages)(invocation.agent, line, images.images, signal)
      if (images !== undefined && images.dropped.length > 0) {
        // Loud-drop policy mirrors the submit pipeline (mentions-missing):
        // a referenced image that never reached the command must be visible.
        notify(t('mentions-missing', { paths: images.dropped.join(' ') }), {
          color: 'warning',
          timeoutMs: 4000,
        })
      }
      // `undefined` = not registered; a handler error surfaces as its
      // message so the user sees why the command failed.
      return execution === undefined ? undefined : execution.result.text ?? ''
    } catch (error) {
      return {
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
        consumeDraft: false,
      }
    }
  }

  /** Encode the staged `@`-mention images the user pasted for THIS command
   *  line into rc.8's `EncodedImageAttachment` payloads; `kind: 'legacy'`
   *  means the installed dsh-commands line predates composer images
   *  (rc.7/rc.6), so the caller uses the legacy 3-arg invoke. Matches the
   *  submit pipeline's
   *  token rule (expandMentions): a staged image attaches only when the
   *  line references its token. The composer preflights `input.images`, but
   *  this adapter still forwards every supplied image: rc.8 owns admission,
   *  so non-UI callers cannot accidentally bypass the registry contract.
   *  Preparation is atomic: limits are checked from durable metadata before
   *  any read/base64 work, and one missing or unreadable image prevents the
   *  handler from running with a silently truncated batch. */
  const registryCommandImages = async (
    service: CommandRuntime,
    line: string,
    imageRefs: readonly ComposerImageRef[],
    staged: ReadonlyMap<string, ChannelImageBlock['attachment']>,
    signal: AbortSignal,
  ): Promise<{ images: RegistryCommandImage[]; dropped: string[] } | undefined> => {
    if (!commandServiceSupportsImages(service)) return undefined
    const declaresImages = (definition as { input?: { images?: boolean } } | undefined)?.input?.images === true
    const stagedImages = inputDelivery.stagedImages()
    if (!declaresImages || stagedImages.size === 0) return { images: [], dropped: [] }
    const store = mentionAttachments(ctx) as
      | { readImage?(ref: unknown, signal?: AbortSignal): Promise<{ data: Uint8Array }> }
      | undefined
    if (typeof store?.readImage !== 'function') return { images: [], dropped: [] }
    const images: RegistryCommandImage[] = []
    const dropped: string[] = []
    for (const [token, attachment] of stagedImages) {
      if (!line.includes(token)) continue
      try {
        const stored = await store.readImage(attachment, signal)
        if (stored?.data instanceof Uint8Array && stored.data.byteLength > 0) {
          images.push({
            mediaType: attachment.mediaType,
            data: Buffer.from(stored.data).toString('base64'),
            name: attachment.name,
          })
        } else {
          dropped.push(token)
        }
      } catch {
        // One unreadable staged image is dropped — same loud policy as the
        // submit pipeline's mentions-missing warning (deliverUserText).
        dropped.push(token)
      }
    }
    if (!commandServiceSupportsImages(service)) {
      return ordered.size > 0
        ? { kind: 'error', reason: 'runtime', tokens: [...ordered.keys()] }
        : { kind: 'legacy' }
    }
    if (ordered.size === 0) return { kind: 'ready', images: [] }
    const store = mentionAttachments(ctx) as
      | (MentionAttachments & { readImage?(ref: unknown, signal?: AbortSignal): Promise<{ data: Uint8Array }> })
      | undefined
    if (typeof store?.readImage !== 'function') {
      return { kind: 'error', reason: 'missing', tokens: [...ordered.keys()] }
    }
    const { imageLimits: limits } = store
    let declaredBytes = 0
    for (const attachment of ordered.values()) {
      if (
        !Number.isSafeInteger(attachment.bytes)
        || attachment.bytes <= 0
        || attachment.bytes > limits.maxImageBytes
        || !limits.mediaTypes.includes(attachment.mediaType)
      ) {
        return { kind: 'error', reason: 'limits', tokens: [...ordered.keys()] }
      }
      declaredBytes += attachment.bytes
    }
    if (
      ordered.size > limits.maxImagesPerMessage
      || declaredBytes > limits.maxMessageImageBytes
    ) {
      return { kind: 'error', reason: 'limits', tokens: [...ordered.keys()] }
    }
    const loaded: Array<{
      readonly token: string
      readonly attachment: ChannelImageBlock['attachment']
      readonly data: Uint8Array
    }> = []
    let actualBytes = 0
    for (const [token, attachment] of ordered) {
      try {
        const stored = await store.readImage(attachment, signal)
        if (!(stored?.data instanceof Uint8Array) || stored.data.byteLength <= 0) {
          return { kind: 'error', reason: 'missing', tokens: [token] }
        }
        actualBytes += stored.data.byteLength
        if (
          stored.data.byteLength > limits.maxImageBytes
          || actualBytes > limits.maxMessageImageBytes
        ) {
          return { kind: 'error', reason: 'limits', tokens: [...ordered.keys()] }
        }
        loaded.push({ token, attachment, data: stored.data })
      } catch {
        return { kind: 'error', reason: 'missing', tokens: [token] }
      }
    }
    return {
      kind: 'ready',
      images: loaded.map(({ attachment, data }) => ({
        mediaType: attachment.mediaType,
        data: Buffer.from(data).toString('base64'),
        name: attachment.name,
      })),
    }
  }

  // Session-mode folds: last-wins projections over the session log. The
  // event types are registered by dsh-plan-mode / dsh-sandbox-policy /
  // dsh-user-approval and are NOT in this package's typed SessionEvent
  // union, so they are matched by name through casts — the same pattern as
  // `agent-preset/selected` in renderEvent and the goal projection above.
  const foldPlanActive = (events: readonly SessionEvent[]): boolean => {
    let active = false
    for (const event of events) {
      if ((event as { type: string }).type === 'plan/mode') {
        active = (event.data as unknown as { active?: boolean }).active === true
      }
    }
    return active
  }
  const foldSandboxMode = (events: readonly SessionEvent[]): string | undefined => {
    let mode: string | undefined
    for (const event of events) {
      if ((event as { type: string }).type === 'sandbox/mode') {
        const value = (event.data as unknown as { mode?: string }).mode
        if (typeof value === 'string') mode = value
      }
    }
    return mode
  }
  const foldApprovalPolicy = (events: readonly SessionEvent[]): string | undefined => {
    let policy: string | undefined
    for (const event of events) {
      if ((event as { type: string }).type === 'approval/policy') {
        const value = (event.data as unknown as { policy?: string }).policy
        if (typeof value === 'string') policy = value
      }
    }
    return policy
  }
  /** Last durable permission preset identity (`permission/preset`), if any.
   *  Registered by the harness permission preset service, never manufactured
   *  by the TUI. */
  const foldPermissionPreset = (events: readonly SessionEvent[]): string | undefined => {
    let preset: string | undefined
    for (const event of events) {
      if ((event as { type: string }).type === 'permission/preset') {
        const value = (event.data as unknown as { preset?: string }).preset
        if (typeof value === 'string') preset = value
      }
    }
    return preset
  }

  /** First configured mode whose declared atoms all match the folds;
   *  undeclared atoms are wildcards; no match → index 0 (the base mode).
   *  Matching is exact: a fresh session has no `approval/policy` event, so
   *  a mode declaring `approval: 'ask'` never falsely matches it. */
  const deriveModeIndex = (events: readonly SessionEvent[]): number => {
    // A durable permission identity is stronger than the derived sandbox /
    // approval atoms. This keeps a runtime preset (including one that maps
    // to the same atoms as a static mode) selected after resume or manual
    // commands instead of snapping to a look-alike static mode.
    const permission = foldPermissionPreset(events)
    if (permission !== undefined) {
      const permissionIndex = sessionModes.findIndex(
        spec =>
          spec.permission === permission
          && (spec.plan === undefined || foldPlanActive(events) === spec.plan),
      )
      if (permissionIndex >= 0) return permissionIndex
    }
    // Atom fallback: permission-only (dynamic) specs declare no atoms and
    // would wildcard-match ANY session state, stealing the indicator on
    // sessions that never held a durable identity. They can only be
    // selected through the permission branch above.
    const index = sessionModes.findIndex(
      spec =>
        spec.permission === undefined
        && (spec.plan === undefined || foldPlanActive(events) === spec.plan)
        && (spec.sandbox === undefined || foldSandboxMode(events) === spec.sandbox)
        && (spec.approval === undefined || foldApprovalPolicy(events) === spec.approval),
    )
    return index >= 0 ? index : 0
  }

  /** Re-derive the current mode from the live session log (boot, every
   *  agent re-bind, and after mode-affecting session events). */
  const refreshMode = (): void => {
    state.modeIndex = deriveModeIndex(binding.agent.session.events)
    state.mode = sessionModes[state.modeIndex]!
  }

  // Session.append rejects observer reentry; restore after publication unwinds.
  const pendingPlanExitRestores = new Map<object, SessionModeSpec>()
  const prePlanModes = new WeakMap<object, SessionModeSpec>()
  /** Durable preset identity captured when plan mode starts; an implicit plan
   *  exit (approval / manual `/plan off`) prefers returning to it over the
   *  canonical bundle of the restored atoms, so the user lands back on their
   *  own preset (e.g. a third-party `auto`), not on a look-alike static mode. */
  const prePlanPermissionIdentity = new WeakMap<object, string>()
  // An in-turn /plan off commits at pre-step, after the command has returned.
  const explicitPlanExits = new WeakSet<object>()

  const modePermissions = (events: readonly SessionEvent[]): SessionModeSpec => {
    const sandbox = foldSandboxMode(events)
    const approval = foldApprovalPolicy(events)
    return {
      id: 'restore',
      ...(sandbox === 'read-only' || sandbox === 'workspace-write' || sandbox === 'danger-full-access'
        ? { sandbox } : {}),
      ...(approval === 'ask' || approval === 'never' ? { approval } : {}),
    }
  }

  /** Recover a resumed plan's snapshot before /plan ran, not before its
   *  deferred plan/mode event. Unknown historical atoms stay untouched. */
  const prePlanModeSpec = (log: readonly SessionEvent[]): SessionModeSpec | undefined => {
    let active = false
    let start = -1
    let command: { index: number; id: unknown } | undefined
    for (let index = 0; index < log.length - 1; index += 1) {
      const event = log[index]!
      const type = (event as { type: string }).type
      const data = event.data as unknown as Record<string, unknown>
      if (!active && type === 'command/run' && data.name === 'plan' && typeof data.args === 'string') {
        if (data.args.trim() === 'off') command = undefined
        else command ??= { index, id: data.commandId }
      }
      if (type === 'command/done' && data.commandId === command?.id && data.kind !== 'success') {
        command = undefined
      }
      if (type === 'plan/mode') {
        if (data.active === true && !active) start = command?.index ?? index
        active = data.active === true
        command = undefined
      }
    }
    return active && start >= 0 ? modePermissions(log.slice(0, start)) : undefined
  }

  const applyModeAtoms = (spec: SessionModeSpec): void => {
    // The durable sandbox override is one session event (dsh-sandbox-policy's
    // own write path); the session/event arm picks it up immediately.
    if (spec.sandbox !== undefined && foldSandboxMode(binding.agent.session.events) !== spec.sandbox) {
      ;(binding.agent.session as unknown as { append(type: string, data: Record<string, unknown>): unknown }).append(
        'sandbox/mode',
        { mode: spec.sandbox },
      )
    }
    // Prefer the approval service (it narrates the switch to the model);
    // the raw durable event is the fallback when it is unmounted.
    if (spec.approval !== undefined && foldApprovalPolicy(binding.agent.session.events) !== spec.approval) {
      const approval = ctx.get('approval') as
        | { setPolicy(a: Agent, policy: 'ask' | 'never'): void }
        | undefined
      approval?.setPolicy(binding.agent, spec.approval)
      // The service may no-op when its configured default already matches.
      if (foldApprovalPolicy(binding.agent.session.events) !== spec.approval) {
        ;(binding.agent.session as unknown as { append(type: string, data: Record<string, unknown>): unknown }).append(
          'approval/policy',
          { policy: spec.approval },
        )
      }
    }
  }

  /** Effective sandbox of a mode target: its explicit atom, else the folded
   *  session value, else the sandbox-policy service default. Unknown means
   *  the bundle is not safely mappable. */
  const effectiveSandboxForMode = (spec: SessionModeSpec): SessionModeSpec['sandbox'] | undefined => {
    if (spec.sandbox !== undefined) return spec.sandbox
    const folded = foldSandboxMode(snapshotLiveSessionEvents(agent.session))
    if (folded === 'read-only' || folded === 'workspace-write' || folded === 'danger-full-access') return folded
    try {
      const sandbox = ctx.get('sandboxPolicy') as { defaultMode?: unknown } | undefined
      const value = sandbox?.defaultMode
      if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') return value
    } catch {
      // Optional service; an unknown default means the target is not safely
      // mappable.
    }
    return undefined
  }

  /** Effective approval policy of a mode target: its explicit atom, else the
   *  folded session value, else the approval service configuration. */
  const effectiveApprovalForMode = (spec: SessionModeSpec): SessionModeSpec['approval'] | undefined => {
    if (spec.approval !== undefined) return spec.approval
    const folded = foldApprovalPolicy(snapshotLiveSessionEvents(agent.session))
    if (folded === 'ask' || folded === 'never') return folded
    try {
      const approval = ctx.get('approval') as
        | { effectivePolicy?(session: Agent['session']): unknown; config?: { policy?: unknown } }
        | undefined
      const value = approval?.effectivePolicy?.(agent.session) ?? approval?.config?.policy
      if (value === 'ask' || value === 'never') return value
    } catch {
      // Optional service; an unknown default means the target is not safely
      // mappable.
    }
    return undefined
  }

  /** Canonical preset for an effective sandbox/approval bundle, when one
   *  exists among the deployment's runtime table (or the stock built-ins
   *  when the service does not resolve atoms). Undefined means no visible
   *  preset matches the bundle. */
  const canonicalPermissionForMode = (
    spec: SessionModeSpec,
  ): string | undefined => {
    const sandbox = effectiveSandboxForMode(spec)
    const approval = effectiveApprovalForMode(spec)
    if (sandbox === undefined || approval === undefined) return undefined
    let service: unknown
    try {
      service = ctx.get('permissionPresets')
    } catch {
      service = undefined
    }
    const bundles = service === undefined ? undefined : permissionBundlesFromService(service)
    return canonicalPresetFor(sandbox, approval, bundles)
  }

  /** The durable permission identity reports the target: either the folded
   *  `permission/preset` session event or a runtime registry readback. */
  const permissionTargetConfirmed = (target: string): boolean => {
    if (foldPermissionPreset(snapshotLiveSessionEvents(agent.session)) === target) return true
    try {
      const snapshot = state.permissionPresets()
      if (
        snapshot.availability === 'runtime'
        && snapshot.current?.kind === 'preset'
        && snapshot.current.value === target
      ) {
        return true
      }
    } catch {
      // The registry may be unmounted mid-switch; the fold check above
      // remains authoritative for the durable identity.
    }
    return false
  }

  /** Poll fold/registry readback for the target within a grace window; a
   *  runtime registry may confirm asynchronously (approval step, event
   *  batching), while without one only a short fold-based grace makes sense
   *  before failing closed. */
  const confirmPermissionTarget = async (target: string, session: Agent['session'], timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (session !== agent.session) return false
      if (permissionTargetConfirmed(target)) return true
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    ctx.logger.warn(`dsh-tui: permission mode "${target}" was not confirmed by permissionPresets.current()/permission/preset`)
    state.notify(t('mode-permission-unconfirmed'), { color: 'warning' })
    return false
  }

  /** Official `/permission <preset>` switch, then confirmation. The TUI
   *  never fabricates permission events: success requires the durable
   *  `permission/preset` event or a runtime registry readback to report the
   *  target within a short grace window (the external command may append its
   *  event asynchronously or behind an approval step). Already being on the
   *  target is a no-op — no redundant command, no approval prompt.
   *  When the /permission COMMAND is not registered, falls back to the
   *  permission-presets service's own write path — the same handler the
   *  command drives. */
  const applyPermissionIdentity = async (target: string): Promise<boolean> => {
    if (!isCommandCompletionToken(target)) {
      ctx.logger.warn(`dsh-tui: permission mode "${target}" skipped because its identity is not a safe command token`)
      return false
    }
    if (permissionTargetConfirmed(target)) return true
    let registered = false
    try {
      registered = commandService?.find(agent, 'permission') !== undefined
    } catch {
      registered = false
    }
    const session = agent.session
    if (!registered) {
      let service: unknown
      try {
        service = ctx.get('permissionPresets')
      } catch {
        service = undefined
      }
      const runtime = service as PermissionPresetService | undefined
      if (runtime !== undefined && typeof runtime.set === 'function') {
        try {
          runtime.set(session, target)
        } catch (error) {
          ctx.logger.warn(
            `dsh-tui: permission mode "${target}" could not be applied by the permissionPresets service: ${error instanceof Error ? error.message : String(error)}`,
          )
          state.notify(t('mode-permission-invoke-failed'), { color: 'warning' })
          return false
        }
        return await confirmPermissionTarget(target, session, 2000)
      }
      ctx.logger.warn(`dsh-tui: permission mode "${target}" skipped because /permission is not registered`)
      state.notify(t('mode-permission-unregistered'), { color: 'warning' })
      return false
    }
    const result = await executeRegistryCommand('permission', ` ${target}`)
    if (session !== agent.session) return false
    if (result === undefined) {
      ctx.logger.warn(`dsh-tui: permission mode "${target}" could not invoke /permission`)
      state.notify(t('mode-permission-invoke-failed'), { color: 'warning' })
      return false
    }
    let availability: PermissionPresetAvailability = 'unavailable'
    try {
      availability = state.permissionPresets().availability
    } catch {
      // keep the default
    }
    return await confirmPermissionTarget(target, session, availability === 'runtime' ? 2000 : 300)
  }

  /** Durable identity to restore after an implicit plan exit: the preset the
   *  user was on when plan mode ran, provided the runtime registry still
   *  recognizes it as current (a drifted knob combination reads back as
   *  custom and must fall back to the canonical bundle of the atoms). */
  const rememberPrePlanIdentity = (session: Agent['session']): string | undefined => {
    const identity = foldPermissionPreset(snapshotLiveSessionEvents(session))
    if (identity === undefined || identity === PERMISSION_PRESET_CUSTOM) return undefined
    try {
      const snapshot = state.permissionPresets()
      if (snapshot.availability !== 'runtime') return undefined
      if (snapshot.current?.kind !== 'preset' || snapshot.current.value !== identity) return undefined
      if (!snapshot.options.some(option => option.value === identity)) return undefined
      return identity
    } catch {
      return undefined
    }
  }

  /** Apply the configured atoms; an explicit exit owns its target mode. */
  const applyMode = async (spec: SessionModeSpec): Promise<void> => {
    const session = binding.agent.session
    pendingPlanExitRestores.delete(session)
    const planMode = ctx.get('planMode') as
      | { get?(a: Agent): { active: boolean; pending?: boolean } }
      | undefined
    const planActive = foldPlanActive(snapshotLiveSessionEvents(session))
    const planChange = spec.plan !== undefined && (planMode?.get?.(agent).pending ?? planActive) !== spec.plan
    if (planChange && commandService?.find(agent, 'plan') === undefined) {
      state.notify(t('mode-plan-unavailable'), { color: 'warning' })
      return
    }
    // Capture the pre-plan sandbox/approval bundle (and the durable preset
    // identity, when authoritative) BEFORE any permission canonicalization
    // can append replacement events.
    if (planChange && spec.plan && !planActive && !prePlanModes.has(session)) {
      const previous = modePermissions(snapshotLiveSessionEvents(session))
      const sandbox = ctx.get('sandboxPolicy') as { defaultMode?: SessionModeSpec['sandbox'] } | undefined
      const approval = ctx.get('approval') as { effectivePolicy?(session: Agent['session']): SessionModeSpec['approval'] } | undefined
      const base = previous.sandbox === undefined && previous.approval === undefined ? sessionModes[0] : undefined
      previous.sandbox ??= sandbox?.defaultMode ?? base?.sandbox
      previous.approval ??= approval?.effectivePolicy?.(session) ?? base?.approval
      prePlanModes.set(session, previous)
      const remembered = rememberPrePlanIdentity(session)
      if (remembered !== undefined) prePlanPermissionIdentity.set(session, remembered)
      else prePlanPermissionIdentity.delete(session)
      // Persist missing defaults before /plan, so resume can recover them.
      applyModeAtoms(previous)
    }
    // Permission identity is applied before plan and atom changes. Dynamic
    // presets use the official command path (or the service write fallback)
    // and are confirmed by event / registry readback; the TUI never
    // manufactures permission events.
    if (spec.permission !== undefined) {
      if (!(await applyPermissionIdentity(spec.permission))) return
    } else {
      // Static modes own a canonical permission identity. Leaving any OTHER
      // durable identity behind (third-party preset OR a stale canonical,
      // e.g. plan left `read-only` while atoms were restored to
      // workspace-write) would make a static mode appear selected only
      // because its sandbox/approval bundle happens to match, and would let
      // the durable identity lie about the real policy. Canonicalize BEFORE
      // applying atoms; when no canonical preset exists for the target
      // bundle, fail closed with a visible notice.
      const currentPermission = foldPermissionPreset(snapshotLiveSessionEvents(session))
      if (currentPermission !== undefined && currentPermission !== PERMISSION_PRESET_CUSTOM) {
        const canonical = canonicalPermissionForMode(spec)
        if (canonical === undefined) {
          ctx.logger.warn(`dsh-tui: static mode "${spec.id}" cannot safely clear permission identity "${currentPermission}"`)
          state.notify(t('mode-permission-no-canonical', { name: modeDisplayName(spec) }), { color: 'warning' })
          return
        }
        if (canonical !== currentPermission) {
          if (!(await applyPermissionIdentity(canonical))) return
        }
      }
    }
    // Reconcile a stale explicit-exit marker before acting. The marker only
    // legitimately survives while a deferred exit awaits its plan/mode:false
    // (foldPlanActive && pending === false). If plan is still logged active
    // with no pending intent, that awaited event was abandoned (e.g. an
    // aborted pre-step) — drop the orphan so it cannot suppress a later restore
    // such as an approved exit_plan_mode.
    if (planActive && planMode?.get?.(binding.agent).pending === undefined) {
      explicitPlanExits.delete(session)
    }
    if (spec.plan !== undefined && (planMode?.get?.(binding.agent).pending ?? planActive) !== spec.plan) {
      if (commandService?.find(binding.agent, 'plan') === undefined) {
        notify(t('mode-plan-unavailable'), { color: 'warning' })
        return
      }
      try {
        const text = await executeRegistryCommand('plan', spec.plan ? '' : ' off')
        if (session !== binding.agent.session) return
        if (text === undefined) {
          notify(t('mode-plan-unavailable'), { color: 'warning' })
          return
        }
        if (execution.kind === 'error') {
          if (execution.text !== '') state.notify(execution.text, { color: 'error' })
          return
        }
      } finally {
        if (session === binding.agent.session) {
          const pending = planMode?.get?.(binding.agent).pending
          if (!foldPlanActive(session.events) || pending !== false) explicitPlanExits.delete(session)
          if (!foldPlanActive(session.events) && pending !== true) prePlanModes.delete(session)
        }
      }
    }
    applyModeAtoms(spec)
    refreshMode()
    notify(t('mode-switched', { name: modeDisplayName(state.mode) }))
    state.emit()
  }

  /** Shift+Tab: advance to the next configured session mode. Cycling starts
   *  from the mode DERIVED from the session log (never a stored index), so
   *  manual `/plan` use can never desync the cycle. */
  const cycleMode = async (): Promise<void> => {
    const index = deriveModeIndex(binding.agent.session.events)
    await applyMode(sessionModes[(index + 1) % sessionModes.length]!)
  }

  // Session-lifetime candidate pool for non-path queries. The load promise is
  // shared so concurrent first keystrokes cannot kick off duplicate scans, and
  // it is keyed by cwd so a /workspace switch or resumed session never reuses
  // another directory's listing.
  const fileCandidateCache = { cwd: '', load: undefined as Promise<readonly FileCandidate[]> | undefined }

  // `/model <provider/id>` completion: the model catalog is async (one llm
  // listModels per provider), so the first keystrokes that could be heading
  // for /model warm a session-lifetime cache — the shared promise dedupes
  // concurrent triggers, children() synchronously serves whatever has landed,
  // and the arrival state.emit() reopens the menu mid-typing. switchModel's
  // success path drops the cache so the [current] tag re-resolves against
  // the new route.
  const modelNodeCache = {
    nodes: undefined as readonly CommandCompletionNode[] | undefined,
    load: undefined as Promise<void> | undefined,
    // Monotonic load generation. dropModelNodeCache bumps it so a warm that
    // was already in flight when the cache was dropped cannot publish its
    // stale catalog on resolve — only the newest load may write nodes.
    generation: 0,
  }
  const warmModelNodes = (): void => {
    if (modelNodeCache.load !== undefined) return
    const generation = modelNodeCache.generation
    modelNodeCache.load = state.listModels().then((list) => {
      if (!owner.current() || generation !== modelNodeCache.generation) return
      modelNodeCache.nodes = list.map((model) => ({
        name: `${model.provider}/${model.id}`,
        description: model.name,
        ...(state.provider === model.provider && state.model === model.id
          ? { tag: 'current' }
          : {}),
      }))
      state.emit()
    }).catch(() => {
      if (!owner.current() || generation !== modelNodeCache.generation) return
      // listModels already swallows per-provider failures; this only fires
      // when the llm service shape itself is missing — settle on an empty
      // menu rather than retrying on every keystroke.
      modelNodeCache.nodes = []
    })
  }

  /** Drop the `/model <provider/id>` completion cache so the next `/model `
   *  keystroke refetches a fresh catalog. Model switches (the [current] tag
   *  re-resolves against the new route) and every `/provider` catalog change
   *  (add / edit / delete / OAuth sign-in-out) invalidate it, so completion
   *  always matches what the picker would list. */
  const dropModelNodeCache = (): void => {
    modelNodeCache.generation += 1
    modelNodeCache.nodes = undefined
    modelNodeCache.load = undefined
  }

  // `/preset <id>` completion: same warm-cache pattern as models. The
  // current/default tags resolve at children() time (sync state reads), so
  // no cache invalidation is needed on switch. The localized display text,
  // however, resolves at listPresets() call time — a mid-session /lang
  // switch invalidates lazily here (lang-keyed warm) so completion hints
  // never serve the previous language.
  const presetOptionCache = {
    lang: undefined as Lang | undefined,
    list: undefined as readonly PresetOption[] | undefined,
    load: undefined as Promise<void> | undefined,
  }
  /** Warm the `/preset <id>` completion roster once per UI language; a
   *  language change since the last warm drops the stale localized copy. */
  const warmPresetOptions = (): void => {
    const lang = getLang()
    if (presetOptionCache.lang !== undefined && presetOptionCache.lang !== lang) {
      presetOptionCache.list = undefined
      presetOptionCache.load = undefined
    }
    if (presetOptionCache.load !== undefined) return
    presetOptionCache.lang = lang
    presetOptionCache.load = state.listPresets().then((list) => {
      presetOptionCache.list = list
      state.emit()
    }).catch(() => {
      presetOptionCache.list = []
    })
  }

  // `/effort <id>` completion: state.effortLevels is the sync vocabulary
  // (populated on route changes); when still unknown, one best-effort
  // resolveEfforts warms it. `tried` caps the retry — resolveEfforts
  // notifies on hard errors, so keystroke-time retries would spam.
  const effortWarm = { tried: false }
  const warmEffortLevels = (): void => {
    if (state.effortLevels !== undefined || effortWarm.tried) return
    effortWarm.tried = true
    void resolveEfforts().then((resolved) => {
      if (resolved === 'unavailable' || resolved === 'error') return
      effortWarm.tried = false
      state.emit()
    }).catch(() => {})
  }

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
    reasoningEffort: options.effort ?? readEffortPref(),
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
        if ('model'.startsWith(head)) warmModelNodes()
        if ('preset'.startsWith(head)) warmPresetOptions()
        if ('effort'.startsWith(head)) warmEffortLevels()
      }
      return completeCommands(input, state.commandList, (path) => {
        if (path.length === 1 && path[0] === 'model') {
          // provider/id specs, current model tagged; see modelNodeCache.
          warmModelNodes()
          return modelNodeCache.nodes ?? []
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
          warmEffortLevels()
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
          warmPresetOptions()
          return [
            { name: 'status', description: 'Show the current agent preset', descriptionKey: 'sugg-status-desc' },
            ...(presetOptionCache.list ?? []).map((preset) => ({
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
    listWorkspaces() {
      return workspaceService.list(state.cwd)
    },
    resolveWorkspace(uri: string) {
      return workspaceService.resolve(uri, state.cwd)
    },
    async switchWorkspace(target: TuiWorkspaceTarget): Promise<boolean> {
      if (state.working) {
        notify(t('workspace-switch-working'), { color: 'warning' })
        return false
      }
      // Local targets must exist and be directories — creating a session in
      // a typo'd cwd "succeeds" and then every file tool errors per call.
      if (target.kind === 'local') {
        try {
          if (!statSync(target.cwd).isDirectory()) throw new Error('not a directory')
        } catch {
          notify(t('workspace-open-invalid', { target: target.label }), { color: 'error', timeoutMs: 8000 })
          return false
        }
      }
      const previousCwd = state.cwd
      const previousDisplay = state.displayCwd
      state.cwd = target.cwd
      state.displayCwd = target.description ?? target.uri
      const switched = await channelCommands(state).newSession()
      if (!switched) {
        state.cwd = previousCwd
        state.displayCwd = previousDisplay
        return false
      }
      // The breadcrumb follows the adopted cwd, same as /resume (#96).
      refreshGitBranch()
      notify(t('workspace-switched', { target: target.label }))
      state.emit()
      return true
    },
    async renameWorkspace(title: string): Promise<boolean> {
      try {
        const renamed = await workspaceService.rename(state.cwd, title)
        state.displayCwd = renamed.description ?? renamed.uri
        notify(t('workspace-renamed', { title: renamed.label }))
        state.emit()
        return true
      } catch (error) {
        notify(
          t('workspace-rename-failed', { err: error instanceof Error ? error.message : String(error) }),
          { color: 'error', timeoutMs: 8000 },
        )
        return false
      }
    },
    workspaceCommands() {
      return workspaceService.commands()
    },
    runWorkspaceCommand(name: string, input: string) {
      return workspaceService.runCommand(name, input, state.cwd)
    },
    async switchModel(provider: string, model: string): Promise<boolean> {
      const adoption = binding.capture()
      // `/model` picker Enter — switch the live model by forking the
      // conversation at its current end and continuing with a new agent
      // routed to the chosen model. Same reset shape as rewindTo/resumeTo;
      // the history replays unchanged, only the request model changes.
      if (state.working) {
        notify(t('model-switch-while-working'), {
          color: 'warning',
        })
        return false
      }
      const agents = ctx.get('agents') as
        | { create(options: CreateAgentOptions): Promise<AgentHandle> }
        | undefined
      if (!sessions || !agents) {
        notify(t('model-switch-unavailable'), {
          color: 'error',
        })
        return false
      }
      let seed: readonly SessionEvent[]
      try {
        // An in-flight manual compaction must not straddle the fork: cancel
        // it first, or its checkpoint can commit right after this snapshot —
        // the model-switched child would start from the summary alone while
        // the user believes the full history carried over ("context lost").
        await settleManualCompaction()
        // No boundary = fork the whole log (continue the conversation).
        seed = sessions.fork(binding.agent.session).events
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        notify(t('model-switch-fork-failed', { err: message }), { color: 'error' })
        return false
      }
      const childId = SessionId(randomUUID())
      let handle: AgentHandle
      // The forked conversation keeps the session's own preset — only the
      // request route changes (same rule as rewindTo).
      const modelComposed = await composePreset(ctx, runningPresetOf(binding.agent.session))
      try {
        handle = await binding.prepare(adoption, () => agents.create({
          sessionId: childId,
          seed,
          meta: {
            cwd: state.cwd,
            parentSession: binding.agent.session.id,
            seedLength: seed.length,
            ...(modelComposed.agentPreset === undefined
              ? {}
              : { agentPreset: modelComposed.agentPreset }),
          },
          agentOptions: { provider, model },
          ...(modelComposed.setup === undefined ? {} : { setup: modelComposed.setup }),
        }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        notify(t('model-switch-failed', { err: message }), { color: 'error', timeoutMs: 8000 })
        return false
      }
      try {
        await attachSessionToWorkspace(ctx, state.cwd, childId)
      } catch (error) {
        notify(
          t('model-switch-attach-failed', { err: error instanceof Error ? error.message : String(error) }),
          { color: 'warning', timeoutMs: 8000 },
        )
      }
      if (!binding.isCurrent(adoption)) { await binding.abandon(handle); return false }
      return binding.adopt(handle, adoption, (committed, disposePrevious) => {
      projector.reset()

      // Stale sealed/thinking bookkeeping belongs to the OLD agent's rows;
      // keep it out of the next turn's settle logs and revive cache.


      rowIds.value = 0
      state.rows.length = 0
      markChannelReadDirty(state.rows)
      resetSubagentProjection()
      resetJobProjection()
      // Goal/todo/title are session-scoped; the replay re-derives them for
      // the session being entered (or leaves them empty).
      state.todos = []
      // Queued-but-undelivered messages live in the OLD agent's inbox; the
      // swap must drop their previews or they linger forever (unretirable —
      // retire events are filtered to the new agent, unwithdrawable — the
      // new inbox never heard of them).
      state.pending = []
      state.goal = undefined
      state.sessionTitle = ''
      state.sessionColor = ''
      state.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
      state.responseChars = 0
      state.activeToolCount = 0
      state.lastUserText = ''
      state.working = false
      state.cancelPending = false
      state.spinnerMode = 'requesting'
      state.status = handle.agent.status
      state.agentId = handle.agent.id
      state.agentPreset = modelComposed.agentPreset
      state.model = model
      state.provider = provider
      // /model completion cache: the [current] tag was resolved at fetch
      // time — drop the cache so the next `/model ` refetches for the new
      // route.
      dropModelNodeCache()
      state.tps = undefined
      state.tpsSamples = []
      state.lastUsage = undefined
      state.workingActivity = undefined
      state.contextWindow = undefined
      // Route changed: a stale tier table would let top-tier UI fire on the
      // wrong level (or never fire on the real one); clear and re-resolve.
      state.effortLevels = undefined
      state.reasoningEffort = undefined
      refreshEffortLevels()
      state.contextSegments = {
        system: 0,
        prompt: 0,
        assistant: 0,
        thinking: 0,
        tools: 0,
      }
      projector.replayEvents(seed)
      projector.settleStreaming()
      // Same mid-turn-seed spinner reset as resume above.
      state.working = handle.agent.status === 'running'
      const oldHandle = committed.handle
      bindAgent()
      clearStagedImages()
      // Model-switch quip rides the fresh tracker.
      updateWorkingActivity('model switch', () => activityTracker.onModelSwitch(model))
      refreshCommandList()
      void refreshLoadedContext()
      void refreshSkillCommands()
      // The model-switched fork becomes the most recently used.
      touchSession(childId)
      state.emit()
      disposePrevious('dispose')
      // Staged image tokens were typed against the pre-switch conversation;
      // resumeTo/newSession already drop theirs on the swap — same contract.
      clearStagedImages()
      // Persist the choice so the next boot and `/new` start on it (same
      // contract as /preset and /effort; issues #14/#30). A failed
      // write keeps the live switch but warns it will not survive a restart.
      if (!writeModelPref(provider, model)) {
        notify(t('model-pref-write-failed'), {
          color: 'warning',
        })
      }
      return true
      })
    },
    listEfforts,
    setEffort,
    setDefaultEffort,
    cycleMode,
    clear() {
      state.rows.length = 0
      markChannelReadDirty(state.rows)
      rowIds.value = 0
      projector.reset()

      // In-flight subagents keep streaming after the wipe; clearing the row
      // map lets their next event re-create the card as a fresh row instead
      // of feeding a row object no transcript holds (the store keeps live
      // tracking for the dashboard — same session, still running).
      dropSubagentRows()
      // Live jobs keep running across the wipe too (same session): clear the
      // row map so their next commit re-creates the card as a fresh row.
      jobRowsByJobId.clear()
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
    /** Localized roster projection for the /preset picker — resolves
     *  built-in display text through the dictionary under `en`; the
     *  Channel.listPresets contract comment carries the full doc. */
    async listPresets() {
      const presets = rosterOf(ctx)
      if (presets === undefined) return []
      // The roster copies `name`/`description` verbatim from each preset.yml,
      // and the stock yml files are written in Chinese — the /preset picker
      // showed them under `en` too. Built-in ids have dictionary surfaces
      // (preset-name-* / preset-desc-*); under `en` they win via tOr, while
      // unknown (user-authored) ids fall through to the roster text. Under
      // `zh` the roster text is kept as-is so a user-edited or upstream-
      // reworded preset.yml is never shadowed by a stale dictionary copy.
      const localized = getLang() === 'en'
      try {
        const list = await presets.list()
        return list.map(preset => ({
          id: preset.id,
          ...(preset.name === undefined
            ? {}
            : { name: localized ? tOr(`preset-name-${preset.id}`, preset.name) : preset.name }),
          ...(preset.description === undefined
            ? {}
            : { description: localized ? tOr(`preset-desc-${preset.id}`, preset.description) : preset.description }),
          ...(preset.broken === undefined ? {} : { broken: preset.broken }),
          isDefault: preset.id === presets.defaultId,
        }))
      } catch {
        return []
      }
    },
    async switchPreset(presetId) {
      const presets = rosterOf(ctx)
      if (presets === undefined) {
        notify(t('preset-unavailable'), { color: 'error' })
        return false
      }
      if (state.working) {
        notify(t('preset-agent-running'), { color: 'warning' })
        return false
      }
      let target: AgentPresetInfo
      try {
        target = await resolveCompatiblePreset(presets, presetId)
      } catch (error) {
        notify(
          t('preset-not-found', { id: presetId, err: error instanceof Error ? error.message : String(error) }),
          { color: 'error', timeoutMs: 8000 },
        )
        return false
      }
      if (target.broken !== undefined) {
        notify(t('preset-load-failed', { id: target.id, broken: target.broken }), { color: 'error', timeoutMs: 8000 })
        return false
      }
      if (target.id === state.agentPreset) {
        if (!migratePresetPref(presetId, target.id)) {
          notify(t('preset-switched-pref-failed', { id: target.id }), { color: 'warning' })
          return true
        }
        notify(t('preset-already-current', { id: target.id }), { color: 'success' })
        return true
      }
      // Official rule (dsh-agent-presets): only a session that has produced
      // nothing may swap compositions — a started session's logged tool calls
      // would strand under a different tool set. Blank = no turn ever ran.
      const blank = !binding.agent.session.events.some(event => event.type === 'turn/start')
      if (!blank) {
        // Persist as the default for future sessions instead of failing.
        if (!writePresetPref(target.id)) {
          notify(t('preset-pref-write-failed'), { color: 'error' })
          return false
        }
        notify(
          t('preset-locked-saved-default', { current: state.agentPreset ?? 'host', id: target.id }),
          { color: 'warning', timeoutMs: 8000 },
        )
        return true
      }
      try {
        const preset = await presets.recompose(binding.agent.ctx, target.id)
        // The switch is a logged session fact (model-visible ⟺ logged):
        // resumes/forks of this session resolve the NEW composition. The
        // type is runtime-registered in dsh-session's known-event set but
        // not yet in its typed SessionEventMap — cast the SESSION (never
        // extract the method: `append` reads the private `this.log`, so an
        // unbound call throws "Cannot read properties of undefined").
        const session = binding.agent.session as unknown as { append(type: string, data: unknown): void }
        session.append('agent-preset/selected', { agentPreset: preset.id })
        state.agentPreset = preset.id
      } catch (error) {
        notify(
          t('preset-switch-failed', { err: error instanceof Error ? error.message : String(error) }),
          { color: 'error', timeoutMs: 8000 },
        )
        return false
      }
      state.emit()
      if (!writePresetPref(target.id)) {
        notify(t('preset-switched-pref-failed', { id: target.id }), { color: 'warning' })
        return true
      }
      notify(t('preset-switched-saved', { id: target.id }), { color: 'success' })
      return true
    },
    listModels() {
      const llm = ctx.get('llm') as
        | {
          listProviders(): readonly { id: string }[]
          listModels(provider: string): Promise<readonly LlmModelInfo[]>
        }
        | undefined
      if (!llm) return Promise.resolve([])
      const providers = llm.listProviders()
      return Promise.all(providers.map(provider => llm.listModels(provider.id).catch(() => [])))
        .then(lists => lists.flat())
    },
    listProviders() {
      // Group labels for the two-level /model picker: the registry's own
      // display names, detached so a registry swap cannot leak through.
      const llm = ctx.get('llm') as
        | { listProviders(): readonly { id: string; name: string }[] }
        | undefined
      return Promise.resolve(llm === undefined ? [] : llm.listProviders().map(info => ({ ...info })))
    },
    invalidateModelCompletion() {
      // `/provider` changed the catalog (add/edit/delete/OAuth): the next
      // `/model <provider/id>` keystroke must not serve the stale snapshot.
      dropModelNodeCache()
    },
    async listSkills() {
      // snapshot() over list(): only a COMPLETE observation is authoritative
      // (same contract as the skill-command merge above) — a partial catalog
      // must surface as "failed", not as a misleading near-empty picker.
      const target = binding.agent
      const registry = skillRegistryFor(target)
      if (registry === undefined) return []
      try {
        const observation = await registry.snapshot(skillViewOptions(target))
        if (target !== binding.agent || !observation.complete) {
          return undefined
        }
        return observation.skills.map(skill => ({
          name: skill.name,
          description: skill.description,
          userInvocable: isUserInvocable(skill),
          source: skill.source,
        }))
      } catch {
        return undefined
      }
    },
    async describeCredential(ref) {
      const credentials = ctx.get('credentials') as
        | { describe(ref: string): Promise<CredentialStatus> }
        | undefined
      if (!credentials) return undefined
      return credentials.describe(ref)
    },
    async balanceInfo() {
      // Same key resolution order as the community balance plugins: the
      // harness credentials seam first, the process environment as fallback
      // (the /doctor check reads the env directly). The value rides only in
      // the Authorization header — never logged, printed or persisted.
      const credentials = ctx.get('credentials') as
        | { resolve(ref: string): Promise<{ value: string } | undefined> }
        | undefined
      let apiKey = ''
      if (credentials !== undefined) {
        try {
          apiKey = (await credentials.resolve('DEEPSEEK_API_KEY'))?.value ?? ''
        } catch {
          apiKey = ''
        }
      }
      if (apiKey === '') apiKey = process.env.DEEPSEEK_API_KEY ?? ''
      return fetchBalance(apiKey)
    },
    settingsSections(): readonly TuiSettingsSection[] {
      return settingsSectionsRuntime?.list() ?? []
    },
    subscribeSettingsSections(listener: () => void): () => void {
      return emitter.subscribe(listener)
    },
    async sideQuestion(
      question: string,
      options?: { signal?: AbortSignal; onText?: (delta: string) => void },
    ): Promise<{ answer: string | null; error?: string }> {
      // /btw：无工具单轮辅助调用，重放 deriveMessages() 前缀 + 一条
      // 包装问题。tools 永不传（侧问无工具是核心语义）；usage 不回收
      // （skipCacheWrite 同义——答案不进主上下文也不进 token 计数）。
      const llm = ctx.get('llm') as SideQuestionLlm | undefined
      if (!llm) return { answer: null, error: t('btw-llm-unavailable') }
      const header = binding.agent.session.requestHeader()
      const config = header?.config
      const messages: Message[] = [
        ...binding.agent.session.deriveMessages(),
        createUserMessage({
          content: [{ type: 'text', text: wrapSideQuestion(question) }],
          source: { kind: 'plugin', plugin: 'dsh-tui/side-question' },
        }),
      ]
      const request: Record<string, unknown> = {
        provider: config?.provider ?? state.provider,
        model: config?.model ?? state.model,
        messages,
        ...(header?.system !== undefined && { system: header.system }),
        ...(config?.reasoningEffort !== undefined && { reasoningEffort: config.reasoningEffort }),
        ...(config?.temperature !== undefined && { temperature: config.temperature }),
        ...(config?.maxTokens !== undefined && { maxTokens: config.maxTokens }),
        ...(config?.stop !== undefined && { stop: [...config.stop] }),
        sessionId: binding.agent.session.id,
        ...(options?.signal && { signal: options.signal }),
      }
      return runSideQuestion({
        stream: llm.stream.bind(llm),
        options: request,
        onText: options?.onText,
        signal: options?.signal,
      })
    },
    async listFileCandidates(query: string, options?: { signal?: AbortSignal; topK?: number }) {
      const fs = ctx.get('fs') as MentionFs | undefined
      if (!fs || options?.signal?.aborted) return []
      if (isPathLikeQuery(query)) {
        return listPathCandidates(fs, state.cwd, query, options?.signal, options?.topK ?? 50)
      }
      if (fileCandidateCache.cwd !== state.cwd) {
        fileCandidateCache.cwd = state.cwd
        fileCandidateCache.load = undefined
      }
      fileCandidateCache.load ??= listFilesDeepCandidates(fs, state.cwd).then(candidates => {
        if (candidates.length > 0) return candidates
        // An empty scan is not worth caching forever — retry on next query.
        fileCandidateCache.load = undefined
        return candidates
      })
      const candidates = await fileCandidateCache.load
      if (options?.signal?.aborted) return []
      return rankFileCandidates(candidates, query, options?.topK ?? 50)
    },
    async listFiles() {
      const fs = ctx.get('fs') as MentionFs | undefined
      const candidates = await listFilesDeepCandidates(fs, state.cwd)
      return candidates.map(candidate => candidate.path)
    },
    async listSessions() {
      // Every stored session, classified and unfiltered. Which of them a
      // surface shows — this project only, conversations only, sub-agent runs
      // folded away — is a view decision, and keeping it out of here is what
      // lets the browser toggle those views without re-reading a single log.
      const rows = await listSessionsSnapshot(ctx)
      persistedRowsCache = rows
      notifyAgentView()
      return rows
    },
    async previewSession(sessionId) {
      const persistence = ctx.get('sessionPersistence') as SessionSource | undefined
      if (!persistence) return []
      const path = await locateSession(persistence, sessionId)
      return path === undefined ? [] : previewSession(path, PREVIEW_ENTRIES)
    },
    // ── agent view ──────────────────────────────────────────────────────────
    bindApprovalStore(store) {
      approvalStore = store
      ctx.effect(() => store.subscribe(notifyAgentView))
      notifyAgentView()
    },
    agentViewRows() {
      // Cached snapshot (see notifyAgentView): the array identity is stable
      // between changes, which useSyncExternalStore requires.
      if (agentViewRowsCache !== undefined) return agentViewRowsCache
      const agentsService = ctx.get('agents') as
        | { list(): readonly Agent[] }
        | undefined
      const pendingIds = new Set(approvalStore?.pendingAgentIds() ?? [])
      const live: AgentViewRow[] = []
      if (agentsService !== undefined) {
        // Minimal test fixtures mount an agents service without enumeration
        // (create-only); an empty roster is the honest projection there.
        const roster = typeof agentsService.list === 'function' ? agentsService.list() : []
        for (const liveAgent of roster) {
          // Subagent children are not agent-view rows: they
          // belong to their parent's conversation.
          if (liveAgent.session.header.origin === 'subagent') continue
          const fold = foldOf(liveAgent)
          const id = String(liveAgent.id)
          const isCurrent = id === String(binding.agent.session.id)
          // A session that never held a conversation is not a row (the
          // session browser's rule): the fresh terminal session a `/bg`
          // creates stays visible only while it IS the attached one.
          if (!fold.hasTurns && !isCurrent) continue
          const needsInput = pendingIds.has(id)
          const status = agentViewStatusOf(liveAgent.status, fold, needsInput)
          // A blocked row's summary is the question it is
          // waiting on (the parked approval's reason/gated command).
          const ask = needsInput ? approvalStore?.pendingAgentDetail(id) : undefined
          // A prompt-kind summary is the session's own prompt echoed back —
          // the name column already says it, so the row stays clean.
          const summary = ask !== undefined
            ? oneLine(ask.reason ?? ask.command ?? ask.toolName ?? '')
            : fold.summaryKind === 'prompt' ? '' : fold.summary
          live.push({
            id,
            title: fold.title.length > 0 ? fold.title : sessionTitleFallback(fold, liveAgent.session.header.cwd),
            cwd: liveAgent.session.header.cwd ?? state.cwd,
            summary,
            status,
            live: true,
            current: isCurrent,
            createdAt: liveAgent.session.header.createdAt,
            updatedAt: fold.updatedAt,
          })
        }
      }
      const liveIds = new Set(live.map(row => row.id))
      // Stopped rows come from the shared persistence store, which also
      // holds sessions other front doors (web, other profiles) created and
      // the ordinary /resume history. The agent-view ledger is the exact
      // ownership record: only sessions this TUI dispatched, backgrounded,
      // or attached to FROM the view appear here (background sessions, not the
      // whole history).
      const agentViewSessions = readAgentViewSessions()
      const persisted: AgentViewRow[] = persistedRowsCache
        .filter(summary =>
          !liveIds.has(summary.id)
          && summary.kind.kind !== 'subagent'
          && agentViewSessions[summary.id] !== undefined
          // Never list a session that holds no conversation (the session
          // browser's rule): a `/bg` fresh session the user never typed
          // into is not an agent-view row once it stops.
          && summary.hasPrompt)
        .map(summary => ({
          id: summary.id,
          title: summary.title.text,
          cwd: summary.cwd,
          summary: summary.label === undefined ? '' : oneLine(summary.label),
          status: 'stopped',
          live: false,
          current: false,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
        }))
      const rows = [...live, ...persisted]
      const rank = (row: AgentViewRow): number => {
        const index = AGENT_VIEW_STATUS_ORDER.indexOf(row.status)
        return index < 0 ? AGENT_VIEW_STATUS_ORDER.length : index
      }
      rows.sort((left, right) =>
        rank(left) - rank(right)
        || right.updatedAt - left.updatedAt
        || right.createdAt - left.createdAt
        || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      agentViewRowsCache = rows
      return rows
    },
    subscribeAgentView(listener) {
      agentViewListeners.add(listener)
      return () => {
        agentViewListeners.delete(listener)
      }
    },
    async dispatchBackgroundAgent(prompt) {
      const text = prompt.trim()
      if (text.length === 0) {
        return { ok: false, reason: 'failed', error: t('agentview-empty-prompt') }
      }
      const agentsService = ctx.get('agents') as
        | { create(options: CreateAgentOptions): Promise<AgentHandle> }
        | undefined
      if (!agentsService) {
        notify(t('agentview-dispatch-unavailable'), { color: 'error' })
        return { ok: false, reason: 'unavailable' }
      }
      const sessionId = SessionId(randomUUID())
      // Same composition as /new: the caller's default preset + model route.
      // Every failure path below must return a result (never reject): the
      // screen shows the error, and a silent rejection would look like a
      // "missing" session.
      let handle: AgentHandle
      let detached: Awaited<ReturnType<typeof createDetachedHandle>>
      try {
        owner.assertActive()
        const composed = await composePreset(ctx, options.configuredPreset ?? readPresetPref())
        const resolved = resolveModelRoute(
          { provider: options.configuredProvider, model: options.configuredModel },
          readModelPref(),
          { provider: options.provider, model: options.model },
        )
        const llm = ctx.get('llm') as
          | { listModels(provider: string): Promise<readonly { id: string }[]> }
          | undefined
        const { route } = await validateModelRoute(llm, resolved, {
          provider: options.provider,
          model: options.model,
        })
        owner.assertActive()
        detached = await createDetachedHandle(() => agentsService.create({
          sessionId,
          meta: {
            cwd: state.cwd,
            ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }),
          },
          agentOptions: route,
          ...(composed.setup === undefined ? {} : { setup: composed.setup }),
        }))
        handle = detached.handle
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        notify(t('agentview-dispatch-failed', { err: message }), { color: 'error', timeoutMs: 8000 })
        return { ok: false, reason: 'failed', error: message }
      }
      if (!owner.current()) { await detached.release(); return { ok: false, reason: 'failed', error: 'Channel lifetime ended' } }
      try {
        await attachSessionToWorkspace(ctx, state.cwd, sessionId)
      } catch {
        // The workspace ledger is optional bookkeeping; the session runs
        // without it and the next resume repairs the entry.
      }
      if (!owner.current()) {
        await detached.release()
        return { ok: false, reason: 'failed', error: 'Channel lifetime ended' }
      }
      // The independent background lifecycle owns the handle only after all
      // owner-scoped preparation and attachment awaits have passed.
      detached.transfer()
      backgroundHandles.set(String(sessionId), handle)
      // Record ownership BEFORE delivery: even a delivery failure must not
      // silently drop the session from the view.
      touchAgentViewSession(String(sessionId))
      touchSession(sessionId)
      // Deliver the prompt as a user message; the agent loop picks it up and
      // the session keeps running unattended until its turn ends. A failure
      // here must be loud — a silent rejection would leave an empty row and
      // a "missing" session with no explanation.
      try {
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        notify(t('agentview-dispatch-failed', { err: message }), { color: 'error', timeoutMs: 8000 })
        return { ok: false, reason: 'failed', error: message }
      }
      notifyAgentView()
      return { ok: true, sessionId: String(sessionId) }
    },
    async stopBackgroundAgent(sessionId) {
      // The attached session cannot be stopped from the view: the channel
      // drives it, and disposing it out from under the UI would strand the
      // terminal on a dead agent.
      if (sessionId === String(binding.agent.session.id)) return false
      const handle = backgroundHandles.get(sessionId)
      if (handle === undefined) return false
      backgroundHandles.delete(sessionId)
      try {
        handle.agent.cancel({ kind: 'user' })
        await handle.dispose()
      } catch (error) {
        logForDebugging(`agent view: stop of "${sessionId}" failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      dropFold(sessionId)
      void listSessionsSnapshot(ctx).then((rows) => {
        persistedRowsCache = rows
      })
      notifyAgentView()
      return true
    },
    async attachToAgent(sessionId) {
      if (sessionId === String(binding.agent.session.id)) return { ok: true }
      const agentsService = ctx.get('agents') as
        | { get(id: SessionId): Agent | undefined }
        | undefined
      const liveTarget = agentsService?.get(SessionId(sessionId))
      if (liveTarget !== undefined) {
        if (await sessionSwitchVetoed('agent-view', sessionId)) return { ok: false, reason: 'cancelled' }
        return adoptLiveAgent(liveTarget)
      }
      // Not alive in this process: resume it through the persistence seam,
      // keeping the current agent running in the background.
      if (await sessionSwitchVetoed('agent-view', sessionId)) return { ok: false, reason: 'cancelled' }
      return resumeInto(sessionId, 'agent-view', true)
    },
    async peekAgentSession(sessionId) {
      const live = (ctx.get('agents') as { get(id: SessionId): Agent | undefined } | undefined)?.get(SessionId(sessionId))
      if (live !== undefined) return agentViewLivePreview(snapshotLiveSessionEvents(live.session), PREVIEW_ENTRIES)
      const persistence = ctx.get('sessionPersistence') as SessionSource | undefined
      if (!persistence) return []
      const path = await locateSession(persistence, sessionId)
      return path === undefined ? [] : previewSession(path, PREVIEW_ENTRIES)
    },
    async replyToAgent(sessionId, text) {
      const trimmed = text.trim()
      if (trimmed.length === 0) {
        notify(t('agentview-reply-empty'), { color: 'warning' })
        return false
      }
      const live = (ctx.get('agents') as { get(id: SessionId): Agent | undefined } | undefined)?.get(SessionId(sessionId))
      if (live === undefined) {
        // A stopped session takes a reply only through a restarted agent:
        // attach into it and send from the conversation instead.
        notify(t('agentview-reply-stopped'), { color: 'warning' })
        return false
      }
      live.followup(createUserMessage({
        content: [{ type: 'text', text: trimmed }],
        source: { kind: 'user' },
      }))
      notifyAgentView()
      return true
    },
    async backgroundCurrent() {
      const adoption = binding.capture()
      // `/bg` — the attached session moves to the background (it keeps
      // running in this process) and the terminal lands on a fresh one.
      const agentsService = ctx.get('agents') as
        | { create(options: CreateAgentOptions): Promise<AgentHandle> }
        | undefined
      if (!agentsService) {
        notify(t('agentview-dispatch-unavailable'), { color: 'error' })
        return { ok: false }
      }
      const sessionId = SessionId(randomUUID())
      const composed = await composePreset(ctx, options.configuredPreset ?? readPresetPref())
      const resolved = resolveModelRoute(
        { provider: options.configuredProvider, model: options.configuredModel },
        readModelPref(),
        { provider: options.provider, model: options.model },
      )
      const llm = ctx.get('llm') as
        | { listModels(provider: string): Promise<readonly { id: string }[]> }
        | undefined
      const { route } = await validateModelRoute(llm, resolved, {
        provider: options.provider,
        model: options.model,
      })
      let handle: AgentHandle
      try {
        handle = await binding.prepare(adoption, () => agentsService.create({
          sessionId,
          meta: {
            cwd: state.cwd,
            ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }),
          },
          agentOptions: route,
          ...(composed.setup === undefined ? {} : { setup: composed.setup }),
        }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        notify(t('agentview-dispatch-failed', { err: message }), { color: 'error', timeoutMs: 8000 })
        return { ok: false }
      }
      if (!binding.isCurrent(adoption)) { await binding.abandon(handle); return { ok: false } }
      try {
        await attachSessionToWorkspace(ctx, state.cwd, sessionId)
      } catch (error) {
        // The workspace ledger is optional bookkeeping; retain the baseline
        // warning-and-continue policy for the newly foregrounded session.
        ctx.logger.warn('dsh-tui: background session attachment failed: %o', error)
      }
      if (!owner.current()) { await binding.abandon(handle); return { ok: false, reason: 'failed', error: 'Channel lifetime ended' } }
      // Fresh-session reset shape (mirrors /new; nothing to replay).
      return binding.adopt(handle, adoption, (committed, disposePrevious) => {
      const previousHandle = committed.handle
      const previousSessionId = String(committed.agent.session.id)
      // CC parity: even an EMPTY session is backgrounded (it shows as a
      // "send a prompt to start" row; Esc in the view returns to it), so the
      // handle is always kept for stopping/adopting — never disposed here.
      if (previousHandle !== undefined) {
        backgroundHandles.set(previousSessionId, previousHandle)
        disposePrevious('park')
      }
      projector.reset()



      rowIds.value = 0
      state.rows.length = 0
      markChannelReadDirty(state.rows)
      state.todos = []
      state.pending = []
      state.goal = undefined
      state.sessionTitle = ''
      state.sessionColor = ''
      state.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
      state.responseChars = 0
      state.activeToolCount = 0
      state.lastUserText = ''
      state.working = false
      state.cancelPending = false
      state.spinnerMode = 'requesting'
      state.status = handle.agent.status
      state.agentId = handle.agent.id
      state.tps = undefined
      state.tpsSamples = []
      state.lastUsage = undefined
      state.workingActivity = undefined
      state.loadedContext = undefined
      state.contextWindow = undefined
      state.effortLevels = undefined
      state.reasoningEffort = undefined
      refreshEffortLevels()
      state.contextSegments = {
        system: 0,
        prompt: 0,
        assistant: 0,
        thinking: 0,
        tools: 0,
      }
      bindAgent()
      clearStagedImages()
      refreshCommandList()
      void refreshLoadedContext()
      void refreshSkillCommands()
      clearResumeTarget()
      touchSession(handle.agent.id)
      // Both sides of a backgrounding belong to the agent view: the session
      // left running and the fresh one the terminal lands on.
      touchAgentViewSession(previousSessionId)
      touchAgentViewSession(String(handle.agent.id))
      notifySessionSwitched('background', String(handle.agent.id), previousSessionId)
      notifyAgentView()
      return { ok: true, backgroundedSessionId: previousSessionId }
      })
    },
    setResumeTarget(sessionId) {
      writeResumeTarget(sessionId)
    },
    renameSession(title) {
      // `session/title` is a known envelope type (dsh-session-title writes
      // it for the first prompt). The append publishes through the session
      // firehose, so the event case above updates state.sessionTitle and
      // the persistence flush makes it durable for the next picker open.
      binding.agent.session.append('session/title', { title })
      state.sessionTitle = title
      state.emit()
    },
    setSessionColor(color) {
      // `session/color` is a dsh-tui plugin event — not in dsh-session's
      // typed union, so appended through the same cast applyMode uses for
      // its sandbox/approval overrides. It replays on resume/rewind like
      // session/title, keeping each session's accent color its own.
      ;(binding.agent.session as unknown as { append(type: string, data: Record<string, unknown>): unknown })
        .append('session/color', { color })
      state.sessionColor = color
      state.emit()
    },
    async recapRecent(options) {
      // `/recap` (pi-recap semantics): one tool-less LLM call over the
      // session's TAIL exchanges — unlike /btw it does not replay the full
      // derived history (the excerpt IS the payload), so it stays cheap.
      // The answer is pure UI state: never appended to the session log.
      const llm = ctx.get('llm') as SideQuestionLlm | undefined
      if (!llm) return { summary: null, error: t('recap-llm-unavailable') }
      const header = binding.agent.session.requestHeader()
      const config = header?.config
      const activity = collectRecentActivity(binding.agent.session.events, RECAP_RECENT_CHARS)
      if (activity === '') return { summary: null, error: t('recap-no-activity') }
      const messages: Message[] = [
        createUserMessage({
          content: [{ type: 'text', text: wrapRecapPrompt(activity) }],
          source: { kind: 'plugin', plugin: 'dsh-tui/recap' },
        }),
      ]
      const request: Record<string, unknown> = {
        provider: config?.provider ?? state.provider,
        model: config?.model ?? state.model,
        messages,
        ...(header?.system !== undefined && { system: header.system }),
        ...(config?.reasoningEffort !== undefined && { reasoningEffort: config.reasoningEffort }),
        ...(config?.temperature !== undefined && { temperature: config.temperature }),
        ...(config?.maxTokens !== undefined && { maxTokens: config.maxTokens }),
        ...(config?.stop !== undefined && { stop: [...config.stop] }),
        sessionId: binding.agent.session.id,
        ...(options?.signal && { signal: options.signal }),
      }
      const outcome = await runSideQuestion({
        stream: llm.stream.bind(llm),
        options: request,
        onText: options?.onText,
        signal: options?.signal,
      })
      if (outcome.answer === null) return { summary: null, error: outcome.error }
      const parsed = parseRecapResponse(outcome.answer)
      return parsed.title === undefined
        ? { summary: parsed.summary }
        : { summary: parsed.summary, title: parsed.title }
    },
    async deleteSession(sessionId) {
      // The live session's log is still being appended by this process —
      // deleting it from under the writer is never offered in the picker
      // (the current session is filtered out), so refuse it here too.
      if (sessionId === binding.agent.session.id) return false
      if (deleteSessionLog(sessionId) !== 'deleted') return false
      forgetSession(sessionId)
      forgetAgentViewSession(sessionId)
      // A resume marker naming the deleted session would make the next
      // `dsh-tui --resume` launch target a log that no longer exists.
      if (readResumeTarget() === sessionId) clearResumeTarget()
      return true
    },
    async renameSessionTo(sessionId, title) {
      if (sessionId === binding.agent.session.id) {
        // The live session renames through session.append so the firehose
        // updates the status line right away (same as /rename).
        binding.agent.session.append('session/title', { title })
        state.sessionTitle = title
        state.emit()
        return true
      }
      if (appendSessionTitle(sessionId, title) !== 'appended') return false
      // The append changed the log, so the next listing sees a new revision,
      // re-derives, and reads back the very title event just written — no
      // second path to the same answer. Touching it is about ordering, not
      // titles: a rename is user interaction, so the row belongs at the top.
      touchSession(sessionId)
      return true
    },
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
    mcpStatus() {
      // MCP tools land on the tool runtime under mcp__<server>__<tool>
      // public names (dsh-mcp-client's naming contract); group by server.
      const runtime = ctx.get('tools') as
        | { schemas(scope?: unknown): readonly { name: string; description: string }[] }
        | undefined
      const schemas = runtime?.schemas() ?? []
      const byServer = new Map<string, string[]>()
      for (const schema of schemas) {
        const match = schema.name.match(/^mcp__([a-z0-9-]+)__(.+)$/)
        if (!match) continue
        const list = byServer.get(match[1]) ?? []
        list.push(match[2])
        byServer.set(match[1], list)
      }
      if (byServer.size === 0) {
        return [
          t('mcp-none-configured'),
          t('mcp-insert-hint'),
          '  - insert:',
          '      - id: mcp-context7',
          "        name: '@deepseek-ai/dsh-mcp-client'",
          '        config: { transport: stdio, serverName: context7, command: npx, args: ["-y", "@upstash/context7-mcp"] }',
          t('mcp-readme-hint'),
        ]
      }
      const lines: string[] = []
      for (const [server, tools] of byServer) {
        lines.push(t('mcp-server-tools', { server, count: tools.length, tools: tools.join(', ') }))
      }
      return lines
    },
    exportSession() {
      // Export from the session log — the authoritative, complete record —
      // not the bounded transcript window (folded rows keep only previews).
      const parts: string[] = [
        t('export-title'),
        '',
        t('export-time', { time: new Date().toLocaleString() }),
        t('export-model', { model: state.model }),
        t('export-session', { id: state.agentId }),
        t('export-dir', { cwd: state.cwd }),
        '',
      ]
      for (const event of binding.agent.session.events) {
        switch (event.type) {
          case 'user/message': {
            if (event.data.source.kind !== 'user') break
            // Export what the user SAW: the typed prompt, not the expanded
            // `@`-mention attachment blocks.
            const text = projector.firstTextOf(event.data.content)
            if (text) parts.push(`${t('export-user-section')}\n\n${text}\n`)
            break
          }
          case 'assistant/message': {
            const blocks = event.data.message.content
            for (const block of blocks) {
              if (block.type === 'reasoning' && block.text) {
                parts.push(`${t('export-thinking-section')}\n\n${block.text}\n`)
              } else if (block.type === 'text' && block.text) {
                parts.push(`${t('export-assistant-section')}\n\n${block.text}\n`)
              }
            }
            break
          }
          case 'tool/call': {
            parts.push(`${t('export-tool-section', { name: event.data.name })}\n\n\`\`\`json\n${event.data.arguments}\n\`\`\`\n`)
            break
          }
          case 'tool/result': {
            const block = event.data.message.content[0]
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable session data may not match type
            if (block.type === 'tool-result') {
              const text = projector.textOf(block.content)
              if (text) parts.push(`${t('export-result-section')}\n\n\`\`\`\n${text}\n\`\`\`\n`)
            }
            break
          }
          default:
            break
        }
      }
      const fileName = `dsh-tui-export-${Date.now()}.md`
      try {
        const target = join(state.cwd, fileName)
        writeFileSync(target, parts.join('\n'), 'utf8')
        return target
      } catch {
        return null
      }
    },
    initWorkspace() {
      const target = join(state.cwd, 'AGENTS.md')
      if (existsSync(target)) return 'exists'
      const template = [
        '# AGENTS.md',
        '',
        t('agentsmd-project'),
        '',
        t('agentsmd-project-body'),
        '',
        t('agentsmd-conventions'),
        '',
        t('agentsmd-convention-read'),
        t('agentsmd-convention-style'),
        '',
      ].join('\n')
      try {
        writeFileSync(target, template, 'utf8')
        return target
      } catch {
        return null
      }
    },
    doctorInfo() {
      const lines: string[] = []
      lines.push(`Node ${process.version} · ${process.platform} ${process.arch}`)
      lines.push(`${t('doctor-api-key', { state: process.env.DEEPSEEK_API_KEY ? t('doctor-key-configured') : t('doctor-key-missing') })}`)
      lines.push(t('doctor-model', { model: state.model, provider: options.provider }))
      lines.push(t('doctor-cwd', { cwd: state.cwd }))
      lines.push(t('doctor-context-window', { window: state.contextWindow ?? t('doctor-unknown') }))
      lines.push(`${t('doctor-session', { id: state.agentId })}${state.sessionTitle ? ' · ' + state.sessionTitle : ''}`)
      const userHome = homeDir()
      const configCandidates = [
        join(userHome, '.dsh-tui/cordis.yml'),
        join(userHome, '.dsh/profiles/dsh-tui/cordis.patch.yml'),
      ]
      for (const candidate of configCandidates) {
        lines.push(`${t('doctor-config', { candidate, state: existsSync(candidate) ? '✓' : t('doctor-config-missing') })}`)
      }
      // Session store candidates mirror the compat layer (sessionsRoots):
      // the active root depends on the composition (bare cordis.yml →
      // legacy ~/.dsh-tui/sessions, profile → $DSH_HOME/sessions), so list every
      // candidate with its own state instead of hardcoding one.
      for (const dir of sessionsRoots()) {
        lines.push(`${t('doctor-storage', { dir, state: existsSync(dir) ? '✓' : t('doctor-storage-uninit') })}`)
      }
      // Plugin-spec diagnostics (v0.15): the runtime generation and the
      // vendored registry self-check, both soft-probed (#183 discipline).
      const pluginHost = ctx.get('tuiPluginHost')
      lines.push(t('doctor-plugin-generation', { id: pluginHost?.generationId ?? t('doctor-plugin-host-missing') }))
      const violations = pluginHost?.selfCheck()
      lines.push(t('doctor-plugin-registry', {
        state: violations === undefined ? t('doctor-plugin-host-missing') : violations.length === 0 ? '✓' : `✗ ${violations.length}`,
      }))
      // P2 kernel consumer: /doctor reads the read-only HostFacade backed by
      // the KernelRuntime's unified lifecycle evidence. The same facade is the
      // host-internal diagnostic bridge; live probes are reflected here when
      // they have completed.
      const facade = getHostFacade(pluginHost)
      if (facade === undefined) {
        lines.push('Adapter kernel (P2): HostFacade unavailable')
      } else {
        const snapshot = facade.descriptor.snapshot()
        const permissions = getHostGrantStore(pluginHost)?.knownPermissions() ?? []
        const adapterDiagnostics = collectAdapterDiagnostics(adapterRuntime, snapshot, permissions)
        lines.push(
          `Adapter kernel (P2): mode=${adapterDiagnostics.runtime.mode} · contracts=${adapterDiagnostics.descriptor.contracts.length} · permissions=${adapterDiagnostics.permissions.length}`,
        )
      }
      return lines
    },
    pluginsInfo(args: string) {
      const host = ctx.get('tuiPluginHost')
      return pluginsInfoLines(args, {
        grants: getHostGrantStore(host) ?? currentGrantStore(),
        host: host?.describe(),
      })
    },
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

  /**
   * Assemble the context a fresh conversation for the live agent will load,
   * for the startup panel: the system prompt (sections + dynamic context +
   * tools), the workspace instruction files baseline discovery would
   * inject, and the skill catalog. Runs at boot and on every agent swap;
   * every source degrades independently, and a total failure leaves the
   * panel hidden instead of showing a broken snapshot. A snapshot computed
   * for a previous agent is discarded (swaps rebind `agent` mid-flight).
   */
  const refreshLoadedContext = async (): Promise<void> => {
    if (!owner.current()) return
    const target = binding.agent
    const sections: LoadedContextEntry[] = []
    const contexts: LoadedContextEntry[] = []
    const files: LoadedContextFile[] = []
    const skills: LoadedContextSkill[] = []
    const tools: LoadedContextTool[] = []
    try {
      const systemPrompt = ctx.get('systemPrompt')
      if (systemPrompt !== undefined) {
        const assembly = await systemPrompt.assemble(assembleContextFor(target))
        if (!owner.current() || target !== binding.agent) return
        // Render each section through the shared strict interpolator with
        // this assembly's variables (renderPrompt joins; a single-section
        // assembly renders exactly one section), keeping non-empty results.
        for (const section of assembly.sections) {
          const text = renderPrompt({
            sections: [section],
            contexts: [],
            tools: [],
            variables: assembly.variables,
          })
          if (text.length > 0) sections.push({ name: section.name, text })
        }
        contexts.push(...renderContextSections(assembly))
        for (const tool of assembly.tools) {
          tools.push({ name: tool.name, description: tool.description ?? '' })
        }
      }
      const renderedInstructions = await loadBaselineInstructions({
        cwd: state.cwd,
        maxBytes: 1024 * 1024,
        maxSourceBytes: 1024 * 1024,
      }, ctx.get('fs'))
      if (!owner.current() || target !== binding.agent) return
      const instructionSources = renderedInstructions as (typeof renderedInstructions & {
        represented?: readonly { displayPath: string }[]
      })
      const instructionPaths = new Set([
        ...(instructionSources?.represented ?? []).map(file => file.displayPath),
        ...(renderedInstructions?.omitted ?? []).map(file => file.displayPath),
        ...(renderedInstructions?.truncated ?? []).map(file => file.displayPath),
      ])
      files.push(...[...instructionPaths].map(displayPath => ({ displayPath })))
      // A registry entry reaches the model only through dsh-tool-skill's
      // catalog, which is gated on that exact tool being visible to the agent.
      const skillsRegistry = tools.some(tool => tool.name === 'skill')
        ? skillRegistryFor(target)
        : undefined
      if (skillsRegistry !== undefined) {
        const observation = await skillsRegistry.snapshot(skillViewOptions(target))
        if (!owner.current() || target !== binding.agent) return
        if (observation.complete) {
          skills.push(...observation.skills.filter(isModelInvocable).map(skill => ({
            name: skill.name,
            description: skill.description,
          })))
        }
      }
    } catch (error) {
      ctx.logger.warn('loaded-context snapshot failed: %o', error)
      return
    }
    state.loadedContext = { sections, contexts, files, skills, tools }
    state.emit()
  }

  /**
   * Rebuild the merged slash-command list: built-in locals, then registry
   * commands (plan/goal/…), then user-invocable skills from the DSH skill
   * registry (issue #86 — filesystem-discovered skills must appear in the
   * `/` menu and Tab completion, like /my-skill). Skill entries
   * are completion-only: dispatch falls through to the model as plain text,
   * where dsh-tool-skill's pre-step hook injects the skill body — the same
   * path a hand-typed `/skill-name` takes. Registry and skill reads are
   * scoped to the LIVE agent, so this runs on `commands/change` +
   * `skills/change` and again whenever the live agent is swapped
   * (rewind/resume/new/model). A failed skill read restores the last
   * successfully merged skill set for the same agent (last-good), so a
   * transient provider failure never makes known skills vanish.
   */
  let commandListSeq = 0
  /**
   * The last successfully merged skill entries, tagged with the agent whose
   * scope produced them. A failed catalog read restores these instead of
   * dropping skill entries from the menu until the next successful refresh
   * (last-good); the agent tag refuses cross-agent restores — a different
   * scope's skills may not exist for the live agent at all.
   */
  let lastGoodSkills: { agent: Agent; commands: LocalCommand[] } | undefined
  const refreshCommandList = (): void => {
    const target = binding.agent
    const token = ++commandListSeq
    const merged: LocalCommand[] = [...LOCAL_COMMANDS]
    if (commandService) {
      for (const descriptor of commandService.list(target)) {
        // Hidden TUI commands (e.g. /deepseek) stay out of the public
        // command catalog even if a plugin/skill happens to share the name.
        if (HIDDEN_COMMAND_NAMES.has(descriptor.name)) continue
        if (merged.some(command => command.name === descriptor.name)) continue
        const descriptions = commandTrees?.descriptions(descriptor.name)
        merged.push({
          name: descriptor.name,
          description: descriptor.description,
          ...(descriptions === undefined ? {} : { descriptions }),
          tag: descriptor.input?.hint,
          external: true,
          acceptsImages: descriptor.input?.images === true,
          // Skills reach the registry as ordinary commands, so the menu would
          // lose the marker HelpMenu uses to keep them out of the chrome list.
          // This channel registered them and is the authority on which names
          // are skills.
          ...(skillCommands.has(descriptor.name) ? { skill: true } : {}),
        })
      }
    }
    // The permission-presets service may be mounted (service row + session
    // projection) while its /permission COMMAND never reaches this agent's
    // registry view — command-row composition varies between harness
    // versions. When the service snapshot is usable, surface a TUI-side entry
    // so picker / completion / typed switches stay reachable; the switch
    // itself prefers the official command and falls back to the service's own
    // write path.
    if (!merged.some(command => command.name === 'permission')) {
      let service: unknown
      try {
        service = ctx.get('permissionPresets')
      } catch {
        service = undefined
      }
      const usable = service !== undefined
        && permissionPresetSnapshotFromService(service, target.session).availability === 'runtime'
      if (usable) {
        merged.push({
          name: 'permission',
          // English fallback text; the live label resolves through the
          // `cmd-desc-permission` dictionary entry (localizedDescription).
          description: 'Switch the permission preset (sandbox mode + approval policy)',
        })
      }
    }
    state.commandList = merged
    state.emit()
    // The skill catalog resolves asynchronously (filesystem providers scan
    // their roots), so skills append in a continuation; a newer refresh or
    // an agent swap supersedes this run (token/identity check, same rule as
    // refreshLoadedContext). Locals and registry commands win name
    // collisions — a skill named `plan` must not shadow the registry's.
    const skillsService = serviceForAgent<{
      snapshot(options?: { scope?: unknown; cwd?: string }): Promise<{
        skills: readonly SkillSummary[]
        complete: boolean
      }>
    }>(ctx, target, 'skills')
    if (skillsService === undefined) return
    /** Last-good restore shared by the failed-read and incomplete-read
     *  paths; the caller holds the staleness check. */
    const restoreLastGood = (): void => {
      const fallback = lastGoodSkills?.agent === target ? lastGoodSkills.commands : []
      const restored = fallback.filter(entry =>
        !merged.some(command => command.name === entry.name))
      if (restored.length === 0) return
      state.commandList = [...merged, ...restored]
      state.emit()
    }
    // snapshot() over list(): only a COMPLETE observation is authoritative
    // — list() discards `complete`, so a provider failure or a rescan still
    // in flight would resolve as a partial/empty catalog and wrongly clear
    // the last-good set (dsh-skill's own consumer contract).
    void skillsService.snapshot({
      scope: target,
      cwd: (target.session as { header?: { cwd?: string } }).header?.cwd ?? state.cwd,
    }).then((observation) => {
      if (!owner.current() || token !== commandListSeq || target !== binding.agent) return
      if (!observation.complete) {
        // Incomplete (provider failure/rescan mid-flight): NOT authoritative
        // — never clear last-good or repopulate from the partial catalog.
        // The provider's next invalidate fires skills/change for the retry.
        ctx.logger.warn('skill command merge: incomplete catalog observation, keeping last-good skills')
        restoreLastGood()
        return
      }
      const withSkills = [...merged]
      for (const skill of observation.skills) {
        if (!isUserInvocable(skill)) continue
        if (withSkills.some(command => command.name === skill.name)) continue
        withSkills.push({ name: skill.name, description: skill.description, skill: true })
      }
      const added = withSkills.slice(merged.length)
      lastGoodSkills = { agent: target, commands: added }
      // The sync phase already assigned `merged`; a complete read that adds
      // nothing leaves the state as-is (and authoritatively clears the
      // last-good set above).
      if (added.length === 0) return
      state.commandList = withSkills
      state.emit()
    }).catch((error: unknown) => {
      // A superseded read (a newer refresh or an agent swap beat it) says
      // nothing about the live menu: stay silent instead of logging a
      // misleading failure warning.
      if (!owner.current() || token !== commandListSeq || target !== binding.agent) return
      ctx.logger.warn('skill command merge failed: %o', error)
      // Last-good: a transient provider failure (rescan error, permission
      // hiccup) must not make known skills vanish from completion.
      restoreLastGood()
    })
  }
  // A registry mount or unmount can arrive as a command change (the harness
  // advertises /permission through the same commands service that also backs
  // the preset registry) — rebuild the dynamic Shift+Tab modes and re-derive
  // the indicator whenever the menu changes.
  ctx.on('commands/change', () => {
    refreshCommandList()
    rebuildSessionModes(agent)
    refreshMode()
  })
  ctx.on('skills/change', refreshCommandList)

  /**
   * The view a skill-catalog read must be taken through, as ONE value.
   *
   * The registry is host-plane but scope-LAYERED: a provider mounted by an
   * agent preset's standing composition files into that preset's layer, and a
   * read taken without the scope sees only the host layer. Passing the pair
   * together keeps a read from being taken half-scoped.
   *
   * @param target - the agent whose view is wanted.
   */
  const skillViewOptions = (target: Agent): { scope: Agent; cwd: string } => ({
    scope: target,
    cwd: state.cwd,
  })

  /** The skill registry as the given agent sees it, or undefined when a boot
   *  mounts none. `serviceForAgent` resolves through the agent's mount and
   *  falls back to the host context. */
  const skillRegistryFor = (target: Agent) =>
    serviceForAgent<{
      snapshot(options?: { scope?: unknown; cwd?: string }): Promise<{
        skills: readonly SkillSummary[]
        complete: boolean
      }>
      get(name: string, options?: { scope?: unknown; cwd?: string; signal?: AbortSignal }): Promise<unknown>
    }>(ctx, target, 'skills')

  /**
   * Skill commands this channel owns, by skill name. The value keeps the
   * description the command was registered with so an edited SKILL.md
   * re-registers instead of leaving a stale menu entry.
   */
  const skillCommands = new Map<string, { dispose: () => void; description: string }>()
  /** Skill names the registry refused (name taken, or invalid) — warn once. */
  const skillCommandsRefused = new Set<string>()
  /** Pending re-read after an incomplete catalog observation. */
  let skillCommandsRetry: ReturnType<typeof setTimeout> | undefined

  /**
   * Publish every user-invocable skill as a slash command (issue #86).
   *
   * The completion menu already lists these skills, but a menu entry is not a
   * command: nothing dispatches it, so typing the name and pressing Enter does
   * nothing. Registering through the host command registry is what makes them
   * runnable, and buys three things the TUI would otherwise reimplement:
   * `register` emits `commands/change`, so the menu merge folds the entry in
   * on its own; Enter dispatches through the normal command path, so the
   * invocation is logged as a paired `command/run`/`command/done` like every
   * other command; and the handler runs host-side, so invoking a skill is
   * DETERMINISTIC — the body is injected here, instead of sending `/name` to
   * the model and depending on it to recognize the text and reach for its
   * skill loader.
   *
   * `userInvocable` covers "human-facing command catalogs AND loaders", so
   * discovery alone would honor half the flag.
   */
  const refreshSkillCommands = async (): Promise<void> => {
    if (!owner.current()) return
    if (commandService === undefined) return
    const target = binding.agent
    const registry = skillRegistryFor(target)
    if (registry === undefined) return
    let observation
    try {
      observation = await registry.snapshot(skillViewOptions(target))
    } catch (error) {
      ctx.logger.warn('skill commands: catalog read failed: %o', error)
      return
    }
    if (!owner.current() || target !== binding.agent) return
    // A provider still warming its watcher reports an incomplete observation;
    // re-read once so a cold start cannot leave the menu permanently short.
    if (!observation.complete && skillCommandsRetry === undefined) {
      skillCommandsRetry = setTimeout(() => {
        skillCommandsRetry = undefined
        void refreshSkillCommands()
      }, SKILL_COMMAND_RETRY_MS)
    }
    const wanted = new Map<string, string>(
      observation.skills
        .filter(skill => isUserInvocable(skill))
        // A name the TUI's own command grammar cannot parse would show in the
        // menu and then fail to dispatch when typed; ask the real parser
        // instead of restating its pattern here.
        .filter(skill => parseCommandName(`/${skill.name}`)?.name === skill.name)
        // Built-in locals win a name collision, exactly as they do over
        // plugin-registered commands in refreshCommandList.
        .filter(skill => !isLocalCommandName(skill.name))
        .map(skill => [skill.name, skill.description] as const),
    )
    for (const [name, entry] of skillCommands) {
      if (wanted.get(name) === entry.description) continue
      entry.dispose()
      skillCommands.delete(name)
    }
    for (const [name, description] of wanted) {
      if (skillCommands.has(name) || skillCommandsRefused.has(name)) continue
      // Another plugin already owns this name (plan/goal/…): leave it alone.
      if (commandService.find(target, name) !== undefined) continue
      try {
        const dispose = commandService.register({
          name,
          description,
          // Deliberately omit `input.images`: skill gestures are text-only.
          // Capable composers refuse image batches, and rc.8+ command
          // executors enforce the same contract before this handler runs.
          // The invocation line is re-submitted as a user message (kernel
          // path) or replaced by the injected body (fallback) — recording
          // the raw input here too would duplicate it in the session log.
          recordInput: false,
          handler: async ({ agent: invoker, rawInput, signal }) => {
            // Kernel gesture path: the `skill` tool and dsh-tool-skill's
            // pre-step boundary mount together, so a visible `skill` tool
            // means the boundary scans this agent's user messages for the
            // `/name` gesture and injects the rendered body host-side —
            // the same architecture as the web client's ui-skill. Routing
            // through it keeps the user's args in the transcript message
            // (rawInput rides along instead of being swallowed by the
            // command layer) and matches the kernel's own adjudication.
            const tools = ctx.get('tools') as ToolsRegistryLike | undefined
            if (tools?.get('skill', invoker) !== undefined) {
              dispatchUserText(`/${name}${rawInput}`, 'followup')
              // Silent success: the submitted message is the feedback.
              return { kind: 'success' }
            }
            // Fallback for compositions without dsh-tool-skill (e.g. the
            // minimal preset): inject the rendered body directly, in the
            // official user-explicit invocation shape (dsh-skill's
            // SkillInvocationSource).
            const view = { ...skillViewOptions(invoker), signal }
            const skill = await skillRegistryFor(invoker)?.get(name, view)
            if (skill === undefined || !isUserInvocable(skill as SkillSummary)) {
              return { kind: 'error', text: t('skill-unavailable', { name }) }
            }
            invoker.followup(createUserMessage({
              content: [{ type: 'text', text: renderSkillContent(skill as never) }],
              source: { kind: 'skill-invocation', name, form: 'instructions' },
            }))
            return { kind: 'success' }
          },
        })
        skillCommands.set(name, { dispose, description })
        ctx.get('tuiEffectLedger')?.record(
          { operation: 'create', resource: { kind: 'command', id: name }, result: 'applied' },
          ctx,
        )
      } catch (error) {
        // C-041: a duplicate registration arrives as a plain-message Error
        // from dsh-commands; map it onto the contract code before handling
        // (the refusal path itself is unchanged).
        const mapped = mapCommandError(error)
        skillCommandsRefused.add(name)
        ctx.logger.warn(
          `skill commands: "${name}" not registrable%s: %o`,
          hasCommandErrorCode(mapped, 'DUPLICATE_CONTRIBUTION_ID') ? ' (DUPLICATE_CONTRIBUTION_ID)' : '',
          mapped,
        )
        ctx.get('tuiEffectLedger')?.record(
          {
            operation: 'create',
            resource: { kind: 'command', id: name },
            result: 'failed',
            errorCode: hasCommandErrorCode(mapped, 'DUPLICATE_CONTRIBUTION_ID') ? 'DUPLICATE_CONTRIBUTION_ID' : 'COMMAND_FAILED',
          },
          ctx,
        )
      }
    }
  }
  ctx.on('skills/change', () => {
    void refreshSkillCommands()
  })
  /**
   * Mirror the scene runtime's active scene into channel state, so screens
   * swap to it through the ordinary version-bump re-render instead of a
   * second subscription channel.
   */
  owner.own(settingsSectionsRuntime?.subscribe(() => { if (owner.current()) state.emit() }) ?? (() => undefined))
  const unsubscribeScenes = sceneRuntime?.subscribe(() => {
    if (state.pluginScene === sceneRuntime.active) return
    state.pluginScene = sceneRuntime.active
    state.emit()
  })
  /** See {@link Channel.releaseContributions}. */
  const releaseSkillCommands = (): void => {
    if (skillCommandsRetry !== undefined) clearTimeout(skillCommandsRetry)
    skillCommandsRetry = undefined
    for (const entry of skillCommands.values()) entry.dispose()
    skillCommands.clear()
  }

  refreshCommandList()
  void refreshLoadedContext()
  void refreshSkillCommands()

  const rowIds = { value: 0 }
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
    selection.current = undefined
    selection.assembled = undefined
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
      selection.current = { provider: state.provider, model: state.model }
    }
    void applyPreferredEffort()
    rebuildSessionModes(agent)
    refreshMode()
    const register = <T extends () => void>(dispose: T): T => {
      binding.subscribe(dispose)
      return dispose
    }
    const on = (...args: Parameters<typeof ctx.on>): ReturnType<typeof ctx.on> =>
      register(ctx.on(...args))
    register(installModelSelection(binding.agent.ctx, selection))
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
        const subagentId = isMainSession
          ? undefined
          : subagentStore.getSubagentIdBySession(session)
        if (subagentId !== undefined) {
          subagentStore.onSessionEvent(subagentId, event)
          if (event.type === 'assistant/chunk') {
            // Token-rate path (100-300 events/s): the store append stays
            // synchronous (cheap); the expensive snapshot + row projection
            // defers to the frame-aligned flush inside emitStream's 16ms
            // timer, so it coalesces exactly like the main-agent stream.
            subagentStreamDirty = true
            state.emitStream()
          } else {
            syncSubagentsNow()
            state.emit()
          }
          return
        }
        // Otherwise handle the bound main-agent session.
        if (!isMainSession) return
        if (session !== binding.agent.session) {
          // A background (agent view) session is active: refresh the rows
          // so its summary/status follows the live output, throttled.
          scheduleAgentViewRefresh()
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
        // Mode-affecting atoms fold into the Shift+Tab mode indicator the
        // moment they land (whether appended by cycleMode or by hand).
        const eventType = (event as { type: string }).type
        if (
          eventType === 'plan/mode'
          || eventType === 'sandbox/mode'
          || eventType === 'approval/policy'
          || eventType === 'permission/preset'
        ) {
          refreshMode()
        }
        if (eventType === 'plan/mode' && (event.data as unknown as { active?: boolean }).active === false) {
          const target = prePlanModes.get(session) ?? prePlanModeSpec(snapshotLiveSessionEvents(session))
          prePlanModes.delete(session)
          if (!explicitPlanExits.delete(session) && target !== undefined) {
            const queued = pendingPlanExitRestores.has(session)
            pendingPlanExitRestores.set(session, target)
            if (!queued) queueMicrotask(() => {
              const restore = pendingPlanExitRestores.get(session)
              pendingPlanExitRestores.delete(session)
              // Rebinding, reentry, or an explicit switch supersedes this restore.
              if (restore === undefined || session !== binding.agent.session || foldPlanActive(session.events)) return
              applyMode(restore).catch(error => {
                ctx.logger.warn(
                  `dsh-tui: plan-exit mode restore failed: ${error instanceof Error ? error.message : String(error)}`,
                )
              }).finally(() => {
                // Return the user to the preset they were on before plan mode
                // (when the runtime registry still offers it) instead of
                // parking them on the canonical bundle of the restored atoms.
                const remembered = prePlanPermissionIdentity.get(session)
                prePlanPermissionIdentity.delete(session)
                if (remembered === undefined || session !== agent.session) return
                applyPermissionIdentity(remembered).then((ok) => {
                  if (!ok || session !== agent.session) return
                  refreshMode()
                  state.notify(t('mode-switched', { name: modeDisplayName(state.mode) }))
                }).catch(() => {
                  // The identity restore is best-effort; failures already
                  // surfaced through applyPermissionIdentity's own notices.
                })
              })
            })
          }
        }
        projector.renderEvent(event)
        // Streaming deltas (one event per token) take the frame-aligned
        // path; every other event keeps synchronous notification.
        if (event.type === 'assistant/chunk') state.emitStream()
        else state.emit()
      }),
      // Subagent lifecycle tracking. The dsh-subagent service publishes scoped
      // observe-only events as `subagent/start` and `subagent/end`; the parent
      // Agent is carried by Cordis scope dispatch, not included in the payload.
      (() => {
        const disposeStart = on('subagent/start' as any, (info: { id: string; runId?: string; provider: string; local?: boolean }) => {
          if (!info?.id) return
          subagentStore.onSpawned(info.id, info.provider || 'subagent', info.provider, {
            runId: info.runId ?? info.id,
            local: info.local,
            description: pendingTaskDescriptions.shift() ?? `${info.provider || 'subagent'} task`,
          })
          // In-process providers publish a child Agent during this notification.
          // Resolve through ctx.get('agents') (the property proxy is
          // topology-sensitive); the child carries its session (live output
          // stream) and its provider/model route for the card header.
          try {
            const agents = ctx.get('agents') as
              | { get(id: string): { session?: unknown; options?: { provider?: string; model?: string } } | undefined }
              | undefined
            const child = agents?.get(info.id)
            if (child?.session) {
              subagentStore.linkSession(info.id, child.session)
              const model = child.options?.model ?? child.options?.provider
              if (model) subagentStore.patch(info.id, { model, provider: child.options?.provider ?? info.provider })
            }
          } catch {
            // Session discovery is best-effort and must not break the parent turn.
          }
          syncSubagentsNow()
          state.emit()
        })
        const disposeEnd = on('subagent/end' as any, (info: { id: string; stopReason: string; lastAssistantMessage?: unknown[] }) => {
          if (!info?.id) return
          const output = Array.isArray(info.lastAssistantMessage)
            ? info.lastAssistantMessage
                .map(block => typeof block === 'object' && block !== null && 'text' in block ? String((block as { text?: unknown }).text ?? '') : '')
                .filter(Boolean)
                .join('\n')
            : ''
          // The final assistant output becomes the card's summary only; the
          // running waterfall came from the child session stream, so echoing
          // it into the output buffer would duplicate it on the collapsed card.
          subagentStore.flushOutput(info.id)
          if (info.stopReason === 'completed') subagentStore.onCompleted(info.id, output, info.stopReason)
          else if (info.stopReason === 'cancelled' || info.stopReason === 'aborted') subagentStore.onCancelled(info.id, info.stopReason, output)
          else subagentStore.onFailed(info.id, info.stopReason || 'Unknown error')
          syncSubagentsNow()
          state.emit()
        })
        return () => {
          disposeStart()
          disposeEnd()
        }
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
    resetSubagents: resetSubagentProjection,
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
    resetSubagents: resetSubagentProjection,
    resetJobs: resetJobProjection,
    replay: events => projector.replayEvents(events),
    settleReplay: projector.settleStreaming,
    describeWorkspace: cwd => workspaceService.describe(cwd),
    refreshGitBranch: () => refreshGitBranch(),
    refreshEffortLevels,
    bindAgent,
    refreshCommands: refreshCommandList,
    refreshLoadedContext,
    refreshSkillCommands,
    clearStagedImages,
    notifySessionSwitched,
    notifyAgentView,
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
    resetSubagents: resetSubagentProjection,
    resetJobs: resetJobProjection,
    replay: events => projector.replayEvents(events),
    settleReplay: projector.settleStreaming,
    describeWorkspace: cwd => workspaceService.describe(cwd),
    refreshGitBranch: () => refreshGitBranch(),
    refreshEffortLevels,
    bindAgent,
    refreshCommands: refreshCommandList,
    refreshLoadedContext,
    refreshSkillCommands,
    clearStagedImages,
    settleCompaction: () => settleManualCompaction(),
    sessionSwitchVetoed,
    notify,
    notifySessionSwitched,
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
    if (agentViewRefreshTimer !== undefined) clearTimeout(agentViewRefreshTimer)
    agentViewListeners.clear()
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
