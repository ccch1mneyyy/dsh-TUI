import { randomUUID } from 'node:crypto'
import { assembleContextFor, installModelSelection, type Agent, type AgentHandle, type AgentStatus, type CreateAgentOptions, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { CommandExecution, CommandRuntime } from '@deepseek-ai/dsh-commands'
import { isModelInvocable, isUserInvocable, renderSkillContent, type SkillSummary } from '@deepseek-ai/dsh-skill'
import type { LlmConfigurableProvider, LlmDiscoveredModel, LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import {
  createUserMessage,
  MessageId,
  ReasoningEffortId,
  type ContentBlock,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { runSideQuestion, wrapSideQuestion } from './sideQuestion.js'
import { isReservedCredentialRef } from './credentialRefGuard.js'
import { collectRecentActivity, parseRecapResponse, RECAP_RECENT_CHARS, wrapRecapPrompt, type RecapOutcome } from './recap.js'
import { swallowNestedUpdateOverflow } from '../ink/update-overflow-guard.js'
import { SESSION_COLOR_NAMES } from '../cc/sessionColors.js'
import { fetchBalance, type BalanceResult } from '../deepseekBalance.js'
import { isPeakHour } from '../deepseekPricing.js'
/** dsh-llm LlmRuntime as the side-question needs it: one streaming call. */
type SideQuestionLlm = {
  stream(options: object): AsyncIterable<StreamChunk>
}
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { loadBaselineInstructions } from '@deepseek-ai/dsh-agent-instructions'
import type { Context } from '@deepseek-ai/cordis'
import { extname, isAbsolute, join } from 'node:path'
import { completeCommands, HIDDEN_COMMAND_NAMES, isCommandCompletionToken, isLocalCommandName, LOCAL_COMMANDS, parseCommandName, type CommandCompletion, type CommandCompletionNode, type LocalCommand } from '../commands.js'
import { clearResumeTarget, forgetAgentViewSession, forgetSession, readAgentViewSessions, readResumeTarget, touchAgentViewSession, touchSession, writeResumeTarget } from '../sessionHistory.js'
import {
  appendSessionTitle,
  defaultMaxScanned,
  deleteSessionLog,
  ensureLegacySessionEventTypes,
  appendInterruptedTurnEnd,
  liveSessionCreateOptions,
  liveSessionListingFields,
  liveSessionOffset,
  readPhysicalHeaderSeedLength,
  readPhysicalHeaderSeedLengthForSession,
  readSessionEventsFromFile,
  readSessionEventsFromLog,
  sessionsRoots,
  sliceLiveSessionSeed,
  snapshotLiveSessionEvents,
} from './compat/index.js'
import {
  buildSessionTree,
  forkTarget,
  liveTailWindow,
  rewindTarget,
  turnUserText,
  type FamilySession,
  type SessionTreeData,
} from './sessionTree.js'
import { resolveDshProfileName } from '../update.js'
import {
  listSummaries,
  locateSession,
  noteBranch,
  previewSession,
  readHeader,
  readInheritedCut,
  type PreviewEntry,
  type RawSessionHeader,
  type SessionSource,
  type SessionSummary,
} from './sessions/index.js'
import {
  AGENT_VIEW_STATUS_ORDER,
  agentViewHasTurns,
  agentViewLivePreview,
  agentViewStatusOf,
  foldAgentViewEvents,
  oneLine,
  sessionTitleFallback,
  type AgentViewFold,
} from './agent-view.js'
import { writeActivityFrames } from '../activityPrefs.js'
import { isPathLikeQuery, rankFileCandidates, type FileCandidate } from '../utils/fileSuggestions.js'
import { readEffortPref, writeEffortPref } from '../effortPrefs.js'
import { readModelPref, writeModelPref } from '../modelPrefs.js'
import { explicitModelRoute, recordedModelRoute, resolveModelRoute, validateModelRoute } from '../modelRoute.js'
import type { OAuthProviderStatus, OAuthSetupHost, ProfilePathOp, ProviderSetupHost } from './providerWizard.js'
import { migratePresetPref, readPresetPref, writePresetPref } from '../presetPrefs.js'
import { composePreset, resolvePersistedPreset, resolvePersistedRoute, runningPresetOf, serviceForAgent } from './presets.js'
import { resolveCompatiblePreset, rosterOf, type AgentPresetInfo } from './preset-resolution.js'
import { isPresetName, PRESET_NAMES } from '../components/activityFrames.js'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { logForDebugging } from '../utils/debug.js'
import { homeDir, LEGACY_DATA_DIR } from '../utils/paths.js'
import { extractMentions } from '../utils/mentions.js'
import { getLang, LANGS, t, tOr, type Lang } from '../i18n.js'
import { AUTO_THEME_NAME } from '../theme.js'
import { listThemeCatalog } from '../themeCatalog.js'
import { modeDisplayName, resolveSessionModes, type SessionModeSpec } from '../sessionModes.js'
import { normalizePageMargin, normalizeScrollGutter, normalizeStatusBar, normalizeToolBackground, type PageMarginSetting, type ScrollGutterMode, type StatusBarConfig, type ToolBackground } from '../tuiDisplayPrefs.js'
import { SubagentActivityStore, type SubagentState } from './subagents.js'
export type { SubagentState } from './subagents.js'
import { BackgroundJobStore, formatJobDuration, type BackgroundJobState, type BackgroundJobStatus, type JobsRuntime } from './jobs.js'
import type { SpinnerMode } from '../components/Spinner/spinnerMode.js'
import { ActivityTracker, type ActivityState } from 'dsh-working-activity/status'
import type { TrackerConfig } from 'dsh-working-activity/status'
import { featureOn } from 'dsh-working-activity/config'
import { setMinimalMode } from '../minimalMode.js'
import { readActivityConfig } from '../activityPrefs.js'
import { attachSessionToWorkspace } from './workspace.js'
import { createLocalWorkspaceRuntime, getHostWorkspaceRuntime, type TuiWorkspaceCommand, type TuiWorkspaceCommandResult, type TuiWorkspaceTarget } from './workspaces.js'
import { getHostCommandTrees } from './command-trees.js'
import { getHostSettingsSections, getLocalSettingsSectionsHost, type TuiSettingsSection, type TuiSettingsSectionsRuntime } from './settings-sections.js'
import type { SettingsHost } from './settingsEditor.js'
import { getHostSceneRuntime, type TuiSceneDescriptor, type TuiSceneRuntime } from './scenes.js'
import { getHostRenderers, type TuiRendererRuntime } from './renderers.js'
import { getHostThemes, type TuiThemeRuntime } from './themes.js'
import { getHostMessageObserver, type TuiMessageObserverRuntime } from './message-observer.js'
import { dispatchTuiDecision, dispatchTuiNotification, normalizeCancelDecision } from './extension-events.js'
import { installDecisionGuard } from './decision-guard.js'
import { commandOwner } from './command-attribution.js'
import { readGrantStore } from './grants.js'
import { hasCommandErrorCode, mapCommandError } from './command-errors.js'
import { installedMeetsVersion } from './contract.js'
import { pluginsInfoLines } from './plugins-info.js'
import { cleanRenderText, cleanScalarText } from './sanitize.js'
import type {
  TuiInputDecision,
  TuiRewindMode,
  TuiRewindPromptDecision,
} from './extension-events.js'

/** `tui/input` return normalization: transform/handled/cancel or no opinion.
 *  A blank `{ text }` rewrite is NOT a decision — it is logged and the chain
 *  continues so a later veto listener still runs. */
function normalizeInputDecision(
  result: unknown,
  warn: (what: string) => void,
): TuiInputDecision | undefined {
  if (result === undefined || result === null || result === false) return undefined
  if (typeof result !== 'object') {
    warn(`a non-object (${typeof result})`)
    return undefined
  }
  const record = result as Record<string, unknown>
  if (record.cancel === true) {
    const reason = cleanScalarText(record.reason, NOTICE_CELLS)
    return { cancel: true, ...(reason === '' ? {} : { reason }) }
  }
  if (record.handled === true) {
    const notice = cleanScalarText(record.notice, NOTICE_CELLS)
    return { handled: true, ...(notice === '' ? {} : { notice }) }
  }
  if (typeof record.text === 'string') {
    if (record.text.trim() === '') {
      warn('a blank {text} rewrite')
      return undefined
    }
    return { text: record.text }
  }
  warn('an unrecognized decision shape')
  return undefined
}

/** `tui/rewind-prompt` return normalization: cancel/modes or no opinion.
 *  Modes are COPIED with only validated, sanitized scalar fields — the raw
 *  plugin object must never reach the render path (a `description: {}` would
 *  crash ListItem's `.replace`, and control chars would corrupt the pane).
 *  Notices/reasons are toast-bound plugin text: sanitized too (see
 *  ./sanitize.js — the one implementation of the render-path contract). */
function normalizeRewindPromptDecision(
  result: unknown,
  warn: (what: string) => void,
): TuiRewindPromptDecision | undefined {
  if (result === undefined || result === null || result === false) return undefined
  if (typeof result !== 'object') {
    warn(`a non-object (${typeof result})`)
    return undefined
  }
  const record = result as Record<string, unknown>
  if (record.cancel === true) {
    const reason = cleanScalarText(record.reason, NOTICE_CELLS)
    return { cancel: true, ...(reason === '' ? {} : { reason }) }
  }
  if (Array.isArray(record.modes)) {
    const modes: TuiRewindMode[] = []
    for (const raw of record.modes as unknown[]) {
      if (modes.length >= 8) break
      if (raw === null || typeof raw !== 'object') continue
      const candidate = raw as Record<string, unknown>
      if (typeof candidate.id !== 'string' || candidate.id.trim() === '') continue
      const label = typeof candidate.label === 'string' ? cleanRenderText(candidate.label, 120) : ''
      if (label === '') continue
      const description =
        typeof candidate.description === 'string' && candidate.description.trim() !== ''
          ? cleanRenderText(candidate.description, 400)
          : undefined
      modes.push({ id: candidate.id, label, ...(description === undefined ? {} : { description }) })
    }
    if (modes.length === 0) {
      warn('an empty or invalid {modes} list')
      return undefined
    }
    return { modes }
  }
  warn('an unrecognized decision shape')
  return undefined
}

/** Toast-bound plugin text (veto reasons, handled notices, rewind summaries)
 *  is render-path data too: same sanitization, toast-width cap. */
const NOTICE_CELLS = 200

const PERMISSION_PRESET_CUSTOM = 'custom'
const PERMISSION_PRESET_NAME_CELLS = 120
const PERMISSION_PRESET_DESCRIPTION_CELLS = 400

type PermissionPresetService = {
  names?: unknown
  current?: (events: readonly SessionEvent[]) => unknown
  optionOf?: (name: string) => unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function legacyPermissionPresetOptions(): readonly PermissionPresetOption[] {
  return [
    {
      value: 'read-only',
      name: t('permission-preset-readonly'),
      description: t('permission-preset-readonly-desc'),
    },
    {
      value: 'workspace-write',
      name: t('permission-preset-workspace-write'),
      description: t('permission-preset-workspace-write-desc'),
    },
    {
      value: 'danger-full-access',
      name: t('permission-preset-full-access'),
      description: t('permission-preset-full-access-desc'),
    },
  ]
}

function legacyPermissionPresetSnapshot(sandbox: SessionModeSpec['sandbox']): PermissionPresetSnapshot {
  const options = legacyPermissionPresetOptions()
  const currentOption = sandbox === undefined ? undefined : options.find(option => option.value === sandbox)
  return {
    availability: 'legacy',
    options,
    ...(currentOption === undefined
      ? {}
      : { current: { ...currentOption, kind: 'preset' as const } }),
  }
}

function unavailablePermissionPresetSnapshot(): PermissionPresetSnapshot {
  return { availability: 'unavailable', options: [] }
}

function normalizePermissionPresetOption(value: unknown): PermissionPresetOption | undefined {
  if (!isRecord(value) || typeof value.value !== 'string' || typeof value.name !== 'string') return undefined
  const name = cleanRenderText(value.name, PERMISSION_PRESET_NAME_CELLS)
  if (name === '') return undefined
  if (value.description !== undefined && typeof value.description !== 'string') return undefined
  const description = value.description === undefined
    ? undefined
    : cleanRenderText(value.description, PERMISSION_PRESET_DESCRIPTION_CELLS)
  if (value.description !== undefined && description === '') return undefined
  return {
    value: value.value,
    name,
    ...(description === undefined || description === '' ? {} : { description }),
  }
}

function permissionPresetSnapshotFromService(
  service: unknown,
  events: readonly SessionEvent[],
): PermissionPresetSnapshot {
  if (!isRecord(service)) return unavailablePermissionPresetSnapshot()
  const runtime = service as PermissionPresetService
  try {
    const capturedNames = runtime.names
    const current = runtime.current
    const optionOf = runtime.optionOf
    if (!Array.isArray(capturedNames) || capturedNames.length === 0) return unavailablePermissionPresetSnapshot()
    if (typeof current !== 'function' || typeof optionOf !== 'function') return unavailablePermissionPresetSnapshot()

    const names = [...capturedNames]
    const seen = new Set<string>()
    for (const name of names) {
      if (typeof name !== 'string' || name.trim() === '' || name === PERMISSION_PRESET_CUSTOM || seen.has(name)) {
        return unavailablePermissionPresetSnapshot()
      }
      seen.add(name)
    }

    const options: PermissionPresetOption[] = []
    for (const name of names) {
      const option = normalizePermissionPresetOption(optionOf(name))
      if (option === undefined || option.value !== name) return unavailablePermissionPresetSnapshot()
      options.push({ ...option })
    }

    const currentValue = current(events)
    if (typeof currentValue !== 'string' || (currentValue !== PERMISSION_PRESET_CUSTOM && !seen.has(currentValue))) {
      return unavailablePermissionPresetSnapshot()
    }
    const currentOption = normalizePermissionPresetOption(optionOf(currentValue))
    if (currentOption === undefined || currentOption.value !== currentValue) return unavailablePermissionPresetSnapshot()
    if (currentValue !== PERMISSION_PRESET_CUSTOM) {
      const rosterOption = options.find(option => option.value === currentValue)
      if (
        rosterOption === undefined
        || rosterOption.name !== currentOption.name
        || rosterOption.description !== currentOption.description
      ) {
        return unavailablePermissionPresetSnapshot()
      }
    }

    return {
      availability: 'runtime',
      options,
      current: {
        ...currentOption,
        kind: currentValue === PERMISSION_PRESET_CUSTOM ? 'custom' : 'preset',
      },
    }
  } catch {
    return unavailablePermissionPresetSnapshot()
  }
}

/** `tui/rewind-done` return normalization: the first non-empty STRING is the
 *  summary; anything else is not a decision. */
function normalizeRewindDoneSummary(result: unknown, warn: (what: string) => void): string | undefined {
  if (result === undefined || result === null || result === false) return undefined
  if (typeof result === 'string') {
    const summary = cleanRenderText(result, NOTICE_CELLS)
    return summary === '' ? undefined : summary
  }
  warn('a non-string summary')
  return undefined
}

type ChannelImageBlock = Extract<ContentBlock, { type: 'image' }>
type ChannelImageMediaType = ChannelImageBlock['attachment']['mediaType']

export interface StagedImageInput {
  data: Uint8Array
  mediaType: ChannelImageMediaType
  name?: string
}

/** Tool-call card state, mirroring the Claude Code tool-use presentation. */
export interface ToolRow {
  readonly callId: string
  readonly name: string
  /** Raw JSON arguments as the model produced them (displayed truncated). */
  readonly argsText: string
  /** Full arguments, shown when Ctrl+O verbose mode is on; dropped when the
   *  row is folded (session log retains it). */
  argsFull?: string
  status: 'running' | 'ok' | 'error'
  resultText?: string
  /** Full result text, shown when Ctrl+O verbose mode is on. */
  resultFull?: string
  errorText?: string
  /** Tool-owned render intent from dsh-tools `presentCall` (diff/terminal/
   *  generic). Drives the structured card body instead of the raw text. */
  callView?: ToolCallView
  /** Tool-owned completed-state view from `presentResult` (applied diff
   *  hunks, terminal output, read content…). Wins over callView once set. */
  resultView?: ToolResultView
  /** Wall-clock start of the call (live elapsed while running). */
  startedAt: number
  /** Settled wall-clock duration, written by tool/result. */
  durationMs?: number
}

/** One file change in a tool presentation (dsh-tools FileDiff). */
export interface ToolFileDiff {
  readonly path: string
  /** Prior content, or null for a new file / no before-image. */
  readonly oldText: string | null
  readonly newText: string
}

/** Pending-call render intent (structural subset of dsh-tools ToolCallView). */
export type ToolCallView =
  | { readonly card: 'generic'; readonly title: string; readonly kind?: string }
  | { readonly card: 'terminal'; readonly title: string; readonly description?: string; readonly cwd?: string }
  | { readonly card: 'diff'; readonly title: string; readonly diffs: readonly ToolFileDiff[] }

/** Completed-call render intent (structural subset of dsh-tools
 *  ToolResultView). `web` results and unknown shapes fall back to raw text. */
export type ToolResultView =
  | { readonly card: 'generic'; readonly title?: string; readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }> }
  | { readonly card: 'terminal'; readonly title?: string; readonly output?: string; readonly exitCode?: number; readonly signal?: string }
  | { readonly card: 'diff'; readonly title?: string; readonly diffs: readonly ToolFileDiff[] }
  | { readonly card: 'read'; readonly title?: string; readonly path?: string; readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }> }
  | {
      readonly card: 'search'
      readonly shape: 'matches'
      readonly title?: string
      readonly files: ReadonlyArray<{ readonly path: string; readonly matches: ReadonlyArray<{ readonly lineNumber: number; readonly line: string }> }>
      readonly truncated: boolean
      readonly total: number
    }
  | { readonly card: 'search'; readonly shape: 'paths'; readonly title?: string; readonly paths: readonly string[]; readonly truncated: boolean; readonly total: number }

/** The dsh-tools registry seam dsh-tui reads presentations through. The
 *  registry lives on the host plane; `get` takes the live agent as the
 *  scope so a preset's own tool definitions resolve (dsh-host-apiproxy's
 *  presenter pattern). */
interface ToolsRegistryLike {
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

/**
 * Subagent row: displays a subagent's lifecycle (started → running → completed/failed).
 * Derived from agent.task events and history events.
 */
export interface SubagentControl {
  interrupt(agentId: string): boolean
}

/**
 * Background-job row control (`/jobs` panel): cancellation with the same
 * authority the owning agent itself would use (`job_kill`). Returns false
 * when the jobs service is absent or the job is unknown/foreign.
 */
export interface JobControl {
  kill(id: string): boolean
}

export interface SubagentRow {
  agentId: string
  runId?: string
  description: string
  provider?: string
  model?: string
  effort?: string
  status: SubagentState['status']
  startedAt: number
  completedAt?: number
  durationMs?: number
  outputLines: string[]
  toolCalls: SubagentState['toolCalls']
  tokens?: SubagentState['tokens']
  summary?: string
  stopReason?: string
  error?: string
}

/** One background job as a live transcript card (see `kind: 'job'`). */
export interface JobRow {
  id: string
  kind: string
  label: string
  status: BackgroundJobStatus
  detail?: string
  startedAt: number
  finishedAt?: number
  /** Mirrored `job_output` tail feeding the card's three-line waterfall. */
  outputLines: readonly string[]
}

/**
 * One rendered transcript row. The DSH session log is the source of truth:
 * rows are derived from `session/event` records (and the initial
 * `snapshotLiveSessionEvents(agent.session)` replay), never from optimistic local state.
 */
export interface ChatRow {
  id: number
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'reasoning' | 'interrupt' | 'local' | 'local-output' | 'compact' | 'subagent' | 'job'
  /** Extra label for non-human user rows (e.g. `steering`). */
  label?: string
  /** Actual execution location for `!command` rows. */
  executionTarget?: string
  text: string
  /** True while an assistant step is still streaming chunks. */
  streaming?: boolean
  /** Present on `tool` rows; the card model. */
  tool?: ToolRow
  /** Present on `subagent` rows; the subagent state snapshot. */
  subagent?: SubagentRow
  /** Present on `job` rows; the background-job state snapshot. */
  job?: JobRow
  /** Event wall-clock time (transcript-mode metadata, assistant rows). */
  time?: number
  /** Present on `reasoning` rows once settled: thinking wall-clock duration. */
  durationMs?: number
  /** Source session event seq — present on every log-derived row (rewind
   *  fork anchor on user rows; window-floor bookkeeping for the rest). */
  seq?: number
  /** True when the row's full text was folded to keep the transcript window
   *  bounded (see MAX_ROWS); the session log still holds the full content
   *  and loadOlder() restores it. */
  folded?: boolean
  /** True when loadOlder() restored this row from the log; restored rows are
   *  exempt from the next fold pass so a restore is not instantly undone. */
  restored?: boolean
  /** True on rows created by LIVE event handling (not replay/resume/fold
   *  restore) — the smooth-streaming reveal animates freshly-arrived
   *  content only; replayed history must paint complete. Set once at
   *  creation; never mutated afterwards. */
  fresh?: boolean
}

/**
 * Delay before re-reading a skill catalog that reported an incomplete
 * observation (a provider whose directory watcher is still warming).
 */
const SKILL_COMMAND_RETRY_MS = 800

/** One 计费时段（高峰/空闲）的 token 累计。 */
export interface TokenBucket {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Running token totals across the session's assistant messages. */
export interface TokenUsage {
  input: number
  output: number
  /** Prompt-cache hit tokens across the session (priced at the hit rate). */
  cacheRead: number
  /** Prompt-cache write tokens across the session (priced with uncached input). */
  cacheWrite: number
  /** Peak-hour tokens (billed at peak rates) — each usage lands in a bucket
   *  by its event time, so a session spanning both windows is priced per
   *  window instead of all at the current rate. */
  peak: TokenBucket
  /** Off-peak-hour tokens (billed at idle rates). */
  idle: TokenBucket
}

/** 全零 token 累计（新会话 / 复位用）。 */
export function emptyTokenUsage(): TokenUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

/** In-process working-line snapshot derived from the base session stream. */
export type ActivityStatus = ActivityState

/** A transient status message shown above the prompt input. */
export interface NotificationItem {
  id: number
  text: string
  /** Theme color key; defaults to dim. */
  color?: 'error' | 'warning' | 'success'
  /** Auto-dismiss after this many ms (default 4000); 0 = sticky, removed
   *  only through the early-dismiss handle. */
  timeoutMs: number
}

/** Names the subagent delegation tools ship under (preset `toolName` values
 *  plus the CLI default); each renders as a live subagent card, never a plain
 *  tool card. */
const SUBAGENT_TOOL_NAMES = new Set([
  'task',
  'subagent',
  'subagent_fork',
  'subagent_claude_code',
  'subagent_codex',
  'spawn_task',
])
function isSubagentToolName(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(name.toLowerCase())
}

/** Extract `job_id` from a job_output call's raw args (JSON), or undefined. */
function parseJobOutputId(argsFull: string | undefined): string | undefined {
  if (argsFull === undefined || argsFull === '') return undefined
  try {
    const args = JSON.parse(argsFull) as { job_id?: unknown }
    return typeof args.job_id === 'string' && args.job_id !== '' ? args.job_id : undefined
  } catch {
    return undefined
  }
}

/** Extract the command that launched a background job from its tool args
 *  (`command` for the shell tools, `text` for terminal_send). The registry
 *  label is the friendly description; the command is the actual invocation. */
function toolCommandOf(argsFull: string | undefined): string | undefined {
  if (argsFull === undefined || argsFull === '') return undefined
  try {
    const args = JSON.parse(argsFull) as { command?: unknown; text?: unknown }
    const candidate = typeof args.command === 'string' && args.command !== ''
      ? args.command
      : typeof args.text === 'string' && args.text !== ''
        ? args.text
        : undefined
    return candidate
  } catch {
    return undefined
  }
}

/** The ack a shell tool returns for `run_in_background: true`. */
const BACKGROUND_START_ACK = /^started background job (\S+)/

/**
 * Durable same-session goal projection surfaced on the channel (see
 * {@link Channel['goal']}). Mirrors the goal domain's `GoalSnapshot` +
 * replay counters; declared locally so the UI needs no dsh-goal dependency.
 */
export interface ChannelGoal {
  id: string
  revision: number
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  /** Total admitted goal-round cap. */
  maxGoalRounds: number
  /** Highest admitted continuation round so far. */
  roundsStarted: number
  /** Present exactly while `phase` is `blocked`. */
  blockedReason?: { code: string; message: string }
}

/** The observable outcome of adopting a persisted session. */
export type ResumeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'working' }
  | { readonly ok: false; readonly reason: 'unavailable' }
  | { readonly ok: false; readonly reason: 'cancelled' }
  | { readonly ok: false; readonly reason: 'failed'; readonly error: string }

/**
 * One session's state in the agent view (CC's `claude agents` screen).
 * States mirror Claude Code's vocabulary:
 * `working` — a turn is running; `needs-input` — an approval request is
 * parked for this agent; `idle` — live and waiting for the next prompt;
 * `completed` — a live agent whose last turn ended (task finished, waiting);
 * `failed` — the last turn ended with an error; `stopped` — the session's
 * process is gone (persisted only).
 */
export type AgentViewStatus =
  | 'working'
  | 'needs-input'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'stopped'

/** One row in the agent view list. */
export interface AgentViewRow {
  /** Session id — the attach/dispatch target. */
  readonly id: string
  /** Display title (session title, or a fallback from the prompt/cwd). */
  readonly title: string
  /** Absolute working directory the session runs in. */
  readonly cwd: string
  /** One-line activity summary derived from the session's recent output. */
  readonly summary: string
  readonly status: AgentViewStatus
  /** True when an agent for this session is alive in THIS process (✻ vs ∙). */
  readonly live: boolean
  /** True when this is the session the TUI terminal is attached to. */
  readonly current: boolean
  /** Unix epoch milliseconds when the session was created. */
  readonly createdAt: number
  /** Unix epoch milliseconds of the session's latest activity. */
  readonly updatedAt: number
}

/** The observable outcome of dispatching a new background session. */
export type AgentViewDispatchResult =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly reason: 'unavailable' }
  | { readonly ok: false; readonly reason: 'failed'; readonly error: string }

/** The observable outcome of backgrounding the attached session. */
export type BackgroundResult =
  | { readonly ok: true; readonly backgroundedSessionId: string }
  | { readonly ok: false }

/** Secret-free credential metadata for configuration and status surfaces. */
export interface CredentialStatus {
  configured: boolean
  source?: string
  writable: boolean
}

/** One entry of the latest todo-list snapshot (mirrors dsh-tool-todo's
 *  `TodoItem`; declared locally so the adapter needn't depend on that plugin). */
export interface TodoPanelItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** Narrow an optional plugin event without importing its module augmentation. */
function todoPanelItems(data: unknown): TodoPanelItem[] | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const todos = (data as { todos?: unknown }).todos
  if (!Array.isArray(todos)) return undefined
  const valid = todos.every(item => {
    if (typeof item !== 'object' || item === null) return false
    const candidate = item as { content?: unknown; status?: unknown }
    return typeof candidate.content === 'string' &&
      (candidate.status === 'pending' || candidate.status === 'in_progress' || candidate.status === 'completed')
  })
  return valid ? todos as TodoPanelItem[] : undefined
}

/** One named prompt contribution with its model-visible text. */
export interface LoadedContextEntry {
  /** Provider-declared name (e.g. `harness:identity`, `deployment:persona`). */
  readonly name: string
  /** The interpolated text the model receives for this entry. */
  readonly text: string
}

/** One discovered workspace instruction file (AGENTS.md-family). */
export interface LoadedContextFile {
  /** Model-facing path (e.g. `./AGENTS.md`). */
  readonly displayPath: string
}

/** One model-invocable skill from the skill registry. */
export interface LoadedContextSkill {
  readonly name: string
  readonly description: string
}

/** One skill in the live agent's catalog, for the `/skills` picker (issue #204). */
export interface SkillInfo {
  readonly name: string
  readonly description: string
  /** True when `/name` invokes it (it appears in the `/` menu, issue #86). */
  readonly userInvocable: boolean
  /** Discovery source bucket (bundled / user-* / project-* / runtime / …). */
  readonly source: string
}

/** One model-visible tool from the prompt assembly. */
export interface LoadedContextTool {
  readonly name: string
  readonly description: string
}

/**
 * Snapshot of everything a fresh conversation for the current agent will
 * load: the assembled system prompt (ordered sections, dynamic context,
 * tools), the workspace instruction files baseline discovery would inject,
 * and the skill catalog. Declared locally so screens and helpers consume a
 * self-contained contract instead of the dsh-system-prompt/dsh-skill types.
 */
export interface LoadedContext {
  /** Ordered system-prompt sections after strict variable interpolation. */
  readonly sections: readonly LoadedContextEntry[]
  /** Dynamic context contributions (runtime snapshot parts). */
  readonly contexts: readonly LoadedContextEntry[]
  /** Workspace instruction files (AGENTS.md-family) discovered for the cwd. */
  readonly files: readonly LoadedContextFile[]
  /** Model-invocable skills, when the skill registry is mounted. */
  readonly skills: readonly LoadedContextSkill[]
  /** Model-visible tools in assembly order. */
  readonly tools: readonly LoadedContextTool[]
}

/**
 * The public channel surface a screen renders: the full transcript and live
 * status snapshot (tokens, spinner, working activity, goals, todos, loaded
 * context) plus every action the TUI can take (submit, steer, cancel,
 * rewind, resume, model switching, …). Implementations mutate internal state
 * and bump `version` so subscribed screens re-render.
 */
export interface Channel {
  /** Monotonic version — bump on every mutation so screens can re-render. */
  readonly version: number
  readonly rows: readonly ChatRow[]
  readonly status: AgentStatus | 'starting' | 'disposed'
  readonly sessionTitle: string
  /** Per-session accent color name (`/color`), '' when unset — persisted via
   *  a `session/color` log event so it survives resume/rewind. Renders as
   *  the prompt-input border + session label chip accent (cc/sessionColors). */
  readonly sessionColor: string
  readonly agentId: string
  /** TUI-owned generation that changes on every live Agent rebind. */
  readonly agentBindingGeneration: number
  /** `dsh-tui.recapOnOpen` (default on): auto-summarize the session tail
   *  into the dim AutoRecapRow when the session opens/resumes. Read live
   *  (settings service), so a `/settings` change applies on the next
   *  session switch; absent settings service → on. */
  readonly autoRecapOnOpen: boolean
  /** Resolved model id (from the plugin config). */
  readonly model: string
  /** Provider route of the live agent. */
  readonly provider: string
  /** Raw cordis.yml `provider` key (undefined when unset) — the boot-time
   *  pin `/reload` must never override. */
  readonly configuredProvider: string | undefined
  /** Raw cordis.yml `model` key (undefined when unset). */
  readonly configuredModel: string | undefined
  /** Explicit cordis.yml `preset` (undefined = roster default wins) — `/reload`
   *  must not override a static deployment choice. */
  readonly configuredPreset: string | undefined
  /** Explicit cordis.yml `activityFrames` (undefined = pref/default wins). */
  readonly configuredActivityFrames: string | undefined
  /** Explicit cordis.yml `lang` (undefined = settings/lang.json wins). */
  readonly configuredLang: string | undefined
  /** Running token totals across the session's assistant messages. */
  readonly tokens: TokenUsage
  /** Working directory of the session. */
  readonly cwd: string
  /** Human-facing cwd (remote POSIX path/URI instead of a host alias). */
  readonly displayCwd: string
  /** Current git branch, when the cwd is inside a git worktree. */
  readonly gitBranch: string | undefined
  /** True between turn/start and turn/end — drives the working spinner. */
  readonly working: boolean
  /** True while a user-requested abort (Ctrl+C/Esc interrupt) has not yet
   *  converged — no turn/start or turn/end has retired the aborted turn.
   *  Chat uses it so a repeated Ctrl+C during a stuck abort force-exits. */
  readonly cancelPending: boolean
  /** Which phase the spinner should present while working. */
  readonly spinnerMode: SpinnerMode
  /** Chars streamed as text this turn (feeds the spinner token counter). */
  readonly responseChars: number
  /** Number of tool calls still in flight this turn. */
  readonly activeToolCount: number
  /** Wall-clock ms of turn/start (spinner elapsed timer). */
  readonly turnStart: number
  /** Last user prompt text (sticky header + statusline). */
  readonly lastUserText: string
  /** Transient notifications, newest last. */
  readonly notifications: readonly NotificationItem[]
  /** Adapter-advertised context capacity for the model route, when known. */
  readonly contextWindow: number | undefined
  /** Reasoning effort of the latest request header, when the adapter sets one. */
  readonly reasoningEffort: string | undefined
  /** The live route's reasoning-effort level ids, low → high (the last entry
   *  is the top tier). Consumed by top-tier-triggered UI (effort ignition). */
  readonly effortLevels: readonly string[] | undefined
  /** Usage of the most recent request (context share + cache hits come from
   *  this, not the running totals — each request's input IS the context). */
  readonly lastUsage:
    | { input: number; output: number; cacheRead: number; cacheWrite: number }
    | undefined
  /** Output tokens per second of the current/last turn's response, when known. */
  readonly tps: number | undefined
  /** Per-turn tps samples (sparkline history), oldest first. */
  readonly tpsSamples: readonly { tps: number; at: number }[]
  /** Latest in-process working-activity snapshot. */
  readonly workingActivity: ActivityStatus | undefined
  /** Working-activity indicator preset name (`claude`/`moon`/…/`random`). */
  readonly activityFrames: string | undefined
  /** Edit/Write diff presentation preference (`auto`/`split`/`unified`). */
  readonly diffLayout: 'auto' | 'split' | 'unified'
  /** Thinking-block display (`preview` = 2-3 line live stream + fold per
   *  step; `full` = expanded until turn end). */
  readonly thinkingFold: 'preview' | 'full'
  /** Live tool-card background treatment. */
  readonly toolBackground: ToolBackground
  /** What the fullscreen transcript's right gutter shows (settings
   *  `dsh-tui.scrollGutter`: turn timeline / proportional scrollbar /
   *  nothing). */
  readonly scrollGutter: ScrollGutterMode
  /** Root page inset (settings `dsh-tui.pageMargin`): a preset name
   *  (`none` / `slim` / `normal` (default) / `roomy`) or a custom `NxM`
   *  spec (columns per side × rows top/bottom) inset the whole UI from the
   *  terminal edges — terminals without their own viewport padding (bare
   *  WSL, tmux, SSH) otherwise hug the screen border. */
  readonly pageMargin: PageMarginSetting
  /** Terminal-card header folding (settings `dsh-tui.foldTerminalCommand`):
   *  collapse a multi-line command title to its first line + count hint. */
  readonly foldTerminalCommand: boolean
  /** Whether the session-name chip shows on the prompt top border's right
   *  side (settings `dsh-tui.promptSessionLabel`; off by default). */
  readonly promptSessionLabel: boolean
  /** Whether the fullscreen draft editor is enabled (settings
   *  `dsh-tui.expandEditor`; on by default) — gates the ⛶ affordance and
   *  the expandEditor shortcut. */
  readonly expandEditor: boolean
  /** Smooth streaming reveal (settings `dsh-tui.smoothStreaming`; on by
   *  default): live-arriving assistant text, expanded thinking, and tool
   *  call bodies paint through a ~30fps reveal instead of jumping per
   *  provider burst. */
  readonly smoothStreaming: boolean
  /** Live status-footer visibility and compactness preferences. */
  readonly statusBar: Readonly<StatusBarConfig>
  /** Whether the header's pixel whale art shows (settings `dsh-tui.whale`). */
  readonly whale: boolean
  /** Whether the settled header whale keeps behaving — fin flutters, tail
   * thumps, sleep after inactivity (settings `dsh-tui.whaleIdle`; off by
   * default so the settled header holds zero timers). */
  readonly whaleIdle: boolean
  /** Minimal mode (settings `dsh-tui.minimal`): no header splash, no emoji
   *  glyphs, no decorative colors; code highlight and tool colors stay. */
  readonly minimal: boolean
  /** Whether the in-process working-activity line is shown (config.activity). */
  readonly activityEnabled: boolean
  /** Whether the segmented context bar row shows in the status footer
   *  (config.contextBar; the status/mode lines are unaffected). */
  readonly contextBarEnabled: boolean
  /**
   * Current same-session goal projection, when a goal exists. Derived live
   * from the durable goal events in the session log — top-level
   * `goal/change` snapshots (every goal mutation appends one) plus the
   * goal-sourced continuation rounds that advance the counter — so this
   * snapshot tracks create/edit/pause/resume/complete/block/clear in real
   * time and replays correctly on resume/rewind.
   */
  readonly goal: ChannelGoal | undefined
  /**
   * Latest todo-list snapshot (`todo/write` whole-list event, last write
   * wins). Log-only UI state, updated live and on replay.
   */
  readonly todos: readonly TodoPanelItem[]
  /**
   * Snapshot of the context a fresh conversation for this agent will load
   * (system prompt sections, dynamic context, workspace instructions, skill
   * catalog, tools), computed at boot and on every agent swap. `undefined`
   * while loading or when the snapshot could not be assembled — the startup
   * panel stays hidden until it lands.
   */
  readonly loadedContext: LoadedContext | undefined
  /**
   * Messages submitted while the model was working and not yet claimed by a
   * turn (`steer` → next step boundary of the running turn, `followup` →
   * after the turn ends). Driven by agent inbox events.
   */
  readonly pending: readonly PendingMessage[]
  /**
   * Effective slash commands: built-in locals plus plugin-registered
   * commands (plan/goal/…) merged from the DSH command registry. The
   * registry is the source of truth for external names — a plugin shadows
   * nothing here; locals win on name collisions.
   */
  readonly commandList: readonly LocalCommand[]
  /** Context-aware slash completions, including plugin subcommands. */
  commandCompletions(input: string): readonly CommandCompletion[]
  /**
   * Run a plugin-registered slash command against the live agent (DSH
   * `dsh-commands` registry): logs `command/run`/`command/done` and returns
   * the handler's result text — `''` when the handler succeeded silently,
   * `undefined` when the registry has no such command (the caller falls
   * back to sending the line to the model).
   */
  runExternalCommand(name: string, rawInput: string): Promise<string | undefined>
  /**
   * Plugin-registered full-screen scene currently replacing the conversation
   * (the `dsh-tui-scenes` runtime), if any. The chat screen renders its
   * component INSTEAD of the transcript — the same whole-terminal treatment
   * the trajectory scene gets — and hands it the keyboard; `undefined`
   * renders the conversation normally.
   */
  readonly pluginScene: TuiSceneDescriptor | undefined
  /**
   * Open a registered plugin scene by id. Plugin command handlers usually
   * call the runtime directly (`ctx.tuiScenes.open`); this passthrough lets
   * host-side UI code do the same without touching cordis services.
   */
  openPluginScene(id: string): boolean
  /** Close the open plugin scene, if any (a no-op otherwise). */
  closePluginScene(): void
  /** 侧问（CC /btw）：无工具单轮 LLM 调用，复用当前会话上下文；结果不落 session log。 */
  sideQuestion(
    question: string,
    options?: { signal?: AbortSignal; onText?: (delta: string) => void },
  ): Promise<{ answer: string | null; error?: string }>
  /** Estimated context segments by content type (pi-nano-context style bar). */
  readonly contextSegments: {
    system: number
    prompt: number
    assistant: number
    thinking: number
    tools: number
  }
  /** Active subagents spawned by the current session. */
  readonly subagents: readonly SubagentState[]
  /** Native control operations; unavailable providers safely return false. */
  readonly subagentControl: SubagentControl
  /**
   * Background jobs of the current session (`run_in_background` tool work),
   * live-tracked from the harness job registry. Empty when the composition
   * has no jobs service. Drives the `/jobs` panel, transcript job cards and
   * the status-line chip.
   */
  readonly backgroundJobs: readonly BackgroundJobState[]
  /** Cancellation of a background job with the owning agent's authority. */
  readonly jobControl: JobControl
  subscribe: (listener: () => void) => () => void
  /** Validate and persist a pasted image, returning its prompt placeholder. */
  stageImage(input: StagedImageInput): Promise<string>
  submit(text: string): void
  /**
   * Steer a message into the running turn (Codex/pi semantics): injected at
   * the next step boundary, the agent continues without aborting.
   */
  steer(text: string): void
  /** Pull a pending message back out of the inbox (Alt+Up) for re-editing. */
  removePending(id: string): boolean
  /** Abort the in-flight turn (`Ctrl+C` while working). While `cancelPending`
   *  stays true the abort has not converged; Chat force-exits on the next
   *  Ctrl+C press in that window. */
  cancel(): void
  /** Abort the in-flight turn and process `texts` right away (Esc/Ctrl+Enter
   *  with queued input): each text is re-queued as a followup once the abort
   *  settles, so the new turn starts immediately. Returns the count queued. */
  interruptAndDeliver(texts: readonly string[]): number
  /** Rewind the conversation to a past user message (CC's double-Esc rewind):
   *  forks the session through that message, swaps in a fresh agent, and
   *  returns the message text for re-editing — or `null` when unwritable.
   *  `mode` is the plugin-offered rewind mode the user picked (the
   *  tui/rewind-prompt seam), null for the plain conversation rewind. */
  rewindTo(row: ChatRow, mode?: string | null): Promise<string | null>
  /**
   * The rewind decision prompt (tui/rewind-prompt event): asked when the
   * picker confirms a message, before the confirm pane renders. 'cancel'
   * vetoes the rewind (reason already toasted), `{ modes }` adds plugin
   * choices to the confirm pane, null means no opinion (plain confirm).
   */
  promptRewind(row: ChatRow): Promise<{ modes: readonly TuiRewindMode[] } | 'cancel' | null>
  /**
   * The session family tree for the /tree screen (pi's Session Tree): the
   * live session's whole lineage — ancestors, siblings, descendants —
   * stitched across fork sessions into one message-level tree. `null` (with
   * a notify) when session persistence is unavailable or the live session
   * swapped while the family loaded.
   */
  buildSessionTree(): Promise<SessionTreeData | null>
  /**
   * Session-tree fork: `rewind` drops the picked user turn (its prompt comes
   * back as the returned text), `fork` keeps the picked entry. `seq` is the
   * tree entry's source event seq inside `sessionId`'s log; `sessionId` may
   * be any family member (adopting a dead branch forks IT at the picked
   * point). Null = refused (the channel notified why).
   */
  rewindToNode(sessionId: string, seq: number, mode?: 'rewind' | 'fork'): Promise<string | null>
  /** `/fork`: fork the current session at its tip into a persisted copy the
   *  user enters via `/resume` — the live session keeps running untouched. */
  forkSession(): Promise<boolean>
  /** Switch the live agent to a persisted session, replaying its history. */
  resumeTo(sessionId: string): Promise<ResumeResult>
  /** Start a fresh conversation (`/new`): a brand-new agent + session, the
   *  transcript cleared, the resume marker forgotten. */
  newSession(): Promise<boolean>
  /** Workspace targets contributed by the TUI and optional providers. */
  listWorkspaces(): Promise<readonly TuiWorkspaceTarget[]>
  /** Resolve an absolute path, file URL, or provider URI. */
  resolveWorkspace(reference: string): Promise<TuiWorkspaceTarget | undefined>
  /** Start a fresh session in the selected workspace. */
  switchWorkspace(target: TuiWorkspaceTarget): Promise<boolean>
  /** Rename the current durable workspace. */
  renameWorkspace(title: string): Promise<boolean>
  /** Provider-owned workspace subcommands. */
  workspaceCommands(): readonly Pick<TuiWorkspaceCommand, 'name' | 'aliases' | 'description'>[]
  runWorkspaceCommand(name: string, input: string): Promise<TuiWorkspaceCommandResult | undefined>
  /** Switch the live model (`/model` picker): forks the conversation at its
   *  current end and continues it with a new agent routed to `provider`/`model`.
   *  The history replays unchanged; only the request route changes. */
  switchModel(provider: string, model: string): Promise<boolean>
  /** The live route's effort levels + adapter default for the `/effort`
   *  slider; empty `efforts` after notifying when unsupported/unavailable. */
  listEfforts(): Promise<{ efforts: readonly EffortOption[]; defaultEffort: string | undefined }>
  /** Set one effort level by id (validated against the adapter list);
   *  false + a notify when the id is not offered. Persists like the old
   *  Shift+Tab cycle (~/.dsh-tui/effort.json). */
  setEffort(id: string): Promise<boolean>
  /** The session mode currently in force (matched from the session log, or
   *  the last one Shift+Tab applied). */
  readonly mode: SessionModeSpec
  /** Index of `mode` in the configured cycle; 0 is the unmarked base mode. */
  readonly modeIndex: number
  /** Shift+Tab: advance to the next configured session mode. */
  cycleMode(): Promise<void>
  /** Read the official permission preset roster and current identity. */
  permissionPresets(): PermissionPresetSnapshot
  /** The preset the CURRENT session runs under (issue #8), resolved from its
   *  log at create/resume time; undefined when no roster is mounted. */
  readonly agentPreset: string | undefined
  /** The roster's presets for the `/preset` picker (empty without a roster). */
  listPresets(): Promise<readonly PresetOption[]>
  /** Switch the agent preset (`/preset`): a blank session swaps composition
   *  in place (official `recompose` + logged `agent-preset/selected`); a
   *  started session is locked, so the choice persists as the default for
   *  future sessions instead. False when the roster is absent, the id is
   *  unknown/broken, or a turn is running. */
  switchPreset(presetId: string): Promise<boolean>
  /** Reset the visible transcript (`/clear`). */
  clear(): void
  /**
   * Re-render rows older than the current in-memory window from the session
   * log (rows beyond {@link ChannelState.rows}' cap are folded away; this
   * restores them for review). Returns the number of rows restored, 0 when
   * the whole log is already materialized.
   */
  loadOlder(): number
  /** Push a transient notification above the prompt input. Returns an
   *  early-dismiss handle (the auto-timeout still runs as the backstop). */
  notify(text: string, options?: { color?: NotificationItem['color']; timeoutMs?: number }): () => void
  /** Switch the working-activity indicator preset (`/activity`): validates
   *  the name, persists it to `~/.dsh-tui/working-activity.json`, and
   *  re-renders the indicator immediately; false when the name is unknown
   *  or the preference cannot be written. */
  setActivityFrames(name: string): boolean
  /** Advertised models across every registered provider route (empty when the LLM service is absent). */
  listModels(): Promise<readonly LlmModelInfo[]>
  /** Provider display identities for the same routes (picker group labels). */
  listProviders(): Promise<readonly LlmProviderInfo[]>
  /** Drop the `/model <provider/id>` completion cache so the next `/model `
   *  refetch reflects a provider-catalog change (`/provider` add/edit/delete,
   *  OAuth sign-in/out) — the same consistency the picker's per-open refetch
   *  already provides. */
  invalidateModelCompletion(): void
  /** The live agent's full skill catalog for `/skills` (issue #204) — name,
   *  description, invocation flags and source bucket. Undefined on a failed
   *  or incomplete registry read (the picker shows an error); empty only
   *  when no registry is mounted or it genuinely holds nothing. */
  listSkills(): Promise<readonly SkillInfo[] | undefined>
  /** Safe credential metadata for `/login`; undefined without the service. */
  describeCredential(ref: string): Promise<CredentialStatus | undefined>
  /** DeepSeek official account balance for `/balance`: resolves
   *  `DEEPSEEK_API_KEY` through the credentials seam (env fallback) and
   *  queries the official balance endpoint. The key is used only for the
   *  request header — never logged, printed or persisted. */
  balanceInfo(): Promise<BalanceResult>
  /** Runtime capabilities for the `/provider` wizard, over the settings /
   *  credentials / llm seams; undefined when the composition lacks them
   *  (bare cordis.yml start without the dsh-base services). */
  providerSetup(): ProviderSetupHost | undefined
  /** OAuth sign-in states from a mounted dsh-auth-style plugin; undefined
   *  without the plugin, so `/login` renders exactly what it did before. */
  oauthProviderStatuses(): Promise<readonly OAuthProviderStatus[] | undefined>
  /**
   * Runtime capabilities for the `/settings` screen, over the settings /
   * credentials seams; undefined when the composition lacks the settings
   * service (the screen then renders plugin sections as unavailable and
   * namespaces read-only).
   */
  settingsHost(): SettingsHost | undefined
  /** Plugin-declared settings sections from the `tuiSettingsSections` seam
   *  (empty when the seam or every provider is absent). */
  settingsSections(): readonly TuiSettingsSection[]
  /** Subscribe to settings-section register/unregister events. */
  subscribeSettingsSections(listener: () => void): () => void
  /** Structured `@` file completion, using the session's remote fs service. */
  listFileCandidates(query: string, options?: { signal?: AbortSignal; topK?: number }): Promise<readonly FileCandidate[]>
  /** Backward-compatible top-level/recursive listing. */
  listFiles(): Promise<readonly string[]>
  /** Every session the persistence backend stores, classified and unfiltered
   *  — the browser (`/resume`) decides which of them a given view shows. */
  listSessions(): Promise<readonly SessionSummary[]>
  /** Trailing exchanges of a persisted session, for the browser's preview. */
  previewSession(sessionId: string): Promise<readonly PreviewEntry[]>
  /** Mark a session for `dsh-tui --resume` on the next launch. */
  setResumeTarget(sessionId: string): void
  /** Rename the current session (CC's /rename): appends a `session/title`
   *  event, which the status line and the /resume picker both read. */
  renameSession(title: string): void
  /** Set the current session's accent color (`/color <name>`): appends a
   *  `session/color` event; '' clears it back to the theme default. */
  setSessionColor(color: string): void
  /** Generate a recap of the session's recent activity (`/recap`): one
   *  tool-less LLM call over the tail exchanges, returning a one-line
   *  summary plus an optional proposed title. The answer is pure UI state
   *  and never enters the session log. */
  recapRecent(options?: { signal?: AbortSignal; onText?: (delta: string) => void }): Promise<RecapOutcome>
  /** Delete a persisted session (`/resume` picker ctrl+d): removes its log
   *  directory, its last-used entry, and the resume marker when it points
   *  here. False for the live session or a missing/unwritable log. */
  deleteSession(sessionId: string): Promise<boolean>
  /** Rename any persisted session (`/resume` picker ctrl+r): appends a
   *  `session/title` event to its log (live sessions go through the normal
   *  rename path). False when the log is absent or undecodable. */
  renameSessionTo(sessionId: string, title: string): Promise<boolean>
  /** Manually compact the session history (CC's /compact); no-op notify when the leaf lacks a compaction service. */
  compact(): void
  /** Render a multi-line local report in the transcript (`/status`,
   *  `/doctor`, …): a `local` row plus one `local-output` row per line. */
  pushLocal(title: string, lines: readonly string[]): void
  /** MCP server/tool status for /mcp: one line per server, or setup guidance. */
  mcpStatus(): string[]
  /** Write the conversation transcript to `dsh-tui-export-<ts>.md` in the
   *  session cwd; returns the written path, or null on failure. */
  exportSession(): string | null
  /** Create `AGENTS.md` in the session cwd (DSH workspace-context file);
   *  returns the path, `'exists'` when already present, or null on failure. */
  initWorkspace(): string | null
  /** Environment diagnostics for `/doctor`. */
  doctorInfo(): string[]
  /** Plugin contract/grant/ledger diagnostics for `/plugins` (C-070 trust
   *  banner first line; `check <path>` runs validatePlugin + negotiate). */
  pluginsInfo(args: string): string[]
  /** Subagent rows for `/agents` (DSH subagent service; empty message when
   *  the service is absent). */
  listSubagents(): Promise<string[]>
  /**
   * The agent view (CC's `claude agents`) row snapshot: every live agent in
   * this process plus every persisted session that no live agent owns,
   * ordered needs-input/working first, then most recently active. Reading it
   * is cheap; subscribe for changes.
   */
  agentViewRows(): readonly AgentViewRow[]
  /** Change feed for {@link agentViewRows}: fired on agent lifecycle/status
   *  changes and — throttled — on session events of background agents. */
  subscribeAgentView(listener: () => void): () => void
  /**
   * Dispatch a new background session (`agent view` input): creates an agent
   * in this process, delivers the prompt as a user message, and keeps the
   * TUI attached to its current session. The new session keeps running until
   * it finishes its turn or is stopped — it lives only while this process
   * does.
   */
  dispatchBackgroundAgent(prompt: string): Promise<AgentViewDispatchResult>
  /** Stop a background session (Ctrl+X): abort its turn and dispose its
   *  agent; the persisted log survives for resume. False for the attached
   *  session or one this TUI does not own. */
  stopBackgroundAgent(sessionId: string): Promise<boolean>
  /**
   * Attach the TUI terminal to a session (`agent view` Enter/→): a live
   * agent is adopted in place (its handle becomes the channel's), a
   * persisted one resumes through the persistence seam. The previously
   * attached agent is NOT disposed — it keeps running as a background
   * session unless it was already idle with no history.
   */
  attachToAgent(sessionId: string): Promise<ResumeResult>
  /** Trailing exchanges of any session — the live agent's in-memory log when
   *  it is alive in this process, the persisted artifact otherwise. */
  peekAgentSession(sessionId: string): Promise<readonly PreviewEntry[]>
  /** `/bg` — background the attached session: swap the TUI to a fresh agent
   *  while the current one keeps running. The agent view lists it as a
   *  background session; `backgroundedSessionId` is the move's return target
   *  (CC's "Esc returns to that conversation"). */
  backgroundCurrent(): Promise<BackgroundResult>
  /** Send a follow-up user message to a session from the agent view's peek
   *  panel. Live sessions receive it directly; a session no live agent owns
   *  cannot take a reply (false + a notify to attach instead). */
  replyToAgent(sessionId: string, text: string): Promise<boolean>
  /**
   * Dispose the host-registry entries this channel registered (skill slash
   * commands).
   *
   * `commandService.register` binds the registration to ITS own context, not
   * the caller's, so the entries outlive this channel unless released: after a
   * launcher recompose the stale registrations would still answer, but the
   * fresh channel would see the names taken and stop managing them, freezing
   * the menu. The plugin calls this from its teardown effect, where the real
   * cordis context lives.
   */
  releaseContributions(): void
  /**
   * The live agent's session event log (immutable snapshot, replaced on
   * every append — dsh-session caches the frozen array) — the `/trace`
   * trajectory view's data source. Screens already re-render on `version`
   * bumps, so a view reading this per render follows live events in real
   * time; agent swaps (/resume /rewind /new) are reflected immediately.
   */
  traceEvents(): readonly SessionEvent[]
}

/** @internal */
/** One roster entry in the `/preset` picker (see {@link Channel.listPresets}). */
export interface PresetOption {
  id: string
  name?: string
  description?: string
  /** Present when the roster marked this preset unloadable (shown verbatim). */
  broken?: string
  isDefault: boolean
}

export type PermissionPresetAvailability = 'runtime' | 'legacy' | 'unavailable'

export interface PermissionPresetOption {
  readonly value: string
  readonly name: string
  readonly description?: string
}

export interface PermissionPresetCurrent {
  readonly value: string
  readonly name: string
  readonly description?: string
  readonly kind: 'preset' | 'custom'
}

/**
 * Adapter-owned permission roster snapshot. `options` never contains the
 * official `custom` sentinel; it is represented only by `current`.
 */
export interface PermissionPresetSnapshot {
  readonly availability: PermissionPresetAvailability
  readonly options: readonly PermissionPresetOption[]
  readonly current?: PermissionPresetCurrent
}

/** @internal */
/** One user message submitted while the model was working, not yet claimed
 *  by a turn. `steer` lands at the next step boundary of the running turn;
 *  `followup` waits for the turn to end. */
export interface PendingMessage {
  id: string
  text: string
  placement: 'steer' | 'followup'
}

/**
 * Mutable channel state owned by {@link createChannel}: the screen's
 * reactive store. Screens subscribe and re-render on `version` bumps; the
 * fields mirror the public {@link Channel} contract, and the `@internal`
 * emit hooks belong to the implementation.
 */
/** One adapter-owned reasoning-effort level for the `/effort` slider. */
export interface EffortOption {
  id: string
  name: string
  description?: string
}

export interface ChannelState {
  version: number
  rows: ChatRow[]
  status: AgentStatus | 'starting' | 'disposed'
  sessionTitle: string
  sessionColor: string
  autoRecapOnOpen: boolean
  agentId: string
  /** TUI-owned generation that changes on every live Agent rebind. */
  agentBindingGeneration: number
  model: string
  provider: string
  tokens: TokenUsage
  cwd: string
  displayCwd: string
  gitBranch: string | undefined
  working: boolean
  /** Whether a requested abort is still converging (see the public Channel type). */
  cancelPending: boolean
  spinnerMode: SpinnerMode
  responseChars: number
  activeToolCount: number
  turnStart: number
  lastUserText: string
  notifications: NotificationItem[]
  /** Adapter-advertised context capacity for the model route, when known. */
  contextWindow: number | undefined
  /** Reasoning effort of the latest request header, when the adapter sets one. */
  reasoningEffort: string | undefined
  /** The live route's reasoning-effort level ids, low → high. */
  effortLevels: readonly string[] | undefined
  /** Usage of the most recent request (context share + cache hits). */
  lastUsage:
    | { input: number; output: number; cacheRead: number; cacheWrite: number }
    | undefined
  /** Output tokens per second of the current/last turn's response, when known. */
  tps: number | undefined
  /** Per-turn tps samples (sparkline history), oldest first. */
  tpsSamples: { tps: number; at: number }[]
  /** Latest working-activity snapshot (see the public Channel type). */
  workingActivity: ActivityStatus | undefined
  /** Working-activity indicator preset (see the public Channel type). */
  activityFrames: string | undefined
  /** Raw cordis.yml pins `/reload` must respect (see the public Channel type). */
  configuredProvider: string | undefined
  configuredModel: string | undefined
  configuredPreset: string | undefined
  configuredActivityFrames: string | undefined
  configuredLang: string | undefined
  /** Diff presentation preference (see the public Channel type). */
  diffLayout: 'auto' | 'split' | 'unified'
  /** Thinking-block display (see the public Channel type). */
  thinkingFold: 'preview' | 'full'
  /** Tool-card background treatment (see the public Channel type). */
  toolBackground: ToolBackground
  /** Transcript gutter mode (see the public Channel type). */
  scrollGutter: ScrollGutterMode
  /** Root page inset setting (see the public Channel type). */
  pageMargin: PageMarginSetting
  /** Terminal-card header folding (see the public Channel type). */
  foldTerminalCommand: boolean
  /** Session-name chip on the prompt border (see the public Channel type). */
  promptSessionLabel: boolean
  /** Fullscreen draft editor gate (see the public Channel type). */
  expandEditor: boolean
  /** Smooth streaming reveal (see the public Channel type). */
  smoothStreaming: boolean
  /** Status-footer preferences (see the public Channel type). */
  statusBar: StatusBarConfig
  /** Apply a diff-layout change (see the public Channel type). */
  setDiffLayout(layout: 'auto' | 'split' | 'unified'): void
  /** Apply a thinking-display change (see the public Channel type). */
  setThinkingFold(mode: 'preview' | 'full'): void
  /** Apply a tool-card background change. */
  setToolBackground(background: ToolBackground): void
  /** Apply a transcript gutter mode change. */
  setScrollGutter(mode: ScrollGutterMode): void
  /** Apply a root page-inset setting change (drives the PageMargin box). */
  setPageMargin(setting: PageMarginSetting): void
  /** Apply a terminal-card header folding change. */
  setFoldTerminalCommand(enabled: boolean): void
  /** Apply a prompt session-name chip change. */
  setPromptSessionLabel(enabled: boolean): void
  /** Apply a fullscreen-editor gate change. */
  setExpandEditor(enabled: boolean): void
  /** Apply a smooth-streaming reveal change. */
  setSmoothStreaming(enabled: boolean): void
  /** Apply status-footer preference changes. */
  setStatusBar(config: Partial<StatusBarConfig>): void
  /** Whale header art switch (see the public Channel type). */
  whale: boolean
  /** Idle whale behaviors switch (see the public Channel type). */
  whaleIdle: boolean
  /** Apply a whale-visibility change (see the public Channel type). */
  setWhale(visible: boolean): void
  /** Apply an idle-whale-behavior change (see the public Channel type). */
  setWhaleIdle(enabled: boolean): void
  minimal: boolean
  /** Apply a minimal-mode change (see the public Channel type). */
  setMinimal(enabled: boolean): void
  /** Working-activity display switch (see the public Channel type). */
  activityEnabled: boolean
  /** Context bar row switch (see the public Channel type). */
  contextBarEnabled: boolean
  /** Current same-session goal projection (see the public Channel type). */
  goal: ChannelGoal | undefined
  /** Latest todo-list snapshot (see the public Channel type). */
  todos: TodoPanelItem[]
  /** Loaded-context snapshot (see the public Channel type). */
  loadedContext: LoadedContext | undefined
  /** Messages submitted while working, awaiting their turn/step boundary.
   *  Driven by agent inbox events (inserted/claimed/discarded). */
  pending: PendingMessage[]
  /** 侧问（见 public Channel.sideQuestion）。 */
  sideQuestion(
    question: string,
    options?: { signal?: AbortSignal; onText?: (delta: string) => void },
  ): Promise<{ answer: string | null; error?: string }>
  /** 会话 recap（见 public Channel.recapRecent）。 */
  recapRecent(
    options?: { signal?: AbortSignal; onText?: (delta: string) => void },
  ): Promise<RecapOutcome>
  /** 会话强调色（见 public Channel.setSessionColor）。 */
  setSessionColor(color: string): void
  /** Effective slash commands (see the public Channel type). */
  commandList: readonly LocalCommand[]
  /** Context-aware slash completions (see the public Channel type). */
  commandCompletions(input: string): readonly CommandCompletion[]
  /** Run a plugin-registered command (see the public Channel type). */
  runExternalCommand(name: string, rawInput: string): Promise<string | undefined>
  /** Open plugin scene mirrored from the scenes runtime (see the public Channel type). */
  pluginScene: TuiSceneDescriptor | undefined
  /** Open a plugin scene by id (see the public Channel type). */
  openPluginScene(id: string): boolean
  /** Close the open plugin scene (see the public Channel type). */
  closePluginScene(): void
  /** Estimated context segments by content type (pi-nano-context style bar). */
  contextSegments: {
    system: number
    prompt: number
    assistant: number
    thinking: number
    tools: number
  }
  /** Active subagents roster (see the public Channel type). */
  subagents: readonly SubagentState[]
  subagentControl: SubagentControl
  /** Background jobs of the current session (see the public Channel type). */
  backgroundJobs: readonly BackgroundJobState[]
  jobControl: JobControl
  subscribe: (listener: () => void) => () => void
  stageImage(input: StagedImageInput): Promise<string>
  /** @internal event bump (the public `notify(text)` posts a notification). */
  emit(): void
  /** @internal frame-aligned emit for high-frequency streaming deltas:
   *  version bumps synchronously but listeners fire at most once per 16ms
   *  window (trailing edge). */
  emitStream(): void
  submit(text: string): void
  steer(text: string): void
  removePending(id: string): boolean
  cancel(): void
  /** @internal interrupt-and-deliver (see the public Channel type). */
  interruptAndDeliver(texts: readonly string[]): number
  rewindTo(row: ChatRow, mode?: string | null): Promise<string | null>
  /** @internal rewind decision prompt (see the public Channel.promptRewind). */
  promptRewind(row: ChatRow): Promise<{ modes: readonly TuiRewindMode[] } | 'cancel' | null>
  /** @internal session-tree assembly (see the public Channel.buildSessionTree). */
  buildSessionTree(): Promise<SessionTreeData | null>
  /** @internal tree-entry rewind/fork (see the public Channel.rewindToNode). */
  rewindToNode(sessionId: string, seq: number, mode?: 'rewind' | 'fork'): Promise<string | null>
  /** @internal tip fork (see the public Channel.forkSession). */
  forkSession(): Promise<boolean>
  /** Switch the live agent to a persisted session, replaying its history. */
  resumeTo(sessionId: string): Promise<ResumeResult>
  /** Start a fresh conversation (`/new`). */
  newSession(): Promise<boolean>
  listWorkspaces(): Promise<readonly TuiWorkspaceTarget[]>
  resolveWorkspace(uri: string): Promise<TuiWorkspaceTarget | undefined>
  switchWorkspace(target: TuiWorkspaceTarget): Promise<boolean>
  renameWorkspace(title: string): Promise<boolean>
  workspaceCommands(): readonly Pick<TuiWorkspaceCommand, 'name' | 'aliases' | 'description'>[]
  runWorkspaceCommand(name: string, input: string): Promise<TuiWorkspaceCommandResult | undefined>
  /** Switch the live model (`/model` picker). */
  switchModel(provider: string, model: string): Promise<boolean>
  /** The route's effort levels for `/effort` (see the public Channel type). */
  listEfforts(): Promise<{ efforts: readonly EffortOption[]; defaultEffort: string | undefined }>
  /** Set one effort level by id (see the public Channel type). */
  setEffort(id: string): Promise<boolean>
  /** The session mode currently in force (see the public Channel type). */
  mode: SessionModeSpec
  /** Index of `mode` in the configured cycle (see the public Channel type). */
  modeIndex: number
  /** Shift+Tab session-mode advance (see the public Channel type). */
  cycleMode(): Promise<void>
  /** Read the official permission preset roster and current identity. */
  permissionPresets(): PermissionPresetSnapshot
  /** The preset the current session runs under (see the public Channel type). */
  agentPreset: string | undefined
  /** The roster's presets for the `/preset` picker (see the public Channel type). */
  listPresets(): Promise<readonly PresetOption[]>
  /** Switch the agent preset (see the public Channel type). */
  switchPreset(presetId: string): Promise<boolean>
  clear(): void
  /** @internal older-row restoration (see the public Channel.loadOlder). */
  loadOlder(): number
  notify(text: string, options?: { color?: NotificationItem['color']; timeoutMs?: number }): () => void
  /** Switch the working-activity indicator preset (see the public Channel). */
  setActivityFrames(name: string): boolean
  listModels(): Promise<readonly LlmModelInfo[]>
  /** Provider display identities (see the public Channel type). */
  listProviders(): Promise<readonly LlmProviderInfo[]>
  /** Drop the `/model` completion cache (see the public Channel type). */
  invalidateModelCompletion(): void
  /** The live agent's skill catalog for `/skills` (see the public Channel type). */
  listSkills(): Promise<readonly SkillInfo[] | undefined>
  /** Safe credential metadata for `/login` (see the public Channel type). */
  describeCredential(ref: string): Promise<CredentialStatus | undefined>
  /** DeepSeek official balance for `/balance` (see the public Channel type). */
  balanceInfo(): Promise<BalanceResult>
  /** `/provider` wizard capabilities (see the public Channel type). */
  providerSetup(): ProviderSetupHost | undefined
  /** OAuth sign-in states (see the public Channel type). */
  oauthProviderStatuses(): Promise<readonly OAuthProviderStatus[] | undefined>
  /** `/settings` screen capabilities (see the public Channel type). */
  settingsHost(): SettingsHost | undefined
  /** Plugin-declared settings sections (see the public Channel type). */
  settingsSections(): readonly TuiSettingsSection[]
  /** Subscribe to settings-section register/unregister events. */
  subscribeSettingsSections(listener: () => void): () => void
  listFileCandidates(query: string, options?: { signal?: AbortSignal; topK?: number }): Promise<readonly FileCandidate[]>
  listFiles(): Promise<readonly string[]>
  listSessions(): Promise<readonly SessionSummary[]>
  /** Trailing exchanges of a persisted session (see the public Channel type). */
  previewSession(sessionId: string): Promise<readonly PreviewEntry[]>
  setResumeTarget(sessionId: string): void
  /** Rename the current session (see the public Channel type). */
  renameSession(title: string): void
  /** Delete a persisted session (see the public Channel type). */
  deleteSession(sessionId: string): Promise<boolean>
  /** Rename any persisted session (see the public Channel type). */
  renameSessionTo(sessionId: string, title: string): Promise<boolean>
  /** Manually compact the session history (CC's /compact). */
  compact(): void
  /** Multi-line local report (`/status`, `/doctor`, …). */
  pushLocal(title: string, lines: readonly string[]): void
  /** MCP server/tool status for /mcp: one line per server, or setup guidance. */
  mcpStatus(): string[]
  /** Export the transcript to a markdown file (CC's /export). */
  exportSession(): string | null
  /** Create `AGENTS.md` in the session cwd (CC's /init). */
  initWorkspace(): string | null
  /** Environment diagnostics (CC's /doctor). */
  doctorInfo(): string[]
  /** Plugin diagnostics (/plugins); see the public Channel type. */
  pluginsInfo(args: string): string[]
  /** Subagent rows (CC's /agents). */
  listSubagents(): Promise<string[]>
  /** See {@link Channel.agentViewRows}. */
  agentViewRows(): readonly AgentViewRow[]
  /** See {@link Channel.subscribeAgentView}. */
  subscribeAgentView(listener: () => void): () => void
  /** See {@link Channel.dispatchBackgroundAgent}. */
  dispatchBackgroundAgent(prompt: string): Promise<AgentViewDispatchResult>
  /** See {@link Channel.stopBackgroundAgent}. */
  stopBackgroundAgent(sessionId: string): Promise<boolean>
  /** See {@link Channel.attachToAgent}. */
  attachToAgent(sessionId: string): Promise<ResumeResult>
  /** See {@link Channel.peekAgentSession}. */
  peekAgentSession(sessionId: string): Promise<readonly PreviewEntry[]>
  /** See {@link Channel.backgroundCurrent}. */
  backgroundCurrent(): Promise<BackgroundResult>
  /** See {@link Channel.replyToAgent}. */
  replyToAgent(sessionId: string, text: string): Promise<boolean>
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

const ARGS_PREVIEW_LIMIT = 160
const RESULT_PREVIEW_LIMIT = 240

/** Local `!`-command output cap (mirrors the result preview limit). */
const LOCAL_OUTPUT_LIMIT = 240

/**
 * In-memory transcript window cap. Older rows beyond this count are FOLDED:
 * their full-text fields (assistant/reasoning text, tool args/results) are
 * dropped and only the preview/status metadata kept, so a long merge/deploy
 * turn cannot grow the TUI's RAM without bound. The session log remains the
 * complete source of truth (`/export` reads it, `/resume` replays it); the
 * folded row keeps its kind/id so scrolling and selection stay stable.
 */
const MAX_ROWS = 600

function preview(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * Fold the oldest rows beyond the transcript window cap: drop each row's
 * full-text fields (assistant/reasoning text, tool args/results) and keep
 * only its preview text, kind, id, and seq. Bounds the TUI's retained text
 * without touching the session log (the source of truth for /export and
 * loadOlder). Small local/notice/interrupt rows are left intact (they hold
 * terminal-local text the log cannot restore). Restored rows are exempt so
 * a loadOlder() restore is not instantly undone. Returns the number of rows
 * folded.
 */
function foldRows(
  rows: ChatRow[],
  cap: number,
  cursor?: { rows: unknown; index: number },
): number {
  const excess = rows.length - cap
  if (excess <= 0) {
    if (cursor !== undefined) cursor.index = 0
    return 0
  }
  // Incremental pass: rows only ever append past the fold line and the
  // folded/restored exemptions are permanent, so everything below a cursor
  // over the SAME array identity needs no re-inspection. emit/emitStream
  // fold on every frame during streaming — a full rescan of a long window
  // there was the O(rows) per-frame term of long-session streaming.
  const from = cursor === undefined ? 0 : cursor.rows === rows ? cursor.index : 0
  if (cursor !== undefined) cursor.rows = rows
  if (excess <= from) return 0
  let folded = 0
  for (const row of rows.slice(from, excess)) {
    if (row.folded || row.restored) continue
    if (row.kind !== 'user' && row.kind !== 'assistant' && row.kind !== 'reasoning' && row.kind !== 'tool') continue
    row.folded = true
    folded += 1
    if (row.kind === 'tool' && row.tool) {
      row.tool.argsFull = undefined
      row.tool.resultFull = undefined
      row.tool.errorText = undefined
      // Presentation views hold duplicated content strings (diff before/
      // after images, terminal output); the session log re-derives them.
      row.tool.callView = undefined
      row.tool.resultView = undefined
    } else if (row.text.length > 0) {
      // Keep a short preview so the transcript reads naturally; the full
      // text lives in the session log and is restored by loadOlder().
      row.text = preview(row.text, 200)
    }
  }
  if (cursor !== undefined) cursor.index = excess
  return folded
}

/**
 * Restore folded rows from the session log, newest folded batch first.
 * Rebuilds each folded row's full text from its source events and clears
 * the folded mark, keeping row ids, scroll anchors, and selection stable.
 * `views` re-derives the tool presentation views foldRows dropped (the
 * presenters live on the host plane, so the channel passes them in).
 * Returns the number of rows restored.
 */
function foldBack(rows: ChatRow[], events: readonly SessionEvent[], views?: ToolViewPresenter): number {
  const folded = rows.filter(row => row.folded)
  if (folded.length === 0) return 0
  const firstFoldedSeq = folded[0]?.seq ?? 0
  const restoreEvents = events.filter(event => event.seq >= firstFoldedSeq)
  // tool results are matched by callId, not seq, because the result event
  // seq differs from the call event seq that anchored the row.
  const resultsByCall = new Map<string, SessionEvent<'tool/result'>>()
  for (const event of restoreEvents) {
    if (event.type === 'tool/result') {
      resultsByCall.set(event.data.message.source.callId, event)
    }
  }
  let restored = 0
  for (const row of folded) {
    const rowSeq = row.seq
    if (rowSeq === undefined) continue
    if (row.kind === 'tool' && row.tool !== undefined) {
      // The tool row is anchored on its tool/call seq; its result text comes
      // from the matching tool/result event.
      const call = restoreEvents.find(event => event.seq === rowSeq && event.type === 'tool/call')
      if (call === undefined || call.type !== 'tool/call') continue
      restoreRowFromEvent(row, call)
      const result = resultsByCall.get(row.tool.callId)
      if (result !== undefined) restoreToolResult(row, result)
      row.tool.callView = views?.call(call.data.name, call.data.arguments)
      row.tool.resultView = result !== undefined && result.data.error === undefined
        ? views?.result(call.data.name, call.data.arguments, result.data)
        : undefined
      row.folded = false
      restored += 1
      continue
    }
    // Text rows are anchored on their first delta chunk; the settled
    // assistant/message at or after that seq carries the full text.
    const message = restoreEvents.find(event => event.seq >= rowSeq && event.type === 'assistant/message')
    if (message === undefined) continue
    restoreRowFromEvent(row, message)
    row.folded = false
    restored += 1
  }
  return restored
}

/** Rebuild a folded row's full text from its source session event. */
function restoreRowFromEvent(row: ChatRow, event: SessionEvent): void {
  switch (row.kind) {
    case 'user': {
      if (event.type !== 'user/message') break
      const text = event.data.content.map(block => block.type === 'text' ? block.text : '').join('').trim()
      if (text) row.text = text
      break
    }
    case 'assistant': {
      if (event.type !== 'assistant/message') break
      const text = event.data.message.content.map(block => block.type === 'text' ? block.text : '').join('').trim()
      if (text) row.text = text
      break
    }
    case 'reasoning': {
      // Thinking text is carried by the assistant/message's reasoning
      // blocks, not the (ephemeral) delta chunks, so the settled message
      // restores it exactly.
      if (event.type !== 'assistant/message') break
      const text = event.data.message.content.map(block => block.type === 'reasoning' ? block.text : '').join('').trim()
      if (text) row.text = text
      break
    }
    case 'tool': {
      if (event.type !== 'tool/call' || row.tool === undefined) break
      row.tool.argsFull = event.data.arguments
      break
    }
    default:
      break
  }
}

/** Render the durable tool-result payload, including provider error details. */
function toolResultText(event: SessionEvent<'tool/result'>): string {
  const block = event.data.message.content[0]
  if (block === undefined || block.type !== 'tool-result') return ''
  return block.content.map(item => item.type === 'text' ? item.text : '').join('').trim()
}

/** Phase badge for the harness goal card — mirrors the panel's PhaseBadge. */
const GOAL_RESULT_BADGE: Record<string, string> = {
  active: '● active',
  paused: '⏸ paused',
  blocked: '⛔ blocked',
  complete: '✓ complete',
}

/**
 * Summary cards for the harness's goal/todo tools. Their results are machine
 * JSON (`{"goal":{…}}` / `{"todos":[…]}`) that would otherwise dump under the
 * tool card as a raw `⎿ {"goal":…}` line. Matched by tool-name substring AND
 * payload shape, so unrelated tools and plain-text results pass through to
 * the registry/raw-text path untouched. Runs on the live stream and replay.
 */
function harnessToolResultView(
  name: string,
  data: SessionEvent<'tool/result'>['data'],
): ToolResultView | undefined {
  const lower = name.toLowerCase()
  const isGoalTool = lower.includes('goal')
  const isTodoTool = lower.includes('todo')
  if (!isGoalTool && !isTodoTool) return undefined
  const block = data.message.content[0]
  if (block === undefined || block.type !== 'tool-result') return undefined
  const text = block.content.map(item => item.type === 'text' ? item.text : '').join('').trim()
  if (text === '' || !text.startsWith('{')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>

  if (isGoalTool && typeof record.goal === 'object' && record.goal !== null) {
    const goal = record.goal as Record<string, unknown>
    if (typeof goal.objective === 'string' && typeof goal.phase === 'string') {
      const badge = GOAL_RESULT_BADGE[goal.phase] ?? goal.phase
      const rounds = typeof goal.roundsStarted === 'number' && typeof goal.maxGoalRounds === 'number'
        ? ` · ${goal.roundsStarted}/${goal.maxGoalRounds}`
        : ''
      const activation = typeof record.activation === 'string' ? ` · ${record.activation}` : ''
      const lines = [`🎯 ${goal.objective}`, `${badge}${rounds}${activation}`]
      const blocked = (goal.blockedReason as { message?: unknown } | undefined)?.message
      if (typeof blocked === 'string') lines.push(`⛔ ${blocked}`)
      return { card: 'generic', content: lines.map(line => ({ type: 'text', text: line })) }
    }
  }

  if (isTodoTool && Array.isArray(record.todos)) {
    const rows = record.todos as Array<Record<string, unknown>>
    const done = rows.filter(row => row.status === 'completed').length
    const lines = [`todos ✓ ${done}/${rows.length}`]
    for (const row of rows) {
      if (row.status !== 'in_progress' || typeof row.content !== 'string') continue
      lines.push(`● ${row.content}`)
      if (lines.length >= 4) break
    }
    return { card: 'generic', content: lines.map(line => ({ type: 'text', text: line })) }
  }

  return undefined
}

function toolErrorText(event: SessionEvent<'tool/result'>): string {
  const failure = event.data.error
  if (failure === undefined) return ''
  const identity = `${failure.name}: ${failure.code}`
  const detail = toolResultText(event)
  return detail === '' || detail === identity ? identity : `${identity} — ${detail}`
}

/** Restore a folded tool row's result text from its tool/result event. */
function restoreToolResult(row: ChatRow, event: SessionEvent<'tool/result'>): void {
  if (row.tool === undefined) return
  const failure = event.data.error
  if (failure !== undefined) {
    row.tool.status = 'error'
    row.tool.errorText = toolErrorText(event)
    return
  }
  row.tool.status = 'ok'
  const result = toolResultText(event)
  row.tool.resultFull = result || undefined
}


/**
 * Prepare durable events for REPLAY (resume / rewind / model-switch fork):
 * drop settled `assistant/chunk` stream deltas — the sealed
 * `assistant/message` events carry the full text and reasoning blocks, so
 * per-token chunks add nothing to the replayed transcript while costing a
 * per-chunk renderEvent pass (a real 4.5MB session logs ~19k chunks against
 * ~30 messages). The trailing chunk run AFTER the last message belongs to an
 * unfinished step (crash-orphaned turn) and is kept, so a resumed session
 * still shows its partial content. Storage-level packed rows
 * (`text-chunks`/`reasoning-chunks`/`tool-call-chunks`) are dropped the
 * same way — defensive: the jsonl reader expands them, but a future
 * direct-pass path must not resurrect them. Replay-side tps sampling is
 * lost with the chunks (a live metric; lastUsage comes from the message's
 * own usage). Live events never go through this.
 */
function prepareReplayEvents(events: readonly SessionEvent[]): SessionEvent[] {
  let lastMessageSeq = -1
  for (const event of events) {
    if (event.type === 'assistant/message') lastMessageSeq = event.seq
  }
  return events.filter(event => {
    if (event.type === 'assistant/message') return true
    if (event.type === 'assistant/chunk') {
      // Keep only the in-flight tail (no message sealed after it).
      return lastMessageSeq < 0 || event.seq > lastMessageSeq
    }
    // Storage-level packed rows: not in the SessionEvent union (they exist
    // only in the durable JSON), so compare through a widened view — the
    // defensive drop is exactly for data the static type doesn't know.
    const packedType = (event as { type: string }).type
    if (
      packedType === 'text-chunks' ||
      packedType === 'reasoning-chunks' ||
      packedType === 'tool-call-chunks'
    ) {
      return false
    }
    return true
  })
}

/** Buffer below the context window at which CC warns (autoCompact.ts). */
const CONTEXT_WARNING_BUFFER_TOKENS = 20_000

/** How many trailing exchanges the browser's preview pane asks for. */
const PREVIEW_ENTRIES = 8

/** Resolve once a `turn/end` event newer than `fromSeq` lands in the session
 *  log (Agent.cancel closes the turn asynchronously), or when the timeout
 *  expires. Polling the session log is race-free here: fork reads the same
 *  append-only log. */
async function waitForTurnEnd(
  session: unknown,
  fromSeq: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const last = snapshotLiveSessionEvents(session).at(-1)
    if (last !== undefined && last.type === 'turn/end' && last.seq >= fromSeq) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return false
}

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
    /** Indicator preset for the working-activity line (`claude`/`moon`/
     *  `comet`/`dots`/… or `random`); default `claude`. */
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
  let agent = initialAgent
  let currentHandle: AgentHandle | undefined = options.handle
  const themeHost = getHostThemes(ctx.get('tuiThemes') as TuiThemeRuntime | undefined)

  // ── agent view (CC's `claude agents`) internal state ──────────────────────
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
        runtime.interrupt(target, { kind: 'ancestor', agent })
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
  const fallbackGrantStore = readGrantStore()
  const currentGrantStore = (): ReturnType<typeof readGrantStore> =>
    ctx.get('tuiPluginHost')?.grants ?? fallbackGrantStore
  installDecisionGuard(ctx, currentGrantStore())
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
          id: nextRowId++,
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
    }
  }
  const jobStore = new BackgroundJobStore({
    onSettled(job) {
      state.notify(
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
        jobs.kill(id, agent, 'dsh-tui /jobs panel')
      } catch {
        return false
      }
      // kill() marks the job reported, which SUPPRESSES the harness
      // completion notice — without this steer the model only learns about
      // the user's kill lazily, from its next job_list/job_output read.
      // Steer only for a job that was actually live; the steering row
      // doubles as the transcript record of the action.
      if (job !== undefined && (job.status === 'running' || job.status === 'stopping')) {
        state.steer(t('jobs-steer-killed', { id, label: job.label }))
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
        jobStore.replace(jobs.list(agent))
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
          id: nextRowId++,
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
  let settingsHostCache: SettingsHost | undefined
  let settingsHostResolved = false
  // Plugin scene runtime (optional service, same degradation rule as
  // tuiWorkspaces/tuiCommandTrees): mounted by the bundle patch's
  // dsh-tui-scenes row; absent the row, `pluginScene` simply stays undefined.
  const sceneRuntime = getHostSceneRuntime(ctx.get('tuiScenes') as TuiSceneRuntime | undefined)
  // Falls back to the in-package local host when the composition's service
  // row is unavailable (issue #557: the row can be disposed right after
  // load in real compositions); the TUI's own section registers there.
  const settingsSectionsRuntime = getHostSettingsSections(
    ctx.get('tuiSettingsSections') as TuiSettingsSectionsRuntime | undefined,
  ) ?? getLocalSettingsSectionsHost()
  // Custom-entry text renderers (optional service, dsh-tui-extensions row):
  // absent the row, unknown plugin event types stay invisible in the
  // transcript, exactly as before the seam existed.
  const rendererRuntime = getHostRenderers(ctx.get('tuiRenderers') as TuiRendererRuntime | undefined)
  // Shift+Tab session-mode cycle: cordis.yml `modes` wins; absent/empty/
  // atom-less → the built-in default/plan/full cycle (sessionModes.ts).
  const { modes: sessionModes, dropped: droppedModeIds } = resolveSessionModes(options.modes)
  if (droppedModeIds.length > 0) {
    ctx.logger.warn(
      `dsh-tui: session modes ${droppedModeIds.map(id => `"${id}"`).join(', ')} declare no plan/sandbox/approval atom; dropped from the Shift+Tab cycle`,
    )
  }
  const listeners = new Set<() => void>()
  /** True while a frame-aligned stream notification is pending (emitStream). */
  let streamNotifyScheduled = false
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
  const flushSubagentStream = (): void => {
    if (!subagentStreamDirty) return
    subagentStreamDirty = false
    state.subagents = subagentStore.snapshot()
    syncSubagentRows(state.subagents)
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
  let nextNotificationId = 1
  /** One-shot context-low warning per session (CC's TokenWarning). */
  let contextWarned = false
  const checkContextWarning = (): void => {
    if (contextWarned || state.contextWindow === undefined) return
    const remaining = state.contextWindow - state.tokens.input
    if (remaining >= CONTEXT_WARNING_BUFFER_TOKENS) return
    contextWarned = true
    const percentLeft = Math.max(
      0,
      Math.round((remaining / state.contextWindow) * 100),
    )
    state.notify(
      t('context-low-warning', { percent: percentLeft }),
      { color: 'warning', timeoutMs: 8000 },
    )
  }
  /**
   * Register a submitted message as pending and notify the UI. The inbox
   * events (claimed/discarded) retire it; nothing here guesses timing.
   */
  const trackPending = (message: { id: string; text: string }, placement: PendingMessage['placement']): void => {
    state.pending = [...state.pending, { id: message.id, text: message.text, placement }]
    state.emit()
  }
  /** Remove one pending entry (rollback on a refused send, steering
   *  rejection, or delivery races) and notify only when it existed. */
  const untrackPending = (messageId: string): void => {
    const before = state.pending.length
    state.pending = state.pending.filter(item => item.id !== messageId)
    if (state.pending.length !== before) state.emit()
  }
  /**
   * `@` file mentions (issue #15): expansion reads files asynchronously, so
   * every user-text delivery (submit / steer / interrupt-requeue) funnels
   * through this chain to keep the send order FIFO.
   */
  let sendChain: Promise<void> = Promise.resolve()
  let stagedImageSequence = 0
  const stagedImages = new Map<string, ChannelImageBlock['attachment']>()
  const clearStagedImages = (): void => {
    stagedImages.clear()
    stagedImageSequence = 0
  }
  /**
   * Expand the text's `@` mentions and deliver ONE user message: the typed
   * text stays the first content block (the transcript bubble renders it —
   * never the file dump) and each resolved reference appends a model-facing
   * attachment block. The pending preview tracks the typed text.
   */
  const deliverUserText = (text: string, placement: PendingMessage['placement']): void => {
    sendChain = sendChain.then(async () => {
      const expansion = await expandMentions(
        mentionFs(ctx),
        state.cwd,
        text,
        mentionAttachments(ctx),
        stagedImages,
      )
      const message = createUserMessage({
        content: expansion.blocks,
        source: { kind: 'user' },
      })
      // Track BEFORE the agent call: a synchronous throw inside
      // followup/steer rolls the preview back; otherwise the inbox events
      // retire it once the message is claimed or discarded.
      trackPending({ id: message.id, text }, placement)
      try {
        if (placement === 'steer') agent.steer(message)
        else agent.followup(message)
      } catch (error) {
        untrackPending(message.id)
        throw error
      }
      if (expansion.attached.length > 0) {
        state.notify(t('mentions-attached', { count: expansion.attached.length }), { timeoutMs: 2500 })
      }
      if (expansion.missing.length > 0) {
        state.notify(t('mentions-missing', { paths: expansion.missing.map(path => `@${path}`).join(' ') }), {
          color: 'warning',
          timeoutMs: 4000,
        })
      }
    }).catch((error: unknown) => {
      // The chain must survive a failed send: log and notify, then continue
      // with the next queued delivery.
      const message = error instanceof Error ? error.message : String(error)
      logForDebugging(`submit: delivery failed (${message})`)
      state.notify(t('send-failed', { err: message }), { color: 'error' })
    })
  }
  /**
   * RFC 0005 D-8: a flow parked on a plugin decision must be user-observable.
   * Decisions normally resolve in milliseconds, so the notice only fires
   * once the wait crosses a threshold — a slow plugin (e.g. one showing a
   * managed dialog) then explains the pause instead of looking like the TUI
   * ate the input.
   */
  const DECISION_PENDING_MS = 400
  const withDecisionPending = <T>(name: string, pending: Promise<T>): Promise<T> => {
    let dismiss: (() => void) | undefined
    const timer = setTimeout(() => {
      // Sticky (timeoutMs 0), D-8: the indicator must cover the WHOLE wait —
      // an auto-expiring notice would vanish after ~4s while the decision,
      // the delivery and every queued FIFO task behind them stay parked,
      // leaving the user with no sign the flow is still waiting. It comes
      // down only when the decision settles (finally below); a decision
      // that never settles keeps its indicator up, which is the truthful
      // state.
      dismiss = state.notify(t('ext-decision-pending', { event: name }), { timeoutMs: 0 })
    }, DECISION_PENDING_MS)
    // Both exits are covered: a fast decision clears the timer before it
    // fires; a slow one dismisses the indicator it raised.
    return pending.finally(() => {
      clearTimeout(timer)
      dismiss?.()
    })
  }
  /**
   * The `tui/input` decision event (pi's `input` seam): the FIRST plugin
   * returning a valid decision wins — transform the text, mark it handled,
   * or cancel it. No listeners (or only crashing/malformed ones) means
   * delivery proceeds unchanged, so a broken plugin can never wedge the
   * input path — and can never skip a later veto listener either
   * (dispatchTuiDecision isolates crashes and normalizes returns per
   * listener instead of bailing on the first object).
   *
   * Decision AND delivery enter one FIFO chain in submission order: a slow
   * listener on A parks A's delivery AND any later submissions behind it —
   * without the chain, B's decision could resolve first and the model would
   * receive B before A. Each submission binds its origin agent AT ENQUEUE,
   * so a session switch landing before OR during its decision drops the
   * stale text with a notice instead of sending the old conversation's
   * words to the new session.
   */
  let inputChain: Promise<void> = Promise.resolve()
  const runUserTextDecision = async (
    text: string,
    placement: PendingMessage['placement'],
    originAgent: Agent,
    originAgentId: string,
  ): Promise<void> => {
    // Stale detection compares the AGENT REFERENCE, not the id: session ids
    // are reusable (A → /new → /resume A lands back on the same id with a
    // fresh agent), so an id check has an ABA hole. Both origin values are
    // ENQUEUE-time captures (see dispatchUserText): a decision parked behind
    // a slow predecessor must still be judged against the session its text
    // was typed in, not whichever session is live when it finally runs.
    const decision = await withDecisionPending('tui/input', dispatchTuiDecision(ctx, 'tui/input', {
      text,
      delivery: placement === 'steer' ? 'steer' : 'followup',
      sessionId: originAgentId,
      cwd: state.cwd,
    }, normalizeInputDecision))
    if (decision !== undefined) {
      // Both intercepts toast — a bare {cancel}/{handled} must not make the
      // typed line vanish silently (the host-localized fallback mirrors the
      // other decision events' ext-action-cancelled handling).
      if ('cancel' in decision) {
        state.notify(decision.reason ?? t('ext-action-cancelled'), { color: 'warning', timeoutMs: 4000 })
        return
      }
      if ('handled' in decision) {
        state.notify(decision.notice ?? t('ext-action-handled'), { timeoutMs: 4000 })
        return
      }
      text = decision.text.trim()
    }
    if (agent !== originAgent) {
      state.notify(t('ext-stale-dropped'), { color: 'warning', timeoutMs: 4000 })
      return
    }
    deliverUserText(text, placement)
  }
  const dispatchUserText = (text: string, placement: PendingMessage['placement']): void => {
    // D-6: bind the submission to the session it was typed in AT ENQUEUE
    // TIME. The FIFO chain may park this task behind a slow predecessor
    // while the user /new's away — capturing the agent at run time would
    // adopt the NEW session as this text's origin and deliver the old
    // conversation's words into it.
    const originAgent = agent
    const originAgentId = state.agentId
    inputChain = inputChain.then(() => runUserTextDecision(text, placement, originAgent, originAgentId)).catch((error: unknown) => {
      // The chain must survive a failed decision: log, then continue with
      // the next queued submission.
      ctx.logger.warn('dsh-tui: tui/input dispatch failed: %o', error)
    })
  }
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
    const originAgent = agent
    const decision = await withDecisionPending('tui/session-switch', dispatchTuiDecision(ctx, 'tui/session-switch', {
      kind,
      ...(targetSessionId === undefined ? {} : { targetSessionId }),
      sessionId: state.agentId,
      cwd: state.cwd,
    }, normalizeCancelDecision))
    if (agent !== originAgent) {
      // The world changed while the decision parked: drop the pending
      // switch instead of replacing the user's newer session.
      state.notify(t('ext-stale-dropped'), { color: 'warning', timeoutMs: 4000 })
      return true
    }
    if (decision !== undefined) {
      state.notify(decision.reason ?? t('ext-action-cancelled'), { color: 'warning', timeoutMs: 4000 })
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
  const adoptForkedAgent = (
    handle: AgentHandle,
    seed: readonly SessionEvent[],
    agentPreset: string | undefined,
    childId: SessionId,
  ): string => {
    // Replay the forked history into a fresh transcript (tokens/spinner
    // counters land back at the rewind point, matching the fork).
    streaming = undefined
    reasoning = undefined
    // Stale sealed/thinking bookkeeping belongs to the OLD agent's rows;
    // keep it out of the next turn's settle logs and revive cache.
    sealedReasoning.length = 0
    lastReasoningRow = undefined
    toolCards.clear()
    nextRowId = 0
    state.rows.length = 0
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
    state.agentPreset = agentPreset
    state.tps = undefined
    state.tpsSamples = []
    state.lastUsage = undefined
    state.workingActivity = undefined
    state.contextSegments = {
      system: 0,
      prompt: 0,
      assistant: 0,
      thinking: 0,
      tools: 0,
    }
    replayEvents(seed)
    settleStreaming()
    // A seed ending mid-turn replays a turn/start that set working=true;
    // the boot path resets this after replay — mirror it here so an idle
    // rewound agent doesn't sit with a live spinner (a still-running
    // agent re-asserts on its next event).
    state.working = handle.agent.status === 'running'
    // Rebind subscriptions to the new agent, then free the old one.
    const oldHandle = currentHandle
    const sourceSessionId = String(agent.session.id)
    agent = handle.agent
    currentHandle = handle
    bindAgent()
    refreshCommandList()
    void refreshLoadedContext()
    void refreshSkillCommands()
    // The forked session (rewind) becomes the most recently used.
    touchSession(childId)
    state.emit()
    void oldHandle?.dispose().catch(() => {})
    // The staged-image map is session-scoped (the same contract the
    // resumeTo/newSession tails enforce): tokens typed against the rewound
    // conversation must not ride into the fork's next send, and the epoch
    // bump fences saves still in flight for the old session.
    clearStagedImages()
    return sourceSessionId
  }
  /** Monotonic token: only the latest `interruptAndDeliver` re-queues, so a
   *  second interrupt while the abort settles cannot double-deliver. */
  let interruptSeq = 0
  // Cancellation is asynchronous: a fast second Esc can arrive after the
  // driver has accepted the first abort but before its turn/end event lands.
  // Do not cancel the same driver twice, or the second cancel can swallow the
  // replacement work queued by interruptAndDeliver and leave the UI gated on
  // a working flag that has not observed turn/end yet.
  let cancelInFlight = false
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
   *  to every newly bound agent once validated against its adapter's list. */
  let preferredEffort: string | undefined = options.effort ?? readEffortPref()

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
      state.notify(t('effort-read-failed', { error: error instanceof Error ? error.message : String(error) }), {
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
    state.notify(t('effort-switched', { name: effort.name }))
    state.emit()
  }


  /** The live route's effort levels for the `/effort` slider; empty after
   *  notifying when the route is unsupported/unavailable/single-tier. */
  const listEfforts = async (): Promise<{ efforts: readonly EffortOption[]; defaultEffort: string | undefined }> => {
    const resolved = await resolveEfforts()
    if (resolved === 'unavailable') {
      state.notify(t('effort-unavailable'), { color: 'error' })
      return { efforts: [], defaultEffort: undefined }
    }
    if (resolved === 'error') return { efforts: [], defaultEffort: undefined }
    if (resolved.efforts.length === 0) {
      state.notify(t('effort-unsupported'), { color: 'warning' })
    } else if (resolved.efforts.length === 1) {
      state.notify(t('effort-single-tier', { name: resolved.efforts[0]!.name }), { color: 'warning' })
    }
    return resolved
  }

  /** Set one effort level by id (`/effort <id>` and the slider's live
   *  apply); false + a notify when the id is not offered by the route. */
  const setEffort = async (id: string): Promise<boolean> => {
    const resolved = await resolveEfforts()
    if (resolved === 'unavailable') {
      state.notify(t('effort-unavailable'), { color: 'error' })
      return false
    }
    if (resolved === 'error') return false
    if (resolved.efforts.length === 0) {
      state.notify(t('effort-unsupported'), { color: 'warning' })
      return false
    }
    const found = resolved.efforts.find(effort => effort.id === id)
    if (!found) {
      state.notify(
        t('effort-invalid', { id, ids: resolved.efforts.map(effort => effort.id).join(', ') }),
        { color: 'warning' },
      )
      return false
    }
    applyEffort(found)
    return true
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
    if (!commandService) return undefined
    // Resolve the exact definition that execute() will select for this agent.
    // Same names may exist in distinct agent scopes, so a name-only lookup can
    // apply another scope's owner policy.
    const definition = commandService.find(agent, name)
    const owner = commandOwner(ctx, definition)
    // The root checkpoint covers host/direct registrations.  A built-in name
    // is not necessarily a namespaced contribution id, so use a deterministic
    // host scope for that case; legacy unscoped denies still conservatively
    // revoke every valid command scope.
    const rootScope = owner?.commandId
      ?? (/^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/u.test(name)
        ? name
        : `dsh-tui.${name.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'command'}`)
    if (!currentGrantStore().allows(
      { componentId: 'root' },
      'commands.invoke',
      rootScope,
    )) {
      ctx.logger.warn('dsh-tui: registry command invocation denied (commands.invoke revoked for "root" in the grants file)')
      ctx.get('tuiEffectLedger')?.record(
        {
          operation: 'bind',
          resource: { kind: 'permission', id: `root:commands.invoke:${rootScope}` },
          result: 'failed',
          errorCode: 'PERMISSION_NOT_GRANTED',
        },
        ctx,
      )
      return t('command-invoke-denied')
    }
    // Per-owner gate (C-041): a command REGISTERED BY A PLUGIN through the
    // plugin-host row's mediated registerCommand (see command-attribution.js)
    // is additionally gated on the OWNER's grant, so a denies entry for the
    // plugin closes the host-mediated invocation of ITS commands.
    // Unattributed host/direct registrations remain inside the documented
    // trusted-in-process boundary and have no plugin grant to evaluate.
    if (owner !== undefined && !currentGrantStore().allows(
      { componentId: owner.componentId, activationId: owner.activationId },
      'commands.invoke',
      owner.commandId,
    )) {
      ctx.logger.warn(
        `dsh-tui: registry command "/${name}" invocation denied — owner Component "${owner.componentId}" lost commands.invoke for "${owner.commandId}"`,
      )
      ctx.get('tuiEffectLedger')?.record(
        {
          operation: 'bind',
          resource: { kind: 'permission', id: `${owner.componentId}:commands.invoke:${owner.commandId}` },
          result: 'failed',
          errorCode: 'PERMISSION_NOT_GRANTED',
        },
        ctx,
      )
      return t('command-invoke-denied-owner', { name, owner: owner.componentId })
    }
    try {
      const signal = new AbortController().signal
      const line = `/${name}${rawInput}`
      const images = await registryCommandImages(commandService, definition, line, signal)
      // rc.8 moved the signal to the 4th parameter and added composer
      // images; older lines (rc.7/rc.6) take (agent, line, signal).
      const execution = images === undefined
        ? await (commandService.execute as unknown as CommandExecuteLegacy)(agent, line, signal)
        : await (commandService.execute as unknown as CommandExecuteWithImages)(agent, line, images.images, signal)
      if (images !== undefined && images.dropped.length > 0) {
        // Loud-drop policy mirrors the submit pipeline (mentions-missing):
        // a referenced image that never reached the command must be visible.
        state.notify(t('mentions-missing', { paths: images.dropped.join(' ') }), {
          color: 'warning',
          timeoutMs: 4000,
        })
      }
      // `undefined` = not registered; a handler error surfaces as its
      // message so the user sees why the command failed.
      return execution === undefined ? undefined : execution.result.text ?? ''
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /** Encode the staged `@`-mention images the user pasted for THIS command
   *  line into rc.8's `EncodedImageAttachment` payloads; undefined = the
   *  installed dsh-commands line predates composer images (rc.7/rc.6), so
   *  the caller uses the legacy 3-arg invoke. Matches the submit pipeline's
   *  token rule (expandMentions): a staged image attaches only when the
   *  line references its token. A command that does not declare
   *  `input.images` gets NO images — rc.8 admission settles such a batch
   *  as an error, and upstream sends images only to image-capable commands.
   *  A failing read drops just that image (reported via the returned
   *  tokens) while the command still runs. */
  const registryCommandImages = async (
    service: CommandRuntime,
    definition: unknown,
    line: string,
    signal: AbortSignal,
  ): Promise<{ images: RegistryCommandImage[]; dropped: string[] } | undefined> => {
    if (!commandServiceSupportsImages(service)) return undefined
    const declaresImages = (definition as { input?: { images?: boolean } } | undefined)?.input?.images === true
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
    return { images, dropped }
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

  /** First configured mode whose declared atoms all match the folds;
   *  undeclared atoms are wildcards; no match → index 0 (the base mode).
   *  Matching is exact: a fresh session has no `approval/policy` event, so
   *  a mode declaring `approval: 'ask'` never falsely matches it. */
  const deriveModeIndex = (events: readonly SessionEvent[]): number => {
    const index = sessionModes.findIndex(
      spec =>
        (spec.plan === undefined || foldPlanActive(events) === spec.plan) &&
        (spec.sandbox === undefined || foldSandboxMode(events) === spec.sandbox) &&
        (spec.approval === undefined || foldApprovalPolicy(events) === spec.approval),
    )
    return index >= 0 ? index : 0
  }

  /** Re-derive the current mode from the live session log (boot, every
   *  agent re-bind, and after mode-affecting session events). */
  const refreshMode = (): void => {
    state.modeIndex = deriveModeIndex(snapshotLiveSessionEvents(agent.session))
    state.mode = sessionModes[state.modeIndex]!
  }

  // Session.append rejects observer reentry; restore after publication unwinds.
  const pendingPlanExitRestores = new Map<object, SessionModeSpec>()
  const prePlanModes = new WeakMap<object, SessionModeSpec>()
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
    if (spec.sandbox !== undefined && foldSandboxMode(snapshotLiveSessionEvents(agent.session)) !== spec.sandbox) {
      ;(agent.session as unknown as { append(type: string, data: Record<string, unknown>): unknown }).append(
        'sandbox/mode',
        { mode: spec.sandbox },
      )
    }
    // Prefer the approval service (it narrates the switch to the model);
    // the raw durable event is the fallback when it is unmounted.
    if (spec.approval !== undefined && foldApprovalPolicy(snapshotLiveSessionEvents(agent.session)) !== spec.approval) {
      const approval = ctx.get('approval') as
        | { setPolicy(a: Agent, policy: 'ask' | 'never'): void }
        | undefined
      approval?.setPolicy(agent, spec.approval)
      // The service may no-op when its configured default already matches.
      if (foldApprovalPolicy(snapshotLiveSessionEvents(agent.session)) !== spec.approval) {
        ;(agent.session as unknown as { append(type: string, data: Record<string, unknown>): unknown }).append(
          'approval/policy',
          { policy: spec.approval },
        )
      }
    }
  }

  /** Apply the configured atoms; an explicit exit owns its target mode. */
  const applyMode = async (spec: SessionModeSpec): Promise<void> => {
    const session = agent.session
    pendingPlanExitRestores.delete(session)
    const planMode = ctx.get('planMode') as
      | { get?(a: Agent): { active: boolean; pending?: boolean } }
      | undefined
    const planActive = foldPlanActive(snapshotLiveSessionEvents(session))
    // Reconcile a stale explicit-exit marker before acting. The marker only
    // legitimately survives while a deferred exit awaits its plan/mode:false
    // (foldPlanActive && pending === false). If plan is still logged active
    // with no pending intent, that awaited event was abandoned (e.g. an
    // aborted pre-step) — drop the orphan so it cannot suppress a later restore
    // such as an approved exit_plan_mode.
    if (planActive && planMode?.get?.(agent).pending === undefined) {
      explicitPlanExits.delete(session)
    }
    if (spec.plan !== undefined && (planMode?.get?.(agent).pending ?? planActive) !== spec.plan) {
      if (commandService?.find(agent, 'plan') === undefined) {
        state.notify(t('mode-plan-unavailable'), { color: 'warning' })
        return
      }
      if (spec.plan && !planActive && !prePlanModes.has(session)) {
        const previous = modePermissions(snapshotLiveSessionEvents(session))
        const sandbox = ctx.get('sandboxPolicy') as { defaultMode?: SessionModeSpec['sandbox'] } | undefined
        const approval = ctx.get('approval') as { effectivePolicy?(session: Agent['session']): SessionModeSpec['approval'] } | undefined
        const base = previous.sandbox === undefined && previous.approval === undefined ? sessionModes[0] : undefined
        previous.sandbox ??= sandbox?.defaultMode ?? base?.sandbox
        previous.approval ??= approval?.effectivePolicy?.(session) ?? base?.approval
        prePlanModes.set(session, previous)
        // Persist missing defaults before /plan, so resume can recover them.
        applyModeAtoms(previous)
      }
      if (!spec.plan) explicitPlanExits.add(session)
      try {
        const text = await executeRegistryCommand('plan', spec.plan ? '' : ' off')
        if (session !== agent.session) return
        if (text === undefined) {
          state.notify(t('mode-plan-unavailable'), { color: 'warning' })
          return
        }
      } finally {
        if (session === agent.session) {
          const pending = planMode?.get?.(agent).pending
          if (!foldPlanActive(snapshotLiveSessionEvents(session)) || pending !== false) explicitPlanExits.delete(session)
          if (!foldPlanActive(snapshotLiveSessionEvents(session)) && pending !== true) prePlanModes.delete(session)
        }
      }
    }
    applyModeAtoms(spec)
    refreshMode()
    state.notify(t('mode-switched', { name: modeDisplayName(state.mode) }))
    state.emit()
  }

  /** Shift+Tab: advance to the next configured session mode. Cycling starts
   *  from the mode DERIVED from the session log (never a stored index), so
   *  manual `/plan` use can never desync the cycle. */
  const cycleMode = async (): Promise<void> => {
    const index = deriveModeIndex(snapshotLiveSessionEvents(agent.session))
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
      if (generation !== modelNodeCache.generation) return
      modelNodeCache.nodes = list.map((model) => ({
        name: `${model.provider}/${model.id}`,
        description: model.name,
        ...(state.provider === model.provider && state.model === model.id
          ? { tag: 'current' }
          : {}),
      }))
      state.emit()
    }).catch(() => {
      if (generation !== modelNodeCache.generation) return
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

  // --- Manual-compaction lifecycle ---------------------------------------
  // The in-flight /compact transaction: its abort hook plus the settled
  // promise. Every path that replaces `agent` (rewind / rewind-node /
  // resume / new / model switch) must cancel and await it BEFORE snapshot-
  // ting the session. Without this, a slow summarizer keeps running against
  // the OLD session across the switch and can commit its replacement
  // checkpoint AFTER the fork snapshot — silently swapping the history the
  // user believed intact ("compaction failed → /model → context lost").
  let manualCompaction:
    | { controller: AbortController; settled: Promise<void> }
    | undefined
  /** Compactions cancelled by settleManualCompaction: their rejection is expected. */
  const cancelledCompactions = new WeakSet<AbortController>()

  /**
   * Cancel an in-flight manual compaction and wait for it to settle.
   * Aborting tears the summarizer stream down; dsh-compaction then closes
   * the transaction with an error end marker and rejects compactNow with
   * the `cancelled` class — no checkpoint is committed, the surface stays
   * whole. The settle race is capped so a stuck stream can never wedge the
   * session switch itself.
   */
  const settleManualCompaction = async (): Promise<void> => {
    const active = manualCompaction
    if (active === undefined) return
    manualCompaction = undefined
    cancelledCompactions.add(active.controller)
    active.controller.abort(new Error('session switch'))
    state.notify(t('compact-cancelled-switch'), { color: 'warning', timeoutMs: 4000 })
    await Promise.race([
      active.settled,
      new Promise<void>(resolve => { setTimeout(resolve, 3000) }),
    ])
  }

  let agentBindingGeneration = 0

  /**
   * Adopt a live agent in this process — the agent view's attach path for a
   * background session. The target is already composed (preset, route,
   * tools), so no persistence resolution runs; the projection resets and
   * replays the target's in-memory log. The previously attached agent is
   * NOT disposed when it still has something to run or say: it keeps living
   * as a background session (backgroundHandles), and an empty one is freed.
   */
  const adoptLiveAgent = async (target: Agent): Promise<ResumeResult> => {
    const previousHandle = currentHandle
    const previousSessionId = String(agent.session.id)
    // Same reset shape as resumeTo (no history replay sources differ — the
    // target's own events are replayed below).
    streaming = undefined
    reasoning = undefined
    sealedReasoning.length = 0
    lastReasoningRow = undefined
    toolCards.clear()
    nextRowId = 0
    state.rows.length = 0
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
    state.status = target.status
    state.agentId = target.id
    state.cwd = target.session.header.cwd ?? state.cwd
    state.displayCwd = workspaceService.describe(state.cwd).description ?? state.cwd
    refreshGitBranch()
    state.agentPreset = runningPresetOf(target.session)
    const adoptedRoute = recordedModelRoute(snapshotLiveSessionEvents(target.session))
    if (adoptedRoute !== undefined) {
      state.provider = adoptedRoute.provider
      state.model = adoptedRoute.model
    }
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
    replayEvents(snapshotLiveSessionEvents(target.session))
    settleStreaming()
    state.working = target.status === 'running'
    agent = target
    // The dispatch kept this agent's handle for stopping; adoption takes
    // ownership of it (the agent stays registered either way).
    currentHandle = backgroundHandles.get(String(target.id))
    backgroundHandles.delete(String(target.id))
    bindAgent()
    refreshCommandList()
    void refreshLoadedContext()
    void refreshSkillCommands()
    writeResumeTarget(String(target.id))
    touchSession(target.id)
    state.emit()
    const keepPrevious =
      previousHandle !== undefined
      && previousHandle.agent !== target
      && (previousHandle.agent.status === 'running' || agentViewHasTurns(snapshotLiveSessionEvents(previousHandle.agent.session)))
    if (previousHandle !== undefined && previousHandle.agent !== target) {
      if (keepPrevious) backgroundHandles.set(previousSessionId, previousHandle)
      else void previousHandle.dispose().catch(() => {})
    }
    // Both sessions are now part of the view's working set: the adopted one
    // and the one the terminal detached from.
    touchAgentViewSession(String(target.id))
    touchAgentViewSession(previousSessionId)
    clearStagedImages()
    notifySessionSwitched('agent-view', String(target.id), previousSessionId)
    notifyAgentView()
    return { ok: true }
  }

  /**
   * Resume a persisted session — the shared core of `/resume` and the agent
   * view's attach path for a session no live agent owns. `keepCurrent`
   * moves the previously attached agent into the background instead of
   * disposing it (the agent view never kills what it is not told to stop).
   */
  const resumeInto = async (
    sessionId: string,
    kind: 'resume' | 'agent-view',
    keepCurrent: boolean,
  ): Promise<ResumeResult> => {
    const agents = ctx.get('agents') as
      | {
        resume(options: {
          resumeSessionId: SessionId
          agentOptions?: { provider?: string; model?: string }
          setup?: CreateAgentOptions['setup']
        }): Promise<AgentHandle>
      }
      | undefined
    if (!agents) {
      state.notify(t('resume-unavailable'), { color: 'error' })
      return { ok: false, reason: 'unavailable' }
    }
    // Compat boundary: register vouched-for legacy event types (e.g.
    // activity/status from pre-#143 logs) in every reachable dsh-session
    // copy before ANY strict read path (preset lookup below, then the
    // harness seed validation) loads the target — the plugin's #119
    // registration never ran in processes where it is unmounted (issue
    // #153). In-process only: the shared log is never rewritten.
    ensureLegacySessionEventTypes()
    // The target session's own preset (from its persisted log) — never the
    // current preference: a resume re-enters the composition its history
    // was produced under. Same rule for the route: only an explicit
    // cordis.yml provider/model overrides the route the target's own
    // request/header records (issue #30) — and only as a COMPLETE pair
    // (issue #67): a provider-only pin must not merge with the recorded
    // model half into a route no adapter recognizes.
    const resumeComposed = await composePreset(
      ctx,
      await resolvePersistedPreset(ctx, SessionId(sessionId)),
    )
    const resumeRoute = explicitModelRoute({
      provider: options.configuredProvider,
      model: options.configuredModel,
    })
    // The recorded route feeds back into agentOptions too — not just the
    // status line below: a provider-only cordis.yml pin (issue #67) leaves
    // agentOptions.model undefined on resume, which breaks the `{{model}}`
    // persona variable for the resumed agent's own assembly AND for every
    // subagent it spawns (dsh-subagent's resolveChildAgentOptions inherits
    // `parent.options.model`).
    const recordedRoute = await resolvePersistedRoute(ctx, SessionId(sessionId))
    let handle: AgentHandle
    try {
      handle = await agents.resume({
        resumeSessionId: SessionId(sessionId),
        agentOptions: {
          provider: resumeRoute?.provider ?? recordedRoute?.provider,
          model: resumeRoute?.model ?? recordedRoute?.model,
        },
        ...(resumeComposed.setup === undefined ? {} : { setup: resumeComposed.setup }),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      state.notify(t('resume-failed', { err: message }), { color: 'error', timeoutMs: 8000 })
      return { ok: false, reason: 'failed', error: message }
    }
    try {
      // Adopting this persisted conversation; this also repairs sessions
      // created by TUI versions that predate the workspace ownership ledger.
      await attachSessionToWorkspace(ctx, handle.agent.session.header.cwd ?? state.cwd, SessionId(sessionId))
    } catch (error) {
      state.notify(
        t('resume-attach-failed', { err: error instanceof Error ? error.message : String(error) }),
        { color: 'warning', timeoutMs: 8000 },
      )
    }
    // Replay the persisted history into a fresh transcript (same reset as
    // rewindTo, plus the context window which the replay re-derives).
    streaming = undefined
    reasoning = undefined
    sealedReasoning.length = 0
    lastReasoningRow = undefined
    toolCards.clear()
    nextRowId = 0
    state.rows.length = 0
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
    state.cwd = handle.agent.session.header.cwd ?? state.cwd
    state.displayCwd = workspaceService.describe(state.cwd).description ?? state.cwd
    refreshGitBranch()
    state.agentPreset = resumeComposed.agentPreset
    const resumedRoute = resumeRoute ?? recordedModelRoute(snapshotLiveSessionEvents(handle.agent.session))
    if (resumedRoute !== undefined) {
      state.provider = resumedRoute.provider
      state.model = resumedRoute.model
    }
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
    replayEvents(snapshotLiveSessionEvents(handle.agent.session))
    settleStreaming()
    state.working = handle.agent.status === 'running'
    const oldHandle = currentHandle
    const previousSessionId = String(agent.session.id)
    agent = handle.agent
    currentHandle = handle
    bindAgent()
    refreshCommandList()
    void refreshLoadedContext()
    void refreshSkillCommands()
    writeResumeTarget(sessionId)
    touchSession(sessionId)
    state.emit()
    const keepPrevious =
      keepCurrent
      && oldHandle !== undefined
      && (oldHandle.agent.status === 'running' || agentViewHasTurns(snapshotLiveSessionEvents(oldHandle.agent.session)))
    if (oldHandle !== undefined) {
      if (keepPrevious) backgroundHandles.set(previousSessionId, oldHandle)
      else void oldHandle.dispose().catch(() => {})
    }
    // Attaching FROM the agent view makes both sides view sessions; the
    // plain /resume path keeps its history out of the view's ledger.
    if (kind === 'agent-view') {
      touchAgentViewSession(sessionId)
      touchAgentViewSession(previousSessionId)
    }
    clearStagedImages()
    notifySessionSwitched(kind, sessionId, previousSessionId)
    return { ok: true }
  }
  const state: ChannelState = {
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
    agentId: agent.id,
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
    activityFrames: options.activityFrames,
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
    whaleIdle: options.whaleIdle === true,
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
            .filter(option => isCommandCompletionToken(option.value))
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
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit() {
      foldRows(state.rows, MAX_ROWS, foldCursor)
      state.version += 1
      // #185 self-heal: a forceStoreRerender enqueue can surface React's
      // nested-update overflow here; React resets the counter on throw, so
      // absorb it and let the next wakeup render with a clean slate.
      for (const listener of listeners) {
        try {
          listener()
        } catch (error) {
          if (!swallowNestedUpdateOverflow(error, 'channel.emit')) throw error
        }
      }
    },
    // Frame-aligned notification for streaming deltas. LLM chunks arrive at
    // 100-300 events/s (one per token); waking React synchronously per event
    // commits the whole tree per token — the render throttle only gates
    // paint, not commits, so the event loop saturates and output stutters.
    // Data + version stay synchronous (getSnapshot always reads fresh
    // state); only the listener wakeup coalesces to paint cadence.
    emitStream() {
      state.version += 1
      if (streamNotifyScheduled) return
      streamNotifyScheduled = true
      const timer = setTimeout(() => {
        streamNotifyScheduled = false
        // Deferred subagent projection rides this same frame: flush BEFORE
        // the listeners wake so React reads fully projected rows.
        flushSubagentStream()
        foldRows(state.rows, MAX_ROWS, foldCursor)
        // Same #185 self-heal as emit(): this timer is the busiest enqueue
        // site during streaming, so the overflow most often surfaces here.
        for (const listener of listeners) {
          try {
            listener()
          } catch (error) {
            if (!swallowNestedUpdateOverflow(error, 'channel.emitStream')) throw error
          }
        }
      }, 16)
      // Never hold the process open for a pending UI wakeup.
      timer.unref()
    },
    loadOlder() {
      // Restore folded-away full text from the session log, newest folded
      // batch first, clearing the folded marks. The log is the authoritative
      // source, so restored rows match a fresh replay; live streaming rows
      // are never folded, so nothing here races a running turn.
      const restored = foldBack(state.rows, snapshotLiveSessionEvents(agent.session), { call: presentCallView, result: presentResultView })
      if (restored > 0) state.emit()
      return restored
    },
    async stageImage(input: StagedImageInput): Promise<string> {
      const attachments = mentionAttachments(ctx)
      if (attachments === undefined) throw new Error('image attachments are unavailable in this profile')
      if (!attachments.imageLimits.mediaTypes.includes(input.mediaType)) {
        throw new Error(`${input.mediaType} images are not accepted by this profile`)
      }
      if (input.data.byteLength > attachments.imageLimits.maxImageBytes) {
        throw new Error(`image exceeds this profile's per-image size limit`)
      }
      const attachment = await attachments.saveImage(input)
      stagedImageSequence += 1
      const token = `[Image #${stagedImageSequence}]`
      stagedImages.set(token, attachment)
      // References are content-addressed and durable. This map only connects
      // editable prompt placeholders to them; cap it to bound a long TUI run.
      while (stagedImages.size > 128) {
        const oldest = stagedImages.keys().next().value as string | undefined
        if (oldest === undefined) break
        stagedImages.delete(oldest)
      }
      return token
    },
    submit(text) {
      const trimmed = text.trim()
      if (!trimmed) return
      // Claude Code's `!` mode: `!cmd` runs locally and only shows the
      // output; `!!cmd` additionally sends the output to the model as a
      // user message (CC's <bash-stdout> convention).
      if (trimmed.startsWith('!!')) {
        void runLocalCommand(trimmed.slice(2).trim(), true)
        return
      }
      if (trimmed.startsWith('!')) {
        void runLocalCommand(trimmed.slice(1).trim(), false)
        return
      }
      // The current session is being used — move it to the MRU front
      // (/resume sorts by last-used).
      touchSession(state.agentId)
      void dispatchUserText(trimmed, 'followup')
    },
    /** Steer a message into the RUNNING turn (Codex/pi semantics): it is
     *  injected at the next step boundary of the current turn and the agent
     *  continues without stopping — faster than followup, never an abort. */
    steer(text) {
      const trimmed = text.trim()
      if (!trimmed) return
      touchSession(state.agentId)
      // Same tui/input decision pass as submit; the delivery re-validates
      // the live agent after the await. Official dsh-agent rc.6: steer() is
      // synchronous void — the message enters the next-step inbox; a
      // rejected step leaves it parked for the next wake, and the inbox
      // events retire the preview (claimed → turn boundary, discarded →
      // cancel).
      void dispatchUserText(trimmed, 'steer')
    },
    /** Pull a pending message back out of the inbox (Alt+Up): it returns to
     *  the input for editing instead of being delivered. */
    removePending(id: string): boolean {
      const index = state.pending.findIndex(item => item.id === id)
      if (index === -1) return false
      // Official dsh-agent rc.6: withdrawal goes through the agent's inbox
      // projection — `Inbox.remove(messageId)` durably records the
      // cancellation (an `agent/inbox/spliced` session event) and publishes
      // `agent/inbox/discarded`, which retires the preview. Refuse when the
      // message was already claimed (remove returns false) so the UI never
      // pretends a ghost send was pulled back.
      if (!agent.inbox.remove(MessageId(id))) return false
      state.pending = state.pending.filter(item => item.id !== id)
      state.emit()
      return true
    },
    cancel() {
      // Keep the staged queue: an interrupt aborts the running turn but the
      // queued/steered messages are delivered as the next turn (web parity).
      // Cancellation converges asynchronously; ignore a repeated Esc/Ctrl+C
      // until the aborted turn has produced its terminal event. `cancelPending`
      // mirrors that window for the UI, where a repeated press force-exits.
      if (cancelInFlight) return
      cancelInFlight = true
      state.cancelPending = true
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    },
    interruptAndDeliver(texts: readonly string[]): number {
      const queued = texts.map(text => text.trim()).filter(text => text !== '')
      if (queued.length === 0) return 0
      // No keepInbox: the parked copies are dropped (their discard events
      // retire the preview), then each text is re-queued as a fresh
      // followup. dsh-agent's cancel-convergence wake latch accepts this
      // wake immediately after cancel and starts it once the aborted turn
      // retires; waiting for whenIdle is unsafe because it also follows
      // replacement work and may never settle. If cancellation is already
      // in flight, keep the existing abort and still replace the pending
      // interrupt delivery; fake/embedded agents may not emit turn/end.
      if (!cancelInFlight) {
        cancelInFlight = true
        agent.cancel({ kind: 'user' })
      }
      state.cancelPending = true
      const token = ++interruptSeq
      const deliver = (): void => {
        // A second interrupt while the abort is still settling must not
        // double-deliver: only the latest request's re-queue runs.
        if (interruptSeq !== token) return
        for (const text of queued) {
          touchSession(state.agentId)
          // Same tui/input decision pass as a typed submit: Ctrl+Enter must
          // not bypass a plugin's cancel/transform policy, and re-queued
          // texts keep submission order through the one FIFO chain.
          dispatchUserText(text, 'followup')
        }
      }
      // Let cancel finish its synchronous inbox bookkeeping before waking.
      // A microtask also coalesces two same-tick interrupts: only the latest
      // token survives, so the user's text is never sent twice.
      queueMicrotask(deliver)
      return queued.length
    },
    /**
     * The `tui/rewind-prompt` decision event (pi's `session_before_fork`):
     * fired when the rewind picker confirms a message, before any fork
     * work. The first answering plugin may cancel the rewind (the picker
     * stays open; the reason is toasted here so the UI string stays
     * host-localized when absent) or offer extra modes rendered in the
     * confirm pane. Returns 'cancel', the modes, or null for "no opinion".
     */
    async promptRewind(row: ChatRow): Promise<{ modes: readonly TuiRewindMode[] } | 'cancel' | null> {
      if (row.seq === undefined) return null
      // D-6, same as the other decision points: a slow /new or /resume can
      // replace the agent while this decision parks. Without the identity
      // check the picker would go on to show the OLD session's row in the
      // confirm pane and rewindTo would cut the NEW session at the old
      // seq — a wrong rewind or a fork failure. Compare agent REFERENCES
      // (session ids are reusable — ABA) and stale-cancel.
      const originAgent = agent
      const decision = await withDecisionPending('tui/rewind-prompt', dispatchTuiDecision(ctx, 'tui/rewind-prompt', {
        text: row.text,
        seq: row.seq,
        sessionId: state.agentId,
        cwd: state.cwd,
      }, normalizeRewindPromptDecision))
      if (agent !== originAgent) {
        state.notify(t('ext-stale-dropped'), { color: 'warning', timeoutMs: 4000 })
        return 'cancel'
      }
      if (decision === undefined) return null
      if ('cancel' in decision) {
        state.notify(decision.reason ?? t('ext-action-cancelled'), { color: 'warning', timeoutMs: 4000 })
        return 'cancel'
      }
      return { modes: decision.modes }
    },
    async rewindTo(row: ChatRow, mode: string | null = null): Promise<string | null> {
      if (row.seq === undefined) return null
      const agents = ctx.get('agents') as
        | { create(options: CreateAgentOptions): Promise<AgentHandle> }
        | undefined
      if (!agents) {
        state.notify(t('rewind-unavailable'), { color: 'error' })
        return null
      }
      // Stop a running turn first and WAIT for its turn/end to land — fork
      // rejects boundaries inside open turns, and Agent.cancel() closes the
      // turn asynchronously (a long thinking turn can take seconds to settle).
      const wasWorking = state.working
      const cancelSeq = liveSessionOffset(agent.session)
      if (wasWorking) agent.cancel({ kind: 'user' })
      if (wasWorking) {
        const turnSettled = await waitForTurnEnd(agent.session, cancelSeq, 30000)
        if (!turnSettled) {
          state.notify(t('rewind-settling'), { color: 'error' })
          return null
        }
      }
      // An in-flight manual compaction must not straddle the fork: cancel it
      // and wait, or its checkpoint could commit right after the seed snapshot
      // below and quietly replace history the rewind was meant to preserve.
      await settleManualCompaction()
      const childId = SessionId(randomUUID())
      // DSH event order is `turn/start → user/message → … → turn/end`, so a
      // message's own seq always sits inside its turn — forking there would
      // hit OPEN_TURN. Rewind to just BEFORE the message's turn/start: the
      // conversation restarts at that point and the message itself comes
      // back into the input for re-editing (CC's rewind semantics).
      const events = snapshotLiveSessionEvents(agent.session)
      let boundary = row.seq
      for (let i = row.seq; i >= 0; i--) {
        const event = events[i]
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: seq may exceed events
        if (event === undefined) break
        if (event.type === 'turn/start') {
          boundary = event.seq - 1
          break
        }
        if (event.type === 'turn/end') break
      }
      // Slice the SOURCE snapshot through an inclusive seq. Never
      // sessions.fork(): that registers a real child whose snapshot includes
      // child-owned session/end-seed, so snapshot.length is not the inherited
      // cut. agents.create owns the new session id.
      let seed: readonly SessionEvent[]
      try {
        if (boundary < 0) {
          throw new Error('cannot rewind to the very first message')
        }
        seed = sliceLiveSessionSeed(agent.session, boundary)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state.notify(t('rewind-fork-failed', { err: message }), { color: 'error' })
        return null
      }
      let handle: AgentHandle
      // The fork continues under the source session's own preset: switches
      // are blank-only, so every `agent-preset/selected` event predates any
      // rewind boundary and the source log resolves the exact composition.
      // The route likewise stays the live one — a rewind continues the same
      // conversation, so a `/model` switch must survive it (issue #30).
      const rewindComposed = await composePreset(ctx, runningPresetOf(agent.session))
      try {
        handle = await agents.create(liveSessionCreateOptions({
          sessionId: childId,
          seed,
          runtimeSession: agent.session,
          inheritedCount: seed.length,
          cwd: state.cwd,
          parentSession: agent.session.id,
          agentPreset: rewindComposed.agentPreset,
          agentOptions: { provider: state.provider, model: state.model },
          setup: rewindComposed.setup,
        }))
      } catch {
        state.notify(t('rewind-create-failed'), { color: 'error' })
        return null
      }
      try {
        await attachSessionToWorkspace(ctx, state.cwd, childId)
      } catch (error) {
        state.notify(
          t('rewind-attach-failed', { err: error instanceof Error ? error.message : String(error) }),
          { color: 'warning', timeoutMs: 8000 },
        )
      }
      // Swap the live agent for the fork (shared with rewindToNode): replay
      // the seed, rebind, and free the replaced handle.
      const sourceSessionId = adoptForkedAgent(handle, seed, rewindComposed.agentPreset, childId)
      // Decision-event pair around the completed rewind: `tui/rewind-done`
      // (the first non-empty string is toasted as the post-rewind summary,
      // e.g. a plugin reporting restored files) and the generic
      // `tui/session-switched` notification. Listener failures are logged,
      // never surfaced — the rewind itself already succeeded.
      //
      // rewind-done is a post-hoc summary, NOT a gate, so it is dispatched
      // DECOUPLED from the return value: the picker is already closed and
      // PromptInput is live — awaiting a slow listener here would delay the
      // picked text's return to the draft, letting its late arrival
      // overwrite whatever the user typed meanwhile, and a listener that
      // never settles would park tui/session-switched forever. The summary
      // toasts whenever it lands.
      try {
        void dispatchTuiDecision(ctx, 'tui/rewind-done', {
          text: row.text,
          mode,
          boundarySeq: boundary,
          sourceSessionId,
          childSessionId: String(childId),
          sessionId: String(childId),
          cwd: state.cwd,
        }, normalizeRewindDoneSummary)
          .then(summary => {
            if (summary !== undefined) state.notify(summary, { timeoutMs: 6000 })
          })
          .catch((error: unknown) => {
            ctx.logger.warn('dsh-tui: tui/rewind-done dispatch failed: %o', error)
          })
      } catch (error) {
        // A bare embedder's context may lack the event bus entirely; the
        // rewind itself already succeeded, so this stays a log line.
        ctx.logger.warn('dsh-tui: tui/rewind-done dispatch failed: %o', error)
      }
      notifySessionSwitched('rewind', String(childId), sourceSessionId)
      return row.text
    },
    async buildSessionTree(): Promise<SessionTreeData | null> {
      const persistence = ctx.get('sessionPersistence') as
        | (SessionSource & {
          // Optional at runtime: fakes and third-party backends may not
          // implement the full coordinator surface.
          inspect?(id: SessionId, signal?: AbortSignal): Promise<{
            events: readonly SessionEvent[]
            inheritedEventCount?: unknown
          }>
        })
        | undefined
      if (!persistence) {
        state.notify(t('tree-unavailable'), { color: 'error' })
        return null
      }
      // Pin the live session snapshot NOW: every await below (list/inspect)
      // is a window in which a fire-and-forget switch (/new, /resume,
      // /model) can swap `agent`. Reading agent.session piecemeal would
      // stitch the NEW session's events under the OLD session's id — a
      // confirm would then rewind from the wrong persisted log. Everything
      // below reads this snapshot, and the result is discarded if the live
      // session moved on before the build finished.
      const liveSession = agent.session
      const currentId = String(liveSession.id)
      // Same enumerate as the /resume listing (snapshots when the backend
      // offers revisions, plain list otherwise), each header narrowed through
      // the sessions reader — one malformed header costs that session its
      // metadata, never the whole tree. `raw` stays the backend's own header
      // object for locate() below.
      let listed: { header: RawSessionHeader; raw: unknown }[] = []
      try {
        if (typeof persistence.listSnapshots === 'function') {
          const snapshots = await persistence.listSnapshots()
          listed = snapshots.flatMap(snapshot => {
            const raw = (snapshot as { header?: unknown } | null)?.header
            const header = readHeader(raw)
            return header === undefined ? [] : [{ header, raw }]
          })
        } else if (typeof persistence.list === 'function') {
          const headers = await persistence.list()
          listed = headers.flatMap(raw => {
            const header = readHeader(raw)
            return header === undefined ? [] : [{ header, raw }]
          })
        }
      } catch {
        // A listing failure degrades the tree to the live session only.
      }
      // Same cwd scoping as /resume (Claude Code's project dimension): forks
      // inherit cwd, so the family never crosses projects — and the match is
      // the project-aware one /resume uses, so a pre-upgrade subdirectory
      // path, Windows separators, or a case variant on one header cannot
      // quietly amputate the ancestors and siblings it records. Subagent
      // child sessions carry parentSession too, but they are delegation
      // artifacts, not rewind branches — exclude them from the family.
      const local = listed.filter(entry =>
        sessionCwdMatches(state.cwd, entry.header.cwd ?? '') &&
        entry.header.origin !== 'subagent' &&
        (entry.header.delegationDepth ?? 0) === 0,
      )
      const headerById = new Map(local.map(entry => [entry.header.id, entry]))
      // The live session's header may not be materialized in list() yet
      // (the jsonl backend writes on first append) — overlay the in-memory
      // header so the ancestor walk below still finds a fresh fork's parent.
      const liveListed = liveSessionListingFields(liveSession)
      const liveMeta = (liveSession as { header?: SessionHeader }).header
      if (!headerById.has(currentId) && liveListed.id !== undefined) {
        headerById.set(currentId, {
          header: {
            id: liveListed.id,
            cwd: liveListed.cwd,
            createdAt: liveListed.createdAt,
            parentSession: liveListed.parentSession,
            origin: liveListed.origin,
            delegationDepth: liveListed.delegationDepth,
            seedLength: liveListed.seedLength,
            agentPreset: liveListed.agentPreset,
          },
          raw: liveMeta,
        })
      }
      // Family = the live session's ancestor chain PLUS every descendant of
      // its topmost known ancestor (siblings and cousins included).
      const childrenByParent = new Map<string, string[]>()
      for (const entry of local) {
        if (entry.header.parentSession === undefined) continue
        const list = childrenByParent.get(entry.header.parentSession)
        if (list === undefined) childrenByParent.set(entry.header.parentSession, [entry.header.id])
        else list.push(entry.header.id)
      }
      const ancestorIds: string[] = []
      {
        const visited = new Set<string>([currentId])
        let cursor = headerById.get(currentId)
        while (cursor?.header.parentSession !== undefined) {
          const parentId = cursor.header.parentSession
          if (visited.has(parentId)) break
          visited.add(parentId)
          if (!headerById.has(parentId)) break
          ancestorIds.push(parentId)
          cursor = headerById.get(parentId)
        }
      }
      // BFS from the topmost ancestor. The scan must NOT be gated by family
      // membership: ancestor-chain nodes are already in the family, and
      // skipping them here would never enumerate their other children —
      // siblings/cousins forking off a MIDDLE ancestor would be lost.
      const family = new Set<string>([currentId, ...ancestorIds])
      {
        const scanned = new Set<string>()
        const queue = [ancestorIds.at(-1) ?? currentId]
        while (queue.length > 0) {
          const id = queue.shift()!
          if (scanned.has(id)) continue
          scanned.add(id)
          family.add(id)
          for (const child of childrenByParent.get(id) ?? []) {
            queue.push(child)
          }
        }
      }
      // Processing order is TOPOLOGICAL (a parent before its children): the
      // coverage bookkeeping below — which seq range each chain already
      // shows — feeds the next read's inherited-prefix skip, so a parent
      // must be read before its forks. Within each sibling group the live
      // chain wins, then newest first (the same priority the read budget
      // always had).
      const ancestorSet = new Set(ancestorIds)
      const priorityOf = (a: string, b: string): number => {
        const aChain = a === currentId || ancestorSet.has(a)
        const bChain = b === currentId || ancestorSet.has(b)
        if (aChain !== bChain) return aChain ? -1 : 1
        return (headerById.get(b)?.header.createdAt ?? 0) - (headerById.get(a)?.header.createdAt ?? 0)
      }
      const kidsOf = new Map<string, string[]>()
      const familyRoots: string[] = []
      for (const id of family) {
        const parentId = headerById.get(id)?.header.parentSession
        if (parentId !== undefined && parentId !== id && family.has(parentId)) {
          const list = kidsOf.get(parentId)
          if (list === undefined) kidsOf.set(parentId, [id])
          else list.push(id)
        } else {
          familyRoots.push(id)
        }
      }
      familyRoots.sort(priorityOf)
      for (const list of kidsOf.values()) list.sort(priorityOf)
      const ordered: string[] = []
      {
        const seen = new Set<string>()
        const stack = [...familyRoots].reverse()
        while (stack.length > 0) {
          const id = stack.pop()!
          if (seen.has(id)) continue
          seen.add(id)
          ordered.push(id)
          const kids = kidsOf.get(id)
          if (kids !== undefined) {
            for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!)
          }
        }
        // Cycle-broken leftovers (corrupt parent headers) — never drop one.
        for (const id of [...family].sort(priorityOf)) {
          if (!seen.has(id)) ordered.push(id)
        }
      }
      // Caps: the ancestor chain + live session ALWAYS stay selected — the
      // structural invariant (the live branch must reach the family root)
      // outranks the session cap, which therefore evicts only non-ancestors.
      // The event budget bounds the READ cost too: non-live logs decode
      // lazily and stop at the remaining budget (see below), the live
      // session keeps only its tail.
      const MAX_TREE_SESSIONS = 24
      const MAX_TREE_EVENTS = 200_000
      // The event budget alone does NOT bound read cost: skipped envelopes
      // (ignorable frames, headers) are paid for but never collected, so a
      // noisy log can return ZERO events and leave the next log a full scan
      // allowance — 23 logs × ~800k envelopes would block the TUI for
      // seconds. scanBudget caps the TOTAL envelopes inspected across all
      // logs (the reader reports its real scanned count); per-log caps
      // derive from the event budget as before, and the smaller of the two
      // applies, so one flood cannot starve every later sibling either.
      const MAX_TREE_SCANNED = defaultMaxScanned(MAX_TREE_EVENTS)
      let scanBudget = MAX_TREE_SCANNED
      const selected = new Set<string>()
      let slots = MAX_TREE_SESSIONS
      for (const id of ordered) {
        const chain = id === currentId || ancestorSet.has(id)
        if (chain || slots > 0) {
          selected.add(id)
          if (!chain) slots -= 1
        }
      }
      // The live session's events come from memory (its header may not be
      // materialized yet — the jsonl backend writes on first append).
      const liveHeader = headerById.get(currentId)
      const familySessions: FamilySession[] = []
      let truncated = selected.size < family.size
      let eventBudget = 0
      // Coverage bookkeeping: coveredThrough(S) = the highest K such that
      // [0..K] is already displayed by S's chain or an ancestor's. A fork's
      // inherited seed prefix duplicates that range, so non-live reads SKIP
      // it (the reader's skipBelowSeq): the prefix still costs scan budget
      // (its bytes are read and parsed) but NOT the event budget — a fork
      // of a huge parent pays only for its OWN events, so two small forks
      // of a 70k-event parent both stay visible. Unreadable/unloaded
      // sessions are transparent: they claim nothing beyond what their own
      // ancestors covered, so a fork of a dead branch dedups against the
      // grandparent instead of hiding its self-contained history.
      const coveredThrough = new Map<string, number>()
      for (const id of ordered) {
        if (!selected.has(id)) continue
        const entry = headerById.get(id)
        if (id === currentId) {
          const liveParentId = liveHeader?.header.parentSession ?? liveListed.parentSession
          const liveParent = liveParentId !== undefined ? String(liveParentId) : undefined
          const liveEvents = snapshotLiveSessionEvents(liveSession)
          const remaining = Math.max(0, MAX_TREE_EVENTS - eventBudget)
          // The live session's in-memory log is SELF-CONTAINED: a fork's
          // events still carry the inherited seed prefix, which the parent's
          // chain already displays (and already charged to the budget).
          // Skipping it exactly like the non-live reads do keeps a live fork
          // of a huge parent from spending the whole family budget on
          // duplicated history and evicting its own siblings.
          const liveSeed = liveHeader?.header.seedLength ?? liveListed.seedLength
          // A recorded parent without an exact cut is not a usable coverage
          // edge: the pure tree detaches it, so forwarding the parent's range
          // here would let descendants skip history no root displays.
          const parentCovered = liveParent !== undefined && liveSeed !== undefined
            ? (coveredThrough.get(liveParent) ?? -1)
            : -1
          const skipBelow =
            liveParent !== undefined && liveSeed !== undefined
              ? Math.min(liveSeed, parentCovered + 1)
              : 0
          const own = skipBelow > 0
            ? liveEvents.filter(event => event.seq >= skipBelow || event.type === 'session/title')
            : liveEvents
          // A live session larger than the remaining budget keeps its TAIL,
          // aligned to whole turns (sessionTree.liveTailWindow): leftover
          // entries of a turn whose turn/start was cut away render as
          // selectable rows that can never rewind; a window holding no
          // turn/start at all (one oversized LAST turn spans the budget)
          // retries over the earlier complete turns instead of blacking the
          // session out. Rewind itself never reads this copy (rewindToNode
          // forks the real session), so the slice only narrows what the tree
          // can display.
          const events = liveTailWindow(own, remaining)
          // Charge the KEPT tail, not the in-memory length: extraction only
          // ever touches `events`, and charging the full log would black out
          // every other family member's budget behind a discarded prefix.
          eventBudget += events.length
          if (events.length !== own.length) truncated = true
          familySessions.push({
            id,
            createdAt: liveHeader?.header.createdAt ?? liveListed.createdAt ?? Date.now(),
            ...(liveParent !== undefined ? { parentSession: liveParent } : {}),
            ...(liveHeader?.header.seedLength !== undefined || liveListed.seedLength !== undefined
              ? { seedLength: liveHeader?.header.seedLength ?? liveListed.seedLength }
              : {}),
            events,
            live: true,
            // The in-memory log always reaches the tip (liveTailWindow trims
            // the head only), so the adopt/warning UX facts are derivable.
            tailComplete: true,
          })
          // A kept tail cut off the front connects to nothing — coverage
          // stays at the parent's (a fork of the live session re-reads the
          // hidden prefix from its own log).
          const firstKept = events.length > 0 ? events[0]!.seq : Number.POSITIVE_INFINITY
          const lastKept = events.length > 0 ? events[events.length - 1]!.seq : -1
          coveredThrough.set(
            id,
            firstKept <= parentCovered + 1 ? Math.max(parentCovered, lastKept) : parentCovered,
          )
          continue
        }
        const header = entry?.header
        const parentId = header?.parentSession
        const structuralParentCovered = parentId !== undefined ? (coveredThrough.get(parentId) ?? -1) : -1
        const locate = persistence.locate
        const hasLocate = typeof locate === 'function'
        let locatedPath: string | undefined
        if (hasLocate && entry !== undefined) {
          try {
            const location: unknown = locate.call(persistence, entry.raw)
            // Only the jsonl kind enters the compat file layer — a foreign
            // kind's artifact is the backend's own format (inspect below).
            if (location !== null && typeof location === 'object') {
              const record = location as { kind?: unknown; path?: unknown }
              if (record.kind === 'jsonl' && typeof record.path === 'string') {
                locatedPath = record.path
              }
            }
          } catch {
            // Best effort — a locate hiccup falls through to inspect.
          }
        }
        // Alpha.4 deliberately omits the inherited cut from logical list
        // headers. Resolve it only for the SELECTED family node currently
        // being read: JSONL keeps the exact physical `seedLength`; non-file
        // backends expose the cut on inspect below. Never scan every listed
        // session and never infer it from an end-seed marker or log length.
        let inheritedCut = parentId === undefined ? undefined : readInheritedCut(entry?.raw)
        if (parentId !== undefined && inheritedCut === undefined) {
          inheritedCut = locatedPath !== undefined
            ? readPhysicalHeaderSeedLength(locatedPath)
            : !hasLocate
                ? readPhysicalHeaderSeedLengthForSession(id)
                : undefined
        }
        // Keep structural ancestry separate from proven dedup coverage. The
        // model layer detaches a parent edge whose exact cut is unavailable;
        // treating that edge as covered here would hide a child's prefix
        // under a parent root that no longer owns it.
        let parentCovered = parentId !== undefined && inheritedCut !== undefined
          ? structuralParentCovered
          : -1
        // Never skip past the seed prefix: events beyond it are this
        // session's OWN — no ancestor can show them. A parent that was never
        // read (evicted, or outside the family) covers nothing (skip 0).
        let skipBelow =
          parentId !== undefined && inheritedCut !== undefined
            ? Math.min(inheritedCut, parentCovered + 1)
            : 0
        let facts: FamilySession = {
          id,
          createdAt: header?.createdAt ?? 0,
          events: [],
          live: false,
          ...(parentId !== undefined ? { parentSession: parentId } : {}),
          ...(inheritedCut !== undefined ? { seedLength: inheritedCut } : {}),
        }
        if (eventBudget >= MAX_TREE_EVENTS || scanBudget <= 0) {
          // Budget spent: keep the STRUCTURE — the session degrades to an
          // unloaded placeholder so its branch (and any ancestor chain
          // through it) stays visible instead of vanishing from the tree.
          truncated = true
          familySessions.push({ ...facts, events: [], live: false, unloaded: true })
          coveredThrough.set(id, parentCovered)
          continue
        }
        // Read-only, tolerant, bounded: the compat reader decodes frames
        // lazily and stops at the remaining event budget. Browsing the tree
        // must never REWRITE history logs (the ignorable-marking repair
        // stays on the explicit resume/rewind path), and the strict backend
        // inspect would both reject third-party event types wholesale and
        // parse chunk-heavy logs whole. Header facts come from list().
        const remaining = MAX_TREE_EVENTS - eventBudget
        // Source precedence, all read-only:
        //  1. persistence.locate — the backend's OWN artifact resolution is
        //     authoritative (custom root, workspace-key scheme). When it
        //     names a path, ONLY that file is read: falling back to a
        //     same-id copy under the stock root could surface a STALE log
        //     from another backend configuration. A locate miss or an ABSENT
        //     file falls through to inspect, never to the stock scan.
        //  2. Stock root scan — only for backends WITHOUT locate (fakes,
        //     older custom implementations).
        //  3. inspect — the backend's strict read (non-file backends), with
        //     the same budget enforced on what we keep — and ONLY when the
        //     file read found NOTHING (undefined). A read that failed on a
        //     safety cap or corruption (failed) must never escalate here:
        //     inspect parses the WHOLE log up front, so falling through
        //     would re-read unboundedly exactly the logs the caps exist to
        //     bound (64 MiB frames, decode bombs) — degrade to a placeholder
        //     instead.
        let events: readonly SessionEvent[] | undefined
        let complete = true
        let failed = false
        // First seq the chosen source actually covers: the file readers start
        // at the inherited-prefix skip, inspect always hands the whole log.
        let readFrom = 0
        // Per-log scan allowance: the usual 4×-of-remaining derivation,
        // clamped to what the tree-level scan budget still has.
        const scanAllowance = Math.min(defaultMaxScanned(remaining), scanBudget)
        if (hasLocate) {
          if (locatedPath !== undefined) {
            const viaPath = readSessionEventsFromFile(locatedPath, remaining, scanAllowance, skipBelow)
            if (viaPath !== undefined) {
              scanBudget -= viaPath.scanned
              if (viaPath.failed === true) failed = true
              else {
                events = viaPath.events
                complete = viaPath.complete
                readFrom = skipBelow
              }
            }
          }
        } else if (!hasLocate) {
          const read = readSessionEventsFromLog(id, remaining, scanAllowance, skipBelow)
          if (read !== undefined) {
            scanBudget -= read.scanned
            if (read.failed === true) failed = true
            else {
              events = read.events
              complete = read.complete
              readFrom = skipBelow
            }
          }
        }
        if (!failed && events === undefined && typeof persistence.inspect === 'function') {
          try {
            const inspection = await persistence.inspect(SessionId(id))
            const inspectedCut = readInheritedCut(inspection)
            if (parentId !== undefined && inheritedCut === undefined && inspectedCut !== undefined) {
              inheritedCut = inspectedCut
              parentCovered = structuralParentCovered
              skipBelow = parentId !== undefined
                ? Math.min(inheritedCut, parentCovered + 1)
                : 0
              facts = { ...facts, seedLength: inheritedCut }
            }
            // inspect parses the WHOLE log up front: charge the full length
            // to the scan budget (may overdraw; the next iterations skip).
            scanBudget -= inspection.events.length
            // Non-file backends hand back the self-contained log from seq 0:
            // the inherited-prefix skip the file readers got must apply here
            // too, or a long prefix would fill the slice and the branch's OWN
            // events — the only ones nobody else displays — would be cut.
            const all = skipBelow > 0
              ? inspection.events.filter(event => event.seq >= skipBelow || event.type === 'session/title')
              : inspection.events
            readFrom = skipBelow
            events = all
            if (events.length > remaining) {
              events = events.slice(0, remaining)
              complete = false
            }
          } catch {
            events = undefined
          }
        }
        if (failed || events === undefined) {
          // An unreadable log keeps the branch structure, no entries — and
          // stays transparent for coverage, so a fork of this branch dedups
          // against the grandparent instead of hiding its own history.
          familySessions.push({ ...facts, events: [], live: false, unreadable: true })
          coveredThrough.set(id, parentCovered)
          continue
        }
        eventBudget += events.length
        if (!complete) truncated = true
        // tailComplete gates the branch-adopt target and the drop-turn
        // warning: a budget-sliced read lost the tail, and a tip computed
        // from it would fork mid-branch while claiming to keep everything.
        familySessions.push({ ...facts, events, live: false, ...(complete ? { tailComplete: true } : {}) })
        const lastRead = events.length > 0 ? events[events.length - 1]!.seq : -1
        coveredThrough.set(
          id,
          readFrom <= parentCovered + 1 ? Math.max(parentCovered, lastRead) : parentCovered,
        )
      }
      // A session swap mid-build invalidates the whole assembly (it mixes
      // the snapshot's lineage with headers listed for the OLD cwd state):
      // drop it silently — the reopened tree rebuilds on the new session.
      if (agent.session !== liveSession) return null
      return buildSessionTree(familySessions, currentId, truncated)
    },
    async rewindToNode(sessionId: string, seq: number, mode: 'rewind' | 'fork' = 'rewind'): Promise<string | null> {
      const agents = ctx.get('agents') as
        | { create(options: CreateAgentOptions): Promise<AgentHandle> }
        | undefined
      if (!agents) {
        state.notify(t('rewind-unavailable'), { color: 'error' })
        return null
      }
      // An in-flight manual compaction must not straddle the snapshot below
      // (live branch) nor keep summarizing the current session while the
      // rewind targets another — cancel and await it first.
      await settleManualCompaction()
      // Pin the entry-time session: the awaits below (log load, preset
      // compose, agent create) are windows in which a queued switch
      // (/new, /resume, /model) can swap `agent` — the mutation queue only
      // serializes the REPLACING entries, so the boundary and restored text
      // derive from THIS session's log and any swap along the way aborts
      // the rewind (forking or disposing whatever agent happens to be
      // current at the end would rewind the wrong session).
      const entrySession = agent.session
      const currentId = String(entrySession.id)
      const childId = SessionId(randomUUID())
      // Source events: the live session from memory; any other family member
      // from its durable log (legacy event types registered first — the same
      // in-process compat seam as resumeTo, since load validates known types).
      let sourceEvents: readonly SessionEvent[]
      let sourceCwd = state.cwd
      let forkFromLive = true
      if (sessionId === currentId) {
        sourceEvents = snapshotLiveSessionEvents(entrySession)
      } else {
        forkFromLive = false
        const persistence = ctx.get('sessionPersistence') as
          | {
            load(id: SessionId): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }>
          }
          | undefined
        if (!persistence || typeof persistence.load !== 'function') {
          state.notify(t('rewind-no-persistence'), { color: 'error' })
          return null
        }
        try {
          ensureLegacySessionEventTypes()
          const loaded = await persistence.load(SessionId(sessionId))
          sourceEvents = loaded.events
          sourceCwd = loaded.meta.cwd ?? state.cwd
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          state.notify(t('rewind-load-failed', { err: message }), { color: 'error' })
          return null
        }
      }
      // DSH event order is `turn/start → user/message → … → turn/end`, and a
      // fork seed must not end inside an open turn. pi's navigateTree
      // semantics mapped onto that constraint (sessionTree.rewindTarget): a
      // USER message drops its turn — the boundary sits just before the
      // turn/start and the prompt comes back into the input for re-editing;
      // any OTHER entry keeps through its enclosing STEP — a mid-turn cut at
      // the step/end with the turn closed synthetically (DSH agentic turns
      // span thousands of events, so turn-granular keeping would barely move
      // the visible history). Fork mode (pi's /fork) instead KEEPS the
      // picked entry: a user message cuts right after itself (the turn's
      // reply drops) and never returns text to the input.
      const target = mode === 'fork'
        ? forkTarget(sourceEvents, seq)
        : rewindTarget(sourceEvents, seq)
      const boundary = target.boundary
      if (boundary < 0) {
        state.notify(t('rewind-first-message'), { color: 'error' })
        return null
      }
      // Keeping the entry can still be a NO-OP: when nothing message-bearing
      // follows the boundary (only a turn/end, or nothing at all), the fork's
      // transcript would be identical to the live one. pi truncates to right
      // after the entry; DSH's step/turn-closed seed cannot always express
      // that, so the honest answer is to say there is nothing to rewind. A
      // DEAD session's tip still forks: that adopts the branch, a real
      // switch.
      if (forkFromLive && !sourceEvents.some(event =>
        event.seq > boundary &&
        (event.type === 'user/message' || event.type === 'assistant/message' ||
          event.type === 'tool/call' || event.type === 'tool/result'))) {
        state.notify(t('rewind-noop'), { color: 'warning' })
        return null
      }
      // The dropped turn's own prompt text, restored into the input after
      // the swap ('' whenever the entry was kept — fork mode included — or
      // the turn had no human-typed text to restore).
      const restoredText = mode === 'fork' ? '' : turnUserText(sourceEvents, seq)
      // The fork continues under the source session's own preset: switches
      // are blank-only, so every `agent-preset/selected` event predates any
      // rewind boundary and the source log resolves the exact composition.
      // The route likewise stays the live one — a rewind continues the same
      // conversation, so a `/model` switch must survive it (issue #30).
      const sourcePreset = forkFromLive
        ? runningPresetOf(entrySession)
        : ((await resolvePersistedPreset(ctx, SessionId(sessionId))) ?? runningPresetOf(entrySession))
      const rewindComposed = await composePreset(ctx, sourcePreset)
      // Everything fallible is done — only NOW stop a running turn (a load
      // or preset failure above must not kill it). But bail first when the
      // live session was swapped during those awaits: cancelling/forking
      // now would hit the NEW session with THIS session's boundary.
      if (agent.session !== entrySession) {
        state.notify(t('rewind-session-changed'), { color: 'error' })
        return null
      }
      // Stop a running turn first and WAIT for its turn/end to land: fork
      // rejects boundaries inside open turns, and Agent.cancel() closes the
      // turn asynchronously (a long thinking turn can take seconds to
      // settle). Cross-session rewinds need this too: the live agent is
      // about to be disposed, and its turn must close cleanly.
      const wasWorking = state.working
      const cancelSeq = liveSessionOffset(agent.session)
      if (wasWorking) agent.cancel({ kind: 'user' })
      if (wasWorking) {
        const turnSettled = await waitForTurnEnd(agent.session, cancelSeq, 30000)
        if (!turnSettled) {
          state.notify(t('rewind-settling'), { color: 'error' })
          return null
        }
      }
      // Slice the seed from the PINNED event snapshot. Never sessions.fork
      // here: fork() rejects a boundary inside an open turn, which is
      // exactly where a keep-style cut lands (closeTurn set) — close it
      // with the exact event a real user cancellation writes instead.
      // agents.create validates the result itself (contiguous from seq 0,
      // no open turns).
      const seed = sourceEvents.filter(event => event.seq <= boundary)
      const inheritedCount = seed.length
      if (target.closeTurn !== undefined) {
        appendInterruptedTurnEnd(seed, target.closeTurn)
      }
      let handle: AgentHandle
      try {
        handle = await agents.create(liveSessionCreateOptions({
          sessionId: childId,
          seed,
          runtimeSession: entrySession,
          inheritedCount,
          cwd: sourceCwd,
          parentSession: SessionId(sessionId),
          agentPreset: rewindComposed.agentPreset,
          agentOptions: { provider: state.provider, model: state.model },
          setup: rewindComposed.setup,
        }))
      } catch {
        state.notify(t('rewind-create-failed'), { color: 'error' })
        return null
      }
      try {
        await attachSessionToWorkspace(ctx, sourceCwd, childId)
      } catch (error) {
        state.notify(
          t('rewind-attach-failed', { err: error instanceof Error ? error.message : String(error) }),
          { color: 'warning', timeoutMs: 8000 },
        )
      }
      // The create await was another swap window: adopting now would dispose
      // the NEW session's agent. Free the fork we just made and bail.
      if (agent.session !== entrySession) {
        void handle.dispose().catch(() => {})
        state.notify(t('rewind-session-changed'), { color: 'error' })
        return null
      }
      // Replay the forked history into a fresh transcript (the same swap
      // tail rewindTo runs), then announce the session switch.
      const sourceSessionId = adoptForkedAgent(handle, seed, rewindComposed.agentPreset, childId)
      notifySessionSwitched(mode === 'fork' ? 'fork' : 'rewind', String(childId), sourceSessionId)
      return restoredText
    },
    async forkSession(): Promise<boolean> {
      const agents = ctx.get('agents') as
        | { create(options: CreateAgentOptions): Promise<AgentHandle> }
        | undefined
      if (!agents) {
        state.notify(t('fork-unavailable'), { color: 'error' })
        return false
      }
      // kimi-code /fork semantics: refuse mid-turn instead of cancelling —
      // the fork must not surprise the user by killing their running turn,
      // and sessions.fork rejects an open-turn log anyway.
      if (state.working) {
        state.notify(t('fork-while-working'), { color: 'warning' })
        return false
      }
      // An in-flight manual compaction must not straddle the fork snapshot:
      // cancel and await it, or its checkpoint could commit right after the
      // seed copy below and quietly replace history the fork preserved.
      await settleManualCompaction()
      const source = agent.session
      const childId = SessionId(randomUUID())
      // No boundary: the whole (turn-closed) source log. Slice the source
      // snapshot — sessions.fork() would register a child and append
      // session/end-seed, so snapshot.length is not a lineage cut.
      let seed: readonly SessionEvent[]
      try {
        seed = sliceLiveSessionSeed(source)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state.notify(t('fork-failed', { err: message }), { color: 'error' })
        return false
      }
      // Same preset/route rule as a rewind fork: the source log's own
      // composition, the live route (a /model switch survives forking).
      const forkComposed = await composePreset(ctx, runningPresetOf(source))
      let handle: AgentHandle
      try {
        handle = await agents.create(liveSessionCreateOptions({
          sessionId: childId,
          seed,
          runtimeSession: source,
          inheritedCount: seed.length,
          cwd: state.cwd,
          // NO parentSession: a /fork copy is an independent conversation
          // (kimi-code semantics — a copy of the message list under a new
          // root session, like /new plus the history), not a rewind branch.
          // Recording lineage would fold it into the source's family in
          // /resume and the user would never find it.
          agentPreset: forkComposed.agentPreset,
          agentOptions: { provider: state.provider, model: state.model },
          setup: forkComposed.setup,
        }))
      } catch {
        state.notify(t('fork-create-failed'), { color: 'error' })
        return false
      }
      // STAY in the source session: adopting the fork would dispose the live
      // agent (killing its in-flight turn and background tasks) — the fork is
      // an independent copy the user enters via /resume or the printed resume
      // command. The teardown order matters:
      // 1. attach while the fork's agent is still LIVE — the workspace's
      //    header read resolves live sessions from the registry, so attaching
      //    after dispose races the persistence index and can fail with
      //    "cannot validate session".
      // 2. await the dispose so the seed log finishes flushing…
      // 3. …then append the Fork: title — appending mid-flush races the
      //    writer and the frame is silently dropped.
      try {
        await attachSessionToWorkspace(ctx, state.cwd, childId)
      } catch (error) {
        state.notify(
          t('fork-attach-failed', { err: error instanceof Error ? error.message : String(error) }),
          { color: 'warning', timeoutMs: 8000 },
        )
      }
      try {
        await handle.dispose()
      } catch (error: unknown) {
        ctx.logger.warn('dsh-tui: forked session dispose failed: %o', error)
      }
      // kimi's naming convention: the fork wears `Fork: <source title>` (the
      // prefix stays English in both locales). Best effort — a backend whose
      // log the compat layer cannot reach just leaves the fork untitled.
      const sourceTitle = state.sessionTitle.trim()
      appendSessionTitle(String(childId), `Fork: ${sourceTitle === '' ? String(source.id).slice(0, 8) : sourceTitle}`)
      // The same resume-command shape the exit hint prints (plugin.ts
      // resumeCommand): DSH_TUI_RESUME_SESSION + the boot profile.
      const profile = resolveDshProfileName()
      const boot = profile === undefined ? 'dsh --config cordis.yml' : `dsh --profile ${profile}`
      const command = process.platform === 'win32'
        ? `dsh-tui --resume ${childId}`
        : `DSH_TUI_RESUME_SESSION=${childId} ${boot}`
      state.notify(t('fork-done', { id: String(childId), command }), { timeoutMs: 8000 })
      return true
    },
    async resumeTo(sessionId: string): Promise<ResumeResult> {
      // Switch the live agent to a persisted session: /resume picker Enter
      // loads the history immediately (the `--resume` launcher path keeps
      // resolving through DSH_TUI_RESUME_SESSION at boot).
      if (state.working) {
        state.notify(t('resume-while-working'), { color: 'warning' })
        return { ok: false, reason: 'working' }
      }
      const agents = ctx.get('agents') as
        | {
          resume(options: {
            resumeSessionId: SessionId
            agentOptions?: { provider?: string; model?: string }
            setup?: CreateAgentOptions['setup']
          }): Promise<AgentHandle>
        }
        | undefined
      if (!agents) {
        state.notify(t('resume-unavailable'), { color: 'error' })
        return { ok: false, reason: 'unavailable' }
      }
      // Plugin veto point (tui/session-switch): before any read of the
      // target — a veto leaves the live session and its transcript
      // untouched.
      if (await sessionSwitchVetoed('resume', sessionId)) return { ok: false, reason: 'cancelled' }
      // The live session's in-flight manual compaction must not keep running
      // (and commit its checkpoint) once we leave it for the target — cancel
      // and await it before any target read.
      await settleManualCompaction()
      // Identity pin for the rival-swap guard below: everything between here
      // and the adoption can await (veto, preset, route, agents.resume), and
      // an interrupt-queued /new or a second /resume may commit a different
      // swap in that window.
      const entrySession = agent.session
      let handle: AgentHandle
      // Compat boundary: register vouched-for legacy event types (e.g.
      // activity/status from pre-#143 logs) in every reachable dsh-session
      // copy before ANY strict read path (preset lookup below, then the
      // harness seed validation) loads the target — the plugin's #119
      // registration never ran in processes where it is unmounted (issue
      // #153). In-process only: the shared log is never rewritten.
      ensureLegacySessionEventTypes()
      // The target session's own preset (from its persisted log) — never the
      // current preference: a resume re-enters the composition its history
      // was produced under. Same rule for the route: only an explicit
      // cordis.yml provider/model overrides the route the target's own
      // request/header records (issue #30) — and only as a COMPLETE pair
      // (issue #67): a provider-only pin must not merge with the recorded
      // model half into a route no adapter recognizes.
      const resumeComposed = await composePreset(
        ctx,
        await resolvePersistedPreset(ctx, SessionId(sessionId)),
      )
      const resumeRoute = explicitModelRoute({
        provider: options.configuredProvider,
        model: options.configuredModel,
      })
      // The recorded route feeds back into agentOptions too — not just the
      // status line below: a provider-only cordis.yml pin (issue #67) leaves
      // agentOptions.model undefined on resume, which breaks the `{{model}}`
      // persona variable for the resumed agent's own assembly AND for every
      // subagent it spawns (dsh-subagent's resolveChildAgentOptions inherits
      // `parent.options.model`).
      const recordedRoute = await resolvePersistedRoute(ctx, SessionId(sessionId))
      try {
        handle = await agents.resume({
          resumeSessionId: SessionId(sessionId),
          agentOptions: {
            provider: resumeRoute?.provider ?? recordedRoute?.provider,
            model: resumeRoute?.model ?? recordedRoute?.model,
          },
          ...(resumeComposed.setup === undefined ? {} : { setup: resumeComposed.setup }),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state.notify(t('resume-failed', { err: message }), { color: 'error', timeoutMs: 8000 })
        return { ok: false, reason: 'failed', error: message }
      }
      try {
        // `/resume` is an explicit adoption of this persisted conversation.
        // This also repairs sessions created by TUI versions that predate the
        // separate workspace ownership ledger.
        await attachSessionToWorkspace(ctx, handle.agent.session.header.cwd ?? state.cwd, SessionId(sessionId))
      } catch (error) {
        state.notify(
          t('resume-attach-failed', { err: error instanceof Error ? error.message : String(error) }),
          { color: 'warning', timeoutMs: 8000 },
        )
      }
      // Rival-swap guard (rewindToNode's entrySession check, applied to the
      // resume path): the awaits above can straddle another session swap
      // committing first, and adopting now would stomp the newer session's
      // live transcript with this target's replay. Free the just-created
      // handle and bail — the live session stays exactly as the rival left
      // it, and the persisted target simply stays in /resume.
      if (agent.session !== entrySession) {
        void handle.dispose().catch(() => {})
        state.notify(t('resume-session-changed'), { color: 'error' })
        return { ok: false, reason: 'failed', error: 'live session changed during resume' }
      }
      // Replay the persisted history into a fresh transcript (same reset as
      // rewindTo, plus the context window which the replay re-derives).
      streaming = undefined
      reasoning = undefined
      // Stale sealed/thinking bookkeeping belongs to the OLD agent's rows;
      // keep it out of the next turn's settle logs and revive cache.
      sealedReasoning.length = 0
      lastReasoningRow = undefined
      toolCards.clear()
      nextRowId = 0
      state.rows.length = 0
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
      // Adopt the resumed session's persisted cwd (issue #96): pre-upgrade
      // sessions recorded the LAUNCH directory (often a repo subdirectory),
      // so keeping the freshly resolved root would split @ expansion / file
      // completion (state.cwd) from the agent's own workspace record — and
      // drop the session back out of the /resume filter. The branch
      // breadcrumb follows the adopted cwd.
      state.cwd = handle.agent.session.header.cwd ?? state.cwd
      state.displayCwd = workspaceService.describe(state.cwd).description ?? state.cwd
      refreshGitBranch()
      state.agentPreset = resumeComposed.agentPreset
      // Status-line route follows the resumed session (review feedback): the
      // route it actually continues on — a complete cordis.yml pin, else the
      // route its own request/header records carry. A bare log (no turn ever
      // started) records none; keep the current display as best effort.
      const resumedRoute = resumeRoute ?? recordedModelRoute(snapshotLiveSessionEvents(handle.agent.session))
      if (resumedRoute !== undefined) {
        state.provider = resumedRoute.provider
        state.model = resumedRoute.model
      }
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
      replayEvents(snapshotLiveSessionEvents(handle.agent.session))
      settleStreaming()
      // A log ending mid-turn replays a turn/start that set working=true;
      // mirror the boot path's post-replay reset (a still-running agent
      // re-asserts on its next event).
      state.working = handle.agent.status === 'running'
      // Rebind subscriptions to the resumed agent, then free the old one.
      const oldHandle = currentHandle
      const previousSessionId = String(agent.session.id)
      agent = handle.agent
      currentHandle = handle
      bindAgent()
      refreshCommandList()
      void refreshLoadedContext()
      void refreshSkillCommands()
      // Keep the `--resume` launcher contract pointing at the same session.
      writeResumeTarget(sessionId)
      // The resumed session is now the most recently used.
      touchSession(sessionId)
      state.emit()
      void oldHandle?.dispose().catch(() => {})
      clearStagedImages()
      notifySessionSwitched('resume', sessionId, previousSessionId)
      return { ok: true }
    },
    async newSession(): Promise<boolean> {
      // `/new` — start a fresh conversation: brand-new agent + session, the
      // transcript reset, the `--resume` marker forgotten (the old session
      // stays persisted for /resume). Same reset shape as rewindTo/resumeTo.
      if (state.working) {
        state.notify(t('new-session-while-working'), {
          color: 'warning',
        })
        return false
      }
      const agents = ctx.get('agents') as
        | { create(options: CreateAgentOptions): Promise<AgentHandle> }
        | undefined
      if (!agents) {
        state.notify(t('new-session-unavailable'), {
          color: 'error',
        })
        return false
      }
      // Plugin veto point (tui/session-switch): no side effects have
      // happened yet — the session id below is not even allocated.
      if (await sessionSwitchVetoed('new')) return false
      // Leaving the live session: its in-flight manual compaction must not
      // keep summarizing (and later commit a checkpoint the user believes
      // cancelled) — cancel and await it first.
      await settleManualCompaction()
      const sessionId = SessionId(randomUUID())
      let handle: AgentHandle
      // A fresh session composes the caller's DEFAULT preset: the cordis.yml
      // `preset` key wins over the persisted `/preset` choice, which wins
      // over the roster default (same precedence as activityFrames).
      const presetPref = options.configuredPreset === undefined ? readPresetPref() : undefined
      const newComposed = await composePreset(ctx, options.configuredPreset ?? presetPref)
      if (!migratePresetPref(presetPref, newComposed.agentPreset)) {
        state.notify(
          t('preset-switched-pref-failed', { id: newComposed.agentPreset ?? presetPref ?? 'unknown' }),
          { color: 'warning' },
        )
      }
      // Same precedence for the route (issues #14/#30/#67): the pair resolves
      // atomically — a complete cordis.yml route wins whole, else the
      // persisted `/model` choice (a switch earlier in this run just wrote
      // it, so `/new` follows the live model) wins whole, else the startup
      // route. A stale persisted choice that the adapter catalog rejects
      // falls back to the startup route wholesale, with a warning.
      const newResolved = resolveModelRoute(
        { provider: options.configuredProvider, model: options.configuredModel },
        readModelPref(),
        { provider: options.provider, model: options.model },
      )
      const newLlm = ctx.get('llm') as
        | { listModels(provider: string): Promise<readonly { id: string }[]> }
        | undefined
      const { route, rejected } = await validateModelRoute(newLlm, newResolved, {
        provider: options.provider,
        model: options.model,
      })
      if (rejected !== undefined) {
        state.notify(
          t('model-route-invalid', {
            provider: rejected.provider,
            model: rejected.model,
            fallback: `${route.provider}/${route.model}`,
          }),
          { color: 'warning', timeoutMs: 8000 },
        )
      }
      try {
        handle = await agents.create({
          sessionId,
          meta: {
            cwd: state.cwd,
            ...(newComposed.agentPreset === undefined
              ? {}
              : { agentPreset: newComposed.agentPreset }),
          },
          agentOptions: route,
          ...(newComposed.setup === undefined ? {} : { setup: newComposed.setup }),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state.notify(t('new-session-failed', { err: message }), {
          color: 'error',
          timeoutMs: 8000,
        })
        return false
      }
      try {
        await attachSessionToWorkspace(ctx, state.cwd, sessionId)
      } catch (error) {
        state.notify(
          t('new-session-attach-failed', { err: error instanceof Error ? error.message : String(error) }),
          { color: 'warning', timeoutMs: 8000 },
        )
      }
      streaming = undefined
      reasoning = undefined
      // Stale sealed/thinking bookkeeping belongs to the OLD agent's rows;
      // keep it out of the next turn's settle logs and revive cache. Event
      // sequence numbers restart in the fresh session, so its dedupe ledgers
      // must not retain the old session's sequence ids.
      sealedReasoning.length = 0
      lastReasoningRow = undefined
      toolCards.clear()
      handledAssistantMessages.clear()
      handledAssistantChunks.clear()
      assistantRowsByStep.clear()
      lastTextDelta.clear()
      nextRowId = 0
      state.rows.length = 0
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
      state.agentPreset = newComposed.agentPreset
      state.model = route.model
      state.provider = route.provider
      state.tps = undefined
      state.tpsSamples = []
      state.lastUsage = undefined
      state.workingActivity = undefined
      state.loadedContext = undefined
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
      const oldHandle = currentHandle
      const previousSessionId = String(agent.session.id)
      agent = handle.agent
      currentHandle = handle
      bindAgent()
      refreshCommandList()
      void refreshLoadedContext()
      void refreshSkillCommands()
      clearResumeTarget()
      // The brand-new session becomes the most recently used.
      touchSession(handle.agent.id)
      void oldHandle?.dispose().catch(() => {})
      clearStagedImages()
      notifySessionSwitched('new', String(handle.agent.id), previousSessionId)
      return true
    },
    listWorkspaces() {
      return workspaceService.list(state.cwd)
    },
    resolveWorkspace(uri: string) {
      return workspaceService.resolve(uri, state.cwd)
    },
    async switchWorkspace(target: TuiWorkspaceTarget): Promise<boolean> {
      if (state.working) {
        state.notify(t('workspace-switch-working'), { color: 'warning' })
        return false
      }
      // Local targets must exist and be directories — creating a session in
      // a typo'd cwd "succeeds" and then every file tool errors per call.
      if (target.kind === 'local') {
        try {
          if (!statSync(target.cwd).isDirectory()) throw new Error('not a directory')
        } catch {
          state.notify(t('workspace-open-invalid', { target: target.label }), { color: 'error', timeoutMs: 8000 })
          return false
        }
      }
      const previousCwd = state.cwd
      const previousDisplay = state.displayCwd
      state.cwd = target.cwd
      state.displayCwd = target.description ?? target.uri
      const switched = await state.newSession()
      if (!switched) {
        state.cwd = previousCwd
        state.displayCwd = previousDisplay
        return false
      }
      // The breadcrumb follows the adopted cwd, same as /resume (#96).
      refreshGitBranch()
      state.notify(t('workspace-switched', { target: target.label }))
      state.emit()
      return true
    },
    async renameWorkspace(title: string): Promise<boolean> {
      try {
        const renamed = await workspaceService.rename(state.cwd, title)
        state.displayCwd = renamed.description ?? renamed.uri
        state.notify(t('workspace-renamed', { title: renamed.label }))
        state.emit()
        return true
      } catch (error) {
        state.notify(
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
      // `/model` picker Enter — switch the live model by forking the
      // conversation at its current end and continuing with a new agent
      // routed to the chosen model. Same reset shape as rewindTo/resumeTo;
      // the history replays unchanged, only the request model changes.
      if (state.working) {
        state.notify(t('model-switch-while-working'), {
          color: 'warning',
        })
        return false
      }
      const agents = ctx.get('agents') as
        | { create(options: CreateAgentOptions): Promise<AgentHandle> }
        | undefined
      if (!agents) {
        state.notify(t('model-switch-unavailable'), {
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
        // No boundary = the whole source log (continue the conversation).
        seed = sliceLiveSessionSeed(agent.session)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state.notify(t('model-switch-fork-failed', { err: message }), { color: 'error' })
        return false
      }
      const childId = SessionId(randomUUID())
      let handle: AgentHandle
      // The forked conversation keeps the session's own preset — only the
      // request route changes (same rule as rewindTo).
      const modelComposed = await composePreset(ctx, runningPresetOf(agent.session))
      try {
        handle = await agents.create(liveSessionCreateOptions({
          sessionId: childId,
          seed,
          runtimeSession: agent.session,
          inheritedCount: seed.length,
          cwd: state.cwd,
          parentSession: agent.session.id,
          agentPreset: modelComposed.agentPreset,
          agentOptions: { provider, model },
          setup: modelComposed.setup,
        }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state.notify(t('model-switch-failed', { err: message }), { color: 'error', timeoutMs: 8000 })
        return false
      }
      try {
        await attachSessionToWorkspace(ctx, state.cwd, childId)
      } catch (error) {
        state.notify(
          t('model-switch-attach-failed', { err: error instanceof Error ? error.message : String(error) }),
          { color: 'warning', timeoutMs: 8000 },
        )
      }
      streaming = undefined
      reasoning = undefined
      // Stale sealed/thinking bookkeeping belongs to the OLD agent's rows;
      // keep it out of the next turn's settle logs and revive cache.
      sealedReasoning.length = 0
      lastReasoningRow = undefined
      toolCards.clear()
      nextRowId = 0
      state.rows.length = 0
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
      replayEvents(seed)
      settleStreaming()
      // Same mid-turn-seed spinner reset as resume above.
      state.working = handle.agent.status === 'running'
      const oldHandle = currentHandle
      agent = handle.agent
      currentHandle = handle
      bindAgent()
      // Model-switch quip rides the fresh tracker (pi parity).
      updateWorkingActivity('model switch', () => activityTracker.onModelSwitch(model))
      refreshCommandList()
      void refreshLoadedContext()
      void refreshSkillCommands()
      // The model-switched fork becomes the most recently used.
      touchSession(childId)
      state.emit()
      void oldHandle?.dispose().catch(() => {})
      // Staged image tokens were typed against the pre-switch conversation;
      // resumeTo/newSession already drop theirs on the swap — same contract.
      clearStagedImages()
      // Persist the choice so the next boot and `/new` start on it (same
      // contract as /preset and /effort; issues #14/#30). A failed
      // write keeps the live switch but warns it will not survive a restart.
      if (!writeModelPref(provider, model)) {
        state.notify(t('model-pref-write-failed'), {
          color: 'warning',
        })
      }
      return true
    },
    listEfforts,
    setEffort,
    cycleMode,
    clear() {
      state.rows.length = 0
      nextRowId = 0
      streaming = undefined
      reasoning = undefined
      toolCards.clear()
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
        id: nextRowId,
        kind: 'notice',
        text: 'Session cleared',
      })
      nextRowId += 1
      state.emit()
    },
    notify(text, options = {}) {
      const item: NotificationItem = {
        id: nextNotificationId++,
        text,
        color: options.color,
        timeoutMs: options.timeoutMs ?? 4000,
      }
      state.notifications.push(item)
      state.emit()
      const remove = (): void => {
        const index = state.notifications.indexOf(item)
        if (index >= 0) {
          state.notifications.splice(index, 1)
          state.emit()
        }
      }
      // timeoutMs 0 = sticky: no expiry timer, the dismiss handle is the
      // only way out (a decision-parked indicator must outlive the wait it
      // describes — auto-expiring it would hide a still-parked flow, D-8).
      const expire = item.timeoutMs > 0 ? setTimeout(remove, item.timeoutMs) : undefined
      // Early-dismiss handle for flows that know their notice went stale
      // (e.g. a decision-parked indicator whose decision just landed).
      return () => {
        if (expire !== undefined) clearTimeout(expire)
        remove()
      }
    },
    setDiffLayout(layout) {
      if (layout === state.diffLayout) return
      state.diffLayout = layout
      state.emit()
    },
    setThinkingFold(mode) {
      if (mode === state.thinkingFold) return
      state.thinkingFold = mode
      state.emit()
    },
    setToolBackground(background) {
      const normalized = normalizeToolBackground(background)
      if (normalized === state.toolBackground) return
      state.toolBackground = normalized
      state.emit()
    },
    setScrollGutter(mode) {
      const normalized = normalizeScrollGutter(mode)
      if (normalized === state.scrollGutter) return
      state.scrollGutter = normalized
      state.emit()
    },
    setPageMargin(setting) {
      const normalized = normalizePageMargin(setting)
      if (normalized === state.pageMargin) return
      state.pageMargin = normalized
      state.emit()
    },
    setFoldTerminalCommand(enabled) {
      if (enabled === state.foldTerminalCommand) return
      state.foldTerminalCommand = enabled
      state.emit()
    },
    setPromptSessionLabel(enabled) {
      if (enabled === state.promptSessionLabel) return
      state.promptSessionLabel = enabled
      state.emit()
    },
    setExpandEditor(enabled) {
      if (enabled === state.expandEditor) return
      state.expandEditor = enabled
      state.emit()
    },
    setSmoothStreaming(enabled) {
      if (enabled === state.smoothStreaming) return
      state.smoothStreaming = enabled
      state.emit()
    },
    setStatusBar(config) {
      const next = normalizeStatusBar({ ...state.statusBar, ...config })
      const changed = Object.keys(next).some(key =>
        next[key as keyof StatusBarConfig] !== state.statusBar[key as keyof StatusBarConfig],
      )
      if (!changed) return
      state.statusBar = next
      state.emit()
    },
    setWhale(visible) {
      if (visible === state.whale) return
      state.whale = visible
      state.emit()
    },
    setWhaleIdle(enabled) {
      if (enabled === state.whaleIdle) return
      state.whaleIdle = enabled
      state.emit()
    },
    setMinimal(enabled) {
      setMinimalMode(enabled)
      if (enabled === state.minimal) return
      state.minimal = enabled
      state.emit()
    },
    setActivityFrames(name) {
      if (!isPresetName(name)) {
        state.notify(t('unknown-activity-preset', { name }), { color: 'error' })
        return false
      }
      if (name === state.activityFrames) {
        state.notify(t('activity-indicator-already', { name }), { color: 'success' })
        return true
      }
      // Persist first (pi behavior: a failed write refuses the switch) so a
      // preference that cannot be saved never silently disappears.
      if (!writeActivityFrames(name)) {
        state.notify(t('activity-pref-write-failed'), { color: 'error' })
        return false
      }
      state.activityFrames = name
      state.emit()
      state.notify(t('activity-indicator-switched', { name }))
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
      return permissionPresetSnapshotFromService(service, snapshotLiveSessionEvents(agent.session))
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
        state.notify(t('preset-unavailable'), { color: 'error' })
        return false
      }
      if (state.working) {
        state.notify(t('preset-agent-running'), { color: 'warning' })
        return false
      }
      let target: AgentPresetInfo
      try {
        target = await resolveCompatiblePreset(presets, presetId)
      } catch (error) {
        state.notify(
          t('preset-not-found', { id: presetId, err: error instanceof Error ? error.message : String(error) }),
          { color: 'error', timeoutMs: 8000 },
        )
        return false
      }
      if (target.broken !== undefined) {
        state.notify(t('preset-load-failed', { id: target.id, broken: target.broken }), { color: 'error', timeoutMs: 8000 })
        return false
      }
      if (target.id === state.agentPreset) {
        if (!migratePresetPref(presetId, target.id)) {
          state.notify(t('preset-switched-pref-failed', { id: target.id }), { color: 'warning' })
          return true
        }
        state.notify(t('preset-already-current', { id: target.id }), { color: 'success' })
        return true
      }
      // Official rule (dsh-agent-presets): only a session that has produced
      // nothing may swap compositions — a started session's logged tool calls
      // would strand under a different tool set. Blank = no turn ever ran.
      const blank = !snapshotLiveSessionEvents(agent.session).some(event => event.type === 'turn/start')
      if (!blank) {
        // Persist as the default for future sessions instead of failing.
        if (!writePresetPref(target.id)) {
          state.notify(t('preset-pref-write-failed'), { color: 'error' })
          return false
        }
        state.notify(
          t('preset-locked-saved-default', { current: state.agentPreset ?? 'host', id: target.id }),
          { color: 'warning', timeoutMs: 8000 },
        )
        return true
      }
      try {
        const preset = await presets.recompose(agent.ctx, target.id)
        // The switch is a logged session fact (model-visible ⟺ logged):
        // resumes/forks of this session resolve the NEW composition. The
        // type is runtime-registered in dsh-session's known-event set but
        // not yet in its typed SessionEventMap — cast the SESSION (never
        // extract the method: `append` reads the private `this.log`, so an
        // unbound call throws "Cannot read properties of undefined").
        const session = agent.session as unknown as { append(type: string, data: unknown): void }
        session.append('agent-preset/selected', { agentPreset: preset.id })
        state.agentPreset = preset.id
      } catch (error) {
        state.notify(
          t('preset-switch-failed', { err: error instanceof Error ? error.message : String(error) }),
          { color: 'error', timeoutMs: 8000 },
        )
        return false
      }
      state.emit()
      if (!writePresetPref(target.id)) {
        state.notify(t('preset-switched-pref-failed', { id: target.id }), { color: 'warning' })
        return true
      }
      state.notify(t('preset-switched-saved', { id: target.id }), { color: 'success' })
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
      const target = agent
      const registry = skillRegistryFor(target)
      if (registry === undefined) return []
      try {
        const observation = await registry.snapshot(skillViewOptions(target))
        if (target !== agent || !observation.complete) {
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
    settingsHost(): SettingsHost | undefined {
      if (settingsHostResolved) return settingsHostCache
      settingsHostResolved = true
      // The `/settings` screen's runtime surface, over the same dsh-base
      // seams the `/provider` wizard uses: settings (namespace descriptors +
      // revision-fenced mutate) and credentials (secret writes). Structurally
      // typed like the other optional seams in this file.
      const settings = ctx.get('settings') as
        | {
          describe(options?: { redactSecrets?: boolean }): readonly {
            ns: string
            revision: number
            applies: 'live' | 'restart'
            value: unknown
            user?: unknown
          }[]
          mutate(
            ns: string,
            ops: readonly (
              | { op: 'set'; path: readonly string[]; value: unknown }
              | { op: 'unset'; path: readonly string[] }
            )[],
            expectedRevision?: number,
          ): Promise<void>
        }
        | undefined
      const credentials = ctx.get('credentials') as
        | {
          resolve(ref: string): Promise<{ value: string } | undefined>
          set(ref: string, value: string): Promise<void>
        }
        | undefined
      if (!settings) return undefined
      settingsHostCache = {
        listNamespaces() {
          // redactSecrets: the screen never renders a secret literal — secret
          // fields are write-only controls over the credentials seam.
          return settings.describe({ redactSecrets: true }).map(descriptor => ({
            ns: descriptor.ns,
            revision: descriptor.revision,
            applies: descriptor.applies,
            value: descriptor.value,
            user: descriptor.user,
          }))
        },
        write(ns, ops, expectedRevision) {
          return settings.mutate(ns, ops, expectedRevision)
        },
        async credentialConfigured(ref) {
          // The environment shadows the store (providerSetup.envShadows), so
          // an env-provided key counts as configured.
          if (process.env[ref] !== undefined) return true
          return credentials !== undefined && (await credentials.resolve(ref)) !== undefined
        },
        async writeCredential(ref, value) {
          if (!credentials) throw new Error('credentials service unavailable')
          // Second layer of the secret-ref reservation guard: the
          // registration layer already rejects plugin sections with
          // host-owned refs, but this seam must not trust it — a stale
          // section (registered before the guard) or a direct call must not
          // reach the shared credentials. The host's own main-credential
          // writes go through providerSetup().writeCredential instead.
          if (isReservedCredentialRef(ref)) throw new Error(t('settings-secret-ref-reserved', { ref }))
          await credentials.set(ref, value)
        },
      }
      return settingsHostCache
    },
    settingsSections(): readonly TuiSettingsSection[] {
      return settingsSectionsRuntime?.list() ?? []
    },
    subscribeSettingsSections(listener: () => void): () => void {
      return settingsSectionsRuntime?.subscribe(listener) ?? (() => {})
    },
    providerSetup(): ProviderSetupHost | undefined {
      // The `/provider` wizard's runtime surface, over the dsh-base seams:
      // settings (profile persistence), credentials (key storage) and the
      // llm runtime's configurable-provider directory + model discovery.
      // Structurally typed like the other optional seams in this file.
      const llm = ctx.get('llm') as
        | {
          listConfigurableProviders(): readonly LlmConfigurableProvider[]
          discoverModels(
            settingsNs: string,
            request: {
              provider?: string
              baseURL?: string
              api?: string
              apiKey?: string
            },
          ): Promise<readonly LlmDiscoveredModel[]>
        }
        | undefined
      const settings = ctx.get('settings') as
        | {
          describe(): readonly { ns: string; revision: number; user?: unknown }[]
          get(ns: string): unknown
          mutate(
            ns: string,
            ops: readonly (
              | { op: 'set'; path: readonly string[]; value: unknown }
              | { op: 'unset'; path: readonly string[] }
            )[],
            expectedRevision?: number,
          ): Promise<void>
        }
        | undefined
      const credentials = ctx.get('credentials') as
        | {
          resolve(ref: string): Promise<{ value: string } | undefined>
          set(ref: string, value: string): Promise<void>
          unset(ref: string): Promise<void>
        }
        | undefined
      // Without dsh-llm-pi-ai there is no adapter watching the settings
      // section, so a written profile would never activate a route. The
      // adapter registers its `llm-pi-ai` settings namespace at mount, which
      // is the rc.6-observable mount signal (the newer
      // `listModelDiscoveryNamespaces()` does not exist in rc.6).
      if (!llm || !settings || !credentials
        || !settings.describe().some(descriptor => descriptor.ns === 'llm-pi-ai')) {
        return undefined
      }
      const revision = (): number | undefined =>
        settings.describe().find(descriptor => descriptor.ns === 'llm-pi-ai')?.revision
      // The OAuth sign-in surface (dsh-auth-style plugin), structural and
      // optional: mounting the plugin lights up the wizard's OAuth branch,
      // and without it the wizard is exactly what it was before.
      const oauthApi = (ctx.get('dshAuth') as { api?: OAuthSetupHost } | undefined)?.api
      // Real catalog membership on this mount: routes the adapter knows from
      // its installed catalog (`declared !== true`). A stored profile naming
      // such a route is an activation/override of the catalog route — even
      // when it carries an explicit `api` field — while routes the adapter
      // only knows because a profile names them are custom. Classifying by
      // anything less (a profile-shape guess) misroutes the edit semantics.
      const catalogMembers = (): Set<string> => new Set(
        llm.listConfigurableProviders()
          .filter(entry => entry.settingsNs === 'llm-pi-ai' && entry.declared !== true)
          .map(entry => entry.provider),
      )
      return {
        ...(oauthApi === undefined ? {} : { oauth: oauthApi }),
        listCatalogProviders() {
          // declared === true marks routes the adapter knows only because a
          // stored profile names them (user-added); the rest are activatable
          // catalog routes.
          return llm.listConfigurableProviders()
            .filter(entry => entry.settingsNs === 'llm-pi-ai' && entry.declared !== true)
            .map(entry => ({ provider: entry.provider, displayName: entry.displayName }))
        },
        routeExists(route) {
          const section = settings.get('llm-pi-ai') as
            | { providers?: Record<string, unknown> }
            | undefined
          return section?.providers !== undefined && route in section.providers
        },
        listRefUsers(ref, exceptRoute) {
          // The RESOLVED merge (settings.get), not the user layer: a base
          // provider or composition-base route naming this ref is invisible
          // to listConfiguredProviders() but still consumes the credential.
          const section = settings.get('llm-pi-ai') as
            | { providers?: Record<string, unknown> }
            | undefined
          const providers = section?.providers
          if (providers === undefined || typeof providers !== 'object' || providers === null) return []
          return Object.entries(providers).flatMap(([route, profile]) => {
            if (route === exceptRoute) return []
            if (typeof profile !== 'object' || profile === null) return []
            const stored = profile as Record<string, unknown>
            return stored.apiKeyEnv === ref ? [route] : []
          })
        },
        listConfiguredProviders() {
          // The editable/deletable set is the USER layer only: `describe()`'s
          // `user` is the raw user section — the same source the /settings
          // screen treats as overrides. `settings.get()` is the resolved
          // merge; listing a route inherited from a composition base would
          // promise a delete that cannot land (the unset only clears the
          // user layer, so the base value re-inherits) while the credential
          // is really gone. When the running base exposes no `user` layer,
          // fall back to the resolved section: such builds (the official
          // dsh-base) carry zero base routes anyway, so the layers coincide.
          const descriptor = settings.describe().find(row => row.ns === 'llm-pi-ai')
          // Only an absent `user` (older base) falls back; a present-but-empty
          // user layer legitimately exposes nothing to edit.
          const section = (descriptor?.user !== undefined
            ? descriptor.user
            : settings.get('llm-pi-ai')) as
            | { providers?: Record<string, unknown> }
            | undefined
          const providers = section?.providers
          if (providers === undefined || typeof providers !== 'object' || providers === null) return []
          const catalog = catalogMembers()
          return Object.entries(providers).flatMap(([route, profile]) => {
            // The settings section is user-editable, so a `providers.<route>`
            // entry may be null or a scalar; skip anything that is not a plain
            // object instead of dereferencing it and throwing (which would
            // block the edit/delete menu for every route).
            if (typeof profile !== 'object' || profile === null) return []
            const stored = profile as Record<string, unknown>
            const ref = typeof stored.apiKeyEnv === 'string' ? stored.apiKeyEnv : ''
            const baseURL = typeof stored.baseURL === 'string' && stored.baseURL !== ''
              ? stored.baseURL
              : undefined
            const api = typeof stored.api === 'string' && stored.api !== ''
              ? stored.api
              : undefined
            // Keep the raw model entries: a model-list re-selection must
            // rewrite kept ids with their stored objects, so per-model fields
            // this wizard never learned about survive the edit.
            const modelEntries = Array.isArray(stored.models)
              ? stored.models.filter(
                (model): model is Record<string, unknown> =>
                  typeof model === 'object' && model !== null,
              )
              : undefined
            const models = modelEntries?.flatMap(
              entry => typeof entry.id === 'string' ? [entry.id] : [],
            )
            return [{
              route,
              ref,
              isCatalog: catalog.has(route),
              shadowed: ref !== '' && process.env[ref] !== undefined,
              ...(baseURL !== undefined ? { baseURL } : {}),
              ...(api !== undefined ? { api } : {}),
              ...(models !== undefined ? { models } : {}),
              ...(modelEntries !== undefined && modelEntries.length > 0
                ? { modelEntries }
                : {}),
            }]
          })
        },
        discoverModels(request) {
          return llm.discoverModels('llm-pi-ai', request)
        },
        envShadows(ref) {
          return process.env[ref] !== undefined
        },
        envValue(ref) {
          return process.env[ref]
        },
        async readCredential(ref) {
          const resolved = await credentials.resolve(ref)
          return resolved?.value
        },
        writeCredential(ref, value) {
          return credentials.set(ref, value)
        },
        removeCredential(ref) {
          return credentials.unset(ref)
        },
        async writeProfile(route, profile) {
          const ops = [{ op: 'set' as const, path: ['providers', route], value: profile }]
          try {
            await settings.mutate('llm-pi-ai', ops, revision())
          } catch (error) {
            // One retry on a stale-revision conflict (a concurrent write
            // landed between describe and mutate); anything else propagates
            // so the wizard can report and roll back the credential.
            const code = (error as { code?: unknown })?.code
            if (code !== 'SETTINGS_CONFLICT') throw error
            await settings.mutate('llm-pi-ai', ops, revision())
          }
        },
        async mutateProfile(route, ops) {
          // Route-relative path patch: only the addressed fields inside
          // `providers.<route>` enter the write, so stored fields the TUI
          // does not model never pass through here and cannot be dropped.
          const full: readonly ProfilePathOp[] = ops.map(op => op.op === 'set'
            ? { op: 'set', path: ['providers', route, ...op.path], value: op.value }
            : { op: 'unset', path: ['providers', route, ...op.path] })
          try {
            await settings.mutate('llm-pi-ai', full, revision())
          } catch (error) {
            // Same stale-revision retry as writeProfile.
            const code = (error as { code?: unknown })?.code
            if (code !== 'SETTINGS_CONFLICT') throw error
            await settings.mutate('llm-pi-ai', full, revision())
          }
        },
        async removeProfile(route) {
          const ops = [{ op: 'unset' as const, path: ['providers', route] }]
          try {
            await settings.mutate('llm-pi-ai', ops, revision())
          } catch (error) {
            // Same stale-revision retry as writeProfile: the wizard reports
            // any real failure so the credential deletion can be skipped.
            const code = (error as { code?: unknown })?.code
            if (code !== 'SETTINGS_CONFLICT') throw error
            await settings.mutate('llm-pi-ai', ops, revision())
          }
        },
      }
    },
    async oauthProviderStatuses(): Promise<readonly OAuthProviderStatus[] | undefined> {
      // Same optional seam the wizard's OAuth branch reads: absent plugin →
      // undefined, and `/login` renders exactly its pre-plugin lines.
      const api = (ctx.get('dshAuth') as { api?: OAuthSetupHost } | undefined)?.api
      return api === undefined ? undefined : api.providers()
    },
    async sideQuestion(
      question: string,
      options?: { signal?: AbortSignal; onText?: (delta: string) => void },
    ): Promise<{ answer: string | null; error?: string }> {
      // CC /btw：无工具单轮辅助调用，重放 deriveMessages() 前缀 + 一条
      // 包装问题。tools 永不传（侧问无工具是核心语义）；usage 不回收
      // （skipCacheWrite 同义——答案不进主上下文也不进 token 计数）。
      const llm = ctx.get('llm') as SideQuestionLlm | undefined
      if (!llm) return { answer: null, error: t('btw-llm-unavailable') }
      const header = agent.session.requestHeader()
      const config = header?.config
      const messages: Message[] = [
        ...agent.session.deriveMessages(),
        createUserMessage({
          content: [{ type: 'text', text: wrapSideQuestion(question) }],
          source: { kind: 'plugin', plugin: 'dsh-tui/btw' },
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
        sessionId: agent.session.id,
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
    // ── agent view (CC's `claude agents`) ───────────────────────────────────
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
          // Subagent children are not agent-view rows (CC parity): they
          // belong to their parent's conversation.
          if (liveAgent.session.header.origin === 'subagent') continue
          const fold = foldOf(liveAgent)
          const id = String(liveAgent.id)
          const isCurrent = id === String(agent.session.id)
          // A session that never held a conversation is not a row (the
          // session browser's rule): the fresh terminal session a `/bg`
          // creates stays visible only while it IS the attached one.
          if (!fold.hasTurns && !isCurrent) continue
          const needsInput = pendingIds.has(id)
          const status = agentViewStatusOf(liveAgent.status, fold, needsInput)
          // CC parity: a blocked row's summary is the question it is
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
      // or attached to FROM the view appear here (CC `claude agents`
      // semantics — background sessions, not the whole history).
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
        state.notify(t('agentview-dispatch-unavailable'), { color: 'error' })
        return { ok: false, reason: 'unavailable' }
      }
      const sessionId = SessionId(randomUUID())
      // Same composition as /new: the caller's default preset + model route.
      // Every failure path below must return a result (never reject): the
      // screen shows the error, and a silent rejection would look like a
      // "missing" session.
      let handle: AgentHandle
      try {
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
        handle = await agentsService.create({
          sessionId,
          meta: {
            cwd: state.cwd,
            ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }),
          },
          agentOptions: route,
          ...(composed.setup === undefined ? {} : { setup: composed.setup }),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state.notify(t('agentview-dispatch-failed', { err: message }), { color: 'error', timeoutMs: 8000 })
        return { ok: false, reason: 'failed', error: message }
      }
      backgroundHandles.set(String(sessionId), handle)
      // Record ownership BEFORE delivery: even a delivery failure must not
      // silently drop the session from the view.
      touchAgentViewSession(String(sessionId))
      touchSession(sessionId)
      try {
        await attachSessionToWorkspace(ctx, state.cwd, sessionId)
      } catch {
        // The workspace ledger is optional bookkeeping; the session runs
        // without it and the next resume repairs the entry.
      }
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
        state.notify(t('agentview-dispatch-failed', { err: message }), { color: 'error', timeoutMs: 8000 })
        return { ok: false, reason: 'failed', error: message }
      }
      notifyAgentView()
      return { ok: true, sessionId: String(sessionId) }
    },
    async stopBackgroundAgent(sessionId) {
      // The attached session cannot be stopped from the view: the channel
      // drives it, and disposing it out from under the UI would strand the
      // terminal on a dead agent.
      if (sessionId === String(agent.session.id)) return false
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
      if (sessionId === String(agent.session.id)) return { ok: true }
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
        state.notify(t('agentview-reply-empty'), { color: 'warning' })
        return false
      }
      const live = (ctx.get('agents') as { get(id: SessionId): Agent | undefined } | undefined)?.get(SessionId(sessionId))
      if (live === undefined) {
        // A stopped session takes a reply only through a restarted agent:
        // attach into it and send from the conversation instead.
        state.notify(t('agentview-reply-stopped'), { color: 'warning' })
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
      // `/bg` — the attached session moves to the background (it keeps
      // running in this process) and the terminal lands on a fresh one.
      const agentsService = ctx.get('agents') as
        | { create(options: CreateAgentOptions): Promise<AgentHandle> }
        | undefined
      if (!agentsService) {
        state.notify(t('agentview-dispatch-unavailable'), { color: 'error' })
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
        handle = await agentsService.create({
          sessionId,
          meta: {
            cwd: state.cwd,
            ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }),
          },
          agentOptions: route,
          ...(composed.setup === undefined ? {} : { setup: composed.setup }),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        state.notify(t('agentview-dispatch-failed', { err: message }), { color: 'error', timeoutMs: 8000 })
        return { ok: false }
      }
      try {
        await attachSessionToWorkspace(ctx, state.cwd, sessionId)
      } catch {
        // Optional ledger, same as dispatch.
      }
      const previousHandle = currentHandle
      const previousSessionId = String(agent.session.id)
      // CC parity: even an EMPTY session is backgrounded (it shows as a
      // "send a prompt to start" row; Esc in the view returns to it), so the
      // handle is always kept for stopping/adopting — never disposed here.
      if (previousHandle !== undefined) backgroundHandles.set(previousSessionId, previousHandle)
      // Fresh-session reset shape (mirrors /new; nothing to replay).
      streaming = undefined
      reasoning = undefined
      sealedReasoning.length = 0
      lastReasoningRow = undefined
      toolCards.clear()
      nextRowId = 0
      state.rows.length = 0
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
      agent = handle.agent
      currentHandle = handle
      bindAgent()
      refreshCommandList()
      void refreshLoadedContext()
      void refreshSkillCommands()
      clearResumeTarget()
      touchSession(handle.agent.id)
      // Both sides of a backgrounding belong to the agent view: the session
      // left running and the fresh one the terminal lands on.
      touchAgentViewSession(previousSessionId)
      touchAgentViewSession(String(handle.agent.id))
      clearStagedImages()
      notifySessionSwitched('background', String(handle.agent.id), previousSessionId)
      notifyAgentView()
      return { ok: true, backgroundedSessionId: previousSessionId }
    },
    setResumeTarget(sessionId) {
      writeResumeTarget(sessionId)
    },
    renameSession(title) {
      // `session/title` is a known envelope type (dsh-session-title writes
      // it for the first prompt). The append publishes through the session
      // firehose, so the event case above updates state.sessionTitle and
      // the persistence flush makes it durable for the next picker open.
      agent.session.append('session/title', { title })
      state.sessionTitle = title
      state.emit()
    },
    setSessionColor(color) {
      // `session/color` is a dsh-tui plugin event — not in dsh-session's
      // typed union, so appended through the same cast applyMode uses for
      // its sandbox/approval overrides. It replays on resume/rewind like
      // session/title, keeping each session's accent color its own.
      ;(agent.session as unknown as { append(type: string, data: Record<string, unknown>): unknown })
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
      const header = agent.session.requestHeader()
      const config = header?.config
      const activity = collectRecentActivity(snapshotLiveSessionEvents(agent.session), RECAP_RECENT_CHARS)
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
        sessionId: agent.session.id,
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
      if (sessionId === agent.session.id) return false
      if (deleteSessionLog(sessionId) !== 'deleted') return false
      forgetSession(sessionId)
      forgetAgentViewSession(sessionId)
      // A resume marker naming the deleted session would make the next
      // `dsh-tui --resume` launch target a log that no longer exists.
      if (readResumeTarget() === sessionId) clearResumeTarget()
      return true
    },
    async renameSessionTo(sessionId, title) {
      if (sessionId === agent.session.id) {
        // The live session renames through session.append so the firehose
        // updates the status line right away (same as /rename).
        agent.session.append('session/title', { title })
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
      // DSH compaction service key: `ctx.compaction` (dsh-compaction's
      // CompactionEngine; dsh-compaction-basic provides it in the example
      // leaf). Under agent presets the engine lives in the preset's isolate
      // realm, invisible from the root context — resolve through the agent's
      // scope chain first (minimal composes NO compaction: stays unavailable).
      const compactService = serviceForAgent<{
          // rc.6 signature: compactNow(agent: ManualCompactAgentContext,
          // signal, sourceCommandId?) — an Agent satisfies the context
          // (session/options/runMaintenance). The result shape is only used
          // for truthiness here.
          compactNow(
            agent: unknown,
            signal: AbortSignal,
          ): Promise<unknown>
        }>(ctx, agent, 'compaction')
      if (!compactService) {
        state.notify(t('compact-unavailable'), {
          color: 'warning',
        })
        return
      }
      if (state.working) {
        state.notify(t('compact-while-working'), { color: 'warning' })
        return
      }
      // Plugin veto point (tui/compact): the first answering plugin may
      // cancel the compaction before anything runs.
      const originAgentId = state.agentId
      // Compare the AGENT REFERENCE after the await, not the id — session
      // ids are reusable (A → /new → /resume A returns the same id on a new
      // agent), so an id comparison has an ABA hole that would hand the new
      // agent to the OLD scope's compaction service.
      const originAgent = agent
      void (async () => {
        const decision = await withDecisionPending('tui/compact', dispatchTuiDecision(ctx, 'tui/compact', {
          sessionId: originAgentId,
          cwd: state.cwd,
        }, normalizeCancelDecision))
        if (decision !== undefined) {
          state.notify(decision.reason ?? t('ext-action-cancelled'), { color: 'warning', timeoutMs: 4000 })
          return
        }
        // Stale-drop (same rule as tui/input): the await parked us while the
        // user switched sessions — `compactService` was resolved through the
        // OLD agent's scope chain, and the mutable `agent` now points at the
        // new session. Running now would hand the new agent to the old
        // service (or call into an unloaded one).
        if (agent !== originAgent) {
          state.notify(t('ext-compact-stale'), { color: 'warning', timeoutMs: 4000 })
          return
        }
        if (state.working) {
          // The await above gave a queued turn time to start; compacting
          // mid-turn now would be the same race the check upfront avoided.
          state.notify(t('compact-while-working'), { color: 'warning' })
          return
        }
        const controller = new AbortController()
        state.notify(t('compact-working'))
        // Register the in-flight transaction so any agent-replacing path
        // (rewind/resume/new/model switch) can cancel it before snapshotting
        // the session — see settleManualCompaction. `settled` never rejects:
        // every branch lands in a notification.
        const settled = (async () => {
          try {
            const result = await compactService.compactNow(agent, controller.signal)
            state.notify(result ? t('compact-done') : t('compact-nothing'))
            // Compaction quip rides the next thinking rotation (pi parity).
            if (result) updateWorkingActivity('compaction', () => activityTracker.onCompact('done'))
          } catch (error: unknown) {
            // ManualCompactionError('persistence'): the replacement checkpoint
            // is ALREADY committed — only the durability flush failed. The
            // surface is now the summary, so a plain "failed" toast here sent
            // users to /model expecting full history and finding only the
            // summary ("context lost"). Distinguish it, structurally — the
            // TUI must not import the error class across the adapter seam.
            if ((error as { code?: unknown }).code === 'persistence') {
              state.notify(t('compact-flush-failed'), { color: 'warning', timeoutMs: 12000 })
              return
            }
            // A switch-initiated abort rejects compactNow with the abort reason;
            // the cancellation was already toasted above — a second generic
            // "failed" toast for the same, expected rejection would mislead.
            if (cancelledCompactions.has(controller)) return
            state.notify(
              t('compact-failed', { err: error instanceof Error ? error.message : String(error) }),
              { color: 'error', timeoutMs: 8000 },
            )
          }
        })()
        manualCompaction = { controller, settled }
        void settled.finally(() => {
          if (manualCompaction?.controller === controller) manualCompaction = undefined
        })
      })().catch((error: unknown) => {
        // Sync throws from compactNow (e.g. runMaintenance rejecting a
        // non-idle agent right after /resume) reject this IIFE itself;
        // uncaught, that is an unhandled rejection and Node exits the
        // whole TUI. Surface it as the same failure notification.
        state.notify(
          t('compact-failed', { err: error instanceof Error ? error.message : String(error) }),
          { color: 'error', timeoutMs: 8000 },
        )
      })
    },
    runExternalCommand(name, rawInput) {
      return executeRegistryCommand(name, rawInput)
    },
    pluginScene: sceneRuntime?.active,
    openPluginScene(id: string) {
      return sceneRuntime?.open(id) ?? false
    },
    closePluginScene() {
      sceneRuntime?.close()
    },
    pushLocal(title, lines) {
      state.rows.push({ id: nextRowId++, kind: 'local', text: title })
      for (const line of lines) {
        state.rows.push({
          id: nextRowId++,
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
      for (const event of snapshotLiveSessionEvents(agent.session)) {
        switch (event.type) {
          case 'user/message': {
            if (event.data.source.kind !== 'user') break
            // Export what the user SAW: the typed prompt, not the expanded
            // `@`-mention attachment blocks.
            const text = firstTextOf(event.data.content)
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
              const text = textOf(block.content)
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
      if (existsSync(LEGACY_DATA_DIR)) {
        lines.push(t('doctor-legacy-dir'))
      }
      // Plugin-spec diagnostics (v0.15): the runtime generation and the
      // vendored registry self-check, both soft-probed (#183 discipline).
      const pluginHost = ctx.get('tuiPluginHost')
      lines.push(t('doctor-plugin-generation', { id: pluginHost?.generationId ?? t('doctor-plugin-host-missing') }))
      const violations = pluginHost?.selfCheck()
      lines.push(t('doctor-plugin-registry', {
        state: violations === undefined ? t('doctor-plugin-host-missing') : violations.length === 0 ? '✓' : `✗ ${violations.length}`,
      }))
      return lines
    },
    pluginsInfo(args: string) {
      const host = ctx.get('tuiPluginHost')
      return pluginsInfoLines(args, {
        grants: host?.grants ?? currentGrantStore(),
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
        const children = await subagents.listChildren(agent.session.id)
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
      releaseSkillCommands()
      unsubscribeScenes?.()
    },
    traceEvents() {
      // Immutable per-append snapshot (dsh-session caches the frozen array);
      // reads follow agent swaps (/resume /rewind /new) automatically.
      return snapshotLiveSessionEvents(agent.session)
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
    const target = agent
    const sections: LoadedContextEntry[] = []
    const contexts: LoadedContextEntry[] = []
    const files: LoadedContextFile[] = []
    const skills: LoadedContextSkill[] = []
    const tools: LoadedContextTool[] = []
    try {
      const systemPrompt = ctx.get('systemPrompt')
      if (systemPrompt !== undefined) {
        const assembly = await systemPrompt.assemble(assembleContextFor(target))
        if (target !== agent) return
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
      if (target !== agent) return
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
        if (target !== agent) return
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
    const target = agent
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
          // Skills reach the registry as ordinary commands, so the menu would
          // lose the marker HelpMenu uses to keep them out of the chrome list.
          // This channel registered them and is the authority on which names
          // are skills.
          ...(skillCommands.has(descriptor.name) ? { skill: true } : {}),
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
      if (token !== commandListSeq || target !== agent) return
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
      if (token !== commandListSeq || target !== agent) return
      ctx.logger.warn('skill command merge failed: %o', error)
      // Last-good: a transient provider failure (rescan error, permission
      // hiccup) must not make known skills vanish from completion.
      restoreLastGood()
    })
  }
  ctx.on('commands/change', refreshCommandList)
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
    if (commandService === undefined) return
    const target = agent
    const registry = skillRegistryFor(target)
    if (registry === undefined) return
    let observation
    try {
      observation = await registry.snapshot(skillViewOptions(target))
    } catch (error) {
      ctx.logger.warn('skill commands: catalog read failed: %o', error)
      return
    }
    if (target !== agent) return
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
              deliverUserText(`/${name}${rawInput}`, 'followup')
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

  let nextRowId = 0
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

  /** Claude Code's `!` mode: execute in the current workspace provider and
   *  render local-only transcript rows (never sent to the model). */
  const runLocalCommand = async (
    command: string,
    includeInContext: boolean,
  ): Promise<void> => {
    const workspace = workspaceService.describe(state.cwd)
    state.rows.push({
      id: nextRowId++,
      kind: 'local',
      text: command,
      executionTarget: workspace.kind === 'local' ? workspace.badge : `${workspace.badge} · ${workspace.label}`,
    })
    state.emit()
    let output = '(no output)'
    const executionShell = await workspaceService.commandShell(state.cwd) ?? bash
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
    state.rows.push({
      id: nextRowId++,
      kind: 'local-output',
      text: preview(output, LOCAL_OUTPUT_LIMIT),
    })
    state.emit()
    if (includeInContext) {
      // CC's <bash-stdout> envelope: the model treats the output as the
      // result of a local command the user just ran.
      agent.followup(createUserMessage({
        content: [{
          type: 'text',
          text: `<bash-stdout>
${output}
</bash-stdout>`,
        }],
        source: { kind: 'user' },
      }))
    }
  }
  /** The in-progress assistant text row; `undefined` when no step is streaming. */
  let streaming: ChatRow | undefined
  /** The in-progress reasoning row; `undefined` when no reasoning is streaming. */
  let reasoning: ChatRow | undefined
  /** Reasoning rows sealed by an assistant/message this turn. They stay
   *  `streaming: true` — expanded in the transcript — until turn/end folds
   *  them (WebUI AssistantMarkdown keepOpen parity: thinking holds open
   *  through the whole in-flight turn, tool-call steps included). */
  const sealedReasoning: ChatRow[] = []
  /** Wall-clock start of the current reasoning row (durationMs on settle). */
  let reasoningStart = 0
  /** Decode-throughput fold for the current turn. DSH defines one step as
   *  one model call plus its tools; summing only first-token → message spans
   *  excludes tool execution and per-request TTFT from generation speed. */
  let tpsTurn: number | undefined
  let tpsBeforeTurn: number | undefined
  let tpsTurnDecodeMs = 0
  let tpsTurnDecodeTokens = 0
  let tpsTurnSampled = false
  let tpsStep:
    | {
      turn: number
      step: number
      firstTokenTime: number | undefined
      outputChars: number
    }
    | undefined
  /** Tool cards by callId, so tool/result can settle the running card. */
  const toolCards = new Map<string, ChatRow>()
  /**
   * Session events are delivered live and can also be replayed around a
   * reconnect. A repeated sealed message must not create a second assistant
   * row for the same durable sequence number.
   */
  const handledAssistantMessages = new Set<number>()
  const handledAssistantChunks = new Set<number>()
  const assistantRowsByStep = new Map<string, ChatRow>()
  const lastTextDelta = new Map<ChatRow, string>()
  const stepKey = (turn: number, step: number): string => `${turn}:${step}`

  /** Append a stream delta idempotently. Providers normally send a pure
   * delta, but reconnect/proxy paths can resend a cumulative prefix or a
   * delta whose beginning overlaps the previous tail. Merge the overlap
   * instead of blindly concatenating it into the visible transcript. */
  const appendTextDelta = (row: ChatRow, delta: string): void => {
    if (delta === '') return
    if (lastTextDelta.get(row) === delta) return
    lastTextDelta.set(row, delta)
    if (delta.startsWith(row.text)) {
      row.text = delta
      return
    }
    const maxOverlap = Math.min(row.text.length, delta.length, 4096)
    for (let size = maxOverlap; size > 0; size--) {
      if (row.text.endsWith(delta.slice(0, size))) {
        row.text += delta.slice(size)
        return
      }
    }
    row.text += delta
  }

  /** The host-plane tools registry (dsh-tools). Resolved once; absent in
   *  bare embedders — every presenter call soft-fails to undefined and the
   *  card falls back to raw text. */
  const toolsRegistry = ctx.get('tools') as ToolsRegistryLike | undefined
  /** Ask the producing tool how its call should render (diff/terminal/…).
   *  Scoped to the live agent so preset-owned tool definitions resolve —
   *  the dsh-host-apiproxy presenter pattern. Unknown tool, unparseable
   *  args, or a throwing presenter all degrade to the plain text card. */
  const presentCallView = (name: string, rawArgs: string): ToolCallView | undefined => {
    try {
      const tool = toolsRegistry?.get(name, agent)
      if (tool?.presentCall === undefined) return undefined
      return tool.presentCall(JSON.parse(rawArgs)) as ToolCallView | undefined
    } catch {
      return undefined
    }
  }
  /** Same for the settled result; `meta` is the tool-private presentation
   *  payload the tool attached to its tool/result event (dsh-tool-fs reads
   *  its result-time contextual diff back from here). */
  const presentResultView = (name: string, rawArgs: string, data: SessionEvent<'tool/result'>['data']): ToolResultView | undefined => {
    try {
      // Harness goal/todo tools first: their raw JSON reads as noise in the
      // transcript — fold recognizable shapes into a summary card before the
      // registry gets a chance to (not) know them.
      const local = harnessToolResultView(name, data)
      if (local !== undefined) return local
      const tool = toolsRegistry?.get(name, agent)
      if (tool?.presentResult === undefined) return undefined
      const block = data.message.content[0]
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable session data may not match type
      const content = block !== undefined && block.type === 'tool-result' ? block.content : []
      return tool.presentResult(JSON.parse(rawArgs), {
        content,
        isError: block?.isError === true,
        ...(data.meta !== undefined ? { meta: data.meta } : {}),
      }) as ToolResultView | undefined
    } catch {
      return undefined
    }
  }

  // ContentBlockMap is merge-extensible: plugin-added block types are
  // silently skipped (v1 renders text blocks only) — never crashes.
  const textOf = (content: readonly ContentBlock[] | undefined): string =>
    (content ?? []).map(block => (block.type === 'text' ? block.text : '')).join('').trim()

  /**
   * Transcript-facing text of a user message: the FIRST text block only.
   * `@`-mention attachments (issue #15) ride as later blocks — model-facing
   * only — so joining every block would dump file contents into the bubble,
   * the sticky header, and session titles.
   */
  const firstTextOf = (content: readonly ContentBlock[] | undefined): string =>
    (content ?? []).find(block => block.type === 'text')?.text.trim() ?? ''

  const ensureStreaming = (seq?: number): ChatRow => {
    if (streaming !== undefined) return streaming
    // A reconnect can replay the first delta after the sealed message was
    // already observed. Reuse that durable row instead of opening a second
    // assistant bubble for the same event sequence.
    const existing = seq === undefined
      ? undefined
      : [...state.rows].reverse().find(row => row.kind === 'assistant' && row.seq === seq)
    if (existing !== undefined) {
      existing.streaming = true
      streaming = existing
      return existing
    }
    streaming = { id: nextRowId, kind: 'assistant', text: '', streaming: true, fresh: true, ...seq !== undefined ? { seq } : {} }
    nextRowId += 1
    state.rows.push(streaming)
    return streaming
  }

  /** Latest reasoning row keyed by its (turn, step) — lets a resumed
   *  mid-step stream REVIVE the row the replay sealed (crash-orphan tail:
   *  replay folds the partial row, live continuation chunks would
   *  otherwise open a SECOND row for the same step, splitting one
   *  thinking block in two). */
  let lastReasoningRow: { row: ChatRow; turn: number; step: number } | undefined

  const ensureReasoning = (seq?: number, turn?: number, step?: number): ChatRow => {
    if (reasoning === undefined) {
      // Same-step revive: the sealed row is this step's thinking — continue
      // it (durationMs carried over via reasoningStart back-dating).
      if (
        lastReasoningRow !== undefined &&
        turn !== undefined &&
        lastReasoningRow.turn === turn &&
        lastReasoningRow.step === step
      ) {
        reasoning = lastReasoningRow.row
        reasoning.streaming = true
        const sealedIdx = sealedReasoning.indexOf(reasoning)
        if (sealedIdx !== -1) sealedReasoning.splice(sealedIdx, 1)
        reasoningStart = Date.now() - (reasoning.durationMs ?? 0)
        logForDebugging('thinking: revived sealed reasoning row for same step')
        return reasoning
      }
      reasoningStart = Date.now()
      reasoning = { id: nextRowId, kind: 'reasoning', text: '', streaming: true, ...seq !== undefined ? { seq } : {} }
      nextRowId += 1
      state.rows.push(reasoning)
      logForDebugging('thinking: reasoning row open (expanded)')
    }
    if (turn !== undefined && step !== undefined) {
      lastReasoningRow = { row: reasoning, turn, step }
    }
    return reasoning
  }

  /** Fold the live reasoning preview the moment the model moves PAST
   *  thinking — the answer's first text token or a tool call — not at
   *  `assistant/message` (end of step). A long reply pushes the thinking
   *  block into terminal scrollback long before the message seals, and
   *  scrollback rows cannot be repainted (the cursor cannot reach them),
   *  so a late fold leaves a stale unfolded preview frozen above the
   *  window — the user scrolls up and the thinking looks "not folded".
   *  Folding while the block still sits in the live window keeps the
   *  shrink inside the diff engine's reachable region. Preview mode only
   *  (`full` holds every block open until turn settle by design). */
  const foldLiveReasoning = (where: string): void => {
    if (reasoning === undefined || state.thinkingFold !== 'preview') return
    const duration = Math.max(0, Date.now() - reasoningStart)
    reasoning.durationMs = duration
    reasoning.streaming = false
    sealedReasoning.push(reasoning)
    reasoning = undefined
    logForDebugging(`thinking: folded at ${where} (${duration}ms)`)
  }

  const settleStreaming = (): void => {
    if (streaming !== undefined) streaming.streaming = false
    streaming = undefined
    const folded = sealedReasoning.length + (reasoning !== undefined ? 1 : 0)
    for (const row of sealedReasoning) row.streaming = false
    sealedReasoning.length = 0
    if (reasoning !== undefined) {
      reasoning.streaming = false
      reasoning.durationMs = Math.max(0, Date.now() - reasoningStart)
    }
    reasoning = undefined
    if (folded > 0) logForDebugging(`thinking: folded ${folded} reasoning row(s) at turn settle`)
  }

  /** Recompute the spinner phase from live row/tool state. */
  const updateSpinnerMode = (): void => {
    if (state.activeToolCount > 0) {
      state.spinnerMode = 'tool-use'
    } else if (reasoning !== undefined) {
      // Only LIVE reasoning counts — sealed rows stay streaming=true for
      // transcript expansion until turn/end but the model is past thinking.
      state.spinnerMode = 'thinking'
    } else if (streaming !== undefined) {
      state.spinnerMode = 'responding'
    } else {
      state.spinnerMode = 'requesting'
    }
  }

  /**
   * One durable goal mutation as the goal service records it (the `data` of
   * a top-level `goal/change` session event, and of the snapshot a round-zero
   * goal-sourced `user/message` may inline). Declared structurally: the
   * pinned peer's `SessionEvent` union predates the event type, so the fold
   * admits the payload by shape, not by union membership.
   */
  type GoalChangePayload = {
    kind: 'goal/change'
    version: number
    operation:
      | 'create'
      | 'edit'
      | 'pause'
      | 'resume'
      | 'complete'
      | 'block'
      | 'clear'
    goal?: Omit<ChannelGoal, 'roundsStarted'>
    roundsStarted?: number
  }

  /** Fold one goal mutation into the channel's goal projection. */
  const applyGoalChange = (change: GoalChangePayload): void => {
    if (change.operation === 'clear') {
      state.goal = undefined
    } else if (change.goal !== undefined) {
      state.goal = {
        ...change.goal,
        roundsStarted: change.roundsStarted ?? state.goal?.roundsStarted ?? 0,
      }
    }
  }

  /**
   * Fold one goal-sourced message into the channel's goal projection.
   * Round-zero goal messages may carry the full durable snapshot (or a clear
   * tombstone) in their source; positive-round messages are admitted
   * continuation prompts that only advance the rounds counter.
   */
  const applyGoalEvent = (event: SessionEvent<'user/message'>): void => {
    const source = event.data.source as unknown as {
      round: number
      change?: GoalChangePayload
    }
    if (source.round > 0) {
      // Admitted continuation round — the snapshot itself is unchanged.
      if (state.goal !== undefined) {
        state.goal = {
          ...state.goal,
          roundsStarted: Math.max(state.goal.roundsStarted, source.round),
        }
      }
      return
    }
    const change = source.change
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may not match the static type
    if (change === undefined || change.kind !== 'goal/change') return
    applyGoalChange(change)
  }

  /** True while the durable transcript is being replayed (boot /resume /
   *  rewind / model-switch fork). The assistant/message reasoning-rebuild
   *  branch below must run ONLY on this path: in a live stream the chunks
   *  already created the reasoning row, and foldLiveReasoning clears the
   *  `reasoning` handle before assistant/message arrives — so
   *  `reasoning === undefined` alone cannot tell replay from live, and
   *  using it would rebuild a second thinking block per step. */
  let replaying = false
  const replayEvents = (events: readonly SessionEvent[]): void => {
    // Event sequence numbers restart with a replacement session; reset the
    // idempotency ledger before replay so an old session cannot suppress a
    // legitimate message in the new transcript.
    handledAssistantMessages.clear()
    handledAssistantChunks.clear()
    assistantRowsByStep.clear()
    lastTextDelta.clear()
    replaying = true
    try {
      for (const event of prepareReplayEvents(events)) renderEvent(event)
    } finally {
      replaying = false
    }
  }

  const renderEvent = (event: SessionEvent): void => {
    // Top-level `goal/change` events are how the goal service actually
    // records durable goal mutations (create/edit/pause/resume/complete/
    // block/clear) — confirmed in production logs. The pinned peer's
    // SessionEvent union predates the type, so admit it structurally: the
    // goal chip and panel stay dark without this fold.
    if ((event as { type: string }).type === 'goal/change') {
      applyGoalChange((event as { data: GoalChangePayload }).data)
      return
    }
    switch (event.type) {
      case 'user/message': {
        // Compaction checkpoint: `source = { kind: 'plugin', plugin:
        // 'compact' }` (dsh-compact's COMPACT_CHECKPOINT_SOURCE). CC shows
        // the framed summary after /compact; render it as a Divider title +
        // a summary row that defaults folded (`compact` kind) instead of
        // skipping it like other injected context.
        if (
          event.data.source.kind === 'plugin' &&
          event.data.source.plugin === 'compact'
        ) {
          const summary = textOf(event.data.content)
          state.rows.push({ id: nextRowId, kind: 'notice', text: 'Conversation compacted' })
          nextRowId += 1
          if (summary) {
            state.rows.push({ id: nextRowId, kind: 'compact', text: summary })
            nextRowId += 1
          }
          // The surface replace drops the whole pre-compact history: reset
          // the context accounting NOW so the status bar (ctx bar, tokens,
          // context-low warning) drops immediately instead of waiting for
          // the next request's usage event.
          const removed =
            state.contextSegments.prompt +
            state.contextSegments.assistant +
            state.contextSegments.thinking +
            state.contextSegments.tools
          const summaryTokens = estimateTokens(summary)
          state.tokens.input = Math.max(0, state.tokens.input - removed) + summaryTokens
          state.contextSegments = {
            system: state.contextSegments.system,
            prompt: summaryTokens,
            assistant: 0,
            thinking: 0,
            tools: 0,
          }
          state.lastUsage = {
            input: state.contextSegments.system + summaryTokens,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          }
          contextWarned = false
          break
        }
        // Same-session goal domain: goal-sourced messages are the round
        // driver's continuation prompts (positive rounds advance the
        // counter); some hosts also inline the durable snapshot in a
        // round-zero source. They are not transcript bubbles — they drive
        // the goal panel's live projection (replayed on resume/rewind like
        // every other event; the snapshot itself arrives as the top-level
        // `goal/change` event admitted above).
        if ((event.data.source as { kind: string }).kind === 'goal') {
          applyGoalEvent(event)
          break
        }
        // Injected context (plugin/skill source) is not a human bubble; v1
        // renders direct human prompts only.
        if (event.data.source.kind !== 'user') break
        const text = firstTextOf(event.data.content)
        if (text) {
          state.rows.push({ id: nextRowId, kind: 'user', text, seq: event.seq })
          state.lastUserText = text
          // The context estimate counts everything sent to the model —
          // typed text AND the `@`-mention attachment blocks.
          state.contextSegments.prompt += estimateTokens(textOf(event.data.content))
          nextRowId += 1
        }
        break
      }
      case 'step/start': {
        if (tpsTurn === event.data.turn) {
          tpsStep = {
            turn: event.data.turn,
            step: event.data.step,
            firstTokenTime: undefined,
            outputChars: 0,
          }
        }
        break
      }
      case 'assistant/chunk': {
        if (handledAssistantChunks.has(event.seq)) break
        handledAssistantChunks.add(event.seq)
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') {
          if (chunk.text) {
            // Fold the thinking preview while it is still in the live
            // window (see foldLiveReasoning) — before this text grows the
            // transcript and pushes the block into scrollback.
            foldLiveReasoning('first text token')
            const key = stepKey(event.data.turn, event.data.step)
            const row = assistantRowsByStep.get(key) ?? ensureStreaming(event.seq)
            assistantRowsByStep.set(key, row)
            streaming = row
            row.streaming = true
            const before = row.text.length
            appendTextDelta(row, chunk.text)
            state.responseChars += Math.max(0, row.text.length - before)
          }
        } else if (chunk.type === 'reasoning-delta') {
          if (chunk.text) {
            const row = ensureReasoning(event.seq, event.data.turn, event.data.step)
            appendTextDelta(row, chunk.text)
          }
        }
        const step = tpsStep
        if (
          step !== undefined &&
          step.turn === event.data.turn &&
          step.step === event.data.step &&
          isTokenDelta(chunk)
        ) {
          step.firstTokenTime ??= event.time
          step.outputChars += tokenDeltaChars(chunk)
          const elapsedMs = Math.max(0, event.time - step.firstTokenTime)
          if (elapsedMs > 500) {
            const decodeMs = tpsTurnDecodeMs + elapsedMs
            const outputTokens = tpsTurnDecodeTokens + Math.ceil(step.outputChars / 4)
            state.tps = outputTokens / (decodeMs / 1000)
          }
        }
        updateSpinnerMode()
        break
      }
      case 'assistant/message': {
        if (handledAssistantMessages.has(event.seq)) break
        handledAssistantMessages.add(event.seq)
        const text = textOf(event.data.message.content)
        // Replay without chunk deltas (prepareReplayEvents drops settled
        // ones): rebuild the reasoning row from the sealed message's
        // reasoning blocks. Replay-only — gated on the `replaying` flag,
        // not on `reasoning === undefined`: a live stream's chunks already
        // created the row, and foldLiveReasoning has cleared the `reasoning`
        // handle by the time this event lands, so the undefined check alone
        // would rebuild a duplicate thinking block per step. Pushed BEFORE
        // the assistant row so the transcript order matches the live
        // stream; settled (folded) immediately, durationMs unknown without
        // a live clock.
        if (replaying && reasoning === undefined) {
          const reasoningText = event.data.message.content
            .map(block => (block.type === 'reasoning' ? block.text : ''))
            .join('')
          if (reasoningText !== '') {
            state.rows.push({
              id: nextRowId,
              kind: 'reasoning',
              text: reasoningText,
              seq: event.seq,
            })
            nextRowId += 1
          }
        }
        // Reasoning/tool-only steps emit no text: creating an assistant row
        // anyway leaves an empty `●` bullet in the transcript. A pre-existing
        // streaming row always has text (ensureStreaming is only reached on
        // non-empty text deltas), so only create one when text arrives.
        // Key the step→row ledger only when the event carries a durable
        // turn/step; a message without them must never collide onto a
        // previous step's row (a bare `undefined:undefined` key would make
        // every turn/step-less message reuse the FIRST one's assistant row).
        const msgTurn = event.data.turn
        const msgStep = event.data.step
        const msgKey = msgTurn !== undefined && msgStep !== undefined
          ? stepKey(msgTurn, msgStep)
          : undefined
        const row = (msgKey !== undefined ? assistantRowsByStep.get(msgKey) : undefined) ?? streaming ??
          (text
            ? ([...state.rows].reverse().find(candidate =>
                candidate.kind === 'assistant' && candidate.seq === event.seq,
              ) ?? ensureStreaming(event.seq))
            : undefined)
        if (row !== undefined) {
          if (msgKey !== undefined) assistantRowsByStep.set(msgKey, row)
          row.time = event.time
          if (text) row.text = text
          row.streaming = false
          // Live settles keep the smooth-reveal cursor alive (a one-shot
          // non-streaming delivery still paints as a flow); replayed
          // settles must not — the transcript would typewrite on open.
          if (!replaying && text) row.fresh = true
        }
        streaming = undefined
        if (reasoning !== undefined) {
          // Backstop fold: reasoning whose step ended with no text token
          // and no tool call (foldLiveReasoning handles those earlier —
          // while the block is still in the repaintable live window;
          // here a long reply may already have pushed it into scrollback,
          // where the shrink cannot be repainted). `full` mode
          // (/settings opt-in) keeps the block expanded until turn settle
          // — settleStreaming folds the sealed rows then.
          reasoning.durationMs = Math.max(0, Date.now() - reasoningStart)
          if (state.thinkingFold === 'preview') reasoning.streaming = false
          sealedReasoning.push(reasoning)
          logForDebugging(`thinking: step sealed (${reasoning.durationMs}ms), expanded until turn/end`)
        }
        reasoning = undefined
        updateSpinnerMode()
        const usage = event.data.usage
        if (usage !== undefined) {
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack tokens
          state.tokens.input += usage.inputTokens ?? 0
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack tokens
          state.tokens.output += usage.outputTokens ?? 0
          // Cache split totals feed the session cost estimate (hit-priced
          // input vs. uncached input) — the durable replay may lack them.
          state.tokens.cacheRead += usage.cacheReadTokens ?? 0
          state.tokens.cacheWrite += usage.cacheWriteTokens ?? 0
          // Peak/idle bucketing by the request's own time (the durable replay
          // replays historical events, so a resumed session prices each
          // request at the rate window it actually ran in — the session cost
          // estimate never prices the whole session at the current window).
          {
            const bucket = isPeakHour(new Date(event.time))
              ? state.tokens.peak
              : state.tokens.idle
            bucket.input += usage.inputTokens ?? 0
            bucket.output += usage.outputTokens ?? 0
            bucket.cacheRead += usage.cacheReadTokens ?? 0
            bucket.cacheWrite += usage.cacheWriteTokens ?? 0
          }
          // The most recent request's usage describes the CURRENT context:
          // input (uncached) + cache hits all occupy the window. Cache hits
          // also drive the status-line `cache N` readout.
          state.lastUsage = {
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack tokens
            input: usage.inputTokens ?? 0,
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable replay data may lack tokens
            output: usage.outputTokens ?? 0,
            cacheRead: usage.cacheReadTokens ?? 0,
            cacheWrite: usage.cacheWriteTokens ?? 0,
          }
        }
        const tpsMessageStep = tpsStep
        if (
          tpsTurn === event.data.turn &&
          tpsMessageStep !== undefined &&
          tpsMessageStep.turn === event.data.turn &&
          tpsMessageStep.step === event.data.step &&
          tpsMessageStep.firstTokenTime !== undefined
        ) {
          const outputTokens = usageOutputTokens(usage)
            ?? (tpsMessageStep.outputChars > 0
              ? Math.ceil(tpsMessageStep.outputChars / 4)
              : undefined)
          if (outputTokens !== undefined) {
            tpsTurnDecodeMs += Math.max(0, event.time - tpsMessageStep.firstTokenTime)
            tpsTurnDecodeTokens += outputTokens
            tpsTurnSampled = true
            if (tpsTurnDecodeMs > 0) {
              state.tps = tpsTurnDecodeTokens / (tpsTurnDecodeMs / 1000)
            }
          }
        }
        if (
          tpsMessageStep !== undefined &&
          tpsMessageStep.turn === event.data.turn &&
          tpsMessageStep.step === event.data.step
        ) {
          tpsStep = undefined
        }
        // Context-bar segmentation (pi-nano-context style): assistant text
        // and tool calls in the assistant segment, thinking separately.
        for (const block of event.data.message.content) {
          if (block.type === 'text' && block.text) {
            state.contextSegments.assistant += estimateTokens(block.text)
          } else if (block.type === 'reasoning' && block.text) {
            state.contextSegments.thinking += estimateTokens(block.text)
          }
        }
        break
      }
      case 'tool/call': {
        // The ask-user-question tool renders as the interactive questionnaire
        // panel (DSH user-interaction seam), not as a tool card: the model is
        // parked waiting for the human, so no running card, no active-tool
        // spinner, no args noise in the transcript. The Q&A summary is pushed
        // by the TUI once the batch is answered; tool/result for a call with
        // no card is a no-op below.
        if (event.data.name === 'ask_user_question') break
        // The Task tool's plain card is replaced by the live subagent card
        // (Kimi Code semantics): the delegation itself renders as a subagent
        // row, so the raw args/result card would only duplicate it. The call
        // still runs - only its transcript rendering is suppressed.
        if (isSubagentToolName(event.data.name)) {
          try {
            const args = JSON.parse(event.data.arguments) as { description?: unknown }
            if (typeof args.description === 'string' && args.description) pendingTaskDescriptions.push(args.description)
          } catch {
            // Unparseable args leave the queue untouched; the card falls back
            // to the provider label.
          }
          break
        }
        // Reasoning that led to a tool call is done thinking — fold the
        // preview now, before the tool card grows the transcript past it
        // (see foldLiveReasoning).
        foldLiveReasoning('tool call')
        const card: ChatRow = {
          id: nextRowId,
          kind: 'tool',
          text: '',
          seq: event.seq,
          // Smooth-reveal participation flag: live cards animate their body
          // in; replayed cards (resume/rewind) paint complete.
          fresh: !replaying,
          tool: {
            callId: event.data.callId,
            name: event.data.name,
            argsText: preview(event.data.arguments, ARGS_PREVIEW_LIMIT),
            argsFull: event.data.arguments,
            status: 'running',
            callView: presentCallView(event.data.name, event.data.arguments),
            startedAt: Date.now(),
          },
        }
        nextRowId += 1
        toolCards.set(event.data.callId, card)
        state.rows.push(card)
        state.activeToolCount += 1
        state.contextSegments.assistant += estimateTokens(
          `${event.data.name}${event.data.arguments}`,
        )
        updateSpinnerMode()
        break
      }
      case 'tool/result': {
        const card = toolCards.get(event.data.message.source.callId)
        if (card !== undefined && card.tool !== undefined) {
          card.tool.durationMs = Math.max(0, Date.now() - card.tool.startedAt)
          const failure = event.data.error
          if (failure !== undefined) {
            card.tool.status = 'error'
            const errorText = toolErrorText(event)
            card.tool.errorText = errorText
            state.contextSegments.tools += estimateTokens(errorText)
          } else {
            card.tool.status = 'ok'
            const block = event.data.message.content[0]
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable session data may not match type
            const result = block !== undefined && block.type === 'tool-result' ? textOf(block.content) : ''
            card.tool.resultFull = result || undefined
            card.tool.resultText = result ? preview(result, RESULT_PREVIEW_LIMIT) : undefined
            // The tool's own settled-state view (applied diff, terminal
            // output, read content…) wins over the raw text body. argsFull
            // pairs the args: live cards are never folded, so it is intact.
            card.tool.resultView = presentResultView(card.tool.name, card.tool.argsFull ?? '', event.data)
            state.contextSegments.tools += estimateTokens(result)
            // A job_output result doubles as the job card's output feed:
            // the registry's read() is consuming and reserved for the
            // owning agent, so the UI mirrors the tail that already streams
            // through the transcript instead of polling the job itself.
            if (card.tool.name === 'job_output' && result !== '') {
              const id = parseJobOutputId(card.tool.argsFull)
              if (id !== undefined) jobStore.onOutputSeen(id, result, event.time ?? Date.now())
            }
            // A `started background job <id>` ack pairs the job with its
            // tool call: capture the FULL command from the args (the
            // registry label is the friendly description) for the panel.
            const startAck = BACKGROUND_START_ACK.exec(result)
            if (startAck !== null) {
              const command = toolCommandOf(card.tool.argsFull)
              if (command !== undefined) jobStore.onStarted(startAck[1], command)
            }
          }
          state.activeToolCount = Math.max(0, state.activeToolCount - 1)
          // The card is settled: no later event looks it up by callId, so
          // drop the index entry. The card itself stays in state.rows
          // (bounded by MAX_ROWS + foldRows, which also drops the full
          // args/result payloads of folded cards).
          toolCards.delete(event.data.message.source.callId)
          updateSpinnerMode()
        }
        break
      }
      case 'step/end': {
        if (
          tpsStep !== undefined &&
          tpsStep.turn === event.data.turn &&
          tpsStep.step === event.data.step
        ) {
          tpsStep = undefined
        }
        break
      }
      case 'turn/start': {
        cancelInFlight = false
        state.cancelPending = false
        state.working = true
        state.turnStart = Date.now()
        state.responseChars = 0
        state.spinnerMode = 'requesting'
        // Keep the prior turn visible until this turn produces a measurable
        // decode span, while starting a fresh weighted step fold.
        tpsBeforeTurn = state.tps
        tpsTurn = event.data.turn
        tpsTurnDecodeMs = 0
        tpsTurnDecodeTokens = 0
        tpsTurnSampled = false
        tpsStep = undefined
        break
      }
      case 'turn/end': {
        cancelInFlight = false
        state.cancelPending = false
        settleStreaming()
        state.working = false
        state.activeToolCount = 0
        if (tpsTurn !== undefined && tpsTurn === event.data.turn) {
          if (tpsTurnSampled && tpsTurnDecodeMs > 0) {
            const turnTps = tpsTurnDecodeTokens / (tpsTurnDecodeMs / 1000)
            state.tps = turnTps
            state.tpsSamples.push({ tps: turnTps, at: event.time })
            if (state.tpsSamples.length > 500) state.tpsSamples.shift()
          } else {
            // Do not leave a chars/4 live estimate behind when no completed
            // decode sample exists for this turn.
            state.tps = tpsBeforeTurn
          }
          tpsTurn = undefined
          tpsStep = undefined
          tpsTurnDecodeMs = 0
          tpsTurnDecodeTokens = 0
          tpsTurnSampled = false
        }
        const reason = event.data.reason
        if (reason.kind === 'completed') {
          checkContextWarning()
          break
        }
        if (reason.kind === 'aborted' || reason.kind === 'interrupted') {
          // `Agent.cancel()` closes the turn as `aborted`; `interrupted`
          // only appears for crash-orphaned turns. Claude Code renders both
          // user-interruption paths as a distinct dim row.
          state.rows.push({
            id: nextRowId,
            kind: 'interrupt',
            text: t('interrupted-by-user') + t('interrupted-ask-next'),
          })
          nextRowId += 1
          break
        }
        // The notice renders as a single-line Divider title: error.message
        // can carry newlines/control chars, and an embedded \n splits the
        // rule across rows. cleanRenderText is the render-path single-line
        // contract (sessionTree's preview() folds likewise for the tree).
        const detail = reason.kind === 'error' ? cleanRenderText(reason.error.message, NOTICE_CELLS) : ''
        state.rows.push({ id: nextRowId, kind: 'notice', text: `turn ${reason.kind}${detail ? ` · ${detail}` : ''}` })
        nextRowId += 1
        state.notify(
          t('turn-failed', { detail: detail ? ` · ${detail}` : '' }),
          { color: 'error', timeoutMs: 8000 },
        )
        break
      }
      case 'request/context':
        // Adapter-advertised context capacity; drives the context-low
        // warning (CC's TokenWarning) when the route reports one.
        if (event.data.contextWindow !== undefined) {
          state.contextWindow = event.data.contextWindow
        }
        break
      case 'request/header': {
        // Reasoning effort readout (status line): the header carries the
        // conversation's call config (provider/model/effort/sampling). The
        // system prompt text seeds the context bar's system segment.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- durable session data may lack header config
        const effort = event.data.header.config?.reasoningEffort
        if (typeof effort === 'string') {
          state.reasoningEffort = effort
        }
        if (typeof event.data.header.system === 'string') {
          state.contextSegments.system = estimateTokens(event.data.header.system)
        }
        break
      }
      case 'session/title':
        state.sessionTitle = event.data.title
        break
      default:
        // dsh-tool-todo owns this optional module augmentation on the 0.1.2 line.
        // Match by name so the TUI remains loadable without that plugin.
        if ((event as { type: string }).type === 'todo/write') {
          const todos = todoPanelItems((event as unknown as { data?: unknown }).data)
          if (todos !== undefined) state.todos = todos
          break
        }
        // Logged preset switch (blank sessions only, issue #8): a transcript
        // marker so a replayed log shows which composition produced the
        // turns after it. Not in dsh-session's typed union — matched here by
        // name, like the other plugin-defined events above.
        if ((event as { type: string }).type === 'agent-preset/selected') {
          const data = event.data as unknown as { agentPreset?: string }
          const recordedPreset = typeof data.agentPreset === 'string' ? data.agentPreset : undefined
          const renamedOfficialPreset =
            (recordedPreset === 'code' && state.agentPreset === 'ptc') ||
            (recordedPreset === 'ptc' && state.agentPreset === 'code')
          const preset = renamedOfficialPreset && state.agentPreset !== undefined
            ? state.agentPreset
            : recordedPreset ?? 'unknown'
          state.rows.push({
            id: nextRowId,
            kind: 'notice',
            text: t('agent-preset-switched', { preset }),
          })
          nextRowId += 1
          break
        }
        // `/color` accent (dsh-tui plugin event, replayed on resume/rewind
        // like session/title): last write wins, '' clears to the default.
        if ((event as { type: string }).type === 'session/color') {
          const data = event.data as unknown as { color?: unknown }
          state.sessionColor = typeof data.color === 'string' ? data.color : ''
          break
        }
        // Custom plugin events (tuiRenderers seam): a registered renderer
        // maps the payload to text rows — title as a local row, body as
        // preview-clipped local-output rows, same shape pushLocal uses.
        // Runs on the live stream AND on replay (resume/rewind), so the
        // projection must stay total; the runtime isolates renderer
        // crashes per type.
        if (rendererRuntime !== undefined) {
          const rendered = rendererRuntime.render(
            (event as { type: string }).type,
            (event as { data?: unknown }).data,
          )
          if (rendered !== undefined) {
            if (rendered.title !== undefined && rendered.title !== '') {
              state.rows.push({ id: nextRowId, kind: 'local', text: rendered.title })
              nextRowId += 1
            }
            for (const line of rendered.lines) {
              state.rows.push({
                id: nextRowId,
                kind: 'local-output',
                text: preview(String(line), LOCAL_OUTPUT_LIMIT),
              })
              nextRowId += 1
            }
          }
        }
        break
    }
  }

  // Replay the durable transcript first, then follow live events.
  replayEvents(snapshotLiveSessionEvents(agent.session))
  settleStreaming()
  // Attached to an idle agent: any replayed turn/start belongs to a previous
  // session run, so the spinner must not come up on boot.
  state.working = false
  state.cancelPending = false
  state.status = agent.status
  state.emit()

  // Live subscription list and activity timer, rebound to every replacement
  // agent so no status from the previous session can leak across a swap.
  let agentSubscriptions: Array<() => void> = []
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
    cancelInFlight = false
    state.cancelPending = false
    state.working = false
    state.activeToolCount = 0
    settleStreaming()
    updateSpinnerMode()
  }

  const bindAgent = (): void => {
    agentBindingGeneration += 1
    state.agentBindingGeneration = agentBindingGeneration
    for (const dispose of agentSubscriptions) dispose()
    stopActivityTick()
    // Cancel state and deferred interrupt delivery belong to one bound agent.
    // A replacement must neither inherit the old latch nor receive its queued
    // microtask after the session identity changes.
    cancelInFlight = false
    interruptSeq += 1
    const prefs = activityPrefsSnapshot()
    activityTracker = new ActivityTracker(prefs.config, Date.now, prefs.customActions)
    activityFailureReported = false
    updateWorkingActivity('agent bind', () => activityTracker.onAgentStatus(agent.status))
    activityTickTimer = setInterval(() => {
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
    if (agent.options?.model === undefined && state.provider !== '' && state.model !== '') {
      selection.current = { provider: state.provider, model: state.model }
    }
    void applyPreferredEffort()
    refreshMode()
    agentSubscriptions = [
      installModelSelection(agent.ctx, selection),
      ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject !== agent) return
        state.status = status
        updateWorkingActivity(`agent/status:${status}`, () => activityTracker.onAgentStatus(status))
        if (status === 'idle') reconcileRetiredProjection('idle')
        state.emit()
      }),
      ctx.on('agent/disposed', ({ agent: subject }) => {
        if (subject !== agent) return
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
          if (payload.agent !== agent) return
          const messageId = payload.message?.id
          if (typeof messageId !== 'string') return
          const before = state.pending.length
          state.pending = state.pending.filter(item => item.id !== messageId)
          if (state.pending.length !== before) state.emit()
        }
        const disposers: Array<() => boolean> = []
        for (const event of ['agent/inbox/claimed', 'agent/inbox/discarded'] as const) {
          disposers.push(ctx.on(event, retirePending))
        }
        return () => {
          for (const dispose of disposers) dispose()
        }
      })(),
      ctx.on('session/event', (session, event) => {
        // The currently bound main session always wins. SubagentActivityStore
        // intentionally retains Session-object mappings for completed cards;
        // if one of those sessions is later adopted/resumed as the main agent,
        // checking the stale child mapping first would swallow every main event
        // (including turn/end) and leave working/cancelPending latched forever.
        const isMainSession = session === agent.session
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
        if (session !== agent.session) {
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
          // comeback copy shows on the next thinking rotation (pi parity).
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
        if (eventType === 'plan/mode' || eventType === 'sandbox/mode' || eventType === 'approval/policy') {
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
              if (restore === undefined || session !== agent.session || foldPlanActive(snapshotLiveSessionEvents(session))) return
              applyMode(restore).catch(error => {
                ctx.logger.warn(
                  `dsh-tui: plan-exit mode restore failed: ${error instanceof Error ? error.message : String(error)}`,
                )
              })
            })
          }
        }
        renderEvent(event)
        // Streaming deltas (one event per token) take the frame-aligned
        // path; every other event keeps synchronous notification.
        if (event.type === 'assistant/chunk') state.emitStream()
        else state.emit()
      }),
      // Subagent lifecycle tracking. The dsh-subagent service publishes scoped
      // observe-only events as `subagent/start` and `subagent/end`; the parent
      // Agent is carried by Cordis scope dispatch, not included in the payload.
      (() => {
        const disposeStart = ctx.on('subagent/start' as any, (info: { id: string; runId?: string; provider: string; local?: boolean }) => {
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
        const disposeEnd = ctx.on('subagent/end' as any, (info: { id: string; stopReason: string; lastAssistantMessage?: unknown[] }) => {
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
  // Subagents inherit provider/model from AgentOptions, but resumed TUI
  // agents can legitimately carry their route only in persisted request
  // headers. Their child scopes do not share this channel's per-agent
  // ModelSelectionRef, so fill an otherwise incomplete first request from
  // the active route. Keep complete child-specific routes authoritative.
  ctx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
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
  // this effect closes the final timer when the Channel's context unloads.
  const effect = (ctx as Context & {
    effect?: (setup: () => () => void, label?: string) => void
  }).effect
  effect?.call(ctx, () => () => { stopActivityTick() }, 'dsh-tui activity timer')
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
        if (state.cwd !== requestedCwd) return
        const branch = result.stdout.text.trim()
        if (branch !== '') {
          state.gitBranch = branch
          // Note it against the session too. A session log records no branch,
          // and nothing can reconstruct one after the fact, so the browser can
          // only show a branch for sessions this install actually used — which
          // is exactly what the column claims.
          noteBranch(agent.session.id, branch)
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

  return state
}

/** Trailing path segment (`C:/a/b` → `b`). */
function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

/** Normalize a cwd for comparison: forward slashes, no trailing slash; case
 *  folded when the platform's filesystem semantics are case-insensitive. */
function normalizeCwd(path: string, caseInsensitive: boolean): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

/**
 * `/resume` project filter (issue #96): exact cwd match, PLUS sessions
 * recorded in a subdirectory — pre-upgrade launches recorded the launch
 * subdirectory as the header cwd, and with the cwd default now resolving to
 * the git worktree root an exact match would hide those sessions forever.
 * They belong to the same workspace, so they stay listed. Comparison follows
 * the platform's filesystem semantics (case-insensitive on Windows — a
 * pre-upgrade header may record `C:\Repo` where the current launch resolves
 * `c:\repo`). `caseInsensitive` is a parameter (not a platform read) so the
 * verifier can exercise both modes on any host. Exported for
 * scripts/verify-session-cwd.mjs.
 *
 * Boundary rule (issue #153): container directories are nobody's workspace.
 * $HOME and the Windows root forms — plain drive roots (`C:`), UNC share
 * roots (`//server/share`), and extended-length roots (`//?/C:`,
 * `//?/UNC/server/share`) — are ancestors of unrelated projects, so the
 * descendant rules below would list every session on the machine from `~`
 * (and every session on the drive/share from those roots). At these
 * boundaries, in either direction, only an exact match passes.
 */
export function sessionCwdMatches(
  stateCwd: string,
  headerCwd: string,
  caseInsensitive: boolean = process.platform === 'win32',
): boolean {
  const cwd = normalizeCwd(stateCwd, caseInsensitive)
  const recorded = normalizeCwd(headerCwd, caseInsensitive)
  if (recorded === '' || cwd === '') return false
  const home = normalizeCwd(homeDir(), caseInsensitive)
  // Paths below arrive backslash-normalized (`\\server\share` →
  // `//server/share`, `\\?\C:\` → `//?/C:`), trailing slashes stripped.
  const isContainer = (path: string): boolean =>
    (home !== '' && path === home) ||
    /^[a-z]:$/i.test(path) || // drive root: C:
    /^\/\/[^/]+\/[^/]+$/.test(path) || // UNC share root: //server/share
    /^\/\/\?\/[a-z]:$/i.test(path) || // extended drive root: //?/C:
    /^\/\/\?\/unc\/[^/]+\/[^/]+$/i.test(path) // extended UNC root: //?/UNC/server/share
  if (isContainer(cwd) || isContainer(recorded)) return recorded === cwd
  return (
    recorded === cwd ||
    // Pre-upgrade subdirectory session of this workspace.
    recorded.startsWith(`${cwd}/`) ||
    // Resumed INTO a pre-upgrade subdirectory session (state.cwd adopted its
    // recorded subdirectory): the workspace-root sessions it belongs with
    // must stay visible, or /resume looks like it lost them for the rest of
    // the process lifetime (review leftover).
    cwd.startsWith(`${recorded}/`)
  )
}

/** Context-bar token estimate (pi-nano-context: ~4 chars per token). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Whether one stream chunk advances the first-token/decode boundary. */
function isTokenDelta(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== ''
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default:
      return false
  }
}

/** Character payload of one token-bearing stream delta for the live fallback. */
function tokenDeltaChars(chunk: StreamChunk): number {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text.length
    case 'tool-call-delta':
      return (chunk.name?.length ?? 0) + chunk.argumentsDelta.length
    default:
      return 0
  }
}

/** Provider output count when usable; durable imports may predate strict validation. */
function usageOutputTokens(usage: unknown): number | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined
  const value = (usage as { outputTokens?: unknown }).outputTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

type FileSuggestionFs = {
  resolve(path: string): Promise<{ displayPath: string }>
  listDir(target: { displayPath: string }): Promise<Array<{ name: string; type: 'file' | 'directory' | 'other'; target?: { displayPath: string } }>>
}

async function listPathCandidates(fs: FileSuggestionFs, cwd: string, query: string, signal: AbortSignal | undefined, topK: number): Promise<FileCandidate[]> {
  const normalized = query.replaceAll('\\', '/')
  const slash = normalized.lastIndexOf('/')
  // `.` / `..` without a trailing separator are whole-directory queries too.
  const bareDir = slash < 0 && (normalized === '.' || normalized === '..' || normalized === '~')
  const directoryPart = slash < 0 ? (bareDir ? `${normalized}/` : '') : normalized.slice(0, slash + 1)
  const nameQuery = slash < 0 || bareDir ? '' : normalized.slice(slash + 1)
  // `~/` expands against the host home (matches the cwd resolution rules);
  // drive-letter and POSIX-absolute prefixes pass through untouched.
  const expanded = directoryPart === '~/'
    ? `${homeDir()}/`
    : directoryPart.startsWith('/') || /^[A-Za-z]:\//.test(directoryPart)
      ? directoryPart
      : join(cwd, directoryPart || '.')
  try {
    if (signal?.aborted) return []
    const target = await fs.resolve(expanded)
    const entries = (await fs.listDir(target)).slice().sort((a, b) => a.name.localeCompare(b.name))
    return rankFileCandidates(entries.filter(entry => entry.type === 'file' || entry.type === 'directory').map(entry => {
      const path = `${directoryPart}${entry.name}${entry.type === 'directory' ? '/' : ''}`
      return { id: path, path, displayPath: path, name: entry.name, kind: entry.type as 'file' | 'directory', score: 0 }
    }), nameQuery, topK)
  } catch {
    return []
  }
}

async function listFilesDeepCandidates(fs: FileSuggestionFs | undefined, root: string, signal?: AbortSignal): Promise<FileCandidate[]> {
  if (!fs) return []
  const out: FileCandidate[] = []
  const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', '.DS_Store', 'dist'])
  const BUILD_DIR = /^(?:build(?:[-_].*)?|cmake-build(?:[-_].*)?)$/i
  type Entry = { name: string; type: 'file' | 'directory' | 'other'; target?: { displayPath: string } }
  type Node = { dir: string; prefix: string; entries?: Entry[]; index: number }
  const queue: Node[] = [{ dir: root, prefix: '', index: 0 }]
  const visited = new Set<string>()
  const maxFiles = 100
  const maxDirectories = 100
  let fileCount = 0
  let dirCount = 0
  // Round-robin: each directory yields ONE non-skipped entry per visit before
  // it re-queues, so a large early sibling (e.g. `generated/` with 120 files)
  // cannot starve `src/` out of the per-kind budgets. This is the regression
  // contract pinned by scripts/verify-file-completion.mjs.
  while (queue.length && fileCount < maxFiles && dirCount < maxDirectories) {
    if (signal?.aborted) return []
    const current = queue.shift()!
    if (!current.entries) {
      try {
        const target = await fs.resolve(current.dir)
        if (visited.has(target.displayPath)) continue
        visited.add(target.displayPath)
        current.entries = (await fs.listDir(target)).slice().sort((a, b) => a.name.localeCompare(b.name))
      } catch { continue }
    }
    let entry: Entry | undefined
    while (current.index < current.entries.length) {
      const candidate = current.entries[current.index++]!
      if (SKIP.has(candidate.name) || BUILD_DIR.test(candidate.name)) continue
      entry = candidate
      break
    }
    if (!entry) continue
    if (current.index < current.entries.length) queue.push(current)

    const path = current.prefix ? `${current.prefix}/${entry.name}` : entry.name
    if (entry.type === 'directory') {
      if (dirCount >= maxDirectories) continue
      out.push({ id: `${path}/`, path: `${path}/`, displayPath: `${path}/`, name: entry.name, kind: 'directory', score: 0 })
      dirCount += 1
      queue.push({ dir: entry.target?.displayPath ?? join(current.dir, entry.name), prefix: path, index: 0 })
    } else if (entry.type === 'file') {
      if (fileCount >= maxFiles) continue
      out.push({ id: path, path, displayPath: path, name: entry.name, kind: 'file', score: 0 })
      fileCount += 1
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** One attached file's contribution is capped so an absent-minded `@` of a
 *  huge file cannot blow the context window (CC caps @-attachments too). */
const MENTION_MAX_FILE_CHARS = 50_000
/** Total budget across all attachments in one message. */
const MENTION_MAX_TOTAL_CHARS = 200_000
/** A directory mention contributes a shallow listing, capped at this many
 *  entries. */
const MENTION_MAX_DIR_ENTRIES = 200

/** The fs-service surface `@`-mention expansion consumes (dsh-fs-local). */
export interface MentionFs {
  resolve(path: string): Promise<{ displayPath: string }>
  stat(target: { displayPath: string }): Promise<{ type: 'file' | 'directory' | 'other' } | undefined>
  readText(target: { displayPath: string }): Promise<string>
  readBytes?(target: { displayPath: string }, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  listDir(target: { displayPath: string }): Promise<Array<{ name: string; type: 'file' | 'directory' | 'other' }>>
}

/** The leaf's fs service in the shape mention expansion needs; undefined
 *  when the plugin is not mounted (mentions then stay literal text). */
function mentionFs(ctx: Context): MentionFs | undefined {
  return ctx.get('fs') as MentionFs | undefined
}

type MentionImageBlock = ChannelImageBlock
type MentionImageMediaType = ChannelImageMediaType

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

function mentionAttachments(ctx: Context): MentionAttachments | undefined {
  return ctx.get('attachments') as MentionAttachments | undefined
}

const MENTION_IMAGE_MEDIA_TYPES: Readonly<Record<string, MentionImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function mentionImageMediaType(path: string): MentionImageMediaType | undefined {
  return MENTION_IMAGE_MEDIA_TYPES[extname(path).toLowerCase()]
}

/** One mention target that resolved and stat'ed to something attachable. */
interface ResolvedMention {
  target: { displayPath: string }
  info: { type: 'file' | 'directory' | 'other' }
}

/** Resolve+stat one candidate path; undefined when it throws OR stats
 * absent — both are a miss for strip-first mention resolution (issue #359). */
async function tryResolveMention(fs: MentionFs, absolute: string): Promise<ResolvedMention | undefined> {
  try {
    const target = await fs.resolve(absolute)
    const info = await fs.stat(target)
    if (info === undefined) return undefined
    return { target, info }
  } catch {
    return undefined
  }
}

export interface MentionExpansion {
  /** Model-facing blocks: the typed text first, one block per attachment. */
  blocks: ContentBlock[]
  /** Paths that resolved and were attached (for the confirmation notice). */
  attached: string[]
  /** Mention tokens that failed to resolve (kept literal, warned about). */
  missing: string[]
}

/**
 * Expand a submitted text's `@` mentions (issue #15) into model-facing
 * attachment blocks: supported image files become durable image blocks,
 * other files contribute capped text, and directories contribute a shallow
 * listing. Reads always go through the active fs service, so provider-owned
 * workspaces keep their routing semantics. The typed text stays first and
 * verbatim. Best-effort failures degrade to `missing`, never a failed send.
 */
export async function expandMentions(
  fs: MentionFs | undefined,
  cwd: string,
  text: string,
  attachments?: MentionAttachments,
  stagedImages?: ReadonlyMap<string, MentionImageBlock['attachment']>,
): Promise<MentionExpansion> {
  const blocks: MentionExpansion['blocks'] = [{ type: 'text', text }]
  const attached: string[] = []
  const missing: string[] = []
  const mentions = extractMentions(text)
  let budget = MENTION_MAX_TOTAL_CHARS
  let imageCount = 0
  let imageBytes = 0
  if (fs !== undefined) {
    for (const mention of mentions) {
    const display = mention.literal ?? mention.path
    const imageMediaType = mentionImageMediaType(mention.path)
    if (budget <= 0 && imageMediaType === undefined) break
    // Mentions resolve against the session cwd, same as the model-facing fs
    // tools; absolute paths pass through untouched. A `#L12-14` line suffix
    // (issue #359) is stripped before resolution; when the stripped path
    // misses, the typed literal (suffix intact) gets ONE fallback try so
    // filenames genuinely containing `#L…` still resolve as whole files.
    const absolute = isAbsolute(mention.path) ? mention.path : join(cwd, mention.path)
    let resolved = await tryResolveMention(fs, absolute)
    let literalFallback = false
    if (resolved === undefined && mention.literal !== undefined) {
      const literalPath = isAbsolute(mention.literal) ? mention.literal : join(cwd, mention.literal)
      resolved = await tryResolveMention(fs, literalPath)
      literalFallback = resolved !== undefined
    }
    if (resolved === undefined) {
      missing.push(display)
      continue
    }
    const { target, info } = resolved
    // On a literal-fallback hit the attached file IS the typed name — the
    // model must see that path, not the suffix-stripped one.
    const shownPath = literalFallback ? display : mention.path
    // …and judge image-ness by the typed extension in that case too.
    const imageType = literalFallback && mention.literal !== undefined
      ? mentionImageMediaType(mention.literal)
      : imageMediaType
    if (info?.type === 'file') {
      if (imageType !== undefined && attachments !== undefined && fs.readBytes !== undefined) {
        const limits = attachments.imageLimits
        if (!limits.mediaTypes.includes(imageType) || imageCount >= limits.maxImagesPerMessage) {
          missing.push(display)
          continue
        }
        try {
          const data = await fs.readBytes(target, undefined, limits.maxImageBytes)
          if (imageBytes + data.byteLength > limits.maxMessageImageBytes) {
            missing.push(display)
            continue
          }
          const attachment = await attachments.saveImage({
            data,
            mediaType: imageType,
            name: basename(target.displayPath),
          })
          blocks.push({ type: 'image', attachment })
          imageCount += 1
          imageBytes += data.byteLength
          attached.push(display)
        } catch {
          missing.push(display)
        }
        continue
      }
      try {
        const cap = Math.min(MENTION_MAX_FILE_CHARS, budget)
        const content = await fs.readText(target)
        let body = content
        let truncated = false
        let header = `<attached-file path="${shownPath}">`
        if (mention.startLine !== undefined && !literalFallback) {
          // Line-range slice (issue #359): 1-based inclusive. An endLine
          // past EOF clamps to the file; a startLine past EOF falls back
          // to the whole file with an in-band note — never a silent
          // empty attach. Line ranges never apply to literal-fallback
          // hits (those files really are named `…#L…`, no suffix typed).
          const lines = content.split('\n')
          if (mention.startLine > lines.length) {
            header = `<attached-file path="${shownPath}" lines="${mention.startLine}-${mention.endLine}" note="requested lines beyond EOF (file has ${lines.length} line${lines.length === 1 ? '' : 's'}); whole file attached">`
          } else {
            const endLine = Math.min(mention.endLine ?? mention.startLine, lines.length)
            header = `<attached-file path="${shownPath}" lines="${mention.startLine}${endLine === mention.startLine ? '' : `-${endLine}`}">`
            body = lines.slice(mention.startLine - 1, endLine).join('\n')
          }
        }
        if (body.length > cap) {
          body = body.slice(0, cap)
          truncated = true
        }
        budget -= body.length
        blocks.push({
          type: 'text',
          text: `${header}\n${body}${truncated ? '\n[… truncated]' : ''}\n</attached-file>`,
        })
        attached.push(display)
      } catch {
        // Binary/undecodable or unreadable — report it like a miss.
        missing.push(display)
      }
      continue
    }
    if (info?.type === 'directory') {
      try {
        const entries = await fs.listDir(target)
        const listing = entries
          .slice(0, MENTION_MAX_DIR_ENTRIES)
          .map(entry => (entry.type === 'directory' ? `${entry.name}/` : entry.name))
        if (entries.length > MENTION_MAX_DIR_ENTRIES) {
          listing.push(`… (${entries.length - MENTION_MAX_DIR_ENTRIES} more)`)
        }
        const body = listing.join('\n')
        budget -= body.length
        blocks.push({
          type: 'text',
          text: `<attached-directory path="${shownPath}">\n${body}\n</attached-directory>`,
        })
        attached.push(display)
      } catch {
        missing.push(display)
      }
      continue
    }
    // Absent (stat → undefined) or a special file.
    missing.push(display)
    }
  }
  if (attachments !== undefined && stagedImages !== undefined) {
    const limits = attachments.imageLimits
    for (const [token, attachment] of stagedImages) {
      if (!text.includes(token)) continue
      // A referenced-but-dropped staged image must be loud: silently sending
      // the bare token would leave the user believing the image reached the
      // model. Reuse the missing-mention warning channel.
      if (
        imageCount >= limits.maxImagesPerMessage
        || imageBytes + attachment.bytes > limits.maxMessageImageBytes
        || !limits.mediaTypes.includes(attachment.mediaType)
      ) {
        missing.push(token)
        continue
      }
      blocks.push({ type: 'image', attachment })
      imageCount += 1
      imageBytes += attachment.bytes
    }
  }
  return { blocks, attached, missing }
}
