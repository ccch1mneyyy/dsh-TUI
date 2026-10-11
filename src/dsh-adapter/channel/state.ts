import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { OpenTarget, SessionCatalog } from '../../agent/backend.js'
import type { AgentEvent } from '../../agent/events.js'
import type { AgentSession } from '../../agent/session.js'
import type { PermissionStore } from '../../channel/permissions.js'
import type { QuestionStoreLike } from '../../channel/questions.js'
import type { ContextPressureSource } from '../context-occupancy.js'
import type { ActivityView } from '../activity-store.js'
import type { SessionModeSpec } from '../../sessionModes.js'
import { normalizeJobGroupFold, normalizePageMargin, normalizeScrollGutter, normalizeStatusBar, normalizeToolBackground, type JobGroupFoldMode, type PageMarginSetting, type ScrollGutterMode, type StatusBarConfig, type ToolBackground } from '../../tuiDisplayPrefs.js'
import { normalizeActivityPreset } from '../../components/activityFrames.js'
import { normalizeSplashFont, type SplashFontSetting } from '../../components/splashFonts.js'
import { normalizeBrandSetting, type BrandSetting } from '../../branding.js'
import type { ChannelState } from './types.js'

/** The DSH backend's user-facing name (capability snapshot default). */
export const DSH_BACKEND_LABEL = 'DSH'

/** The settled startup open (`ChannelLaunchOptions.startup`). */
export interface ChannelStartup {
  readonly session: AgentSession
  readonly history: readonly AgentEvent[]
  readonly route?: { readonly provider: string; readonly model: string }
  readonly agentPreset?: string
}

/**
 * A startup open that failed for a reason `/new` cannot fix (the in-process
 * DSH kernel's composition failed: there is no DSH to open a session on).
 * Its `hint` replaces the failure row's `/new` hint (`startup-open-failed-hint`).
 */
export class StartupOpenError extends Error {
  constructor(message: string, readonly hint: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StartupOpenError'
  }
}

