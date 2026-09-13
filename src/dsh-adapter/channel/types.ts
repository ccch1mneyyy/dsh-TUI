import type { ChannelUi } from '../../adapter/ports/channel-ui.js'
import type { ChatRow, ToolRow, ToolCallView, ToolFileDiff, ToolResultView, SubagentRow, JobRow, TokenUsage, TokenBucket, NotificationItem, ActivityStatus, ChannelGoal, TodoPanelItem, LoadedContext, LoadedContextEntry, LoadedContextFile, LoadedContextSkill, LoadedContextTool, PendingMessage, SubagentControl, JobControl, StagedImageInput, StagedImageHandle, ComposerImageRef, ComposerSubmission, ExternalCommandOutcome, TranscriptImage, ResumeResult, EffortOption, PermissionPresetSnapshot, PermissionPresetAvailability, PermissionPresetOption, PermissionPresetCurrent, PresetOption, SkillInfo, CredentialStatus, AgentViewRow, AgentViewStatus, AgentViewDispatchResult, BackgroundResult } from '../../adapter/ports/channel-view.js'
export type { ChatRow, ToolRow, ToolCallView, ToolFileDiff, ToolResultView, SubagentRow, JobRow, TokenUsage, TokenBucket, NotificationItem, ActivityStatus, ChannelGoal, TodoPanelItem, LoadedContext, LoadedContextEntry, LoadedContextFile, LoadedContextSkill, LoadedContextTool, PendingMessage, SubagentControl, JobControl, StagedImageInput, StagedImageHandle, ComposerImageRef, ComposerSubmission, ExternalCommandOutcome, TranscriptImage, ResumeResult, EffortOption, PermissionPresetSnapshot, PermissionPresetAvailability, PermissionPresetOption, PermissionPresetCurrent, PresetOption, SkillInfo, CredentialStatus, AgentViewRow, AgentViewStatus, AgentViewDispatchResult, BackgroundResult } from '../../adapter/ports/channel-view.js'
import { type AgentStatus } from '@deepseek-ai/dsh-agent'
import type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import {
  type ContentBlock,
  type StreamChunk
} from '@deepseek-ai/dsh-llm'
import { type SessionEvent } from '@deepseek-ai/dsh-session'
import { type ActivityState } from 'dsh-working-activity/status'
import { type CommandCompletion, type LocalCommand } from '../../commands.js'
import type { SpinnerMode } from '../../components/Spinner/spinnerMode.js'
import { type BalanceResult } from '../../deepseekBalance.js'
import { type SessionModeSpec } from '../../sessionModes.js'
import { type PageMarginSetting, type ScrollGutterMode, type StatusBarConfig, type ToolBackground } from '../../tuiDisplayPrefs.js'
import { type FileCandidate } from '../../utils/fileSuggestions.js'
import type {
  TuiRewindMode
} from '../extension-events.js'
import { type BackgroundJobState, type BackgroundJobStatus } from '../jobs.js'
import type { OAuthProviderStatus, ProviderSetupHost } from '../providerWizard.js'
import { type RecapOutcome } from '../recap.js'
import { type TuiSceneDescriptor } from '../scenes.js'
import {
  type PreviewEntry,
  type SessionSummary
} from '../sessions/index.js'
import {
  type SessionTreeData
} from '../sessionTree.js'
import { type TuiSettingsSection } from '../settings-sections.js'
import type { SettingsHost } from '../settingsEditor.js'
import { type SubagentState } from '../subagents.js'
import { type TuiWorkspaceCommand, type TuiWorkspaceCommandResult, type TuiWorkspaceTarget } from '../workspaces.js'

/** dsh-llm LlmRuntime as the side-question needs it: one streaming call. */
export type SideQuestionLlm = {
  stream(options: object): AsyncIterable<StreamChunk>
}

export type PermissionPresetService = {
  names?: unknown
  current?: (events: readonly SessionEvent[]) => unknown
  optionOf?: (name: string) => unknown
}

export type ChannelImageBlock = Extract<ContentBlock, { type: 'image' }>

export type ChannelImageMediaType = ChannelImageBlock['attachment']['mediaType']

/** The dsh-tools registry seam dsh-tui reads presentations through. The
 *  registry lives on the host plane; `get` takes the live agent as the
 *  scope so a preset's own tool definitions resolve (dsh-host-apiproxy's
 *  presenter pattern). */
export interface ToolsRegistryLike {
  get(name: string, scope?: unknown): {
    presentCall?(args: unknown): unknown
    presentResult?(args: unknown, result: unknown): unknown
  } | undefined
}

