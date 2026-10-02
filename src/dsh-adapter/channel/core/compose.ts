/**
 * The backend-neutral channel core (docs/agent-backend-design.md §3.5): one
 * composition for every `AgentSession`, whatever backend serves it.
 *
 * `createCoreChannel` acquires, in one owner transaction, the binding, the
 * host seams and decision gate, the emitter, notifications, context
 * bookkeeping, the IDE selection link, the composer and input pipeline (FIFO,
 * `tui/input` decisions, `@` mentions, staged images, IDE selection) ending in
 * `session.submit`, the shared projector feed, session switching (`/new`),
 * local actions, files, reports and the capability-backed actions, and builds
 * the common half of the `ChannelState`. Nothing is subscribed and no action
 * is callable yet.
 *
 * An extension (the DSH specialists, `../extensions.ts`) then `extend`s the
 * core: hooks into the feed and the emitter, state fields it serves, and its
 * action delegates on top of the core's. `start()` installs the action table
 * once, starts the runtime subscriptions, binds the session, and hands the
 * channel lifetime to Cordis. A session no extension claims is served by the
 * core alone: every action is backed by a capability, the core, or explicitly
 * unavailable.
 */
import type { Context } from '@deepseek-ai/cordis'
import { markChannelReadDirty } from '../../../adapter/channel/read-view.js'
import type { OAuthSetupHost } from '../../../adapter/ports/channel-settings.js'
import type { AgentSession } from '../../../agent/session.js'
import { createActivityProjection } from '../../../channel/activity.js'
import { channelCapabilities } from '../../../channel/capabilities.js'
import { anchoredRow, prependHistoryRows, projectHistorySlice, restoreFoldedRows } from '../../../channel/history-restore.js'
import { t } from '../../../i18n.js'
import { DEFAULT_SESSION_MODES } from '../../../sessionModes.js'
import { IdeChannel, ideLockDir, type SelectionSnapshot } from '../../ide-channel.js'
import { createChannelActionMethods, createChannelActionReadiness, type ChannelActionDelegates } from '../action-readiness.js'
import { createChannelBinding, type ChannelBinding } from '../binding.js'
import { channelCommands } from '../commands.js'
import { createComposerImages } from '../composer-images.js'
import { createContextBookkeeping } from '../context-bookkeeping.js'
import { createChannelEmitter } from '../emitter.js'
import { createSelectionAttachments } from '../ide-selection.js'
import { createInputActions, type InputConvergence } from '../input-actions.js'
import { createInputDelivery } from '../input-delivery.js'
import { createChannelNotifications } from '../notifications.js'
import { registerChannelOwner, type ChannelOwner } from '../owner.js'
import { unavailablePermissionPresetSnapshot } from '../permissions.js'
import { createPreferences } from '../preferences.js'
import { createSettingsHosts } from '../settings-host.js'
import { createInitialChannelView, type ChannelLaunchOptions } from '../state.js'
import type { ChannelState } from '../types.js'
import { createCapabilityDelegates, installChannelActions } from './actions.js'
import { createBindingFeed, type BindingFeedHooks } from './binding-feed.js'
import { createCoreFiles, NO_COMPLETION_CATALOG, type CompletionCatalog } from './files.js'
import { createGitBranchRefresher, resolveCoreHost, startHostSubscriptions, type CoreHost } from './host.js'
import { createCoreLocalActions } from './local-actions.js'
import { createCoreReports } from './reports.js'
import { createSessionControls, localCommandsFor } from './session-controls.js'
import { createCoreSessionActions } from './sessions.js'
import { createWorkspaceActions } from '../workspace-actions.js'
import { createBackendOpener, createSessionSwitch, SESSION_MOUNT_LEDGER, type NewSessionOpener, type ResumeSessionOpener } from './session-switch.js'

/** Token buffer below the context window at which the context-low warning fires. */
const CONTEXT_WARNING_BUFFER_TOKENS = 20_000

/** A session without a durable log of its own for `/trace`. */
const NO_TRACE: readonly never[] = Object.freeze([])

