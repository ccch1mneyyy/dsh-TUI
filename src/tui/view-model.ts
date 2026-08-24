/**
 * Bounded readonly projections over the business channel and the UI stores
 * (plan §1.3, WP-02).
 *
 * `src/dsh-adapter/channel.ts` stays the single mutable business store — this
 * module declares ONLY types. There is no global `TuiSnapshot`: every screen
 * or overlay reads a bounded projection holding just the fields its UI needs
 * (the field lists mirror the WP-02 consumption matrices), each stamped with
 * a {@link ProjectionMeta} triple:
 *
 * - `revision` — the source version at which this projection's CONTENT last
 *   changed (the channel `version` for channel-sourced slices, a store
 *   counter for store-sourced ones). Unrelated source bumps reuse the
 *   previous projection object (structural sharing), so a moved `revision`
 *   always means a field this slice reads actually changed.
 * - `sessionEpoch` — the channel's session/agent replacement counter; it
 *   tells projections built before a /new, /resume, /model or rewind swap
 *   apart from ones built after.
 * - `generation` — the TUI lifecycle generation (`TuiLifecycle.generation`),
 *   bumped on every quiesce/resume cycle.
 *
 * Array/object fields are SHARED BY REFERENCE with the channel — never
 * deep-copied per tick. Some channel cells mutate in place (`tokens`,
 * `tpsSamples`, `notifications`), so projection identity and `revision` only
 * track reference-level change; consumers re-read field VALUES on every
 * notification rather than memoizing scalars off a shared cell.
 *
 * Field types are indexed access off `Channel` wherever the projection
 * mirrors the channel verbatim, so this contract cannot drift from the
 * store's own types.
 */
import type { Channel, ChatRow, SubagentState } from '../dsh-adapter/channel.js'
import type { ApprovalSnapshot } from '../dsh-adapter/approvals.js'
import type { TuiDialogSnapshot } from '../dsh-adapter/dialogs.js'
import type { QuestionSnapshot } from '../dsh-adapter/questions.js'
import type { SessionSummary } from '../dsh-adapter/sessions/types.js'
import type { TuiSettingsSection } from '../dsh-adapter/settings-sections.js'
import type { TuiStatusEntry } from '../dsh-adapter/status.js'
import type { AdapterSessionEvent as SessionEvent } from '../dsh-adapter/channel.js'

/** Freshness/fence stamps every projection carries (see module header). */
export interface ProjectionMeta {
  readonly revision: number
  readonly sessionEpoch: number
  readonly generation: number
}

/** Transcript slice (MessageList): the row list, shared by reference. */
export interface TranscriptProjection {
  readonly meta: ProjectionMeta
  readonly rows: readonly ChatRow[]
}

/** StatusLine slice — the footer reads exactly these channel fields. */
export interface StatusLineProjection {
  readonly meta: ProjectionMeta
  readonly minimal: Channel['minimal']
  readonly statusBar: Channel['statusBar']
  readonly lastUsage: Channel['lastUsage']
  readonly reasoningEffort: Channel['reasoningEffort']
  readonly mode: Channel['mode']
  readonly modeIndex: Channel['modeIndex']
  readonly contextWindow: Channel['contextWindow']
  readonly tps: Channel['tps']
  readonly tpsSamples: Channel['tpsSamples']
  readonly model: Channel['model']
  readonly tokens: Channel['tokens']
  readonly gitBranch: Channel['gitBranch']
  readonly displayCwd: Channel['displayCwd']
  readonly sessionTitle: Channel['sessionTitle']
  readonly agentId: Channel['agentId']
  readonly working: Channel['working']
  readonly workingActivity: Channel['workingActivity']
  readonly activityFrames: Channel['activityFrames']
  readonly contextBarEnabled: Channel['contextBarEnabled']
  readonly contextSegments: Channel['contextSegments']
}

/** WorkingSpinner / activity-line slice. */
export interface SpinnerProjection {
  readonly meta: ProjectionMeta
  readonly working: Channel['working']
  readonly spinnerMode: Channel['spinnerMode']
  readonly responseChars: Channel['responseChars']
  readonly turnStart: Channel['turnStart']
  readonly activeToolCount: Channel['activeToolCount']
  readonly workingActivity: Channel['workingActivity']
  readonly activityFrames: Channel['activityFrames']
  readonly activityEnabled: Channel['activityEnabled']
  readonly minimal: Channel['minimal']
  readonly lastUsage: Channel['lastUsage']
}

