/**
 * TuiController — the ONLY subscriber translating the business channel and
 * the UI stores into per-screen readonly projections (plan §1.3, WP-02).
 *
 * The channel stays the single mutable business store; this controller never
 * copies it into a second one. Each getter rebuilds its slice from the
 * current sources and compares field-by-field against the cached projection
 * (arrays/objects by REFERENCE — rows, pending, notifications are shared,
 * never deep-copied per tick): when nothing the slice reads changed, the
 * previous object is returned, so `meta.revision` marks the source version
 * of the last CONTENT change rather than the last notification. A moved
 * sessionEpoch/generation fence alone refreshes only those two stamps.
 * The transcript slice is the exception: its `rows` array is mutated in
 * place by the channel, so content moves are indistinguishable from bare
 * version bumps and its revision tracks the channel version itself.
 *
 * Notification is synchronous and unbatched: the channel's `emitStream`
 * already coalesces streaming deltas to ~16ms, so the controller adds no
 * scheduling of its own — listeners simply pull the latest projection
 * through the getters (repeated synchronous notifies dedupe naturally: every
 * pull sees the newest state).
 *
 * Fence semantics: `sessionEpoch` comes from the channel (bumped by
 * /new, /resume, /model switches and rewinds), `generation` from the shared
 * {@link TuiFences} (i.e. `TuiLifecycle.generation`). The one controller-owned
 * async read, {@link TuiController.refreshSessions}, applies the same fence
 * the command sink does: a result settling after either fence moved is
 * dropped and logged, never written into the sessions projection.
 */
import type { Channel } from '../dsh-adapter/channel.js'
import type { ApprovalSnapshot } from '../dsh-adapter/approvals.js'
import type { TuiDialogSnapshot } from '../dsh-adapter/dialogs.js'
import type { QuestionSnapshot } from '../dsh-adapter/questions.js'
import type { SessionSummary } from '../dsh-adapter/sessions/types.js'
import type { TuiStatusEntry } from '../dsh-adapter/status.js'
import { logForDebugging } from '../utils/debug.js'
import type { TuiFences } from './commands.js'
import type {
  ChatViewModel,
  GoalTodoProjection,
  HeaderProjection,
  OverlayProjection,
  PluginSceneProjection,
  ProjectionMeta,
  PromptProjection,
  SessionsProjection,
  SettingsSectionsProjection,
  SpinnerProjection,
  StatusLineProjection,
  SubagentsProjection,
  TrajectoryProjection,
  TranscriptProjection,
  ViewModelSlice,
} from './view-model.js'

/**
 * The controller's channel consumption surface, narrowed to a structural
 * interface so tests (and headless hosts) can drive the controller with a
 * minimal fake — the real `Channel` satisfies it as-is. Field types are
 * indexed access off `Channel` so this cannot drift from the store.
 */
export interface ChannelProjectionSource {
  readonly version: Channel['version']
  readonly sessionEpoch: Channel['sessionEpoch']
  readonly rows: Channel['rows']
  readonly agentId: Channel['agentId']
  readonly cwd: Channel['cwd']
  readonly gitBranch: Channel['gitBranch']
  readonly provider: Channel['provider']
  readonly model: Channel['model']
  readonly tokens: Channel['tokens']
  readonly displayCwd: Channel['displayCwd']
  readonly sessionTitle: Channel['sessionTitle']
  readonly working: Channel['working']
  readonly spinnerMode: Channel['spinnerMode']
  readonly responseChars: Channel['responseChars']
  readonly activeToolCount: Channel['activeToolCount']
  readonly turnStart: Channel['turnStart']
  readonly notifications: Channel['notifications']
  readonly contextWindow: Channel['contextWindow']
  readonly reasoningEffort: Channel['reasoningEffort']
  readonly effortLevels: Channel['effortLevels']
  readonly lastUsage: Channel['lastUsage']
  readonly tps: Channel['tps']
  readonly tpsSamples: Channel['tpsSamples']
  readonly workingActivity: Channel['workingActivity']
  readonly activityFrames: Channel['activityFrames']
  readonly statusBar: Channel['statusBar']
  readonly scrollGutter: Channel['scrollGutter']
  readonly whale: Channel['whale']
  readonly minimal: Channel['minimal']
  readonly activityEnabled: Channel['activityEnabled']
  readonly contextBarEnabled: Channel['contextBarEnabled']
  readonly contextSegments: Channel['contextSegments']
  readonly loadedContext: Channel['loadedContext']
  readonly pending: Channel['pending']
  readonly commandList: Channel['commandList']
  readonly mode: Channel['mode']
  readonly modeIndex: Channel['modeIndex']
  readonly pluginScene: Channel['pluginScene']
  readonly subagents: Channel['subagents']
  readonly goal: Channel['goal']
  readonly todos: Channel['todos']
  subscribe(listener: () => void): () => void
  listSessions(): ReturnType<Channel['listSessions']>
  settingsSections(): ReturnType<Channel['settingsSections']>
  subscribeSettingsSections(listener: () => void): () => void
  traceEvents(): ReturnType<Channel['traceEvents']>
}

