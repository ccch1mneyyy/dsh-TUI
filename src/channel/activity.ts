/**
 * Backend-neutral activity projection: `agent.message`, `subagent.*`,
 * `task.*` and `tasks.snapshot` events of a session, plus the
 * child-lane events of its subagents (assistant / tool events carrying
 * `parentCallId`), become the `SubagentState` / `BackgroundJobState` rosters
 * the subagent dashboard, `/agents`, the `/jobs` panel and the status-line
 * chip read, plus one transcript card per subagent (`kind: 'subagent'`) and
 * per background job (`kind: 'job'`), placed where the event arrived.
 *
 * The shared projector hands this module every such event in stream order
 * (`apply`), so a card lands exactly where its delegation happened, in live
 * and replayed history alike. A DSH session never reaches it: the DSH
 * specialists keep their own projections fed by the DSH host services.
 *
 * Identity: a subagent is keyed by its `agentId`; its lane (the delegating
 * call, `parentCallId`) routes the child-lane events. A second
 * `subagent.start` for a known lane completes the first and re-keys it to the
 * new id (a backend may only learn the subagent's own id after the call).
 *
 * Terminal states: the first real end wins. `tasks.snapshot` is a level
 * signal that replaces the previous set: a background subagent or job
 * missing from it with no end of its own is settled as inferred (`unknown` /
 * killed + "status unknown"); a real end arriving later still overrides an
 * inferred one (the level may precede its bookend). A foreground subagent
 * still live when its turn closes (`turn.end`, which a process that exited
 * or reconnected also forces) is settled the same way.
 *
 * Bounded: per-subagent output lines (160) and tool calls (200), tracked
 * subagents (100) and jobs (40), the job output tail (30 lines).
 */
import { markChannelReadDirty } from '../adapter/channel/read-view.js'
import type { ChannelUi } from '../adapter/ports/channel-ui.js'
import type {
  AgentMessageView, BackgroundJobOutputLine, BackgroundJobState, BackgroundJobStatus, ChatRow, JobRow, SubagentOutputKind,
  SubagentOutputLine, SubagentRow, SubagentState, SubagentToolCall,
} from '../adapter/ports/channel-view.js'
import type { AgentEvent, AgentEventOf, SubagentUsage, TaskStatus } from '../agent/events.js'
import { foldAgentMessage } from '../agent/messages.js'
import { t } from '../i18n.js'
import { formatJobDuration } from './job-format.js'
import { preview } from './transcript.js'

const MAX_OUTPUT_EVENTS = 160
const MAX_TOOL_CALLS = 200
const MAX_SUBAGENTS = 100
const MAX_JOBS = 40
/** Output tail lines kept per job (the card shows 3, the panel the rest). */
export const ACTIVITY_TAIL_LINES = 30
/** The output tail of a watched live job is re-read at most this often. */
export const ACTIVITY_TAIL_INTERVAL_MS = 1000
/** Consecutive failed tail reads after which a job's output is given up on. */
const MAX_TAIL_FAILURES = 5
const ARGS_PREVIEW = 120
const RESULT_PREVIEW = 80
/** The longest subagent output line kept (characters; an ellipsis marks the cut). */
export const MAX_OUTPUT_LINE_CHARS = 400

/** One output line cut to {@link MAX_OUTPUT_LINE_CHARS} (never a lone surrogate). */
function capLine(text: string): string {
  if (text.length <= MAX_OUTPUT_LINE_CHARS) return text
  const code = text.charCodeAt(MAX_OUTPUT_LINE_CHARS - 1)
  return `${text.slice(0, code >= 0xd800 && code <= 0xdbff ? MAX_OUTPUT_LINE_CHARS - 1 : MAX_OUTPUT_LINE_CHARS)}…`
}

/** The child-lane event kinds (they carry the delegating call's id). */
export type LaneEvent = AgentEventOf<'assistant.attempt.start' | 'assistant.delta' | 'assistant.message' | 'tool.call' | 'tool.result' | 'tool.progress' | 'tool.output'>

/** The subagent lane an event belongs to (`parentCallId`), if it is a child-lane event. */
export function laneOf(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'assistant.attempt.start':
    case 'assistant.delta':
    case 'assistant.message':
    case 'tool.call':
    case 'tool.result':
    case 'tool.progress':
    case 'tool.output':
      return event.parentCallId
    default:
      return undefined
  }
}

/** The state slice this projection writes. */
export interface ActivityState {
  rows: ChatRow[]
  subagents: readonly SubagentState[]
  backgroundJobs: readonly BackgroundJobState[]
}