/** The job registry feed is a DSH host service; nothing feeds it by default. */
const NO_JOB_FEED = { onOutputSeen: () => undefined, onStarted: () => undefined }

/**
 * What an extension contributes (every member optional; `extend` merges, a
 * later call wins per member, `delegates` merge by action name).
 */
export interface ChannelExtension {
  /** The object a parked decision's staleness is judged by (default: the
   *  session object; DSH: its agent, which rebinds keep across wrappers). */
  conversationKey?(session: AgentSession): object
  /** Flush deferred projection work before a frame wake; true = the
   *  renderer-visible data changed (DSH: the subagent stream batcher). */
  flushDeferred?(): boolean
  /** Restore folded rows from the backend's durable history. Its presence
   *  enables folding past the transcript window; absent, the session's
   *  `transcript` capability does (folding only the rows it can restore),
   *  and without either nothing folds. */
  loadOlder?(): number
  /** The extension projects subagents and background jobs itself (DSH: its
   *  host-service specialists): the core's event-driven activity projection
   *  stays inert and its controls are the extension's. */
  readonly ownsActivity?: boolean
  /** Whether the local disk stands in for a missing host `fs` service
   *  (default true; the DSH workspace may be remote, so DSH says false). */
  localFs?: boolean
  /** Rows of extension projections that `/clear` drops with the transcript. */
  dropRows?(): void
  /** Move a used session to the front of the `/resume` MRU. */
  touchSession?(sessionId: string): void
  /** Record a resolved git branch against the bound session. */
  noteBranch?(branch: string): void
  /** Argument catalogs for slash completion. */
  completions?: CompletionCatalog
  /** Hooks into every bind (core/binding-feed.ts). */
  bind?: BindingFeedHooks
  /** How `/new` opens a fresh session (default: `options.openSession`). */
  newSession?: NewSessionOpener
  /** How the core `/resume` reopens a persisted session (default:
   *  `options.openSession`; DSH serves `/resume` itself). */
  resumeSession?: ResumeSessionOpener
  /** Actions served on top of the core's. */
  delegates?: Partial<ChannelActionDelegates>
  /** Runtime starts around the core's host subscriptions, before the bind. */
  start?: { before?(): void; after?(): void }
}

/** The core as an extension sees it. */
export type CoreChannel = ReturnType<typeof createCoreChannel>