/** Minimal subscribe/getSnapshot contract the four UI stores already
 *  implement (useSyncExternalStore-style, snapshots stable between emits). */
export interface SnapshotSource<T> {
  subscribe(listener: () => void): () => void
  getSnapshot(): T
}

export interface TuiControllerDeps {
  readonly channel: ChannelProjectionSource
  readonly questions: SnapshotSource<QuestionSnapshot | null>
  readonly approvals: SnapshotSource<ApprovalSnapshot | null> | undefined
  readonly dialogs: SnapshotSource<TuiDialogSnapshot | null> | undefined
  readonly status: SnapshotSource<readonly TuiStatusEntry[]> | undefined
  /** Shared with the command sink; `generation` is `TuiLifecycle.generation`. */
  readonly fences: TuiFences
}

const EMPTY_STATUS_ENTRIES: readonly TuiStatusEntry[] = []
const EMPTY_SESSIONS: readonly SessionSummary[] = []

export class TuiController {
  private readonly channel: ChannelProjectionSource
  private readonly questions: SnapshotSource<QuestionSnapshot | null>
  private readonly approvals: SnapshotSource<ApprovalSnapshot | null> | undefined
  private readonly dialogs: SnapshotSource<TuiDialogSnapshot | null> | undefined
  private readonly status: SnapshotSource<readonly TuiStatusEntry[]> | undefined
  private readonly fences: TuiFences

  private readonly listeners: Record<ViewModelSlice, Set<() => void>> = {
    chat: new Set(),
    sessions: new Set(),
    settings: new Set(),
    trajectory: new Set(),
    subagents: new Set(),
    overlays: new Set(),
  }
  private readonly unsubscribes: (() => void)[] = []
  private disposed = false

  /** Controller-owned sessions list (filled by the fenced refresh below). */
  private sessionsData: readonly SessionSummary[] = EMPTY_SESSIONS
  /** Store-sourced slice counters: the stores carry no version, so each
   *  notification bumps the counter the slice's meta.revision stamps from. */
  private overlaysRevision = 0
  private settingsRevision = 0

  private chatCache: ChatViewModel | undefined
  private transcriptCache: TranscriptProjection | undefined
  private statusLineCache: StatusLineProjection | undefined
  private spinnerCache: SpinnerProjection | undefined
  private headerCache: HeaderProjection | undefined
  private promptCache: PromptProjection | undefined
  private pluginSceneCache: PluginSceneProjection | undefined
  private overlaysCache: OverlayProjection | undefined
  private sessionsCache: SessionsProjection | undefined
  private settingsCache: SettingsSectionsProjection | undefined
  private trajectoryCache: TrajectoryProjection | undefined
  private subagentsCache: SubagentsProjection | undefined
  private goalTodoCache: GoalTodoProjection | undefined

  constructor(deps: TuiControllerDeps) {
    this.channel = deps.channel
    this.questions = deps.questions
    this.approvals = deps.approvals
    this.dialogs = deps.dialogs
    this.status = deps.status
    this.fences = deps.fences
    this.unsubscribes.push(
      this.channel.subscribe(() => this.onChannelNotify()),
      this.questions.subscribe(() => this.onStoreNotify()),
      this.channel.subscribeSettingsSections(() => this.onSettingsNotify()),
    )
    if (this.approvals !== undefined) {
      this.unsubscribes.push(this.approvals.subscribe(() => this.onStoreNotify()))
    }
    if (this.dialogs !== undefined) {
      this.unsubscribes.push(this.dialogs.subscribe(() => this.onStoreNotify()))
    }
    if (this.status !== undefined) {
      this.unsubscribes.push(this.status.subscribe(() => this.onStoreNotify()))
    }
  }

