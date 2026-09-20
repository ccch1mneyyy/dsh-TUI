import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionModeSpec } from '../../sessionModes.js'
import { normalizePageMargin, normalizeScrollGutter, normalizeStatusBar, normalizeToolBackground, type PageMarginSetting, type ScrollGutterMode, type StatusBarConfig, type ToolBackground } from '../../tuiDisplayPrefs.js'
import { normalizeActivityPreset } from '../../components/activityFrames.js'
import type { ChannelState } from './types.js'

/** Launch configuration belongs to channel construction, not the composition root. */
export interface ChannelLaunchOptions {
  model: string
  cwd: string
  provider: string
  effort?: string
  activity?: boolean
  activityFrames?: string
  diffLayout?: 'auto' | 'split' | 'unified'
  thinkingFold?: 'preview' | 'full'
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
  minimal?: boolean
  contextBar?: boolean
  configuredPreset?: string
  configuredProvider?: string
  configuredModel?: string
  configuredLang?: string
  configuredActivityFrames?: string
  agentPreset?: string
  modes?: readonly SessionModeSpec[]
  handle?: AgentHandle
}

/**
 * Neutral observable fields only. Behaviour is assembled explicitly by the
 * composition root after each specialist owner exists, so this factory cannot
 * acquire services, subscribe, or create a second authority bag.
 */
export function createInitialChannelView(
  options: ChannelLaunchOptions,
  input: { agentId: string; mode: ChannelState['mode']; cwdDescription: string },
): Pick<ChannelState,
  'effortLevels' | 'version' | 'rows' | 'status' | 'sessionTitle' | 'sessionColor' |
  'agentId' | 'agentBindingGeneration' | 'model' | 'provider' | 'tokens' | 'cwd' |
  'displayCwd' | 'gitBranch' | 'working' | 'cancelPending' | 'spinnerMode' |
  'responseChars' | 'activeToolCount' | 'turnStart' | 'lastUserText' |
  'notifications' | 'contextWindow' | 'reasoningEffort' | 'mode' | 'modeIndex' |
  'workingActivity' | 'activityFrames' | 'configuredProvider' | 'configuredModel' |
  'configuredPreset' | 'configuredActivityFrames' | 'configuredLang' | 'diffLayout' |
  'thinkingFold' | 'toolBackground' | 'scrollGutter' | 'pageMargin' |
  'foldTerminalCommand' | 'promptSessionLabel' | 'expandEditor' | 'smoothStreaming' |
  'statusBar' | 'whale' | 'whaleIdle' | 'minimal' | 'activityEnabled' | 'contextBarEnabled' |
  'agentPreset' | 'goal' | 'todos' | 'loadedContext' | 'pending' | 'commandList' |
  'lastUsage' | 'tps' | 'tpsSamples' | 'contextSegments' | 'subagents' | 'backgroundJobs' | 'selection'
> {
  return {
    effortLevels: undefined, version: 0, rows: [], selection: undefined, status: 'starting', sessionTitle: '', sessionColor: '',
    agentId: input.agentId, agentBindingGeneration: 0, model: options.model, provider: options.provider,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    cwd: options.cwd, displayCwd: input.cwdDescription, gitBranch: undefined, working: false,
    cancelPending: false, spinnerMode: 'requesting', responseChars: 0, activeToolCount: 0,
    turnStart: 0, lastUserText: '', notifications: [], contextWindow: undefined,
    reasoningEffort: options.effort, mode: input.mode, modeIndex: 0, workingActivity: undefined,
    activityFrames: normalizeActivityPreset(options.activityFrames), configuredProvider: options.configuredProvider,
    configuredModel: options.configuredModel, configuredPreset: options.configuredPreset,
    configuredActivityFrames: options.configuredActivityFrames, configuredLang: options.configuredLang,
    diffLayout: options.diffLayout ?? 'auto', thinkingFold: options.thinkingFold ?? 'preview',
    toolBackground: normalizeToolBackground(options.toolBackground), scrollGutter: normalizeScrollGutter(options.scrollGutter),
    pageMargin: normalizePageMargin(options.pageMargin), foldTerminalCommand: options.foldTerminalCommand === true,
    promptSessionLabel: options.promptSessionLabel === true, expandEditor: options.expandEditor !== false,
    smoothStreaming: options.smoothStreaming !== false, statusBar: normalizeStatusBar(options.statusBar),
    whale: options.whale !== false, whaleIdle: options.whaleIdle !== false, minimal: options.minimal === true, activityEnabled: options.activity !== false,
    contextBarEnabled: options.contextBar !== false, agentPreset: options.agentPreset, goal: undefined,
    todos: [], loadedContext: undefined, pending: [], commandList: [], lastUsage: undefined,
    tps: undefined, tpsSamples: [], contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    subagents: [], backgroundJobs: [],
  }
}