/** Timer seam (tests inject a manual one). */
export interface ActivityTimer {
  set(callback: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const REAL_TIMER: ActivityTimer = {
  set: (callback, ms) => {
    const handle = setInterval(callback, ms)
    handle.unref()
    return handle
  },
  clear: handle => { clearInterval(handle as ReturnType<typeof setInterval>) },
}

export interface ActivityDeps {
  rowIds: { value: number }
  /** Settlement toasts (absent = silent, e.g. a scratch projection). */
  notify?: ChannelUi['notify']
  /** Publish an asynchronous change (an output tail read). */
  emit?(): void
  /** Read a job's output tail; undefined when the backend cannot. */
  readOutput?(taskId: string): Promise<string> | undefined
  now?(): number
  timer?: ActivityTimer
}

interface SubagentEntry {
  state: SubagentState
  lane?: string
  /** The terminal state was inferred from a snapshot; a real end overrides it. */
  inferred: boolean
  /** The backend named the subagent itself (not only its delegating call). */
  confirmed: boolean
  row?: ChatRow
  /** The streamed attempt being assembled: the lines before it began. */
  attempt?: { readonly id: string; readonly before: SubagentOutputLine[] }
  lastSummary?: string
  copy?: SubagentState
}

interface JobEntry {
  state: BackgroundJobState
  row?: ChatRow
  inferred: boolean
  /** The settlement toast fired (once per job). */
  toasted: boolean
  reading: boolean
  /** When the tail was last read (reads are at most one interval apart). */
  lastReadAt?: number
  /** A tail read landed after the job settled (no more polling). */
  finalRead: boolean
  failures: number
}

const isLiveSubagent = (status: SubagentState['status']): boolean => status === 'running' || status === 'starting'
const isLiveJob = (status: BackgroundJobStatus): boolean => status === 'running' || status === 'stopping'

function jobStatusOf(status: TaskStatus): BackgroundJobStatus {
  switch (status) {
    case 'pending':
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'killed'
    default: {
      const unknown: never = status
      return unknown
    }
  }
}

/** Text of a tool result / summary as one short line. */
function oneLine(text: string, limit: number): string | undefined {
  const flat = preview(text, limit)
  return flat === '' ? undefined : flat
}

/** The longest job detail kept: it rides the card header as a fixed column
 *  (a long one would squeeze the label to nothing). */
const JOB_DETAIL_CELLS = 32

/**
 * A job's terminal detail from its end report: the exit code when the
 * report names one (`exit code: N`, the shape the card and panel expect),
 * else nothing. The full report is the backend's to keep, not the header's.
 */
function jobDetailOf(summary: string | undefined): string | undefined {
  if (summary === undefined) return undefined
  const code = /exit code[:\s]+(-?\d+)/iu.exec(summary)?.[1]
  return code === undefined ? undefined : `exit code: ${code}`
}

/** Create the projection over one channel state. */
export function createActivityProjection(getState: () => ActivityState, deps: ActivityDeps) {
  const now = deps.now ?? Date.now
  const timer = deps.timer ?? REAL_TIMER
  const subagents = new Map<string, SubagentEntry>()
  const lanes = new Map<string, string>()
  const jobs = new Map<string, JobEntry>()
  const agentMessages: AgentMessageView[] = []
  const watchers = new Map<string, number>()
  let tick: unknown
  let disposed = false
  let replaying = false

  const touch = (row: ChatRow): void => {
    markChannelReadDirty(row)
    markChannelReadDirty(getState().rows)
  }

  // ── subagents ─────────────────────────────────────────────────────────

  const subagentView = (state: SubagentState): SubagentRow => ({
    agentId: state.agentId,
    ...(state.runId === undefined ? {} : { runId: state.runId }),
    description: state.description,
    ...(state.provider === undefined ? {} : { provider: state.provider }),
    ...(state.model === undefined ? {} : { model: state.model }),
    status: state.status,
    startedAt: state.startedAt,
    ...(state.completedAt === undefined ? {} : { completedAt: state.completedAt }),
    durationMs: (state.completedAt ?? now()) - state.startedAt,
    outputLines: state.output.slice(-3),
    toolCalls: state.toolCalls.map(tool => ({ ...tool })),
    ...(state.tokens === undefined ? {} : { tokens: { ...state.tokens } }),
    ...(state.summary === undefined ? {} : { summary: state.summary }),
    ...(state.stopReason === undefined ? {} : { stopReason: state.stopReason }),
    ...(state.error === undefined ? {} : { error: state.error }),
    ...(state.background === undefined ? {} : { background: state.background }),
    ...(state.depth === undefined ? {} : { depth: state.depth }),
  })

  /** Repaint one subagent's card (re-created after `/clear` while it runs)
   *  and its roster copy. */
  const syncSubagent = (entry: SubagentEntry): void => {
    entry.copy = undefined
    let row = entry.row
    if (row === undefined) {
      if (!isLiveSubagent(entry.state.status)) return publishSubagents()
      row = { id: deps.rowIds.value++, kind: 'subagent', text: entry.state.description, subagent: undefined }
      entry.row = row
      getState().rows.push(row)
    }
    row.subagent = subagentView(entry.state)
    row.text = entry.state.description
    touch(row)
    publishSubagents()
  }

  const copyOf = (entry: SubagentEntry): SubagentState => {
    entry.copy ??= {
      ...entry.state,
      output: [...entry.state.output],
      outputEvents: entry.state.outputEvents.map(line => ({ ...line })),
      toolCalls: entry.state.toolCalls.map(tool => ({ ...tool })),
      ...(entry.state.tokens === undefined ? {} : { tokens: { ...entry.state.tokens } }),
    }
    return entry.copy
  }

  const publishSubagents = (): void => {
    getState().subagents = [...subagents.values()].map(copyOf)
  }

  const pushLine = (entry: SubagentEntry, line: SubagentOutputLine): void => {
    const state = entry.state
    if (line.text.length > MAX_OUTPUT_LINE_CHARS) line.text = capLine(line.text)
    state.outputEvents.push(line)
    if (state.outputEvents.length > MAX_OUTPUT_EVENTS) state.outputEvents.splice(0, state.outputEvents.length - MAX_OUTPUT_EVENTS)
    state.output = state.outputEvents.map(item => item.text)
  }

  /** Settled lines of a block of text (one per line, the empty ones dropped). */
  const commitText = (entry: SubagentEntry, kind: SubagentOutputKind, text: string): void => {
    for (const line of text.split('\n').slice(-MAX_OUTPUT_EVENTS)) {
      if (line.trim() === '') continue
      pushLine(entry, { kind, text: line, at: now(), settled: true })
    }
  }

  /** Stream text into the tail line (split on newlines as it grows). */
  const appendText = (entry: SubagentEntry, kind: SubagentOutputKind, text: string): void => {
    if (text === '') return
    const state = entry.state
    const last = state.outputEvents.at(-1)
    if (last === undefined || last.settled === true || last.kind !== kind) {
      if (last !== undefined && last.settled !== true) last.settled = true
      pushLine(entry, { kind, text: '', at: now(), settled: false })
    }
    const tail = state.outputEvents.at(-1)!
    const parts = `${tail.text}${text}`.split('\n')
    // A streamed line stops growing at the cap (its cut text stays as is
    // until the line ends).
    tail.text = tail.text.length > MAX_OUTPUT_LINE_CHARS ? tail.text : capLine(parts[0]!)
    if (parts.length > 1) {
      tail.settled = true
      for (const middle of parts.slice(1, -1)) pushLine(entry, { kind, text: middle, at: now(), settled: true })
      const rest = parts.at(-1) ?? ''
      if (rest !== '') pushLine(entry, { kind, text: rest, at: now(), settled: false })
    }
    state.output = state.outputEvents.map(item => item.text)
  }

  /** Put back the lines a superseded streamed attempt replaced. */
  const restoreAttempt = (entry: SubagentEntry): void => {
    const attempt = entry.attempt
    if (attempt === undefined) return
    entry.attempt = undefined
    entry.state.outputEvents = attempt.before
    entry.state.output = attempt.before.map(line => line.text)
  }

  const flushTail = (entry: SubagentEntry): void => {
    const last = entry.state.outputEvents.at(-1)
    if (last !== undefined && last.settled !== true) last.settled = true
  }

  const applyUsage = (entry: SubagentEntry, usage: SubagentUsage | undefined): void => {
    if (usage === undefined) return
    const sum = (usage.input ?? 0) + (usage.output ?? 0)
    const total = usage.total ?? (sum > 0 ? sum : undefined)
    if (total === undefined && usage.input === undefined && usage.output === undefined) return
    entry.state.tokens = {
      ...entry.state.tokens,
      ...(usage.input === undefined ? {} : { input: usage.input }),
      ...(usage.output === undefined ? {} : { output: usage.output }),
      ...(total === undefined ? {} : { total }),
    }
  }

  /** The backend's own reports (absolute values: overwrite, never add). The
   *  locally kept tool records miss lane frames, so the reports win. */
  const applyReports = (entry: SubagentEntry, usage: SubagentUsage | undefined): void => {
    if (usage === undefined) return
    if (usage.toolUses !== undefined) entry.state.reportedToolUses = usage.toolUses
    if (usage.durationMs !== undefined) entry.state.reportedDurationMs = usage.durationMs
  }

  /** Forget the oldest settled subagents beyond the roster bound (their
   *  transcript cards stay as they are). */
  const trimSubagents = (): void => {
    if (subagents.size <= MAX_SUBAGENTS) return
    for (const [id, entry] of subagents) {
      if (subagents.size <= MAX_SUBAGENTS) break
      if (isLiveSubagent(entry.state.status)) continue
      subagents.delete(id)
      if (entry.lane !== undefined && lanes.get(entry.lane) === id) lanes.delete(entry.lane)
    }
  }

  const entryOf = (id: string): SubagentEntry | undefined => subagents.get(id) ?? subagents.get(lanes.get(id) ?? '')

  const startSubagent = (event: AgentEventOf<'subagent.start'>): void => {
    const lane = event.parentCallId
    let entry = (lane === undefined ? undefined : subagents.get(lanes.get(lane) ?? '')) ?? subagents.get(event.agentId)
    if (entry !== undefined && entry.state.agentId !== event.agentId) {
      // The lane's subagent learned its own id: re-key it.
      subagents.delete(entry.state.agentId)
      entry.state.agentId = event.agentId
      subagents.set(event.agentId, entry)
    }
    if (entry === undefined) {
      entry = {
        state: {
          agentId: event.agentId,
          description: event.description !== '' ? event.description : t('subagent-task-fallback', { kind: event.kind ?? 'subagent' }),
          ...(event.kind === undefined ? {} : { provider: event.kind }),
          ...(event.model === undefined ? {} : { model: event.model }),
          status: 'running',
          startedAt: event.time,
          output: [],
          outputEvents: [],
          toolCalls: [],
          background: event.background,
          ...(event.depth === undefined ? {} : { depth: event.depth }),
          ...(event.parentAgentId === undefined ? {} : { parentAgentId: event.parentAgentId }),
        },
        inferred: false,
        confirmed: false,
      }
      subagents.set(event.agentId, entry)
      trimSubagents()
    } else {
      const state = entry.state
      if (!isLiveSubagent(state.status)) {
        // A start for a settled subagent is a new run of the same agent (a
        // SendMessage to a finished agent resumes it from its transcript
        // under the same id, and the CLI re-registers it). The old run's
        // terminal fields go; the identity, transcript, tool records and
        // cumulative tokens stay; the new run's clock starts now. A start
        // while it still runs (moved to the background) is the same run, so
        // nothing resets.
        state.status = 'running'
        state.startedAt = event.time
        state.completedAt = undefined
        state.endedAt = undefined
        state.stopReason = undefined
        state.summary = undefined
        state.error = undefined
        state.reportedToolUses = undefined
        state.reportedDurationMs = undefined
        state.lastTool = undefined
        entry.inferred = false
        entry.lastSummary = undefined
      }
      if (event.description !== '') state.description = event.description
      if (event.kind !== undefined) state.provider = event.kind
      if (event.model !== undefined) state.model = event.model
      state.background = event.background || state.background === true
      if (event.depth !== undefined) state.depth = event.depth
      // A late parent fact heals an unknown one; a known parent is never
      // rewritten by a fact-free refresh (same once-only rule as depth).
      if (event.parentAgentId !== undefined && state.parentAgentId === undefined) state.parentAgentId = event.parentAgentId
    }
    if (lane !== undefined) {
      lanes.set(lane, event.agentId)
      entry.lane = lane
    }
    if (lane === undefined || event.agentId !== lane) entry.confirmed = true
    syncSubagent(entry)
  }

  const progressSubagent = (event: AgentEventOf<'subagent.progress'>): void => {
    const entry = entryOf(event.agentId)
    if (entry === undefined) return
    applyUsage(entry, event.usage)
    applyReports(entry, event.usage)
    if (event.lastTool !== undefined) entry.state.lastTool = event.lastTool
    const summary = event.summary?.trim()
    if (summary !== undefined && summary !== '' && summary !== entry.lastSummary) {
      entry.lastSummary = summary
      flushTail(entry)
      pushLine(entry, { kind: 'system', text: summary, at: now(), settled: true })
    }
    syncSubagent(entry)
  }

  const finishSubagent = (entry: SubagentEntry, status: SubagentState['status'], time: number, options: { summary?: string; inferred?: boolean } = {}): boolean => {
    const state = entry.state
    // The first real outcome wins; an inferred one yields to it.
    if (!isLiveSubagent(state.status) && !entry.inferred && state.status !== 'unknown') return false
    if (options.inferred === true && !isLiveSubagent(state.status)) return false
    restoreAttempt(entry)
    flushTail(entry)
    state.status = status
    state.completedAt = time
    state.endedAt = time
    state.stopReason = status
    if (options.summary !== undefined && options.summary !== '') state.summary = options.summary
    if (status === 'failed') state.error = options.summary !== undefined && options.summary !== '' ? oneLine(options.summary, RESULT_PREVIEW) : t('subagent-status-failed')
    // A settled subagent runs no tools any more.
    for (const tool of state.toolCalls) {
      if (tool.status === 'running') {
        tool.status = status === 'completed' ? 'completed' : 'failed'
        tool.endedAt = time
      }
    }
    entry.inferred = options.inferred === true
    return true
  }

  const endSubagent = (event: AgentEventOf<'subagent.end'>): void => {
    const entry = entryOf(event.agentId)
    if (entry === undefined) return
    applyUsage(entry, event.usage)
    applyReports(entry, event.usage)
    finishSubagent(entry, event.status, event.time, { ...(event.summary === undefined ? {} : { summary: event.summary }) })
    syncSubagent(entry)
  }

  /** The child-lane entry (created when the lane was never announced). */
  const laneEntry = (lane: string, time: number): SubagentEntry => {
    const known = subagents.get(lanes.get(lane) ?? '')
    if (known !== undefined) return known
    startSubagent({ type: 'subagent.start', agentId: lane, parentCallId: lane, description: '', background: false, time })
    return subagents.get(lane)!
  }

  const recordTool = (entry: SubagentEntry, input: SubagentToolCall): void => {
    const tools = entry.state.toolCalls
    const current = input.id === undefined ? undefined : tools.find(tool => tool.id === input.id)
    if (current !== undefined) Object.assign(current, input)
    else tools.push(input)
    if (tools.length > MAX_TOOL_CALLS) {
      const settled = tools.findIndex(tool => tool.status !== 'running')
      tools.splice(settled === -1 ? 0 : settled, 1)
    }
  }

  const applyLane = (lane: string, event: LaneEvent): void => {
    const time = 'time' in event && typeof event.time === 'number' ? event.time : now()
    const entry = laneEntry(lane, time)
    switch (event.type) {
      case 'assistant.attempt.start':
        restoreAttempt(entry)
        flushTail(entry)
        entry.attempt = { id: event.attemptId, before: entry.state.outputEvents.map(line => ({ ...line })) }
        break
      case 'assistant.delta': {
        if (entry.attempt === undefined || entry.attempt.id !== event.attemptId) {
          restoreAttempt(entry)
          flushTail(entry)
          entry.attempt = { id: event.attemptId, before: entry.state.outputEvents.map(line => ({ ...line })) }
        }
        const delta = event.delta
        if (delta.kind === 'text') appendText(entry, 'text', delta.text)
        else if (delta.kind === 'reasoning') appendText(entry, 'thinking', delta.text)
        else return
        break
      }
      case 'assistant.message':
        // The settled message replaces what its streamed attempt showed.
        if (entry.attempt?.id === event.attemptId) restoreAttempt(entry)
        flushTail(entry)
        for (const block of event.blocks) {
          if (typeof block.text !== 'string' || block.text === '') continue
          if (block.type === 'text') commitText(entry, 'text', block.text)
          else if (block.type === 'reasoning') commitText(entry, 'thinking', block.text)
        }
        break
      case 'tool.call': {
        const title = event.presentation !== undefined && 'title' in event.presentation && typeof event.presentation.title === 'string' ? event.presentation.title : undefined
        recordTool(entry, {
          id: event.callId,
          name: event.name,
          status: 'running',
          startedAt: event.time,
          argsPreview: oneLine(title ?? event.argsJson, ARGS_PREVIEW) ?? '',
        })
        break
      }
      case 'tool.result': {
        const tool = entry.state.toolCalls.find(item => item.id === event.callId)
        if (tool === undefined) return
        tool.status = event.isError ? 'failed' : 'completed'
        tool.endedAt = event.time
        if (event.isError) tool.error = oneLine(event.errorText ?? '', RESULT_PREVIEW) ?? t('subagent-status-failed')
        else {
          const result = oneLine(event.text, RESULT_PREVIEW)
          if (result !== undefined) tool.resultPreview = result
        }
        break
      }
      case 'tool.progress':
        // Elapsed time only: the card already ticks its own duration.
        return
      case 'tool.output':
        // A child's live tool output: the subagent card lists its calls,
        // not their output (the result preview lands with tool.result).
        return
      default: {
        const unknown: never = event
        return unknown
      }
    }
    syncSubagent(entry)
  }

  // ── background jobs ───────────────────────────────────────────────────

  const jobView = (state: BackgroundJobState): JobRow => ({
    id: state.id,
    kind: state.kind,
    label: state.label,
    status: state.status,
    ...(state.detail === undefined ? {} : { detail: state.detail }),
    ...(state.progress === undefined ? {} : { progress: state.progress }),
    startedAt: state.startedAt,
    ...(state.finishedAt === undefined ? {} : { finishedAt: state.finishedAt }),
    outputLines: [...state.outputLines],
  })

  const publishJobs = (): void => {
    getState().backgroundJobs = [...jobs.values()].map(entry => ({ ...entry.state, outputLines: [...entry.state.outputLines] }))
  }

  const syncJob = (entry: JobEntry): void => {
    let row = entry.row
    if (row === undefined) {
      if (!isLiveJob(entry.state.status)) return publishJobs()
      row = { id: deps.rowIds.value++, kind: 'job', text: entry.state.label, job: undefined }
      entry.row = row
      getState().rows.push(row)
    }
    row.job = jobView(entry.state)
    row.text = entry.state.label
    touch(row)
    publishJobs()
  }

  const trimJobs = (): void => {
    if (jobs.size <= MAX_JOBS) return
    for (const [id, entry] of jobs) {
      if (jobs.size <= MAX_JOBS) break
      if (isLiveJob(entry.state.status)) continue
      jobs.delete(id)
    }
  }

  /** Settle a job: the first real outcome wins (an inferred one yields). */
  const settleJob = (entry: JobEntry, status: BackgroundJobStatus, time: number, detail: string | undefined, inferred: boolean): void => {
    const state = entry.state
    if (!isLiveJob(state.status) && !entry.inferred) {
      // Already settled for real: a later report may only add its detail.
      if (detail !== undefined && state.detail === undefined) state.detail = detail
      return
    }
    if (inferred && !isLiveJob(state.status)) return
    state.status = status
    state.finishedAt = time
    if (detail !== undefined) state.detail = detail
    else if (inferred) state.detail = t('jobs-detail-unknown')
    else if (entry.inferred) delete state.detail
    delete state.progress
    entry.inferred = inferred
    entry.finalRead = false
    if (inferred || entry.toasted || replaying) return
    entry.toasted = true
    deps.notify?.(
      t(status === 'completed' ? 'jobs-toast-completed' : status === 'failed' ? 'jobs-toast-failed' : 'jobs-toast-killed', {
        id: state.id,
        label: state.label,
        duration: formatJobDuration(state),
        detail: state.detail ?? '',
      }),
      { color: status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'warning', timeoutMs: 6000 },
    )
  }

  const startJob = (event: AgentEventOf<'task.start'>): void => {
    // Foreground work stays on its tool card: only background tasks are jobs.
    // Housekeeping tasks are not activity at all (no card, chip or toast).
    if (!event.background || event.hidden === true) return
    let entry = jobs.get(event.taskId)
    if (entry === undefined) {
      entry = {
        state: {
          id: event.taskId,
          kind: event.kind,
          label: event.description !== '' ? event.description : event.command ?? event.taskId,
          ...(event.command === undefined ? {} : { command: event.command }),
          status: 'running',
          startedAt: event.time,
          outputLines: [],
          ...(event.outputFile === undefined ? {} : { outputFile: event.outputFile }),
        },
        inferred: false,
        toasted: false,
        reading: false,
        finalRead: false,
        failures: 0,
      }
      jobs.set(event.taskId, entry)
      trimJobs()
    } else {
      if (event.command !== undefined) entry.state.command = event.command
      if (event.outputFile !== undefined) noteOutputFile(entry, event.outputFile)
    }
    syncJob(entry)
  }

  const updateJob = (event: AgentEventOf<'task.update'>): void => {
    const entry = jobs.get(event.taskId)
    if (entry === undefined) return
    const patch = event.patch
    const state = entry.state
    if (patch.description !== undefined && patch.description !== '') state.label = patch.description
    if (patch.outputFile !== undefined && patch.outputFile !== '') noteOutputFile(entry, patch.outputFile)
    if (patch.progress !== undefined && isLiveJob(state.status)) state.progress = patch.progress
    if (patch.status !== undefined) {
      const status = jobStatusOf(patch.status)
      if (isLiveJob(status)) {
        if (entry.inferred) {
          // The level said gone, the task says it runs: it runs.
          entry.inferred = false
          state.status = status
          delete state.finishedAt
          delete state.detail
        }
      } else {
        settleJob(entry, status, now(), patch.error === undefined ? undefined : oneLine(patch.error, JOB_DETAIL_CELLS), false)
      }
    }
    syncJob(entry)
  }

  const endJob = (event: AgentEventOf<'task.end'>): void => {
    const entry = jobs.get(event.taskId)
    if (entry === undefined) return
    if (event.outputFile !== undefined && event.outputFile !== '') noteOutputFile(entry, event.outputFile)
    const status: BackgroundJobStatus = event.status === 'stopped' ? 'killed' : event.status
    settleJob(entry, status, event.time, jobDetailOf(event.summary), false)
    syncJob(entry)
    // The final tail of a watched job.
    if (watchers.has(entry.state.id)) readTail(entry, true)
  }

  const outputJob = (event: AgentEventOf<'task.output'>): void => {
    const entry = jobs.get(event.taskId)
    if (entry === undefined || event.text === '') return
    const lines = event.text.split(/\r?\n/u).map(line => line.replace(/\s+$/u, '')).filter(line => line !== '').map(text => ({ text }))
    if (lines.length === 0) return
    entry.state.outputLines = [...entry.state.outputLines, ...lines].slice(-ACTIVITY_TAIL_LINES)
    entry.state.lastOutputAt = event.time
    syncJob(entry)
  }

  const applySnapshot = (event: AgentEventOf<'tasks.snapshot'>): void => {
    const live = new Set(event.taskIds)
    const time = now()
    for (const entry of jobs.values()) {
      if (live.has(entry.state.id)) {
        if (entry.inferred) {
          entry.inferred = false
          entry.state.status = 'running'
          delete entry.state.finishedAt
          delete entry.state.detail
          syncJob(entry)
        }
        continue
      }
      if (!isLiveJob(entry.state.status)) continue
      settleJob(entry, 'killed', time, undefined, true)
      syncJob(entry)
    }
    for (const entry of subagents.values()) {
      // Only a subagent the backend named itself can be in the level (a
      // foreground one never is: the level lists background work only).
      if (!entry.confirmed || entry.state.background !== true) continue
      if (live.has(entry.state.agentId)) {
        if (entry.inferred && entry.state.status === 'unknown') {
          entry.inferred = false
          entry.state.status = 'running'
          entry.state.completedAt = undefined
          entry.state.endedAt = undefined
          entry.state.stopReason = undefined
          syncSubagent(entry)
        }
        continue
      }
      if (finishSubagent(entry, 'unknown', time, { inferred: true })) syncSubagent(entry)
    }
  }

  /**
   * The turn closed (or the backend's process went away, which closes it):
   * a foreground subagent cannot outlive the turn that delegated to it. One
   * still live never reported its end, so it is settled `unknown` as
   * inferred and a real end that arrives late still wins. Background
   * subagents are settled by the level signal (`tasks.snapshot`).
   */
  const settleForeground = (time: number): void => {
    for (const entry of subagents.values()) {
      if (entry.state.background === true || !isLiveSubagent(entry.state.status)) continue
      if (finishSubagent(entry, 'unknown', time, { inferred: true })) syncSubagent(entry)
    }
  }

  // ── output tail ───────────────────────────────────────────────────────

  /**
   * The backend named (or renamed) a job's output file: a new path is a new
   * read target: earlier failures (reads before the path was known, or of
   * another path) no longer count, and a watched job is read again at once.
   */
  function noteOutputFile(entry: JobEntry, outputFile: string): void {
    if (entry.state.outputFile === outputFile) return
    entry.state.outputFile = outputFile
    entry.failures = 0
    entry.lastReadAt = undefined
    if (disposed || deps.readOutput === undefined || !watchers.has(entry.state.id)) return
    const live = isLiveJob(entry.state.status)
    if (live || !entry.finalRead) {
      readTail(entry, !live)
      tick ??= timer.set(onTick, ACTIVITY_TAIL_INTERVAL_MS)
    }
  }

  /**
   * One tail read of a job's output: never overlapping, at most one per
   * interval (`final` = the one read after the job settled), given up after
   * repeated failures.
   */
  const readTail = (entry: JobEntry, final = false): void => {
    if (disposed || entry.reading || entry.failures >= MAX_TAIL_FAILURES || deps.readOutput === undefined) return
    // Nothing to read until the backend names the file: no read, no failure.
    if (entry.state.outputFile === undefined) return
    if (!final && entry.lastReadAt !== undefined && now() - entry.lastReadAt < ACTIVITY_TAIL_INTERVAL_MS) return
    entry.lastReadAt = now()
    const settled = !isLiveJob(entry.state.status)
    let pending: Promise<string> | undefined
    try {
      pending = deps.readOutput(entry.state.id)
    } catch {
      pending = undefined
    }
    if (pending === undefined) {
      entry.failures = MAX_TAIL_FAILURES
      return
    }
    entry.reading = true
    pending.then(text => {
      entry.reading = false
      if (disposed || jobs.get(entry.state.id) !== entry) return
      entry.failures = 0
      if (settled) entry.finalRead = true
      const lines: BackgroundJobOutputLine[] = []
      for (const raw of text.split(/\r?\n/u)) {
        // A carriage return rewrites its line (progress output): keep the last form.
        const line = (raw.split('\r').at(-1) ?? '').replace(/\s+$/u, '')
        if (line !== '') lines.push({ text: line })
      }
      const tail = lines.slice(-ACTIVITY_TAIL_LINES)
      const before = entry.state.outputLines
      if (tail.length === before.length && tail.every((line, index) => line.text === before[index]?.text)) return
      entry.state.outputLines = tail
      entry.state.lastOutputAt = now()
      syncJob(entry)
      deps.emit?.()
    }, () => {
      entry.reading = false
      entry.failures += 1
    })
  }

  const stopTimer = (): void => {
    if (tick === undefined) return
    timer.clear(tick)
    tick = undefined
  }

  const onTick = (): void => {
    if (disposed) return stopTimer()
    let polling = false
    for (const id of watchers.keys()) {
      const entry = jobs.get(id)
      if (entry === undefined || entry.failures >= MAX_TAIL_FAILURES || entry.state.outputFile === undefined) continue
      if (isLiveJob(entry.state.status)) {
        readTail(entry)
        polling = true
      } else if (!entry.finalRead) {
        readTail(entry, true)
        polling = true
      }
    }
    if (!polling) stopTimer()
  }

  /** A job's card or panel entry is on screen: keep its tail fresh. */
  const watchOutput = (id: string): (() => void) => {
    if (disposed || deps.readOutput === undefined) return () => undefined
    watchers.set(id, (watchers.get(id) ?? 0) + 1)
    const entry = jobs.get(id)
    if (entry !== undefined && (isLiveJob(entry.state.status) || !entry.finalRead)) readTail(entry, !isLiveJob(entry.state.status))
    tick ??= timer.set(onTick, ACTIVITY_TAIL_INTERVAL_MS)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = (watchers.get(id) ?? 1) - 1
      if (count <= 0) watchers.delete(id)
      else watchers.set(id, count)
      if (watchers.size === 0) stopTimer()
    }
  }

  // ── public surface ────────────────────────────────────────────────────

  /** Fold one event (the shared projector calls this in stream order). */
  const apply = (event: AgentEvent, replay: boolean): void => {
    if (disposed) return
    replaying = replay
    try {
      const lane = laneOf(event)
      if (lane !== undefined) {
        applyLane(lane, event as LaneEvent)
        return
      }
      switch (event.type) {
        case 'agent.message':
          foldAgentMessage(agentMessages, event.message)
          return
        case 'subagent.start':
          startSubagent(event)
          return
        case 'subagent.progress':
          progressSubagent(event)
          return
        case 'subagent.end':
          endSubagent(event)
          return
        case 'task.start':
          startJob(event)
          return
        case 'task.update':
          updateJob(event)
          return
        case 'task.output':
          outputJob(event)
          return
        case 'task.end':
          endJob(event)
          return
        case 'tasks.snapshot':
          applySnapshot(event)
          return
        case 'turn.end':
          settleForeground(event.time)
          return
        default:
          return
      }
    } finally {
      replaying = false
    }
  }

  /** `/clear`: the cards leave the transcript; live ones come back on their
   *  next change. */
  const dropRows = (): void => {
    for (const entry of subagents.values()) entry.row = undefined
    for (const entry of jobs.values()) entry.row = undefined
  }

  /** A session switch: forget everything. */
  const reset = (): void => {
    dropRows()
    subagents.clear()
    lanes.clear()
    jobs.clear()
    agentMessages.length = 0
    watchers.clear()
    stopTimer()
    const state = getState()
    state.subagents = []
    state.backgroundJobs = []
  }

  return {
    apply,
    reset,
    dropRows,
    watchOutput,
    dispose(): void {
      disposed = true
      watchers.clear()
      stopTimer()
    },
    /** The subagent a lane or id names, for control requests. */
    subagent(id: string): SubagentState | undefined {
      const entry = entryOf(id)
      return entry === undefined ? undefined : copyOf(entry)
    },
    job(id: string): BackgroundJobState | undefined {
      return jobs.get(id)?.state
    },
    agentMessages(): readonly AgentMessageView[] {
      return agentMessages
    },
    /** `/agents`: one line per tracked subagent. */
    listLines(): string[] {
      if (subagents.size === 0) return [t('subagent-none')]
      return [...subagents.values()].map(entry => {
        const state = entry.state
        const status = isLiveSubagent(state.status) ? t('subagent-running')
          : state.status === 'unknown' ? t('subagent-unknown')
          : ` ${t(state.status === 'completed' ? 'subagent-status-completed' : state.status === 'failed' ? 'subagent-status-failed' : 'subagent-status-cancelled')}`
        return t('subagent-row', {
          mode: state.background === true ? t('subagent-background') : (state.provider ?? 'subagent'),
          label: `「${state.description}」`,
          activity: status,
          id: state.agentId.slice(0, 8),
        })
      })
    },
  }
}

export type ActivityProjection = ReturnType<typeof createActivityProjection>