  /** Subscribe one slice; the listener pulls the getter itself (pull model).
   *  Returns the unsubscribe function. */
  subscribe(slice: ViewModelSlice, listener: () => void): () => void {
    const set = this.listeners[slice]
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  /** Unsubscribe everything; getters keep serving the last known state. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe()
    for (const set of Object.values(this.listeners)) set.clear()
  }

  getChat(): ChatViewModel {
    const channel = this.channel
    const transcript = this.transcriptProjection()
    const statusLine = this.statusLineProjection()
    const spinner = this.spinnerProjection()
    const header = this.headerProjection()
    const prompt = this.promptProjection()
    const overlays = this.getOverlays()
    const pluginScene = this.pluginSceneProjection()
    return (this.chatCache = this.project(
      this.chatCache,
      channel.version,
      (cached) =>
        cached.transcript === transcript &&
        cached.statusLine === statusLine &&
        cached.spinner === spinner &&
        cached.header === header &&
        cached.prompt === prompt &&
        cached.overlays === overlays &&
        cached.pluginScene === pluginScene &&
        cached.agentId === channel.agentId &&
        cached.cwd === channel.cwd &&
        cached.gitBranch === channel.gitBranch &&
        cached.provider === channel.provider &&
        cached.scrollGutter === channel.scrollGutter,
      (meta) => ({
        meta,
        transcript,
        statusLine,
        spinner,
        header,
        prompt,
        overlays,
        pluginScene,
        agentId: channel.agentId,
        cwd: channel.cwd,
        gitBranch: channel.gitBranch,
        provider: channel.provider,
        scrollGutter: channel.scrollGutter,
      }),
    ))
  }

  getSessions(): SessionsProjection {
    const channel = this.channel
    const sessions = this.sessionsData
    return (this.sessionsCache = this.project(
      this.sessionsCache,
      channel.version,
      (cached) =>
        cached.sessions === sessions &&
        cached.cwd === channel.cwd &&
        cached.gitBranch === channel.gitBranch &&
        cached.currentAgentId === channel.agentId,
      (meta) => ({
        meta,
        sessions,
        cwd: channel.cwd,
        gitBranch: channel.gitBranch,
        currentAgentId: channel.agentId,
      }),
    ))
  }

  getSettings(): SettingsSectionsProjection {
    const sections = this.channel.settingsSections()
    return (this.settingsCache = this.project(
      this.settingsCache,
      this.settingsRevision,
      (cached) =>
        cached.sections.length === sections.length &&
        cached.sections.every((section, index) => section === sections[index]),
      (meta) => ({ meta, sections }),
    ))
  }

  getTrajectory(): TrajectoryProjection {
    const events = this.channel.traceEvents()
    return (this.trajectoryCache = this.project(
      this.trajectoryCache,
      this.channel.version,
      (cached) => cached.events === events,
      (meta) => ({ meta, events }),
    ))
  }

  getSubagents(): SubagentsProjection {
    const items = this.channel.subagents
    return (this.subagentsCache = this.project(
      this.subagentsCache,
      this.channel.version,
      (cached) => cached.items === items,
      (meta) => ({ meta, items }),
    ))
  }

  /**
   * Goal/todo slice for the chat dock panel. The channel folds `goal/change`
   * and `todo/write` into fresh `goal`/`todos` references (never in-place),
   * so reference equality plus the working flag is the whole content check.
   */
  getGoalTodo(): GoalTodoProjection {
    const channel = this.channel
    return (this.goalTodoCache = this.project(
      this.goalTodoCache,
      channel.version,
      (cached) =>
        cached.goal === channel.goal &&
        cached.todos === channel.todos &&
        cached.working === channel.working,
      (meta) => ({
        meta,
        goal: channel.goal,
        todos: channel.todos,
        working: channel.working,
      }),
    ))
  }

  getOverlays(): OverlayProjection {
    const question = this.questions.getSnapshot()
    const approval = this.approvals?.getSnapshot() ?? null
    const dialog = this.dialogs?.getSnapshot() ?? null
    const statusEntries = this.status?.getSnapshot() ?? EMPTY_STATUS_ENTRIES
    return (this.overlaysCache = this.project(
      this.overlaysCache,
      this.overlaysRevision,
      (cached) =>
        cached.question === question &&
        cached.approval === approval &&
        cached.dialog === dialog &&
        cached.statusEntries === statusEntries,
      (meta) => ({ meta, question, approval, dialog, statusEntries }),
    ))
  }

  /**
   * The controller-owned async read: load the sessions list through the same
   * sessionEpoch/generation fence the command sink applies, and only then
   * write it into the sessions projection. A stale result is dropped (and
   * logged), leaving the projection at its previous content.
   */
  async refreshSessions(): Promise<readonly SessionSummary[] | undefined> {
    const epoch = this.fences.sessionEpoch()
    const generation = this.fences.generation()
    const stale = (): boolean => this.fences.sessionEpoch() !== epoch || this.fences.generation() !== generation
    let sessions: readonly SessionSummary[]
    try {
      sessions = await this.channel.listSessions()
    } catch (error) {
      if (!stale()) throw error
      logForDebugging('sessions refresh failure dropped (stale fences)', { epoch, generation })
      return undefined
    }
    if (stale()) {
      logForDebugging('sessions refresh result dropped (stale fences)', { epoch, generation })
      return undefined
    }
    this.sessionsData = sessions
    this.dispatch('sessions')
    return sessions
  }

  private transcriptProjection(): TranscriptProjection {
    const rows = this.channel.rows
    const version = this.channel.version
    return (this.transcriptCache = this.project(
      this.transcriptCache,
      version,
      // `rows` is an IN-PLACE mutable array: emit()/emitStream() bump only
      // the version while rows are appended (and streaming row text grown)
      // through the same reference, so `cached.rows === rows` alone can
      // never detect a content change. The cache is stale whenever the
      // version moved past the cached revision; within one version,
      // repeated pulls still reuse the projection.
      (cached) => cached.rows === rows && cached.meta.revision === version,
      (meta) => ({ meta, rows }),
    ))
  }

  private statusLineProjection(): StatusLineProjection {
    const channel = this.channel
    return (this.statusLineCache = this.project(
      this.statusLineCache,
      channel.version,
      (cached) =>
        cached.minimal === channel.minimal &&
        cached.statusBar === channel.statusBar &&
        cached.lastUsage === channel.lastUsage &&
        cached.reasoningEffort === channel.reasoningEffort &&
        cached.mode === channel.mode &&
        cached.modeIndex === channel.modeIndex &&
        cached.contextWindow === channel.contextWindow &&
        cached.tps === channel.tps &&
        cached.tpsSamples === channel.tpsSamples &&
        cached.model === channel.model &&
        cached.tokens === channel.tokens &&
        cached.gitBranch === channel.gitBranch &&
        cached.displayCwd === channel.displayCwd &&
        cached.sessionTitle === channel.sessionTitle &&
        cached.agentId === channel.agentId &&
        cached.working === channel.working &&
        cached.workingActivity === channel.workingActivity &&
        cached.activityFrames === channel.activityFrames &&
        cached.contextBarEnabled === channel.contextBarEnabled &&
        cached.contextSegments === channel.contextSegments,
      (meta) => ({
        meta,
        minimal: channel.minimal,
        statusBar: channel.statusBar,
        lastUsage: channel.lastUsage,
        reasoningEffort: channel.reasoningEffort,
        mode: channel.mode,
        modeIndex: channel.modeIndex,
        contextWindow: channel.contextWindow,
        tps: channel.tps,
        tpsSamples: channel.tpsSamples,
        model: channel.model,
        tokens: channel.tokens,
        gitBranch: channel.gitBranch,
        displayCwd: channel.displayCwd,
        sessionTitle: channel.sessionTitle,
        agentId: channel.agentId,
        working: channel.working,
        workingActivity: channel.workingActivity,
        activityFrames: channel.activityFrames,
        contextBarEnabled: channel.contextBarEnabled,
        contextSegments: channel.contextSegments,
      }),
    ))
  }

  private spinnerProjection(): SpinnerProjection {
    const channel = this.channel
    return (this.spinnerCache = this.project(
      this.spinnerCache,
      channel.version,
      (cached) =>
        cached.working === channel.working &&
        cached.spinnerMode === channel.spinnerMode &&
        cached.responseChars === channel.responseChars &&
        cached.turnStart === channel.turnStart &&
        cached.activeToolCount === channel.activeToolCount &&
        cached.workingActivity === channel.workingActivity &&
        cached.activityFrames === channel.activityFrames &&
        cached.activityEnabled === channel.activityEnabled &&
        cached.minimal === channel.minimal &&
        cached.lastUsage === channel.lastUsage,
      (meta) => ({
        meta,
        working: channel.working,
        spinnerMode: channel.spinnerMode,
        responseChars: channel.responseChars,
        turnStart: channel.turnStart,
        activeToolCount: channel.activeToolCount,
        workingActivity: channel.workingActivity,
        activityFrames: channel.activityFrames,
        activityEnabled: channel.activityEnabled,
        minimal: channel.minimal,
        lastUsage: channel.lastUsage,
      }),
    ))
  }

  private headerProjection(): HeaderProjection {
    const channel = this.channel
    return (this.headerCache = this.project(
      this.headerCache,
      channel.version,
      (cached) =>
        cached.whale === channel.whale &&
        cached.model === channel.model &&
        cached.reasoningEffort === channel.reasoningEffort &&
        cached.displayCwd === channel.displayCwd &&
        cached.loadedContext === channel.loadedContext,
      (meta) => ({
        meta,
        whale: channel.whale,
        model: channel.model,
        reasoningEffort: channel.reasoningEffort,
        displayCwd: channel.displayCwd,
        loadedContext: channel.loadedContext,
      }),
    ))
  }

  private promptProjection(): PromptProjection {
    const channel = this.channel
    return (this.promptCache = this.project(
      this.promptCache,
      channel.version,
      (cached) =>
        cached.pending === channel.pending &&
        cached.notifications === channel.notifications &&
        cached.commandList === channel.commandList &&
        cached.reasoningEffort === channel.reasoningEffort &&
        cached.effortLevels === channel.effortLevels &&
        cached.working === channel.working &&
        cached.mode === channel.mode,
      (meta) => ({
        meta,
        pending: channel.pending,
        notifications: channel.notifications,
        commandList: channel.commandList,
        reasoningEffort: channel.reasoningEffort,
        effortLevels: channel.effortLevels,
        working: channel.working,
        mode: channel.mode,
      }),
    ))
  }

  private pluginSceneProjection(): PluginSceneProjection {
    const active = this.channel.pluginScene
    return (this.pluginSceneCache = this.project(
      this.pluginSceneCache,
      this.channel.version,
      (cached) =>
        // Compared by identity fields, not descriptor reference: the
        // projection deliberately hides the descriptor (WP-04 swaps its
        // shape), and a same-id/same-title swap is not a visible change.
        active === undefined
          ? cached.active === undefined
          : cached.active !== undefined && cached.active.id === active.id && cached.active.title === active.title,
      (meta) => ({
        meta,
        active: active === undefined ? undefined : { id: active.id, title: active.title },
      }),
    ))
  }

  /**
   * Rebuild-or-reuse core for every projection. `unchanged` compares CONTENT
   * fields against the cache (references for arrays/objects); `revision` is
   * the source's current version, stamped only when content moved. When
   * content is unchanged but a fence (sessionEpoch/generation) moved, the
   * projection is rebuilt with refreshed fence stamps and the SAME revision.
   */
  private project<P extends { readonly meta: ProjectionMeta }>(
    cached: P | undefined,
    revision: number,
    unchanged: (cached: P) => boolean,
    build: (meta: ProjectionMeta) => P,
  ): P {
    const sessionEpoch = this.channel.sessionEpoch
    const generation = this.fences.generation()
    if (cached !== undefined && unchanged(cached)) {
      if (cached.meta.sessionEpoch === sessionEpoch && cached.meta.generation === generation) return cached
      return build({ revision: cached.meta.revision, sessionEpoch, generation })
    }
    return build({ revision, sessionEpoch, generation })
  }

  private onChannelNotify(): void {
    // 'chat' embeds only channel slices here; the store-driven overlay half
    // arrives through onStoreNotify.
    this.dispatch('chat', 'sessions', 'trajectory', 'subagents')
  }

  private onStoreNotify(): void {
    this.overlaysRevision += 1
    // 'chat' fires too: ChatViewModel embeds the overlay projection.
    this.dispatch('overlays', 'chat')
  }

  private onSettingsNotify(): void {
    this.settingsRevision += 1
    this.dispatch('settings')
  }

  /** Synchronous, unbatched dispatch; one listener runs once per round even
   *  when it subscribed to several of the dispatched slices. */
  private dispatch(...slices: readonly ViewModelSlice[]): void {
    const called = new Set<() => void>()
    for (const slice of slices) {
      for (const listener of this.listeners[slice]) called.add(listener)
    }
    for (const listener of called) listener()
  }
}
