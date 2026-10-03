/**
 * Claude Agent SDK → Agent Domain translator (docs/agent-backend-design.md
 * §4.4–§4.8, §5.1, with the Phase 0 corrections): one pure state machine per
 * session that turns the SDK message stream (including the frames the SDK
 * types do not declare — `command_lifecycle`, `session_state_changed`,
 * `thinking_tokens` estimates, design appendix B) into `AgentEvent`s for the
 * shared projector. No I/O: the session feeds it messages and the inputs it
 * pushed; fixtures feed it recorded JSON.
 *
 * State: the open turn and its step counter, the open attempt (keyed by the
 * API `message.id`; the CLI sends one `assistant` message per content block,
 * all sharing that id), the open tool calls (their presenters need the
 * input), the inputs this session pushed (their text becomes the user row
 * when the CLI confirms them) and the last `system/init` (re-sent every turn;
 * only changes are emitted).
 *
 * Every field is narrowed from `unknown`; an unknown message type or subtype
 * is ignored (debug-logged), never fatal.
 */
import type { AgentEvent, AgentEventOf, AgentEventType, ContentBlockView, ImageRef, PendingItem, SubagentUsage, TurnEndReason, UsageDelta } from '../../agent/events.js'
import type { TodoPanelItem } from '../../adapter/ports/channel-view.js'
import { t } from '../../i18n.js'
import { claudeToolRole, presentClaudeToolCall, presentClaudeToolResult } from './tools.js'

/** How confirmed user inputs become user rows. */
export type ClaudeUserRows =
  /** On `command_lifecycle{started}` (CLI capability `msg_lifecycle_v1`). */
  | 'lifecycle'
  /** On the CLI's `user{isReplay:true}` echo of our message (fallback). */
  | 'replay'

export interface ClaudeTranslatorOptions {
  readonly cwd: string
  readonly userRows: ClaudeUserRows
  /** Wall clock for event times (injected by fixtures for determinism). */
  readonly now?: () => number
  readonly debug?: (message: string) => void
  /**
   * Where a resumed session's numbering continues (design §4.11): the turn
   * and sequence counters the replayed history ended at, and the model it
   * last ran. Live events after a resume must neither reuse a replayed
   * (turn, step) — the projector binds attempts by position — nor a
   * replayed `seq` (settled assistant messages are deduplicated by it).
   */
  readonly start?: { readonly turn: number; readonly seq: number; readonly model?: string
    /** The replayed conversation's task table (replay.ts `taskSeeds()`):
     * seeded as the live table so a resumed TaskUpdate finds its id. */
    readonly tasks?: readonly ClaudeTaskSeed[] }
}

type Rec = Readonly<Record<string, unknown>>
const rec = (value: unknown): Rec | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Rec : undefined
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const arr = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : []

/** User texts the CLI injects that are not human bubbles. */
const INTERRUPT_ECHO = '[Request interrupted by user'
const LOCAL_COMMAND_TAG = /^<local-command-(stdout|stderr|caveat)>/u
const COMMAND_TAG = /^<command-(name|message|args)>/u
/** Abort diagnostics the CLI appends to `result.errors` (never shown). */
const EDE_DIAGNOSTIC = '[ede_diagnostic]'
/** Command output sent as a prompt (`!!` / the CLI's bash mode). */
const BASH_OUTPUT = /^<bash-stdout>\n?([\s\S]*?)\n?<\/bash-stdout>/u
/** A backgrounded command's acknowledgement: where its output goes (the
 *  rest of the line — a path may contain spaces). */
const BACKGROUND_OUTPUT = /Output is being written to: ([^\r\n]+)/u

/**
 * The output path a backgrounded command's acknowledgement names: the rest
 * of its line, cut after `<taskId>.output` (the sentence that follows on the
 * same line is not part of it), else after the first `.output` that ends a
 * word. Undefined when the text names none.
 */
export function backgroundOutputPath(text: string, taskId: string): string | undefined {
  const line = BACKGROUND_OUTPUT.exec(text)?.[1]?.trim()
  if (line === undefined || line === '') return undefined
  const marker = `${taskId}.output`
  const at = line.indexOf(marker)
  if (at !== -1) return line.slice(0, at + marker.length)
  return /^(.+?\.output)(?=[.,;:]?(?:\s|$))/u.exec(line)?.[1]
}

/** The longest lane tool-result text kept (a subagent card shows a one-line
 *  preview; the full output stays in the subagent's own transcript). */
const LANE_RESULT_CHARS = 2000

/** A lane payload cut to {@link LANE_RESULT_CHARS} (never a lone surrogate). */
function clipLane(text: string): string {
  if (text.length <= LANE_RESULT_CHARS) return text
  const code = text.charCodeAt(LANE_RESULT_CHARS - 1)
  return `${text.slice(0, code >= 0xd800 && code <= 0xdbff ? LANE_RESULT_CHARS - 1 : LANE_RESULT_CHARS)}…`
}

/** The user-facing name of a rate-limit window. */
function rateLimitWindow(type: string): string {
  switch (type) {
    case 'five_hour': return t('status-rate-limit-five-hour')
    case 'seven_day': return t('status-rate-limit-seven-day')
    case 'seven_day_opus': return `${t('status-rate-limit-seven-day')} Opus`
    case 'seven_day_sonnet': return `${t('status-rate-limit-seven-day')} Sonnet`
    default: return type === '' ? '?' : type
  }
}