export function createCoreChannel(
  ctx: Context,
  initialSession: AgentSession,
  options: ChannelLaunchOptions,
  owner: ChannelOwner,
) {
  const rowIds = { value: 0 }
  const binding: ChannelBinding = createChannelBinding(initialSession, owner)
  // A session that owns its own lifetime (no host registry disposes it — any
  // non-DSH backend) is closed when the channel releases; registered first,
  // so a throw anywhere later in construction still stops it. Replaced
  // sessions are closed by the binding at adoption.
  owner.own(() => { binding.releaseOwned() })
  const host: CoreHost = resolveCoreHost(ctx, owner)

  let extension: ChannelExtension = {}
  let started = false

  const emitter = createChannelEmitter(() => state, () => extension.flushDeferred?.() ?? false, {
    // Folding drops a row's full text on the promise that `loadOlder`
    // restores it; without a history slicer every row stays whole. A
    // session's durable transcript restores only rows with a stable anchor.
    fold: () => extension.loadOlder !== undefined || binding.session.capabilities.transcript !== undefined,
    restorable: row => extension.loadOlder !== undefined || anchoredRow(row),
  })
  // The emitter exists before the complete state surface. Put it in the
  // construction rollback funnel immediately; normal release remains
  // idempotent through the same disposer.
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
  /**
   * Subagents and background jobs of a session no extension projects
   * (design §4.8): fed by the shared projector in stream order; output tails
   * read through the session's `tasks` capability while a card is watched.
   */
  const activity = createActivityProjection(() => state, {
    rowIds,
    notify: (...args) => notify(...args),
    emit: () => { if (owner.current()) state.emit() },
    readOutput: taskId => binding.session.capabilities.tasks?.readOutput?.(taskId),
  })
  owner.own(() => { activity.dispose() })
  const activityOwned = (): boolean => extension.ownsActivity !== true
  /**
   * The binding generation the view was last `/clear`ed in. `/clear` is
   * view-only (every backend, as DSH): history older than the cleared view
   * must not come back through "load earlier" — rows folded after the
   * clear still restore — and the divider is hidden, until another session
   * is bound.
   */
  let clearedGeneration: number | undefined
  const viewCleared = (): boolean => clearedGeneration !== undefined && clearedGeneration === state.agentBindingGeneration
  /** "Load earlier" through the session's durable transcript: restore the
   *  folded rows first, then prepend the next older slice. */
  const transcriptLoadOlder = (): number => {
    const transcript = binding.session.capabilities.transcript
    if (transcript === undefined) return 0
    const failed = (error: unknown): number => {
      notify(t('capability-failed', { name: 'load earlier', err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
      return 0
    }
    try {
      if (state.rows.some(row => row.folded === true)) {
        const record = transcript.record()
        const restored = record === undefined ? 0 : restoreFoldedRows(state.rows, record)
        if (restored > 0) return restored
      }
      if (viewCleared() || !transcript.hasOlder()) return 0
      return prependHistoryRows(state.rows, projectHistorySlice(transcript.older(), state.thinkingFold))
    } catch (error) {
      return failed(error)
    }
  }
  const bookkeeping = createContextBookkeeping(
    () => state,
    (text, notifyOptions) => notify(text, notifyOptions),
    percent => t('context-low-warning', { percent }),
    CONTEXT_WARNING_BUFFER_TOKENS,
  )
  const { resetContextWarning, checkContextWarning, trackPending, untrackPending } = bookkeeping

  // IDE selection channel (AC-5): one IdeChannel per channel, started in the
  // background against the session cwd — lock discovery needs it, env
  // direct-connect does not but tolerates the extra hint. start() is fully
  // non-throwing and self-degrading, so a missing IDE costs nothing and
  // startup never waits on the loopback dial.
  const ideChannel = new IdeChannel()
  // The loopback link lives outside every other owner: own its stop at once
  // so a construction failure past this line releases it (`stop` is
  // idempotent; `releaseContributions` stops it again in its finally).
  owner.own(() => { ideChannel.stop() })
  void ideChannel.start(process.env, ideLockDir(), options.cwd).catch(() => {})
  let currentSelection: SelectionSnapshot | undefined
  ideChannel.onSelection(snapshot => {
    // The channel already clears empty snapshots internally; mirror that here
    // so consumption reads one consistent variable.
    currentSelection = snapshot.isEmpty ? undefined : snapshot
    // Live prompt-footer badge: the projection must reach the screen BEFORE
    // the user submits — emit() bumps `version` so the useSyncExternalStore
    // tree re-renders with the new badge immediately.
    state.selection = currentSelection
    state.emit()
  })
  /**
   * Re-target the IDE selection link when the session's working directory
   * changes (/resume, /workspace, /new, an adopted background session): a
   * selection made in the OLD workspace would otherwise stay projected — the
   * badge shows it and the next submit attaches the wrong file — and the OLD
   * link would keep pushing the old window's selections into the new one.
   * rebind() drops the link and rediscovers against the new cwd. Callers
   * set state.cwd BEFORE this runs, so it reads the fresh value.
   */
  const resetIdeSelection = (): void => {
    currentSelection = undefined
    state.selection = undefined
    state.emit()
    void ideChannel.rebind(state.cwd).catch(() => {})
  }
  const selectionAttachments = createSelectionAttachments()
  const composer = createComposerImages(ctx, owner, { generation: () => state.agentBindingGeneration })
  const files = createCoreFiles(ctx, {
    owner,
    binding,
    state: () => state,
    host,
    localFallback: () => extension.localFs !== false,
    // Read late: the session controls are built after the files.
    mcpServers: () => controls.mcpServers(),
  })
  const inputDelivery = createInputDelivery(ctx, owner, binding, () => state,
    (...args) => notify(...args), trackPending, untrackPending, composer,
    () => currentSelection, (messageId, info) => selectionAttachments.remember(messageId, info),
    files.fallbackFs)
  const { dispatchUserText, withDecisionPending, clearStagedImages } = inputDelivery
  /** Monotonic token: only the latest `interruptAndDeliver` re-queues, so a
   *  second interrupt while the abort settles cannot double-deliver. */
  const inputConvergence: InputConvergence = { interruptSeq: 0, cancelInFlight: false }

  const actionReadiness = createChannelActionReadiness()
  const getReadyActions = (): ChannelActionDelegates => {
    owner.assertActive()
    return actionReadiness.getReadyActions()
  }
  const actionMethods = createChannelActionMethods(getReadyActions)

  const backendLabel = options.backendLabel ?? initialSession.ref.backendId
  const snapshotOf = (session: AgentSession) => channelCapabilities({
    backendId: session.ref.backendId,
    backendLabel,
    capabilities: session.capabilities,
    dsh: false,
    resume: options.openSession !== undefined && options.sessionCatalog !== undefined,
  })
  const initialCapabilities = snapshotOf(initialSession)

  const state: ChannelState = {
    ...createInputActions(() => state, () => binding.session, owner, inputConvergence,
      composer,
      (text, placement, images) => dispatchUserText(text, placement, images),
      (command, includeInContext) => getReadyActions().runLocalCommand(command, includeInContext),
      sessionId => { extension.touchSession?.(sessionId) }),
    subscribe: emitter.subscribe,
    emit: emitter.emit,
    emitStream: emitter.emitStream,
    ...createSettingsHosts(ctx, owner.assertActive),
    ...createPreferences(() => state),
    /** Mount-owned settings namespace: the section registers under it, so this
     *  is the only ns whose section carries the TUI's user layer. */
    settingsNamespace: options.settingsNs ?? 'dsh-tui',
    // The open-time recap is an extension feature (DSH: one LLM call).
    autoRecapOnOpen: false,
    ...createInitialChannelView(options, {
      agentId: initialSession.ref.sessionId,
      sessionId: initialSession.ref.sessionId,
      // The unmarked base mode: backend-native modes are a capability.
      mode: DEFAULT_SESSION_MODES[0]!,
      cwdDescription: host.workspaceService.describe(options.cwd).description ?? options.cwd,
    }),
    // Deprecated pre-rename alias of `minimalUi`. An accessor is required here
    // (a field set in createInitialChannelView would be copied by the spread
    // into a stale data property). Read-only on purpose: the only supported
    // write path is `setMinimalUi()` / its `setMinimal()` alias.
    get minimal(): boolean {
      return state.minimalUi
    },
    commandList: localCommandsFor(initialCapabilities.commands),
    capabilities: initialCapabilities,
    get sessionRef() {
      const ref = binding.session.ref
      return { backendId: ref.backendId, sessionId: ref.sessionId }
    },
    costReport: undefined,
    rateLimit: undefined,
    get olderHistory(): boolean {
      return extension.loadOlder === undefined && !viewCleared() && (binding.session.capabilities.transcript?.hasOlder() ?? false)
    },
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
    subagentControl: {
      interrupt: agentId => {
        const control = binding.session.capabilities.subagents
        if (control === undefined) { unavailable('agents'); return false }
        const subagent = activity.subagent(agentId)
        if (subagent === undefined || (subagent.status !== 'running' && subagent.status !== 'starting')) return false
        void control.interrupt(subagent.agentId).then(stopped => {
          if (!stopped && owner.current()) notify(t('subagent-interrupt-failed', { id: subagent.agentId.slice(0, 8) }), { color: 'warning', timeoutMs: 6000 })
        }, (error: unknown) => {
          if (owner.current()) notify(t('capability-failed', { name: 'agents', err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
        })
        return true
      },
    },
    jobControl: {
      kill: id => {
        const tasks = binding.session.capabilities.tasks
        if (tasks === undefined) { unavailable('jobs'); return false }
        const job = activity.job(id)
        if (job === undefined || (job.status !== 'running' && job.status !== 'stopping')) return false
        void tasks.stop(id).then(stopped => {
          if (!stopped && owner.current()) notify(t('jobs-kill-failed', { id }), { color: 'error', timeoutMs: 6000 })
        }, (error: unknown) => {
          if (owner.current()) notify(t('capability-failed', { name: 'jobs', err: error instanceof Error ? error.message : String(error) }), { color: 'error', timeoutMs: 8000 })
        })
        return true
      },
      watchOutput: id => activity.watchOutput(id),
    },
    stagedImageGeneration: composer.stagedImageGeneration,
    stageImage: composer.stageImage,
    stageComposerImage: composer.stageComposerImage,
    hasStagedImage: composer.hasStagedImage,
    discardStagedImage: composer.discardStagedImage,
    stagedImage: composer.stagedImage,
    stagedImageLimits: composer.stagedImageLimits,
    // The core rewind prompt (capability-backed); the DSH extension
    // replaces it with its plugin-decision prompt.
    promptRewind: row => sessionActions.promptRewind(row),
    buildSessionTree: () => {
      unavailable('tree')
      return Promise.resolve(null)
    },
    notify: createChannelNotifications(() => state, owner),
    permissionPresets: () => unavailablePermissionPresetSnapshot(),
    settingsSections: () => host.settingsSectionsRuntime?.list() ?? [],
    subscribeSettingsSections: listener => emitter.subscribe(listener),
    pluginScene: host.sceneRuntime?.active,
    openPluginScene: id => host.sceneRuntime?.open(id) ?? false,
    closePluginScene: () => { host.sceneRuntime?.close() },
    releaseContributions() {
      // Owner cleanup is exhaustive, but it can report an external cleanup
      // failure. The emitter and the IDE loopback link are both OUTSIDE the
      // owner and must still stop no matter which earlier step throws — a
      // bare trailing ideChannel.stop() used to be skipped whenever
      // owner.dispose() threw, leaking the socket (maintainer review round 3).
      try {
        owner.dispose()
      } finally {
        try { emitter.dispose() } finally { ideChannel.stop() }
      }
    },
    traceEvents: () => NO_TRACE,
  }

  // Register the raw state before any specialist can synchronously publish a
  // callback. The renderer lease binds its external authority later, but this
  // owner already makes teardown and construction failure fail closed.
  registerChannelOwner(state, owner)

  const controls = createSessionControls({ state: () => state, backendLabel: () => state.capabilities.backendLabel })
  const feed = createBindingFeed(ctx, {
    owner,
    binding,
    state,
    options,
    inputConvergence,
    projection: {
      rowIds, resetContextWarning,
      jobs: NO_JOB_FEED,
      activity: { apply: (event, replaying) => { if (activityOwned()) activity.apply(event, replaying) } },
      checkContextWarning, notify: (...args) => notify(...args),
      renderer: host.rendererRuntime,
      selectionAttached: messageId => selectionAttachments.take(messageId),
    },
    retireAttachment: inputDelivery.retireAttachment,
    controls,
    hooks: () => extension.bind ?? {},
    onReset: event => { resetConversation(event) },
  })
  /**
   * The backend reset the conversation in place (Claude `conversation_reset`:
   * a plan-mode exit that clears the context, a fresh-session flow): what the
   * view shows belonged to the discarded conversation — the rows, the
   * subagent and job rosters, the usage and cost of it, its title — so it
   * goes, as on a session switch, and a notice row says why. Queued inputs
   * stay (the backend still runs them). Unlike the TUI's own view-only
   * `/clear`, this follows a reset the backend made.
   */
  const resetConversation = (event: { readonly trigger: string }): void => {
    state.rows.length = 0
    markChannelReadDirty(state.rows)
    rowIds.value = 0
    feed.resetProjection()
    extension.dropRows?.()
    if (activityOwned()) activity.reset()
    state.todos = []
    state.sessionTitle = ''
    state.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    state.mainCost = {}
    state.subagentCost = []
    state.costReport = undefined
    state.lastUsage = undefined
    state.contextSegments = { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 }
    state.activeToolCount = 0
    state.responseChars = 0
    state.compaction = undefined
    resetContextWarning()
    // The history before the reset is another conversation's: "load
    // earlier" never brings it back above this view.
    clearedGeneration = state.agentBindingGeneration
    const key = event.trigger === 'clear' ? 'conversation-reset-clear'
      : event.trigger === 'plan_mode_exit' ? 'conversation-reset-plan'
        : event.trigger === 'fresh_session' ? 'conversation-reset-fresh'
          : 'conversation-reset'
    state.rows.push({ id: rowIds.value++, kind: 'notice', text: t(key) })
    state.emit()
  }

  /** `!!` commands on their way to the session (`/new` waits them out). */
  const shellInputs = { started: 0, inFlight: 0 }
  const sessionSwitch = createSessionSwitch(ctx, {
    owner,
    binding,
    state: () => state,
    notify,
    withDecisionPending,
    conversationKey: session => extension.conversationKey?.(session) ?? session,
    describeWorkspace: cwd => host.workspaceService.describe(cwd),
    resetIdeSelection,
    clearStagedImages,
    opener: () => extension.newSession ?? defaultOpeners?.create,
    resumeOpener: () => extension.resumeSession ?? defaultOpeners?.resume,
    activity: () => {
      const fifo = inputDelivery.activity()
      return {
        inputs: fifo.dispatched + shellInputs.started,
        unsettled: fifo.unsettled || shellInputs.inFlight > 0,
        turnStarts: feed.router.turnStarts(),
        ...(fifo.parked !== undefined ? { parked: fifo.parked } : shellInputs.inFlight > 0 ? { parked: '!!' } : {}),
      }
    },
    unavailable,
  })
  /** `/new` and `/resume` on a session no extension claims: the backend's
   *  own `open`. */
  const defaultOpeners = options.openSession === undefined ? undefined : createBackendOpener({
    open: options.openSession,
    state,
    rowIds,
    resetProjection: feed.resetProjection,
    resetActivity: () => { activity.reset() },
    snapshotOf,
    resetControls: controls.reset,
    bind: seed => feed.bind(seed),
    bound: () => binding.session,
    mounts: SESSION_MOUNT_LEDGER,
    ...(options.sessionPrefs === undefined ? {} : { touch: (sessionId: string) => options.sessionPrefs?.touch(sessionId) }),
    notify,
  })
  /** The browser's catalog, `/resume`, `/fork` and the rewind (core). */
  const sessionActions = createCoreSessionActions({
    owner,
    session: () => binding.session,
    state: () => state,
    notify,
    unavailable,
    catalog: options.sessionCatalog,
    prefs: options.sessionPrefs,
    resumeCommand: options.resumeCommand,
    resume: (sessionId, kind) => sessionSwitch.resumeSession(sessionId, kind),
    // `/resume` (the browser's open) needs the catalog too — the same rule
    // as the capability snapshot; a rewind adopts its fork by `open` alone.
    canOpen: options.openSession !== undefined && options.sessionCatalog !== undefined,
  })

  const local = createCoreLocalActions(ctx, {
    owner,
    binding,
    state,
    rowIds,
    workspace: host.workspaceService,
    resetProjection: feed.resetProjection,
    notify,
    unavailable,
    dropRows: () => {
      extension.dropRows?.()
      if (activityOwned()) activity.dropRows()
    },
    loadOlder: () => extension.loadOlder ?? (binding.session.capabilities.transcript === undefined ? undefined : transcriptLoadOlder),
    beginInput: () => {
      shellInputs.started += 1
      shellInputs.inFlight += 1
      let ended = false
      return () => {
        if (ended) return
        ended = true
        shellInputs.inFlight -= 1
      }
    },
  })
  const reports = createCoreReports({ owner, binding, state: () => state })
  /** A fresh session in another directory (the session browser's new-session
   *  card, `/workspace`'s handoff): the core `/new` with a target. */
  const workspaces = createWorkspaceActions(state, {
    owner,
    service: host.workspaceService,
    newSession: target => sessionSwitch.newSession(target),
    refreshGitBranch: () => refreshGitBranch(),
    notify,
  })
  const refreshGitBranch = createGitBranchRefresher(ctx, {
    owner,
    state,
    noteBranch: branch => { extension.noteBranch?.(branch) },
  })

  return {
    state,
    owner,
    binding,
    rowIds,
    host,
    notify,
    unavailable,
    bookkeeping,
    composer,
    input: inputDelivery,
    inputConvergence,
    feed,
    sessionSwitch,
    local,
    files,
    reports,
    resetIdeSelection,
    refreshGitBranch,
    /** Merge an extension's contributions (before `start`). */
    extend(next: ChannelExtension): void {
      if (started) throw new Error('dsh-tui: Channel extensions must attach before the channel starts')
      extension = {
        ...extension,
        ...next,
        delegates: { ...extension.delegates, ...next.delegates },
      }
    },
    /** Install the actions, start the runtime, bind the session. */
    start(): ChannelState {
      if (started) throw new Error('dsh-tui: Channel already started')
      started = true
      const core: Partial<ChannelActionDelegates> = {
        commandCompletions: files.commandCompletions(extension.completions ?? NO_COMPLETION_CATALOG),
        runLocalCommand: local.runLocalCommand,
        loadOlder: local.loadOlder,
        clear: () => {
          local.clear()
          clearedGeneration = state.agentBindingGeneration
        },
        setActivityFrames: local.setActivityFrames,
        pushLocal: local.pushLocal,
        listFileCandidates: files.listFileCandidates,
        listFiles: files.listFiles,
        doctorInfo: reports.doctorInfo,
        exportSession: reports.exportSession,
        newSession: () => sessionSwitch.newSession(),
        // `/agents` from the event-driven roster (the DSH extension serves its own).
        listSubagents: () => Promise.resolve(binding.session.capabilities.subagents === undefined ? unavailableLines('agents') : activity.listLines()),
        resolveWorkspace: workspaces.resolveWorkspace,
        switchWorkspace: workspaces.switchWorkspace,
        ...sessionActions.delegates,
      }
      installChannelActions(actionReadiness, {
        unavailable,
        unavailableLines,
        capability: createCapabilityDelegates({
          owner,
          session: () => binding.session,
          state: () => state,
          notify,
          unavailable,
          unavailableLines,
          controls,
        }),
        core,
        extension: extension.delegates,
      })
      // Everything below can synchronously invoke external callbacks. It runs
      // only after the owner is registered and the complete delegate surface
      // is installed; the outer construction transaction rolls every step back.
      extension.start?.before?.()
      startHostSubscriptions(host, owner, state)
      extension.start?.after?.()
      // The startup session's history, read ahead of construction, paints
      // before any live event (an extension owning the facts replays its own).
      feed.bind(extension.bind?.ownsSessionFacts === true ? undefined : options.initialHistory)
      // Cordis owns the Channel lifetime. Rebinding handles the common case;
      // this effect closes the final timer and releases the DecisionEvents
      // dispatch-topology marker when the Channel's context unloads.
      const effect = (ctx as Context & {
        effect?: (setup: () => () => void, label?: string) => void
      }).effect
      effect?.call(ctx, () => () => {
        // The context owns the complete Channel lifetime. Keep emitter and
        // IDE-link teardown in the same finally funnel.
        state.releaseContributions()
      }, 'dsh-tui channel lifecycle')
      refreshGitBranch()
      if (extension.bind?.ownsSessionFacts !== true) state.emit()
      return state
    },
  }
}