/** Launch configuration belongs to channel construction, not the composition root. */
export interface ChannelLaunchOptions {
  model: string
  cwd: string
  provider: string
  effort?: string
  activity?: boolean
  /** Read the activity projection's current value when a session binds. A
   *  projection value only arrives on change, so a resumed session needs this
   *  read to render its line before the next event lands. */
  seedActivity?: (session: unknown) => void
  /** Land one backend-authored working-activity value for the bound session
   *  (the Claude backend's counterpart of the projection feed: the session's
   *  `workingActivity` capability, wired per binding in
   *  `channel/session-activity.ts`). Values are narrowed (`asActivityView`)
   *  before this is called; absent → the capability is not consumed. */
  publishActivity?: (sessionId: string, view: ActivityView) => void
  /** Drop the bound session's backend-authored working-activity value (its
   *  session went away: the next binding, or the channel's release). */
  clearActivity?: (sessionId: string) => void
  /**
   * Official context-occupancy source (see `dsh-adapter/context-occupancy.ts`).
   *
   * `read` is a cached map lookup — never a projection fold — so the channel's
   * `contextOccupancy` accessor may call it per read; `subscribe` is the
   * projection's own change feed, which republishes occupancy when it moves
   * between session events (a compaction rewriting the surface, the prompt
   * growing). Absent → the channel falls back to the last request's billed
   * sample, which is what a composition without the token meter must do.
   */
  contextPressure?: ContextPressureSource
  /** Read that source's current value when a session binds (see
   *  {@link ChannelLaunchOptions.contextPressure}). */
  seedContextOccupancy?: (session: unknown) => void
  activityFrames?: string
  /** Settings namespace this boot registered its section under: the Config
   *  owner's Loader id (`resolveSettingsNamespace`), which is NOT always the
   *  plugin name. Read sites look the TUI's section up by it, so passing the
   *  literal `'dsh-tui'` here would silently miss custom mounts. Absent →
   *  `'dsh-tui'` (direct `createChannel` embedders and fixtures). */
  settingsNs?: string
  diffLayout?: 'auto' | 'split' | 'unified'
  /** Seed the upstream auto-retry policy (upstream-retry.ts) on the
   *  llm-pi-ai route the bound session actually uses, when that route
   *  declares no retryPolicy. Absent means enabled (the Config schema's
   *  default); false opts out without touching settings. */
  upstreamRetry?: boolean
  thinkingFold?: 'preview' | 'full'
  jobGroupFold?: JobGroupFoldMode
  toolBackground?: ToolBackground
  scrollGutter?: ScrollGutterMode
  pageMargin?: PageMarginSetting
  foldTerminalCommand?: boolean
  turnUsageRow?: boolean
  promptSessionLabel?: boolean
  expandEditor?: boolean
  smoothStreaming?: boolean
  statusBar?: Partial<StatusBarConfig>
  whale?: boolean
  whaleIdle?: boolean
  /** Big-text face (settings `dsh-tui.splashFont`); absent → `daily`, the
   *  date rotation. Junk normalizes to `daily` (see `normalizeSplashFont`). */
  splashFont?: SplashFontSetting
  /** Brand look (settings `dsh-tui.brand`); absent → `auto` (follow the
   *  active backend). Junk normalizes to `auto` (see `normalizeBrandSetting`). */
  brand?: BrandSetting
  /** Maid portrait for the header splash (settings `dsh-tui.whaleGirl`;
   * off by default). */
  whaleGirl?: boolean
  /** Minimal UI (settings key `dsh-tui.minimal`, 极简界面 / "Minimal UI"):
   *  purely a decoration switch. NOT the kernel agent preset `minimal`. */
  minimalUi?: boolean
  contextBar?: boolean
  configuredPreset?: string
  configuredProvider?: string
  configuredModel?: string
  configuredLang?: string
  configuredActivityFrames?: string
  agentPreset?: string
  modes?: readonly SessionModeSpec[]
  /** User-facing name of the backend serving the session (capability
   *  snapshot, `cmd-unavailable-backend`); absent → the DSH label. */
  backendLabel?: string
  /**
   * Open a session of the bound session's own backend: a fresh one (`/new`
   * on a non-DSH session) or a persisted one (`/resume`, the session
   * browser, a conversation rewind's fork). Absent → those are unavailable
   * there. DSH sessions keep their own resume/new orchestration and ignore
   * it.
   */
  openSession?: (target: Extract<OpenTarget, { readonly kind: 'create' | 'resume' }>) => Promise<AgentSession>
  /**
   * The backend's offline session catalog: the session browser's
   * listing, preview, rename and delete for a non-DSH session.
   * With `openSession` it enables `/resume`. DSH sessions ignore it.
   */
  sessionCatalog?: SessionCatalog
  /**
   * The backend's session preferences (TUI-side notes only, never the
   * transcripts): the MRU note of each use, the launcher's
   * last-session marker, and forgetting a deleted session.
   */
  sessionPrefs?: {
    touch(sessionId: string): void
    setLastSession(sessionId: string): void
    forget(sessionId: string): void
  }
  /** The startup session's durable history, read before construction so
   *  the first bind paints it ahead of any live event. */
  initialHistory?: readonly AgentEvent[]
  /** The `/settings` service (../tui-settings.ts); absent → the host's `settings`. */
  settingsService?: unknown
  /**
   * The startup session still opening: the channel starts on a placeholder
   * (`ready` false) and `start()` adopts the real one once this settles; a
   * rejection stays on the placeholder and `/new` retries. `route`/`agentPreset` override the construction options.
   */
  startup?: Promise<ChannelStartup>
  /** How a user re-enters a session of this backend from a shell (the
   *  `/fork` notice); absent → the in-TUI `/resume` hint. */
  resumeCommand?: (sessionId: string) => string
  /**
   * The stores a non-DSH session's prompts park in: its
   * `permission.request` events go to `permissions` (the panel Chat renders
   * for this channel), its `question.request` events to `questions`. Absent →
   * such events are dropped (a backend that declares no prompt capability).
   * DSH sessions answer through their own seams and ignore it.
   */
  interaction?: { readonly permissions: PermissionStore; readonly questions: QuestionStoreLike }
  /** Lifetime handle of the agent when `createChannel` receives a raw DSH
   *  agent (direct embedders, fixtures); a passed `AgentSession` carries its
   *  own and this is ignored. */
  handle?: AgentHandle
}

/**
 * Neutral observable fields only. Behaviour is assembled explicitly by the
 * composition root after each specialist owner exists, so this factory cannot
 * acquire services, subscribe, or create a second authority bag.
 */