/** A duration until a reset, coarse (`3d 1h`, `2h 5m`, `7m`). */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${rest}m`
  return `${rest}m`
}

/** Longest remembered superseded-update call ids (FIFO; see
 * `supersedePendingUpdates`). */
const MAX_SUPERSEDED_UPDATES = 512

/** A task report's usage (`total_tokens`, `tool_uses`, `duration_ms`). */
function usageOfTask(value: unknown): SubagentUsage | undefined {
  const usage = rec(value)
  if (usage === undefined) return undefined
  const total = num(usage.total_tokens)
  const toolUses = num(usage.tool_uses)
  const durationMs = num(usage.duration_ms)
  if (total === undefined && toolUses === undefined && durationMs === undefined) return undefined
  return { ...(total === undefined ? {} : { total }), ...(toolUses === undefined ? {} : { toolUses }), ...(durationMs === undefined ? {} : { durationMs }) }
}

/**
 * The Claude backend's decision for every Agent Domain event type (checked by
 * `verify:agent-domain`): a new `AgentEvent` variant fails `tsc` here until
 * this backend decides whether it emits it.
 */
export function claudeEmits(type: AgentEventType): boolean {
  switch (type) {
    case 'session.ready':
    case 'session.title':
    case 'session.reset':
    case 'session.status':
    case 'turn.start':
    case 'turn.end':
    case 'step.start':
    case 'step.end':
    case 'user.message':
    case 'pending.changed':
    case 'assistant.attempt.start':
    case 'assistant.delta':
    case 'assistant.message':
    case 'tool.call':
    case 'tool.result':
    case 'tool.progress':
    case 'subagent.start':
    case 'subagent.progress':
    case 'subagent.end':
    case 'task.start':
    case 'task.update':
    case 'task.end':
    case 'tasks.snapshot':
    case 'compaction.start':
    case 'compaction.end':
    case 'context.capacity':
    case 'model.changed':
    case 'mode.changed':
    case 'commands.changed':
    case 'todo.write':
    case 'notice':
    case 'rate-limit':
    // The session's `/color` (prefs-backed, session.ts).
    case 'session.color':
      return true
    // Emitted by the session's permission bridge (permissions.ts), not by
    // this translator: the prompts arrive through `canUseTool`.
    case 'permission.request':
    case 'permission.settled':
    case 'question.request':
    case 'question.settled':
      return true
    // Later phases (effort, context usage) or not a Claude concept (DSH
    // goals, presets, request headers, system prompt text, plugin events,
    // compaction summary progress, task output reads).
    case 'assistant.attempt.end':
    case 'task.output':
    case 'compaction.progress':
    case 'context.usage':
    case 'effort.changed':
    case 'goal.change':
    case 'preset.selected':
    case 'system.prompt':
    case 'request.header':
    case 'custom':
      return false
    default: {
      const unhandled: never = type
      return unhandled
    }
  }
}

/** A pushed input awaiting the CLI's confirmation. */
interface RegisteredInput {
  readonly text: string
  readonly placement: PendingItem['placement'] | 'turn' | 'now'
  /** Images the message carries (facades for the user row). */
  readonly images?: readonly ImageRef[]
}

/** The attempt (one API response) being assembled. */
interface OpenAttempt {
  readonly id: string
  readonly step: number
  readonly model?: string
  reasoning: string
  text: string
  /** Visible TEXT streamed for this attempt (the settled blocks land in
   *  `text` only when the CLI sends the whole assistant message; a streamed
   *  response never does, so the narration window reads this). */
  streamText: string
  /** Blocks received via `assistant` messages. */
  blocks: number
  aborted: boolean
  /** Usage from `message_start` / `assistant` (input side). */
  usage: UsageDelta | undefined
  /** Cumulative output tokens from `message_delta`. */
  outputTokens: number | undefined
  /** Stream block index → tool call (for `input_json_delta`). */
  readonly streamTools: Map<number, string>
}

/** Usage of one API response, in the domain's shape. */
function usageOf(value: unknown): UsageDelta | undefined {
  const usage = rec(value)
  if (usage === undefined) return undefined
  const input = num(usage.input_tokens)
  const output = num(usage.output_tokens)
  const cacheRead = num(usage.cache_read_input_tokens)
  const cacheWrite = num(usage.cache_creation_input_tokens)
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined
  return { input, output, cacheRead, cacheWrite }
}

/** Joined text of a tool_result `content` (string or block array). */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  return arr(content).map(block => {
    const value = rec(block)
    return value?.type === 'text' ? str(value.text) ?? '' : ''
  }).join('')
}

/** The longest working-line narration kept (the ⏵ self-narration line). */
const NARRATION_CHARS = 120

/**
 * The leading ⏵ self-narration line of a streaming reply, when there is
 * one (the narrate contract puts exactly one at the very top; only a COMPLETE
 * first line counts, so a narration still streaming shows nothing yet). The
 * line is flattened and capped — it is model output destined for a status
 * line, never for re-parsing.
 */
function narrationOf(text: string | undefined): string | undefined {
  if (text === undefined || text === '') return undefined
  const newline = text.indexOf('\n')
  if (newline === -1) return undefined
  const first = text.slice(0, newline).trimStart()
  if (!first.startsWith('⏵')) return undefined
  const flat = first.replace(/[\u0000-\u001f\u007f]/gu, '')
  return flat.length <= NARRATION_CHARS ? flat : flat.slice(0, NARRATION_CHARS) + '…'
}

/** First text of a user `message.content` (string or block array). */
function userText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  for (const block of arr(content)) {
    const value = rec(block)
    if (value?.type === 'text') return str(value.text)
  }
  return undefined
}

/**
 * The result text of an answered `AskUserQuestion`, in the shape the shared
 * projector folds into the answered-questionnaire record (the `{answers:
 * [{selected}]}` JSON the DSH `ask_user_question` tool persists, matched to
 * the questions by order). The answers come from the structured result
 * (`answers: {question: text}`) or, failing that, the CLI's
 * `"question"="answer"` sentence; anything unreadable keeps the raw text (a
 * title-only record).
 */
function questionRecordText(input: unknown, structured: unknown, raw: string): string {
  const questions = arr(rec(input)?.questions).map(item => str(rec(item)?.question) ?? '')
  if (questions.length === 0) return raw
  let answers: Rec | undefined = rec(rec(structured)?.answers)
  if (answers === undefined) {
    const parsed: Record<string, string> = {}
    for (const match of raw.matchAll(/"([^"]*)"="([^"]*)"/gu)) parsed[match[1]!] = match[2]!
    answers = parsed
  }
  const found = answers
  if (Object.keys(found).length === 0) return raw
  return JSON.stringify({
    answers: questions.map(question => {
      const value = str(found[question])
      return { selected: value === undefined ? [] : [value] }
    }),
  })
}

/**
 * One task of the CLI's task family (2.1.284+: TaskCreate/TaskUpdate/
 * TaskList/TaskGet replaced TodoWrite for plan tracking), as the todo panel
 * projects it. Keyed by the id the CLI assigned (a TaskCreate result).
 */
interface TrackedTask {
  /** The `subject` line (the panel's content). */
  content: string
  status: TodoPanelItem['status']
  /** The spinner line while in_progress — tracked for parity with the
   *  family's input contract, never emitted (the panel shape is
   *  content/status only, exactly like TodoWrite's path). */
  activeForm?: string
  /** Creation order: the snapshot's row order. */
  seq: number
}

/**
 * One tracked task as a resumed session hands it to its live translator (R2
 * review: the replayed conversation's task table must continue live — a
 * resumed TaskUpdate names an id the replay already tracked; a fresh empty
 * table would silently drop every such update). Serializable: the replay and
 * the live session are two translator instances.
 */
export interface ClaudeTaskSeed {
  readonly id: string
  readonly content: string
  readonly status: TodoPanelItem['status']
  readonly activeForm?: string
  /** Creation order: the snapshot's row order. */
  readonly seq: number
}

/** One optimistic TaskUpdate patch awaiting its result (R6 review, RV
 *  follow-up): only the fields the input named — an unspecified field keeps
 *  whatever the record had when the patch is applied or replayed. */
interface TaskPatch {
  readonly id: string
  readonly subject?: string
  readonly status?: string
  readonly activeForm?: string
  /** The patch's status was 'deleted' (it removes the task). */
  readonly deleted: boolean
}

/** A confirmed-deleted task in the base table: no later stale fact (an old
 *  failure's rollback, a late-arriving older success) may resurrect it. */
interface TaskTombstone { readonly deleted: true }
type TaskBase = TrackedTask | TaskTombstone
const TASK_DELETED: TaskTombstone = { deleted: true }

/**
 * The translator's own state as the working-activity fold reads it (the
 * Claude counterpart of the DSH working-activity plugin's inputs): everything
 * the working line shows, already tracked here, so the fold (activity.ts)
 * re-parses nothing. A snapshot is taken after each translated message.
 */
export interface ClaudeActivityState {
  /** A turn is open (the line works only inside one). */
  readonly turnOpen: boolean
  /** Wall clock the open (or last) turn began (0 before the first). */
  readonly turnStartedAt: number
  /** The newest tool call not yet settled, main lane or subagent lane. */
  readonly openTool: { readonly name: string; readonly input: unknown } | undefined
  /** Tool results settled in the current turn (main lane). */
  readonly toolCount: number
  /** The in_progress tracked task's `activeForm` — the CLI's own spinner
   *  wording, the closest thing to a DSH phrase this backend has. */
  readonly activeForm: string | undefined
  /** The leading `⏵` self-narration line of the streaming reply, if any
   *  (the narrate contract: exactly one, at the very top). */
  readonly narration: string | undefined
}

/** Create one translator; it serves exactly one session's stream. */
export function createClaudeTranslator(options: ClaudeTranslatorOptions) {
  const now = options.now ?? Date.now
  const debug = options.debug ?? (() => undefined)
  let userRows = options.userRows
  let seq = options.start?.seq ?? 0
  let turn = options.start?.turn ?? 0
  let turnOpen = false
  let step = 0
  let stepOpen = false
  let attempt: OpenAttempt | undefined
  /** API message ids already settled (late duplicate blocks are ignored). */
  const settledAttempts = new Set<string>()
  const openCalls = new Map<string, { readonly name: string; readonly input: unknown; readonly turn: number; readonly lane?: string }>()
  const inputs = new Map<string, RegisteredInput>()
  /** Registered inputs the CLI already started whose echo (the user row of
   *  the replay fallback) has not arrived yet. */
  const startedInputs = new Set<string>()
  /** Inputs the channel still shows as queued (pending previews). */
  const pending = new Map<string, PendingItem>()
  /** The last `system/init` command list (re-sent every turn; only changes
   *  are reported). Undefined until the first init. */
  let initCommands: string | undefined
  /** The model and permission mode the session runs, as last confirmed
   *  (init, status frames, `message_start`, or a control request the
   *  session made — see `noteModel` / `noteMode`). */
  let currentModel = options.start?.model ?? ''
  let currentMode: string | undefined
  /** The next synthetic user message is a compaction summary. */
  let summaryExpected = false
  /** A `/compact` this session pushed is in flight (manual trigger). */
  let compactRequested = false
  /** A background task just reported: the CLI's next unprompted turn is the
   *  model reacting to it (a notification turn, not a user turn). */
  let notificationTurnExpected = false
  /**
   * What each started task is, from its `task_started`: a subagent, a
   * background job, or a foreground tool's progress report. Its
   * `task_notification` ends exactly that (a foreground Bash ends nothing —
   * its card settles with the tool result).
   */
  const taskKinds = new Map<string, 'agent' | 'job' | 'foreground'>()
  /** What each task's `task_started` said (a foreground Bash moved to the
   *  background becomes a job then, with this description). */
  const taskInfo = new Map<string, { readonly description: string; readonly callId?: string }>()
  /** The delegating `Agent` call (subagent lane) → its task id, once
   *  `task_started` named it (a stop request needs the task id). */
  const laneTasks = new Map<string, string>()
  /** Where each task writes its output, as the CLI reported it. */
  const outputFiles = new Map<string, string>()
  /** Housekeeping / watcher tasks (`skip_transcript` / `ambient`). */
  const hiddenTasks = new Set<string>()
  /** The last rate-limit state announced (`status:window`): a warning is
   *  said once per state, not on every turn's repeat of it. */
  let rateLimitState: string | undefined
  /** Why the CLI auto-denied a call (`system/permission_denied`), until its
   *  error result lands on the card. */
  const deniedReasons = new Map<string, string>()
  /** The session's plan-tracking tasks (the Task* family), projected onto
   *  the shared todo panel as full `todo.write` snapshots. */
  const trackedTasks = new Map<string, TrackedTask>()
  /** Each task's CONFIRMED base: seeds, create / get / list results, updates
   *  whose results came back successful — never an optimistic write. A
   *  failed update rolls the view back here (with the still-pending patches
   *  re-applied), so a failure can neither hide behind a newer success nor
   *  resurrect a confirmed delete. */
  const taskBases = new Map<string, TaskBase>()
  /** Task creation counter: the snapshots' row order. */
  let taskSeq = 0
  // The resumed conversation's tasks start as the live table (R2 review):
  // each translator owns its own Maps, so two sessions seeded from the same
  // replay never share one.
  for (const seed of options.start?.tasks ?? []) {
    const record: TrackedTask = {
      content: seed.content,
      status: seed.status,
      ...(seed.activeForm === undefined ? {} : { activeForm: seed.activeForm }),
      seq: seed.seq,
    }
    trackedTasks.set(seed.id, record)
    taskBases.set(seed.id, record)
    taskSeq = Math.max(taskSeq, seed.seq)
  }
  /** Wall clock the open (or last) turn began (the activity fold's anchor). */
  let turnTime = 0
  /** Main-lane tool results settled in the open turn (the fold's toolCount). */
  let toolResults = 0
  /** The turn's latest complete ⏵ narration line (survives the attempt
   *  that streamed it — the working line keeps narrating between responses,
   *  like the DSH plugin's freshness window). */
  let narrated: string | undefined

  const nextSeq = (): number => ++seq

  /** The tracked tasks as one full todo snapshot (creation order; a deleted
   *  task is simply absent). */
  const taskSnapshot = (): AgentEventOf<'todo.write'> => ({
    type: 'todo.write',
    items: [...trackedTasks.entries()].sort((a, b) => a[1].seq - b[1].seq).map(([, task]) => ({ content: task.content, status: task.status })),
  })

  /** One optimistic TaskUpdate patch awaiting its result, by its call id
   *  (issue order — a Map iterates in insertion order). */
  const taskPatches = new Map<string, TaskPatch>()
  /** Update call ids whose optimistic patches a later authoritative fact
   *  discarded (a TaskList / TodoWrite result, a conversation reset — RV
   * follow-up): a late SUCCESS for one must not fabricate a task the
   * authority already ruled away, so its result drops whole (no base
   * commit, no unknown-id completion, no recompute). Consumed by its own
   * result; refilled only with the calls still in flight. */
  const supersededUpdates = new Set<string>()
  /** EVERY in-flight TaskUpdate call id — known-patch or UNKNOWN id (a
   *  resumed/compacted table tracks ids the update still names; RV round
   * 4): an authority that rules the table away supersedes these calls too,
   * or their late successes would fabricate tasks through the unknown-id
   * completion. Consumed by the call's own result. */
  const inFlightUpdates = new Set<string>()

  /** Remember one update call as in flight (capped FIFO, like the
   *  superseded set: an evicted call's result has been absent a long
   *  while). */
  const noteInFlightUpdate = (callId: string): void => {
    inFlightUpdates.add(callId)
    if (inFlightUpdates.size > MAX_SUPERSEDED_UPDATES) {
      const oldest = inFlightUpdates.values().next().value
      if (oldest !== undefined) inFlightUpdates.delete(oldest)
    }
  }

  /** Move every in-flight update call id (known patch or unknown id) into
   *  the superseded set — their authority has discarded them. Capped FIFO:
   *  an evicted call's result has been absent a long while, and the cap
   *  keeps a pathological session from growing the set without bound. */
  const supersedePendingUpdates = (): void => {
    for (const callId of inFlightUpdates) {
      supersededUpdates.add(callId)
      if (supersededUpdates.size > MAX_SUPERSEDED_UPDATES) {
        const oldest = supersededUpdates.values().next().value
        if (oldest !== undefined) supersededUpdates.delete(oldest)
      }
    }
    inFlightUpdates.clear()
  }

  /** A patch applied to a record: unspecified fields keep theirs (a delete,
   *  or a patch on nothing, leaves nothing). */
  const applyPatch = (record: TrackedTask | undefined, patch: TaskPatch): TrackedTask | undefined => {
    if (record === undefined || patch.deleted) return undefined
    return {
      content: patch.subject ?? record.content,
      status: panelStatus(patch.status) ?? record.status,
      ...((patch.activeForm ?? record.activeForm) === undefined ? {} : { activeForm: patch.activeForm ?? record.activeForm }),
      seq: record.seq,
    }
  }

  /** The live record of a base entry, if it is one (a tombstone is not). */
  const baseRecord = (base: TaskBase | undefined): TrackedTask | undefined =>
    base !== undefined && 'deleted' in base ? undefined : base

  /** A patch whose result came back successful: it joins the confirmed base
   *  (a delete leaves a tombstone; a patch with no live base — a stale
   *  success after a delete or an authoritative rebuild — commits nothing). */
  const commitPatch = (patch: TaskPatch): void => {
    if (patch.deleted) {
      taskBases.set(patch.id, TASK_DELETED)
      return
    }
    const base = baseRecord(taskBases.get(patch.id))
    if (base === undefined) return
    taskBases.set(patch.id, applyPatch(base, patch) ?? base)
  }

  /** Recompute one task's view — its confirmed base with every still-pending
   *  patch re-applied in issue order — and announce the table when it
   *  changed. This is the rollback (a failure restores the CONFIRMED base,
   *  never a whole-record pre-image: that let failures hide behind newer
   *  successes and resurrect confirmed deletes) and the post-commit refresh
   *  (an earlier rollback may have wiped a patch whose success just landed). */
  const recomputeTask = (out: AgentEvent[], id: string): void => {
    const base = baseRecord(taskBases.get(id))
    let record: TrackedTask | undefined = base === undefined ? undefined : { ...base }
    for (const patch of taskPatches.values()) if (patch.id === id) record = applyPatch(record, patch)
    const current = trackedTasks.get(id)
    if (record === undefined) {
      if (current === undefined) return
      trackedTasks.delete(id)
    } else {
      if (sameTask(current, record)) return
      trackedTasks.set(id, record)
    }
    out.push(taskSnapshot())
  }

  /** Whether two task records already say the same thing (a recompute that
   *  would change nothing emits no snapshot). */
  const sameTask = (a: TrackedTask | undefined, b: TrackedTask): boolean =>
    a !== undefined && a.content === b.content && a.status === b.status && a.activeForm === b.activeForm && a.seq === b.seq

  /** A task status the panel shows (`deleted` is not one — it removes). */
  const panelStatus = (value: unknown): TodoPanelItem['status'] | undefined =>
    value === 'pending' || value === 'in_progress' || value === 'completed' ? value : undefined

  /** The tracked tasks as resume seeds (creation order; see {@link ClaudeTaskSeed}). */
  const taskSeeds = (): readonly ClaudeTaskSeed[] =>
    [...trackedTasks.entries()].sort((a, b) => a[1].seq - b[1].seq).map(([id, task]) => ({
      id,
      content: task.content,
      status: task.status,
      ...(task.activeForm === undefined ? {} : { activeForm: task.activeForm }),
      seq: task.seq,
    }))

  /** A task record from a Task* result (`{id, subject, status}`), narrowed;
   *  undefined when the record is missing or not a panel status. */
  const taskRecord = (value: unknown): { id: string; content: string; status: TodoPanelItem['status'] } | undefined => {
    const task = rec(value)
    const id = str(task?.id)
    const content = str(task?.subject)
    const status = task?.status
    if (id === undefined || content === undefined || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) return undefined
    return { id, content, status }
  }

  const closeStep = (out: AgentEvent[]): void => {
    if (!stepOpen) return
    stepOpen = false
    out.push({ type: 'step.end', turn, step })
  }

  const openTurn = (out: AgentEvent[], origin: AgentEventOf<'turn.start'>['origin'], userMessageId?: string): void => {
    if (turnOpen) return
    turnOpen = true
    turn += 1
    step = 0
    turnTime = now()
    toolResults = 0
    narrated = undefined
    // An unprompted turn right after a task notification is the model
    // reporting on it: a notice stands where a user bubble would be.
    const notified = origin === 'system' && notificationTurnExpected
    notificationTurnExpected = false
    out.push({ type: 'turn.start', turn, origin: notified ? 'notification' : origin, time: now(), ...(userMessageId === undefined ? {} : { userMessageId }) })
    if (notified) out.push({ type: 'notice', level: 'info', text: t('claude-notification-turn') })
  }

  /** Settle the open attempt as one canonical assistant message. */
  const settleAttempt = (out: AgentEvent[]): void => {
    const open = attempt
    if (open === undefined) return
    attempt = undefined
    settledAttempts.add(open.id)
    // A reply that narrated keeps the working line narrating until the turn
    // ends (the fold's freshness window is the turn itself). A streamed
    // response never re-delivers its blocks; the settled message carries them.
    const complete = narrationOf(open.streamText !== '' ? open.streamText : open.text)
    if (complete !== undefined) narrated = complete
    const blocks: ContentBlockView[] = []
    if (open.reasoning !== '' || open.blocks > 0) blocks.push({ type: 'reasoning', text: open.reasoning })
    if (open.text !== '') blocks.push({ type: 'text', text: open.text })
    const usage = open.usage === undefined && open.outputTokens === undefined
      ? undefined
      : { ...open.usage, ...(open.outputTokens === undefined ? {} : { output: open.outputTokens }) }
    out.push({
      type: 'assistant.message',
      seq: nextSeq(),
      anchor: open.id,
      turn,
      step: open.step,
      attemptId: open.id,
      time: now(),
      ...(open.model === undefined ? {} : { model: open.model }),
      blocks,
      ...(usage === undefined ? {} : { usage }),
      ...(open.aborted ? { interrupted: true as const } : {}),
      canonical: true,
    })
  }

  /** Open an attempt for `id` (a new API response), closing the previous one. */
  const ensureAttempt = (out: AgentEvent[], id: string, model: string | undefined, usage: UsageDelta | undefined): OpenAttempt | undefined => {
    if (attempt?.id === id) return attempt
    if (settledAttempts.has(id)) return undefined
    settleAttempt(out)
    openTurn(out, 'system')
    closeStep(out)
    step += 1
    stepOpen = true
    out.push({ type: 'step.start', turn, step })
    out.push({ type: 'assistant.attempt.start', attemptId: id, turn, step, ...(model === undefined ? {} : { model }) })
    // `message_start.model` is the CLI's own confirmation of the model a
    // request ran on (design §4.10): an in-place switch shows up here first.
    if (model !== undefined && model !== '' && currentModel !== '' && model !== currentModel) {
      currentModel = model
      out.push({ type: 'model.changed', model, source: 'settings' })
    }
    attempt = { id, step, model, reasoning: '', text: '', streamText: '', blocks: 0, aborted: false, usage, outputTokens: undefined, streamTools: new Map() }
    return attempt
  }

  const delta = (open: OpenAttempt, value: AgentEventOf<'assistant.delta'>['delta'], index: number): AgentEvent =>
    ({ type: 'assistant.delta', attemptId: open.id, index, time: now(), delta: value })

  /** The user row for a confirmed input (lifecycle `started` / replay echo). */
  const confirmInput = (out: AgentEvent[], uuid: string): void => {
    const input = inputs.get(uuid)
    if (pending.delete(uuid)) out.push({ type: 'pending.changed', items: [...pending.values()], claimed: [uuid] })
    // Started while a turn is open = folded into that turn (Phase 0 P2-1):
    // a user row, no new turn. Only an input this session pushed makes the
    // turn the user's: an unknown uuid (another client's, a CLI-internal
    // command) opens a system turn.
    if (input === undefined) {
      openTurn(out, 'system')
      return
    }
    openTurn(out, 'user', uuid)
    inputs.delete(uuid)
    startedInputs.delete(uuid)
    if (input.text.trim() === '/compact') return
    // A `!!` command's output sent on to the model (or the CLI's own bash
    // mode output): not a bubble — its output row (the channel showed it
    // live; a replay restores it).
    const output = BASH_OUTPUT.exec(input.text)
    if (output !== null) {
      out.push({ type: 'user.message', id: uuid, anchor: uuid, seq: nextSeq(), turn, time: now(), source: 'command-output', text: output[1]!.trim(), blocks: [{ type: 'text', text: input.text }] })
      return
    }
    out.push({ type: 'user.message', id: uuid, anchor: uuid, seq: nextSeq(), turn, time: now(), source: 'user', text: input.text, blocks: [{ type: 'text', text: input.text }], ...(input.images === undefined || input.images.length === 0 ? {} : { images: input.images }) })
  }

  const translateLifecycle = (message: Rec): AgentEvent[] => {
    const uuid = str(message.command_uuid)
    const state = str(message.state)
    if (uuid === undefined || state === undefined) return []
    const out: AgentEvent[] = []
    switch (state) {
      case 'started':
        if (userRows === 'lifecycle') {
          confirmInput(out, uuid)
          break
        }
        // Echo fallback: the echo brings the row, but the turn is already
        // the user's when the input is one this session pushed.
        if (pending.delete(uuid)) out.push({ type: 'pending.changed', items: [...pending.values()], claimed: [uuid] })
        if (inputs.has(uuid)) {
          startedInputs.add(uuid)
          openTurn(out, 'user', uuid)
        }
        break
      case 'cancelled':
      case 'discarded':
      case 'refused':
        inputs.delete(uuid)
        startedInputs.delete(uuid)
        if (pending.delete(uuid)) out.push({ type: 'pending.changed', items: [...pending.values()], discarded: [uuid] })
        if (state === 'refused') out.push({ type: 'notice', level: 'warning', text: t('claude-input-refused') })
        break
      default:
        // `queued` (the channel already shows the preview) / `completed`
        // (the turn closes on `result`).
        break
    }
    return out
  }

  const translateInit = (message: Rec): AgentEvent[] => {
    const model = str(message.model) ?? ''
    const permissionMode = str(message.permissionMode)
    const commands = arr(message.slash_commands).filter((name): name is string => typeof name === 'string')
    const out: AgentEvent[] = []
    if (initCommands === undefined) {
      out.push({
        type: 'session.ready',
        sessionId: str(message.session_id) ?? '',
        cwd: str(message.cwd) ?? options.cwd,
        model,
        ...(permissionMode === undefined ? {} : { permissionMode }),
        ...(str(message.claude_code_version) === undefined ? {} : { backendVersion: str(message.claude_code_version) }),
      })
    } else {
      if (model !== '' && model !== currentModel) out.push({ type: 'model.changed', model, source: 'settings' })
      if (permissionMode !== undefined && permissionMode !== currentMode) out.push({ type: 'mode.changed', modeId: permissionMode })
      if (commands.join('\n') !== initCommands) out.push({ type: 'commands.changed', commands: commands.map(name => ({ name })) })
    }
    initCommands = commands.join('\n')
    if (model !== '') currentModel = model
    if (permissionMode !== undefined) currentMode = permissionMode
    return out
  }

  const translateStream = (message: Rec): AgentEvent[] => {
    const event = rec(message.event)
    const type = str(event?.type)
    if (event === undefined || type === undefined) return []
    const out: AgentEvent[] = []
    switch (type) {
      case 'message_start': {
        const body = rec(event.message)
        const id = str(body?.id)
        if (id !== undefined) ensureAttempt(out, id, str(body?.model), usageOf(body?.usage))
        return out
      }
      case 'content_block_start': {
        const block = rec(event.content_block)
        const index = num(event.index) ?? 0
        const open = attempt
        if (open === undefined || block?.type !== 'tool_use') return out
        const callId = str(block.id)
        const name = str(block.name)
        if (callId === undefined) return out
        open.streamTools.set(index, callId)
        out.push(delta(open, { kind: 'tool-args', callId, partialJson: '', ...(name === undefined ? {} : { name }) }, index))
        return out
      }
      case 'content_block_delta': {
        const open = attempt
        const body = rec(event.delta)
        const index = num(event.index) ?? 0
        if (open === undefined || body === undefined) return out
        switch (str(body.type)) {
          case 'text_delta': {
            const text = str(body.text) ?? ''
            if (text !== '') {
              open.streamText += text
              out.push(delta(open, { kind: 'text', text }, index))
            }
            return out
          }
          case 'thinking_delta': {
            const text = str(body.thinking) ?? ''
            if (text !== '') out.push(delta(open, { kind: 'reasoning', text }, index))
            const estimated = num(body.estimated_tokens)
            if (text === '' && estimated !== undefined) out.push(delta(open, { kind: 'reasoning-tokens', estimated }, index))
            return out
          }
          case 'input_json_delta': {
            const callId = open.streamTools.get(index)
            const partialJson = str(body.partial_json) ?? ''
            if (callId !== undefined && partialJson !== '') out.push(delta(open, { kind: 'tool-args', callId, partialJson }, index))
            return out
          }
          default:
            // signature_delta / citations_delta: nothing to show.
            return out
        }
      }
      case 'message_delta': {
        const open = attempt
        const output = num(rec(event.usage)?.output_tokens)
        if (open !== undefined && output !== undefined) open.outputTokens = output
        return out
      }
      case 'message_stop':
        settleAttempt(out)
        return out
      default:
        return out
    }
  }

  /**
   * The subagent an `Agent` / `Task` call delegates to, pre-created from the
   * call itself (design §4.8: the call arrives before `task_started`): keyed
   * by the call id until `task_started` names the subagent.
   */
  const delegation = (callId: string, input: unknown): AgentEvent => {
    const args = rec(input)
    return {
      type: 'subagent.start',
      agentId: callId,
      parentCallId: callId,
      description: str(args?.description) ?? '',
      ...(str(args?.subagent_type) === undefined ? {} : { kind: str(args?.subagent_type) }),
      ...(str(args?.model) === undefined ? {} : { model: str(args?.model) }),
      background: args?.run_in_background === true,
      time: now(),
    }
  }

  /**
   * A subagent's own traffic (`parent_tool_use_id` = the delegating call,
   * with `forwardSubagentText`): its text and thinking, tool calls and
   * results as child-lane events for its card and panels. The main lane's
   * turn / step / attempt state is never touched; a nested delegation is
   * pre-created like a main-lane one.
   */
  const translateLane = (lane: string, type: string, message: Rec): AgentEvent[] => {
    const body = rec(message.message)
    const out: AgentEvent[] = []
    if (type === 'assistant') {
      const id = str(body?.id) ?? `lane-${seq + 1}`
      const blocks: ContentBlockView[] = []
      for (const raw of arr(body?.content)) {
        const block = rec(raw)
        switch (str(block?.type)) {
          case 'thinking': {
            const text = str(block?.thinking) ?? ''
            if (text !== '') blocks.push({ type: 'reasoning', text })
            break
          }
          case 'text': {
            const text = str(block?.text) ?? ''
            if (text !== '') blocks.push({ type: 'text', text })
            break
          }
          default:
            break
        }
      }
      if (blocks.length > 0) {
        out.push({ type: 'assistant.message', seq: nextSeq(), anchor: id, turn, step, attemptId: id, time: now(), blocks, canonical: false, parentCallId: lane })
      }
      for (const raw of arr(body?.content)) {
        const block = rec(raw)
        if (block?.type !== 'tool_use') continue
        const callId = str(block.id)
        const name = str(block.name)
        if (callId === undefined || name === undefined) continue
        openCalls.set(callId, { name, input: block.input, turn, lane })
        const presentation = presentClaudeToolCall(name, block.input, options.cwd)
        out.push({
          type: 'tool.call',
          seq: nextSeq(),
          anchor: callId,
          turn,
          step,
          callId,
          name,
          argsJson: JSON.stringify(block.input ?? {}),
          parentCallId: lane,
          time: now(),
          ...(presentation === undefined ? {} : { presentation }),
        })
        if (claudeToolRole(name) === 'subagent') out.push(delegation(callId, block.input))
      }
      return out
    }
    if (type === 'user') {
      const results = arr(body?.content).flatMap(raw => rec(raw)?.type === 'tool_result' ? [rec(raw)!] : [])
      // Message-level, as on the main lane: it describes a single result.
      const structured = results.length === 1 ? rec(message.tool_use_result) : undefined
      for (const block of results) {
        const callId = str(block.tool_use_id)
        if (callId === undefined) continue
        const call = openCalls.get(callId)
        openCalls.delete(callId)
        const isError = block.is_error === true
        const fullText = toolResultText(block.content)
        // A lane result only feeds its subagent card (a one-line preview):
        // its payload is cut, so replayed history that lives as long as the
        // session never keeps whole tool outputs.
        const text = clipLane(fullText)
        const presentation = call === undefined ? undefined : presentClaudeToolResult(call.name, call.input, { isError, text, structured: undefined }, options.cwd)
        out.push({
          type: 'tool.result',
          seq: nextSeq(),
          turn,
          step,
          callId,
          isError,
          time: now(),
          content: [{ type: 'text', text }],
          text: isError ? '' : text,
          ...(isError ? { errorText: text } : {}),
          ...(presentation === undefined ? {} : { presentation }),
          parentCallId: lane,
        })
        // A background command a subagent started names its output file in
        // its acknowledgement too.
        const backgroundTask = str(structured?.backgroundTaskId)
        const outputFile = backgroundTask === undefined || isError ? undefined : backgroundOutputPath(fullText, backgroundTask)
        if (backgroundTask !== undefined && outputFile !== undefined) {
          outputFiles.set(backgroundTask, outputFile)
          out.push({ type: 'task.update', taskId: backgroundTask, patch: { outputFile } })
        }
      }
      // The subagent's prompt (its first user text) is not shown.
      return out
    }
    // Streamed partials of a subagent: its settled messages carry the content.
    debug(`claude: subagent stream frame ignored (${lane})`)
    return out
  }

  const translateAssistant = (message: Rec): AgentEvent[] => {
    const body = rec(message.message)
    const id = str(body?.id)
    if (body === undefined || id === undefined) return []
    const out: AgentEvent[] = []
    const open = ensureAttempt(out, id, str(body.model), usageOf(body.usage))
    if (open === undefined) {
      debug(`claude: late block of settled message ${id} ignored`)
      return out
    }
    open.usage ??= usageOf(body.usage)
    if (message.aborted === true) open.aborted = true
    const error = str(message.error)
    if (error !== undefined) out.push({ type: 'notice', level: 'error', text: t('claude-assistant-error', { error }) })
    for (const raw of arr(body.content)) {
      const block = rec(raw)
      if (block === undefined) continue
      open.blocks += 1
      switch (str(block.type)) {
        case 'thinking':
          open.reasoning += str(block.thinking) ?? ''
          break
        case 'redacted_thinking':
          break
        case 'text':
          open.text += str(block.text) ?? ''
          break
        case 'tool_use': {
          const callId = str(block.id)
          const name = str(block.name)
          if (callId === undefined || name === undefined) break
          const input = block.input
          openCalls.set(callId, { name, input, turn })
          // Plan-mode tools render as a mode change and the plan-review
          // panel, never as a card: no call, and their result below only
          // reports the outcome.
          if (claudeToolRole(name) === 'plan') break
          const presentation = presentClaudeToolCall(name, input, options.cwd)
          out.push({
            type: 'tool.call',
            seq: nextSeq(),
            anchor: callId,
            turn,
            step: open.step,
            callId,
            name,
            argsJson: JSON.stringify(input ?? {}),
            time: now(),
            ...(presentation === undefined ? {} : { presentation }),
          })
          if (claudeToolRole(name) === 'subagent') out.push(delegation(callId, input))
          if (claudeToolRole(name) === 'todo') {
            if (name === 'TodoWrite') {
              const todos = arr(rec(input)?.todos).flatMap((item): TodoPanelItem[] => {
                const todo = rec(item)
                const content = str(todo?.content)
                const status = todo?.status
                if (content === undefined || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) return []
                return [{ content, status }]
              })
              out.push({ type: 'todo.write', items: todos })
            } else if (name === 'TaskUpdate') {
              // The input is the patch, applied when the call is seen; the
              // patch itself waits for the result (R6 review: a FAILED
              // update rolls back to the confirmed base — the CLI promises
              // no corrective read).
              const patch = rec(input)
              const id = str(patch?.taskId)
              const known = id === undefined ? undefined : trackedTasks.get(id)
              // Every id-bearing update call is in flight, tracked or not —
              // an authority that empties the table supersedes it all the
              // same (see inFlightUpdates).
              if (id !== undefined) noteInFlightUpdate(callId)
              if (id !== undefined && known !== undefined) {
                const applied: TaskPatch = {
                  id,
                  ...(str(patch?.subject) === undefined ? {} : { subject: str(patch?.subject) }),
                  ...(patch?.status === undefined ? {} : { status: str(patch?.status) }),
                  ...(str(patch?.activeForm) === undefined ? {} : { activeForm: str(patch?.activeForm) }),
                  deleted: patch?.status === 'deleted',
                }
                taskPatches.set(callId, applied)
                // A partial update keeps the fields it does not mention —
                // the CLI's own spinner keeps showing the remembered
                // activeForm, and so does the working line's phrase.
                const updated = applyPatch(known, applied)
                if (updated === undefined) trackedTasks.delete(id)
                else trackedTasks.set(id, updated)
                out.push(taskSnapshot())
              }
            }
            // TaskCreate waits for its result (the id); TaskList/TaskGet have
            // no input-driven effect.
          }
          break
        }
        default:
          break
      }
    }
    // An aborted response gets no message_stop: it settles here with the
    // prefix it streamed.
    if (open.aborted) settleAttempt(out)
    return out
  }

  /** What a settled plan-mode tool means for the transcript and the mode. */
  const planOutcome = (name: string, isError: boolean): AgentEvent[] => {
    if (name === 'EnterPlanMode') {
      if (isError || currentMode === 'plan') return []
      currentMode = 'plan'
      return [{ type: 'mode.changed', modeId: 'plan' }]
    }
    return [{ type: 'notice', level: 'info', text: t(isError ? 'claude-plan-kept' : 'claude-plan-approved') }]
  }

  const translateUser = (message: Rec): AgentEvent[] => {
    const body = rec(message.message)
    const content = body?.content
    const out: AgentEvent[] = []
    const uuid = str(message.uuid)
    // Our own message echoed back (`--replay-user-messages` fallback).
    if (message.isReplay === true && uuid !== undefined && inputs.has(uuid)) {
      if (userRows === 'replay') confirmInput(out, uuid)
      return out
    }
    const results = arr(content).flatMap(raw => {
      const block = rec(raw)
      return block?.type === 'tool_result' ? [block] : []
    })
    if (results.length > 0) {
      // The open attempt is NOT settled here: the CLI drains finished tool
      // results while the same API message is still streaming (parallel
      // calls), so a later block of that message — another tool_use, more
      // text, the closing usage — still belongs to it. It settles on
      // `message_stop`, a new message id, an abort, `result` or a forced
      // close.
      // `tool_use_result` is message-level: it describes the one result of a
      // single-result message and nothing when several share the message.
      const structured = results.length === 1 ? message.tool_use_result : undefined
      for (const block of results) {
        const callId = str(block.tool_use_id)
        if (callId === undefined) continue
        const call = openCalls.get(callId)
        openCalls.delete(callId)
        // A TaskUpdate the CLI refused reports failure in its structured
        // result (`success:false`) without always setting the block's
        // `is_error` (R6 review): the call failed all the same — say so, so
        // the suppressed card's failure path and the rollback both fire.
        const isError = block.is_error === true || (call !== undefined && call.name === 'TaskUpdate' && rec(structured)?.success === false)
        const rawText = toolResultText(block.content)
        if (call !== undefined && claudeToolRole(call.name) === 'plan') {
          out.push(...planOutcome(call.name, isError))
          continue
        }
        // An auto-denied call: its card names the deciding component's reason.
        const denied = deniedReasons.get(callId)
        deniedReasons.delete(callId)
        const text = isError && denied !== undefined && !rawText.includes(denied)
          ? `${rawText}${rawText === '' ? '' : '\n'}${t('claude-denied-reason', { reason: denied })}`
          : call !== undefined && claudeToolRole(call.name) === 'question' && !isError
            ? questionRecordText(call.input, structured, rawText)
            : rawText
        const presentation = call === undefined ? undefined : presentClaudeToolResult(call.name, call.input, { isError, text, structured }, options.cwd)
        out.push({
          type: 'tool.result',
          seq: nextSeq(),
          turn,
          step,
          callId,
          isError,
          time: now(),
          content: typeof block.content === 'string' ? [{ type: 'text', text }] : arr(block.content) as ContentBlockView[],
          text: isError ? '' : text,
          ...(isError ? { errorText: text } : {}),
          ...(structured === undefined ? {} : { structured }),
          ...(presentation === undefined ? {} : { presentation }),
        })
        // Every settled main-lane result is one tool done this turn (the
        // working line's toolCount; plan-mode tools continue'd above).
        toolResults += 1
        // A TaskUpdate result settles its optimistic patch (R6 review, RV
        // follow-up): a failure (`is_error`, or the in-contract
        // `success:false`) rolls the task's view back to its CONFIRMED base
        // — newer successes are already part of that base, so the failure
        // neither hides behind them nor resurrects a confirmed delete; a
        // success commits the patch into the base.
        if (call !== undefined && call.name === 'TaskUpdate') {
          inFlightUpdates.delete(callId)
          if (supersededUpdates.delete(callId)) {
            // An authoritative fact (a List/TodoWrite result, a reset)
            // already discarded this call's optimistic patch: its late
            // result drops whole — the unknown-id completion below is for
            // fresh facts, and committing here would fabricate a task the
            // authority ruled away (RV follow-up).
            debug(`claude: superseded TaskUpdate result dropped (${callId})`)
          } else {
            const applied = taskPatches.get(callId)
            taskPatches.delete(callId)
            if (isError || rec(structured)?.success === false) {
              if (applied !== undefined) recomputeTask(out, applied.id)
            } else if (applied === undefined) {
            // A successful update of an id this table never tracked (R2
            // review): the resumed transcript's structured results can be
            // gone (the read API drops them; a compaction may cut the
            // creating turn away) — the confirmed patch still proves the
            // task exists, so the table completes from the patch itself,
            // naming only the id the patch named (never a guess).
              const patch = rec(call.input)
              const record = rec(structured)
              const id = str(patch?.taskId) ?? str(record?.taskId)
              const status = panelStatus(patch?.status) ?? panelStatus(rec(record?.statusChange)?.to)
              if (id !== undefined && status !== undefined && !trackedTasks.has(id)) {
                const completed: TrackedTask = {
                  content: str(patch?.subject) ?? t('claude-task-unnamed', { id }),
                  status,
                  ...(str(patch?.activeForm) === undefined ? {} : { activeForm: str(patch?.activeForm) }),
                  seq: ++taskSeq,
                }
                trackedTasks.set(id, completed)
                taskBases.set(id, completed)
                out.push(taskSnapshot())
              }
            } else {
              commitPatch(applied)
              // An earlier rollback may have wiped this patch from the view.
              recomputeTask(out, applied.id)
            }
          }
        }
        // A legacy TodoWrite result replaced the CLI's whole plan list (RV
        // follow-up: the WHOLE-list authority): the stale Task* view goes
        // with its patches and bases — leaving it would let a later update
        // of a stale id repaint the panel from a dead table and then empty
        // it (the recompute finds no base). Its pending patches are moot (a
        // later result — success or failure — must not repaint the legacy
        // list either).
        if (call !== undefined && !isError && call.name === 'TodoWrite') {
          supersedePendingUpdates()
          taskPatches.clear()
          taskBases.clear()
          trackedTasks.clear()
        }
        // The task family (2.1.284+): a create's record names the id its
        // call lacked; a list/get result is the authoritative state and
        // overwrites what the inputs built (the CLI owns the tasks).
        if (call !== undefined && !isError && call.name !== 'TodoWrite' && claudeToolRole(call.name) === 'todo') {
          const record = rec(structured)
          if (call.name === 'TaskCreate') {
            // The record carries no status (a fresh task is pending).
            const created = rec(record?.task)
            const id = str(created?.id)
            const content = str(rec(call.input)?.subject) ?? str(created?.subject)
            if (id !== undefined && content !== undefined) {
              const activeForm = str(rec(call.input)?.activeForm)
              const created: TrackedTask = {
                content,
                status: 'pending',
                ...(activeForm === undefined ? {} : { activeForm }),
                seq: ++taskSeq,
              }
              trackedTasks.set(id, created)
              taskBases.set(id, created)
              out.push(taskSnapshot())
            }
          } else if (call.name === 'TaskList') {
            // Only a real list syncs (a missing/malformed result must not
            // clear the panel); an empty list is a legitimate clear.
            if (Array.isArray(record?.tasks)) {
              const next = new Map<string, TrackedTask>()
              for (const item of arr(record?.tasks)) {
                const task = taskRecord(item)
                if (task === undefined) continue
                const known = trackedTasks.get(task.id)
                next.set(task.id, { content: task.content, status: task.status, ...(known?.activeForm === undefined ? {} : { activeForm: known.activeForm }), seq: known?.seq ?? ++taskSeq })
              }
              trackedTasks.clear()
              taskBases.clear()
              for (const [id, task] of next) {
                trackedTasks.set(id, task)
                taskBases.set(id, task)
              }
              // The authoritative list superseded every pending patch: a
              // result arriving after it — failure OR late success — must
              // not move the table off this truth.
              supersedePendingUpdates()
              taskPatches.clear()
              out.push(taskSnapshot())
            }
          } else if (call.name === 'TaskGet') {
            // `task: null` is a not-found: local state stands.
            const task = taskRecord(record?.task)
            if (task !== undefined) {
              const known = trackedTasks.get(task.id)
              const fetched: TrackedTask = { content: task.content, status: task.status, ...(known?.activeForm === undefined ? {} : { activeForm: known.activeForm }), seq: known?.seq ?? ++taskSeq }
              trackedTasks.set(task.id, fetched)
              taskBases.set(task.id, fetched)
              out.push(taskSnapshot())
            }
          }
        }
        // A backgrounded command's acknowledgement names its output file
        // (`task_started` does not): the job's output tail is read from it.
        const backgroundTask = str(rec(structured)?.backgroundTaskId)
        const outputFile = backgroundTask === undefined || isError ? undefined : backgroundOutputPath(rawText, backgroundTask)
        if (backgroundTask !== undefined && outputFile !== undefined) {
          outputFiles.set(backgroundTask, outputFile)
          out.push({ type: 'task.update', taskId: backgroundTask, patch: { outputFile } })
        }
      }
      return out
    }
    const text = userText(content)?.trim()
    if (text === undefined || text === '') return out
    // Abort echoes and local-command transcript records are not bubbles.
    if (text.startsWith(INTERRUPT_ECHO) || LOCAL_COMMAND_TAG.test(text) || COMMAND_TAG.test(text)) return out
    if (message.isSynthetic === true && summaryExpected) {
      summaryExpected = false
      out.push({ type: 'user.message', id: uuid ?? `summary-${seq + 1}`, anchor: uuid ?? '', seq: nextSeq(), turn, time: now(), source: 'compaction', text, blocks: [{ type: 'text', text }] })
      return out
    }
    const origin = str(rec(message.origin)?.kind)
    if (origin !== undefined && origin !== 'human') {
      // A system-originated prompt (task notification, peer, channel): not
      // a human bubble; the turn start already says what happened.
      debug(`claude: ${origin} prompt not projected as a bubble`)
      return out
    }
    debug(`claude: unconfirmed user text not projected (${text.slice(0, 40)})`)
    return out
  }

  /** `result`: the authoritative turn close. */
  const translateResult = (message: Rec): AgentEvent[] => {
    const out: AgentEvent[] = []
    settleAttempt(out)
    closeStep(out)
    const subtype = str(message.subtype)
    const terminal = str(message.terminal_reason)
    const isError = message.is_error === true
    // Phase 0 correction: a `now`-interrupted turn is `subtype:'success'` with
    // `terminal_reason:'aborted_*'` — the terminal reason decides first.
    let reason: TurnEndReason
    if (terminal === 'aborted_streaming' || terminal === 'aborted_tools') reason = { kind: 'aborted' }
    else if (subtype === 'error_max_turns' || subtype === 'error_max_budget_usd' || subtype === 'error_max_structured_output_retries') reason = { kind: 'blocked', detail: subtype }
    else if (subtype === 'success' && !isError) reason = { kind: 'completed' }
    else {
      const errors = arr(message.errors).filter((line): line is string => typeof line === 'string' && !line.startsWith(EDE_DIAGNOSTIC))
      const text = str(message.result) ?? errors.join('\n')
      reason = { kind: 'error', message: text === '' ? (subtype ?? 'error') : text }
    }
    const modelUsage = rec(message.modelUsage)
    // The largest window any model of the turn reported (the main model's;
    // a smaller subagent model never shrinks it).
    const windows = Object.values(modelUsage ?? {}).map(value => num(rec(value)?.contextWindow) ?? 0)
    const contextWindow = Math.max(0, ...windows)
    if (contextWindow > 0) out.push({ type: 'context.capacity', contextWindow })
    const cost = num(message.total_cost_usd)
    if (turnOpen) {
      turnOpen = false
      out.push({
        type: 'turn.end',
        turn,
        reason,
        time: now(),
        ...(cost === undefined ? {} : { cost: { currency: 'USD', amount: cost, source: 'backend' as const } }),
      })
    }
    compactRequested = false
    return out
  }

  /** A background job's start: its command from the launching call when
   *  that was a shell command. */
  const jobStart = (taskId: string, taskType: string | undefined): AgentEvent => {
    const hidden = hiddenTasks.has(taskId)
    const info = taskInfo.get(taskId)
    const call = info?.callId === undefined ? undefined : openCalls.get(info.callId)
    const command = call === undefined ? undefined : str(rec(call.input)?.command)
    const kind = taskType === 'local_bash' ? 'shell' : taskType === 'local_workflow' ? 'workflow' : taskType === 'monitor' || taskType === 'local_monitor' ? 'monitor' : taskType ?? 'task'
    const outputFile = outputFiles.get(taskId)
    return {
      type: 'task.start',
      taskId,
      kind,
      description: info?.description ?? '',
      ...(command === undefined ? {} : { command }),
      ...(info?.callId === undefined ? {} : { callId: info.callId }),
      background: true,
      ...(outputFile === undefined ? {} : { outputFile }),
      ...(hidden ? { hidden: true } : {}),
      time: now(),
    }
  }

  /**
   * A subscription limit warning (`allowed_warning`) or refusal (`rejected`)
   * as a notice, once per state (the CLI repeats the event every turn);
   * `allowed` re-arms it.
   */
  const rateLimitNotice = (info: Rec | undefined): AgentEvent[] => {
    const status = str(info?.status)
    const type = str(info?.rateLimitType) ?? ''
    const state = `${status ?? ''}:${type}`
    if (status !== 'allowed_warning' && status !== 'rejected') {
      rateLimitState = undefined
      return []
    }
    if (state === rateLimitState) return []
    rateLimitState = state
    const window = rateLimitWindow(type)
    const resetsAt = num(info?.resetsAt)
    const resets = resetsAt === undefined ? '' : t('claude-rate-limit-resets', { time: t('claude-rate-limit-in', { duration: formatDuration(resetsAt * 1000 - now()) }) })
    if (status === 'rejected') return [{ type: 'notice', level: 'error', key: 'rate-limit', text: t('claude-rate-limit-rejected', { window, resets }) }]
    const utilization = num(info?.utilization)
    return [{ type: 'notice', level: 'warning', key: 'rate-limit', text: t('claude-rate-limit-warning', { window, percent: utilization === undefined ? '?' : Math.round(utilization * 100), resets }) }]
  }

  const translateSystem = (message: Rec): AgentEvent[] => {
    const subtype = str(message.subtype)
    switch (subtype) {
      case 'init':
        return translateInit(message)
      case 'status': {
        const out: AgentEvent[] = []
        const status = message.status
        if (status === 'requesting') openTurn(out, 'system')
        if (status === 'compacting') out.push({ type: 'compaction.start', trigger: compactRequested ? 'manual' : 'auto', cancellable: false, time: now() })
        if (message.compact_result === 'failed') out.push({ type: 'compaction.end', ok: false, error: str(message.compact_error) ?? '', time: now() })
        const mode = str(message.permissionMode)
        if (mode !== undefined && mode !== currentMode) {
          currentMode = mode
          out.push({ type: 'mode.changed', modeId: mode })
        }
        return out
      }
      case 'compact_boundary': {
        const meta = rec(message.compact_metadata)
        summaryExpected = true
        return [{
          type: 'compaction.end',
          ok: true,
          ...(num(meta?.pre_tokens) === undefined ? {} : { preTokens: num(meta?.pre_tokens) }),
          ...(num(meta?.post_tokens) === undefined ? {} : { postTokens: num(meta?.post_tokens) }),
          time: now(),
        }]
      }
      case 'thinking_tokens': {
        const open = attempt
        const estimated = num(message.estimated_tokens)
        if (open === undefined || estimated === undefined) return []
        return [delta(open, { kind: 'reasoning-tokens', estimated }, 0)]
      }
      case 'session_state_changed': {
        const state = message.state
        if (state === 'running') return [{ type: 'session.status', status: 'running' }]
        if (state === 'requires_action') return [{ type: 'session.status', status: 'requires-action' }]
        if (state !== 'idle') return []
        // `idle` is the backstop for a turn that never got its `result`.
        const out: AgentEvent[] = []
        if (turnOpen) out.push(...forceCloseTurn({ kind: 'aborted' }))
        out.push({ type: 'session.status', status: 'idle' })
        return out
      }
      case 'task_started': {
        const taskId = str(message.task_id)
        if (taskId === undefined) return []
        const taskType = str(message.task_type)
        const background = message.is_backgrounded === true
        const description = str(message.description) ?? ''
        const callId = str(message.tool_use_id)
        taskInfo.set(taskId, { description, ...(callId === undefined ? {} : { callId }) })
        // Housekeeping / watcher tasks are not activity: no card, no chip,
        // no toast (the CLI says to keep them out of the transcript and the
        // activity indicators).
        if (message.skip_transcript === true || message.ambient === true) hiddenTasks.add(taskId)
        if (taskType === 'local_agent' || str(message.subagent_type) !== undefined) {
          taskKinds.set(taskId, 'agent')
          if (callId !== undefined) laneTasks.set(callId, taskId)
          const depth = num(message.spawn_depth)
          // Completes the subagent the `Agent` call pre-created (same lane).
          return [{ type: 'subagent.start', agentId: taskId, ...(callId === undefined ? {} : { parentCallId: callId }), description, ...(str(message.subagent_type) === undefined ? {} : { kind: str(message.subagent_type) }), background, ...(depth === undefined ? {} : { depth }), time: now() }]
        }
        // Phase 0 correction: a foreground Bash that runs ~3s also reports
        // `task_started{is_backgrounded:false}` — not a background job.
        if (!background) {
          taskKinds.set(taskId, 'foreground')
          return []
        }
        taskKinds.set(taskId, 'job')
        return [jobStart(taskId, taskType)]
      }
      case 'task_progress': {
        const taskId = str(message.task_id)
        if (taskId === undefined) return []
        const summary = str(message.summary)
        // A backgrounded job's progress is its one-line status.
        if (taskKinds.get(taskId) === 'job') return summary === undefined ? [] : [{ type: 'task.update', taskId, patch: { progress: summary } }]
        const usage = usageOfTask(message.usage)
        return [{
          type: 'subagent.progress',
          agentId: taskId,
          ...(summary === undefined ? {} : { summary }),
          ...(str(message.last_tool_name) === undefined ? {} : { lastTool: str(message.last_tool_name) }),
          ...(usage === undefined ? {} : { usage }),
        }]
      }
      case 'task_updated': {
        const taskId = str(message.task_id)
        const patch = rec(message.patch)
        if (taskId === undefined || patch === undefined) return []
        const out: AgentEvent[] = []
        const kind = taskKinds.get(taskId)
        if (patch.is_backgrounded === true) {
          // A foreground Bash moved to the background is a job from now on;
          // a foreground subagent moved there runs in the background.
          if (kind === 'foreground') {
            taskKinds.set(taskId, 'job')
            out.push(jobStart(taskId, 'local_bash'))
          } else if (kind === 'agent') {
            const info = taskInfo.get(taskId)
            out.push({ type: 'subagent.start', agentId: taskId, ...(info?.callId === undefined ? {} : { parentCallId: info.callId }), description: '', background: true, time: now() })
          }
        }
        // A subagent ends with its notification (summary, usage); the status
        // patch before it adds nothing. A foreground tool's task is its card.
        const status = str(patch.status)
        if (status === undefined || taskKinds.get(taskId) !== 'job') return out
        const mapped = status === 'running' || status === 'pending' || status === 'completed' || status === 'failed' ? status : status === 'killed' || status === 'stopped' ? 'stopped' : undefined
        if (mapped !== undefined) out.push({ type: 'task.update', taskId, patch: { status: mapped, ...(str(patch.error) === undefined ? {} : { error: str(patch.error) }) } })
        return out
      }
      case 'task_notification': {
        const taskId = str(message.task_id)
        const status = str(message.status)
        if (taskId === undefined) return []
        const summary = str(message.summary)
        const done = status === 'failed' ? 'failed' : status === 'stopped' ? 'stopped' : 'completed'
        // A task never seen starting (missed frame): a usage block is what
        // only subagent reports carry.
        const kind = taskKinds.get(taskId) ?? (message.usage === undefined ? 'job' : 'agent')
        const hidden = hiddenTasks.delete(taskId) || message.skip_transcript === true || message.ambient === true
        taskKinds.delete(taskId)
        taskInfo.delete(taskId)
        if (kind === 'foreground') return []
        // A foreground tool's task report arrives inside its own turn; only a
        // report between turns starts the CLI's notification turn (never a
        // housekeeping task's).
        if (!turnOpen && !hidden) notificationTurnExpected = true
        const usage = usageOfTask(message.usage)
        const outputFile = str(message.output_file)
        if (outputFile !== undefined && outputFile !== '') outputFiles.set(taskId, outputFile)
        return kind === 'agent'
          ? [{ type: 'subagent.end', agentId: taskId, status: done === 'stopped' ? 'cancelled' : done, ...(summary === undefined ? {} : { summary }), ...(usage === undefined ? {} : { usage }), time: now() }]
          : [{ type: 'task.end', taskId, status: done, ...(summary === undefined ? {} : { summary }), ...(outputFile === undefined || outputFile === '' ? {} : { outputFile }), time: now() }]
      }
      case 'background_tasks_changed': {
        const ids = arr(message.tasks).flatMap(item => {
          const id = str(rec(item)?.task_id) ?? str(rec(item)?.id)
          return id === undefined ? [] : [id]
        })
        return [{ type: 'tasks.snapshot', taskIds: ids }]
      }
      case 'permission_denied': {
        const callId = str(message.tool_use_id)
        const reason = str(message.decision_reason) ?? str(message.message) ?? ''
        if (callId !== undefined && reason !== '' && openCalls.has(callId)) deniedReasons.set(callId, reason)
        return [{
          type: 'notice',
          level: 'warning',
          text: reason === '' ? t('claude-permission-denied', { tool: str(message.tool_name) ?? '' }) : t('claude-permission-denied-reason', { tool: str(message.tool_name) ?? '', reason }),
          ...(callId === undefined ? {} : { callId, key: `permission-denied:${callId}` }),
        }]
      }
      case 'api_retry': {
        // One passing toast, replaced attempt by attempt (same key).
        const status = num(message.error_status)
        return [{
          type: 'notice',
          level: 'notice',
          key: 'api-retry',
          text: t('claude-api-retry', { attempt: String(num(message.attempt) ?? '?'), max: String(num(message.max_retries) ?? '?'), detail: status === undefined ? '' : t('claude-api-retry-status', { status }) }),
        }]
      }
      case 'informational': {
        // Levels (SDK): `info` is transcript-only, `notice` a quiet gray
        // line — both a row here; `suggestion` a toast; `warning` both.
        // A tool use's progress messages share a key (deduplicated).
        const text = str(message.content) ?? str(message.message) ?? str(message.text)
        if (text === undefined || text.trim() === '') return []
        const level = str(message.level)
        const toolUse = str(message.tool_use_id)
        return [{
          type: 'notice',
          level: level === 'warning' || level === 'error' ? 'warning' : level === 'suggestion' ? 'notice' : 'info',
          text,
          ...(toolUse === undefined ? {} : { key: `informational:${toolUse}` }),
        }]
      }
      case 'notification': {
        // The REPL notification queue: `low` a row, `medium` a toast,
        // `high` / `immediate` a warning; the CLI's key dedupes.
        const text = str(message.text) ?? str(message.message) ?? str(message.content)
        if (text === undefined || text.trim() === '') return []
        const priority = str(message.priority)
        const key = str(message.key)
        return [{
          type: 'notice',
          level: priority === 'high' || priority === 'immediate' ? 'warning' : priority === 'medium' ? 'notice' : 'info',
          text,
          ...(key === undefined || key === '' ? {} : { key: `notification:${key}` }),
        }]
      }
      case 'memory_recall': {
        // The CLI's "Recalled from memory" line, as a transcript row.
        const memories = arr(message.memories)
        if (memories.length === 0) return []
        return [{
          type: 'notice',
          level: 'info',
          key: 'memory-recall',
          text: message.mode === 'synthesize' ? t('claude-memory-synthesized') : t('claude-memory-recalled', { count: memories.length }),
        }]
      }
      case 'elicitation_complete':
        // The session closes the URL elicitation it names (dialogs.ts).
        return []
      case 'local_command_output': {
        const text = str(message.content) ?? str(message.output)
        return text === undefined || text === '' ? [] : [{ type: 'notice', level: 'info', text }]
      }
      case 'session_title_changed': {
        const title = str(message.title)
        return title === undefined ? [] : [{ type: 'session.title', title, source: 'auto' }]
      }
      case 'commands_changed': {
        const commands = arr(message.commands).flatMap(item => {
          const name = typeof item === 'string' ? item : str(rec(item)?.name)
          return name === undefined ? [] : [{ name }]
        })
        return [{ type: 'commands.changed', commands }]
      }
      case 'model_refusal_fallback': {
        const model = str(message.fallback_model) ?? str(message.model)
        if (model === undefined) return []
        const original = str(message.original_model) ?? currentModel
        const category = str(message.api_refusal_category)
        // `local`: only a subagent / side question fell back; the session
        // model is unchanged.
        if (message.scope === 'local') return [{ type: 'notice', level: 'info', key: 'model-fallback-local', text: t('claude-model-fallback-local', { model, original }) }]
        const out: AgentEvent[] = []
        if (model !== currentModel) {
          currentModel = model
          out.push({ type: 'model.changed', model, source: 'fallback' })
        }
        out.push({ type: 'notice', level: 'warning', key: 'model-fallback', text: t('claude-model-fallback', { model, original, category: category === undefined || category === '' ? '' : t('claude-refusal-category-suffix', { category }) }) })
        return out
      }
      case 'model_refusal_no_fallback': {
        const model = str(message.original_model) ?? currentModel
        const category = str(message.api_refusal_category)
        return [{ type: 'notice', level: 'warning', key: 'model-refusal', text: t('claude-model-refused', { model, category: category === undefined || category === '' ? '' : t('claude-refusal-category-suffix', { category }) }) }]
      }
      default:
        debug(`claude: system/${subtype ?? '?'} ignored`)
        return []
    }
  }

  /** Close an open turn without a `result` (idle backstop, forced settle,
   *  process death). */
  function forceCloseTurn(reason: TurnEndReason): AgentEvent[] {
    const out: AgentEvent[] = []
    settleAttempt(out)
    closeStep(out)
    if (turnOpen) {
      turnOpen = false
      out.push({ type: 'turn.end', turn, reason, time: now() })
    }
    return out
  }

  /**
   * The conversation this translator tracked is gone (R2 review): the CLI
   * continues under a new session id with a cleared context, so the old
   * conversation's plan-tracking tasks, its pending optimistic patches, its
   * unsettled main-lane tool contexts and its expectation markers must not
   * leak into the new one (the CLI reuses short task ids, so a stale table
   * could even mismatch a fresh TaskCreate). Kept: the queued-inputs
   * contract (inputs this session pushed still run), the monotonic turn /
   * seq numbering (the projector binds by position), and the identities of
   * unended background process tasks — a backgrounded command or subagent
   * outlives the reset and its notification still arrives.
   */
  const resetConversation = (): void => {
    trackedTasks.clear()
    taskBases.clear()
    taskSeq = 0
    // The old conversation's in-flight updates (known patch or unknown
    // id) are superseded — a result that raced the reset must not
    // fabricate a task in the new conversation; the set itself starts
    // fresh, only those in-flight calls riding along (capped).
    supersededUpdates.clear()
    supersedePendingUpdates()
    taskPatches.clear()
    for (const [callId, call] of openCalls) if (call.lane === undefined) openCalls.delete(callId)
    deniedReasons.clear()
    settledAttempts.clear()
    summaryExpected = false
    compactRequested = false
    notificationTurnExpected = false
    narrated = undefined
    toolResults = 0
    // Foreground tasks of the old conversation are gone with it (their
    // notification never comes); background ones keep their identity.
    for (const [taskId, kind] of [...taskKinds]) {
      if (kind !== 'foreground') continue
      taskKinds.delete(taskId)
      taskInfo.delete(taskId)
      hiddenTasks.delete(taskId)
      for (const [callId, laneTask] of [...laneTasks]) if (laneTask === taskId) laneTasks.delete(callId)
    }
  }

  /** Translate one SDK message (declared or not). */
  const translate = (raw: unknown): readonly AgentEvent[] => {
    const message = rec(raw)
    const type = str(message?.type)
    if (message === undefined || type === undefined) return []
    // A subagent's lane: its own events, never the main transcript's.
    const lane = str(message.parent_tool_use_id)
    if (lane !== undefined && (type === 'assistant' || type === 'user' || type === 'stream_event')) return translateLane(lane, type, message)
    switch (type) {
      case 'command_lifecycle':
        return translateLifecycle(message)
      case 'system':
        return translateSystem(message)
      case 'stream_event':
        return translateStream(message)
      case 'assistant':
        return translateAssistant(message)
      case 'user':
        return translateUser(message)
      case 'result':
        return translateResult(message)
      case 'tool_progress': {
        const callId = str(message.tool_use_id)
        if (callId === undefined || message.heartbeat === true) return []
        return [{ type: 'tool.progress', callId, elapsedMs: (num(message.elapsed_time_seconds) ?? 0) * 1000, ...(lane === undefined ? {} : { parentCallId: lane }) }]
      }
      case 'rate_limit_event': {
        const info = rec(message.rate_limit_info)
        const windows = Object.entries(rec(info?.unifiedWindows) ?? {}).flatMap(([name, value]) => {
          const utilization = num(rec(value)?.utilization)
          return utilization === undefined ? [] : [{ name, utilization, ...(num(rec(value)?.resetsAt) === undefined ? {} : { resetsAt: num(rec(value)?.resetsAt) }) }]
        })
        return [{ type: 'rate-limit', info: { windows } }, ...rateLimitNotice(info)]
      }
      case 'auth_status': {
        // Progress output is the CLI's own sign-in flow (none in headless
        // use); only an error is the user's business.
        const error = str(message.error)
        return error === undefined || error.trim() === '' ? [] : [{ type: 'notice', level: 'error', key: 'auth-status', text: t('claude-auth-status-error', { error }) }]
      }
      case 'conversation_reset': {
        // Close whatever the old conversation left open first (an aborted
        // turn.end before the reset clears the working line; the channel's
        // reset then drops the row it would append), then drop its state.
        const out = forceCloseTurn({ kind: 'aborted' })
        resetConversation()
        out.push({ type: 'session.reset', trigger: str(message.trigger) ?? 'reset' })
        return out
      }
      default:
        debug(`claude: ${type} ignored`)
        return []
    }
  }

  return {
    translate,
    forceCloseTurn,
    /** A pushed input: its text becomes the user row once the CLI confirms
     *  it; a queued placement is a pending preview until then. */
    registerInput(uuid: string, text: string, placement: RegisteredInput['placement'], images?: readonly ImageRef[]): void {
      inputs.set(uuid, { text, placement, ...(images === undefined || images.length === 0 ? {} : { images }) })
      if (placement === 'steer' || placement === 'followup') pending.set(uuid, { id: uuid, text, placement })
      if (text.trim() === '/compact') compactRequested = true
    },
    /** Forget an input the session failed to push. */
    unregisterInput(uuid: string): void {
      inputs.delete(uuid)
      startedInputs.delete(uuid)
      pending.delete(uuid)
    },
    /** Pushed inputs the CLI has not started yet, in push order (a
     *  reconnect re-delivers them to the new CLI). */
    unstartedInputs(): readonly string[] {
      return [...inputs.keys()].filter(uuid => !startedInputs.has(uuid))
    },
    /** Queued-input previews the channel still shows (pending uuids, push
     *  order): what an interrupt covered but has not confirmed deleted —
     *  an answerless or failed interrupt reports them as still queued. */
    pendingInputs(): readonly string[] {
      return [...pending.keys()]
    },
    /** Give up on inputs that can no longer be delivered: their previews
     *  are retired as discarded. */
    dropInputs(uuids: readonly string[]): AgentEvent[] {
      const discarded: string[] = []
      for (const uuid of uuids) {
        inputs.delete(uuid)
        startedInputs.delete(uuid)
        if (pending.delete(uuid)) discarded.push(uuid)
      }
      return discarded.length === 0 ? [] : [{ type: 'pending.changed', items: [...pending.values()], discarded }]
    },
    /** Switch the user-row source once the CLI's capabilities are known. */
    setUserRows(mode: ClaudeUserRows): void {
      userRows = mode
    },
    /** The model as last confirmed ('' before the first init). */
    get model(): string { return currentModel },
    /** The permission mode as last confirmed. */
    get mode(): string | undefined { return currentMode },
    /** A model the session switched to by control request: tracked, and
     *  reported once (a later identical init/message_start stays quiet). */
    noteModel(model: string): AgentEvent[] {
      if (model === '' || model === currentModel) return []
      currentModel = model
      return [{ type: 'model.changed', model, source: 'user' }]
    },
    /** A permission mode the session set by control request (or started in). */
    noteMode(mode: string): AgentEvent[] {
      if (mode === currentMode) return []
      currentMode = mode
      return [{ type: 'mode.changed', modeId: mode }]
    },
    get turnOpen(): boolean { return turnOpen },
    /** The task id a subagent / job id names: a task id itself, or the
     *  delegating call of a subagent `task_started` already named. */
    taskIdOf(id: string): string | undefined {
      if (taskKinds.has(id) || outputFiles.has(id)) return id
      return laneTasks.get(id)
    },
    /** The output file the CLI reported for a task. */
    outputFileOf(taskId: string): string | undefined {
      return outputFiles.get(taskId)
    },
    /** The working-activity fold's inputs (see ClaudeActivityState): the
     *  translator's own view of the stream, nothing re-parsed. */
    activityState(): ClaudeActivityState {
      // Only THIS turn's calls: a call the turn left unsettled is stale (the
      // CLI moved on), so the working line never shows the last turn's tool.
      const newest = [...openCalls.entries()].filter(([, call]) => call.turn === turn).at(-1)
      const inProgress = [...trackedTasks.values()]
        .filter(task => task.status === 'in_progress' && task.activeForm !== undefined && task.activeForm !== '')
        .sort((a, b) => a.seq - b.seq)[0]
      return {
        turnOpen,
        turnStartedAt: turnTime,
        openTool: newest === undefined ? undefined : { name: newest[1].name, input: newest[1].input },
        toolCount: toolResults,
        activeForm: inProgress?.activeForm,
        narration: attempt === undefined ? narrated : narrationOf(attempt.streamText !== '' ? attempt.streamText : attempt.text) ?? narrated,
      }
    },
    /** The last turn number used (a resumed session continues after it). */
    get turnNumber(): number { return turn },
    /** The last event sequence number used. */
    get seqNumber(): number { return seq },
    /** The tracked tasks as serializable resume seeds (replay.ts hands these
     *  to the live translator of the resumed session). */
    taskSeeds,
    /**
     * Open the CLI's own turn that follows a task notification (replay: the
     * transcript records it as a `task-notification` prompt; live, the
     * `task_notification` frame arms the same turn). Closes nothing.
     */
    openNotificationTurn(): AgentEvent[] {
      const out: AgentEvent[] = []
      notificationTurnExpected = true
      openTurn(out, 'system')
      return out
    },
  }
}

export type ClaudeTranslator = ReturnType<typeof createClaudeTranslator>