/** Re-derives the presentation views foldRows dropped, threaded into
 *  foldBack (module-level, no ctx access) by the channel. */
export interface ToolViewPresenter {
  call(name: string, rawArgs: string): ToolCallView | undefined
  result(name: string, rawArgs: string, data: SessionEvent<'tool/result'>['data']): ToolResultView | undefined
}
/** Raw host implementation; the renderer receives ChannelUi instead. */
export interface Channel extends Omit<ChannelUi, 'pluginScene' | 'traceEvents'> {
 readonly pluginScene: TuiSceneDescriptor | undefined
 traceEvents(): readonly SessionEvent[]
 releaseContributions(): void
}
type MutableChannelView = { -readonly [K in keyof ChannelUi]: ChannelUi[K] }

/** Internal writable store; command signatures are owned once by ChannelUi. */
export interface ChannelState extends Omit<MutableChannelView, 'rows' | 'notifications' | 'todos' | 'pending' | 'tpsSamples' | 'subagents' | 'backgroundJobs' | 'pluginScene' | 'traceEvents'> {

  rows: ChatRow[]
  notifications: NotificationItem[]
  /** Per-turn tps samples (sparkline history), oldest first. */
  tpsSamples: { tps: number; at: number }[]
  /** Latest todo-list snapshot (see the public Channel type). */
  todos: TodoPanelItem[]
  /** Messages submitted while working, awaiting their turn/step boundary.
   *  Driven by agent inbox events (inserted/claimed/discarded). */
  pending: PendingMessage[]
  /** Open plugin scene mirrored from the scenes runtime (see the public Channel type). */
  pluginScene: TuiSceneDescriptor | undefined
  /** Active subagents roster (see the public Channel type). */
  subagents: readonly SubagentState[]
  /** Background jobs of the current session (see the public Channel type). */
  backgroundJobs: readonly BackgroundJobState[]
  /** @internal event bump (the public `notify(text)` posts a notification). */
  emit(): void
  /** @internal frame-aligned emit for high-frequency streaming deltas:
   *  version bumps synchronously but listeners fire at most once per 16ms
   *  window (trailing edge). */
  emitStream(): void
  /**
   * Bind the plugin's approval store (post-construction): row derivation
   * reads its parked ask ids for the "needs input" state, and its emits
   * re-publish as agent-view changes.
   */
  bindApprovalStore(store: {
    pendingAgentIds(): readonly string[]
    pendingAgentDetail(agentId: string): { toolName: string; reason?: string; command?: string } | undefined
    subscribe(listener: () => void): () => void
  }): void
  /** See {@link Channel.releaseContributions}. */
  releaseContributions(): void
  /** Live session event log (see the public Channel type, `/trace`). */
  traceEvents(): readonly SessionEvent[]
}

export type FileSuggestionFs = {
  resolve(path: string): Promise<{ displayPath: string }>
  listDir(target: { displayPath: string }): Promise<Array<{ name: string; type: 'file' | 'directory' | 'other'; target?: { displayPath: string } }>>
}

/** The fs-service surface `@`-mention expansion consumes (dsh-fs-local). */
export interface MentionFs {
  resolve(path: string): Promise<{ displayPath: string }>
  stat(target: { displayPath: string }): Promise<{ type: 'file' | 'directory' | 'other' } | undefined>
  readText(target: { displayPath: string }): Promise<string>
  readBytes?(target: { displayPath: string }, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  listDir(target: { displayPath: string }): Promise<Array<{ name: string; type: 'file' | 'directory' | 'other' }>>
}

export type MentionImageBlock = ChannelImageBlock

export type MentionImageMediaType = ChannelImageMediaType

/** Attachment subset used to turn an image path into a durable user block. */
export interface MentionAttachments {
  readonly imageLimits: {
    readonly maxImageBytes: number
    readonly maxImagesPerMessage: number
    readonly maxMessageImageBytes: number
    readonly mediaTypes: readonly MentionImageMediaType[]
  }
  saveImage(input: { data: Uint8Array; mediaType: MentionImageMediaType; name?: string }): Promise<MentionImageBlock['attachment']>
}

/** One mention target that resolved and stat'ed to something attachable. */
export interface ResolvedMention {
  target: { displayPath: string }
  info: { type: 'file' | 'directory' | 'other' }
}

export interface MentionExpansion {
  /** Model-facing blocks: the typed text first, one block per attachment. */
  blocks: ContentBlock[]
  /** Paths that resolved and were attached (for the confirmation notice). */
  attached: string[]
  /** Mention tokens that failed to resolve (kept literal, warned about). */
  missing: string[]
}
