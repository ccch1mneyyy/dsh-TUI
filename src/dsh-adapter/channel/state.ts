import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionModeSpec } from '../../sessionModes.js'
import { normalizeJobGroupFold, normalizePageMargin, normalizeScrollGutter, normalizeStatusBar, normalizeToolBackground, type JobGroupFoldMode, type PageMarginSetting, type ScrollGutterMode, type StatusBarConfig, type ToolBackground } from '../../tuiDisplayPrefs.js'
import { normalizeActivityPreset } from '../../components/activityFrames.js'
import { normalizeSplashFont, type SplashFontSetting } from '../../components/splashFonts.js'
import type { ChannelState } from './types.js'

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
  activityFrames?: string
  /** Settings namespace this boot registered its section under: the Config
   *  owner's Loader id (`resolveSettingsNamespace`), which is NOT always the
   *  plugin name. Read sites look the TUI's section up by it, so passing the
   *  literal `'dsh-tui'` here would silently miss custom mounts. Absent →
   *  `'dsh-tui'` (direct `createChannel` embedders and fixtures). */
  settingsNs?: string
  diffLayout?: 'auto' | 'split' | 'unified'
  thinkingFold?: 'preview' | 'full'
  jobGroupFold?: JobGroupFoldMode
  toolBackground?: ToolBackground
  scrollGutter?: ScrollGutterMode
  pageMargin?: PageMarginSetting
  foldTerminalCommand?: boolean
  promptSessionLabel?: boolean
  expandEditor?: boolean
  smoothStreaming?: boolean
  statusBar?: Partial<StatusBarConfig>
  whale?: boolean
  whaleIdle?: boolean
  /** Big-text face (settings `dsh-tui.splashFont`); absent → `daily`, the
   *  date rotation. Junk normalizes to `daily` (see `normalizeSplashFont`). */
  splashFont?: SplashFontSetting
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
  'effortLevels' | 'version' | 'rows' | 'status' | 'sessionTitle' | 'sessionColor' |
  'agentId' | 'sessionId' | 'agentBindingGeneration' | 'model' | 'provider' | 'tokens' | 'cwd' |
  'displayCwd' | 'gitBranch' | 'working' | 'compaction' | 'cancelPending' | 'spinnerMode' |
  'responseChars' | 'activeToolCount' | 'turnStart' | 'lastUserText' |
  'notifications' | 'contextWindow' | 'reasoningEffort' | 'mode' | 'modeIndex' |
  'activityFrames' | 'configuredProvider' | 'configuredModel' |
  'configuredPreset' | 'configuredActivityFrames' | 'configuredLang' | 'diffLayout' |
  'thinkingFold' | 'jobGroupFold' | 'toolBackground' | 'scrollGutter' | 'pageMargin' |
  'foldTerminalCommand' | 'promptSessionLabel' | 'expandEditor' | 'smoothStreaming' |
  'statusBar' | 'whale' | 'whaleIdle' | 'splashFont' | 'minimalUi' | 'activityEnabled' | 'contextBarEnabled' |
  'statusBar' | 'whale' | 'whaleIdle' | 'whaleGirl' | 'minimalUi' | 'activityEnabled' | 'contextBarEnabled' |
  'agentPreset' | 'goal' | 'todos' | 'loadedContext' | 'pending' | 'commandList' |
  'lastUsage' | 'tps' | 'tpsSamples' | 'contextSegments' | 'mainCost' | 'subagentCost' | 'subagents' | 'backgroundJobs' | 'selection'
> {
  return {
    effortLevels: undefined, version: 0, rows: [], selection: undefined, status: 'starting', sessionTitle: '', sessionColor: '',
    agentId: input.agentId, sessionId: input.sessionId, agentBindingGeneration: 0, model: options.model, provider: options.provider,
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
    promptSessionLabel: options.promptSessionLabel === true, expandEditor: options.expandEditor !== false,
    smoothStreaming: options.smoothStreaming !== false, statusBar: normalizeStatusBar(options.statusBar),
    whale: options.whale !== false, whaleIdle: options.whaleIdle !== false, whaleGirl: options.whaleGirl === true, splashFont: normalizeSplashFont(options.splashFont), minimalUi: options.minimalUi === true, activityEnabled: options.activity !== false,
    contextBarEnabled: options.contextBar !== false, agentPreset: options.agentPreset, goal: undefined,
    todos: [], loadedContext: undefined, pending: [], commandList: [], lastUsage: undefined,
    tps: undefined, tpsSamples: [], contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    // 费用估算输入：主会话按模型分桶 + 子代理快照。与 tokens 并行累计，
    // tokens 的既有语义/显示不变（DESIGN D2）。
    mainCost: {}, subagentCost: [],
    subagents: [], backgroundJobs: [],
  }
}
