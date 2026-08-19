import { randomUUID } from 'node:crypto'
import { assembleContextFor, installModelSelection, type Agent, type AgentHandle, type AgentStatus, type CreateAgentOptions, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { isUserInvocable, renderSkillContent, type SkillSummary } from '@deepseek-ai/dsh-skill'
import type { LlmConfigurableProvider, LlmDiscoveredModel, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import {
  createUserMessage,
  isTokenDelta,
  MessageId,
  ReasoningEffortId,
  type ContentBlock,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { runSideQuestion, wrapSideQuestion } from './sideQuestion.js'
/** dsh-llm LlmRuntime as the side-question needs it: one streaming call. */
type SideQuestionLlm = {
  stream(options: object): AsyncIterable<StreamChunk>
}
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { loadBaselineInstructions } from '@deepseek-ai/dsh-agent-instructions'
import type { Context } from '@deepseek-ai/cordis'
import { extname, isAbsolute, join } from 'node:path'
import { completeCommands, isLocalCommandName, LOCAL_COMMANDS, parseCommandName, type CommandCompletion, type CommandCompletionNode, type LocalCommand } from '../commands.js'
import { clearResumeTarget, forgetSession, readResumeTarget, touchSession, writeResumeTarget } from '../sessionHistory.js'
import { appendSessionTitle, deleteSessionLog, ensureLegacySessionEventTypes, sessionsRoots } from './compat/index.js'
import {
  listSummaries,
  locateSession,
  noteBranch,
  previewSession,
  type PreviewEntry,
  type SessionSource,
  type SessionSummary,
} from './sessions/index.js'
import { writeActivityFrames } from '../activityPrefs.js'
import { readEffortPref, writeEffortPref } from '../effortPrefs.js'
import { readModelPref, writeModelPref } from '../modelPrefs.js'
import { explicitModelRoute, recordedModelRoute, resolveModelRoute, validateModelRoute } from '../modelRoute.js'
import type { ProviderSetupHost } from './providerWizard.js'
import { readPresetPref, writePresetPref } from '../presetPrefs.js'
import { composePreset, resolvePersistedPreset, rosterOf, runningPresetOf, serviceForAgent, type AgentPresetInfo } from './presets.js'
import { isPresetName } from '../components/activityFrames.js'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { logForDebugging } from '../utils/debug.js'
import { homeDir, LEGACY_DATA_DIR } from '../utils/paths.js'
import { extractMentions } from '../utils/mentions.js'
import { t } from '../i18n.js'
import { modeDisplayName, resolveSessionModes, type SessionModeSpec } from '../sessionModes.js'
import type { SpinnerMode } from '../components/Spinner/spinnerMode.js'
import { ActivityTracker, type ActivityState } from 'dsh-working-activity/status'
import { attachSessionToWorkspace } from './workspace.js'
import { createLocalWorkspaceRuntime, getHostWorkspaceRuntime, type TuiWorkspaceCommand, type TuiWorkspaceCommandResult, type TuiWorkspaceTarget } from './workspaces.js'
import { getHostCommandTrees } from './command-trees.js'
import { getHostSettingsSections, type TuiSettingsSection, type TuiSettingsSectionsRuntime } from './settings-sections.js'
import type { SettingsHost } from './settingsEditor.js'
import { getHostSceneRuntime, type TuiSceneDescriptor, type TuiSceneRuntime } from './scenes.js'
import { getHostRenderers, type TuiRendererRuntime } from './renderers.js'
import { getHostMessageObserver, type TuiMessageObserverRuntime } from './message-observer.js'
import { dispatchTuiDecision, dispatchTuiNotification, normalizeCancelDecision } from './extension-events.js'
import { installDecisionGuard } from './decision-guard.js'
import { commandOwner } from './command-attribution.js'
import { readGrantStore } from './grants.js'
import { hasCommandErrorCode, mapCommandError } from './command-errors.js'
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
 * One rendered transcript row. The DSH session log is the source of truth:
 * rows are derived from `session/event` records (and the initial
 * `agent.session.events` replay), never from optimistic local state.
 */
export interface ChatRow {
  id: number
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'reasoning' | 'interrupt' | 'local' | 'local-output' | 'compact'
  /** Extra label for non-human user rows (e.g. `steering`). */
  label?: string
  /** Actual execution location for `!command` rows. */
  executionTarget?: string
  text: string
  /** True while an assistant step is still streaming chunks. */
  streaming?: boolean
  /** Present on `tool` rows; the card model. */
  tool?: ToolRow
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
}

/**
 * Delay before re-reading a skill catalog that reported an incomplete
 * observation (a provider whose directory watcher is still warming).
 */
const SKILL_COMMAND_RETRY_MS = 800

/** Running token totals across the session's assistant messages. */
export interface TokenUsage {
  input: number
  output: number
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

/** Secret-free credential metadata for configuration and status surfaces. */
export interface CredentialStatus {
  configured: boolean
  source?: string
  writable: boolean
}

/** One entry of the latest todo-list snapshot (mirrors the session domain's
 *  `TodoItem`; declared locally for the same reason as {@link ChannelGoal}). */
export interface TodoPanelItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
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
  readonly agentId: string
  /** Resolved model id (from the plugin config). */
  readonly model: string
  /** Provider route of the live agent. */
  readonly provider: string
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
  /** Whether the in-process working-activity line is shown (config.activity). */
  readonly activityEnabled: boolean
  /** Whether the segmented context bar row shows in the status footer
   *  (config.contextBar; the status/mode lines are unaffected). */
  readonly contextBarEnabled: boolean
  /**
   * Current same-session goal projection, when a goal exists. Derived live
   * from the durable `goal/change` context events (round-zero goal-sourced
   * user messages) in the session log — every goal mutation appends one, so
   * this snapshot tracks create/edit/pause/resume/complete/block/clear in
   * real time and replays correctly on resume/rewind.
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
  /** Abort the in-flight turn (`Ctrl+C` while working). */
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
  /** The live agent's full skill catalog for `/skills` (issue #204) — name,
   *  description, invocation flags and source bucket. Undefined on a failed
   *  or incomplete registry read (the picker shows an error); empty only
   *  when no registry is mounted or it genuinely holds nothing. */
  listSkills(): Promise<readonly SkillInfo[] | undefined>
  /** Safe credential metadata for `/login`; undefined without the service. */
  describeCredential(ref: string): Promise<CredentialStatus | undefined>
  /** Runtime capabilities for the `/provider` wizard, over the settings /
   *  credentials / llm seams; undefined when the composition lacks them
   *  (bare cordis.yml start without the dsh-base services). */
  providerSetup(): ProviderSetupHost | undefined
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
  /** Top-level entries of the session cwd for `@` file completion. */
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
  agentId: string
  model: string
  provider: string
  tokens: TokenUsage
  cwd: string
  displayCwd: string
  gitBranch: string | undefined
  working: boolean
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
  /** Diff presentation preference (see the public Channel type). */
  diffLayout: 'auto' | 'split' | 'unified'
  /** Thinking-block display (see the public Channel type). */
  thinkingFold: 'preview' | 'full'
  /** Apply a diff-layout change (see the public Channel type). */
  setDiffLayout(layout: 'auto' | 'split' | 'unified'): void
  /** Apply a thinking-display change (see the public Channel type). */
  setThinkingFold(mode: 'preview' | 'full'): void
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
  /** The live agent's skill catalog for `/skills` (see the public Channel type). */
  listSkills(): Promise<readonly SkillInfo[] | undefined>
  /** Safe credential metadata for `/login` (see the public Channel type). */
  describeCredential(ref: string): Promise<CredentialStatus | undefined>
  /** `/provider` wizard capabilities (see the public Channel type). */
  providerSetup(): ProviderSetupHost | undefined
  /** `/settings` screen capabilities (see the public Channel type). */
  settingsHost(): SettingsHost | undefined
  /** Plugin-declared settings sections (see the public Channel type). */
  settingsSections(): readonly TuiSettingsSection[]
  /** Subscribe to settings-section register/unregister events. */
  subscribeSettingsSections(listener: () => void): () => void
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
  session: { seq: number; events: readonly SessionEvent[] },
  fromSeq: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const last = session.events.at(-1)
    if (last !== undefined && last.type === 'turn/end' && last.seq >= fromSeq) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return false
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
  const settingsSectionsRuntime = getHostSettingsSections(
    ctx.get('tuiSettingsSections') as TuiSettingsSectionsRuntime | undefined,
  )
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
  const sessionSwitchVetoed = async (kind: 'new' | 'resume', targetSessionId?: string): Promise<boolean> => {
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
  const notifySessionSwitched = (kind: 'new' | 'resume' | 'rewind', sessionId: string, previousSessionId: string): void => {
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
  /** Monotonic token: only the latest `interruptAndDeliver` re-queues, so a
   *  second interrupt while the abort settles cannot double-deliver. */
  let interruptSeq = 0
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
      const execution = await commandService.execute(
        agent,
        `/${name}${rawInput}`,
        new AbortController().signal,
      )
      // `undefined` = not registered; a handler error surfaces as its
      // message so the user sees why the command failed.
      return execution?.result.text ?? ''
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
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
    state.modeIndex = deriveModeIndex(agent.session.events)
    state.mode = sessionModes[state.modeIndex]!
  }

  /** Apply one configured mode: each declared atom switches independently
   *  (plan via the registry `/plan` command; sandbox/approval via their
   *  durable session-log override events). A failing plan toggle aborts the
   *  whole switch so the session never lands in a half-applied mode. */
  const applyMode = async (spec: SessionModeSpec): Promise<void> => {
    if (spec.plan !== undefined && foldPlanActive(agent.session.events) !== spec.plan) {
      const text = await executeRegistryCommand('plan', spec.plan ? '' : ' off')
      if (text === undefined) {
        // The active preset registers no /plan.
        state.notify(t('mode-plan-unavailable'), { color: 'warning' })
        return
      }
    }
    // The durable sandbox override is one session event (dsh-sandbox-policy's
    // own write path); the session/event arm picks it up immediately.
    if (spec.sandbox !== undefined && foldSandboxMode(agent.session.events) !== spec.sandbox) {
      ;(agent.session as unknown as { append(type: string, data: Record<string, unknown>): unknown }).append(
        'sandbox/mode',
        { mode: spec.sandbox },
      )
    }
    // Prefer the approval service (it narrates the switch to the model);
    // the raw durable event is the fallback when it is unmounted.
    if (spec.approval !== undefined && foldApprovalPolicy(agent.session.events) !== spec.approval) {
      const approval = ctx.get('approval') as
        | { setPolicy(a: Agent, policy: 'ask' | 'never'): void }
        | undefined
      if (approval) {
        approval.setPolicy(agent, spec.approval)
      } else {
        ;(agent.session as unknown as { append(type: string, data: Record<string, unknown>): unknown }).append(
          'approval/policy',
          { policy: spec.approval },
        )
      }
    }
    refreshMode()
    state.notify(t('mode-switched', { name: modeDisplayName(state.mode) }))
    state.emit()
  }

  /** Shift+Tab: advance to the next configured session mode. Cycling starts
   *  from the mode DERIVED from the session log (never a stored index), so
   *  manual `/plan` use can never desync the cycle. */
  const cycleMode = async (): Promise<void> => {
    const index = deriveModeIndex(agent.session.events)
    await applyMode(sessionModes[(index + 1) % sessionModes.length]!)
  }

  const state: ChannelState = {
    version: 0,
    rows: [],
    status: 'starting',
    sessionTitle: '',
    agentId: agent.id,
    model: options.model,
    provider: options.provider,
    tokens: { input: 0, output: 0 },
    cwd: options.cwd,
    displayCwd: workspaceService.describe(options.cwd).description ?? options.cwd,
    gitBranch: undefined,
    working: false,
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
    diffLayout: options.diffLayout ?? 'auto',
    thinkingFold: options.thinkingFold ?? 'preview',
    activityEnabled: options.activity !== false,
    contextBarEnabled: options.contextBar !== false,
    agentPreset: options.agentPreset,
    goal: undefined,
    todos: [],
    loadedContext: undefined,
    pending: [],
    commandList: LOCAL_COMMANDS,
    commandCompletions(input: string) {
      return completeCommands(input, state.commandList, (path) => {
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
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit() {
      foldRows(state.rows, MAX_ROWS, foldCursor)
      state.version += 1
      for (const listener of listeners) listener()
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
        foldRows(state.rows, MAX_ROWS, foldCursor)
        for (const listener of listeners) listener()
      }, 16)
      // Never hold the process open for a pending UI wakeup.
      timer.unref()
    },
    loadOlder() {
      // Restore folded-away full text from the session log, newest folded
      // batch first, clearing the folded marks. The log is the authoritative
      // source, so restored rows match a fresh replay; live streaming rows
      // are never folded, so nothing here races a running turn.
      const restored = foldBack(state.rows, agent.session.events, { call: presentCallView, result: presentResultView })
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
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    },
    interruptAndDeliver(texts: readonly string[]): number {
      const queued = texts.map(text => text.trim()).filter(text => text !== '')
      if (queued.length === 0) return 0
      // No keepInbox: the parked copies are dropped (their discard events
      // retire the preview), then each text is re-queued as a fresh
      // followup. The harness parks kept inbox work until an unrelated wake
      // (official cancel.spec: "keepInbox parks queued work after an active
      // turn aborts"), and a wake issued while the driver is still aborting
      // is ignored — so the re-queue happens on `whenIdle`, whose own wake
      // starts the new turn.
      agent.cancel({ kind: 'user' })
      const token = ++interruptSeq
      const whenIdle = (agent as { whenIdle?(): Promise<void> }).whenIdle
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
      if (typeof whenIdle === 'function') {
        void whenIdle.call(agent).then(deliver)
      } else {
        // Defensive: a wake while the driver still runs is ignored, so wait
        // for the abort to settle before re-queueing.
        setTimeout(deliver, 200)
      }
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
      const sessions = ctx.get('sessions') as
        | { fork(source: unknown, boundary?: number): { events: readonly SessionEvent[] } }
        | undefined
      const agents = ctx.get('agents') as
        | { create(options: CreateAgentOptions): Promise<AgentHandle> }
        | undefined
      if (!sessions || !agents) {
        state.notify(t('rewind-unavailable'), { color: 'error' })
        return null
      }
      // Stop a running turn first and WAIT for its turn/end to land — fork
      // rejects boundaries inside open turns, and Agent.cancel() closes the
      // turn asynchronously (a long thinking turn can take seconds to settle).
      const wasWorking = state.working
      const cancelSeq = agent.session.seq
      if (wasWorking) agent.cancel({ kind: 'user' })
      if (wasWorking) {
        const turnSettled = await waitForTurnEnd(agent.session, cancelSeq, 30000)
        if (!turnSettled) {
          state.notify(t('rewind-settling'), { color: 'error' })
          return null
        }
      }
      const childId = SessionId(randomUUID())
      // DSH event order is `turn/start → user/message → … → turn/end`, so a
      // message's own seq always sits inside its turn — forking there would
      // hit OPEN_TURN. Rewind to just BEFORE the message's turn/start: the
      // conversation restarts at that point and the message itself comes
      // back into the input for re-editing (CC's rewind semantics).
      const events = agent.session.events
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
      // Slice the seed ourselves instead of storing a fork: agents.create
      // must own the session (a pre-created fork session would collide on
      // the same id). The create boundary validates the seed (contiguous
      // from seq 0, no open turns), which our boundary already guarantees.
      let seed: readonly SessionEvent[]
      try {
        if (boundary < 0) {
          throw new Error('cannot rewind to the very first message')
        }
        seed = sessions.fork(agent.session, boundary).events
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
        handle = await agents.create({
          sessionId: childId,
          seed,
          meta: {
            cwd: state.cwd,
            parentSession: agent.session.id,
            seedLength: seed.length,
            ...(rewindComposed.agentPreset === undefined
              ? {}
              : { agentPreset: rewindComposed.agentPreset }),
          },
          agentOptions: { provider: state.provider, model: state.model },
          ...(rewindComposed.setup === undefined ? {} : { setup: rewindComposed.setup }),
        })
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
      state.tokens = { input: 0, output: 0 }
      state.responseChars = 0
      state.activeToolCount = 0
      state.lastUserText = ''
      state.working = false
      state.spinnerMode = 'requesting'
      state.status = handle.agent.status
      state.agentId = handle.agent.id
      state.agentPreset = rewindComposed.agentPreset
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
      try {
        handle = await agents.resume({
          resumeSessionId: SessionId(sessionId),
          agentOptions: { provider: resumeRoute?.provider, model: resumeRoute?.model },
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
      state.tokens = { input: 0, output: 0 }
      state.responseChars = 0
      state.activeToolCount = 0
      state.lastUserText = ''
      state.working = false
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
      const resumedRoute = resumeRoute ?? recordedModelRoute(handle.agent.session.events)
      if (resumedRoute !== undefined) {
        state.provider = resumedRoute.provider
        state.model = resumedRoute.model
      }
      state.tps = undefined
      state.tpsSamples = []
      state.lastUsage = undefined
      state.workingActivity = undefined
      state.contextWindow = undefined
      state.contextSegments = {
        system: 0,
        prompt: 0,
        assistant: 0,
        thinking: 0,
        tools: 0,
      }
      replayEvents(handle.agent.session.events)
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
      const sessionId = SessionId(randomUUID())
      let handle: AgentHandle
      // A fresh session composes the caller's DEFAULT preset: the cordis.yml
      // `preset` key wins over the persisted `/preset` choice, which wins
      // over the roster default (same precedence as activityFrames).
      const newComposed = await composePreset(ctx, options.configuredPreset ?? readPresetPref())
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
      // keep it out of the next turn's settle logs and revive cache.
      sealedReasoning.length = 0
      lastReasoningRow = undefined
      toolCards.clear()
      nextRowId = 0
      state.rows.length = 0
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
      state.tokens = { input: 0, output: 0 }
      state.responseChars = 0
      state.activeToolCount = 0
      state.lastUserText = ''
      state.working = false
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
      state.contextWindow = undefined
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
      const sessions = ctx.get('sessions') as
        | { fork(source: unknown, boundary?: number): { events: readonly SessionEvent[] } }
        | undefined
      const agents = ctx.get('agents') as
        | { create(options: CreateAgentOptions): Promise<AgentHandle> }
        | undefined
      if (!sessions || !agents) {
        state.notify(t('model-switch-unavailable'), {
          color: 'error',
        })
        return false
      }
      let seed: readonly SessionEvent[]
      try {
        // No boundary = fork the whole log (continue the conversation).
        seed = sessions.fork(agent.session).events
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
        handle = await agents.create({
          sessionId: childId,
          seed,
          meta: {
            cwd: state.cwd,
            parentSession: agent.session.id,
            seedLength: seed.length,
            ...(modelComposed.agentPreset === undefined
              ? {}
              : { agentPreset: modelComposed.agentPreset }),
          },
          agentOptions: { provider, model },
          ...(modelComposed.setup === undefined ? {} : { setup: modelComposed.setup }),
        })
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
      state.tokens = { input: 0, output: 0 }
      state.responseChars = 0
      state.activeToolCount = 0
      state.lastUserText = ''
      state.working = false
      state.spinnerMode = 'requesting'
      state.status = handle.agent.status
      state.agentId = handle.agent.id
      state.agentPreset = modelComposed.agentPreset
      state.model = model
      state.provider = provider
      state.tps = undefined
      state.tpsSamples = []
      state.lastUsage = undefined
      state.workingActivity = undefined
      state.contextWindow = undefined
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
      refreshCommandList()
      void refreshLoadedContext()
      void refreshSkillCommands()
      // The model-switched fork becomes the most recently used.
      touchSession(childId)
      state.emit()
      void oldHandle?.dispose().catch(() => {})
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
    async listPresets() {
      const presets = rosterOf(ctx)
      if (presets === undefined) return []
      try {
        const list = await presets.list()
        return list.map(preset => ({
          id: preset.id,
          ...(preset.name === undefined ? {} : { name: preset.name }),
          ...(preset.description === undefined ? {} : { description: preset.description }),
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
        target = await presets.resolve(presetId)
      } catch (error) {
        state.notify(
          t('preset-not-found', { id: presetId, err: error instanceof Error ? error.message : String(error) }),
          { color: 'error', timeoutMs: 8000 },
        )
        return false
      }
      if (target.broken !== undefined) {
        state.notify(t('preset-load-failed', { id: presetId, broken: target.broken }), { color: 'error', timeoutMs: 8000 })
        return false
      }
      if (target.id === state.agentPreset) {
        state.notify(t('preset-already-current', { id: target.id }), { color: 'success' })
        return true
      }
      // Official rule (dsh-agent-presets): only a session that has produced
      // nothing may swap compositions — a started session's logged tool calls
      // would strand under a different tool set. Blank = no turn ever ran.
      const blank = !agent.session.events.some(event => event.type === 'turn/start')
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
    async listSkills() {
      // snapshot() over list(): only a COMPLETE observation is authoritative
      // (same contract as the skill-command merge above) — a partial catalog
      // must surface as "failed", not as a misleading near-empty picker.
      const registry = skillRegistryFor(agent)
      if (registry === undefined) return []
      try {
        const observation = await registry.snapshot(skillViewOptions(agent))
        if (!observation.complete) return undefined
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
          describe(): readonly { ns: string; revision: number }[]
          get(ns: string): unknown
          mutate(
            ns: string,
            ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[],
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
      return {
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
        discoverModels(request) {
          return llm.discoverModels('llm-pi-ai', request)
        },
        envShadows(ref) {
          return process.env[ref] !== undefined
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
      }
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
    listFiles() {
      const fs = ctx.get('fs') as
        | {
          resolve(path: string): Promise<{ displayPath: string }>
          listDir(target: { displayPath: string }): Promise<
            Array<{
              name: string
              type: 'file' | 'directory' | 'other'
              target: { displayPath: string }
            }>
          >
        }
        | undefined
      return listFilesDeep(fs, state.cwd)
    },
    async listSessions() {
      // Every stored session, classified and unfiltered. Which of them a
      // surface shows — this project only, conversations only, sub-agent runs
      // folded away — is a view decision, and keeping it out of here is what
      // lets the browser toggle those views without re-reading a single log.
      const persistence = ctx.get('sessionPersistence') as SessionSource | undefined
      if (!persistence) return []
      return listSummaries(persistence)
    },
    async previewSession(sessionId) {
      const persistence = ctx.get('sessionPersistence') as SessionSource | undefined
      if (!persistence) return []
      const path = await locateSession(persistence, sessionId)
      return path === undefined ? [] : previewSession(path, PREVIEW_ENTRIES)
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
    async deleteSession(sessionId) {
      // The live session's log is still being appended by this process —
      // deleting it from under the writer is never offered in the picker
      // (the current session is filtered out), so refuse it here too.
      if (sessionId === agent.session.id) return false
      if (deleteSessionLog(sessionId) !== 'deleted') return false
      forgetSession(sessionId)
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
        const signal = new AbortController().signal
        state.notify(t('compact-working'))
        void compactService
          .compactNow(agent, signal)
          .then((result) => {
            state.notify(result ? t('compact-done') : t('compact-nothing'))
          })
          .catch((error: unknown) => {
            state.notify(
              t('compact-failed', { err: error instanceof Error ? error.message : String(error) }),
              { color: 'error', timeoutMs: 8000 },
            )
          })
      })()
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
      for (const event of agent.session.events) {
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
      // legacy ~/.dsh-tui, profile → $DSH_HOME/sessions), so list every
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
      return agent.session.events
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
      // The skills registry is host-plane but scope-layered: preset rows
      // (skill-filesystem) register into the preset's layer, so the catalog
      // must be read through the agent's scope chain (serviceForAgent falls
      // back to the host context when no roster is mounted).
      const skillsService = serviceForAgent<{
        list(options?: unknown): Promise<readonly { name: string; description: string }[]>
      }>(ctx, target, 'skills')
      if (skillsService !== undefined) {
        const catalog = await skillsService.list({})
        if (target !== agent) return
        skills.push(...catalog.map(skill => ({
          name: skill.name,
          description: skill.description,
        })))
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
   * `/` menu and Tab completion, like /audit and /review). Skill entries
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
    if (streaming === undefined) {
      streaming = { id: nextRowId, kind: 'assistant', text: '', streaming: true, ...seq !== undefined ? { seq } : {} }
      nextRowId += 1
      state.rows.push(streaming)
    }
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
   * Fold one goal-sourced message into the channel's goal projection.
   * Round-zero goal messages carry the full durable snapshot (or a clear
   * tombstone) in their source; positive-round messages are admitted
   * continuation prompts that only advance the rounds counter.
   */
  const applyGoalEvent = (event: SessionEvent<'user/message'>): void => {
    const source = event.data.source as unknown as {
      round: number
      change?: {
        kind: 'goal/change'
        version: 1
        operation:
          | 'create'
          | 'edit'
          | 'pause'
          | 'resume'
          | 'complete'
          | 'block'
          | 'clear'
        goal?: ChannelGoal
        roundsStarted?: number
      }
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
    if (change.operation === 'clear') {
      state.goal = undefined
    } else if (change.goal !== undefined) {
      state.goal = {
        ...change.goal,
        roundsStarted: change.roundsStarted ?? state.goal?.roundsStarted ?? 0,
      }
    }
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
    replaying = true
    try {
      for (const event of prepareReplayEvents(events)) renderEvent(event)
    } finally {
      replaying = false
    }
  }

  const renderEvent = (event: SessionEvent): void => {
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
        // Same-session goal domain: round-zero goal-sourced messages carry
        // the durable goal snapshot (or clear tombstone) in their source.
        // They are not transcript bubbles — they drive the goal panel's
        // live projection (replayed on resume/rewind like every other event).
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
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') {
          if (chunk.text) {
            // Fold the thinking preview while it is still in the live
            // window (see foldLiveReasoning) — before this text grows the
            // transcript and pushes the block into scrollback.
            foldLiveReasoning('first text token')
            ensureStreaming(event.seq).text += chunk.text
            state.responseChars += chunk.text.length
          }
        } else if (chunk.type === 'reasoning-delta') {
          if (chunk.text) {
            ensureReasoning(event.seq, event.data.turn, event.data.step).text += chunk.text
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
        const row = streaming ?? (text ? ensureStreaming(event.seq) : undefined)
        if (row !== undefined) {
          row.time = event.time
          if (text) row.text = text
          row.streaming = false
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
        // Reasoning that led to a tool call is done thinking — fold the
        // preview now, before the tool card grows the transcript past it
        // (see foldLiveReasoning).
        foldLiveReasoning('tool call')
        const card: ChatRow = {
          id: nextRowId,
          kind: 'tool',
          text: '',
          seq: event.seq,
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
        const detail = reason.kind === 'error' ? reason.error.message : ''
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
      case 'todo/write':
        // Whole-list snapshot — latest write wins; log-only UI state.
        state.todos = event.data.todos
        break
      default:
        // Logged preset switch (blank sessions only, issue #8): a transcript
        // marker so a replayed log shows which composition produced the
        // turns after it. Not in dsh-session's typed union — matched here by
        // name, like the other plugin-defined events above.
        if ((event as { type: string }).type === 'agent-preset/selected') {
          const data = event.data as unknown as { agentPreset?: string }
          state.rows.push({
            id: nextRowId,
            kind: 'notice',
            text: t('agent-preset-switched', { preset: data.agentPreset ?? 'unknown' }),
          })
          nextRowId += 1
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
  replayEvents(agent.session.events)
  settleStreaming()
  // Attached to an idle agent: any replayed turn/start belongs to a previous
  // session run, so the spinner must not come up on boot.
  state.working = false
  state.status = agent.status
  state.emit()

  // Live subscription list and activity timer, rebound to every replacement
  // agent so no status from the previous session can leak across a swap.
  let agentSubscriptions: Array<() => void> = []
  let activityTracker = new ActivityTracker({
    phrases: true,
    detailLimit: 40,
    showIdle: false,
  })
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

  const bindAgent = (): void => {
    for (const dispose of agentSubscriptions) dispose()
    stopActivityTick()
    activityTracker = new ActivityTracker({
      phrases: true,
      detailLimit: 40,
      showIdle: false,
    })
    activityTracker.onAgentStatus(agent.status)
    renderWorkingActivity()
    activityTickTimer = setInterval(() => {
      const previous = state.workingActivity
      const rendered = renderWorkingActivity()
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
        activityTracker.onAgentStatus(status)
        renderWorkingActivity()
        state.emit()
      }),
      ctx.on('agent/disposed', ({ agent: subject }) => {
        if (subject !== agent) return
        state.status = 'disposed'
        stopActivityTick()
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
        if (session !== agent.session) return
        // Observation broker (C-042): maps user/message + assistant/message
        // into grant-gated envelopes; every other event type is a no-op, and
        // publish never throws into this arm.
        messageObserver?.publish(session, event)
        activityTracker.onSessionEvent(event)
        renderWorkingActivity()
        // Mode-affecting atoms fold into the Shift+Tab mode indicator the
        // moment they land (whether appended by cycleMode or by hand).
        const eventType = (event as { type: string }).type
        if (eventType === 'plan/mode' || eventType === 'sandbox/mode' || eventType === 'approval/policy') {
          refreshMode()
        }
        renderEvent(event)
        // Streaming deltas (one event per token) take the frame-aligned
        // path; every other event keeps synchronous notification.
        if (event.type === 'assistant/chunk') state.emitStream()
        else state.emit()
      }),
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

/**
 * `@` file listing through the leaf's fs service (dsh-fs-local): skips
 * VCS/dependency/build dirs and rotates across directory listings so one
 * large subtree cannot consume the global MAX_FILES budget. That budget also
 * bounds directory reads without imposing an arbitrary source-tree depth.
 * Relative directories retain the trailing `/` that FileSuggestions expects.
 * Unreadable subtrees are skipped, not fatal.
 */
async function listFilesDeep(
  fs: {
    resolve(path: string): Promise<{ displayPath: string }>
    listDir(target: { displayPath: string }): Promise<
      Array<{
        name: string
        type: 'file' | 'directory' | 'other'
        target: { displayPath: string }
      }>
    >
  } | undefined,
  root: string,
): Promise<string[]> {
  if (!fs) return []
  const out: string[] = []
  const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', '.DS_Store', 'dist'])
  const BUILD_DIR = /^(?:build(?:[-_].*)?|cmake-build(?:[-_].*)?)$/i
  const MAX_FILES = 100

  type Entry = {
    name: string
    type: 'file' | 'directory' | 'other'
    target: { displayPath: string }
  }
  type Directory = {
    dir: string
    prefix: string
    entries?: Entry[]
    index: number
  }
  const directories: Directory[] = [{ dir: root, prefix: '', index: 0 }]

  while (directories.length > 0 && out.length < MAX_FILES) {
    const current = directories.shift()
    if (!current) continue
    if (!current.entries) {
      try {
        const target = await fs.resolve(current.dir)
        current.entries = await fs.listDir(target)
      } catch {
        continue // unreadable subtree — skip
      }
    }

    let entry: Entry | undefined
    while (current.index < current.entries.length) {
      const candidate = current.entries[current.index++]
      if (SKIP.has(candidate.name) || BUILD_DIR.test(candidate.name)) continue
      entry = candidate
      break
    }
    if (!entry) continue
    if (current.index < current.entries.length) directories.push(current)

    const rel = current.prefix ? `${current.prefix}/${entry.name}` : entry.name
    if (entry.type === 'directory') {
      out.push(`${rel}/`)
      directories.push({
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- runtime guard: symlink targets optional
        dir: entry.target?.displayPath ?? join(current.dir, entry.name),
        prefix: rel,
        index: 0,
      })
    } else if (entry.type === 'file') {
      out.push(rel)
    }
  }
  return out
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
    const imageMediaType = mentionImageMediaType(mention.path)
    if (budget <= 0 && imageMediaType === undefined) break
    // Mentions resolve against the session cwd, same as the model-facing fs
    // tools; absolute paths pass through untouched.
    const absolute = isAbsolute(mention.path) ? mention.path : join(cwd, mention.path)
    let target: { displayPath: string }
    let info: { type: 'file' | 'directory' | 'other' } | undefined
    try {
      target = await fs.resolve(absolute)
      info = await fs.stat(target)
    } catch {
      missing.push(mention.path)
      continue
    }
    if (info?.type === 'file') {
      if (imageMediaType !== undefined && attachments !== undefined && fs.readBytes !== undefined) {
        const limits = attachments.imageLimits
        if (!limits.mediaTypes.includes(imageMediaType) || imageCount >= limits.maxImagesPerMessage) {
          missing.push(mention.path)
          continue
        }
        try {
          const data = await fs.readBytes(target, undefined, limits.maxImageBytes)
          if (imageBytes + data.byteLength > limits.maxMessageImageBytes) {
            missing.push(mention.path)
            continue
          }
          const attachment = await attachments.saveImage({
            data,
            mediaType: imageMediaType,
            name: basename(target.displayPath),
          })
          blocks.push({ type: 'image', attachment })
          imageCount += 1
          imageBytes += data.byteLength
          attached.push(mention.path)
        } catch {
          missing.push(mention.path)
        }
        continue
      }
      try {
        const cap = Math.min(MENTION_MAX_FILE_CHARS, budget)
        let content = await fs.readText(target)
        let truncated = false
        if (content.length > cap) {
          content = content.slice(0, cap)
          truncated = true
        }
        budget -= content.length
        blocks.push({
          type: 'text',
          text: `<attached-file path="${mention.path}">\n${content}${truncated ? '\n[… truncated]' : ''}\n</attached-file>`,
        })
        attached.push(mention.path)
      } catch {
        // Binary/undecodable or unreadable — report it like a miss.
        missing.push(mention.path)
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
          text: `<attached-directory path="${mention.path}">\n${body}\n</attached-directory>`,
        })
        attached.push(mention.path)
      } catch {
        missing.push(mention.path)
      }
      continue
    }
    // Absent (stat → undefined) or a special file.
    missing.push(mention.path)
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