export function createInitialChannelView(
  options: ChannelLaunchOptions,
  input: { agentId: string; sessionId: string; mode: ChannelState['mode']; cwdDescription: string },
): Pick<ChannelState,
  'effortLevels' | 'version' | 'ready' | 'startupFailure' | 'rows' | 'status' | 'sessionTitle' | 'sessionColor' |
  'agentId' | 'sessionId' | 'agentBindingGeneration' | 'model' | 'modelDisplay' | 'provider' | 'tokens' | 'cwd' |
  'displayCwd' | 'gitBranch' | 'working' | 'compaction' | 'cancelPending' | 'spinnerMode' |
  'responseChars' | 'activeToolCount' | 'turnStart' | 'lastUserText' |
  'notifications' | 'contextWindow' | 'reasoningEffort' | 'mode' | 'modeIndex' |
  'activityFrames' | 'configuredProvider' | 'configuredModel' |
  'configuredPreset' | 'configuredActivityFrames' | 'configuredLang' | 'diffLayout' |
  'thinkingFold' | 'jobGroupFold' | 'toolBackground' | 'scrollGutter' | 'pageMargin' |
  'foldTerminalCommand' | 'turnUsageRow' | 'promptSessionLabel' | 'expandEditor' | 'smoothStreaming' |
  'statusBar' | 'whale' | 'whaleIdle' | 'splashFont' | 'brand' | 'minimalUi' | 'activityEnabled' | 'contextBarEnabled' |
  'statusBar' | 'whale' | 'whaleIdle' | 'whaleGirl' | 'minimalUi' | 'activityEnabled' | 'contextBarEnabled' |
  'agentPreset' | 'goal' | 'todos' | 'loadedContext' | 'pending' | 'commandList' |
  'lastUsage' | 'turnUsage' | 'tps' | 'tpsSamples' | 'contextSegments' | 'mainCost' | 'subagentCost' | 'subagents' | 'backgroundJobs' | 'selection'
> {
  return {
    effortLevels: undefined, version: 0, ready: options.startup === undefined, startupFailure: undefined, rows: [], selection: undefined, status: 'starting', sessionTitle: '', sessionColor: '',
    agentId: input.agentId, sessionId: input.sessionId, agentBindingGeneration: 0, model: options.model, modelDisplay: undefined, provider: options.provider,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    cwd: options.cwd, displayCwd: input.cwdDescription, gitBranch: undefined, working: false,
    compaction: undefined,
    cancelPending: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0,
    turnStart: 0, lastUserText: '', notifications: [], contextWindow: undefined,
    reasoningEffort: options.effort, mode: input.mode, modeIndex: 0,
    activityFrames: normalizeActivityPreset(options.activityFrames), configuredProvider: options.configuredProvider,
    configuredModel: options.configuredModel, configuredPreset: options.configuredPreset,
    configuredActivityFrames: options.configuredActivityFrames, configuredLang: options.configuredLang,
    diffLayout: options.diffLayout ?? 'auto', thinkingFold: options.thinkingFold ?? 'preview',
    jobGroupFold: normalizeJobGroupFold(options.jobGroupFold),
    toolBackground: normalizeToolBackground(options.toolBackground), scrollGutter: normalizeScrollGutter(options.scrollGutter),
    pageMargin: normalizePageMargin(options.pageMargin), foldTerminalCommand: options.foldTerminalCommand === true,
    turnUsageRow: options.turnUsageRow === true,
    promptSessionLabel: options.promptSessionLabel === true, expandEditor: options.expandEditor !== false,
    smoothStreaming: options.smoothStreaming !== false, statusBar: normalizeStatusBar(options.statusBar),
    whale: options.whale !== false, whaleIdle: options.whaleIdle !== false, whaleGirl: options.whaleGirl === true, splashFont: normalizeSplashFont(options.splashFont), brand: normalizeBrandSetting(options.brand), minimalUi: options.minimalUi === true, activityEnabled: options.activity !== false,
    contextBarEnabled: options.contextBar !== false, agentPreset: options.agentPreset, goal: undefined,
    todos: [], loadedContext: undefined, pending: [], commandList: [], lastUsage: undefined, turnUsage: undefined,
    tps: undefined, tpsSamples: [], contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    // 费用估算输入：主会话按模型分桶 + 子代理快照。与 tokens 并行累计，
    // tokens 的既有语义/显示不变（DESIGN D2）。
    mainCost: {}, subagentCost: [],
    subagents: [], backgroundJobs: [],
  }
}
