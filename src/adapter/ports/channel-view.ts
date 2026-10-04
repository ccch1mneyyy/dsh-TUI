/** Host-owned in-process Channel contract. No runtime or upstream imports. */


/** Live editor selection projection (IDE selection channel): the editor
 *  buffer's own text when the IDE pushed it (protocol 2 — unsaved edits
 *  included), plus the coordinates. Structurally mirrors the adapter's
 *  SelectionSnapshot without importing from the adapter layer (this port
 *  takes no runtime or upstream imports). */
export interface ChannelSelection {
  /** Workspace-relative or absolute file path, as the extension reports it. */
  readonly path: string
  /** First selected line, 0-based. */
  readonly startLine: number
  /** Last selected line, 0-based inclusive. */
  readonly endLine: number
  /** True when the editor selection collapsed to nothing. */
  readonly isEmpty: boolean
  /**
   * Protocol 2: the editor buffer's own text for the selection, exactly
   * what the user saw. The submit path attaches it verbatim; when absent
   * (protocol-1 push) it falls back to reading the file from disk.
   */
  readonly text?: string
  /** Protocol 2: the editor document version the text came from. */
  readonly documentVersion?: number
}

/** What one consumed selection contributed to a submitted message, recorded
 *  next to the user row so the transcript can render a "Selected N lines
 *  from <file>" indicator. `lines` is the count actually attached after
 *  clamping — the truth the model received, not the request. */
export interface SelectionAttachment {
  readonly lines: number
  /** The path as the extension reported it (absolute or workspace-relative). */
  readonly path: string
}

/**
 * One context a side panel staged into the composer ("Send to Chat", §6.7):
 * the panel row's own title plus the model-facing text. The composer renders
 * a chip per entry above the input row, and the NEXT submission appends the
 * `<attached-context …>` block — the same one-shot consumption the IDE
 * selection channel next door performs (a staged context is spent by the
 * message that carried it).
 */
export interface AttachedContext {
  /** Stable handle minted by the channel (`ctx-N`), used to detach one entry. */
  readonly id: string
  /** Where the context came from. Only panels exist today; the discriminant
   *  is explicit so a future source cannot be mistaken for a panel row. */
  readonly source: 'panel'
  /** Identity of the contributing row INSIDE its panel (a job id, a session
   *  id, …) — paired with `title` it is the replace key. */
  readonly sourceId: string
  /** Human-facing label for the composer chip (e.g. `Job #142`). */
  readonly title: string
  /** Model-facing body, already capped at `MENTION_MAX_FILE_CHARS`. */
  readonly content: string
  /** Length of `content` after the cap — what the model will actually get. */
  readonly chars: number
  /** True when the panel's content exceeded the cap and was cut at attach
   *  time; the block builder then appends the visible `[… truncated]` marker. */
  readonly truncated: boolean
}

/**
 * One working-activity line value a backend publishes for its own session —
 * the wire shape of the DSH `dsh-working-activity` plugin's session
 * projection, which this port mirrors so a backend without that plugin (the
 * Claude backend folds its own) can serve the same working line. Structural
 * copy only: consumers narrow with `asActivityView` before rendering, so a
 * malformed value is dropped rather than shown half-formed.
 */
export interface WorkingActivityView {
  /** Which phase the line is in; `idle` means "render nothing". */
  readonly phase: 'idle' | 'waiting' | 'thinking' | 'tool' | 'done'
  /** The line as the backend rendered it at `updatedAt`. */
  readonly line: string
  /** Whether `line` counts elapsed time (this port publishes settled copy,
   *  so a backend-authored value is `false` unless it re-renders the line). */
  readonly live: boolean
  /** Tool action verb, when the line describes a running tool. */
  readonly label?: string
  /** Tool detail fragment (path / command / pattern), when there is one. */
  readonly detail?: string
  /** The playful phrase or `⏵` self-narration currently shown, when any. */
  readonly phrase?: string
  /** Tools completed in the current turn. */
  readonly toolCount: number
  /** Wall clock the current phase began. */
  readonly phaseStartedAt: number
  /** Wall clock the current turn began (0 when no turn has started). */
  readonly turnStartedAt: number
  /** Timestamp of the last folded event — the value's freshness signal. */
  readonly updatedAt: number
  /** Language the line was rendered in. */
  readonly lang: 'zh' | 'en'
}