/** LogoHeader slice. */
export interface HeaderProjection {
  readonly meta: ProjectionMeta
  readonly whale: Channel['whale']
  readonly model: Channel['model']
  readonly reasoningEffort: Channel['reasoningEffort']
  readonly displayCwd: Channel['displayCwd']
  readonly loadedContext: Channel['loadedContext']
}

/** PromptInput slice — queued messages, the notification toast and the
 *  slash-command/effort adornments the input border renders. */
export interface PromptProjection {
  readonly meta: ProjectionMeta
  readonly pending: Channel['pending']
  readonly notifications: Channel['notifications']
  readonly commandList: Channel['commandList']
  readonly reasoningEffort: Channel['reasoningEffort']
  readonly effortLevels: Channel['effortLevels']
  readonly working: Channel['working']
  readonly mode: Channel['mode']
}

/** Store-sourced overlay slice: one pending question / approval / plugin
 *  dialog at a time, plus the keyed status-line contributions. Snapshots are
 *  referentially stable between store mutations (useSyncExternalStore
 *  contract of the underlying stores). */
export interface OverlayProjection {
  readonly meta: ProjectionMeta
  readonly question: QuestionSnapshot | null
  readonly approval: ApprovalSnapshot | null
  readonly dialog: TuiDialogSnapshot | null
  readonly statusEntries: readonly TuiStatusEntry[]
}

/** Subagent dashboard/detail slice. */
export interface SubagentsProjection {
  readonly meta: ProjectionMeta
  readonly items: readonly SubagentState[]
}

/**
 * GoalTodoPanel slice: the durable goal projection plus the latest
 * whole-list todo snapshot and the working flag the fold rules read. Pulled
 * through `TuiController.getGoalTodo()` (the same standalone-getter pattern
 * as {@link SubagentsProjection}) instead of riding {@link ChatViewModel}, so
 * the composed chat contract stays stable for hosts that never mount the
 * panel.
 */
export interface GoalTodoProjection {
  readonly meta: ProjectionMeta
  readonly goal: Channel['goal']
  readonly todos: Channel['todos']
  readonly working: Channel['working']
}

/**
 * Plugin-scene slice. The imperative descriptor stays host-side, so the
 * projection carries only identity fields — enough for the chat screen to
 * reconcile the active scene without exposing the descriptor to components.
 */
export interface PluginSceneProjection {
  readonly meta: ProjectionMeta
  readonly active: { readonly id: string; readonly title?: string } | undefined
}

/** Session-browser slice: the controller-loaded list plus the channel
 *  context the browser's `buildView` filters on. `sessions` starts empty;
 *  the controller fills it via its fenced async refresh. */
export interface SessionsProjection {
  readonly meta: ProjectionMeta
  readonly sessions: readonly SessionSummary[]
  readonly cwd: Channel['cwd']
  readonly gitBranch: Channel['gitBranch']
  readonly currentAgentId: Channel['agentId']
}

/** Settings slice: the plugin-declared sections (the panel's own field/write
 *  helpers stay in `src/dsh-adapter/settingsEditor.ts`). */
export interface SettingsSectionsProjection {
  readonly meta: ProjectionMeta
  readonly sections: readonly TuiSettingsSection[]
}

/** Trajectory slice: the immutable session-event snapshot; the screen folds
 *  it incrementally via the existing `trajectory/projection.ts` helpers. */
export interface TrajectoryProjection {
  readonly meta: ProjectionMeta
  readonly events: readonly SessionEvent[]
}

/** The chat main screen's composed view: its slices by reference plus the
 *  handful of scalars the screen itself reads (`/status`, pickers, the
 *  fullscreen scroll-gutter preference). */
export interface ChatViewModel {
  readonly meta: ProjectionMeta
  readonly transcript: TranscriptProjection
  readonly statusLine: StatusLineProjection
  readonly spinner: SpinnerProjection
  readonly header: HeaderProjection
  readonly prompt: PromptProjection
  readonly overlays: OverlayProjection
  readonly pluginScene: PluginSceneProjection
  readonly agentId: Channel['agentId']
  readonly cwd: Channel['cwd']
  readonly gitBranch: Channel['gitBranch']
  readonly provider: Channel['provider']
  readonly scrollGutter: Channel['scrollGutter']
}

/** Subscription granularity of the TuiController: one listener set per
 *  slice. `chat` additionally fires on overlay-store changes because
 *  {@link ChatViewModel} embeds the overlay projection. */
export type ViewModelSlice = 'chat' | 'sessions' | 'settings' | 'trajectory' | 'subagents' | 'overlays'
