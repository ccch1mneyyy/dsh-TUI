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
import type { OAuthSetupHost } from '../../../adapter/ports/channel-settings.js'
import type { AgentSession } from '../../../agent/session.js'
import { channelCapabilities } from '../../../channel/capabilities.js'
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
import { createBackendOpener, createSessionSwitch, type NewSessionOpener } from './session-switch.js'

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
   *  enables folding past the transcript window; absent, nothing folds. */
  loadOlder?(): number
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
    // restores it; without a history slicer every row stays whole.
    fold: () => extension.loadOlder !== undefined,
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
      checkContextWarning, notify: (...args) => notify(...args),
      renderer: host.rendererRuntime,
      selectionAttached: messageId => selectionAttachments.take(messageId),
    },
    retireAttachment: inputDelivery.retireAttachment,
    controls,
    hooks: () => extension.bind ?? {},
  })

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
    opener: () => extension.newSession ?? defaultOpener,
    unavailable,
  })
  /** `/new` on a session no extension claims: the backend's own `open`. */
  const defaultOpener: NewSessionOpener | undefined = options.openSession === undefined ? undefined : createBackendOpener({
    open: options.openSession,
    state,
    rowIds,
    resetProjection: feed.resetProjection,
    snapshotOf,
    resetControls: controls.reset,
    bind: feed.bind,
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
    dropRows: () => { extension.dropRows?.() },
    loadOlder: () => extension.loadOlder,
  })
  const reports = createCoreReports({ owner, binding, state: () => state })
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
        clear: local.clear,
        setActivityFrames: local.setActivityFrames,
        pushLocal: local.pushLocal,
        listFileCandidates: files.listFileCandidates,
        listFiles: files.listFiles,
        doctorInfo: reports.doctorInfo,
        exportSession: reports.exportSession,
        newSession: () => sessionSwitch.newSession(),
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
      feed.bind()
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