/**
 * One rendered transcript row. The DSH session log is the source of truth:
 * rows are derived from `session/event` records (and the initial
 * `agent.session.events` replay), never from optimistic local state.
 */
export interface ChatRow {
  id: number
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'reasoning' | 'interrupt' | 'local' | 'local-output' | 'compact' | 'subagent' | 'job' | 'turn-summary'
  /** Extra label for non-human user rows (e.g. `steering`). */
  label?: string
  /** Actual execution location for `!command` rows. */
  executionTarget?: string
  text: string
  /** Durable session image blocks, loaded lazily through the attachment store. */
  images?: readonly TranscriptImage[]
  /** True while an assistant step is still streaming chunks. */
  streaming?: boolean
  /** Keep a settled reasoning row expanded until the current turn ends. */
  thinkingOpen?: boolean
  /** Present on `tool` rows; the card model. */
  tool?: ToolRow
  /** Present on `turn-summary` rows; the turn's usage ledger. */
  turnUsage?: TurnUsageSummary
  /** Present on `subagent` rows; the subagent state snapshot. */
  subagent?: SubagentRow
  /** Present on `job` rows; the background-job state snapshot. */
  job?: JobRow
  /** Present on `job` rows that share a run of ≥2 consecutive cards: the
   *  group decoration (chain rail + fold summary). Render-derived state:
   *  written only onto shallow copies in the transcript's row pre-pass
   *  (rows may arrive frozen from the session projection), never by the
   *  projection and never on the shared row objects. */
  jobGroup?: JobGroupRow
  /** Event wall-clock time (transcript-mode metadata, assistant rows). */
  time?: number
  /** Present on `reasoning` rows once settled: thinking wall-clock duration. */
  durationMs?: number
  /** Present on `reasoning` rows of a backend that reports thinking only as
   *  an estimated token count (no thinking text): the latest estimate. The
   *  text, when any arrives, still wins over the count. */
  reasoningTokens?: number
  /** Source session event seq — present on every log-derived row (rewind
   *  fork anchor on user rows; window-floor bookkeeping for the rest). */
  seq?: number
  /** The backend's own durable anchor of a row when it is not the row's
   *  `seq`: a `user` row's rewind anchor (a Claude message uuid), an
   *  `assistant`/`reasoning` row's message (a Claude API message id — how
   *  "load earlier" finds the record a folded row came from); absent on DSH
   *  rows, whose anchor is the seq itself. */
  anchor?: string
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
  /** Present on user rows whose submit consumed a live IDE selection: the
   *  transcript renders the "Selected N lines" indicator above the bubble. */
  selectionAttached?: SelectionAttachment
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
export type ToolCallView = ToolViewMeta & (
  | { readonly card: 'generic'; readonly title: string; readonly kind?: string }
  | { readonly card: 'terminal'; readonly title: string; readonly description?: string; readonly cwd?: string }
  | { readonly card: 'diff'; readonly title: string; readonly diffs: readonly ToolFileDiff[] }
)

/**
 * Optional backend decoration of a tool view: the i18n key of the tool's
 * display name (`tool-name-*`; absent = the card localizes the raw tool id)
 * and its colour family (absent = derived from the tool id).
 */
export interface ToolViewMeta {
  readonly displayKey?: string
  readonly category?: 'mutate' | 'exec' | 'other'
}

/** One file change in a tool presentation (dsh-tools FileDiff). */
export interface ToolFileDiff {
  readonly path: string
  /** Prior content, or null for a new file / no before-image. */
  readonly oldText: string | null
  readonly newText: string
}

/** Completed-call render intent (structural subset of dsh-tools
 *  ToolResultView). `web` results and unknown shapes fall back to raw text. */
export type ToolResultView = ToolViewMeta & (
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
)

export interface SubagentRow {
  agentId: string
  runId?: string
  description: string
  /** Durable creation mode from the kernel catalog event; absent before the
   *  parent log's `subagent/catalog` fact arrives (bus-only discovery). */
  mode?: 'one-shot' | 'continuable' | 'unknown'
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
  /** Runs in the background (the delegating call returned at launch). */
  background?: boolean
  /** Spawn nesting: 1 = spawned by the main loop, N+1 = by a depth-N agent. */
  depth?: number
}

export interface SubagentState {
  agentId: string
  runId?: string
  description: string
  /** Durable creation mode from `subagent/catalog` (one-shot burns out;
   *  continuable survives epochs and can take later prompts). */
  mode?: 'one-shot' | 'continuable' | 'unknown'
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
  /** The backend's own tool-count report (`usage.tool_uses`) — preferred
   *  over the locally kept records, which miss lane frames (R6 review). */
  reportedToolUses?: number
  /** The backend's own duration report (`usage.duration_ms`) — free of the
   *  host's receive delay; per run (a resumed run reports its own). */
  reportedDurationMs?: number
  /** The tool the backend last saw the subagent run (`task_progress`). */
  lastTool?: string
  summary?: string
  /** Runs in the background (the delegating call returned at launch). */
  background?: boolean
  /** Spawn nesting: 1 = spawned by the main loop, N+1 = by a depth-N agent. */
  depth?: number
  /** The agent that spawned this child, when the backend stated it as a
   *  fact (Claude resume back-fill: `parent_agent_id` / the delegating
   *  transcript). Absent = parent unknown — depth 1 still proves a
   *  main-loop child, but nothing deeper may be inferred from depth
   *  (agent-team §2: no fake trees). Drives the workbench parent/sibling
   *  panel. */
  parentAgentId?: string
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

/** Output-stream label of one mirrored job line; absent = plain stdout. */
export type BackgroundJobOutputChannel = 'stdout' | 'stderr' | 'log'

/** One mirrored output line. `channel` rides the kernel chunk label
 * (`stderr` renders red, `log` = producer narration the model never sees);
 * `gapBefore` marks bytes lost before this line (ring eviction / producer
 * gap) — the UI renders a dim `…dropped…` banner above it. */
export interface BackgroundJobOutputLine {
  text: string
  channel?: BackgroundJobOutputChannel
  gapBefore?: true
}

/** One background job as a live transcript card (see `kind: 'job'`). */
export interface JobRow {
  id: string
  kind: string
  label: string
  status: BackgroundJobStatus
  detail?: string
  /** Live producer progress line (`3/10`, phase name); cleared at settle. */
  progress?: string
  startedAt: number
  finishedAt?: number
  /** Mirrored output tail feeding the card's three-line waterfall. */
  outputLines: readonly BackgroundJobOutputLine[]
}

/**
 * Group decoration for a run of consecutive background-job cards.
 *
 * A batch of `run_in_background` calls lands as N adjacent cards (the job
 * projection pushes the whole roster in one sync) and each one pays a blank
 * separator line — a pile of near-identical rows for work nobody reads card
 * by card. The transcript therefore reads ≥2 adjacent job rows as ONE group:
 * members drop the blank line between them, share a chain rail on the left,
 * and the group header summarizes the run; once every member settled the
 * whole group folds into that header line alone (click / Ctrl+O expands).
 *
 * Derived state: it rides a per-pass shallow COPY of the row (the shared
 * rows may arrive frozen from the session projection) so BOTH the renderer
 * and the height signature can read it, and it is recomputed from scratch
 * whenever the visible-row window rebuilds.
 */
export interface JobGroupRow {
  /** Group header row: the only member rendering the title/fold line. */
  head: boolean
  /** Last member: closes the rounded rail with a `╰` cap line. */
  last: boolean
  /** Members in the run (≥2 — a lone job card stays ungrouped). */
  count: number
  /** Whole group folded into the header line (meaningful on the head). */
  folded: boolean
  /** Members still live (running + stopping). */
  running: number
  completed: number
  failed: number
  killed: number
  /** Earliest member start. */
  startedAt: number
  /** Latest member finish; absent while any member is still live. */
  endedAt?: number
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
 *   suppress its completion notice. The UI therefore never calls `read()`.
 *   Output mirroring has two tiers: when the kernel event bus is reachable
 *   (`events.subscribe`, present on the real registry) the UI keeps its own
 *   byte cursor and pulls non-consuming `readAt` increments on every
 *   `output` event — live output without the model polling; on kernels
 *   without the bus it falls back to mirroring the agent's own `job_output`
 *   tool results as they stream through the session event log
 *   ({@link BackgroundJobStore.onOutputSeen}).
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

/** 一个模型的峰谷计价桶（与 {@link TokenUsage} 的 peak/idle 同构）。 */
export interface CostTokenBuckets {
  peak: TokenBucket
  idle: TokenBucket
}

/** One completed turn's usage ledger (info-display design §C). Per-turn
 * aggregate of that turn's assistant-message usages — every message reports
 * its OWN request, so the sum is the turn total and never mixes with the
 * cumulative `tokens` (a turn-level report from the backend must not be
 * added on top). Absent wire fields stay absent: `cacheKnown` distinguishes
 * "the route reported zero cache" from "the route reports no cache at
 * all", so the UI never fabricates a zero. */
export interface TurnUsageSummary {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  /** True when any cache field was present on the wire this turn. */
  readonly cacheKnown: boolean
  /** Attempts within the turn that failed and were superseded (API
   * retries) — 0 means no retry segment renders at all. */
  readonly retries: number
  /** turn.start → turn.end wall-clock span (ms). */
  readonly durationMs: number
  /** Model id the turn's last request ran on, when the backend reported
   * one; absent rather than guessed from the session model. */
  readonly model?: string
  /** Reasoning effort the turn's requests pinned, when known. */
  readonly effort?: string
  /** How the turn ended — an interrupted turn's ledger is partial truth
   * and says so. */
  readonly outcome: 'completed' | 'interrupted' | 'error'
}

/**
 * 本会话主会话用量按模型分桶（费用估算输入，见 estimateCostFromBucketsCny）。
 * `channel.tokens` 的语义与既有显示不变；本字段只服务计价，会话中途换模型时
 * 历史用量留在原模型桶，不会被新模型重估。
 */
export interface SessionCostByModel {
  [model: string]: CostTokenBuckets
}

/**
 * 子代理 durable 用量按 (provider, model) 分桶——子代理各自模型不同，价格
 * 也就不同；未计价判定由计价纯函数按 provider/model 完成。
 */
export interface SubagentCostEntry {
  provider: string
  model: string
  buckets: CostTokenBuckets
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

/**
 * The session's in-flight compaction (`/compact`, or the automatic pressure
 * compaction at a turn boundary), as the status row above the prompt renders
 * it. The host exposes no proportional progress: a compaction is one model
 * call between two durable session events, so this carries only what is
 * observable — when the bracket opened, whether that call has started
 * producing output, how much it has produced, and whether this process may
 * abort it.
 */
export interface CompactionStatus {
  /** Wall-clock ms when the compaction bracket opened. */
  readonly startedAt: number
  /** `prefill` until the summarizer's first output chunk: replaying the
   *  conversation prefix is a long silent phase with nothing to count.
   *  `summary` once output is streaming. */
  readonly phase: 'prefill' | 'summary'
  /** Output chars streamed by the compaction model call (see `phase`). */
  readonly outputChars: number
  /** True only for a compaction this process started, so only it may abort. */
  readonly cancellable: boolean
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
  /** Parked channel-side by an interrupt (Esc, Claude Code parity): the
   *  backend dropped its queued copy with the aborted turn, this preview is
   *  the only remaining copy, and nothing delivers it until the user sends
   *  the dock (⏎ / deliverDocked) or retracts it (Alt+↑ / the ↑ editor). */
  docked?: boolean
}

/**
 * Subagent row: displays a subagent's lifecycle (started → running → completed/failed).
 * Derived from agent.task events and history events.
 */
/**
 * One page of a subagent's own transcript (the agent capability's return;
 *  aliased here so the UI port stays free of module imports).
 */
export type SubagentTranscriptView = import('../../agent/capabilities.js').SubagentTranscriptPage
export interface SubagentControl {
  interrupt(agentId: string): boolean
  /** The child's full transcript source (Claude's on-disk child lane).
   *  Absent = this backend has no transcript data (DSH): transcript UI is
   *  not rendered for it — a degraded tail with its retained-range note is
   *  shown instead (design agent-team-panels §2). Null = no such child. */
  history?(agentId: string, window?: import('../../agent/capabilities.js').SubagentTranscriptWindow): Promise<SubagentTranscriptView | null>
  /** The user→agent message capability (design agent-team-full §5): present
   *  only when the bound session's backend actually serves one — the MEMBER's
   *  absence is the signal the composer reads to not render. Backed by real
   *  transports only: Claude's parent-mediated relay, DSH's direct
   *  continuable prompt control plane. */
  message?: AgentMessageControl
}

// ── agent-team unified message domain (design agent-team-full §3) ─────────

/** How one message to an agent travelled (agent-team §3). The transport is a
 *  FACT the backend states, never a guess:
 *  'claude-parent-mediated' — the parent model relays through its own
 *  SendMessage tool (no public child Query send exists);
 *  'dsh-direct-continuable' — the human prompt control plane
 *  (ctx.subagents.prompt) straight into a direct continuable child's inbox,
 *  through the continuation manager;
 *  'dsh-agent-relay' — a model-authored relay between adjacent agents (the
 *  DSH durable AgentMessageSource, form 'relay'). */
export type AgentMessageVia = 'claude-parent-mediated' | 'dsh-direct-continuable' | 'dsh-agent-relay'

/** Delivery state of one message (agent-team §3/§1.4). The fold is monotone:
 *  a view only ever advances, 'unknown' is a legal TERMINAL (no delivery
 *  fact was ever observable), and nothing may be claimed past 'queued'
 *  without an explicit backend fact — an accepted inbox is 'queued', never
 *  read or executed. */
export type AgentMessageState = 'issued' | 'queued' | 'delivered' | 'held' | 'refused' | 'expired' | 'unknown'

/** Neutral identity of one agent in a team (agent-team §3): the stable id
 *  its backend addresses it by (a Claude task/call id, a DSH durable child
 *  session id) plus the presentation facts that are actually known. */
export interface AgentIdentity {
  readonly agentId: string
  readonly parentAgentId?: string
  readonly sessionId?: string
  /** A stable name the parent can address the child by. Absent = no name
   *  addressing: disambiguate by id or hide the submit affordance
   *  (agent-team §2.2). */
  readonly name?: string
  /** Creation label (the delegation's description). */
  readonly label?: string
  readonly mode?: 'one-shot' | 'continuable' | 'unknown'
  readonly status?: SubagentStatus
}

/** One observed or submitted message to an agent (agent-team §3). */
export interface AgentMessageView {
  /** The durable inbox/session message id of the accepted message — NEVER
   *  the local submission id (that is intentId; the two cannot be mixed).
   *  Claude's SendMessage observation has no child inbox id: the parent tool
   *  call id (durable in the parent transcript) names it. */
  readonly messageId: string
  /** The channel-minted submission id, present when this view originated
   *  from a local composer submit (agent-team §5.2's AgentMessageIntent). */
  readonly intentId?: string
  /** Sender: an agent id / session id, the reserved 'user', or absent when
   *  only the lane is known (a parent-lane observation renders as the
   *  parent). */
  readonly from?: string
  /** Target: an agent id / session id, or the name the parent was asked to
   *  address (Claude parent-mediated, before resolution). */
  readonly to?: string
  readonly via: AgentMessageVia
  readonly text: string
  readonly state: AgentMessageState
  /** Back-reference to the fact this view came from: a parent tool call id,
   *  a durable session seq, or a prompt receipt's message id. */
  readonly sourceRef?: string
  readonly observedAt: number
  /** The parent session the observation rode; absent when unknown. */
  readonly parentSessionId?: string
}

/** One composer submission to an agent (agent-team §5.1). */
export interface AgentMessageSubmitInput {
  /** Stable child id (the AgentIdentity the picker chose). */
  readonly targetId: string
  /** Display name, when the transport addresses by name (Claude). */
  readonly targetName?: string
  readonly text: string
  /** Enter = 'queue'; Ctrl+Enter = 'steer' only where the control says so. */
  readonly delivery: 'queue' | 'steer'
  /** Caller cancellation before acceptance. */
  readonly signal?: AbortSignal
}

/** The stable outcome of one submission. ok means the transport ACCEPTED the
 *  message (state names how far the fact goes — never past 'queued' without
 *  a backend fact); the failure reasons are the stable vocabulary the
 *  notices render (no raw provider error text required). */
export type AgentMessageSubmitResult =
  | { readonly ok: true; readonly intentId: string; readonly messageId?: string; readonly state: AgentMessageState }
  | { readonly ok: false; readonly reason: 'not-resumable' | 'unauthorized' | 'delivery-unavailable' | 'parent-unavailable' | 'target-ambiguous' | 'unavailable' | 'cancelled' | 'failed'; readonly message?: string }

/** The user→agent message capability a channel may serve (agent-team §5).
 *  Present only when the backend's transport is real; the composer is not
 *  rendered otherwise (no capability, no UI). */
export interface AgentMessageControl {
  readonly via: AgentMessageVia
  /** Whether steer delivery (Ctrl+Enter) is a real capability here
   *  (agent-team §6.3: DSH direct yes; Claude parent-mediated is always
   *  followup and never interrupts the parent turn). */
  readonly steer: boolean
  /** Addressable children, in roster order. Only children the transport may
   *  actually take (DSH: direct continuable catalog entries; Claude: the
   *  known subagent roster) are listed. Rejects when the backend's roster
   *  read fails — a failed read is never an empty roster. */
  listTargets(): Promise<readonly AgentIdentity[]>
  /** Submit one composer text. Resolves once the transport accepted it or
   *  failed with a stable reason (the draft stays with the caller). */
  submit(input: AgentMessageSubmitInput): Promise<AgentMessageSubmitResult>
  /** Observed relay facts of this session, oldest first (from → to
   *  summaries, the Messages page). Only messages with a real source: a DSH
   *  AgentMessageSource relay or a Claude SendMessage observation. */
  messages(): readonly AgentMessageView[]
}



/** One bounded timeline occurrence of a tracked job (info-display design
 * §D): lifecycle and output-drain observations in arrival order, wall-clock
 * stamped at receipt. The store keeps a bounded ring per job — this is an
 * observation log, not a complete history: entries older than the ring are
 * gone and the panel says "latest" rather than implying completeness. */
export interface JobTimelineEvent {
  readonly kind: 'started' | 'progress' | 'output' | 'gap' | 'stopping' | 'settled'
  readonly at: number
  /** The progress line (progress) or terminal detail (settled), when the
   *  event carries text. */
  readonly text?: string
  /** Bytes observed in this output drain (output events). */
  readonly bytes?: number
  /** The drain's channel label, when the kernel chunk carried one. */
  readonly channel?: BackgroundJobOutputChannel
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
  /** Live producer progress line (`3/10`, phase name); cleared at settle. */
  progress?: string
  startedAt: number
  finishedAt?: number
  /** Last-seen output tail, newest last. Mirrored from the kernel output
   *  ring when its event bus is reachable (non-consuming `readAt` with the
   *  UI's own byte cursor), falling back to `job_output` tool-result tails. */
  outputLines: BackgroundJobOutputLine[]
  /** Epoch ms of the last mirrored output read (receipt time). */
  lastOutputAt?: number
  /** Total output bytes observed through the kernel ring (`output.total`). */
  outputTotalBytes?: number
  /** True when bytes were dropped before the retained tail (ring eviction
   *  or producer gap) — the panel shows the loss banner. */
  outputDropped?: boolean
  /** Producer-retained spill files holding the complete output stream. */
  spillPaths?: readonly string[]
  /** Where the backend writes the job's output (as the backend reported
   *  it); the output tail is read from it while the job is on screen. */
  outputFile?: string
  /** Last producer progress line SEEN (design §D): the live `progress` is
   *  cleared at settle, but the focused detail keeps showing what the
   *  producer last said (with its observation time and the producer kind as
   *  the source) instead of dropping the fact. */
  lastProgress?: string
  /** When `lastProgress` was observed (receipt wall-clock). */
  lastProgressAt?: number
  /** Output discontinuities observed for this job (ring evictions and
   *  producer gaps) — a count, because the bytes behind a gap are gone by
   *  definition and are never estimated. */
  gapCount?: number
  /** Bounded observation timeline (design §D); undefined/empty for jobs
   *  whose history predates the store's lifetime (a resumed roster). */
  timeline?: readonly JobTimelineEvent[]
}

/**
 * Background-job row control (`/jobs` panel): cancellation with the same
 * authority the owning agent itself would use (`job_kill`). Returns false
 * when the jobs service is absent or the job is unknown/foreign.
 */
export interface JobControl {
  kill(id: string): boolean
  /**
   * The job's card or panel entry is on screen: keep its output tail fresh
   * (a backend whose output is read on demand polls at most once a second
   * while watched). Returns the unwatch; absent = the output is pushed.
   */
  watchOutput?(id: string): () => void
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

/** What an adapted paste ended up as, so the composer can report it instead of
 * a re-encode happening silently. Present only when the ingress gate had to
 * change the bytes. Dimensions and media type are the STORE's report for what
 * it persisted (it normalizes further on its own), i.e. what the user gets. */
export interface StagedImageAdjustment {
  /** Media type the bytes were declared with (the pasted file's type). */
  readonly sourceMediaType: ChannelImageMediaType
  /** Media type the store reports for the stored bytes. */
  readonly mediaType: ChannelImageMediaType
  /** Stored pixel dimensions as the store reports them. */
  readonly width: number
  readonly height: number
  /** The stored image is smaller than what the gate handed over. */
  readonly resized: boolean
  /** This gate composited an alpha channel onto an opaque background. */
  readonly flattened: boolean
}

/** Opaque capability returned for one staged composer image. The visible
 * `[Image #N]` label is deliberately absent: PromptInput owns presentation
 * numbering while this id is the non-reusable attachment identity. */
export interface StagedImageHandle {
  readonly stageId: string
  /** How the ingress gate adapted the pasted bytes, when it had to. */
  readonly adjustment?: StagedImageAdjustment
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
   * Another TUI process currently has this session mounted. Two processes
   * driving one session would interleave writes into a single append-only
   * transcript, so the mount is refused rather than raced. `pid` names the
   * holder so a surface can say which terminal owns it; the claim clears on
   * its own once that process exits (see `sessionMounts`).
   */
  | { readonly ok: false; readonly reason: 'occupied'; readonly pid: number }

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

/**
 * One backend-native permission mode (the typed `modes` capability a
 * non-DSH session may declare). The port restates the capability's own
 * {id, label} so the UI layer never imports the agent domain.
 */
export interface BackendModeOption {
  readonly id: string
  readonly name: string
  /** The one-line explanation the picker shows under the name (absent when
   *  the backend declares none). */
  readonly description?: string
}

/**
 * One relay channel profile (the typed `channels` capability a Claude
 * session declares; the store is backends/claude/channels.json). The port
 * restates the capability's own view so the UI layer never imports the
 * agent domain — the picker's rows and the mapping view both render from
 * these entries.
 */
export interface BackendChannelOption {
  readonly id: string
  readonly name: string
  /** Exact requested-id → actual model entries, in file order. */
  readonly models: readonly { readonly from: string; readonly to: string }[]
  /** Tier keyword → actual model entries, in file order (`default` = the
   *  any-model rule). */
  readonly tiers: readonly { readonly tier: string; readonly to: string }[]
  /** The phase-3 connection slice (never a token literal); absent on
   *  mapping-only channels. Equal fingerprints = the same connection, so
   *  the picker can decide restart-vs-refresh without the secret. */
  readonly connection?: {
    readonly baseUrl?: string
    readonly hasToken: boolean
    readonly envKeys: readonly string[]
    readonly fingerprint: string
  }
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

/**
 * Plain readonly capability snapshot of the bound backend session, for UI
 * decisions (which commands to offer, which affordances to render). It is
 * data, never a capability handle: the channel owns the actions.
 */
export interface ChannelCapabilities {
  /** Backend id of the bound session (`dsh`, `claude`, `acp:<agent>`). */
  readonly backendId: string
  /** User-facing backend name (status notices, `cmd-unavailable-backend`). */
  readonly backendLabel: string
  /** Local slash-command names this backend supports (menu, Tab, dispatch). */
  readonly commands: readonly string[]
  /** Queued inputs can be withdrawn synchronously (Alt+Up). */
  readonly retractPending: boolean
  readonly permissions: boolean
  readonly models: boolean
  readonly effort: boolean
  readonly modes: boolean
  readonly compact: boolean
  readonly rewind: boolean
  readonly fork: boolean
  readonly resume: boolean
  readonly subagents: boolean
  readonly tasks: boolean
  readonly mcp: boolean
  /** `/context` reads a backend-measured context report. */
  readonly context: boolean
  /** `/login` signs the backend session in (DSH: the DSH credentials). */
  readonly login: boolean
  /** `/btw` and `/recap` run a side call over the conversation. */
  readonly sideQuery: boolean
  /** `/rename` renames the session. */
  readonly rename: boolean
  /** `/color` keeps a per-session accent. */
  readonly color: boolean
  /** `/channel` manages the backend's relay channel profiles (Claude's
   *  channels.json; false on every other backend, DSH included — the only
   *  flag without the "a DSH session supports everything" shortcut). */
  readonly channels: boolean
  /** `/mcp reconnect|toggle` control the backend's MCP servers (a DSH
   *  session reports status only). */
  readonly mcpControl: boolean
}

/**
 * Cross-backend session identity as the UI sees it. Structurally the Agent
 * Domain's `AgentSessionRef` (src/agent/refs.ts); restated here because the
 * ports never import outside their own directory.
 */
export interface ChannelSessionRef {
  readonly backendId: string
  readonly sessionId: string
}

/** Subscription usage windows (`five_hour`, `seven_day`, …): utilization
 *  0–1 and the reset time (epoch seconds) when known. */
export interface ChannelRateLimit {
  readonly windows: readonly { readonly name: string; readonly utilization: number; readonly resetsAt?: number }[]
}

/** A backend-reported (or locally estimated) session cost. */
export interface ChannelCostReport {
  readonly currency: string
  readonly amount: number
  readonly source: 'backend' | 'estimate'
}

export type AgentStatus = 'idle' | 'running'
export interface LlmModelInfo { provider: string; id: string; name: string; description?: string; inputModalities?: readonly string[] }
export interface LlmProviderInfo { id: string; name: string }
export interface LlmDiscoveredModel { id: string; name?: string; contextWindow?: number; maxTokens?: number }
export type ChannelImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
export interface ChannelSceneMetadata { readonly id: string; readonly title?: string }
export interface RawTrajEvent { readonly type: string; readonly seq: number; readonly time: number; readonly data: unknown }

/**
 * What the channel's trajectory source can honestly report (design doc
 * 「④ 轨迹裁决」): a composition either mounted a trajectory source or it did
 * not — that fact is declared structurally (the backend-neutral core mounts
 * the AgentEvent fold; the DSH extension replaces it with its raw history),
 * never by backendId lookup.
 *
 *   'supported'    a source is mounted and has events (the golden DSH view;
 *                  Claude via the AgentEvent fold);
 *   'empty'        a source is mounted, the session just has no events yet —
 *                  the ONLY state that may promise "data once turns happen";
 *   'unsupported'  no source is mounted at all: surfaces must say THAT
 *                  instead of masquerading as an empty session, promise
 *                  no future data, and keep the fullscreen outlet disabled.
 */
export type TrajectorySource = 'supported' | 'empty' | 'unsupported'

/**
 * The ONE context-occupancy reading every occupancy surface shares: the
 * footer's `ctx` field and its hover detail, the segmented context bar, the
 * working-activity line's `⚠ ctx N%` prefix, `/tokens` + `/status`, and the
 * context-low warning.
 *
 * It is deliberately separate from the last request's billed usage, which stays
 * the source for cache-hit-rate and cost readouts: "what the last request cost"
 * and "how full the window is now" are different questions (see
 * `dsh-adapter/context-occupancy.ts`).
 */
export interface ContextOccupancy {
  /** Tokens the next request would occupy. */
  readonly usedTokens: number
  /** Window to divide by; `undefined` when no route advertised a capacity. */
  readonly contextWindow: number | undefined
  /**
   * Which source answered: `projection` is DSH's own `contextPressure`
   * projection (the number the Web UI shows); `sample` is this TUI's fallback,
   * the last settled request's billed usage, used only when the composition
   * mounts no token meter.
   */
  readonly source: 'projection' | 'sample'
}
