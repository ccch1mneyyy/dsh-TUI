/** Host-owned in-process Channel contract. No runtime or upstream imports. */


/**
 * One rendered transcript row. The DSH session log is the source of truth:
 * rows are derived from `session/event` records (and the initial
 * `agent.session.events` replay), never from optimistic local state.
 */
export interface ChatRow {
  id: number
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'reasoning' | 'interrupt' | 'local' | 'local-output' | 'compact' | 'subagent' | 'job'
  /** Extra label for non-human user rows (e.g. `steering`). */
  label?: string
  /** Actual execution location for `!command` rows. */
  executionTarget?: string
  text: string
  /** Durable session image blocks, loaded lazily through the attachment store. */
  images?: readonly TranscriptImage[]
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

/** Tool-call card state: the presentation of one tool invocation. */
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

/** Pending-call render intent (structural subset of dsh-tools ToolCallView). */
export type ToolCallView =
  | { readonly card: 'generic'; readonly title: string; readonly kind?: string }
  | { readonly card: 'terminal'; readonly title: string; readonly description?: string; readonly cwd?: string }
  | { readonly card: 'diff'; readonly title: string; readonly diffs: readonly ToolFileDiff[] }

/** One file change in a tool presentation (dsh-tools FileDiff). */
export interface ToolFileDiff {
  readonly path: string
  /** Prior content, or null for a new file / no before-image. */
  readonly oldText: string | null
  readonly newText: string
}

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

export interface SubagentState {
  agentId: string
  runId?: string
  description: string
  provider?: string
  model?: string
  effort?: string
  status: SubagentStatus
  startedAt: number
  completedAt?: number
  endedAt?: number
  local?: boolean
  parentSessionId?: string
  sessionId?: string
  stopReason?: string
  error?: string
  /** Compatibility projection for older consumers. */
  output: string[]
  outputEvents: SubagentOutputLine[]
  toolCalls: SubagentToolCall[]
  tokens?: SubagentTokenUsage
  summary?: string
}

/** Unified subagent activity domain model used by the adapter and every view. */

export type SubagentStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'

export interface SubagentOutputLine {
  kind: SubagentOutputKind
  text: string
  at: number
  /** False while the line is still absorbing streaming deltas. */
  settled?: boolean
}

export type SubagentOutputKind = 'text' | 'thinking' | 'tool' | 'error' | 'system'

export interface SubagentToolCall {
  id?: string
  name: string
  status: 'running' | 'completed' | 'failed'
  startedAt: number
  endedAt?: number
  argsPreview?: string
  resultPreview?: string
  error?: string
}

export interface SubagentTokenUsage {
  input?: number
  output?: number
  total?: number
  context?: number
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
 * Background-job projection for the UI (`/jobs` panel, transcript cards,
 * status-line chip, completion toasts).
 *
 * The domain model sits on top of the harness job registry (`ctx.jobs`,
 * `@deepseek-ai/dsh-jobs`). The registry is an optional service the TUI
 * never hard-depends on: channel.ts reaches it through a local structural
 * type ({@link JobsRuntime}), so compositions without the jobs plugin load
 * the UI unchanged with the feature silently off.
 *
 * Two registry rules shape everything here:
 *
 * - `read()` is CONSUMING (one cursor per job) and a terminal read marks the
 *   job reported, which would eat the owning agent's `job_output` delta and
 *   suppress its completion notice. The UI therefore NEVER reads: the
 *   three-line output waterfall on a card is mirrored from the agent's own
 *   `job_output` tool results as they stream through the session event log
 *   ({@link BackgroundJobStore.onOutputSeen}), not polled.
 * - Jobs are process-local and owner-fenced. `list(agent)` returns exactly
 *   the jobs the current conversation owns (plus unowned ones); a job that
 *   disappears while live was teardown-cancelled (owner disposal / session
 *   swap) and is frozen as `killed` so no transcript card ticks forever.
 *
 * @module jobs
 */

/** Terminal / live lifecycle states, mirrored from the registry contract. */
export type BackgroundJobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

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

/** One 计费时段（高峰/空闲）的 token 累计。 */
export interface TokenBucket {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

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

/** In-process working-line snapshot derived from the base session stream. */
export type ActivityStatus = ActivityState

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

/** One entry of the latest todo-list snapshot (mirrors dsh-tool-todo's
 *  `TodoItem`; declared locally so the adapter needn't depend on that plugin). */
export interface TodoPanelItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
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

/** One model-visible tool from the prompt assembly. */
export interface LoadedContextTool {
  readonly name: string
  readonly description: string
}

/** @internal */
/** One user message submitted while the model was working, not yet claimed
 *  by a turn. `steer` lands at the next step boundary of the running turn;
 *  `followup` waits for the turn to end. */
export interface PendingMessage {
  id: string
  text: string
  images: readonly ComposerImageRef[]
  placement: 'steer' | 'followup'
}

/**
 * Subagent row: displays a subagent's lifecycle (started → running → completed/failed).
 * Derived from agent.task events and history events.
 */
export interface SubagentControl {
  interrupt(agentId: string): boolean
}

/** One tracked job as the UI renders it. */
export interface BackgroundJobState {
  id: string
  kind: string
  label: string
  /** The full command that started the job, captured from the originating
   *  tool call's args (`command`/`text`); the registry label is the friendly
   *  description. Absent when the start ack never streamed through (replay
   *  without the tool card, subagent one-shot jobs, …). */
  command?: string
  status: BackgroundJobStatus
  detail?: string
  startedAt: number
  finishedAt?: number
  /** Last-seen output tail (mirrored `job_output` text), newest last. */
  outputLines: string[]
  /** Epoch ms of the last mirrored `job_output` read (receipt time). */
  lastOutputAt?: number
}

/**
 * Background-job row control (`/jobs` panel): cancellation with the same
 * authority the owning agent itself would use (`job_kill`). Returns false
 * when the jobs service is absent or the job is unknown/foreign.
 */
export interface JobControl {
  kill(id: string): boolean
}

export interface StagedImageInput {
  data: Uint8Array
  mediaType: ChannelImageMediaType
  name?: string
  /** Absolute local path the bytes were read from, for the preview card's
   *  path row. Not handed to the attachment store and never persisted. */
  path?: string
}

/** UI-safe facade for one durable image block in the session transcript. */
export interface TranscriptImage {
  readonly id: string
  readonly width: number
  readonly height: number
  readonly name?: string
  /** Verified media type, when the durable reference carries one. */
  readonly mediaType?: string
  /** Stored byte size, when the durable reference carries one. */
  readonly bytes?: number
  /**
   * Absolute local path the bytes were staged from in THIS process: a pasted
   * or dropped file, or the clipboard bitmap's temp export. Display-only and
   * never persisted — the durable event carries a content hash, so images
   * restored from the session log have none.
   */
  readonly path?: string
  read(signal?: AbortSignal): Promise<Uint8Array>
}

/** Opaque capability returned for one staged composer image. The visible
 * `[Image #N]` label is deliberately absent: PromptInput owns presentation
 * numbering while this id is the non-reusable attachment identity. */
export interface StagedImageHandle {
  readonly stageId: string
}

/** One visible composer token bound to its opaque staged-image capability. */
export interface ComposerImageRef {
  readonly token: string
  readonly stageId: string
}

/** Text plus the image capabilities that belong to that exact draft. */
export interface ComposerSubmission {
  readonly text: string
  readonly images?: readonly ComposerImageRef[]
}

/** UI-safe projection of one settled DSH registry command. Keeping the
 * result kind across the adapter boundary lets the composer retain a
 * rejected image draft instead of treating the error text as success. */
export type ExternalCommandOutcome =
  | { readonly kind: 'success'; readonly text: string; readonly consumeDraft: true }
  | { readonly kind: 'error'; readonly text: string; readonly consumeDraft: boolean }

/** The observable outcome of adopting a persisted session. */
export type ResumeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'working' }
  | { readonly ok: false; readonly reason: 'unavailable' }
  | { readonly ok: false; readonly reason: 'cancelled' }
  | { readonly ok: false; readonly reason: 'failed'; readonly error: string }

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

/**
 * Adapter-owned permission roster snapshot. `options` never contains the
 * official `custom` sentinel; it is represented only by `current`.
 */
export interface PermissionPresetSnapshot {
  readonly availability: PermissionPresetAvailability
  readonly options: readonly PermissionPresetOption[]
  readonly current?: PermissionPresetCurrent
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

/** One skill in the live agent's catalog, for the `/skills` picker (issue #204). */
export interface SkillInfo {
  readonly name: string
  readonly description: string
  /** True when `/name` invokes it (it appears in the `/` menu, issue #86). */
  readonly userInvocable: boolean
  /** Discovery source bucket (bundled / user-* / project-* / runtime / …). */
  readonly source: string
}

/** Secret-free credential metadata for configuration and status surfaces. */
export interface CredentialStatus {
  configured: boolean
  source?: string
  writable: boolean
}

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

/**
 * One session's state in the agent view.
 * State vocabulary:
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

/** The observable outcome of dispatching a new background session. */
export type AgentViewDispatchResult =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly reason: 'unavailable' }
  | { readonly ok: false; readonly reason: 'failed'; readonly error: string }

/** The observable outcome of backgrounding the attached session. */
export type BackgroundResult =
  | { readonly ok: true; readonly backgroundedSessionId: string }
  | { readonly ok: false }

export type AgentStatus = 'idle' | 'running'
export interface ActivityState { readonly phase: 'idle' | 'waiting' | 'thinking' | 'tool' | 'done'; readonly line: string; readonly label?: string; readonly detail?: string; readonly phrase?: string; readonly toolCount: number; readonly turnElapsedMs: number; readonly phaseStartedAt: number }
export interface LlmModelInfo { provider: string; id: string; name: string; description?: string; inputModalities?: readonly string[] }
export interface LlmProviderInfo { id: string; name: string }
export interface LlmDiscoveredModel { id: string; name?: string; contextWindow?: number; maxTokens?: number }
export type ChannelImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
export interface ChannelSceneMetadata { readonly id: string; readonly title?: string }
export interface RawTrajEvent { readonly type: string; readonly seq: number; readonly time: number; readonly data: unknown }
